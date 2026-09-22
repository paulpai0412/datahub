import assert from "node:assert/strict";
import test from "node:test";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createReverseHttpPool } from "../extensions/datahub-agent/integration/reverse-http.mjs";
import { startRuntimeRelay } from "../extensions/datahub-agent/integration/runtime-relay.mjs";
import {
  createEgressProxy,
  isPublicIPv4,
} from "../extensions/datahub-agent/integration/egress-proxy.mjs";
import { createAgentGateway } from "../extensions/datahub-agent/integration/gateway.mjs";
import { BrowserGrants } from "../extensions/datahub-agent/integration/browser-grants.mjs";
import { isValidWebSessionToken } from "../extensions/datahub-agent/pi-web/lib/web-auth.ts";

async function stop(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

test("reverse connection queue is bounded, abortable and closed fail-closed", async () => {
  const root = await mkdtemp("/tmp/dha-q-");
  const pool = await createReverseHttpPool(join(root, "r.sock"), {
    capacity: 1,
    pendingLimit: 1,
  });
  try {
    const abort = new AbortController();
    const pending = assert.rejects(pool.acquire(abort.signal), /unavailable/);
    await assert.rejects(pool.acquire(), /capacity_exhausted/);
    abort.abort();
    await pending;
    const closing = assert.rejects(pool.acquire(), /unavailable/);
    await pool.close();
    await closing;
    await assert.rejects(pool.acquire(), /unavailable/);
  } finally {
    await pool.close();
    await rm(root, { recursive: true });
  }
});

test("expired idle HTTP connections are discarded before another request can acquire them", {
  timeout: 5000,
}, async (t) => {
  const root = await mkdtemp("/tmp/dha-idle-");
  const path = join(root, "r.sock");
  const pool = await createReverseHttpPool(path, { capacity: 1 });
  const app = createServer(
    { headersTimeout: 40, requestTimeout: 40, connectionsCheckingInterval: 5 },
    (_req, res) => res.end("fresh"),
  );
  let stopRelay;
  t.after(async () => {
    stopRelay?.();
    await pool.close();
    await stop(app);
    await rm(root, { recursive: true });
  });
  let connections = 0;
  let expired = false;
  app.on("connection", (socket) => {
    if (++connections === 1)
      socket.once("close", () => {
        expired = true;
      });
    else {
      app.headersTimeout = app.requestTimeout = 10000;
      app.emit("replacement");
    }
  });
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  const replacement = once(app, "replacement", {
    signal: AbortSignal.timeout(1500),
  }).then(
    () => true,
    () => false,
  );
  stopRelay = startRuntimeRelay({
    socketPath: path,
    port: app.address().port,
    capacity: 1,
    retryMs: 10,
  });
  assert.equal(
    await replacement,
    true,
    "idle timeout response must close the stale pool connection and permit replenishment",
  );
  assert.equal(expired, true);
  const socket = await pool.acquire();
  const result = await new Promise((resolve, reject) => {
    const outgoing = request(
      {
        host: "localhost",
        port: app.address().port,
        path: "/",
        createConnection: () => socket,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("error", reject);
        res.on("end", () => resolve({ status: res.statusCode, body }));
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
  assert.deepEqual(result, { status: 200, body: "fresh" });
});

test("real reverse HTTP gateway stream is revoked, with native private pi-web authentication", {
  timeout: 10000,
}, async (t) => {
  const root = await mkdtemp("/tmp/dha-s-");
  let pool, app, gateway, stopRelay;
  t.after(async () => {
    stopRelay?.();
    await pool?.close();
    if (gateway) await stop(gateway);
    if (app) await stop(app);
    await rm(root, { recursive: true });
  });
  const path = join(root, "r.sock");
  pool = await createReverseHttpPool(path);
  const password = "synthetic-only-password-at-least-32-bytes";
  let upstreamClosed;
  const finished = new Promise((resolve) => {
    upstreamClosed = resolve;
  });
  app = createServer((req, res) => {
    assert.equal(
      isValidWebSessionToken(
        req.headers.cookie?.replace(/^pi_web_session=/, ""),
        password,
      ),
      true,
    );
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: ready\n\n");
    res.on("close", upstreamClosed);
  });
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  stopRelay = startRuntimeRelay({
    socketPath: path,
    port: app.address().port,
    capacity: 2,
    retryMs: 10,
  });
  const actor = {
    tenant: "fixture",
    urn: "urn:li:corpuser:alice",
    key: "a".repeat(48),
  };
  const grants = new BrowserGrants();
  const issued = grants.issue(actor);
  const { session } = grants.exchange(issued.ticket, actor.key);
  gateway = await createAgentGateway({
    gatewayOrigin: "http://localhost:0",
    datahubOrigin: "http://localhost:9002",
    verifyIdentity: async () => actor,
    runtimeForActor: async () => ({
      origin: "http://must-not-resolve.invalid:9",
      password,
      openSocket: (signal) => pool.acquire(signal),
    }),
    mfeDirectory: fileURLToPath(
      new URL("../extensions/datahub-agent/mfe/dist/", import.meta.url),
    ),
    grants,
  });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  await new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: gateway.address().port,
        path: "/api/events",
        headers: {
          host: `${actor.key}.localhost:${gateway.address().port}`,
          cookie: `datahub_agent_session=${session}`,
        },
      },
      (res) => {
        try {
          assert.equal(res.statusCode, 200);
        } catch (error) {
          reject(error);
          return;
        }
        res.once("data", () => grants.revoke(issued.grantId, actor));
        res.on("error", () => {}); // Deliberate mid-stream revocation.
        res.once("close", () => {
          try {
            assert.equal(res.complete, false);
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("stream_test_timeout")));
    req.end();
  });
  await Promise.race([
    finished,
    new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error("upstream_not_revoked")),
        1000,
      );
      finished.finally(() => clearTimeout(timer));
    }),
  ]);
});

test("reverse HTTP drains large response bodies before closing", {
  timeout: 10000,
}, async (t) => {
  const root = await mkdtemp("/tmp/dha-bytes-");
  let pool, app, stopRelay;
  t.after(async () => {
    stopRelay?.();
    await pool?.close();
    if (app) await stop(app);
    await rm(root, { recursive: true });
  });
  pool = await createReverseHttpPool(join(root, "r.sock"));
  const size = 4 * 1024 * 1024;
  app = createServer((_req, res) => {
    res.writeHead(200, { "content-length": size });
    res.end(Buffer.alloc(size, 42));
  });
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  stopRelay = startRuntimeRelay({
    socketPath: join(root, "r.sock"),
    port: app.address().port,
    capacity: 1,
    retryMs: 10,
  });
  for (let iteration = 0; iteration < 3; iteration++) {
    const socket = await pool.acquire();
    await new Promise((resolve, reject) => {
      const req = request(
        { host: "must-not-resolve.invalid", createConnection: () => socket },
        (res) => {
          let received = 0;
          res.pause();
          setTimeout(() => res.resume(), 100);
          res.on("data", (chunk) => {
            received += chunk.length;
          });
          res.on("error", reject);
          res.on("end", () => {
            try {
              assert.equal(received, size);
              resolve();
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
  }
});

test("egress rejects special IPs and unapproved authorities without opening destination sockets", async () => {
  for (const ip of [
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.31.1.1",
    "192.168.1.1",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::ffff:127.0.0.1",
    "2001:4860:4860::8888",
  ])
    assert.equal(isPublicIPv4(ip), false, ip);
  assert.equal(isPublicIPv4("1.1.1.1"), true);
  const root = await mkdtemp("/tmp/dha-e-");
  const path = join(root, "e.sock");
  const proxy = await createEgressProxy(path);
  try {
    for (const target of [
      "http://example.com",
      "https://127.0.0.1",
      "https://[::1]",
      "https://u:p@example.com",
      "https://example.com:8443",
      "https://example.com/path",
    ])
      assert.throws(
        () => proxy.setAllowedOrigins([target]),
        /invalid_egress_policy/,
      );
    proxy.setAllowedOrigins(["https://example.com"]);
    for (const authority of [
      "127.0.0.1:443",
      "example.com:80",
      "evil.example:443",
      "example.com:443@127.0.0.1:443",
    ]) {
      const result = await new Promise((resolve, reject) => {
        const socket = connect(path);
        let text = "";
        socket.on("error", reject);
        socket.setTimeout(1000, () =>
          socket.destroy(new Error("egress_test_timeout")),
        );
        socket.once("connect", () =>
          socket.write(
            `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`,
          ),
        );
        socket.on("data", (chunk) => {
          text += chunk;
        });
        socket.on("end", () => {
          socket.destroy();
          resolve(text);
        });
      });
      assert.match(result, /^HTTP\/1.1 403 Forbidden/);
    }
  } finally {
    await proxy.close();
    await rm(root, { recursive: true });
  }
});

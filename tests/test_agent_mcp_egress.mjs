import assert from "node:assert/strict";
import test from "node:test";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createEgressProxy } from "../extensions/datahub-agent/integration/egress-proxy.mjs";

// Run in a network-none test container: 8042 is the fixed operator MCP endpoint.
function tunnel(socketPath, authority) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method: "CONNECT", path: authority });
    req.on("connect", (response, socket) =>
      resolve({ status: response.statusCode, socket }),
    );
    req.on("error", reject);
    req.setTimeout(2000, () => req.destroy(new Error("tunnel_timeout")));
    req.end();
  });
}

test("local MCP is opt-in per actor, exact-destination only, and revocable", {
  timeout: 8000,
}, async (t) => {
  const root = await mkdtemp("/tmp/dha-mcp-");
  const app = createServer((req, res) => {
    assert.equal(req.headers["proxy-authorization"], undefined);
    if (req.url === "/stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: pending\n\n");
      return;
    }
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () =>
      res.end(req.method === "POST" ? body : "local-mcp-transport-fixture"),
    );
  });
  let alice, bob;
  t.after(async () => {
    await alice?.close();
    await bob?.close();
    app.closeAllConnections();
    await new Promise((resolve) => app.close(resolve));
    await rm(root, { recursive: true });
  });
  app.listen(8042, "127.0.0.1");
  await once(app, "listening");
  const a = join(root, "a.sock"),
    b = join(root, "b.sock");
  alice = await createEgressProxy(a);
  bob = await createEgressProxy(b);
  async function denied(path, authority) {
    const result = await tunnel(path, authority);
    result.socket.destroy();
    assert.equal(result.status, 403, authority);
  }
  async function forward(socketPath, url = "http://datahub-mcp:8042/mcp") {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath,
          path: url,
          method: "POST",
          headers: {
            host: "datahub-mcp:8042",
            "proxy-authorization": "fixture-only",
          },
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => {
            body += chunk;
          });
          res.on("end", () => resolve({ status: res.statusCode, body }));
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.end("mcp-request-body");
    });
  }
  await denied(a, "datahub-mcp:8042");
  assert.equal((await forward(a)).status, 405);
  alice.setAllowedOrigins(["http://datahub-mcp:8042"]);
  await denied(b, "datahub-mcp:8042");
  assert.equal((await forward(b)).status, 405);
  assert.deepEqual(await forward(a), { status: 200, body: "mcp-request-body" });
  await new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: a,
        path: "http://datahub-mcp:8042/stream",
        headers: { host: "datahub-mcp:8042" },
      },
      (res) => {
        res.once("data", () => alice.setAllowedOrigins([]));
        res.on("error", () => {}); // Expected mid-stream revocation.
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
    req.end();
  });
  alice.setAllowedOrigins(["http://datahub-mcp:8042"]);
  for (const url of [
    "http://127.0.0.1:18080/api/graphql",
    "http://localhost:8042/mcp",
    "http://datahub-mcp:8043/mcp",
    "http://user@datahub-mcp:8042/mcp",
    "http://datahub-mcp:8042@evil.invalid/mcp",
  ])
    assert.equal((await forward(a, url)).status, 405);
  for (const authority of [
    "127.0.0.1:8042",
    "localhost:8042",
    "datahub-mcp:8043",
    "DATAHUB-MCP:8042",
    "datahub-mcp.:8042",
    "127.0.0.1:18080",
    "169.254.169.254:80",
  ])
    await denied(a, authority);
  for (const origin of [
    "http://datahub-mcp:8043",
    "http://127.0.0.1:8042",
    "http://datahub-mcp:8042/mcp",
    "http://datahub-mcp:8042?url=evil",
    "http://user@datahub-mcp:8042",
  ])
    assert.throws(
      () => alice.setAllowedOrigins([origin]),
      /invalid_egress_policy/,
    );
  const allowed = await tunnel(a, "datahub-mcp:8042");
  assert.equal(allowed.status, 200);
  const body = await new Promise((resolve, reject) => {
    const req = request(
      {
        host: "datahub-mcp",
        path: "/health",
        createConnection: () => allowed.socket,
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => resolve(text));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(body, "local-mcp-transport-fixture");
  const held = await tunnel(a, "datahub-mcp:8042");
  const closed = once(held.socket, "close");
  alice.setAllowedOrigins([]);
  await closed;
  await denied(a, "datahub-mcp:8042");
  assert.equal((await forward(a)).status, 405);
});

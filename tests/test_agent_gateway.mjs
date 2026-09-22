import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { isValidWebSessionToken } from "../extensions/datahub-agent/pi-web/lib/web-auth.ts";
import { createAgentGateway } from "../extensions/datahub-agent/integration/gateway.mjs";
import { TaskRecordError } from "../extensions/datahub-agent/integration/task-records.mjs";
import {
  nativeDiscovery,
  discoveryPolicies,
} from "../extensions/datahub-agent/integration/native-discovery.mjs";
import {
  BrowserGrants,
  GrantError,
} from "../extensions/datahub-agent/integration/browser-grants.mjs";

const actors = {
  alice: {
    tenant: "fixture",
    urn: "urn:li:corpuser:alice",
    key: "a".repeat(48),
  },
  bob: { tenant: "fixture", urn: "urn:li:corpuser:bob", key: "b".repeat(48) },
};
const frontend = "http://localhost:9002";
const password = "synthetic-runtime-password-not-a-real-credential";

function call(
  port,
  path,
  { host = `localhost:${port}`, method = "GET", headers = {}, data } = {},
) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          host,
          ...headers,
          ...(data === undefined ? {} : { "content-type": "application/json" }),
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          resolve({
            status: response.statusCode,
            headers: response.headers,
            text,
            data: response.headers["content-type"]?.startsWith(
              "application/json",
            )
              ? JSON.parse(text)
              : null,
          });
        });
      },
    );
    request.on("error", reject);
    request.end(data === undefined ? undefined : JSON.stringify(data));
  });
}

async function stop(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

test("gateway real HTTP boundary with synthetic identity and runtime", async (t) => {
  const received = [];
  const ingestionCalls = [];
  const taskCalls = [];
  const discoveryCalls = [];
  const discoveryScopes = discoveryPolicies({
    [actors.alice.key]: [
      {
        sourceId: "fixture",
        root: "/approved",
        paths: ["pipeline.py"],
        snapshotSha256: "a".repeat(64),
        modelContextApproved: true,
      },
    ],
  });
  const browserAssetsDirectory = await mkdtemp("/tmp/dha-public-");
  t.after(() => rm(browserAssetsDirectory, { recursive: true }));
  await mkdir(join(browserAssetsDirectory, "_next/static"), {
    recursive: true,
  });
  await writeFile(
    join(browserAssetsDirectory, "index.html"),
    "<h1>immutable operator shell</h1>",
  );
  await writeFile(
    join(browserAssetsDirectory, "_next/static/app.js"),
    "/* immutable operator asset */",
  );
  const runtimeServer = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    received.push({ headers: request.headers, path: request.url, body });
    const token = request.headers.cookie?.replace(/^pi_web_session=/, "");
    if (!isValidWebSessionToken(token, password)) {
      response.writeHead(401);
      response.end();
      return;
    }
    response.writeHead(200, {
      "content-type": "application/json",
      "set-cookie": "must-not-escape=synthetic",
      "cache-control": "public",
      "access-control-allow-origin": "*",
    });
    response.end(JSON.stringify({ ok: true }));
  });
  t.after(async () => {
    if (runtimeServer.listening) await stop(runtimeServer);
  });
  runtimeServer.listen(0, "127.0.0.1");
  await once(runtimeServer, "listening");
  let now = 0;
  let provisioningTime = 0;
  let provisioned = 0;
  const grants = new BrowserGrants({
    clock: () => now,
    ticketMs: 10,
    leaseMs: 100,
  });
  const server = await createAgentGateway({
    gatewayOrigin: "http://localhost:0",
    datahubOrigin: frontend,
    browserAssetsDirectory,
    grants,
    mfeDirectory: fileURLToPath(
      new URL("../extensions/datahub-agent/mfe/dist/", import.meta.url),
    ),
    verifyIdentity: async (cookie) => {
      const actor = Object.entries(actors).find(
        ([name]) => cookie === `PLAY_SESSION=${name}`,
      )?.[1];
      if (!actor) throw new GrantError();
      return actor;
    },
    runtimeForActor: async () => {
      provisioned++;
      now += provisioningTime;
      return {
        origin: `http://127.0.0.1:${runtimeServer.address().port}`,
        password,
      };
    },
    ingestionRequest: async (text, context) => {
      context.assertActive();
      ingestionCalls.push({ text, actor: context.actor.urn });
      return { actor: context.actor.urn };
    },
    discoveryRequest: async (text, context) => {
      discoveryCalls.push(context.actor.urn);
      return nativeDiscovery(text, {
        ...context,
        sources: discoveryScopes.get(context.actor.key) ?? [],
        async analyze() {
          return { publicationAuthorized: false, candidates: [] };
        },
      });
    },
    taskRequest: async (text, context) => {
      context.assertActive();
      assert.equal(context.runtime.password, password);
      taskCalls.push({ text, actor: context.actor.urn });
      if (text === "unconfirmed")
        throw new TaskRecordError("task_write_unconfirmed", 502, {
          urn: "urn:li:dataProcessInstance:fixture",
          expectedVersion: "1",
        });
      return { actor: context.actor.urn };
    },
    maxRequestBytes: 128,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const bootstrap = (name = "alice") =>
    call(port, "/agent/bootstrap", {
      method: "POST",
      headers: { origin: frontend, cookie: `PLAY_SESSION=${name}` },
      data: {},
    });
  const exchange = (launchUrl) => {
    const launch = new URL(launchUrl);
    return call(port, "/agent/exchange", {
      host: launch.host,
      method: "POST",
      headers: { origin: launch.origin },
      data: { ticket: launch.hash.slice(1) },
    });
  };
  try {
    await t.test(
      "discovery checks parent origin, actor, grant, source scope and revocation",
      async () => {
        const launch = (await bootstrap()).data;
        const intent = JSON.stringify({
          action: "analyze",
          sourceId: "fixture",
          requestId: "00000000-0000-4000-8000-000000000001",
        });
        const data = {
          grantId: launch.grantId,
          revokeToken: launch.revokeToken,
          request: intent,
        };
        const headers = { origin: frontend, cookie: "PLAY_SESSION=alice" };
        for (const bad of [
          { origin: frontend },
          { origin: frontend, cookie: "PLAY_SESSION=bob" },
          {
            origin: new URL(launch.launchUrl).origin,
            cookie: "PLAY_SESSION=alice",
          },
        ])
          assert.notEqual(
            (
              await call(port, "/agent/discovery", {
                method: "POST",
                headers: bad,
                data,
              })
            ).status,
            200,
          );
        assert.notEqual(
          (
            await call(port, "/agent/discovery", {
              method: "POST",
              headers,
              data: { ...data, revokeToken: "wrong" },
            })
          ).status,
          200,
        );
        assert.equal(discoveryCalls.length, 0);
        assert.equal(
          (
            await call(port, "/agent/discovery", {
              method: "POST",
              headers,
              data,
            })
          ).data.publicationAuthorized,
          false,
        );
        assert.deepEqual(discoveryCalls, [actors.alice.urn]);
        const bob = (await bootstrap("bob")).data;
        const denied = await call(port, "/agent/discovery", {
          method: "POST",
          headers: { origin: frontend, cookie: "PLAY_SESSION=bob" },
          data: {
            grantId: bob.grantId,
            revokeToken: bob.revokeToken,
            request: intent,
          },
        });
        assert.equal(denied.status, 403);
        assert.equal(denied.data.error, "discovery_source_not_authorized");
        assert.equal(
          (
            await call(port, "/agent/discovery", {
              host: new URL(launch.launchUrl).host,
              method: "POST",
              headers: { origin: new URL(launch.launchUrl).origin },
              data,
            })
          ).status,
          403,
        );
        await call(port, "/agent/revoke", {
          method: "POST",
          headers,
          data: { grantId: launch.grantId, revokeToken: launch.revokeToken },
        });
        assert.notEqual(
          (
            await call(port, "/agent/discovery", {
              method: "POST",
              headers,
              data,
            })
          ).status,
          200,
        );
        assert.equal(discoveryCalls.length, 2);
      },
    );
    await t.test(
      "ingestion requires trusted parent origin, fresh matching identity and parent proof",
      async () => {
        const launch = (await bootstrap()).data;
        const data = {
          grantId: launch.grantId,
          revokeToken: launch.revokeToken,
          request: "fixture-intent",
        };
        for (const headers of [
          { origin: frontend },
          { origin: frontend, cookie: "PLAY_SESSION=bob" },
          {
            origin: new URL(launch.launchUrl).origin,
            cookie: "PLAY_SESSION=alice",
          },
        ])
          assert.notEqual(
            (
              await call(port, "/agent/ingestion", {
                method: "POST",
                headers,
                data,
              })
            ).status,
            200,
          );
        assert.equal(ingestionCalls.length, 0);
        const headers = { origin: frontend, cookie: "PLAY_SESSION=alice" };
        assert.notEqual(
          (
            await call(port, "/agent/ingestion", {
              method: "POST",
              headers,
              data: { ...data, revokeToken: "wrong" },
            })
          ).status,
          200,
        );
        assert.equal(ingestionCalls.length, 0);
        assert.equal(
          (
            await call(port, "/agent/ingestion", {
              method: "POST",
              headers,
              data,
            })
          ).data.actor,
          actors.alice.urn,
        );
        assert.deepEqual(ingestionCalls, [
          { text: "fixture-intent", actor: actors.alice.urn },
        ]);
        await call(port, "/agent/revoke", {
          method: "POST",
          headers,
          data: { grantId: launch.grantId, revokeToken: launch.revokeToken },
        });
        assert.notEqual(
          (
            await call(port, "/agent/ingestion", {
              method: "POST",
              headers,
              data,
            })
          ).status,
          200,
        );
        assert.equal(ingestionCalls.length, 1);
      },
    );
    await t.test(
      "Task control route requires parent origin/proof and fresh actor, and bounds bodies independently",
      async () => {
        const launch = (await bootstrap()).data;
        const headers = { origin: frontend, cookie: "PLAY_SESSION=alice" };
        const data = {
          grantId: launch.grantId,
          revokeToken: launch.revokeToken,
          request: "task-fixture",
        };
        for (const bad of [
          {
            origin: new URL(launch.launchUrl).origin,
            cookie: "PLAY_SESSION=alice",
          },
          { origin: frontend, cookie: "PLAY_SESSION=bob" },
          { origin: frontend },
        ])
          assert.notEqual(
            (
              await call(port, "/agent/tasks", {
                method: "POST",
                headers: bad,
                data,
              })
            ).status,
            200,
          );
        assert.equal(taskCalls.length, 0);
        assert.equal(
          (await call(port, "/agent/tasks", { method: "POST", headers, data }))
            .data.actor,
          actors.alice.urn,
        );
        const uncertain = await call(port, "/agent/tasks", {
          method: "POST",
          headers,
          data: { ...data, request: "unconfirmed" },
        });
        assert.equal(uncertain.status, 502);
        assert.equal(
          uncertain.data.reconciliation.urn,
          "urn:li:dataProcessInstance:fixture",
        );
        assert.equal(
          (
            await call(port, "/agent/tasks", {
              method: "POST",
              headers,
              data: { ...data, request: "x".repeat(5000) },
            })
          ).status,
          200,
        );
        assert.equal(
          (
            await call(port, "/agent/ingestion", {
              method: "POST",
              headers,
              data: { ...data, request: "x".repeat(5000) },
            })
          ).status,
          413,
        );
        assert.equal(
          (
            await call(port, "/agent/tasks", {
              method: "POST",
              headers,
              data: { ...data, request: "x".repeat(17000) },
            })
          ).status,
          413,
        );
        const before = taskCalls.length;
        provisioningTime = 200;
        assert.notEqual(
          (await call(port, "/agent/tasks", { method: "POST", headers, data }))
            .status,
          200,
        );
        provisioningTime = 0;
        assert.equal(taskCalls.length, before);
      },
    );
    await t.test(
      "only pinned PWA assets are public on runtime origins, without provisioning",
      async () => {
        const before = provisioned;
        const host = `${actors.alice.key}.localhost:${port}`;
        for (const path of [
          "/sw.js?v=0.9.0",
          "/offline.html",
          "/manifest.webmanifest",
          "/icons/icon-192.png",
          "/icons/icon-512.png",
          "/icons/apple-touch-icon.png",
        ]) {
          const result = await call(port, path, { host });
          assert.equal(result.status, 200);
          assert.equal(result.headers["set-cookie"], undefined);
        }
        for (const path of [
          "/api/sessions",
          "/api/files/home/node/secret",
          "/sw.js/../../package.json",
          "/icons/../../.env",
        ]) {
          assert.equal((await call(port, path, { host })).status, 401);
        }
        assert.equal(
          (await call(port, "/?session=unknown", { host })).text,
          "<h1>immutable operator shell</h1>",
        );
        assert.equal(
          (await call(port, "/_next/static/app.js", { host })).text,
          "/* immutable operator asset */",
        );
        assert.equal(
          (await call(port, "/", { host, headers: { rsc: "1" } })).status,
          401,
        );
        assert.equal(
          (
            await call(port, "/", {
              host,
              headers: { cookie: "datahub_agent_session=forged" },
            })
          ).status,
          401,
        );
        assert.equal(provisioned, before);
      },
    );
    await t.test(
      "static Federation assets are public, arbitrary files and hosts are not",
      async () => {
        assert.equal((await call(port, "/mfe/remoteEntry.js")).status, 200);
        assert.equal((await call(port, "/mfe/../../package.json")).status, 403);
        assert.equal(
          (await call(port, "/mfe/remoteEntry.js", { host: "evil.example" }))
            .status,
          403,
        );
        assert.equal((await call(port, "//evil.example/api")).status, 400);
      },
    );
    await t.test(
      "bootstrap rejects missing identity, untrusted origins and caller actor fields",
      async () => {
        const before = provisioned;
        assert.equal(
          (
            await call(port, "/agent/bootstrap", {
              method: "POST",
              headers: { origin: frontend },
              data: {},
            })
          ).status,
          401,
        );
        assert.equal(
          (
            await call(port, "/agent/bootstrap", {
              method: "POST",
              headers: {
                origin: "http://evil.example",
                cookie: "PLAY_SESSION=alice",
              },
              data: {},
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await call(port, "/agent/bootstrap", {
              method: "POST",
              headers: { origin: frontend, cookie: "PLAY_SESSION=alice" },
              data: { actor: actors.bob },
            })
          ).status,
          400,
        );
        assert.equal(provisioned, before);
      },
    );
    await t.test(
      "one ticket exchange wins; proxy strips all human identity credentials",
      async () => {
        const issued = (await bootstrap()).data;
        const outcomes = await Promise.all([
          exchange(issued.launchUrl),
          exchange(issued.launchUrl),
        ]);
        assert.deepEqual(outcomes.map((r) => r.status).sort(), [200, 401]);
        const accepted = outcomes.find((r) => r.status === 200);
        const cookie = accepted.headers["set-cookie"][0].split(";", 1)[0];
        assert.match(
          accepted.headers["set-cookie"][0],
          /HttpOnly; SameSite=None; Secure; Partitioned; Path=\//,
        );
        const launch = new URL(issued.launchUrl);
        const result = await call(port, "/api/terminal/fixture", {
          host: launch.host,
          method: "POST",
          headers: {
            origin: launch.origin,
            cookie: `${cookie}; PLAY_SESSION=must-not-forward`,
            authorization: "Bearer must-not-forward",
            "x-actor": "must-not-forward",
            "x-forwarded-host": "evil.example",
          },
          data: { input: "echo fixture" },
        });
        assert.equal(result.status, 200);
        assert.equal(result.headers["set-cookie"], undefined);
        assert.equal(result.headers["access-control-allow-origin"], undefined);
        assert.equal(result.headers["cache-control"], "no-store");
        assert.match(
          result.headers["content-security-policy"],
          /frame-ancestors http:\/\/localhost:9002/,
        );
        const sent = received.at(-1);
        assert.match(sent.headers.cookie, /^pi_web_session=/);
        assert.doesNotMatch(
          sent.headers.cookie,
          /PLAY_SESSION|must-not-forward/,
        );
        assert.equal(
          isValidWebSessionToken(
            sent.headers.cookie.slice("pi_web_session=".length),
            password,
          ),
          true,
        );
        assert.equal(sent.headers["x-actor"], undefined);
        assert.equal(sent.headers["x-forwarded-host"], undefined);
        assert.equal(sent.headers.authorization, undefined);
        assert.deepEqual(JSON.parse(sent.body), { input: "echo fixture" });
        assert.equal(
          (await call(port, "/", { host: launch.host, headers: { cookie } }))
            .status,
          200,
        );
        assert.equal(
          (
            await call(port, "/api/sessions", {
              host: `${actors.bob.key}.localhost:${port}`,
              headers: { cookie },
            })
          ).status,
          401,
        );
        assert.equal(
          (
            await call(port, "/api/sessions", {
              host: launch.host,
              headers: { cookie, origin: "http://evil.example" },
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await call(port, "/agent/heartbeat", {
              host: launch.host,
              method: "POST",
              headers: { cookie, origin: launch.origin },
              data: { grantId: issued.grantId },
            })
          ).status,
          403,
        );
        const before = received.length;
        assert.equal(
          (
            await call(port, "/api/upload", {
              host: launch.host,
              method: "POST",
              headers: { cookie, origin: launch.origin },
              data: { huge: "x".repeat(200) },
            })
          ).status,
          413,
        );
        assert.equal(received.length, before);
        const revoked = await call(port, "/agent/revoke", {
          method: "POST",
          headers: { origin: frontend }, // Cleanup after the human session cookie is gone.
          data: { grantId: issued.grantId, revokeToken: issued.revokeToken },
        });
        assert.equal(revoked.status, 200);
        assert.equal(
          (
            await call(port, "/api/sessions", {
              host: launch.host,
              headers: { cookie },
            })
          ).status,
          401,
        );
      },
    );
    await t.test(
      "stop proof does not grant renewal or permit forged revocation",
      async () => {
        const issued = (await bootstrap()).data;
        const launch = new URL(issued.launchUrl);
        const accepted = await exchange(issued.launchUrl);
        const cookie = accepted.headers["set-cookie"][0].split(";", 1)[0];
        const active = async () =>
          (
            await call(port, "/api/sessions", {
              host: launch.host,
              headers: { cookie },
            })
          ).status;
        for (const path of ["/agent/heartbeat", "/agent/revoke"]) {
          assert.equal(
            (
              await call(port, path, {
                method: "POST",
                headers: { origin: frontend, cookie: "PLAY_SESSION=alice" },
                data: { grantId: issued.grantId, revokeToken: "x".repeat(43) },
              })
            ).status,
            401,
          );
          assert.equal(await active(), 200);
        }
        assert.equal(
          (
            await call(port, "/agent/revoke", {
              method: "POST",
              headers: { origin: frontend },
              data: { grantId: issued.grantId },
            })
          ).status,
          400,
        );
        const data = {
          grantId: issued.grantId,
          revokeToken: issued.revokeToken,
        };
        assert.equal(
          (
            await call(port, "/agent/revoke", {
              method: "POST",
              headers: { origin: "http://evil.example" },
              data,
            })
          ).status,
          403,
        );
        assert.equal(await active(), 200);
        assert.equal(
          (
            await call(port, "/agent/heartbeat", {
              method: "POST",
              headers: { origin: frontend, cookie: "PLAY_SESSION=alice" },
              data,
            })
          ).status,
          200,
        );
        assert.equal(
          (
            await call(port, "/agent/heartbeat", {
              method: "POST",
              headers: { origin: frontend, cookie: "PLAY_SESSION=bob" },
              data,
            })
          ).status,
          401,
        );
        assert.equal(await active(), 401);
      },
    );
    await t.test(
      "runtime readiness cannot resurrect an expired browser grant",
      async () => {
        const issued = (await bootstrap("bob")).data;
        provisioningTime = 101;
        const result = await exchange(issued.launchUrl);
        assert.equal(result.status, 401);
        assert.equal(result.headers["set-cookie"], undefined);
        provisioningTime = 0;
      },
    );
  } finally {
    await stop(server);
    await stop(runtimeServer);
  }
});

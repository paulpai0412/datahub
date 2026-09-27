import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { resolve } from "node:path";
import { createAgentGateway } from "../extensions/datahub-agent/integration/gateway.mjs";
import { QueryError } from "../extensions/datahub-agent/integration/query-metadata.mjs";
import { actor } from "./fixtures/query-fixture.mjs";

test("general query HTTP boundary carries larger JOIN intent, stable denial, cancellation and launch origin without per-actor SQL list", async () => {
  let calls = 0;
  const server = await createAgentGateway({
    gatewayOrigin: "http://localhost:0",
    datahubOrigin: "http://localhost:9002",
    mfeDirectory: resolve("extensions/datahub-agent/mfe/dist"),
    queryGrafanaOrigin: "http://localhost:3000",
    verifyIdentity: async (cookie) => {
      if (cookie !== "PLAY_SESSION=fixture")
        throw new QueryError("query_metadata_denied", 403);
      return actor;
    },
    runtimeForActor: async () => ({
      origin: "http://127.0.0.1:9",
      password: "test-only",
    }),
    sqlRequest: async (text, context) => {
      context.assertActive();
      assert.equal(context.actor, actor);
      assert.ok(context.signal);
      assert.equal(text.length, 6000);
      calls++;
      throw new QueryError("query_source_denied", 403);
    },
    grafanaRequest: async (_text, context) => {
      assert.ok(context.signal);
      assert.ok(context.grantId);
      return { status: "synthetic" };
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const post = (path, data, headers = {}) =>
    fetch(`http://localhost:${port}${path}`, {
      method: "POST",
      headers: {
        origin: "http://localhost:9002",
        cookie: "PLAY_SESSION=fixture",
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(data),
    });
  try {
    const bootstrap = await post("/agent/bootstrap", {});
    const launch = await bootstrap.json();
    assert.equal(bootstrap.status, 200, JSON.stringify(launch));
    assert.equal(launch.grafanaOrigin, "http://localhost:3000");
    const envelope = {
      grantId: launch.grantId,
      revokeToken: launch.revokeToken,
      request: "x".repeat(6000),
    };
    const result = await post("/agent/sql", envelope);
    assert.equal(result.status, 403);
    assert.equal((await result.json()).error, "query_source_denied");
    assert.equal(calls, 1);
    assert.equal(
      (await post("/agent/sql", envelope, { origin: "http://evil.invalid" }))
        .status,
      403,
    );
    assert.equal(calls, 1);
    assert.equal(
      (await post("/agent/grafana", { ...envelope, request: "synthetic" }))
        .status,
      200,
    );
    assert.equal(
      (await post("/agent/sql", { ...envelope, request: "x".repeat(70000) }))
        .status,
      413,
    );
    assert.equal(calls, 1);
    await post("/agent/revoke", {
      grantId: launch.grantId,
      revokeToken: launch.revokeToken,
    });
    assert.notEqual((await post("/agent/sql", envelope)).status, 200);
    assert.equal(calls, 1);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

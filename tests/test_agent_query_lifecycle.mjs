// Isolated transport/Host lifecycle tests. DB child is explicit fixture, not live SQL.
import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { MessageChannel } from "node:worker_threads";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createAgentGateway } from "../extensions/datahub-agent/integration/gateway.mjs";
import { createMetadataQueryHost } from "../extensions/datahub-agent/integration/metadata-query.mjs";
import {
  createQuerySource,
  runQueryChild,
} from "../extensions/datahub-agent/integration/query-source.mjs";
import { installSqlBridge } from "../extensions/datahub-agent/mfe/sql.js";
import { BrowserGrants } from "../extensions/datahub-agent/integration/browser-grants.mjs";
import { exchangeFixtureTicket } from "./fixtures/query-lifecycle-http.mjs";
import {
  actor,
  binding,
  metadata,
  plan,
  chart,
  context,
  grafana,
} from "./fixtures/query-fixture.mjs";

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kills = [];
  child.kill = (signal) => {
    child.kills.push(signal);
    child.emit("kill", signal);
    return true;
  };
  return child;
}

const request = (requestId = randomUUID()) =>
  JSON.stringify({ action: "execute_query", requestId, plan, chart });
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test("native fixture exchanges its ticket before 30s; heartbeat cannot rescue an unexchanged ticket", async (t) => {
  let time = 0;
  const grants = new BrowserGrants({ clock: () => time });
  const server = await createAgentGateway({
    gatewayOrigin: "http://localhost:0",
    datahubOrigin: "http://localhost:9002",
    mfeDirectory: resolve("extensions/datahub-agent/mfe/dist"),
    grants,
    verifyIdentity: async () => actor,
    runtimeForActor: async () => ({
      origin: "http://127.0.0.1:9",
      password: "fixture",
    }),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://localhost:${server.address().port}`;
  const post = async (path, body) => {
    const r = await fetch(base + path, {
      method: "POST",
      headers: {
        origin: "http://localhost:9002",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  const fresh = async () => (await post("/agent/bootstrap", {})).body;
  const unexchanged = await fresh(),
    exchanged = await fresh();
  assert.equal(
    (await exchangeFixtureTicket(base, exchanged.launchUrl)).status,
    200,
  );
  const beat = (grant) =>
    post("/agent/heartbeat", {
      grantId: grant.grantId,
      revokeToken: grant.revokeToken,
    });
  time = 20000;
  assert.equal((await beat(unexchanged)).status, 200);
  assert.equal((await beat(exchanged)).status, 200);
  time = 31000;
  assert.equal((await beat(unexchanged)).status, 401);
  assert.equal((await beat(exchanged)).status, 200);
});

test("40-second child deadline and kill escalation never release before close, even with late output", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const child = fakeChild();
  let settled = false;
  const pending = runQueryChild(
    { operation: "execute" },
    { spawnProcess: () => child },
  );
  pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  t.mock.timers.tick(39999);
  assert.deepEqual(child.kills, []);
  t.mock.timers.tick(1);
  assert.deepEqual(child.kills, ["SIGTERM"]);
  await nextTurn();
  assert.equal(settled, false);
  t.mock.timers.tick(1000);
  assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
  child.stdout.write(JSON.stringify({ rows: [{ private: "late-success" }] }));
  await nextTurn();
  assert.equal(settled, false);
  child.emit("close", 0, null);
  await assert.rejects(pending, /query_execution_unconfirmed/);
  t.mock.timers.tick(60000);
  assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
});

test("MFE cancel -> real HTTP disconnect -> Host child drain; source slots recover without replay", {
  timeout: 15000,
}, async (t) => {
  const compiled = await createQuerySource().compile(
    plan,
    metadata,
    binding,
    context,
  );
  const children = [],
    spawned = new EventEmitter();
  let executions = 0,
    publications = 0;
  const source = createQuerySource({
    getConnection: async () => ({ database: "fixture-only" }),
    run: (payload, ctx) => {
      if (payload.operation === "compile") return Promise.resolve(compiled);
      executions++;
      return runQueryChild(payload, {
        ...ctx,
        spawnProcess: (_python, args, opts) => {
          assert.deepEqual(args.slice(0, 2), ["-I", "-B"]);
          assert.equal(opts.shell, false);
          const child = fakeChild();
          children.push(child);
          // Resolve the test's barrier only once real request dispatch reached spawn.
          queueMicrotask(() => spawned.emit("spawn", child));
          return child;
        },
      });
    },
  });
  const host = createMetadataQueryHost({
    bindings: [binding],
    readMetadata: async () => ({
      snapshots: structuredClone(metadata),
      visible: async () => true,
    }),
    source,
    grafana,
    verifyIdentity: async () => actor,
    publishDashboard: async () => {
      publications++;
      throw Error("unexpected_publication");
    },
  });
  const server = await createAgentGateway({
    gatewayOrigin: "http://localhost:0",
    datahubOrigin: "http://localhost:9002",
    mfeDirectory: resolve("extensions/datahub-agent/mfe/dist"),
    verifyIdentity: async () => actor,
    runtimeForActor: async () => ({
      origin: "http://127.0.0.1:9",
      password: "fixture",
    }),
    sqlRequest: (text, ctx) => host.execute(text, ctx),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const originalWindow = globalThis.window,
    listeners = new Set(),
    ports = [];
  let stopBridge = () => {};
  t.after(async () => {
    stopBridge();
    globalThis.window = originalWindow;
    for (const p of ports) p.close();
    // Fixture teardown only; no real DB child exists here.
    for (const child of children) child.emit("close", null, "SIGTERM");
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://localhost:${server.address().port}`;
  const post = (path, body, signal) =>
    fetch(base + path, {
      method: "POST",
      signal,
      headers: {
        origin: "http://localhost:9002",
        cookie: "PLAY_SESSION=fixture",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const bootstrap = await post("/agent/bootstrap", {}),
    grant = await bootstrap.json();
  assert.equal(bootstrap.status, 200);
  const envelope = (text) => ({
    grantId: grant.grantId,
    revokeToken: grant.revokeToken,
    request: text,
  });
  globalThis.window = {
    addEventListener: (_event, fn) => listeners.add(fn),
    removeEventListener: (_event, fn) => listeners.delete(fn),
  };
  const frame = { contentWindow: {} };
  stopBridge = installSqlBridge({
    frame,
    origin: "http://fixture.example",
    execute: async (input, signal) => {
      const r = await post(
        "/agent/sql",
        envelope(JSON.stringify(input)),
        signal,
      );
      return r.json();
    },
    readResult: async () => {
      throw Error("unexpected_result_read");
    },
  });
  const channel = new MessageChannel();
  ports.push(channel.port1, channel.port2);
  const replies = [];
  channel.port1.on("message", (msg) => replies.push(msg));
  const cancelledInput = request(),
    firstSpawn = once(spawned, "spawn");
  const bridgePending = [...listeners][0]({
    source: frame.contentWindow,
    origin: "http://fixture.example",
    data: { type: "datahub-sql", body: cancelledInput },
    ports: [channel.port2],
  });
  const [first] = await firstSpawn;
  const secondSpawn = once(spawned, "spawn"),
    otherRequest = post("/agent/sql", envelope(request()));
  const [second] = await secondSpawn;
  assert.equal(executions, 2);
  const denied = await post("/agent/sql", envelope(request()));
  assert.equal(denied.status, 429);
  assert.equal((await denied.json()).error, "query_capacity_exhausted");
  const killed = once(first, "kill");
  channel.port1.postMessage({ type: "cancel" });
  assert.deepEqual(await killed, ["SIGTERM"]);
  await bridgePending;
  assert.deepEqual(replies, []);
  const stillFull = await post("/agent/sql", envelope(request()));
  assert.equal(
    stillFull.status,
    429,
    "HTTP abort alone must not free the source slot",
  );
  assert.equal(executions, 2);
  // Late bytes cannot turn a cancelled operation into an available receipt.
  first.stdout.write(
    JSON.stringify({
      columns: compiled.columns,
      rows: [],
      sql: compiled.sql,
      truncated: false,
      observedAt: new Date().toISOString(),
    }),
  );
  first.emit("close", 0, null);
  const repeat = await post("/agent/sql", envelope(cancelledInput));
  assert.equal((await repeat.json()).error, "query_cancelled");
  assert.equal(executions, 2, "same cancelled request is not re-executed");
  const replacementSpawn = once(spawned, "spawn"),
    replacement = post("/agent/sql", envelope(request()));
  const [third] = await replacementSpawn;
  const success = () =>
    JSON.stringify({
      columns: compiled.columns,
      rows: [{ region: "FIXTURE", revenue: "1.00" }],
      sql: compiled.sql,
      truncated: false,
      observedAt: new Date().toISOString(),
    });
  for (const child of [second, third]) {
    child.stdout.write(success());
    child.emit("close", 0, null);
  }
  for (const pending of [otherRequest, replacement]) {
    const r = await pending,
      receipt = await r.json();
    assert.equal(r.status, 200);
    assert.equal(receipt.state, "AVAILABLE");
    assert.equal("rows" in receipt, false);
  }
  assert.equal(executions, 3);
  assert.equal(publications, 0);
});

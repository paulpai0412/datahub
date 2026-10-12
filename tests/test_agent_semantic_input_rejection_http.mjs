// Actual HTTP gateway/Host/MFE transport; disposable API fixture only.
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { MessageChannel } from "node:worker_threads";
import { installSemanticBridge } from "../extensions/datahub-agent/mfe/semantic.js";
import { createAgentGateway } from "../extensions/datahub-agent/integration/gateway.mjs";
import { semanticHost } from "../extensions/datahub-agent/integration/native-semantic-tasks.mjs";
import { TaskRecordError } from "../extensions/datahub-agent/integration/task-records.mjs";
import { semanticCatalogFixture } from "./fixtures/semantic-catalog-fixture.mjs";
import { sourceUrn, datasetUrn } from "./fixtures/semantic-fixture.mjs";
import { maintenanceDriverResponse } from "./semantic-maintenance-driver-response.mjs";

test("gateway returns an exact correctable missing-reference location before any child/native write", async t => {
  const f = semanticCatalogFixture();
  const start = { action: "start_maintenance", requestId: randomUUID(), sessionId: f.sessionId, sourceUrn, assetUrns: [datasetUrn] };
  f.writes.pending = start;
  const root = await f.call({ ...start, uiRequestId: "fixture-ui" });
  const inspected = await f.inspect();
  const server = await createAgentGateway({ gatewayOrigin: "http://localhost:0", datahubOrigin: "http://datahub.invalid",
    mfeDirectory: new URL("../extensions/datahub-agent/mfe/dist/", import.meta.url).pathname,
    async verifyIdentity(cookie) { assert.equal(cookie, "PLAY_SESSION=disposable-fixture; actor=fixture"); return f.context.actor; },
    async runtimeForActor() { return f.context.runtime; },
    // The HTTP gateway verifies the fixture actor; native reads must still
    // use the disposable API transport/cookie, never the gateway's real fetch.
    semanticRequest: (raw, context) => semanticHost(raw, { ...context, ...f.context, actor: context.actor }),
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  async function post(path, body) {
    const response = await fetch(`http://localhost:${server.address().port}${path}`, { method: "POST", headers: {
      origin: "http://datahub.invalid", cookie: "PLAY_SESSION=disposable-fixture; actor=fixture", "content-type": "application/json",
    }, body: JSON.stringify(body) });
    return { ok: response.ok, status: response.status, value: await response.json() };
  }
  const bootstrap = await post("/agent/bootstrap", {}); assert.equal(bootstrap.status, 200);
  const { grantId, revokeToken } = bootstrap.value;
  const request = { action: "prepare_maintenance", requestId: randomUUID(), sessionId: f.sessionId,
    maintenanceRunUrn: root.maintenanceRunUrn, contract: "catalog/1", sourceUrn, assetUrn: datasetUrn,
    snapshotDigest: inspected.snapshotDigest, version: root.runVersion,
    candidates: [{ kind: "term", operation: "add", fieldPath: "order_id",
      value: `urn:li:glossaryTerm:ekop-semantic-${"e".repeat(64)}`, reason: "Explicit fixture evidence", evidenceIds: ["asset:identity"] }] };
  f.writes.pending = request; const before = f.writes.recordWrites;
  const reply = await post("/agent/semantic", { grantId, revokeToken, request: JSON.stringify({ ...request, uiRequestId: "fixture-ui" }) });
  assert.equal(reply.status, 400, JSON.stringify(reply.value));
  assert.equal(reply.value.inputRejection.issue, "semantic_reference_not_found");
  assert.deepEqual(reply.value.inputRejection.location, { inputPath: "candidates[0].value", candidateIndex: 0,
    fieldPath: "order_id", kind: "term", referenceUrn: request.candidates[0].value });
  assert.equal(reply.value.reconciliation, undefined);
  assert.equal(maintenanceDriverResponse(request, reply.value, reply.ok), "MODEL_CORRECTION");
  assert.equal(maintenanceDriverResponse({ ...request, requestId: randomUUID() }, reply.value, reply.ok), "STOP");
  assert.equal(f.writes.recordWrites, before); assert.equal(f.writes.targetWrites, 0);
});

test("gateway carries only typed pre-write rejection evidence; ordinary failures cannot forge it", async t => {
  const f = semanticCatalogFixture(); let forged = false, entered = 0;
  const server = await createAgentGateway({ gatewayOrigin: "http://localhost:0", datahubOrigin: "http://datahub.invalid",
    mfeDirectory: new URL("../extensions/datahub-agent/mfe/dist/", import.meta.url).pathname,
    async verifyIdentity(cookie) { assert.equal(cookie, "PLAY_SESSION=disposable-fixture; actor=fixture"); return f.context.actor; },
    async runtimeForActor() { throw Error("no runtime needed for pure shape rejection"); },
    async semanticRequest(raw, context) {
      entered++;
      if (forged) { const error = new TaskRecordError("invalid_semantic_maintenance_request");
        error.inputRejection = { phase: "INPUT_VALIDATION", nativeWriteStarted: false }; throw error; }
      return semanticHost(raw, { ...f.context, ...context });
    },
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const origin = `http://localhost:${server.address().port}`;
  async function post(path, body) {
    const response = await fetch(origin + path, { method: "POST", headers: {
      origin: "http://datahub.invalid", cookie: "PLAY_SESSION=disposable-fixture; actor=fixture", "content-type": "application/json",
    }, body: JSON.stringify(body) });
    return { ok: response.ok, status: response.status, value: await response.json() };
  }
  const bootstrap = await post("/agent/bootstrap", {}); assert.equal(bootstrap.status, 200);
  const { grantId, revokeToken } = bootstrap.value;
  assert.equal(typeof grantId, "string"); assert.equal(typeof revokeToken, "string");
  const root = `urn:li:dataProcessInstance:semantic-${f.context.actor.key}-${randomUUID()}`;
  const previousWindow = globalThis.window;
  let listener;
  globalThis.window = { location: { href: "http://datahub.invalid/mfe/agent" },
    history: { state: null, replaceState() {} },
    addEventListener(_name, fn) { listener = fn; }, removeEventListener() {} };
  const frame = { contentWindow: {} };
  const uninstall = installSemanticBridge({ frame, origin: "http://fixture-iframe.invalid", actorKey: f.context.actor.key,
    async send(request) { return (await post("/agent/semantic", { grantId, revokeToken, request: JSON.stringify(request) })).value; } });
  t.after(() => { uninstall(); globalThis.window = previousWindow; });
  for (const shape of [
    { offset: 20, gap: { code: "INSUFFICIENT_EVIDENCE", reason: "Fixture input" } },
    { gap: { code: "INSUFFICIENT_EVIDENCE", reason: "Fixture input", operation: { action: "prepare_maintenance", maintenanceRunUrn: root } } },
  ]) {
    const request = { action: "prepare_maintenance", requestId: randomUUID(), sessionId: f.sessionId,
      maintenanceRunUrn: root, contract: "catalog/1", sourceUrn, assetUrn: datasetUrn, snapshotDigest: "a".repeat(64), ...shape };
    const before = f.writes.recordWrites;
    const reply = await post("/agent/semantic", { grantId, revokeToken, request: JSON.stringify({ ...request, uiRequestId: "fixture-ui" }) });
    assert.equal(reply.status, 400, JSON.stringify({ value: reply.value, entered })); assert.equal(reply.value.reconciliation, undefined);
    assert.equal(maintenanceDriverResponse(request, reply.value, reply.ok), "MODEL_CORRECTION");
    assert.equal(maintenanceDriverResponse({ ...request, uiRequestId: "fixture-ui" }, reply.value, reply.ok), "MODEL_CORRECTION",
      "driver observes the exact parent POST, including its added UI correlation");
    assert.equal(maintenanceDriverResponse({ ...request, assetUrn: "different-asset", uiRequestId: "fixture-ui" }, reply.value, reply.ok), "STOP");
    assert.equal(f.writes.recordWrites, before); assert.equal(f.writes.targetWrites, 0);
    const channel = new MessageChannel();
    const arrived = once(channel.port1, "message");
    await listener({ source: frame.contentWindow, origin: "http://fixture-iframe.invalid",
      data: { type: "datahub-semantic", body: JSON.stringify(request), uiRequestId: "fixture-ui" }, ports: [channel.port2] });
    const throughParent = JSON.parse((await arrived)[0]); channel.port1.close(); channel.port2.close();
    assert.deepEqual(throughParent.inputRejection, reply.value.inputRejection);
    assert.equal(maintenanceDriverResponse(request, throughParent, false), "MODEL_CORRECTION");
    forged = true;
    const fake = await post("/agent/semantic", { grantId, revokeToken, request: JSON.stringify(request) });
    assert.equal(fake.value.inputRejection, undefined, "gateway must not trust an arbitrary error property");
    assert.equal(maintenanceDriverResponse(request, fake.value, fake.ok), "STOP");
    forged = false;
  }
});

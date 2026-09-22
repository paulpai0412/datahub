import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { MessageChannel } from "node:worker_threads";
import { createAgentGateway } from "../extensions/datahub-agent/integration/gateway.mjs";
import { semanticHost } from "../extensions/datahub-agent/integration/native-semantic-tasks.mjs";
import { installSemanticBridge } from "../extensions/datahub-agent/mfe/semantic.js";
import { semanticFixture, sourceUrn, datasetUrn, requestId, actor } from "./fixtures/semantic-fixture.mjs";

const request = { action: "inspect_dataset", sourceUrn, datasetUrn, requestId };

test("real gateway HTTP → semantic adapter → fixture Catalog, with parent grant isolation", async (t) => {
  const f = semanticFixture();
  let runtimeCalls = 0, hostCalls = 0;
  const cookie = "PLAY_SESSION=fixture-only; actor=fixture";
  const server = await createAgentGateway({
    gatewayOrigin: "http://localhost:0", datahubOrigin: "http://datahub.invalid",
    mfeDirectory: new URL("../extensions/datahub-agent/mfe/dist/", import.meta.url).pathname,
    async verifyIdentity(header) {
      if (header === cookie) return actor;
      if (header === "PLAY_SESSION=other") return { ...actor, urn: "urn:li:corpuser:other", key: "b".repeat(48) };
      throw Object.assign(new Error("denied"), { code: "authentication_required" });
    },
    async runtimeForActor() { runtimeCalls++; return { state: async (sessionId) => ({ running: true, state: { sessionId, extensionUiRequests: [] } }) }; },
    async semanticRequest(text, context) {
      hostCalls++;
      assert.equal(typeof context.getRuntime, "function", "semantic gateway must provide lazy native-session access");
      return semanticHost(text, { ...f.context, ...context, runtime: { state: async (id) => (await context.getRuntime()).state(id) } });
    },
  });
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = server.address().port;
  async function post(path, data, overrides = {}) {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: "127.0.0.1", port, path, method: "POST",
        headers: { host: `localhost:${port}`, origin: "http://datahub.invalid", cookie, "content-type": "application/json", ...overrides },
      }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
      });
      req.on("error", reject);
      req.end(JSON.stringify(data));
    });
  }
  const bootstrap = await post("/agent/bootstrap", {});
  assert.equal(bootstrap.status, 200, JSON.stringify(bootstrap.body));
  const { grantId, revokeToken } = bootstrap.body;
  const envelope = { grantId, revokeToken, request: JSON.stringify(request) };
  for (const headers of [
    { origin: "http://evil.invalid" }, { cookie: "" }, { cookie: "PLAY_SESSION=other" },
    { host: `${actor.key}.localhost:${port}`, origin: `http://${actor.key}.localhost:${port}` },
  ]) assert.notEqual((await post("/agent/semantic", envelope, headers)).status, 200);
  assert.equal(hostCalls, 0);
  assert.notEqual((await post("/agent/semantic", { ...envelope, revokeToken: "wrong" })).status, 200);
  assert.equal(hostCalls, 0);
  const result = await post("/agent/semantic", envelope);
  assert.equal(result.status, 200);
  assert.equal(result.body.fields[0].fieldPath, "order_id");
  assert.equal(result.body.publicationAuthorized, false);
  assert.equal(runtimeCalls, 0);
  const vocabulary = await post("/agent/semantic", { ...envelope, request: JSON.stringify({ action: "search_vocabulary", sourceUrn, requestId, kind: "node", query: "Commerce" }) });
  assert.equal(vocabulary.status, 200);
  assert.equal(vocabulary.body.vocabulary.definitions[0].urn, "urn:li:glossaryNode:Commerce");
  const definition = await post("/agent/semantic", { ...envelope, request: JSON.stringify({ ...request, action: "preview_definition", snapshotDigest: result.body.snapshotDigest,
    definition: { kind: "term", name: "Order value", description: "Proposed only", parentUrn: "urn:li:glossaryNode:Commerce" },
    reason: "Fixture source description", evidenceIds: ["dataset:source-description"] }) });
  assert.equal(definition.status, 200);
  assert.equal(definition.body.definition.operation, "PROPOSED_CREATE_ONLY");
  assert.equal(definition.body.publicationAuthorized, false);
  const field = await post("/agent/semantic", { ...envelope, request: JSON.stringify({ ...request, fieldPath: "order_id" }) });
  assert.equal(field.status, 200); assert.equal(field.body.selectedField.fieldPath, "order_id");
  f.state.impactRows = [{ type: "TaggedWith", direction: "INCOMING", entity: { urn: datasetUrn } }];
  const impact = await post("/agent/semantic", { ...envelope, request: JSON.stringify({ ...request, action: "inspect_impact", kind: "tag", referenceUrn: "urn:li:tag:Existing" }) });
  assert.equal(impact.status, 200); assert.equal(impact.body.impact.references[0].urn, datasetUrn);
  const wrong = await post("/agent/semantic", { ...envelope, request: JSON.stringify({ ...request, datasetUrn: "urn:li:dataset:outside" }) });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.error, "semantic_dataset_not_authorized");
  const mutation = await post("/agent/semantic", { ...envelope, request: JSON.stringify({ ...request, action: "publish" }) });
  assert.equal(mutation.status, 400);
  assert.equal(mutation.body.error, "invalid_semantic_request");
  assert.equal(runtimeCalls, 0, "all read intents remain runtime-free");
  Object.assign(f.policy, { semanticPublicationApproved: true, semanticAgentUrn: "urn:li:aiAgent:fixture", semanticAuditAudience: "EXISTING_TASK_RUN_ACL" });
  const notPending = await post("/agent/semantic", { ...envelope, request: JSON.stringify({ ...request, action: "prepare_review", sessionId: requestId, uiRequestId: "not-pending", snapshotDigest: result.body.snapshotDigest, candidates: [] }) });
  assert.equal(notPending.status, 409); assert.equal(notPending.body.error, "semantic_native_request_not_pending");
  assert.equal(runtimeCalls, 1, "only proposal preparation resolves the actor runtime");
  const before = hostCalls;
  assert.equal((await post("/agent/revoke", { grantId, revokeToken })).status, 200);
  assert.notEqual((await post("/agent/semantic", envelope)).status, 200);
  assert.equal(hostCalls, before);
});

test("MFE bridge binds exact iframe/origin/action and propagates cancellation", async (t) => {
  const previous = globalThis.window;
  globalThis.window = new EventTarget();
  const frame = { contentWindow: {} };
  const origin = "http://fixture-runtime.invalid";
  let calls = 0, signal, resolveSend;
  const sent = new Promise((resolve) => { resolveSend = resolve; });
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const stop = installSemanticBridge({ frame, origin, async send(value, abortSignal) {
    calls++; signal = abortSignal; assert.deepEqual(value, request); resolveSend(); return pending;
  } });
  t.after(() => { stop(); globalThis.window = previous; });
  const ports = [];
  t.after(() => { for (const p of ports) p.close(); });
  function dispatch(overrides = {}) {
    const channel = new MessageChannel(); ports.push(channel.port1, channel.port2);
    const event = Object.assign(new Event("message"), { source: frame.contentWindow, origin, data: { type: "datahub-semantic", body: JSON.stringify(request) }, ports: [channel.port2], ...overrides });
    window.dispatchEvent(event);
    return channel.port1;
  }
  dispatch({ source: {} }); dispatch({ origin: "http://evil.invalid" });
  assert.equal(calls, 0);
  const invalid = dispatch({ data: { type: "datahub-semantic", body: JSON.stringify({ action: "publish" }) } });
  assert.equal(JSON.parse((await once(invalid, "message"))[0]).error, "semantic_request_failed");
  assert.equal(calls, 0);
  const active = dispatch(); await sent;
  const busy = dispatch();
  assert.equal(JSON.parse((await once(busy, "message"))[0]).error, "semantic_request_busy");
  const aborted = once(signal, "abort");
  active.postMessage({ type: "cancel" }); await aborted;
  assert.equal(signal.aborted, true);
  finish({ publicationAuthorized: false });
  stop(); dispatch(); assert.equal(calls, 1);
});

test("lost preparation HTTP response preserves intent locators without retry or success claim", async (t) => {
  const previous = globalThis.window; let remembered;
  globalThis.window = Object.assign(new EventTarget(), { location: { href: "http://datahub.invalid/?keep=1" },
    history: { state: { existing: true }, replaceState(_state, _title, url) { remembered = url; } } });
  const frame = { contentWindow: {} }, origin = "http://fixture-runtime.invalid"; let calls = 0;
  const stop = installSemanticBridge({ frame, origin, actorKey: actor.key, async send() { calls++; throw new Error("fixture lost response"); } });
  t.after(() => { stop(); globalThis.window = previous; });
  const channel = new MessageChannel(); t.after(() => { channel.port1.close(); channel.port2.close(); });
  const received = once(channel.port1, "message");
  window.dispatchEvent(Object.assign(new Event("message"), { source: frame.contentWindow, origin,
    data: { type: "datahub-semantic", uiRequestId: "fixture", body: JSON.stringify({ ...request, action: "prepare_review" }) }, ports: [channel.port2] }));
  const value = JSON.parse((await received)[0]);
  assert.equal(value.error, "semantic_preparation_unconfirmed"); assert.equal(value.reconciliation.retryAllowed, false);
  assert.equal(value.reconciliation.decisionId, requestId); assert.equal(calls, 1);
  assert.equal(remembered.searchParams.get("agentRun"), value.reconciliation.runUrn); assert.equal(remembered.searchParams.get("keep"), "1");
});

test("MFE forwards safe read-only results without rendering strings as approval UI", async (t) => {
  const previous = globalThis.window; globalThis.window = new EventTarget();
  const frame = { contentWindow: {} }; const origin = "http://fixture-runtime.invalid";
  const result = { publicationAuthorized: false, value: "<script>never execute</script>" };
  const stop = installSemanticBridge({ frame, origin, send: async () => result });
  t.after(() => { stop(); globalThis.window = previous; });
  for (const action of ["inspect_dataset", "search_vocabulary", "preview_definition", "inspect_impact"]) {
    const channel = new MessageChannel(); t.after(() => { channel.port1.close(); channel.port2.close(); });
    const received = once(channel.port1, "message");
    window.dispatchEvent(Object.assign(new Event("message"), { source: frame.contentWindow, origin, data: { type: "datahub-semantic", body: JSON.stringify({ ...request, action }) }, ports: [channel.port2] }));
    assert.deepEqual(JSON.parse((await received)[0]), result);
  }
});

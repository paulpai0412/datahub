// Offline product SDK -> actual Host -> disposable public-API fixture.
// No model, deployment, production session or private credentials.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { semanticCatalogFixture } from "./fixtures/semantic-catalog-fixture.mjs";
import { sourceUrn, datasetUrn, envelope } from "./fixtures/semantic-fixture.mjs";
import { MaintenanceInputRejection, maintenanceSelection } from "../extensions/datahub-agent/integration/semantic-maintenance-plan.mjs";
import { semanticNativeClient } from "../extensions/datahub-agent/integration/semantic-native-client.mjs";
import { loadSemanticReview } from "../extensions/datahub-agent/mfe/semantic-review.js";
import { semanticFieldUrn } from "../extensions/datahub-agent/integration/semantic-catalog-contract.mjs";
import { maintenanceDriverResponse } from "./semantic-maintenance-driver-response.mjs";
const { createJiti } = createRequire(new URL("../extensions/datahub-agent/pi-web/package.json", import.meta.url))("jiti");
const oldId = "00000000-0000-4000-8000-000000000099";

async function fixture() {
  const f = semanticCatalogFixture(), requests = [], entries = [], handlers = {}, queued = [];
  const { default: register } = await createJiti(import.meta.url).import("../extensions/datahub-agent/pi-web/lib/datahub-semantic-extension.ts");
  let tool, aborts = 0, changeReply = x => x;
  register({ on(n, h) { handlers[n] = h; }, registerTool(t) { tool = t; },
    appendEntry(customType, data) { entries.push({ type: "custom", customType, data, id: `entry-${entries.length}` }); },
    sendMessage(...x) { queued.push(x); } });
  const ctx = { mode: "rpc", hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => f.sessionId, getBranch: () => entries }, abort() { aborts++; },
    ui: { notify() {}, async input(_title, body) {
      const input = JSON.parse(body); requests.push(input);
      const write = ["start_maintenance", "prepare_maintenance", "revise_maintenance", "seal_maintenance", "continue_maintenance"].includes(input.action);
      if (write) f.writes.pending = input;
      try { return JSON.stringify(changeReply(await f.call({ ...input, ...(write ? { uiRequestId: "fixture-ui" } : {}) }), input)); }
      catch (error) {
        return JSON.stringify(changeReply({ error: error.message,
          ...(error instanceof MaintenanceInputRejection ? { inputRejection: error.inputRejection } : {}),
          ...(error.reconciliation ? { reconciliation: error.reconciliation } : {}) }, input));
      }
    } } };
  return { ...f, tool, ctx, entries, handlers, requests, queued,
    execute: (input, id = "test-call") => tool.execute(id, input, undefined, undefined, ctx),
    setReply(fn) { changeReply = fn; }, get aborts() { return aborts; } };
}
const gap = { code: "INSUFFICIENT_EVIDENCE", reason: "Fixture has no business evidence" };
async function start(f) {
  const plan = (await f.execute({ action: "start_maintenance", sourceUrn, assetUrns: [datasetUrn] })).details;
  await f.execute({ action: "inspect_asset", contract: "catalog/1", assetUrn: datasetUrn });
  return plan;
}

test("a missing direct URN in the last field is correctable without cancelling or losing seven saved items", async () => {
  const f = await fixture();
  f.state.definitions["urn:li:domain:Operations"] = { domainProperties: envelope({ name: "Operations", description: "Explicit fixture domain" }) };
  f.state.definitions["urn:li:glossaryTerm:OrderLine"] = { glossaryTermInfo: envelope({ name: "Order line", definition: "Explicit fixture line term" }) };
  let plan = await start(f);
  const originalItems = [];
  for (let i = 0; i < 7; i++) {
    plan = (await f.execute({ action: "prepare_maintenance", contract: "catalog/1", assetUrn: datasetUrn,
      definition: { kind: "term", operation: "create", name: `Fixture saved concept ${i}`, description: "Explicit fixture definition" },
      reason: "Preserve this already-confirmed preparation", evidenceIds: ["asset:identity"] })).details;
    assert(!plan.error, plan.error);
    assert.equal(plan.delivery, "incremental");
    originalItems.push(structuredClone(plan.items[0]));
  }
  assert.equal(plan.runVersion, "15"); const before = f.writes.recordWrites;
  const missingUrn = `urn:li:glossaryTerm:ekop-semantic-${"a".repeat(64)}`;
  const common = { reason: "Explicit fixture source evidence", evidenceIds: ["asset:identity"] };
  const candidates = [{ kind: "description", operation: "set", value: "Complete fixture description", ...common },
    { kind: "domain", operation: "add", value: "urn:li:domain:Operations", ...common },
    { kind: "term", operation: "add", value: "urn:li:glossaryTerm:OrderLine", ...common },
    { kind: "description", operation: "set", fieldPath: "order_id", value: "Explicit fixture field description", ...common },
    { kind: "term", operation: "add", fieldPath: "order_id", value: missingUrn, ...common }];
  const rejected = (await f.execute({ action: "prepare_maintenance", contract: "catalog/1", assetUrn: datasetUrn,
    version: plan.runVersion, candidates }, "missing-direct-ref")).details;
  assert.equal(rejected.correctionAllowed, true, "normal native 200[] for a supplied direct reference must not become This operation was aborted");
  assert.equal(rejected.inputRejection.issue, "semantic_reference_not_found");
  assert.deepEqual(rejected.inputRejection.location, { inputPath: "candidates[4].value", candidateIndex: 4,
    fieldPath: "order_id", kind: "term", referenceUrn: missingUrn });
  assert.equal(f.aborts, 0); assert.equal(f.writes.recordWrites, before); assert.equal(f.writes.targetWrites, 0);
  await f.handlers.tool_execution_end({ toolName: "datahub_semantic", toolCallId: "missing-direct-ref", isError: false });
  const read = (await f.execute({ action: "read_maintenance" })).details;
  assert.deepEqual(read.items, originalItems); assert.equal(read.runVersion, "15");
  assert.equal(f.requests.filter(r => r.action === "prepare_maintenance").length, 8, "no SDK repair/replay");
  assert.equal(f.requests.at(-2).candidates.at(-1).value, missingUrn, "wrong locator was not silently replaced or dropped");
  const correctedCandidates = structuredClone(candidates); correctedCandidates.at(-1).value = "urn:li:glossaryTerm:OrderLine";
  const corrected = (await f.execute({ action: "prepare_maintenance", contract: "catalog/1", assetUrn: datasetUrn,
    version: read.runVersion, candidates: correctedCandidates }, "new-direct-ref")).details;
  assert(!corrected.error, corrected.error); assert.equal(corrected.totalItems, 8);
  assert.equal(corrected.items.length, 1, "successful ACK contains only this new item");
  const complete = (await f.execute({ action: "read_maintenance" })).details;
  assert.deepEqual(complete.items.slice(0, 7), originalItems); assert.equal(f.aborts, 0);
  const review = await loadSemanticReview(corrected.items.find(i => i.id === corrected.preparedItemId).reviewRef,
    input => f.call(input), new AbortController().signal);
  assert.equal(review.preview.changes.length, candidates.length, "whole proposal is retained, not stripped to avoid the failure");
  assert.equal(review.preview.changes.at(-1).value, "urn:li:glossaryTerm:OrderLine");
  assert.equal(f.writes.targetWrites, 0);
});

test("direct missing collections, properties and parents expose precise input locations without URI guessing", async () => {
  for (const kind of ["domain", "tag", "term", "property", "parent"]) {
    const f = await fixture(); await start(f);
    const entity = { domain: "domain", tag: "tag", term: "glossaryTerm", property: "structuredProperty", parent: "glossaryNode" }[kind];
    const urn = `urn:li:${entity}:ekop-semantic-${"f".repeat(64)}`;
    const evidence = { reason: "Explicit fixture evidence", evidenceIds: ["asset:identity"] };
    const proposal = kind === "parent" ? { definition: { kind: "term", operation: "create", name: "Fixture child",
      description: "Explicit definition", parentUrn: urn }, ...evidence }
      : { candidates: [{ kind, operation: kind === "term" || kind === "property" ? "set" : "add",
        ...(kind === "term" ? { values: ["urn:li:glossaryTerm:Order", urn] } : { value: urn }),
        ...(kind === "property" ? { values: ["high"] } : {}), ...evidence }] };
    const before = f.writes.recordWrites;
    const rejected = (await f.execute({ action: "prepare_maintenance", contract: "catalog/1", assetUrn: datasetUrn, ...proposal })).details;
    assert.equal(rejected.correctionAllowed, true, kind); assert.equal(rejected.inputRejection.issue, "semantic_reference_not_found");
    assert.deepEqual(rejected.inputRejection.location, { inputPath: kind === "parent" ? "definition.parentUrn"
      : kind === "term" ? "candidates[0].values[1]" : "candidates[0].value",
      ...(kind === "parent" ? {} : { candidateIndex: 0 }), kind: kind === "parent" ? "node" : kind, referenceUrn: urn });
    assert.equal(f.aborts, 0); assert.equal(f.writes.recordWrites, before); assert.equal(f.writes.targetWrites, 0);
  }
});

test("a returning empty-lookup callback cannot forge a row or bypass default native validation", async () => {
  const f = semanticCatalogFixture(), urn = `urn:li:glossaryTerm:ekop-semantic-${"0".repeat(64)}`;
  const client = semanticNativeClient(f.context); let missing = 0;
  await assert.rejects(client.entity(urn, "glossaryTerm", ["glossaryTermInfo"], false, () => {
    missing++; return { urn, glossaryTermInfo: envelope({ name: "Forged", definition: "Not a native row" }) };
  }), /semantic_catalog_invalid/);
  assert.equal(missing, 1);
  assert.deepEqual(await client.entity(urn, "glossaryTerm", ["glossaryTermInfo"], true, () => { missing++; }), { urn });
  assert.equal(missing, 1, "planned-definition absence remains an explicit allowed lookup, not a callback rejection");
  assert.equal(f.writes.recordWrites, 0); assert.equal(f.writes.targetWrites, 0);
});

test("missing references do not convert ACL, transport, malformed native data or a read/compile race into input proof", async () => {
  for (const mode of ["denied", "io", "http", "object", "wrongRow", "duplicate", "urnOnly", "badVersion", "compileRace"]) {
    const f = await fixture(); await start(f);
    const urn = `urn:li:glossaryTerm:ekop-semantic-${"c".repeat(64)}`;
    const baseFetch = f.context.fetchImpl; let reads = 0;
    if (mode === "denied") f.state.denied.add(urn);
    f.context.fetchImpl = async (url, options) => {
      if (url.pathname === "/openapi/v3/entity/glossaryterm/batchGet" && JSON.parse(options.body)[0].urn === urn) {
        reads++;
        if (mode === "io") throw Error("fixture read unavailable");
        if (mode === "http") return Response.json([], { status: 503 });
        if (mode === "object") return Response.json({});
        if (mode === "wrongRow") return Response.json([{ urn: "urn:li:glossaryTerm:Other" }]);
        if (mode === "duplicate") return Response.json([{ urn }, { urn }]);
        if (mode === "urnOnly") return Response.json([{ urn }]);
        if (mode === "badVersion") return Response.json([{ urn, glossaryTermInfo: { value: { name: "Fixture term", definition: "Synthetic" }, systemMetadata: { version: null } } }]);
        if (mode === "compileRace") return Response.json(reads === 1 ? [{ urn,
          glossaryTermInfo: envelope({ name: "Fixture term", definition: "Synthetic" }) }] : []);
      }
      return baseFetch(url, options);
    };
    const before = f.writes.recordWrites;
    const rejected = (await f.execute({ action: "prepare_maintenance", contract: "catalog/1", assetUrn: datasetUrn,
      candidates: [{ kind: "term", operation: "add", value: urn, reason: "Explicit fixture evidence", evidenceIds: ["asset:identity"] }] })).details;
    assert(rejected.error, mode); assert.equal(rejected.inputRejection, undefined, mode);
    assert.notEqual(rejected.correctionAllowed, true, mode); assert.equal(f.aborts, 1, mode);
    assert.equal(f.writes.recordWrites, before, mode); assert.equal(f.writes.targetWrites, 0, mode);
    if (mode === "denied") assert.equal(reads, 0, "authorize before even reading the missing reference");
    if (mode === "compileRace") assert.equal(reads, 2, "disappearance after preview is fresh native drift, not proof about original model input");
  }
});

test("a missing native ancestor is not misclassified as a direct model reference mistake", async () => {
  const f = await fixture(); await start(f);
  f.state.definitions["urn:li:glossaryNode:Commerce"].glossaryNodeInfo.value.parentNode =
    `urn:li:glossaryNode:ekop-semantic-${"d".repeat(64)}`;
  const before = f.writes.recordWrites;
  const rejected = (await f.execute({ action: "prepare_maintenance", contract: "catalog/1", assetUrn: datasetUrn,
    definition: { kind: "term", operation: "create", name: "Fixture child", description: "Synthetic",
      parentUrn: "urn:li:glossaryNode:Commerce" }, reason: "Explicit evidence", evidenceIds: ["asset:identity"] })).details;
  assert.equal(rejected.error, "semantic_reference_not_found"); assert.equal(rejected.inputRejection, undefined);
  assert.equal(f.aborts, 1); assert.equal(f.writes.recordWrites, before); assert.equal(f.writes.targetWrites, 0);
});

test("a missing direct definition read does not disarm same-prompt model correction", async () => {
  const f = await fixture(); await start(f);
  const missingUrn = `urn:li:glossaryTerm:ekop-semantic-${"b".repeat(64)}`;
  await assert.rejects(f.execute({ action: "inspect_definition", contract: "catalog/1", assetUrn: datasetUrn,
    kind: "term", referenceUrn: missingUrn }, "missing-read-ref"), /semantic_reference_not_found/);
  await f.handlers.tool_execution_end({ toolName: "datahub_semantic", toolCallId: "missing-read-ref", isError: true });
  const valid = (await f.execute({ action: "inspect_definition", contract: "catalog/1", assetUrn: datasetUrn,
    kind: "term", referenceUrn: "urn:li:glossaryTerm:Order" }, "new-read-ref")).details;
  assert(!valid.error, valid.error);
  const staged = (await f.execute({ action: "prepare_maintenance", contract: "catalog/1", assetUrn: datasetUrn,
    gap })).details;
  await f.handlers.agent_end({ messages: [{ role: "assistant", stopReason: "stop" }] }, f.ctx);
  assert.equal(staged.totalItems, 1); assert.equal(f.queued.length, 1, "known read input mistake must not permanently stop foreground continuation");
  assert.equal(f.aborts, 0); assert.equal(f.writes.targetWrites, 0);
});

test("complete nine-fact definition evidence is retained instead of rejected by a hidden eight-item limit", async () => {
  const f = await fixture();
  const template = f.state.dataset.schemaMetadata.value.fields[0];
  f.state.dataset.schemaMetadata.value.fields = Array.from({ length: 9 }, (_, i) =>
    ({ ...structuredClone(template), fieldPath: `fixture_${i}`, description: `Explicit fixture field statement ${i}` }));
  await start(f); const inspected = await f.inspect();
  const evidenceIds = inspected.evidence.slice(0, 9).map(e => e.id);
  assert.equal(evidenceIds.length, 9, "nine genuine returned facts, no guessed IDs");
  const staged = (await f.execute({ action: "prepare_maintenance", contract: "catalog/1", assetUrn: datasetUrn,
    definition: { kind: "term", operation: "create", name: "Fixture nine-fact concept", description: "Explicit source-backed definition" },
    reason: "Keep every selected supporting fact", evidenceIds })).details;
  assert(!staged.error, staged.error); assert.equal(f.aborts, 0);
  const review = await loadSemanticReview(staged.items[0].reviewRef, input => f.call(input), new AbortController().signal);
  assert.deepEqual(review.preview.definition.evidence.map(e => e.id), evidenceIds);
  assert.equal(f.tool.parameters.properties.evidenceIds.maxItems, undefined);
  assert.equal(f.tool.parameters.properties.candidates.items.properties.evidenceIds.maxItems, undefined);
  const asset = (await f.execute({ action: "prepare_maintenance", contract: "catalog/1", assetUrn: datasetUrn,
    candidates: [{ kind: "description", operation: "set", value: "Explicit fixture dataset description", reason: "All selected facts preserved", evidenceIds }] })).details;
  assert(!asset.error, asset.error);
  const assetReview = await loadSemanticReview(asset.items.find(i => i.id === asset.preparedItemId).reviewRef,
    input => f.call(input), new AbortController().signal);
  assert.deepEqual(assetReview.preview.changes[0].evidence.map(e => e.id), evidenceIds);
  assert.equal(f.writes.targetWrites, 0);
});

test("Domain cannot parent a Term, but an input kind mismatch must not abort the entire same-Root preparation", async () => {
  const f = await fixture(); await start(f);
  const shared = { action: "prepare_maintenance", contract: "catalog/1", assetUrn: datasetUrn,
    reason: "Explicit fixture hierarchy", evidenceIds: ["asset:identity"] };
  const domain = (await f.execute({ ...shared,
    definition: { kind: "domain", operation: "create", name: "Fixture subject area", description: "Explicit subject area" } })).details;
  const original = domain.items[0], before = f.writes.recordWrites;
  const invalid = (await f.execute({ ...shared, version: domain.runVersion,
    definition: { kind: "term", operation: "create", name: "Fixture concept", description: "Explicit concept",
      parentUrn: original.definition.reference } })).details;
  assert.equal(invalid.correctionAllowed, true, "exact pre-write input mismatch is correctable, not an uncertain native write");
  assert.equal(invalid.inputRejection.issue, "semantic_maintenance_definition_reference_kind_mismatch");
  assert.equal(f.aborts, 0, "do not replace the actual input issue with This operation was aborted");
  assert.equal(f.writes.recordWrites, before); assert.equal(f.writes.targetWrites, 0);
  const group = (await f.execute({ ...shared, version: domain.runVersion,
    definition: { kind: "node", operation: "create", name: "Fixture glossary group", description: "Explicit grouping" } })).details;
  assert(!group.error, group.error);
  const term = (await f.execute({ ...shared, version: group.runVersion,
    definition: { kind: "term", operation: "create", name: "Fixture concept", description: "Explicit concept",
      parentUrn: group.items.find(i => i.id === group.preparedItemId).definition.reference } })).details;
  assert(!term.error, term.error); assert.equal(term.totalItems, 3);
  assert.equal(term.items.length, 1, "incremental ACK is not the complete plan");
  const complete = (await f.execute({ action: "read_maintenance" })).details;
  assert(complete.items.some(i => i.id === original.id), "already-saved Domain is not overwritten or recreated");
  assert.equal(f.aborts, 0); assert.equal(f.writes.targetWrites, 0);
});

test("ordinary GAP and deferred operation are exclusive; only the model supplies a new corrected input", async () => {
  const f = await fixture(), plan = await start(f), before = f.requests.length, writes = f.writes.recordWrites;
  const operation = { action: "prepare_maintenance", maintenanceRunUrn: plan.maintenanceRunUrn };
  await assert.rejects(f.execute({ action: "prepare_maintenance", contract: "catalog/1", assetUrn: datasetUrn,
    gap: { ...gap, operation } }), /gap\.operation/);
  await f.handlers.tool_execution_end({ toolName: "datahub_semantic", toolCallId: "test-call", isError: true });
  assert.equal(f.requests.length, before); assert.equal(f.writes.recordWrites, writes); assert.equal(f.aborts, 0);
  const staged = (await f.execute({ action: "prepare_maintenance", contract: "catalog/1", assetUrn: datasetUrn, gap })).details;
  assert.equal(staged.items[0].status, "GAP");
  assert.equal((await f.execute({ action: "seal_maintenance" })).details.state, "READY");
  assert.equal(f.writes.targetWrites, 0);
  const branches = f.tool.parameters.properties.gap.anyOf;
  assert.equal(branches.length, 2); assert.equal(branches[0].properties.operation, undefined);
  assert(branches[1].required.includes("operation"));
});

test("shared Catalog definition may use an exact field evidence anchor without losing its locator", async () => {
  const f = await fixture(); await start(f);
  const staged = (await f.execute({ action: "prepare_maintenance", contract: "catalog/1", assetUrn: datasetUrn,
    fieldPath: "order_id", definition: { kind: "term", operation: "create", name: "Fixture concept", description: "Proposed concept" },
    reason: "Exact source field statement", evidenceIds: ["field:0:source-description"] })).details;
  assert(!staged.error, staged.error); assert.equal(staged.items[0].status, "PENDING");
  const review = await loadSemanticReview(staged.items[0].reviewRef, input => f.call(input), new AbortController().signal);
  assert.equal(review.preview.definition.evidenceAnchor.fieldPath, "order_id");
  assert.equal(review.preview.definition.evidence[0].id, "field:0:source-description");
  assert.equal(f.writes.targetWrites, 0); assert.equal(f.aborts, 0);
});

test("one asset proposal includes multiple field properties; Host compiles and publishes their exact native targets after one batch consent", async () => {
  const f = await fixture(), plan = await start(f);
  const paths = f.state.dataset.schemaMetadata.value.fields.slice(0, 2).map(field => field.fieldPath);
  const candidates = [
    { kind: "tag", operation: "add", value: "urn:li:tag:Reviewed", reason: "Synthetic classification", evidenceIds: ["asset:identity"] },
    ...paths.map(fieldPath => ({ kind: "property", operation: "set", fieldPath, value: "urn:li:structuredProperty:priority",
      values: ["high"], reason: "Synthetic field classification", evidenceIds: ["asset:identity"] })),
  ];
  const staged = (await f.execute({ action: "prepare_maintenance", contract: "catalog/1", assetUrn: datasetUrn, candidates })).details;
  assert(!staged.error, staged.error); assert.equal(staged.totalItems, 1);
  const review = await loadSemanticReview(staged.items[0].reviewRef, input => f.call(input), new AbortController().signal);
  assert.deepEqual(review.preview.changes.map(({ kind, fieldPath, value, after }) => ({ kind, fieldPath, value, after })), [
    { kind: "tag", fieldPath: undefined, value: "urn:li:tag:Reviewed", after: ["urn:li:tag:Existing", "urn:li:tag:Reviewed"] },
    ...paths.map(fieldPath => ({ kind: "property", fieldPath, value: "urn:li:structuredProperty:priority", after: ["high"] })),
  ], "Host retains every business target and the exact complete before/after differences");
  assert.equal(f.writes.targetWrites, 0);
  const ready = (await f.execute({ action: "seal_maintenance" })).details;
  assert.equal(ready.state, "READY"); assert.equal(ready.maintenanceRunUrn, plan.maintenanceRunUrn);
  const pub = { action: "publish_maintenance_item", maintenanceRunUrn: ready.maintenanceRunUrn, planDigest: ready.planDigest, itemId: staged.items[0].id };
  await assert.rejects(f.call(pub), /semantic_maintenance_consent_required/);
  await f.call({ action: "approve_maintenance", maintenanceRunUrn: ready.maintenanceRunUrn,
    version: ready.runVersion, planDigest: ready.planDigest, selection: maintenanceSelection(1, [0]) });
  assert.equal((await f.call(pub)).status, "VERIFIED_CURRENT_VALUES");
  assert.equal(f.writes.targetWrites, 5, "one tag Aspect plus key/property Aspects for two distinct fields");
  for (const fieldPath of paths) {
    const current = await f.inspect(datasetUrn, { fieldPath });
    assert.equal(current.selectedField.urn, semanticFieldUrn(datasetUrn, fieldPath));
    assert.deepEqual(current.selectedField.properties, [{ propertyUrn: "urn:li:structuredProperty:priority", values: ["high"] }]);
  }
  await assert.rejects(f.call(pub), /publication_already_attempted/);
});

test("saved five-definition draft reaches a complete seven-Dataset plan and maintains a changed second round", async () => {
  const f = await fixture();
  f.writes.recordHistoryLimits.ekopAgentRun = 2147483647;
  f.writes.recordHistoryLimits.ekopAgentTask = 2147483647;
  const assets = [datasetUrn, ...Array.from({ length: 6 }, (_, i) => `urn:li:dataset:(urn:li:dataPlatform:mssql,Fixture.reporting.subject_${i},DEV)`)];
  for (const urn of assets.slice(1)) f.state.definitions[urn] = structuredClone(f.state.dataset);
  f.policy.taskDatasets = assets;
  const baseFetch = f.context.fetchImpl;
  f.context.fetchImpl = async (url, options) => {
    if (url.pathname === "/openapi/v3/entity/dataset/batchGet") {
      return Response.json(JSON.parse(options.body).map(({ urn, ...selected }) => {
        assert(assets.includes(urn), "fixture only");
        const row = urn === datasetUrn ? f.state.dataset : f.state.definitions[urn];
        return { urn, ...Object.fromEntries(Object.entries(row).filter(([name]) => Object.hasOwn(selected, name))) };
      }));
    }
    return baseFetch(url, options);
  };
  const first = (await f.execute({ action: "start_maintenance", sourceUrn, assetUrns: assets })).details;
  await f.execute({ action: "inspect_asset", contract: "catalog/1", assetUrn: datasetUrn });
  const refs = {};
  for (const kind of ["domain", "node", "term", "tag", "property"]) {
    const plan = (await f.execute({ action: "read_maintenance" })).details;
    const prepared = (await f.execute({ action: "prepare_maintenance", contract: "catalog/1", assetUrn: datasetUrn, version: plan.runVersion,
      definition: { kind, operation: "create", name: `Fixture scheme ${kind}`, description: "Synthetic complete scheme for human review",
        ...(kind === "term" ? { parentUrn: refs.node } : {}),
        ...(kind === "property" ? { valueType: "string", cardinality: "SINGLE", entityTypes: ["dataset", "schemaField"], allowedValues: ["dimension", "key"] } : {}) },
      reason: "Explicit fixture organizational proposal", evidenceIds: ["asset:identity"] })).details;
    assert(!prepared.error, prepared.error);
    refs[kind] = prepared.items.at(-1).definition.reference;
  }
  const saved = (await f.execute({ action: "read_maintenance" })).details;
  assert.equal(saved.totalItems, 5); assert.equal(saved.runVersion, "11");
  const savedIds = saved.items.map(item => item.id);
  const paths = f.state.dataset.schemaMetadata.value.fields.slice(0, 2).map(field => field.fieldPath);
  for (const assetUrn of assets) {
    await f.execute({ action: "inspect_asset", contract: "catalog/1", assetUrn });
    const plan = (await f.execute({ action: "read_maintenance" })).details;
    const staged = (await f.execute({ action: "prepare_maintenance", contract: "catalog/1", assetUrn, version: plan.runVersion,
      candidates: [
        ...["domain", "term", "tag"].map(kind => ({ kind, operation: "add", value: refs[kind], reason: "Explicit fixture classification", evidenceIds: ["asset:identity"] })),
        ...[undefined, ...paths].map(fieldPath => ({ kind: "property", operation: "set", ...(fieldPath === undefined ? {} : { fieldPath }),
          value: refs.property, values: ["dimension"], reason: "Explicit fixture role proposal", evidenceIds: ["asset:identity"] })),
      ] })).details;
    assert(!staged.error, staged.error); assert.equal(staged.maintenanceRunUrn, first.maintenanceRunUrn);
  }
  const draft = (await f.execute({ action: "read_maintenance" })).details;
  assert.deepEqual(draft.items.slice(0, 5).map(item => item.id), savedIds, "saved successes are retained, not prepared again");
  assert.equal(draft.totalItems, 12); assert.equal(draft.accountedAssetCount, 7);
  const ready = (await f.execute({ action: "seal_maintenance" })).details;
  assert.equal(ready.state, "READY"); assert.equal(f.writes.targetWrites, 0);
  await f.call({ action: "approve_maintenance", maintenanceRunUrn: ready.maintenanceRunUrn, version: ready.runVersion,
    planDigest: ready.planDigest, selection: maintenanceSelection(12, Array.from({ length: 12 }, (_, i) => i)) });
  for (const item of ready.items) assert.equal((await f.call({ action: "publish_maintenance_item", maintenanceRunUrn: ready.maintenanceRunUrn,
    planDigest: ready.planDigest, itemId: item.id })).status, "VERIFIED_CURRENT_VALUES");
  const propertyUrn = ready.items[4].definition.urn;
  assert(propertyUrn); const oldHistory = structuredClone([...f.journal.entries()]);
  f.state.dataset.schemaMetadata.value.fields[0].description = "Changed fixture source statement: role is key";
  f.state.dataset.schemaMetadata.systemMetadata.version = "2";
  await f.handlers.input({ source: "interactive" });
  const second = (await f.execute({ action: "start_maintenance", sourceUrn, assetUrns: assets })).details;
  for (const assetUrn of assets) {
    await f.execute({ action: "inspect_asset", contract: "catalog/1", assetUrn });
    const staged = (await f.execute({ action: "prepare_maintenance", contract: "catalog/1", assetUrn,
      candidates: [{ kind: "property", operation: "set", fieldPath: paths[0], value: propertyUrn,
        values: [assetUrn === datasetUrn ? "key" : "dimension"], reason: "Compare new source statement with prior Agent/current value",
        evidenceIds: ["field:0:source-description"] }] })).details;
    assert(!staged.error, staged.error);
  }
  const secondReady = (await f.execute({ action: "seal_maintenance" })).details;
  assert.equal(secondReady.maintenanceRunUrn, second.maintenanceRunUrn); assert.equal(secondReady.totalItems, 7);
  assert.deepEqual(secondReady.items.map(item => item.status), ["PENDING", ...Array(6).fill("KEEP")]);
  await f.call({ action: "approve_maintenance", maintenanceRunUrn: secondReady.maintenanceRunUrn, version: secondReady.runVersion,
    planDigest: secondReady.planDigest, selection: maintenanceSelection(7, [0]) });
  assert.equal((await f.call({ action: "publish_maintenance_item", maintenanceRunUrn: secondReady.maintenanceRunUrn,
    planDigest: secondReady.planDigest, itemId: secondReady.items[0].id })).status, "VERIFIED_CURRENT_VALUES");
  const current = await f.inspect(datasetUrn, { fieldPath: paths[0] });
  assert.deepEqual(current.selectedField.properties, [{ propertyUrn, values: ["key"] }]);
  for (const [key, versions] of oldHistory) assert.deepEqual(f.journal.get(key), versions, "original plan and evidence history remain unchanged");
});

test("additive associations and multiple distinct properties on one field are a single valid proposal", async () => {
  const f = await fixture(); await start(f);
  f.state.definitions["urn:li:structuredProperty:secondary"] = structuredClone(f.state.definitions["urn:li:structuredProperty:priority"]);
  f.state.definitions["urn:li:tag:Other"] = { tagProperties: envelope({ name: "Other fixture tag" }) };
  const candidates = [
    ...["urn:li:tag:Reviewed", "urn:li:tag:Other"].map(value => ({ kind: "tag", operation: "add", value,
      reason: "Explicit proposed addition", evidenceIds: ["asset:identity"] })),
    ...["urn:li:structuredProperty:priority", "urn:li:structuredProperty:secondary"].map(value => ({ kind: "property", operation: "set",
      fieldPath: "order_id", value, values: ["high"], reason: "Synthetic classification", evidenceIds: ["asset:identity"] })),
  ];
  const staged = (await f.execute({ action: "prepare_maintenance", contract: "catalog/1", assetUrn: datasetUrn, candidates })).details;
  assert(!staged.error, staged.error); assert.equal(staged.totalItems, 1); assert.equal(f.aborts, 0);
  const review = await loadSemanticReview(staged.items[0].reviewRef, input => f.call(input), new AbortController().signal);
  assert.equal(review.preview.changes.length, 4, "all independent association and property intentions survive");
  for (const change of review.preview.changes.filter(change => change.kind === "tag"))
    assert.deepEqual(change.after, ["urn:li:tag:Existing", "urn:li:tag:Reviewed", "urn:li:tag:Other"], "review shows the complete final collection, not separate incomplete after-values");
  assert.equal((await f.execute({ action: "seal_maintenance" })).details.state, "READY");
  assert.equal(f.writes.targetWrites, 0);
});

test("Host-acquired field context preserves unrelated human metadata and still refuses concurrent drift", async () => {
  for (const drift of [false, true]) {
    const f = await fixture(), fieldPath = "order_id", urn = semanticFieldUrn(datasetUrn, fieldPath);
    f.state.fields[urn] = {
      schemaFieldKey: envelope({ parent: datasetUrn, fieldPath }),
      structuredProperties: envelope({ properties: [
        { propertyUrn: "urn:li:structuredProperty:priority", values: [{ string: "normal" }], annotation: "retain human note" },
        { propertyUrn: "urn:li:structuredProperty:unselected", values: [{ string: "human value" }] },
      ], extension: { human: true } }),
    };
    await start(f); const rootSnapshot = await f.inspect();
    const staged = (await f.execute({ action: "prepare_maintenance", contract: "catalog/1", assetUrn: datasetUrn,
      candidates: [{ kind: "property", operation: "set", fieldPath, value: "urn:li:structuredProperty:priority",
        values: ["high"], reason: "Exact human-review proposal", evidenceIds: ["asset:identity"] }] })).details;
    assert(!staged.error, staged.error);
    const review = await loadSemanticReview(staged.items[0].reviewRef, input => f.call(input), new AbortController().signal);
    assert.deepEqual(review.preview.changes[0].before, ["normal"]);
    const ready = (await f.execute({ action: "seal_maintenance" })).details;
    await f.call({ action: "approve_maintenance", maintenanceRunUrn: ready.maintenanceRunUrn, version: ready.runVersion,
      planDigest: ready.planDigest, selection: maintenanceSelection(1, [0]) });
    const pub = { action: "publish_maintenance_item", maintenanceRunUrn: ready.maintenanceRunUrn, planDigest: ready.planDigest, itemId: staged.items[0].id };
    if (drift) {
      f.state.fields[urn].structuredProperties.systemMetadata.version = "2";
      f.state.fields[urn].structuredProperties.value.properties[0].values = [{ string: "human edit" }];
      assert.equal((await f.inspect()).snapshotDigest, rootSnapshot.snapshotDigest, "asset snapshot alone cannot prove extra field freshness");
      assert.equal((await f.call({ action: "read_review", ...staged.items[0].reviewRef })).stale, true);
      await assert.rejects(f.call(pub));
      assert.equal(f.writes.targetWrites, 0); assert.equal(f.state.fields[urn].structuredProperties.value.properties[0].values[0].string, "human edit");
    } else {
      assert.equal((await f.call(pub)).status, "VERIFIED_CURRENT_VALUES");
      const value = f.state.fields[urn].structuredProperties.value;
      assert.deepEqual(value.extension, { human: true }); assert.equal(value.properties[0].annotation, "retain human note");
      assert.deepEqual(value.properties[1], { propertyUrn: "urn:li:structuredProperty:unselected", values: [{ string: "human value" }] });
    }
  }
});

test("mixed-field proposal retains ACL, field identity, Source evidence and lost-ACK protections", async () => {
  for (const failure of ["acl", "identity", "snapshot", "lost-ack"]) {
    const f = await fixture(); await start(f);
    const paths = f.state.dataset.schemaMetadata.value.fields.slice(0, 2).map(field => field.fieldPath);
    const urn = semanticFieldUrn(datasetUrn, paths[1]);
    if (failure === "acl") f.state.denied.add(urn);
    if (failure === "identity") f.state.fields[urn] = { schemaFieldKey: envelope({ parent: "wrong parent", fieldPath: paths[1] }) };
    if (failure === "snapshot") f.state.dataset.schemaMetadata.systemMetadata.version = "2";
    const proposal = { action: "prepare_maintenance", contract: "catalog/1", assetUrn: datasetUrn,
      candidates: paths.map(fieldPath => ({ kind: "property", operation: "set", fieldPath, value: "urn:li:structuredProperty:priority",
        values: ["high"], reason: "Exact fixture targets", evidenceIds: ["asset:identity"] })) };
    const staged = (await f.execute(proposal)).details;
    if (failure !== "lost-ack") {
      assert(staged.error); assert.equal(staged.correctionAllowed, undefined); assert.equal(f.aborts, 1);
      assert.equal(f.writes.targetWrites, 0); continue;
    }
    assert(!staged.error, staged.error);
    const ready = (await f.execute({ action: "seal_maintenance" })).details;
    await f.call({ action: "approve_maintenance", maintenanceRunUrn: ready.maintenanceRunUrn, version: ready.runVersion,
      planDigest: ready.planDigest, selection: maintenanceSelection(1, [0]) });
    f.writes.lossAfter = 1;
    const pub = { action: "publish_maintenance_item", maintenanceRunUrn: ready.maintenanceRunUrn, planDigest: ready.planDigest, itemId: staged.items[0].id };
    await assert.rejects(f.call(pub), /publication_write_unconfirmed/);
    const writes = f.writes.targetWrites; assert.equal(writes, 1);
    await assert.rejects(f.call(pub), /publication_already_attempted/);
    assert.equal(f.writes.targetWrites, writes, "ambiguous field write is not retried");
  }
});

test("known proposal validation mistakes can be corrected without dropping intent or cancelling all preparation", async () => {
  for (const issue of ["evidence", "field", "cardinality", "valueType", "allowedValue", "entityType", "missingItem"]) {
    const f = await fixture(), plan = await start(f), before = f.writes.recordWrites;
    const property = f.state.definitions["urn:li:structuredProperty:priority"].propertyDefinition.value;
    const candidate = { kind: "property", operation: "set", fieldPath: "order_id",
      value: "urn:li:structuredProperty:priority", values: ["high"], reason: "Explicit fixture value", evidenceIds: ["asset:identity"] };
    if (issue === "evidence") candidate.evidenceIds = ["unknown-evidence"];
    if (issue === "field") candidate.fieldPath = "missing_fixture_field";
    if (issue === "cardinality") candidate.values = ["normal", "high"];
    if (issue === "valueType") candidate.values = [42];
    if (issue === "allowedValue") candidate.values = ["not-allowed"];
    if (issue === "entityType") property.entityTypes = ["urn:li:entityType:datahub.dataset"];
    if (issue === "missingItem") candidate.value = { definitionItemId: oldId };
    const response = (await f.execute({ action: "prepare_maintenance", contract: "catalog/1", assetUrn: datasetUrn,
      version: plan.runVersion, candidates: [candidate] })).details;
    assert.equal(response.correctionAllowed, true, issue);
    assert.equal(f.aborts, 0, issue); assert.equal(f.writes.recordWrites, before); assert.equal(f.writes.targetWrites, 0);
    candidate.fieldPath = "order_id"; candidate.evidenceIds = ["asset:identity"]; candidate.values = ["high"];
    candidate.value = "urn:li:structuredProperty:priority"; property.entityTypes = ["urn:li:entityType:datahub.schemaField"];
    const corrected = (await f.execute({ action: "prepare_maintenance", contract: "catalog/1", assetUrn: datasetUrn,
      version: plan.runVersion, candidates: [candidate] })).details;
    assert(!corrected.error, `${issue}: ${corrected.error}`); assert.equal(corrected.totalItems, 1);
    assert.equal(f.aborts, 0); assert.equal(f.writes.targetWrites, 0);
  }
});

test("pure Catalog grammar errors return exact pre-write correction proof without killing preparation", async () => {
  const f = await fixture(); await start(f); const before = f.writes.recordWrites;
  const candidate = { kind: "description", operation: "add", value: "Fixture changed description", reason: "Explicit fixture evidence", evidenceIds: ["asset:identity"] };
  const rejected = (await f.execute({ action: "prepare_maintenance", contract: "catalog/1", assetUrn: datasetUrn, candidates: [candidate] })).details;
  assert.equal(rejected.correctionAllowed, true); assert.equal(rejected.inputRejection.issue, "semantic_invalid_candidate");
  assert.equal(f.writes.recordWrites, before); assert.equal(f.aborts, 0);
  const fixed = (await f.execute({ action: "prepare_maintenance", contract: "catalog/1", assetUrn: datasetUrn,
    candidates: [{ ...candidate, operation: "set" }] })).details;
  assert(!fixed.error, fixed.error); assert.equal(fixed.totalItems, 1);
  assert.equal((await f.execute({ action: "seal_maintenance" })).details.state, "READY");
});

test("exact authenticated Host pre-write rejection permits a new intent, not automatic replay", async () => {
  const f = await fixture(); await start(f);
  const before = f.writes.recordWrites, count = f.requests.length;
  // offset is legal on the broad tool schema, but forbidden for prepare by Host.
  const rejected = await f.execute({ action: "prepare_maintenance", contract: "catalog/1", assetUrn: datasetUrn, gap, offset: 20 });
  assert.equal(rejected.details.correctionAllowed, true); assert.equal(rejected.details.retryAllowed, false);
  assert.equal(rejected.details.inputRejection.phase, "INPUT_VALIDATION");
  assert.equal(maintenanceDriverResponse(f.requests.at(-1), rejected.details, false), "MODEL_CORRECTION");
  assert.equal(f.writes.recordWrites, before); assert.equal(f.requests.length, count + 1); assert.equal(f.aborts, 0);
  await f.handlers.tool_execution_end({ toolName: "datahub_semantic", toolCallId: "test-call", isError: true });
  const fixed = await f.execute({ action: "prepare_maintenance", contract: "catalog/1", assetUrn: datasetUrn, gap }, "fixed-call");
  assert.notEqual(fixed.details.requestId, rejected.details.requestId);
  assert.equal(fixed.details.items.length, 1);
  await f.handlers.agent_end({ messages: [{ role: "assistant", stopReason: "stop" }] }, f.ctx);
  assert.equal(f.queued.length, 1, "same accepted foreground remains eligible after new native progress");
});

test("missing, forged, mismatched or contradictory rejection evidence still stops", async () => {
  for (const mutate of [
    value => ({ error: value.error }),
    value => ({ ...value, inputRejection: { ...value.inputRejection, requestId: oldId } }),
    value => ({ ...value, inputRejection: { ...value.inputRejection, maintenanceRunUrn: "other-root" } }),
    value => ({ ...value, inputRejection: { ...value.inputRejection, requestDigest: "a".repeat(64) } }),
    value => ({ ...value, inputRejection: { ...value.inputRejection, phase: "NATIVE_WRITE" } }),
    value => ({ ...value, reconciliation: { runUrn: "unknown-child" } }),
  ]) {
    const f = await fixture(); await start(f); f.setReply(mutate);
    const result = await f.execute({ action: "prepare_maintenance", contract: "catalog/1", assetUrn: datasetUrn, gap, offset: 20 });
    assert.equal(result.details.correctionAllowed, undefined); assert.equal(f.aborts, 1);
    assert.equal(result.details.retryAllowed, false);
    assert.equal(maintenanceDriverResponse(f.requests.at(-1), result.details, false), "STOP");
    await f.handlers.agent_end({ messages: [{ role: "assistant", stopReason: "stop" }] }, f.ctx);
    assert.equal(f.queued.length, 0);
  }
});

test("lost ACK after an actual record write is not a correctable input failure", async () => {
  const f = await fixture(); await start(f);
  const before = f.writes.recordWrites; f.writes.recordLossAt = before + 1;
  const result = await f.execute({ action: "prepare_maintenance", contract: "catalog/1", assetUrn: datasetUrn, gap });
  assert.equal(f.writes.recordWrites, before + 1); assert.equal(f.aborts, 1);
  assert.equal(result.details.correctionAllowed, undefined); assert.equal(result.details.retryAllowed, false);
  assert.equal(maintenanceDriverResponse(f.requests.at(-1), result.details, false), "STOP");
  assert.equal(f.requests.filter(r => r.action === "prepare_maintenance").length, 1);
});

test("operation history preserves original locators and scopes; a DEFERRED locator can be revised append-only", async () => {
  const f = await fixture(), plan = await start(f);
  const oldRoot = `urn:li:dataProcessInstance:semantic-${f.context.actor.key}-${oldId}`;
  const original = { type: "custom", customType: "datahub-semantic.intent/1", id: "original-intent", data: {
    action: "prepare_maintenance", sessionId: f.sessionId, sourceUrn, assetUrn: datasetUrn,
    requestId: oldId, reconciliation: { requestId: oldId, maintenanceRunUrn: oldRoot }, dispatchIntentOnly: true, retryAllowed: false,
  } };
  f.entries.push(structuredClone(original));
  for (const change of [{ sessionId: "other" }, { sourceUrn: "other-source" }, { assetUrn: "other-asset" }])
    f.entries.push({ ...original, id: "unrelated", data: { ...original.data, ...change } });
  const history = (await f.execute({ action: "read_operation_history", contract: "catalog/1", assetUrn: datasetUrn })).details;
  assert.equal(history.operations.length, 1); assert.equal(history.operations[0].operation.maintenanceRunUrn, oldRoot);
  assert.equal(history.operations[0].effect, "NOT_PROVEN"); assert.equal(history.operations[0].retryAllowed, false);
  assert.equal(history.operations[0].fieldLocatorRecorded, false, "legacy field scope remains explicitly unrecorded");
  const operation = history.operations[0].operation;
  await assert.rejects(f.execute({ action: "prepare_maintenance", contract: "catalog/1", assetUrn: datasetUrn,
    gap: { code: "UNRESOLVED_OPERATION", reason: "Wrong current Root claim", operation: { ...operation, maintenanceRunUrn: plan.maintenanceRunUrn } } }), /operation.*history/);
  // Reproduce an already-saved r16-style incorrect claim via the native
  // boundary. No production data is touched; the SDK must revise, not replay.
  const inspected = await f.inspect();
  f.writes.pending = { action: "prepare_maintenance", requestId: "00000000-0000-4000-8000-000000000098", sessionId: f.sessionId,
    maintenanceRunUrn: plan.maintenanceRunUrn, contract: "catalog/1", sourceUrn, assetUrn: datasetUrn,
    snapshotDigest: inspected.snapshotDigest, gap: { code: "UNRESOLVED_OPERATION", reason: "Earlier incorrect current-Root claim",
      operation: { ...operation, maintenanceRunUrn: plan.maintenanceRunUrn } } };
  const staged = await f.call({ ...f.writes.pending, uiRequestId: "fixture-ui" });
  assert.equal(staged.items[0].gap.operation.maintenanceRunUrn, plan.maintenanceRunUrn);
  const item = staged.items[0], nativeHistory = structuredClone([...f.journal.entries()]);
  const revised = (await f.execute({ action: "revise_maintenance", contract: "catalog/1", assetUrn: datasetUrn,
    version: staged.runVersion, itemId: item.id, childVersion: item.childVersion, planDigest: item.planDigest,
    gap: { code: "UNRESOLVED_OPERATION", reason: "Clarify recorded origin; effects remain unknown", operation } })).details;
  assert.equal(revised.totalRecordedItems, 2); assert.equal(revised.totalItems, 1);
  assert.deepEqual(revised.items[0].gap.operation, operation);
  assert.deepEqual(f.entries.find(e => e.id === "original-intent"), original);
  for (const [key, versions] of nativeHistory) {
    assert.deepEqual(f.journal.get(key).slice(0, versions.length), versions, "old native versions preserved");
  }
  assert.equal((await f.execute({ action: "seal_maintenance" })).details.state, "READY");
  assert.equal(f.writes.targetWrites, 0);
});

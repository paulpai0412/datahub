// Product SDK extension -> actual Host -> synthetic public DataHub API only.
// No provider, credentials, live service, deployment or model quality claim.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { semanticCatalogFixture, catalogEvidence } from "./fixtures/semantic-catalog-fixture.mjs";
import { sourceUrn, datasetUrn } from "./fixtures/semantic-fixture.mjs";
const { createJiti } = createRequire(new URL("../extensions/datahub-agent/pi-web/package.json", import.meta.url))("jiti");

async function fixture() {
  const f = semanticCatalogFixture(), requests = [], entries = [], queued = [], handlers = {};
  const { default: register } = await createJiti(import.meta.url).import("../extensions/datahub-agent/pi-web/lib/datahub-semantic-extension.ts");
  let tool, abortCount = 0, transform = value => value;
  register({ on(name, handler) { handlers[name] = handler; }, registerTool(value) { tool = value; },
    appendEntry(...entry) { entries.push(entry); }, sendMessage(...message) { queued.push(message); } });
  const ctx = { mode: "rpc", sessionManager: { getSessionId: () => f.sessionId }, abort() { abortCount++; },
    ui: { notify() {}, async input(_title, body) {
      const input = JSON.parse(body); requests.push(input);
      const write = ["start_maintenance", "prepare_maintenance", "revise_maintenance", "seal_maintenance", "continue_maintenance"].includes(input.action);
      if (write) f.writes.pending = input;
      const value = await f.call({ ...input, ...(write ? { uiRequestId: "fixture-ui" } : {}) });
      return JSON.stringify(transform(value));
    } } };
  return { ...f, tool, ctx, requests, entries, queued, handlers,
    execute: input => tool.execute("fixture-call", input, undefined, undefined, ctx),
    transform(fn) { transform = fn; }, get abortCount() { return abortCount; } };
}

test("SDK consumes exact incremental ACK versions and definition references without per-item full Root rereads", async () => {
  const f = await fixture();
  await f.execute({ action: "start_maintenance", sourceUrn, assetUrns: [datasetUrn, f.assets.chart] });
  await f.execute({ action: "inspect_asset", contract: "catalog/1", assetUrn: datasetUrn });
  const tag = (await f.execute({ action: "prepare_maintenance", contract: "catalog/1", assetUrn: datasetUrn,
    definition: { kind: "tag", operation: "create", name: "Synthetic stewardship tag", description: "Fixture source evidence" },
    reason: catalogEvidence.reason, evidenceIds: catalogEvidence.evidenceIds })).details;
  assert.equal(tag.delivery, "incremental");
  assert.equal(f.requests.at(-1).responseMode, "incremental");
  const reference = tag.items[0].definition.reference;
  const application = (await f.execute({ action: "prepare_maintenance", contract: "catalog/1", assetUrn: datasetUrn,
    version: tag.runVersion, candidates: [{ kind: "tag", operation: "add", value: reference, ...catalogEvidence }] })).details;
  assert.equal(application.delivery, "incremental");
  assert.equal(application.delta.baseVersion, tag.runVersion);
  assert.equal(application.items.length, 1);
  assert.equal(application.items[0].id, application.preparedItemId);
  assert.deepEqual(application.items[0].dependencies, [tag.preparedItemId]);
  await f.execute({ action: "inspect_asset", contract: "catalog/1", assetUrn: f.assets.chart });
  const chart = (await f.execute({ action: "prepare_maintenance", contract: "catalog/1", assetUrn: f.assets.chart,
    version: application.runVersion, candidates: [{ kind: "description", operation: "set", value: "Evidence-backed chart", ...catalogEvidence }] })).details;
  assert.equal(chart.totalItems, 3);
  assert.equal(chart.unpreparedAssetCount, 0);
  assert.equal(f.requests.filter(q => q.action === "read_maintenance").length, 0, "ACKs suffice for the next NEW intent, not for final self-review/consent");
  assert.equal(f.requests.at(-1).version, application.runVersion, "model supplied version remains exact; SDK never fills it");
  const full = (await f.execute({ action: "read_maintenance", version: chart.runVersion })).details;
  assert.equal(full.items.length, 3);
  assert.equal(full.delivery, undefined);
  assert.equal(f.writes.targetWrites, 0); assert.equal(f.abortCount, 0); assert.equal(f.queued.length, 0);
});

test("malformed incremental ACK and lost ACK stop after one dispatch without repairing or replaying saved work", async () => {
  for (const corrupt of [
    value => ({ ...value, preparedItemId: "00000000-0000-4000-8000-000000000099" }),
    value => ({ ...value, items: [] }),
    value => ({ ...value, delivery: "unknown" }),
    value => ({ ...value, delta: { ...value.delta, completePlan: true } }),
    value => ({ ...value, delta: { ...value.delta, baseVersion: value.runVersion } }),
    value => ({ ...value, nextOffset: 20 }),
    () => undefined,
  ]) {
    const f = await fixture();
    await f.execute({ action: "start_maintenance", sourceUrn, assetUrns: [datasetUrn] });
    await f.execute({ action: "inspect_asset", contract: "catalog/1", assetUrn: datasetUrn });
    const input = f.ctx.ui.input;
    f.ctx.ui.input = async (...args) => {
      const value = JSON.parse(await input(...args));
      const transformed = corrupt(value);
      return transformed === undefined ? undefined : JSON.stringify(transformed);
    };
    const before = f.requests.length;
    const result = await f.execute({ action: "prepare_maintenance", contract: "catalog/1", assetUrn: datasetUrn,
      candidates: [{ kind: "description", operation: "set", value: "Synthetic guarded write", ...catalogEvidence }] });
    assert.equal(result.details.format, "datahub-semantic.error/1");
    assert.equal(result.details.retryAllowed, false); assert.equal(f.abortCount, 1);
    assert.equal(f.requests.length, before + 1); assert.equal(f.queued.length, 0);
    assert.equal(f.writes.targetWrites, 0);
    assert(f.writes.recordWrites > 2, "saved native proposal is not claimed absent after invalid/lost ACK");
    assert(f.entries.some(([kind]) => kind === "datahub-semantic.unconfirmed/1"));
  }
});

test("SDK forwards an explicit unresolved-operation deferral, exposes partial READY and never replays its locator", async () => {
  const f = await fixture(), plan = (await f.execute({ action: "start_maintenance", sourceUrn, assetUrns: [datasetUrn] })).details;
  await f.execute({ action: "inspect_asset", contract: "catalog/1", sourceUrn, assetUrn: datasetUrn });
  const operation = { action: "prepare_maintenance", maintenanceRunUrn: `urn:li:dataProcessInstance:semantic-${f.context.actor.key}`, requestId: "00000000-0000-4000-8000-000000000099" };
  const deferred = await f.execute({ action: "prepare_maintenance", maintenanceRunUrn: plan.maintenanceRunUrn,
    contract: "catalog/1", sourceUrn, assetUrn: datasetUrn, gap: { code: "UNRESOLVED_OPERATION", reason: "Historical unknown; explicitly defer", operation } });
  assert.equal(deferred.details.items[0].status, "DEFERRED");
  assert.deepEqual(deferred.details.items[0].gap.operation, operation);
  assert.notEqual(f.requests.at(-1).requestId, operation.requestId, "new deferral intent is not an original-operation replay");
  const scope = await f.execute({ action: "read_maintenance", maintenanceRunUrn: plan.maintenanceRunUrn, view: "scope", offset: 0 });
  assert.equal(scope.details.sealing.deferredItemCount, 1); assert.equal(scope.details.sealing.semanticCompletenessVerified, false);
  const ready = await f.execute({ action: "seal_maintenance", maintenanceRunUrn: plan.maintenanceRunUrn });
  assert.equal(ready.details.state, "READY"); assert.equal(ready.details.publicationAuthorized, false);
  assert.equal(f.writes.targetWrites, 0); assert.equal(f.abortCount, 0);
  assert(f.requests.every(q => q.action !== "publish_maintenance_item" && q.action !== "recover_maintenance"));
  assert.equal(f.tool.parameters.properties.gap.anyOf[1].properties.code.const, "UNRESOLVED_OPERATION");
});

test("scope/unprepared views reach the actual Host unchanged and do not arm or automate maintenance", async () => {
  const f = await fixture();
  const start = await f.execute({ action: "start_maintenance", sourceUrn, assetUrns: [datasetUrn, f.assets.chart] });
  await f.handlers.input({ source: "interactive" }); // No authority from a prior accepted prompt.
  const reference = { maintenanceRunUrn: start.details.maintenanceRunUrn, version: start.details.runVersion };
  const records = f.writes.recordWrites, entries = f.entries.length;
  for (const view of ["scope", "unprepared"]) {
    const result = await f.execute({ action: "read_maintenance", ...reference, view, offset: 0 });
    assert.equal(result.details.format, "datahub-semantic.maintenance-scope/1");
    assert.equal(result.details.view, view);
    assert.deepEqual(result.details.assets.map(a => a.assetUrn), [datasetUrn, f.assets.chart]);
    assert.equal(result.details.unpreparedAssetCount, 2);
    assert.equal(result.details.sealing.completeSourceInventoryRequired, false);
    assert.equal(result.details.sealing.semanticCompletenessVerified, false);
    assert.equal(result.details.publicationAuthorized, false);
    assert.deepEqual(JSON.parse(result.content[0].text), result.details);
    assert.equal(f.requests.at(-1).view, view);
    assert.equal(f.requests.at(-1).version, reference.version);
    assert.equal(f.requests.at(-1).sessionId, undefined, "read is not an implicit continue");
  }
  assert.equal(f.writes.recordWrites, records); assert.equal(f.writes.targetWrites, 0);
  assert.equal(f.entries.length, entries); assert.equal(f.queued.length, 0);
  const old = await f.execute({ action: "read_maintenance", ...reference });
  assert.equal(old.details.format, "datahub-semantic.maintenance/1"); assert.deepEqual(old.details.items, []);
  assert.deepEqual(f.tool.parameters.properties.view.enum, ["scope", "unprepared"]);
});

test("scope reads reject mismatched format, view, offset or pinned version without retry or parameter repair", async () => {
  for (const change of [
    { format: "datahub-semantic.maintenance/1" }, { view: "scope" }, { offset: 20 }, { runVersion: "999" },
  ]) {
    const f = await fixture();
    const plan = (await f.execute({ action: "start_maintenance", sourceUrn, assetUrns: [datasetUrn] })).details;
    f.transform(value => ({ ...value, ...change }));
    const before = f.requests.length;
    const result = await f.execute({ action: "read_maintenance", maintenanceRunUrn: plan.maintenanceRunUrn,
      version: plan.runVersion, view: "unprepared", offset: 0 });
    assert.equal(result.details.format, "datahub-semantic.error/1");
    assert.equal(result.details.error, "invalid_semantic_host_response");
    assert.equal(result.details.retryAllowed, false); assert.equal(f.abortCount, 1);
    assert.equal(f.requests.length, before + 1); assert.equal(f.queued.length, 0); assert.equal(f.writes.targetWrites, 0);
    assert.equal(f.requests.at(-1).version, plan.runVersion);
  }
});

test("SDK -> actual Host persists Source focus, carries the current Root binding and permits only a new corrected input", async () => {
  const f = await fixture(), original = f.ctx.ui.input;
  f.ctx.ui.input = async (...args) => {
    try { return await original(...args); }
    catch (error) {
      // Same exact typed no-write reply as the trusted Host error boundary.
      // Other failures still throw; this is not a broad correction fallback.
      if (error.inputRejection?.issue !== "semantic_maintenance_focus_mismatch") throw error;
      return JSON.stringify({ format: "datahub-semantic.error/1", error: error.message,
        inputRejection: error.inputRejection, publicationAuthorized: false, retryAllowed: false });
    }
  };
  const start = await f.execute({ action: "start_maintenance", sourceUrn, assetUrns: [datasetUrn], focus: "tag" });
  assert.equal(start.details.governance.focus, "tag");
  assert.equal(f.requests[0].focus, "tag");
  assert.deepEqual(f.tool.parameters.properties.focus.anyOf.map(value => value.const), ["all", "glossary", "tag", "table", "field"]);
  await f.execute({ action: "inspect_asset", contract: "catalog/1", assetUrn: datasetUrn });
  const before = f.writes.recordWrites;
  const rejected = await f.execute({ action: "prepare_maintenance", contract: "catalog/1", assetUrn: datasetUrn,
    candidates: [{ kind: "term", operation: "add", value: "urn:li:glossaryTerm:Order", ...catalogEvidence }] });
  assert.equal(rejected.details.inputRejection.issue, "semantic_maintenance_focus_mismatch");
  assert.equal(rejected.details.correctionAllowed, true); assert.equal(rejected.details.retryAllowed, false);
  assert.equal(f.writes.recordWrites, before); assert.equal(f.abortCount, 0);
  const accepted = await f.execute({ action: "prepare_maintenance", contract: "catalog/1", assetUrn: datasetUrn,
    candidates: [{ kind: "tag", operation: "add", value: "urn:li:tag:Reviewed", ...catalogEvidence }] });
  assert.equal(accepted.details.totalItems, 1); assert.equal(accepted.details.governance.focus, "tag");
  assert.equal(f.requests.at(-1).maintenanceRunUrn, start.details.maintenanceRunUrn);
  assert.equal(f.requests.at(-1).sourceUrn, sourceUrn);
  assert.equal(f.writes.targetWrites, 0); assert.equal(f.abortCount, 0);
});

test("new complete-hierarchy reads cannot treat a successful-empty native ancestor as correctable direct input", async () => {
  const f = await fixture(), missing = "urn:li:glossaryNode:MissingNativeAncestor";
  f.state.definitions["urn:li:glossaryTerm:Order"].glossaryTermInfo.value.parentNode = "urn:li:glossaryNode:Commerce";
  f.state.definitions["urn:li:glossaryNode:Commerce"].glossaryNodeInfo.value.parentNode = missing;
  const fetch = f.context.fetchImpl;
  f.context.fetchImpl = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    if (url.pathname.endsWith("/batchGet") && body?.[0]?.urn === missing) return Response.json([]);
    return fetch(url, options);
  };
  const input = f.ctx.ui.input;
  f.ctx.ui.input = async (...args) => {
    try { return await input(...args); }
    catch (error) {
      if (error.message !== "semantic_definition_ancestor_not_found") throw error;
      return JSON.stringify({ format: "datahub-semantic.error/1", error: error.message, publicationAuthorized: false, retryAllowed: false });
    }
  };
  await assert.rejects(f.execute({ action: "inspect_definition", contract: "catalog/1", sourceUrn, assetUrn: datasetUrn,
    kind: "term", referenceUrn: "urn:li:glossaryTerm:Order" }), /semantic_definition_ancestor_not_found/);
  await f.handlers.tool_execution_end({ toolName: "datahub_semantic", toolCallId: "fixture-call", isError: true });
  assert.equal(f.abortCount, 1, "same prompt/batch aborted, not a correctable supplied-URN failure");
  assert.equal(f.requests.length, 1, "no direct-reference correction/retry or replacement Root dispatched");
  assert.equal(f.queued.length, 0);
  assert.equal(f.writes.recordWrites, 0); assert.equal(f.writes.targetWrites, 0);
});


test("a second field-page prepare overlap returns exact no-write proof and the model can revise one whole Chinese item", async () => {
  const f = await fixture(), original = f.ctx.ui.input;
  f.ctx.ui.input = async (...args) => {
    try { return await original(...args); }
    catch (error) {
      if (error.message !== "semantic_maintenance_aspect_overlap" && error.inputRejection?.issue !== "semantic_maintenance_aspect_overlap") throw error;
      return JSON.stringify({ format: "datahub-semantic.error/1", error: error.message,
        ...(error.inputRejection ? { inputRejection: error.inputRejection } : {}), publicationAuthorized: false, retryAllowed: false });
    }
  };
  const plan = (await f.execute({ action: "start_maintenance", sourceUrn, assetUrns: [datasetUrn] })).details;
  const inspected = (await f.execute({ action: "inspect_asset", contract: "catalog/1", assetUrn: datasetUrn })).details;
  assert(inspected.fields.length >= 2);
  const candidate = (index, value) => ({ kind: "description", operation: "set", fieldPath: inspected.fields[index].fieldPath,
    value, reason: "有來源證據的繁體中文欄位說明，供真人核對", evidenceIds: ["asset:identity"] });
  const a = candidate(0, "第一頁欄位的完整說明"), b = candidate(1, "後續頁欄位的完整說明");
  const first = (await f.execute({ action: "prepare_maintenance", contract: "catalog/1", assetUrn: datasetUrn, candidates: [a] })).details;
  assert.equal(first.maintenanceRunUrn, plan.maintenanceRunUrn);
  const writes = f.writes.recordWrites, journal = JSON.stringify([...f.journal]);
  const rejected = (await f.execute({ action: "prepare_maintenance", contract: "catalog/1", assetUrn: datasetUrn,
    version: first.runVersion, candidates: [b] })).details;
  assert.equal(rejected.inputRejection?.issue, "semantic_maintenance_aspect_overlap");
  assert.equal(rejected.correctionAllowed, true); assert.equal(rejected.retryAllowed, false);
  assert.equal(f.abortCount, 0); assert.equal(f.writes.recordWrites, writes); assert.equal(JSON.stringify([...f.journal]), journal);
  const current = (await f.execute({ action: "read_maintenance", assetUrn: datasetUrn, version: first.runVersion, offset: 0 })).details;
  const item = current.items[0];
  const revised = (await f.execute({ action: "revise_maintenance", contract: "catalog/1", assetUrn: datasetUrn,
    version: current.runVersion, itemId: item.id, childVersion: item.childVersion, planDigest: item.planDigest, candidates: [a,b] })).details;
  assert.equal(revised.totalItems, 1); assert.equal(revised.totalRecordedItems, 2);
  const whole = (await f.execute({ action: "read_maintenance", assetUrn: datasetUrn, version: revised.runVersion, offset: 0 })).details;
  assert.deepEqual(whole.items[0].preparedRequest.candidates, [a,b], "preserve both Chinese pages; no SDK merge, split or translation");
  assert.equal(f.requests.filter(q => q.action === "prepare_maintenance").length, 2, "no automatic redispatch of the rejected input");
  assert.equal(f.queued.length, 0);
  const ready = (await f.execute({ action: "seal_maintenance" })).details;
  assert.equal(ready.state, "READY"); assert.equal(ready.publicationAuthorized, false);
  assert.equal(f.writes.targetWrites, 0); assert.equal(f.abortCount, 0);
});

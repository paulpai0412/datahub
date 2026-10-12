import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { semanticCatalogFixture, catalogEvidence } from "./fixtures/semantic-catalog-fixture.mjs";
import { sourceUrn, datasetUrn } from "./fixtures/semantic-fixture.mjs";
import { maintenanceSelection, MaintenanceInputRejection } from "../extensions/datahub-agent/integration/semantic-maintenance-plan.mjs";
import { loadMaintenancePlan, orderMaintenanceItems } from "../extensions/datahub-agent/mfe/semantic-maintenance-review.js";

function fixture() {
  const f = semanticCatalogFixture();
  f.writes.recordHistoryLimits.ekopAgentTask = 2147483647;
  f.writes.recordHistoryLimits.ekopAgentRun = 2147483647;
  async function write(input) {
    f.writes.pending = { requestId: randomUUID(), sessionId: f.sessionId, ...input };
    return f.call({ ...f.writes.pending, uiRequestId: "fixture-ui" });
  }
  const start = (assetUrns = [datasetUrn]) => write({ action: "start_maintenance", sourceUrn, ...(assetUrns ? { assetUrns } : {}) });
  const stage = async (plan, proposal) => {
    const { action: _action, ...body } = proposal;
    return write({ ...body, action: "prepare_maintenance", maintenanceRunUrn: plan.maintenanceRunUrn });
  };
  const seal = (plan) => write({ action: "seal_maintenance", maintenanceRunUrn: plan.maintenanceRunUrn });
  const read = (plan) => f.call({ action: "read_maintenance", maintenanceRunUrn: plan.maintenanceRunUrn });
  const readScope = (plan, view = "scope", offset = 0, extra = {}) => f.call({ action: "read_maintenance",
    maintenanceRunUrn: plan.maintenanceRunUrn, view, offset, version: plan.runVersion, ...extra });
  const approve = (plan, indexes = Array.from({ length: plan.totalItems }, (_, index) => index)) => f.call({ action: "approve_maintenance",
    maintenanceRunUrn: plan.maintenanceRunUrn, version: plan.runVersion, planDigest: plan.planDigest,
    selection: maintenanceSelection(plan.totalItems, indexes) });
  const publish = (plan, itemId) => f.call({ action: "publish_maintenance_item", maintenanceRunUrn: plan.maintenanceRunUrn,
    planDigest: plan.planDigest, itemId });
  const revise = (plan, item, proposal, extra = {}) => {
    const { action: _action, ...body } = proposal;
    return write({ ...body, action: "revise_maintenance", maintenanceRunUrn: plan.maintenanceRunUrn,
      version: plan.runVersion, itemId: item.id, childVersion: item.childVersion, planDigest: item.planDigest, ...extra });
  };
  return { ...f, start, stage, seal, read, readScope, approve, publish, revise };
}

test("historical UNKNOWN can be explicitly deferred while independent work reaches review and publishes once", async () => {
  const f = fixture(), old = await f.start(), tag = await newDefinition(f, old, "tag");
  await f.stage(old, await f.request([{ kind: "tag", operation: "add", value: tag.urn, ...catalogEvidence }]));
  const oldReady = await f.seal(old); await f.approve(oldReady);
  f.writes.lossAfter = 1;
  await assert.rejects(f.publish(oldReady, tag.item.id), /publication_write_unconfirmed/);
  f.writes.lossAfter = 0;
  const originalHistory = structuredClone([...f.journal.entries()]);
  const plan = await f.start([datasetUrn, f.assets.chart]), inspected = await f.inspect();
  const operation = { action: "publish_maintenance_item", maintenanceRunUrn: old.maintenanceRunUrn, itemId: tag.item.id };
  const staged = await f.stage(plan, { contract: "catalog/1", sourceUrn, assetUrn: datasetUrn,
    snapshotDigest: inspected.snapshotDigest, gap: { code: "UNRESOLVED_OPERATION", reason: "Original target attempt remains unknown; defer, do not replay", operation } });
  assert.equal(staged.items[0].status, "DEFERRED");
  assert.deepEqual(staged.items[0].gap.operation, operation);
  assert.equal(f.writes.targetWrites, 1);
  await f.stage(plan, await f.request([{ kind: "description", operation: "set", value: "Independent evidence-backed chart", ...catalogEvidence }], f.assets.chart));
  const current = await f.read(plan), scope = await f.readScope(current);
  assert.equal(scope.unpreparedAssetCount, 0); assert.equal(scope.sealing.deferredAssetCount, 1);
  assert.equal(scope.sealing.deferredItemCount, 1); assert.equal(scope.sealing.structurallyReady, true);
  assert.equal(scope.sealing.semanticCompletenessVerified, false);
  const ready = await f.seal(plan), loaded = await loadMaintenancePlan({ maintenanceRunUrn: ready.maintenanceRunUrn }, input => f.call(input), new AbortController().signal);
  assert.equal(loaded.items[0].status, "DEFERRED"); assert.equal(loaded.state, "READY");
  await assert.rejects(f.publish(ready, ready.items[1].id), /semantic_maintenance_consent_required/);
  await f.approve(ready);
  assert.equal((await f.publish(ready, ready.items[0].id)).outcome, "DEFERRED");
  assert.equal(f.writes.targetWrites, 1, "deferral cannot dispatch or recover the original attempt");
  assert.equal((await f.publish(ready, ready.items[1].id)).status, "VERIFIED_CURRENT_VALUES");
  assert.equal(f.writes.targetWrites, 2);
  for (const [key, versions] of originalHistory) assert.deepEqual(f.journal.get(key), versions, "old unknown history unchanged");
  await assert.rejects(f.publish(oldReady, tag.item.id), /publication_already_attempted/);
  const later = await f.start();
  await assert.rejects(f.stage(later, await f.definitionRequest({ kind: "tag", operation: "update", urn: tag.urn, version: "1", description: "Still cannot overwrite the unresolved target" })), /semantic_maintenance_target_unresolved/);
});

test("deferral preserves unavailable locators and does not permanently quarantine the asset", async () => {
  const f = fixture(), plan = await f.start(), inspected = await f.inspect();
  const operation = { action: "prepare_maintenance", maintenanceRunUrn: `urn:li:dataProcessInstance:semantic-${f.context.actor.key}` };
  await f.stage(plan, { contract: "catalog/1", sourceUrn, assetUrn: datasetUrn, snapshotDigest: inspected.snapshotDigest,
    gap: { code: "UNRESOLVED_OPERATION", reason: "Historical draft observation locator is incomplete; no absence claimed", operation } });
  const deferred = (await f.read(plan)).items[0];
  assert.equal(deferred.status, "DEFERRED"); assert.equal(deferred.gap.operation.requestId, undefined);
  await f.stage(plan, await f.request([{ kind: "description", operation: "set", value: "Independent meaning with fresh evidence", ...catalogEvidence }]));
  assert.deepEqual((await f.read(plan)).items.map(i => i.status), ["DEFERRED", "PENDING"]);
  assert.equal(f.writes.targetWrites, 0);
});

test("deferral cannot carry target changes, invent a recovery outcome or bypass current ACL/CAS", async () => {
  const f = fixture(), plan = await f.start(), inspected = await f.inspect();
  const operation = { action: "prepare_maintenance", maintenanceRunUrn: plan.maintenanceRunUrn };
  const input = { contract: "catalog/1", sourceUrn, assetUrn: datasetUrn, snapshotDigest: inspected.snapshotDigest,
    gap: { code: "UNRESOLVED_OPERATION", reason: "Explicit historical skip", operation } };
  for (const gap of [
    { code: "UNRESOLVED_OPERATION", reason: "Missing operation" },
    { ...input.gap, operation: { ...operation, action: "approve_maintenance" } },
    { ...input.gap, operation: { ...operation, requestId: "unknown" } },
    { ...input.gap, operation: { ...operation, maintenanceRunUrn: "urn:li:dataProcessInstance:semantic-foreign" } },
    { ...input.gap, operation: { ...operation, resolved: true } },
    { ...input.gap, code: "INSUFFICIENT_EVIDENCE" },
  ]) await assert.rejects(f.stage(plan, { ...input, gap }), /invalid_semantic_maintenance_request/);
  await assert.rejects(f.stage(plan, { ...input, candidates: [] }), /invalid_semantic_maintenance_request/);
  await assert.rejects(f.stage(plan, { ...input, version: "999" }), /semantic_maintenance_plan_changed/);
  const count = f.writes.recordWrites; f.state.denied.add(datasetUrn);
  await assert.rejects(f.stage(plan, input), /semantic_read_forbidden/); f.state.denied.clear();
  assert.equal(f.writes.recordWrites, count); assert.equal(f.writes.targetWrites, 0);
  assert.equal((await f.read(plan)).totalItems, 0);
});

test("native scope explains actual unprepared subjects and seal conditions without choosing semantic actions", async () => {
  const f = fixture(), assets = [f.assets.chart, datasetUrn, f.assets.container], plan = await f.start(assets);
  const first = await f.readScope(plan), writes = f.writes.recordWrites;
  assert.equal(first.format, "datahub-semantic.maintenance-scope/1");
  assert.deepEqual(first.assets.map(a => a.assetUrn), assets);
  assert(first.assets.every(a => !a.accounted && a.activeItemCount === 0));
  assert.equal(first.unpreparedAssetCount, assets.length);
  assert.equal(first.sealing.structurallyReady, false);
  assert.deepEqual(first.sealing.checks.filter(c => !c.met).map(c => c.condition), ["PLAN_HAS_ITEMS", "SELECTED_ASSETS_ACCOUNTED"]);
  assert.equal(first.sealing.completeSourceInventoryRequired, false);
  assert.equal(first.sealing.semanticCompletenessVerified, false);
  assert.equal(first.sealing.humanConsentRequiredForPublication, true);
  assert.equal(first.publicationAuthorized, false);
  assert.equal(f.writes.recordWrites, writes); assert.equal(f.writes.targetWrites, 0);

  await newDefinition(f, plan, "term");
  const definitionOnly = await f.read(plan);
  assert.deepEqual((await f.readScope(definitionOnly, "unprepared")).assets.map(a => a.assetUrn), assets,
    "a definition's evidence anchor does not account for an asset");
  const inspection = await f.inspect();
  await f.stage(plan, { contract: "catalog/1", sourceUrn, assetUrn: datasetUrn, snapshotDigest: inspection.snapshotDigest,
    gap: { code: "INSUFFICIENT_EVIDENCE", reason: "Undetermined business classification; not an unknown publication receipt" } });
  const withGap = await f.read(plan), remaining = await f.readScope(withGap, "unprepared");
  assert.deepEqual(remaining.assets.map(a => a.assetUrn), [f.assets.chart, f.assets.container]);
  assert.equal(remaining.accountedAssetCount, 1); assert.equal(remaining.unpreparedAssetCount, 2);
  assert.equal(remaining.totalAssets, 2); assert.equal(remaining.nextOffset, null);
  await assert.rejects(f.seal(plan), /semantic_maintenance_assets_unaccounted/);

  await f.stage(plan, await f.request([{ kind: "description", operation: "set", value: "Evidenced chart meaning", ...catalogEvidence }], f.assets.chart));
  await f.stage(plan, await f.request([{ kind: "description", operation: "set", value: "Existing human description", ...catalogEvidence }], f.assets.container));
  const final = await f.read(plan), complete = await f.readScope(final);
  assert.equal(complete.sealing.structurallyReady, true); assert.equal(complete.unpreparedAssetCount, 0);
  assert(complete.assets.every(a => a.accounted && a.activeItemCount === 1));
  assert.equal(complete.sealing.semanticCompletenessVerified, false, "GAP/KEEP/PENDING accounting is not semantic quality");
  const noRemaining = await f.readScope(final, "unprepared");
  assert.deepEqual(noRemaining.assets, []); assert.equal(noRemaining.nextOffset, null);
  assert.equal(f.writes.targetWrites, 0, "the scope view never prepares, seals, confirms or publishes");
  const ready = await f.seal(plan), sealed = await f.readScope(ready);
  assert.equal(sealed.state, "READY"); assert.equal(sealed.sealing.structurallyReady, false);
  assert.deepEqual(sealed.sealing.checks.filter(c => !c.met).map(c => c.condition), ["PLAN_UNSEALED"]);
});

test("scope pages require current native version, Source membership and current asset visibility without effects", async () => {
  const f = fixture(), plan = await f.start([datasetUrn, f.assets.chart]);
  const writes = f.writes.recordWrites;
  await assert.rejects(f.readScope(plan, "invented"), /invalid_semantic_maintenance_request/);
  await assert.rejects(f.readScope(plan, "scope", 0, { assetUrn: datasetUrn }), /invalid_semantic_maintenance_request/);
  f.state.denied.add(f.assets.chart);
  await assert.rejects(f.readScope(plan), /semantic_read_forbidden/);
  f.state.denied.clear();
  const beforeScope = f.policy.semanticCatalogAssets;
  f.policy.semanticCatalogAssets = [];
  await assert.rejects(f.readScope(plan), /semantic_maintenance_scope_changed/);
  f.policy.semanticCatalogAssets = beforeScope;
  assert.equal(f.writes.recordWrites, writes); assert.equal(f.writes.targetWrites, 0);
  await f.stage(plan, await f.request([{ kind: "description", operation: "set", value: "Scoped proposal", ...catalogEvidence }]));
  await assert.rejects(f.readScope(plan), /semantic_maintenance_plan_changed/);
  const current = await f.read(plan), base = f.context.fetchImpl;
  let changed = false;
  f.context.fetchImpl = async (url, options) => {
    const response = await base(url, options), input = options.body && JSON.parse(options.body);
    if (!changed && input?.variables?.input?.resourceSpec?.resourceUrn === f.assets.chart) {
      changed = true;
      const root = f.journal.get(`${plan.maintenanceRunUrn}/ekopAgentRun`).at(-1);
      root.systemMetadata.version = String(Number(root.systemMetadata.version) + 1);
    }
    return response;
  };
  const before = f.writes.recordWrites;
  await assert.rejects(f.readScope(current), /semantic_maintenance_plan_changed/, "no mixed-version scope receipt after awaited ACL reads");
  assert.equal(changed, true); assert.equal(f.writes.recordWrites, before); assert.equal(f.writes.targetWrites, 0);
});

test("scope read rechecks Source membership after awaited native reads", async () => {
  const f = fixture(), plan = await f.start([f.assets.chart]), base = f.context.fetchImpl;
  const before = f.writes.recordWrites;
  f.context.fetchImpl = async (url, options) => {
    const response = await base(url, options), input = options.body && JSON.parse(options.body);
    if (input?.variables?.input?.resourceSpec?.resourceUrn === f.assets.chart) f.policy.semanticCatalogAssets = [];
    return response;
  };
  await assert.rejects(f.readScope(plan), /semantic_maintenance_scope_changed/);
  assert.equal(f.writes.recordWrites, before); assert.equal(f.writes.targetWrites, 0);
});

test("scope accounting cannot trust a relabelled native child or a substituted evidence anchor", async () => {
  for (const change of ["definition", "asset"]) {
    const f = fixture(), plan = await f.start([datasetUrn, f.assets.chart]);
    await newDefinition(f, plan, "term");
    const current = await f.read(plan), root = f.journal.get(`${plan.maintenanceRunUrn}/ekopAgentRun`).at(-1);
    const decision = root.value.decisions[0], marker = "semantic-maintenance-item/1:";
    const link = JSON.parse(decision.question.slice(marker.length));
    if (change === "definition") link.definition = false;
    else link.asset = createHash("sha256").update(JSON.stringify(f.assets.chart)).digest("hex").slice(0, 24);
    decision.question = marker + JSON.stringify(link);
    const before = f.writes.recordWrites;
    await assert.rejects(f.readScope(current), /semantic_maintenance_binding_mismatch/);
    await assert.rejects(f.seal(plan), /semantic_maintenance_binding_mismatch/);
    assert.equal(f.writes.recordWrites, before); assert.equal(f.writes.targetWrites, 0);
  }
});

test("malformed maintenance fields are a confirmed no-effect rejection, not an unknown preparation", async () => {
  const f = fixture();
  f.writes.pending = { action: "start_maintenance", contract: "catalog/1", sourceUrn,
    requestId: randomUUID(), sessionId: f.sessionId };
  await assert.rejects(f.call({ ...f.writes.pending, uiRequestId: "fixture-ui" }), (error) => {
    assert.equal(error.message, "invalid_semantic_maintenance_request");
    assert.equal(error.reconciliation, undefined);
    return true;
  });
  assert.equal(f.writes.recordWrites, 0);
  assert.equal(f.writes.targetWrites, 0);
  assert.equal(f.journal.size, 0);
  const draft = await f.start();
  assert.equal(draft.state, "DRAFT");
  const uncertain = fixture();
  uncertain.writes.recordLossAt = 1;
  await assert.rejects(uncertain.start(), (error) => {
    assert.equal(error.message, "task_write_unconfirmed");
    assert.equal(error.reconciliation.retryAllowed, false);
    return true;
  });
  assert.equal(uncertain.writes.recordWrites, 1);
  assert.equal(uncertain.writes.targetWrites, 0);
});

test("foreground admission rechecks original session, grants and scope without native effects or consent", async () => {
  const f = fixture(), plan = await f.start();
  async function resume(sessionId = f.sessionId) {
    f.writes.pending = { action: "continue_maintenance", maintenanceRunUrn: plan.maintenanceRunUrn,
      requestId: randomUUID(), sessionId };
    return f.call({ ...f.writes.pending, uiRequestId: "fixture-ui" });
  }
  const writes = f.writes.recordWrites;
  const admitted = await resume();
  assert.equal(admitted.foregroundPreparation, true);
  assert.equal(admitted.accountedAssetCount, 0);
  assert.equal(admitted.assetCount, 1);
  assert.equal(f.writes.recordWrites, writes);
  assert.equal(f.writes.targetWrites, 0);
  await assert.rejects(resume(randomUUID()), /semantic_native_request_mismatch|semantic_maintenance_binding_mismatch/);
  f.policy.semanticPublicationApproved = false;
  await assert.rejects(resume(), /semantic_publication_not_authorized/);
  f.policy.semanticPublicationApproved = true;
  // Selected Dataset is normally included through the legacy Source scope.
  const scopeBefore = f.policy.taskDatasets;
  f.policy.taskDatasets = [];
  await assert.rejects(resume(), /semantic_maintenance_scope_changed/);
  f.policy.taskDatasets = scopeBefore;
  await f.stage(plan, await f.request([{ kind: "description", operation: "set", value: "Scoped fixture meaning", ...catalogEvidence }]));
  const ready = await f.seal(plan);
  assert.equal(ready.accountedAssetCount, 1);
  const sealedWrites = f.writes.recordWrites;
  assert.equal((await resume()).foregroundPreparation, false);
  assert.equal(f.writes.recordWrites, sealedWrites);
  assert.equal(f.writes.targetWrites, 0);
  assert.equal((await f.read(plan)).state, "READY");
});

test("draft revision merges a complete Aspect, preserves original history and only the final proposal can publish", async () => {
  const f = fixture(), plan = await f.start();
  const first = await f.stage(plan, await f.request([{ kind: "description", fieldPath: "order_id", operation: "set", value: "First field proposal", ...catalogEvidence }]));
  const original = first.items[0];
  const old = structuredClone(f.journal.get(`${original.reviewRef.runUrn}/ekopAgentRun`));
  const replacement = await f.request([
    { kind: "description", fieldPath: "order_id", operation: "set", value: "Complete revised identity proposal", ...catalogEvidence },
    { kind: "description", fieldPath: "[version=2.0].[type=struct].net.amount", operation: "set", value: "Complete amount proposal", ...catalogEvidence },
  ]);
  await assert.rejects(f.stage(plan, replacement), error =>
    error.inputRejection?.issue === "semantic_maintenance_aspect_overlap" && error.inputRejection.nativeWriteStarted === false);
  const revised = await f.revise(first, original, replacement);
  assert.equal(revised.state, "DRAFT"); assert.equal(revised.totalItems, 1); assert.equal(revised.totalRecordedItems, 2);
  assert.equal(revised.revisedItemId, original.id); assert.equal(revised.items[0].supersedes.id, original.id);
  assert.deepEqual(f.journal.get(`${original.reviewRef.runUrn}/ekopAgentRun`), old);
  assert.equal(f.writes.targetWrites, 0);
  const ready = await f.seal(plan); await f.approve(ready);
  await assert.rejects(f.publish(ready, original.id), /semantic_maintenance_consent_required/);
  assert.equal((await f.publish(ready, revised.preparedItemId)).status, "VERIFIED_CURRENT_VALUES");
  const fields = f.state.dataset.editableSchemaMetadata.value.editableSchemaFieldInfo;
  assert.equal(fields.find((field) => field.fieldPath === "order_id").description, "Complete revised identity proposal");
  assert.equal(fields.find((field) => field.fieldPath === "[version=2.0].[type=struct].net.amount").description, "Complete amount proposal");
});

test("asset maintenance view aligns GAP and whole existing proposal for explicit revision without replacing native authority", async () => {
  const f = fixture(), plan = await f.start();
  const empty = await f.call({ action: "read_maintenance", maintenanceRunUrn: plan.maintenanceRunUrn,
    assetUrn: datasetUrn, version: plan.runVersion });
  assert.deepEqual(empty.items, []); assert.equal(empty.assetView.itemCount, 0); assert.equal(empty.nextOffset, null);
  await assert.rejects(f.call({ action: "read_maintenance", maintenanceRunUrn: plan.maintenanceRunUrn, assetUrn: datasetUrn }), /semantic_maintenance_plan_changed/);
  const term = await newDefinition(f, plan, "term"), inspection = await f.inspect();
  await f.stage(plan, { contract: "catalog/1", sourceUrn, assetUrn: datasetUrn, snapshotDigest: inspection.snapshotDigest,
    gap: { code: "INSUFFICIENT_EVIDENCE", reason: "Earlier generic judgment" } });
  const originalRequest = await f.request([
    { kind: "description", operation: "set", value: "Initial evidenced meaning", ...catalogEvidence },
    { kind: "term", operation: "add", value: term.urn, ...catalogEvidence },
  ]);
  const staged = await f.stage(plan, originalRequest), before = f.writes.recordWrites;
  const scoped = offset => f.call({ action: "read_maintenance", maintenanceRunUrn: plan.maintenanceRunUrn,
    assetUrn: datasetUrn, version: staged.runVersion, offset });
  const first = await scoped(0), second = await scoped(first.nextOffset);
  assert.equal(first.assetView.itemCount, 2, "definition evidence anchors are not asset applications");
  assert.equal(first.items[0].status, "GAP"); assert.equal(second.items[0].status, "PENDING");
  assert.equal(first.nextOffset, 1); assert.equal(second.nextOffset, null);
  assert.deepEqual(second.items[0].preparedRequest.candidates, originalRequest.candidates);
  assert.equal(second.items[0].planDigest, staged.items.find(i => i.status === "PENDING" && !i.definition).planDigest);
  assert.equal(f.writes.recordWrites, before); assert.equal(f.writes.targetWrites, 0);
  f.state.denied.add(datasetUrn);
  await assert.rejects(scoped(0), /not_visible|denied|forbidden/);
  f.state.denied.delete(datasetUrn);
  assert.equal(f.writes.recordWrites, before);
  const replacement = await f.request(second.items[0].preparedRequest.candidates.map(c => c.kind === "description" ? { ...c, value: "Revised whole subject meaning" } : c));
  await assert.rejects(f.stage(plan, replacement), error =>
    error.inputRejection?.issue === "semantic_maintenance_aspect_overlap" && error.inputRejection.nativeWriteStarted === false);
  const revised = await f.revise(second, second.items[0], replacement);
  assert.equal(revised.totalItems, staged.totalItems); assert.equal(revised.totalRecordedItems, staged.totalRecordedItems + 1);
  const accounted = await f.readScope(revised);
  assert.equal(accounted.assets[0].activeItemCount, 2, "active GAP and application count; definition and superseded proposal do not");
  assert.equal(accounted.accountedAssetCount, 1); assert.equal(accounted.unpreparedAssetCount, 0);
  await assert.rejects(scoped(0), /semantic_maintenance_plan_changed/, "old scoped page proof must not span a revision");
  const fresh = await f.call({ action: "read_maintenance", maintenanceRunUrn: plan.maintenanceRunUrn,
    assetUrn: datasetUrn, version: revised.runVersion, offset: 1 });
  assert.equal(fresh.items[0].id, revised.preparedItemId); assert.equal(fresh.items[0].preparedRequest.candidates.length, 2, "existing Term retained, not silently omitted");
  assert.equal(fresh.items[0].supersedes.id, second.items[0].id);
  await assert.rejects(f.call({ action: "read_maintenance", maintenanceRunUrn: plan.maintenanceRunUrn,
    assetUrn: datasetUrn + "-outside", version: revised.runVersion }), /semantic_maintenance_scope_changed/);
  const ready = await f.seal(plan); await f.approve(ready);
  for (const i of orderMaintenanceItems(ready.items, new Set(ready.items.map(i => i.id)))) await f.publish(ready, i.id);
  assert.equal(f.state.dataset.editableDatasetProperties.value.description, "Revised whole subject meaning");
});

test("a generic draft GAP becomes an evidenced application without deleting its observation or claiming an old effect", async () => {
  const f = fixture(), plan = await f.start();
  const inspect = await f.inspect();
  const gap = await f.stage(plan, { contract: "catalog/1", sourceUrn, assetUrn: datasetUrn, snapshotDigest: inspect.snapshotDigest,
    gap: { code: "INSUFFICIENT_EVIDENCE", reason: "Earlier incomplete inspection judgment" } });
  const original = gap.items[0], before = structuredClone([...f.journal.values()]);
  const revised = await f.revise(gap, original, await f.request([{ kind: "description", operation: "set", value: "Evidence-backed replacement proposal", ...catalogEvidence }]));
  assert.equal(revised.totalItems, 1); assert.equal(revised.items[0].status, "PENDING");
  assert.equal([...f.journal.values()].filter((versions) => versions.some((row) => row.value.decisions?.some((d) => d.response?.text === "EXPLICIT_GAP"))).length, 1);
  assert.ok(before.length < f.journal.size); assert.equal(f.writes.targetWrites, 0);
  const ready = await f.seal(plan); await f.approve(ready);
  assert.equal((await f.publish(ready, revised.preparedItemId)).status, "VERIFIED_CURRENT_VALUES");
});

test("definition draft refinement marks old consumers stale until the Agent revises their exact whole item", async () => {
  const f = fixture(), plan = await f.start(), term = await newDefinition(f, plan, "term");
  const application = await f.request([{ kind: "term", operation: "add", value: term.urn, ...catalogEvidence }]);
  const consumer = await f.stage(plan, application);
  const item = consumer.items.find((entry) => entry.id === term.item.id);
  const replacement = await f.definitionRequest({ kind: "term", operation: "create", name: "Fixture maintenance term",
    description: "Refined evidenced subject meaning, not a new identity" });
  const revised = await f.revise(consumer, item, replacement);
  const stale = revised.items.find((entry) => entry.id === application.requestId);
  assert.equal(stale.requiresRevision, true); assert.deepEqual(stale.staleDependencies, [item.id]);
  assert.equal(revised.items.find((entry) => entry.id === revised.preparedItemId).definition.urn, term.urn);
  const assessment = await f.readScope(revised);
  assert.equal(assessment.unpreparedAssetCount, 0);
  assert.equal(assessment.sealing.structurallyReady, false);
  assert.equal(assessment.sealing.staleDependencyItemCount, 1);
  assert.deepEqual(assessment.sealing.checks.filter(c => !c.met).map(c => c.condition), ["ACTIVE_DEPENDENCIES"]);
  await assert.rejects(f.seal(plan), /semantic_maintenance_dependency_changed/);
  const updated = await f.revise(revised, stale, await f.request([{ kind: "term", operation: "add", value: term.urn, ...catalogEvidence }]));
  assert.equal(updated.items.find((entry) => entry.id === updated.preparedItemId).requiresRevision, false);
  assert.equal((await f.readScope(updated)).sealing.structurallyReady, true);
  const ready = await f.seal(plan); await f.approve(ready);
  for (const entry of orderMaintenanceItems(ready.items, new Set(ready.items.map((i) => i.id))))
    assert.equal((await f.publish(ready, entry.id)).status, "VERIFIED_CURRENT_VALUES");
});

test("revision rejects stale proofs, field substitution, revocation, sealed plans and attempted children without writes", async () => {
  const f = fixture(), plan = await f.start();
  const staged = await f.stage(plan, await f.request([{ kind: "description", operation: "set", value: "Initial proposal", ...catalogEvidence }]));
  const item = staged.items[0], replacement = await f.request([{ kind: "description", operation: "set", value: "Revised proposal", ...catalogEvidence }]);
  const before = f.writes.recordWrites;
  await assert.rejects(f.revise(staged, item, replacement, { version: "999" }), /semantic_maintenance_plan_changed/);
  await assert.rejects(f.revise(staged, item, replacement, { planDigest: "a".repeat(64) }), /semantic_maintenance_revision_binding_mismatch/);
  await assert.rejects(f.revise(staged, item, replacement, { childVersion: "999" }), /semantic_maintenance_item_attempted/);
  await assert.rejects(f.revise(staged, item, replacement, { fieldPath: "order_id" }), /semantic_maintenance_revision_binding_mismatch/);
  f.policy.semanticPublicationApproved = false;
  await assert.rejects(f.revise(staged, item, replacement), /semantic_publication_not_authorized/);
  f.policy.semanticPublicationApproved = true;
  const child = f.journal.get(`${item.reviewRef.runUrn}/ekopAgentRun`).at(-1);
  child.value.closedAt = f.writes.now;
  await assert.rejects(f.revise(staged, item, replacement), /semantic_maintenance_item_attempted/);
  delete child.value.closedAt;
  assert.equal(f.writes.recordWrites, before); assert.equal(f.writes.targetWrites, 0);
  await f.seal(plan);
  await assert.rejects(f.revise(staged, item, replacement), /semantic_maintenance_plan_sealed/);
});

test("interrupted revision links recover the SAME replacement child, including observations, without replay", async () => {
  for (const observation of [false, true]) for (const loseAfter of observation ? [3, 4] : [2, 3]) {
    const f = fixture(), plan = await f.start();
    const first = await f.stage(plan, await f.request([{ kind: "description", operation: "set", value: "First proposed subject", ...catalogEvidence }]));
    const original = first.items[0], old = structuredClone(f.journal.get(`${original.reviewRef.runUrn}/ekopAgentRun`));
    const request = observation ? { contract: "catalog/1", sourceUrn, assetUrn: datasetUrn,
      snapshotDigest: (await f.inspect()).snapshotDigest, requestId: randomUUID(),
      gap: { code: "AMBIGUOUS_MEANING", reason: "Agent withdrew earlier proposal after whole-scheme review" } }
      : await f.request([{ kind: "description", operation: "set", value: "Complete revised subject", ...catalogEvidence }]);
    f.writes.recordLossAt = f.writes.recordWrites + loseAfter;
    await assert.rejects(f.revise(first, original, request), /task_write_unconfirmed/);
    f.writes.recordLossAt = 0;
    const runUrn = `urn:li:dataProcessInstance:semantic-${f.context.actor.key}-${request.requestId}`;
    const row = structuredClone(f.journal.get(`${runUrn}/ekopAgentRun`).at(-1));
    const digest = row.value.decisions[0].publicationReview?.planDigest ?? createHash("sha256").update(
      row.value.decisions[0].question.slice(row.value.decisions[0].question.indexOf(":") + 1)).digest("hex");
    const root = f.journal.get(`${plan.maintenanceRunUrn}/ekopAgentRun`).at(-1);
    f.writes.pending = { action: "recover_maintenance", requestId: randomUUID(), sessionId: f.sessionId,
      maintenanceRunUrn: plan.maintenanceRunUrn, itemId: request.requestId, version: root.systemMetadata.version,
      childVersion: row.systemMetadata.version, planDigest: digest };
    const recovered = await f.call({ ...f.writes.pending, uiRequestId: "fixture-ui" });
    assert.equal(recovered.totalItems, 1); assert.equal(recovered.items[0].supersedes.id, original.id);
    assert.equal(recovered.items[0].status, observation ? "GAP" : "PENDING");
    assert.deepEqual(f.journal.get(`${runUrn}/ekopAgentRun`).at(-1), row);
    assert.deepEqual(f.journal.get(`${original.reviewRef.runUrn}/ekopAgentRun`), old);
    assert.equal(f.writes.targetWrites, 0);
  }
});

async function interruptedReview(f, plan, loseAfter = 2) {
  const proposal = await f.definitionRequest({ kind: "term", operation: "create", name: "Partial Store fixture",
    description: "Source-described fixture Store; synthetic only" });
  f.writes.recordLossAt = f.writes.recordWrites + loseAfter;
  await assert.rejects(f.stage(plan, proposal), /task_write_unconfirmed/);
  f.writes.recordLossAt = 0;
  const runUrn = `urn:li:dataProcessInstance:semantic-${f.context.actor.key}-${proposal.requestId}`;
  const child = f.journal.get(`${runUrn}/ekopAgentRun`).at(-1);
  return { id: proposal.requestId, runUrn, child: structuredClone(child) };
}
async function recoverReview(f, plan, partial, extra = {}) {
  const root = f.journal.get(`${plan.maintenanceRunUrn}/ekopAgentRun`).at(-1);
  f.writes.pending = { action: "recover_maintenance", requestId: randomUUID(), sessionId: f.sessionId,
    maintenanceRunUrn: plan.maintenanceRunUrn, itemId: partial.id, version: root.systemMetadata.version,
    childVersion: partial.child.systemMetadata.version, planDigest: partial.child.value.decisions[0].publicationReview.planDigest, ...extra };
  return f.call({ ...f.writes.pending, uiRequestId: "fixture-ui" });
}

test("a saved unlinked review is recovered once into its original plan without preparation, child rewrite or consent", async () => {
  const f = fixture(), plan = await f.start(), partial = await interruptedReview(f, plan);
  assert.equal((await f.read(plan)).totalItems, 0);
  const keys = [...f.journal.keys()], before = f.writes.recordWrites;
  const recovered = await recoverReview(f, plan, partial);
  assert.equal(recovered.state, "DRAFT"); assert.equal(recovered.selection, null);
  assert.equal(recovered.recoveredItemId, partial.id); assert.equal(recovered.items[0].status, "PENDING");
  assert.equal(f.writes.recordWrites, before + 2); assert.deepEqual([...f.journal.keys()], keys);
  assert.deepEqual(f.journal.get(`${partial.runUrn}/ekopAgentRun`).at(-1), partial.child);
  const once = f.writes.recordWrites;
  await recoverReview(f, plan, partial); assert.equal(f.writes.recordWrites, once);
  assert.equal(f.writes.targetWrites, 0);
  // The recovered definition can now support the original dependency-ordered
  // whole-plan journey. It is never independently approved or published.
  const termUrn = recovered.items[0].definition.urn;
  await f.stage(plan, await f.request([{ kind: "term", operation: "add", value: termUrn, ...catalogEvidence }]));
  const ready = await f.seal(plan);
  await assert.rejects(f.publish(ready, partial.id), /semantic_maintenance_consent_required/);
  await assert.rejects(recoverReview(f, plan, partial), /semantic_maintenance_plan_sealed/);
  await f.approve(ready);
  for (const item of ready.items) assert.equal((await f.publish(ready, item.id)).status, "VERIFIED_CURRENT_VALUES");
  assert.equal(f.state.dataset.glossaryTerms.value.terms.some((entry) => entry.urn === termUrn), true);
});

test("an interrupted root-link append is reconciled using its exact original question, not a duplicate child", async () => {
  const f = fixture(), plan = await f.start(), partial = await interruptedReview(f, plan, 3);
  await assert.rejects(f.read(plan), /semantic_maintenance_record_invalid/);
  const before = f.writes.recordWrites;
  const recovered = await recoverReview(f, plan, partial);
  assert.equal(recovered.totalItems, 1); assert.equal(recovered.items[0].status, "PENDING");
  assert.equal(f.writes.recordWrites, before + 1); assert.equal(f.writes.targetWrites, 0);
  assert.deepEqual(f.journal.get(`${partial.runUrn}/ekopAgentRun`).at(-1), partial.child);
});

test("recovery rejects changed tuples, foreign plans, session changes, revocation and current evidence drift", async () => {
  const f = fixture(), plan = await f.start(), partial = await interruptedReview(f, plan);
  const before = f.writes.recordWrites;
  await assert.rejects(recoverReview(f, plan, partial, { version: "999" }), /semantic_maintenance_plan_changed/);
  await assert.rejects(recoverReview(f, plan, partial, { childVersion: "999" }), /semantic_maintenance_preparation_incomplete/);
  await assert.rejects(recoverReview(f, plan, partial, { planDigest: "a".repeat(64) }), /semantic_maintenance_binding_mismatch/);
  await assert.rejects(recoverReview(f, plan, partial, { sessionId: randomUUID() }), /semantic_maintenance_plan_sealed/);
  f.policy.semanticPublicationApproved = false;
  await assert.rejects(recoverReview(f, plan, partial), /semantic_publication_not_authorized/);
  f.policy.semanticPublicationApproved = true;
  const scope = f.policy.taskDatasets; f.policy.taskDatasets = [];
  await assert.rejects(recoverReview(f, plan, partial), /semantic_maintenance_scope_changed/);
  f.policy.taskDatasets = scope;
  f.state.denied.add(datasetUrn);
  await assert.rejects(recoverReview(f, plan, partial), /semantic_read_forbidden/);
  f.state.denied.delete(datasetUrn);
  f.state.dataset.schemaMetadata.systemMetadata.version = "2";
  await assert.rejects(recoverReview(f, plan, partial), /semantic_snapshot_conflict|semantic_review_stale/);
  assert.equal(f.writes.recordWrites, before); assert.equal(f.writes.targetWrites, 0);
  const foreign = await f.start();
  await assert.rejects(recoverReview(f, foreign, partial), /semantic_maintenance_binding_mismatch/);
  assert.equal((await f.read(foreign)).totalItems, 0);
});

test("recovery cannot invent a missing child or bind a changed, closed or attempted review", async () => {
  const f = fixture(), plan = await f.start(), partial = await interruptedReview(f, plan);
  const key = `${partial.runUrn}/ekopAgentRun`, row = f.journal.get(key).at(-1);
  const before = f.writes.recordWrites;
  await assert.rejects(recoverReview(f, plan, { ...partial, id: randomUUID() }), /task_record_not_found/);
  row.value.closedAt = f.writes.now;
  await assert.rejects(recoverReview(f, plan, partial), /semantic_maintenance_item_attempted/);
  delete row.value.closedAt;
  row.value.decisions[0].publicationReview.changes[0].valueJson = '{}';
  await assert.rejects(recoverReview(f, plan, partial), /semantic_change_outside_intent|publication_review_digest_mismatch/);
  row.value = structuredClone(partial.child.value);
  row.value.decisions[0].publicationAttempt = { attemptId: randomUUID() };
  await assert.rejects(recoverReview(f, plan, partial), /invalid_publication_attempt|semantic_maintenance_item_attempted/);
  assert.equal(f.writes.recordWrites, before); assert.equal(f.writes.targetWrites, 0);
});

async function newDefinition(f, plan, kind, extra = {}) {
  const proposal = await f.definitionRequest({ kind, operation: "create", name: `Fixture maintenance ${kind}`,
    description: `Synthetic ${kind} classification, confirmed by the test human`, ...extra });
  const staged = await f.stage(plan, proposal);
  const item = staged.items.find((entry) => entry.id === proposal.requestId);
  return { item, urn: item.definition.urn, staged };
}

test("explicit native item references resolve hierarchy/mixed associations/property values under one exact Root and consent", async () => {
  const f = fixture(); let plan = await f.start(); const defs = {};
  const ref = d => ({ definitionItemId: d.item.id });
  for (const kind of ["domain", "node", "term", "tag", "property"]) {
    const definition = { kind, operation: "create", name: `Item reference ${kind}`, description: `Source-supported fixture ${kind}`,
      ...(kind === "term" ? { parentUrn: ref(defs.node) } : {}),
      ...(kind === "property" ? { valueType: "string", cardinality: "SINGLE", entityTypes: ["dataset", "schemaField"] } : {}) };
    const proposal = await f.definitionRequest(definition);
    if (kind === "term") proposal.version = plan.runVersion;
    plan = await f.stage(plan, proposal); const item = plan.items.find(i => i.id === proposal.requestId);
    defs[kind] = { item, urn: item.definition.urn }; assert.deepEqual(item.definition.reference, ref(defs[kind]));
  }
  const proposal = await f.request([
    { kind: "domain", operation: "set", values: ["urn:li:domain:Sales", ref(defs.domain)], ...catalogEvidence },
    { kind: "term", operation: "set", values: ["urn:li:glossaryTerm:Order", ref(defs.term)], ...catalogEvidence },
    { kind: "tag", operation: "add", value: ref(defs.tag), ...catalogEvidence },
    { kind: "property", operation: "set", value: ref(defs.property), values: ["catalog"], ...catalogEvidence },
  ]);
  proposal.version = plan.runVersion; plan = await f.stage(plan, proposal);
  const item = plan.items.find(i => i.id === proposal.requestId);
  assert(defs.domain.item.id && item.dependencies.includes(defs.domain.item.id));
  const scoped = await f.call({ action: "read_maintenance", maintenanceRunUrn: plan.maintenanceRunUrn, assetUrn: datasetUrn, version: plan.runVersion });
  assert.deepEqual(scoped.items[0].preparedRequest.candidates[0].values, ["urn:li:domain:Sales", defs.domain.urn]);
  assert.equal(scoped.items[0].preparedRequest.candidates[3].value, defs.property.urn);
  assert.deepEqual(scoped.items[0].preparedRequest.candidates[3].values, ["catalog"]);
  const field = await f.request([{ kind: "property", operation: "set", fieldPath: "order_id", value: ref(defs.property), values: ["identity"], ...catalogEvidence }], datasetUrn, { fieldPath: "order_id" });
  field.version = plan.runVersion; plan = await f.stage(plan, field);
  const ready = await f.seal(plan); assert.equal(f.writes.targetWrites, 0);
  await assert.rejects(f.publish(ready, item.id), /semantic_maintenance_consent_required/);
  await f.approve(ready); for (const i of ready.items) assert.equal((await f.publish(ready, i.id)).status, "VERIFIED_CURRENT_VALUES");
  assert.equal(f.state.definitions[defs.term.urn].glossaryTermInfo.value.parentNode, defs.node.urn);
  assert(f.state.dataset.domains.value.domains.includes(defs.domain.urn));
  assert(f.state.dataset.domains.value.domains.includes("urn:li:domain:Sales"));
  assert(f.state.dataset.glossaryTerms.value.terms.some(t => t.urn === defs.term.urn));
  assert(f.state.dataset.glossaryTerms.value.terms.some(t => t.urn === "urn:li:glossaryTerm:Order"));
});

test("item references cannot guess, follow supersession, select foreign/observation/wrong-kind items or bypass Root versions", async () => {
  const f = fixture(), root = await f.start(), d = await newDefinition(f, root, "domain"), tag = await newDefinition(f, root, "tag");
  const observed = await f.inspect(), observationId = randomUUID();
  let plan = await f.stage(tag.staged, { contract: "catalog/1", sourceUrn, assetUrn: datasetUrn, snapshotDigest: observed.snapshotDigest,
    requestId: observationId, gap: { code: "INSUFFICIENT_EVIDENCE", reason: "Fixture observation, not a definition" } });
  const before = f.writes.recordWrites;
  const request = async (reference, version = plan.runVersion) => ({ ...await f.request([
    { kind: "domain", operation: "add", value: reference, ...catalogEvidence },
  ]), ...(version === undefined ? {} : { version }) });
  await assert.rejects(f.stage(plan, await request({ definitionItemId: d.item.id }, "999")), /semantic_maintenance_plan_changed/);
  const missing = await request({ definitionItemId: d.item.id }); delete missing.version;
  const inputRejected = issue => error => error instanceof MaintenanceInputRejection && error.inputRejection.issue === issue;
  await assert.rejects(f.stage(plan, missing), inputRejected("semantic_maintenance_reference_version_required"));
  for (const reference of [{ definitionItemId: randomUUID() }, { definitionItemId: observationId }])
    await assert.rejects(f.stage(plan, await request(reference)), inputRejected("semantic_maintenance_definition_reference_not_active"));
  await assert.rejects(f.stage(plan, await request({ definitionItemId: tag.item.id })), inputRejected("semantic_maintenance_definition_reference_kind_mismatch"));
  for (const reference of [{ definitionItemId: d.item.id, urn: d.urn }, { definitionItemId: "name is not an ID" }])
    await assert.rejects(f.stage(plan, await request(reference)), inputRejected("semantic_maintenance_definition_reference_shape"));
  assert.equal(f.writes.recordWrites, before);
  await assert.rejects(f.stage(plan, await request(d.urn.slice(0, -2))), inputRejected("semantic_reference_not_found"));
  assert.equal(f.writes.recordWrites, before, "a malformed direct URI stays rejected, without writing or cancelling all preparation");
  f.state.denied.add(d.urn);
  await assert.rejects(f.stage(plan, await request({ definitionItemId: d.item.id })), /semantic_read_forbidden/);
  f.state.denied.delete(d.urn);
  f.policy.semanticPublicationApproved = false;
  await assert.rejects(f.stage(plan, await request({ definitionItemId: d.item.id })), /semantic_publication_not_authorized/);
  f.policy.semanticPublicationApproved = true;
  const scopedRequest = await request({ definitionItemId: d.item.id }), scope = f.policy.taskDatasets;
  f.policy.taskDatasets = [];
  await assert.rejects(f.stage(plan, scopedRequest), /semantic_maintenance_scope_changed/);
  f.policy.taskDatasets = scope;
  const other = await f.start();
  await assert.rejects(f.stage(other, await request({ definitionItemId: d.item.id }, other.runVersion)), inputRejected("semantic_maintenance_definition_reference_not_active"));
  const replacement = await f.definitionRequest({ kind: "domain", operation: "create", name: "Fixture maintenance domain", description: "Explicit current refinement" });
  plan = await f.revise(plan, d.item, replacement);
  await assert.rejects(f.stage(plan, await request({ definitionItemId: d.item.id })), inputRejected("semantic_maintenance_definition_reference_not_active"));
  const revised = plan.items.find(i => i.supersedes?.id === d.item.id);
  const observation = plan.items.find(i => i.id === observationId);
  const correct = await f.revise(plan, observation, await request({ definitionItemId: revised.id }));
  assert.equal(correct.revisedItemId, observationId);
  assert(correct.items.some(i => i.id === correct.preparedItemId && i.dependencies?.includes(revised.id)));
  assert.equal(f.writes.targetWrites, 0);
});

test("an active referenced child changed while compiling blocks before any new native child", async () => {
  const f = fixture(), root = await f.start(), d = await newDefinition(f, root, "domain");
  const proposal = await f.request([{ kind: "domain", operation: "add", value: { definitionItemId: d.item.id }, ...catalogEvidence }]);
  proposal.version = d.staged.runVersion; const before = f.writes.recordWrites, underlying = f.context.fetchImpl;
  let changed = false;
  f.context.fetchImpl = async (url, options) => {
    if (!changed && url.pathname === "/openapi/v3/entity/domain/batchGet" && JSON.parse(options.body)[0].urn === d.urn) {
      const row = f.journal.get(`${d.item.reviewRef.runUrn}/ekopAgentRun`).at(-1);
      row.systemMetadata.version = String(Number(row.systemMetadata.version) + 1); changed = true;
    }
    return underlying(url, options);
  };
  await assert.rejects(f.stage(d.staged, proposal), /semantic_maintenance_dependency_changed/);
  assert(changed); assert.equal(f.writes.recordWrites, before); assert.equal(f.writes.targetWrites, 0);
  assert(!f.journal.has(`urn:li:dataProcessInstance:semantic-${f.context.actor.key}-${proposal.requestId}/ekopAgentRun`));
});

test("one native plan confirmation creates five definition types, hierarchy and dataset/field values without AUTO policy", async () => {
  const f = fixture(), plan = await f.start();
  assert.equal(f.policy.semanticAutoManagement, undefined);
  const domain = await newDefinition(f, plan, "domain");
  const node = await newDefinition(f, plan, "node");
  const term = await newDefinition(f, plan, "term", { parentUrn: node.urn });
  const tag = await newDefinition(f, plan, "tag");
  const property = await newDefinition(f, plan, "property", { valueType: "string", cardinality: "SINGLE", entityTypes: ["dataset", "schemaField"] });
  const candidates = [
    { kind: "domain", operation: "add", value: domain.urn, ...catalogEvidence },
    { kind: "term", operation: "add", value: term.urn, ...catalogEvidence },
    { kind: "tag", operation: "add", value: tag.urn, ...catalogEvidence },
    { kind: "property", operation: "set", value: property.urn, values: ["catalog"], ...catalogEvidence },
    { kind: "term", operation: "add", fieldPath: "order_id", value: term.urn, ...catalogEvidence },
    { kind: "tag", operation: "add", fieldPath: "order_id", value: tag.urn, ...catalogEvidence },
  ];
  const asset = await f.stage(plan, await f.request(candidates));
  const fieldProperty = await f.stage(plan, await f.request([
    { kind: "property", operation: "set", fieldPath: "order_id", value: property.urn, values: ["identity"], ...catalogEvidence },
  ], datasetUrn, { fieldPath: "order_id" }));
  const ready = await f.seal(plan);
  assert.equal(ready.state, "READY"); assert.equal(ready.totalItems, 7);
  assert.equal(f.writes.targetWrites, 0);
  const parent = await loadMaintenancePlan({ maintenanceRunUrn: ready.maintenanceRunUrn }, (input) => f.call(input), new AbortController().signal);
  assert.equal(parent.items.length, 7);
  assert.equal(orderMaintenanceItems(parent.items, new Set(parent.items.map((item) => item.id)))[0].id, domain.item.id);
  await assert.rejects(f.publish(ready, domain.item.id), /semantic_maintenance_consent_required/);
  const confirmed = await f.approve(ready);
  assert.equal(confirmed.state, "CONFIRMED"); assert.equal(f.writes.targetWrites, 0);
  await assert.rejects(f.publish(ready, term.item.id), /semantic_maintenance_dependency_unverified/);
  for (const item of ready.items) {
    const outcome = await f.publish(ready, item.id);
    assert.equal(outcome.status, "VERIFIED_CURRENT_VALUES");
  }
  assert.equal(f.state.definitions[term.urn].glossaryTermInfo.value.parentNode, node.urn);
  assert.equal(f.state.dataset.domains.value.domains.includes(domain.urn), true);
  assert.equal(f.state.dataset.glossaryTerms.value.terms.some((entry) => entry.urn === term.urn), true);
  assert.equal(f.state.dataset.globalTags.value.tags.some((entry) => entry.tag === tag.urn), true);
  assert.equal(f.state.dataset.structuredProperties.value.properties.some((entry) => entry.propertyUrn === property.urn), true);
  assert.equal(f.state.dataset.editableSchemaMetadata.value.editableSchemaFieldInfo.find((entry) => entry.fieldPath === "order_id").glossaryTerms.terms[0].urn, term.urn);
  const current = await f.read(plan); assert(current.items.every((entry) => entry.status === "VERIFIED"));
  const targets = f.writes.targetWrites;
  await assert.rejects(f.publish(ready, domain.item.id), /publication_already_attempted/);
  assert.equal(f.writes.targetWrites, targets);
  assert(asset.preparedItemId && fieldProperty.preparedItemId);
});

test("excluding a planned parent cannot approve its dependent association", async () => {
  const f = fixture(), plan = await f.start(), tag = await newDefinition(f, plan, "tag");
  await f.stage(plan, await f.request([{ kind: "tag", operation: "add", value: tag.urn, ...catalogEvidence }]));
  const ready = await f.seal(plan);
  await assert.rejects(f.approve(ready, [1]), /semantic_maintenance_selection_dependency_missing/);
  assert.equal(f.writes.targetWrites, 0);
  assert.equal((await f.read(plan)).state, "READY");
});

test("a consumed UNKNOWN parent is not promoted by current same-value readback and cannot be replayed", async () => {
  const f = fixture(), plan = await f.start(), tag = await newDefinition(f, plan, "tag");
  await f.stage(plan, await f.request([{ kind: "tag", operation: "add", value: tag.urn, ...catalogEvidence }]));
  const ready = await f.seal(plan); await f.approve(ready);
  f.writes.lossAfter = 1;
  await assert.rejects(f.publish(ready, tag.item.id), /publication_write_unconfirmed/);
  assert(f.state.definitions[tag.urn].tagProperties);
  await assert.rejects(f.publish(ready, ready.items[1].id), /semantic_maintenance_dependency_unverified/);
  await assert.rejects(f.publish(ready, tag.item.id), /publication_already_attempted/);
  assert.equal(f.writes.targetWrites, 1);
  assert.equal((await f.read(plan)).items[0].status, "ATTEMPTED_UNVERIFIED");
  const subsequent = await f.start();
  await assert.rejects(f.stage(subsequent, await f.definitionRequest({ kind: "tag", operation: "update", urn: tag.urn, version: "1", description: "Cannot hide unresolved target behind a new plan" })),
    /semantic_maintenance_target_unresolved/);
});

test("Source revocation and human drift block effects without requiring a new policy system", async () => {
  const f = fixture(), plan = await f.start();
  await f.stage(plan, await f.request([{ kind: "description", operation: "set", value: "Confirmed new description", ...catalogEvidence }]));
  const ready = await f.seal(plan); await f.approve(ready);
  f.policy.semanticPublicationApproved = false;
  await assert.rejects(f.publish(ready, ready.items[0].id), /semantic_publication_not_authorized/);
  assert.equal((await f.read(plan)).readOnly, true);
  f.policy.semanticPublicationApproved = true;
  f.state.dataset.editableDatasetProperties = { value: { description: "Human changed this after confirmation" }, systemMetadata: { version: "1" } };
  await assert.rejects(f.publish(ready, ready.items[0].id), /publication_target_version_conflict|publication_source_not_verified/);
  assert.equal(f.writes.targetWrites, 0);
});

test("a subsequent unchanged round records KEEP without a target attempt", async () => {
  const f = fixture(), first = await f.start();
  const proposal = await f.request([{ kind: "tag", operation: "add", value: "urn:li:tag:Reviewed", ...catalogEvidence }]);
  await f.stage(first, proposal); const ready = await f.seal(first); await f.approve(ready); await f.publish(ready, ready.items[0].id);
  const before = f.writes.targetWrites, second = await f.start();
  await f.stage(second, await f.request([{ kind: "tag", operation: "add", value: "urn:li:tag:Reviewed", ...catalogEvidence }]));
  const keep = await f.seal(second); assert.equal(keep.items[0].status, "KEEP");
  await f.approve(keep); const result = await f.publish(keep, keep.items[0].id); assert.equal(result.outcome, "KEEP");
  assert.equal(f.writes.targetWrites, before);
});

test("genuinely changed fixture evidence produces a new precise round with prior-Agent comparison, not duplicate creation", async () => {
  const f = fixture(), first = await f.start();
  await f.stage(first, await f.request([{ kind: "tag", operation: "add", value: "urn:li:tag:Reviewed", ...catalogEvidence }]));
  const ready = await f.seal(first); await f.approve(ready); await f.publish(ready, ready.items[0].id);
  f.state.dataset.schemaMetadata.systemMetadata.version = "2";
  f.state.dataset.schemaMetadata.value.fields[0].description = "Genuine fixture revision: revised key evidence";
  assert.equal((await f.read(first)).items[0].status, "VERIFIED_CURRENT_CHANGED");
  const second = await f.start();
  await f.stage(second, await f.request([{ kind: "tag", operation: "remove", value: "urn:li:tag:Reviewed", ...catalogEvidence }]));
  const changed = await f.seal(second);
  const full = await loadMaintenancePlan({ maintenanceRunUrn: changed.maintenanceRunUrn }, (input) => f.call(input), new AbortController().signal);
  assert.equal(full.items[0].review.preview.changes[0].priorAgent.status, "VERIFIED_AGENT_BASELINE");
  assert.equal(full.items[0].review.preview.changes[0].priorAgent.schemaUnchanged, false);
  assert(full.items[0].review.preview.changes[0].before.includes("urn:li:tag:Reviewed"));
  assert(!full.items[0].review.preview.changes[0].after.includes("urn:li:tag:Reviewed"));
  await f.approve(changed); await f.publish(changed, changed.items[0].id);
  assert.equal(f.writes.targetWrites, 2);
  assert.equal(f.state.dataset.editableDatasetProperties.value.description, "Human maintained fixture definition");
  assert.equal(f.state.dataset.globalTags.value.tags.some((entry) => entry.tag === "urn:li:tag:Existing"), true);
});

test("one definition cannot seal an otherwise unaccounted scope; an explicit gap is not success or target publication", async () => {
  const f = fixture(), plan = await f.start();
  await newDefinition(f, plan, "tag");
  await assert.rejects(f.seal(plan), /semantic_maintenance_assets_unaccounted/);
  const inspected = await f.inspect();
  await f.stage(plan, { contract: "catalog/1", requestId: randomUUID(), sourceUrn, assetUrn: datasetUrn,
    snapshotDigest: inspected.snapshotDigest, gap: { code: "INSUFFICIENT_EVIDENCE", reason: "Fixture has no evidence for business classification" } });
  const ready = await f.seal(plan);
  assert.equal(ready.items[1].status, "GAP");
  await f.approve(ready);
  assert.equal((await f.publish(ready, ready.items[1].id)).outcome, "GAP");
  assert.equal(f.writes.targetWrites, 0);
});

test("a verified consent record with no attempt can continue without a second human confirmation", async () => {
  const f = fixture(), plan = await f.start();
  await f.stage(plan, await f.request([{ kind: "tag", operation: "add", value: "urn:li:tag:Reviewed", ...catalogEvidence }]));
  const ready = await f.seal(plan); await f.approve(ready);
  f.writes.recordLossAt = f.writes.recordWrites + 1;
  await assert.rejects(f.publish(ready, ready.items[0].id), /task_write_unconfirmed/);
  assert.equal(f.writes.targetWrites, 0);
  assert.equal((await f.read(plan)).items[0].status, "APPROVE");
  f.writes.recordLossAt = undefined;
  assert.equal((await f.publish(ready, ready.items[0].id)).status, "VERIFIED_CURRENT_VALUES");
  assert.equal(f.writes.targetWrites, 1);
});

test("intact project-created definition can update twice under one consent per round, with explicit unknown global impact", async () => {
  const f = fixture(), first = await f.start(), tag = await newDefinition(f, first, "tag");
  await f.stage(first, await f.request([{ kind: "tag", operation: "add", value: tag.urn, ...catalogEvidence }]));
  const ready = await f.seal(first); await f.approve(ready);
  for (const item of ready.items) await f.publish(ready, item.id);
  f.state.impactRows = [{ entity: { urn: datasetUrn }, type: "TaggedWith", direction: "INCOMING" }];
  for (const version of ["1", "2"]) {
    const round = await f.start();
    await f.stage(round, await f.definitionRequest({ kind: "tag", operation: "update", urn: tag.urn, version, description: `Revised fixture content ${version}` }));
    await f.stage(round, await f.request([{ kind: "tag", operation: "add", value: tag.urn, ...catalogEvidence }]));
    const sealed = await f.seal(round);
    const full = await loadMaintenancePlan({ maintenanceRunUrn: sealed.maintenanceRunUrn }, (input) => f.call(input), new AbortController().signal);
    assert.equal(full.items[0].review.preview.definition.impact.complete, false);
    assert.equal(full.items[0].review.preview.definition.impact.unknownGlobalImpact, true);
    assert.deepEqual(full.items[0].review.preview.definition.impact.references, [datasetUrn]);
    assert(full.items[0].review.preview.definition.ownedUpdate.creationRef);
    const writes = f.writes.targetWrites;
    await assert.rejects(f.publish(sealed, sealed.items[0].id), /semantic_maintenance_consent_required/);
    await f.approve(sealed); await f.publish(sealed, sealed.items[0].id);
    assert.equal(f.writes.targetWrites, writes + 1);
    assert.equal(f.state.definitions[tag.urn].tagProperties.value.description, `Revised fixture content ${version}`);
  }
});

test("all five owned definition kinds retain exact whole-plan consent on later content updates", async () => {
  const f = fixture(), first = await f.start(), definitions = [];
  const domain = await newDefinition(f, first, "domain"); definitions.push(["domain", domain]);
  const node = await newDefinition(f, first, "node"); definitions.push(["node", node]);
  const term = await newDefinition(f, first, "term", { parentUrn: node.urn }); definitions.push(["term", term]);
  const tag = await newDefinition(f, first, "tag"); definitions.push(["tag", tag]);
  const property = await newDefinition(f, first, "property", { valueType: "string", cardinality: "SINGLE", entityTypes: ["dataset", "schemaField"] }); definitions.push(["property", property]);
  await f.stage(first, await f.request([{ kind: "tag", operation: "add", value: tag.urn, ...catalogEvidence }]));
  const initial = await f.seal(first); await f.approve(initial); for (const item of initial.items) await f.publish(initial, item.id);
  const round = await f.start();
  for (const [kind, definition] of definitions)
    await f.stage(round, await f.definitionRequest({ kind, operation: "update", urn: definition.urn, version: "1", description: `Revised ${kind} definition` }));
  await f.stage(round, await f.request([{ kind: "tag", operation: "add", value: tag.urn, ...catalogEvidence }]));
  const ready = await f.seal(round); await f.approve(ready);
  for (const item of ready.items.slice(0, 5)) assert.equal((await f.publish(ready, item.id)).status, "VERIFIED_CURRENT_VALUES");
  assert.equal((await f.read(round)).items[5].status, "KEEP");
  assert.equal(f.writes.targetWrites, 11); // six initial writes, then five content-only updates.
});

test("owned definition updates reject observed outside references and human rewrites without blocking a new independent plan", async () => {
  const f = fixture(), first = await f.start(), tag = await newDefinition(f, first, "tag");
  await f.stage(first, await f.request([{ kind: "tag", operation: "add", value: tag.urn, ...catalogEvidence }]));
  const ready = await f.seal(first); await f.approve(ready); for (const item of ready.items) await f.publish(ready, item.id);
  const update = () => f.definitionRequest({ kind: "tag", operation: "update", urn: tag.urn, version: "1", description: "Blocked fixture update" });
  f.state.impactRows = [{ entity: { urn: datasetUrn.replace("orders,", "outside_scope,") }, type: "TaggedWith" }];
  await assert.rejects(f.stage(await f.start(), await update()), /semantic_maintenance_known_outside_reference/);
  f.state.impactRows = [];
  const pending = await f.start(); await f.stage(pending, await update());
  await f.stage(pending, await f.request([{ kind: "tag", operation: "add", value: tag.urn, ...catalogEvidence }]));
  const consented = await f.seal(pending); await f.approve(consented);
  const effects = f.writes.targetWrites;
  f.state.impactRows = [{ entity: { urn: datasetUrn.replace("orders,", "outside_scope,") }, type: "TaggedWith" }];
  await assert.rejects(f.publish(consented, consented.items[0].id), /semantic_maintenance_known_outside_reference/);
  assert.equal(f.writes.targetWrites, effects);
  f.state.impactRows = [];
  f.state.definitions[tag.urn].tagProperties.value.description = "Human changed this";
  await assert.rejects(f.stage(await f.start(), await update()), /semantic_maintenance_definition_current_changed/);
  const independent = await f.start(); await f.stage(independent, await f.request([{ kind: "tag", operation: "add", value: "urn:li:tag:Reviewed", ...catalogEvidence }]));
  const second = await f.seal(independent); await f.approve(second); await f.publish(second, second.items[0].id);
  assert.equal(f.state.definitions[tag.urn].tagProperties.value.description, "Human changed this");
});

test("91 Dataset/744 field fixture scope is one native Task and a paginated plan, not Task16 or exact-inventory64", async () => {
  const f = fixture(), assets = [datasetUrn];
  for (let index = 1; index < 91; index++) {
    const urn = datasetUrn.replace("orders,", `orders_${index},`), row = structuredClone(f.state.dataset);
    row.urn = urn; row.datasetKey.value.name = `Fixture.reporting.orders_${index}`;
    f.state.definitions[urn] = row; assets.push(urn);
  }
  // 90*8 + 24 = 744 synthetic fields; no real database or ingestion call.
  for (const [index, urn] of assets.entries()) {
    const row = index === 0 ? f.state.dataset : f.state.definitions[urn];
    row.schemaMetadata.value.fields = Array.from({ length: index === 0 ? 24 : 8 }, (_, field) => ({ fieldPath: `field_${field}`, nativeDataType: "int", description: `Fixture evidence ${field}` }));
  }
  f.policy.taskDatasets = assets; f.policy.semanticCatalogAssets = [];
  const base = f.context.fetchImpl;
  f.context.fetchImpl = async (url, options) => {
    if (url.pathname === "/openapi/v3/entity/dataset/batchGet") {
      const request = JSON.parse(options.body)[0], row = request.urn === datasetUrn ? f.state.dataset : f.state.definitions[request.urn];
      return Response.json([{ urn: request.urn, ...Object.fromEntries(Object.entries(row).filter(([key]) => Object.hasOwn(request, key))) }]);
    }
    return base(url, options);
  };
  const plan = await f.start(null);
  assert.equal(plan.assetCount, 91);
  const scopeWrites = f.writes.recordWrites, scopeAssets = [];
  let scopeOffset = 0;
  do {
    const page = await f.readScope(plan, "unprepared", scopeOffset);
    assert(page.assets.length <= 20); assert.equal(page.unpreparedAssetCount, assets.length);
    assert.equal(page.scopeDigest, createHash("sha256").update(JSON.stringify(assets)).digest("hex"));
    scopeAssets.push(...page.assets.map(a => a.assetUrn)); scopeOffset = page.nextOffset;
  } while (scopeOffset !== null);
  assert.deepEqual(scopeAssets, assets); assert.equal(f.writes.recordWrites, scopeWrites);
  await assert.rejects(f.readScope(plan, "unprepared", 20, { version: undefined }), /semantic_maintenance_plan_changed/);
  for (const urn of assets) await f.stage(plan, await f.request([{ kind: "tag", operation: "add", value: "urn:li:tag:Reviewed", ...catalogEvidence }], urn));
  const ready = await f.seal(plan); assert.equal(ready.totalItems, 91); assert.equal(ready.nextOffset, 20);
  await f.approve(ready);
  const refs = [];
  for (let offset = 0; offset < 91; offset += 20) {
    const page = await f.call({ action: "read_maintenance", maintenanceRunUrn: plan.maintenanceRunUrn, offset });
    refs.push(...page.items);
  }
  for (const item of refs) assert.equal((await f.publish(ready, item.id)).status, "VERIFIED_CURRENT_VALUES");
  assert.equal(f.writes.targetWrites, 91);
  const finalPage = await f.call({ action: "read_maintenance", maintenanceRunUrn: plan.maintenanceRunUrn, offset: 80 });
  assert.equal(finalPage.items.length, 11); assert.equal(finalPage.nextOffset, null);
  assert(finalPage.items.every((item) => item.status === "VERIFIED"));
  assert.equal([...f.journal.keys()].filter((key) => key.endsWith("/ekopAgentTask")).length, 1);
});

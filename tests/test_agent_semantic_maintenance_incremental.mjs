// Public Host/SDK/parent seams; only synthetic public DataHub API and no provider.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { semanticCatalogFixture, catalogEvidence } from "./fixtures/semantic-catalog-fixture.mjs";
import { sourceUrn, datasetUrn } from "./fixtures/semantic-fixture.mjs";
import { maintenanceSelection, MaintenanceInputRejection } from "../extensions/datahub-agent/integration/semantic-maintenance-plan.mjs";
import { loadMaintenancePlan } from "../extensions/datahub-agent/mfe/semantic-maintenance-review.js";

function fixture() {
  const f = semanticCatalogFixture();
  f.writes.recordHistoryLimits.ekopAgentTask = 2147483647;
  f.writes.recordHistoryLimits.ekopAgentRun = 2147483647;
  const write = input => {
    f.writes.pending = { ...input, requestId: randomUUID(), sessionId: f.sessionId };
    return f.call({ ...f.writes.pending, uiRequestId: "fixture-ui" });
  };
  const stage = async (plan, proposal, extra = {}) => {
    const { action: _action, ...body } = proposal;
    return write({ ...body, action: "prepare_maintenance", maintenanceRunUrn: plan.maintenanceRunUrn,
      responseMode: "incremental", version: plan.runVersion, ...extra });
  };
  return { ...f, write, stage };
}

test("successful prepare returns only its exact item and latest version, while full native plan remains readable", async () => {
  const f = fixture();
  const start = await f.write({ action: "start_maintenance", sourceUrn, assetUrns: [datasetUrn, f.assets.chart] });
  const first = await f.stage(start, await f.definitionRequest({ kind: "tag", operation: "create", name: "Evidence-backed synthetic tag", description: "Fixture source description" }));
  assert.equal(first.delivery, "incremental");
  assert.equal(first.delta.baseVersion, start.runVersion);
  assert.equal(first.delta.completePlan, false);
  assert.equal(first.delta.resyncRequired, false);
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].id, first.preparedItemId);
  assert.deepEqual(first.items[0].definition.reference, { definitionItemId: first.preparedItemId });
  const application = await f.stage(first, await f.request([{ kind: "tag", operation: "add", value: first.items[0].definition.reference, ...catalogEvidence }]));
  assert.equal(application.items.length, 1);
  assert.equal(application.items[0].id, application.preparedItemId);
  assert.deepEqual(application.items[0].dependencies, [first.preparedItemId]);
  assert.equal(application.totalItems, 2);
  assert.equal(application.accountedAssetCount, 1);
  assert.equal(application.unpreparedAssetCount, 1);
  assert.equal(application.delta.baseVersion, first.runVersion);
  const full = await f.call({ action: "read_maintenance", maintenanceRunUrn: start.maintenanceRunUrn });
  assert.equal(full.delivery, undefined);
  assert.equal(full.runVersion, application.runVersion);
  assert.deepEqual(full.items, [first.items[0], application.items[0]]);
  assert.equal(f.writes.targetWrites, 0);
  assert.equal(application.publicationAuthorized, false);
  assert(Buffer.byteLength(JSON.stringify(application)) < Buffer.byteLength(JSON.stringify(full)), "one delta is smaller than repeating both saved items");
  await assert.rejects(loadMaintenancePlan({ maintenanceRunUrn: start.maintenanceRunUrn }, async () => first, new AbortController().signal), /semantic_maintenance_read_unconfirmed/,
    "even a one-item delta cannot be treated as a complete parent manifest");
});

test("whole-item revision preserves history and requests resync when a definition replacement invalidates other consumers", async () => {
  const f = fixture();
  let plan = await f.write({ action: "start_maintenance", sourceUrn, assetUrns: [datasetUrn] });
  const tagProposal = await f.definitionRequest({ kind: "tag", operation: "create", name: "Synthetic revision tag", description: "Original synthetic evidence" });
  plan = await f.stage(plan, tagProposal);
  const original = plan.items[0];
  plan = await f.stage(plan, await f.request([{ kind: "tag", operation: "add", value: original.definition.reference, ...catalogEvidence }]));
  const journalBefore = structuredClone([...f.journal]);
  const { action: _action, ...body } = tagProposal;
  const revised = await f.write({ ...body, definition: { ...body.definition, description: "Changed synthetic evidence" },
    action: "revise_maintenance", responseMode: "incremental", maintenanceRunUrn: plan.maintenanceRunUrn,
    version: plan.runVersion, itemId: original.id, childVersion: original.childVersion, planDigest: original.planDigest });
  assert.equal(revised.delivery, "incremental");
  assert.equal(revised.items.length, 1); assert.equal(revised.items[0].id, revised.preparedItemId);
  assert.equal(revised.revisedItemId, original.id);
  assert.equal(revised.delta.resyncRequired, true);
  assert.equal(revised.delta.baseVersion, plan.runVersion);
  assert.equal(revised.totalItems, 2); assert.equal(revised.totalRecordedItems, 3);
  assert.equal(revised.items[0].supersedes.id, original.id);
  const full = await f.call({ action: "read_maintenance", maintenanceRunUrn: plan.maintenanceRunUrn });
  const consumer = full.items.find(item => !item.definition);
  assert.equal(consumer.requiresRevision, true); assert.deepEqual(consumer.staleDependencies, [original.id]);
  await assert.rejects(f.write({ action: "seal_maintenance", maintenanceRunUrn: plan.maintenanceRunUrn }), /semantic_maintenance_dependency_changed/);
  for (const [key, versions] of journalBefore) assert.deepEqual(f.journal.get(key).slice(0, versions.length), versions);
  assert.equal(f.writes.targetWrites, 0);
});

test("incremental transport retains current version, ACL and exact prewrite rejection; it never authorizes publication", async () => {
  const f = fixture();
  const start = await f.write({ action: "start_maintenance", sourceUrn, assetUrns: [datasetUrn] });
  const proposal = await f.request([{ kind: "description", operation: "set", value: "Synthetic full-item proposal", ...catalogEvidence }]);
  const first = await f.stage(start, proposal), records = f.writes.recordWrites;
  await assert.rejects(f.stage(start, proposal), /semantic_maintenance_plan_changed/);
  await assert.rejects(f.stage(first, proposal, { responseMode: "truncate" }), error => error instanceof MaintenanceInputRejection && error.inputRejection.nativeWriteStarted === false);
  f.state.denied.add(datasetUrn);
  await assert.rejects(f.stage(first, proposal), /forbidden/);
  f.state.denied.delete(datasetUrn);
  assert.equal(f.writes.recordWrites, records); assert.equal(f.writes.targetWrites, 0);
  const ready = await f.write({ action: "seal_maintenance", maintenanceRunUrn: start.maintenanceRunUrn });
  assert.equal(ready.delivery, undefined);
  const loaded = await loadMaintenancePlan({ maintenanceRunUrn: ready.maintenanceRunUrn }, input => f.call(input), new AbortController().signal);
  assert.equal(loaded.items.length, 1);
  assert.equal(loaded.items[0].review.preview.changes.length, 1);
  await assert.rejects(f.call({ action: "publish_maintenance_item", maintenanceRunUrn: ready.maintenanceRunUrn,
    planDigest: ready.planDigest, itemId: first.preparedItemId }), /semantic_maintenance_consent_required/);
  const confirmed = await f.call({ action: "approve_maintenance", maintenanceRunUrn: ready.maintenanceRunUrn,
    version: ready.runVersion, planDigest: ready.planDigest, selection: maintenanceSelection(1, [0]) });
  assert.equal(confirmed.state, "CONFIRMED");
  const published = await f.call({ action: "publish_maintenance_item", maintenanceRunUrn: ready.maintenanceRunUrn,
    planDigest: ready.planDigest, itemId: first.preparedItemId });
  assert.equal(published.status, "VERIFIED_CURRENT_VALUES"); assert.equal(f.writes.targetWrites, 1);
  await assert.rejects(f.call({ action: "publish_maintenance_item", maintenanceRunUrn: ready.maintenanceRunUrn,
    planDigest: ready.planDigest, itemId: first.preparedItemId }), /publication_already_attempted/);
});

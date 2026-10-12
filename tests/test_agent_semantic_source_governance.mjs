/** Credential-free synthetic public Host boundary; no deployed API or model. */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { semanticCatalogFixture, catalogEvidence } from "./fixtures/semantic-catalog-fixture.mjs";
import { datasetUrn, sourceUrn, envelope } from "./fixtures/semantic-fixture.mjs";
import { maintenanceSelection, MaintenanceInputRejection } from "../extensions/datahub-agent/integration/semantic-maintenance-plan.mjs";
import { compileCatalogPublication, recompileCatalogPublication } from "../extensions/datahub-agent/integration/semantic-catalog-publication.mjs";
import { loadMaintenancePlan } from "../extensions/datahub-agent/mfe/semantic-maintenance-review.js";
import { canCorrectMaintenanceInput } from "../extensions/datahub-agent/pi-web/lib/semantic-input-correction.mjs";

function fixture() {
  const f = semanticCatalogFixture();
  f.writes.recordHistoryLimits.ekopAgentTask = 2147483647;
  f.writes.recordHistoryLimits.ekopAgentRun = 2147483647;
  async function write(input) {
    f.writes.pending = { requestId: randomUUID(), sessionId: f.sessionId, ...input };
    return f.call({ ...f.writes.pending, uiRequestId: "fixture-ui" });
  }
  const start = extra => write({ action: "start_maintenance", sourceUrn, ...extra });
  const stage = (root, proposal) => {
    const { action: _action, ...body } = proposal;
    return write({ ...body, action: "prepare_maintenance", maintenanceRunUrn: root.maintenanceRunUrn });
  };
  const read = root => f.call({ action: "read_maintenance", maintenanceRunUrn: root.maintenanceRunUrn });
  const seal = root => write({ action: "seal_maintenance", maintenanceRunUrn: root.maintenanceRunUrn });
  return { ...f, write, start, stage, read, seal };
}

async function rejectsBeforeChild(f, root, proposal) {
  const before = f.writes.recordWrites;
  await assert.rejects(f.stage(root, proposal), error => {
    assert(error instanceof MaintenanceInputRejection);
    assert.equal(error.inputRejection.issue, "semantic_maintenance_focus_mismatch");
    assert(canCorrectMaintenanceInput(f.writes.pending, { error: error.message, inputRejection: error.inputRejection }));
    return true;
  });
  assert.equal(f.writes.recordWrites, before);
  assert.equal(f.writes.targetWrites, 0);
}

test("Source is the asset boundary: default covers all authorized members, focus/asset selection only narrow it", async () => {
  const f = fixture(), all = await f.start();
  assert.equal(all.assetCount, Object.keys(f.assets).length);
  assert.deepEqual(all.governance, { sourceUrn, focus: "all", assetScopeBasis: "NATIVE_TASK_SELECTED_ASSETS" });
  const field = await f.start({ focus: "field" }), table = await f.start({ focus: "table" });
  assert.equal(field.assetCount, 1); assert.equal(table.assetCount, 1);
  const one = await f.start({ focus: "tag", assetUrns: [f.assets.chart] });
  assert.equal(one.assetCount, 1); assert.equal(one.governance.focus, "tag");
  assert.equal((await f.read(all)).assetCount, all.assetCount, "narrowing a new Root does not rewrite old Roots");
  const before = f.writes.recordWrites;
  for (const extra of [{ focus: "invented" }, { focus: "table", assetUrns: [f.assets.chart] },
    { assetUrns: ["urn:li:dataset:(urn:li:dataPlatform:mssql,SourceKeyword.outside.orders,DEV)"] },
    { assetUrns: [datasetUrn, datasetUrn] }, { assetUrns: [] }])
    await assert.rejects(f.start(extra));
  assert.equal(f.writes.recordWrites, before); assert.equal(f.writes.targetWrites, 0);
});

test("glossary-only rejects Tag/description inputs but saves a complete hierarchy and Term association", async () => {
  const f = fixture(); let root = await f.start({ focus: "glossary", assetUrns: [datasetUrn] });
  await rejectsBeforeChild(f, root, await f.definitionRequest({ kind: "tag", operation: "create", name: "Not this focus", description: "Synthetic" }));
  await rejectsBeforeChild(f, root, await f.request([{ kind: "description", operation: "set", value: "Not this focus", ...catalogEvidence }]));
  const group = await f.definitionRequest({ kind: "node", operation: "create", name: "Current Source Concepts", description: "Fixture Source governance grouping, not an enterprise truth" });
  root = await f.stage(root, group); const groupUrn = root.items[0].definition.urn;
  const term = await f.definitionRequest({ kind: "term", operation: "create", name: "Proposed Order Meaning", description: "Meaning scoped to the fixture", parentUrn: groupUrn });
  root = await f.stage(root, term); const termItem = root.items.find(item => item.id === term.requestId);
  const detail = await f.call({ action: "read_review", ...termItem.reviewRef });
  assert.deepEqual(detail.preview.definition.hierarchy.map(part => part.name), ["Current Source Concepts", "Proposed Order Meaning"]);
  assert.equal(detail.preview.governance.focus, "glossary");
  root = await f.stage(root, await f.request([{ kind: "term", operation: "add", value: termItem.definition.urn, ...catalogEvidence }]));
  const ready = await f.seal(root), loaded = await loadMaintenancePlan({ maintenanceRunUrn: ready.maintenanceRunUrn }, f.call, new AbortController().signal);
  assert.equal(loaded.governance.focus, "glossary");
  assert.equal(f.writes.targetWrites, 0);
  await f.call({ action: "approve_maintenance", maintenanceRunUrn: ready.maintenanceRunUrn, version: ready.runVersion,
    planDigest: ready.planDigest, selection: maintenanceSelection(ready.totalItems, ready.items.map((_, i) => i)) });
  for (const item of ready.items) assert.equal((await f.call({ action: "publish_maintenance_item", maintenanceRunUrn: ready.maintenanceRunUrn,
    planDigest: ready.planDigest, itemId: item.id })).status, "VERIFIED_CURRENT_VALUES");
  assert(f.state.dataset.glossaryTerms.value.terms.some(item => item.urn === termItem.definition.urn));
  assert.equal(f.state.dataset.editableDatasetProperties.value.description, "Human maintained fixture definition");
});

test("tag/table/field filters persist at the Host and a NEW complete input can correct a focus mismatch", async () => {
  for (const focus of ["tag", "table", "field"]) {
    const f = fixture(), root = await f.start({ focus, assetUrns: [datasetUrn] });
    const denied = focus === "tag" ? { kind: "term", operation: "add", value: "urn:li:glossaryTerm:Order", ...catalogEvidence } :
      { kind: "description", operation: "set", value: "Synthetic", ...(focus === "table" ? { fieldPath: "order_id" } : {}), ...catalogEvidence };
    await rejectsBeforeChild(f, root, await f.request([denied]));
    const accepted = focus === "tag" ? { kind: "tag", operation: "add", value: "urn:li:tag:Reviewed", ...catalogEvidence } :
      { kind: "description", operation: "set", value: "Synthetic permitted level", ...(focus === "field" ? { fieldPath: "order_id" } : {}), ...catalogEvidence };
    const staged = await f.stage(root, await f.request([accepted]));
    assert.equal(staged.totalItems, 1); assert.equal(staged.governance.focus, focus);
    const proposal = await f.request([accepted]); proposal.focus = "all";
    await assert.rejects(f.stage(root, proposal), MaintenanceInputRejection);
    assert.equal((await f.read(root)).governance.focus, focus);
    assert.equal(f.writes.targetWrites, 0);
  }
});

test("Catalog search/inspection expose root-to-leaf names, descriptions and URNs; native corrupt/denied ancestors remain hard failures", async () => {
  const f = fixture(), parent = "urn:li:glossaryNode:SourceSpecific";
  f.state.definitions[parent] = { glossaryNodeInfo: envelope({ name: "Other Source Governance", definition: "Only the other source" }) };
  f.state.definitions["urn:li:glossaryNode:Commerce"].glossaryNodeInfo.value.parentNode = parent;
  f.state.definitions["urn:li:glossaryTerm:Order"].glossaryTermInfo.value.parentNode = "urn:li:glossaryNode:Commerce";
  const query = { requestId: randomUUID(), contract: "catalog/1", sourceUrn, assetUrn: datasetUrn, kind: "term", referenceUrn: "urn:li:glossaryTerm:Order" };
  const inspected = await f.call({ action: "inspect_definition", ...query });
  assert.deepEqual(inspected.definition.hierarchy.map(part => part.name), ["Other Source Governance", "Commerce", "Order"]);
  assert.equal(inspected.definition.hierarchy[0].description, "Only the other source");
  const searched = await f.call({ action: "search_vocabulary", requestId: randomUUID(), contract: "catalog/1", sourceUrn, assetUrn: datasetUrn, kind: "term", query: "Order" });
  assert.deepEqual(searched.vocabulary.definitions[0].hierarchy, inspected.definition.hierarchy);
  f.state.denied.add(parent);
  await assert.rejects(f.call({ action: "inspect_definition", ...query }), /denied|forbidden|privilege/);
  f.state.denied.clear(); delete f.state.definitions[parent];
  await assert.rejects(f.call({ action: "inspect_definition", ...query }), error => !error.inputRejection && /semantic_catalog_unavailable/.test(error.message));
  f.state.definitions[parent] = { glossaryNodeInfo: envelope({ name: "Cycle", parentNode: "urn:li:glossaryNode:Commerce" }) };
  await assert.rejects(f.call({ action: "inspect_definition", ...query }), /semantic_definition_parent_cycle/);
  assert.equal(f.writes.targetWrites, 0);
});

test("same-name vocabulary in another hierarchy is context, not compulsory reuse; same-parent collisions still reject", async () => {
  const f = fixture(), root = await f.start({ focus: "glossary", assetUrns: [datasetUrn] });
  const group = await f.definitionRequest({ kind: "node", operation: "create", name: "Scoped Group", description: "Fixture Source scope" });
  const staged = await f.stage(root, group), parent = staged.items[0].definition.urn;
  const term = await f.definitionRequest({ kind: "term", operation: "create", name: "Order", description: "A Source-scoped proposal with the same short name", parentUrn: parent });
  const saved = await f.stage(staged, term), item = saved.items.find(entry => entry.id === term.requestId);
  const detail = await f.call({ action: "read_review", ...item.reviewRef });
  assert.equal(detail.preview.definition.sameNameOtherHierarchy.length, 1);
  assert.equal(detail.preview.definition.conflicts.length, 0);
  assert.equal(detail.preview.definition.sameNameOtherHierarchy[0].urn, "urn:li:glossaryTerm:Order");
  const global = await f.definitionRequest({ kind: "term", operation: "create", name: "Order", description: "Same-parent duplicate remains unresolved" });
  await assert.rejects(f.stage(saved, global), /semantic_definition_reuse_required/);
  assert.equal(f.writes.targetWrites, 0);
});

test("narrowed asset selection rejects a shared definition update with a known reference outside that Task even inside the same Source", async () => {
  const f = fixture(), first = await f.start({ assetUrns: [datasetUrn], focus: "tag" });
  const proposal = await f.definitionRequest({ kind: "tag", operation: "create", name: "Scoped Owned Tag", description: "Synthetic original" });
  let plan = await f.stage(first, proposal); const tag = plan.items[0].definition;
  plan = await f.stage(plan, await f.request([{ kind: "tag", operation: "add", value: tag.urn, ...catalogEvidence }]));
  const ready = await f.seal(plan);
  await f.call({ action: "approve_maintenance", maintenanceRunUrn: ready.maintenanceRunUrn, version: ready.runVersion,
    planDigest: ready.planDigest, selection: maintenanceSelection(ready.totalItems, ready.items.map((_, i) => i)) });
  for (const item of ready.items) await f.call({ action: "publish_maintenance_item", maintenanceRunUrn: ready.maintenanceRunUrn, planDigest: ready.planDigest, itemId: item.id });
  const next = await f.start({ assetUrns: [datasetUrn], focus: "tag" });
  f.state.impactRows = [{ entity: { urn: f.assets.chart } }];
  const version = f.state.definitions[tag.urn].tagProperties.systemMetadata.version;
  const update = await f.definitionRequest({ kind: "tag", operation: "update", urn: tag.urn, version, description: "Would affect another selected-out asset" });
  const before = f.writes.recordWrites, targets = f.writes.targetWrites;
  await assert.rejects(f.stage(next, update), /semantic_maintenance_known_outside_reference/);
  assert.equal(f.writes.recordWrites, before); assert.equal(f.writes.targetWrites, targets);
});

test("legacy compiled reviews keep exact digest, and new governance drift is rejected by the real parent loader", async () => {
  const f = fixture(), request = await f.definitionRequest({ kind: "term", operation: "create", name: "Legacy fixture term", description: "Synthetic" });
  const legacy = await compileCatalogPublication(request, f.context);
  assert.equal((await recompileCatalogPublication(legacy, f.context)).planDigest, legacy.planDigest);
  const root = await f.start({ focus: "tag", assetUrns: [datasetUrn] });
  await f.stage(root, await f.request([{ kind: "tag", operation: "add", value: "urn:li:tag:Reviewed", ...catalogEvidence }]));
  const ready = await f.seal(root); let reads = 0;
  const send = async input => {
    const result = await f.call(input);
    if (input.action === "read_maintenance" && ++reads === 2) result.governance.focus = "all";
    return result;
  };
  await assert.rejects(loadMaintenancePlan({ maintenanceRunUrn: ready.maintenanceRunUrn }, send, new AbortController().signal), /semantic_maintenance_plan_changed/);
  assert.equal(f.writes.targetWrites, 0);
});

import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { nativeSemantic } from "../extensions/datahub-agent/integration/native-semantic.mjs";
import { semanticFixture, sourceUrn, datasetUrn, requestId, executionUrn, envelope } from "./fixtures/semantic-fixture.mjs";

const search = (f, extra = {}) => nativeSemantic(JSON.stringify({ action: "search_vocabulary", sourceUrn, requestId, kind: "tag", query: "*", ...extra }), f.context);
const definition = (extra = {}) => ({ kind: "term", name: "Net order value", description: "Order value after discounts, not a validated revenue metric.", ...extra });
async function propose(f, value = definition(), extra = {}) {
  const snapshot = await f.run();
  return f.run({ action: "preview_definition", snapshotDigest: snapshot.snapshotDigest, definition: value,
    reason: "Review the existing source description before reuse or creation", evidenceIds: ["dataset:source-description"], ...extra });
}
function matchRun(f) {
  Object.assign(f.state.dataset.schemaMetadata.systemMetadata, { runId: executionUrn, lastRunId: "prior-run", pipelineName: sourceUrn });
}
function changeRecipe(f, patch) {
  const recipe = { ...JSON.parse(f.state.recipe), ...patch };
  f.state.recipe = JSON.stringify(recipe);
  f.policy.recipeSha256 = createHash("sha256").update(f.state.recipe).digest("hex");
  f.state.execution.dataHubExecutionRequestInput.value.args.recipe = JSON.stringify({ ...recipe, run_id: executionUrn, pipeline_name: recipe.pipeline_name || sourceUrn });
}

test("native successful execution and schema provenance match only this asset, never a complete source inventory", async () => {
  const f = semanticFixture(); matchRun(f);
  const result = await f.run();
  assert.equal(result.membership.status, "NATIVE_RUN_MATCH");
  assert.equal(result.membership.datasetUrn, datasetUrn);
  assert.equal(result.membership.execution.urn, executionUrn);
  assert.equal(result.scope.completeSourceInventory, false);
  assert.equal(result.scope.ingestionMembershipVerified, false, "the whole authorized subset was not scanned");
  assert.ok(result.blockers.includes("source_inventory_incomplete"));
  assert.ok(!result.blockers.includes("source_membership_not_verified"));
  assert.equal(result.publicationAuthorized, false);
  assert.doesNotMatch(JSON.stringify(result), /SOURCE_PASSWORD|DATAHUB_TOKEN|EXECUTION_REPORT_NOT_FOR_MODEL/);
  changeRecipe(f, { pipeline_name: "operator-owned-pipeline" });
  f.state.dataset.schemaMetadata.systemMetadata.pipelineName = "operator-owned-pipeline";
  assert.equal((await f.run()).membership.status, "NATIVE_RUN_MATCH", "native API preserves configured pipeline names");
});

test("native current run accepts its UUID alias and first observation, never previous-run membership", async () => {
  const f = semanticFixture(); matchRun(f);
  const metadata = f.state.dataset.schemaMetadata.systemMetadata;
  metadata.runId = executionUrn.slice("urn:li:dataHubExecutionRequest:".length);
  const result = await f.run();
  assert.equal(result.membership.status, "NATIVE_RUN_MATCH");
  assert.equal(result.membership.provenance.runId, metadata.runId);
  assert.equal(result.membership.provenance.lastRunId, "prior-run");
  delete metadata.lastRunId;
  assert.equal((await f.run()).membership.status, "NATIVE_RUN_MATCH", "first insertion need not have a prior run");
  metadata.lastRunId = executionUrn;
  metadata.runId = "different-current-run";
  assert.equal((await f.run()).membership.status, "UNVERIFIED", "historical membership cannot override the current observation");
  metadata.runId = `unrelated-prefix:${executionUrn.slice("urn:li:dataHubExecutionRequest:".length)}`;
  assert.equal((await f.run()).membership.status, "UNVERIFIED", "arbitrary suffix aliases are not native execution IDs");
});

test("missing, stale, wrong-source, failed and recipe-drifted run evidence is explicitly unresolved", async () => {
  const mutations = [
    (s) => { s.latestSuccessfulExecution = null; },
    (s) => { s.dataset.schemaMetadata.systemMetadata.runId = "old-run"; },
    (s) => { delete s.dataset.schemaMetadata.systemMetadata.runId; s.dataset.schemaMetadata.systemMetadata.lastRunId = executionUrn; },
    (s) => { s.dataset.schemaMetadata.systemMetadata.pipelineName = "other-source"; },
    (s) => { s.execution.dataHubExecutionRequestInput.value.task = "TEST_CONNECTION"; },
    (s) => { s.execution.dataHubExecutionRequestInput.value.source.ingestionSource = "urn:li:dataHubIngestionSource:other"; },
    (s) => { s.execution.dataHubExecutionRequestInput.value.args.recipe = "{}"; },
    (s) => { s.execution.dataHubExecutionRequestInput.value.args.recipe = "invalid"; },
    (s) => { s.execution.dataHubExecutionRequestInput.value.args.version = "other"; },
    (s) => { s.execution.dataHubExecutionRequestInput.value.executorId = "other"; },
    (s) => { s.execution.dataHubExecutionRequestResult.value.status = "FAILURE"; },
  ];
  for (const mutate of mutations) {
    const f = semanticFixture(); matchRun(f); mutate(f.state);
    const result = await f.run();
    assert.equal(result.membership.status, "UNVERIFIED");
    assert.ok(result.blockers.includes("source_membership_not_verified"));
    assert.equal(result.publicationAuthorized, false);
  }
});

test("pagination and proposals are invalidated by native run/provenance changes", async () => {
  for (const mutate of [
    (s) => { s.dataset.schemaMetadata.systemMetadata.runId = "later-run"; },
    (s) => { s.dataset.schemaMetadata.systemMetadata.lastRunId = "different-prior-run"; },
    (s) => { s.execution.dataHubExecutionRequestResult.systemMetadata.version = "2"; },
    (s) => { s.latestSuccessfulExecution = null; },
    (s) => { s.sourceVersion = "2"; },
  ]) {
    const f = semanticFixture(); matchRun(f);
    const snapshot = await f.run(); mutate(f.state);
    await assert.rejects(f.run({ offset: 0, snapshotDigest: snapshot.snapshotDigest }), /semantic_snapshot_conflict/);
  }
});

test("read-only source inspection is connector neutral but source identity, recipe pin and native manage privilege stay enforced", async () => {
  const f = semanticFixture();
  changeRecipe(f, { source: { type: "oracle", config: { password: "${SOURCE_PASSWORD}" } } });
  f.state.sourceType = "oracle";
  f.state.executorId = "operator-other-executor";
  f.state.execution.dataHubExecutionRequestInput.value.executorId = f.state.executorId;
  matchRun(f);
  const result = await f.run();
  assert.equal(result.source.type, "oracle");
  assert.equal(result.membership.status, "NATIVE_RUN_MATCH");
  assert.equal(result.publicationAuthorized, false);
  assert.ok(f.state.calls.every((c) => c.path.endsWith("batchGet") || c.body.query.startsWith("query")));
  f.state.manageIngestion = false;
  await assert.rejects(f.run(), /semantic_source_forbidden/);
  await assert.rejects(search(f), /semantic_source_forbidden/);
});

test("vocabulary uses public native entity enums, versioned definitions and per-reference ACL", async () => {
  const f = semanticFixture();
  for (const kind of ["domain", "node", "term", "tag", "property"]) {
    const result = await search(f, { kind });
    assert.ok(result.vocabulary.definitions.length);
    assert.ok(result.vocabulary.definitions.every((d) => d.kind === kind && d.version === "1"));
    assert.equal(result.vocabulary.duplicateAbsenceVerified, false);
    assert.equal(result.publicationAuthorized, false);
  }
  const property = (await search(f, { kind: "property" })).vocabulary.definitions[0];
  assert.deepEqual(property.constraints.allowedValues, [{ value: "normal", description: null }, { value: "high", description: null }]);
  assert.equal(property.constraints.immutable, false);
  assert.equal(property.constraints.cardinality, "SINGLE");
  f.state.denied.add("urn:li:tag:Reviewed");
  const result = await search(f);
  assert.deepEqual(result.vocabulary.definitions.map((d) => d.urn), ["urn:li:tag:Existing"]);
  assert.equal(result.vocabulary.hiddenResultsOmitted, true);
  assert.doesNotMatch(JSON.stringify(result), /Reviewed/);
  f.policy.taskDatasets = [];
  const calls = f.state.calls.length;
  await assert.rejects(search(f), /semantic_source_asset_scope_not_configured/);
  assert.ok(f.state.calls.slice(calls).every((c) => !c.body?.query?.includes("searchAcrossEntities")));
});

test("vocabulary search pages are bounded and never promoted to atomic or semantic uniqueness evidence", async () => {
  const f = semanticFixture();
  for (let i = 0; i < 23; i++) f.state.definitions[`urn:li:tag:Page${i}`] = { tagProperties: envelope({ name: `Page ${i}` }) };
  const first = await search(f, { query: "Page" });
  assert.equal(first.vocabulary.definitions.length, 20);
  assert.equal(first.vocabulary.nextStart, 20);
  const last = await search(f, { query: "Page", start: 20 });
  assert.equal(last.vocabulary.definitions.length, 3);
  assert.equal(last.vocabulary.nextStart, null);
  assert.equal(last.vocabulary.duplicateAbsenceVerified, false);
  for (const extra of [{ start: 1000 }, { start: -1 }, { start: 0.5 }, { kind: "dataset" }, { query: "" }, { query: "x".repeat(129) }, { endpoint: "/write" }]) {
    await assert.rejects(search(f, extra), /invalid_semantic_request/);
  }
});

test("new Domain, Glossary Node/Term, Tag and Property definitions stay separate from association and publication", async () => {
  const values = [
    definition({ kind: "domain", name: "Sales operations", parentUrn: "urn:li:domain:Sales" }),
    definition({ kind: "node", name: "Order concepts", parentUrn: "urn:li:glossaryNode:Commerce" }),
    definition({ parentUrn: "urn:li:glossaryNode:Commerce" }),
    definition({ kind: "tag", name: "Revenue-sensitive" }),
    definition({ kind: "property", name: "Business priority", valueType: "string", cardinality: "SINGLE", allowedValues: ["normal", "high"] }),
    definition({ kind: "property", name: "Business rank", valueType: "number", cardinality: "MULTIPLE", allowedValues: [1, 2] }),
  ];
  for (const value of values) {
    const f = semanticFixture(), before = structuredClone(f.state.dataset);
    const result = await propose(f, value);
    assert.equal(result.definition.operation, "PROPOSED_CREATE_ONLY");
    assert.equal(result.definition.existingDefinitionsMayNotBeUpdated, true);
    assert.equal(result.definition.businessMeaningVerified, false);
    assert.equal(result.definition.requiresHumanReview, true);
    assert.ok(result.definition.blockers.includes("native_create_preconditions_not_verified"));
    assert.match(result.definition.proposedUrn, /^urn:li:[a-zA-Z]+:ekop-semantic-[a-f0-9]{64}$/);
    assert.equal(result.changes, undefined, "new definitions do not silently attach to assets");
    assert.deepEqual(f.state.dataset, before);
    assert.equal(result.publicationAuthorized, false);
    if (value.kind === "property") {
      assert.deepEqual(result.definition.value.entityTypes, ["urn:li:entityType:datahub.dataset"]);
      assert.deepEqual(result.definition.value.allowedValues[0].value, value.valueType === "string" ? { string: "normal" } : { double: 1 });
    }
  }
});

test("same-name definitions require reuse review; normalized host-generated identity remains stable without being create authority", async () => {
  const f = semanticFixture();
  const a = await propose(f, definition({ kind: "tag", name: "Reviewed" }));
  const b = await propose(f, definition({ kind: "tag", name: "  REVIEWED  ", description: "A changed proposal description" }));
  assert.deepEqual(a.definition.conflicts, ["existing_name_requires_reuse_review"]);
  assert.equal(a.definition.duplicateCheck.exactNameMatches[0].urn, "urn:li:tag:Reviewed");
  assert.equal(a.definition.proposedUrn, b.definition.proposedUrn);
  assert.ok(a.definition.blockers.includes("definition_namespace_not_authorized"));
});

test("definition evidence, parent types/ACL/deletion and native property shape are checked", async () => {
  for (const def of [
    definition({ kind: "dataset" }), definition({ name: " " }), definition({ urn: "urn:li:tag:Existing" }),
    definition({ parentUrn: "urn:li:domain:Sales" }), definition({ kind: "tag", parentUrn: "urn:li:glossaryNode:Commerce" }),
    definition({ kind: "property", valueType: "date", cardinality: "SINGLE" }),
    definition({ kind: "property", valueType: "string", cardinality: "SINGLE", allowedValues: [1] }),
    definition({ kind: "property", valueType: "number", cardinality: "MULTIPLE", allowedValues: [1, 1] }),
    definition({ kind: "property", valueType: "number", cardinality: "SINGLE", entityTypes: ["all"] }),
  ]) await assert.rejects(propose(semanticFixture(), def), /semantic_invalid_definition/);
  await assert.rejects(propose(semanticFixture(), definition(), { evidenceIds: ["fabricated"] }), /semantic_invalid_candidate/);
  for (const mode of ["denied", "deleted"]) {
    const f = semanticFixture();
    if (mode === "denied") f.state.denied.add("urn:li:glossaryNode:Commerce");
    else f.state.definitions["urn:li:glossaryNode:Commerce"].status = envelope({ removed: true });
    await assert.rejects(propose(f, definition({ parentUrn: "urn:li:glossaryNode:Commerce" })), /semantic_read_forbidden|semantic_reference_removed/);
  }
});

test("malformed search and cross-type references fail without trusting search snippets", async () => {
  for (const page of [
    { start: 0, total: 1, searchResults: [] },
    { start: 99, total: 0, searchResults: [] },
    { start: 0, total: 1, searchResults: [{ entity: { urn: datasetUrn } }] },
    { start: 0, total: 2, searchResults: Array(2).fill({ entity: { urn: "urn:li:tag:Existing" } }) },
  ]) {
    const f = semanticFixture(), fetch = f.context.fetchImpl;
    f.context.fetchImpl = (url, options) => JSON.parse(options.body ?? "{}").query?.includes("searchAcrossEntities")
      ? Promise.resolve(Response.json({ data: { searchAcrossEntities: page } })) : fetch(url, options);
    await assert.rejects(search(f), /semantic_search_invalid|semantic_invalid_reference/);
  }
});

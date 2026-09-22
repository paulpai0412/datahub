import test from "node:test";
import assert from "node:assert/strict";
import { semanticPublicationFixture } from "./fixtures/semantic-publication-fixture.mjs";
import { datasetUrn, sourceUrn, requestId, actor, envelope } from "./fixtures/semantic-fixture.mjs";
import { taskRecords } from "../extensions/datahub-agent/integration/task-records.mjs";
import semanticExtension from "../extensions/datahub-agent/pi-web/lib/datahub-semantic-extension.ts";
import { makePublicationReview, canonicalPublicationJson } from "../extensions/datahub-agent/integration/publication-review.mjs";

async function prepareInput(f, proposal, inspection = {}) {
  const inspected = await f.run(inspection);
  f.writes.pending = { action: "prepare_review", requestId, sessionId: f.sessionId, sourceUrn, datasetUrn, snapshotDigest: inspected.snapshotDigest, ...inspection, ...proposal };
  return f.call({ ...f.writes.pending, uiRequestId: "fixture-ui" });
}

const candidates = [
  { kind: "tag", value: "urn:li:tag:Reviewed", reason: "Fixture", evidenceIds: ["dataset:source-description"] },
  { kind: "description", fieldPath: "[version=2.0].[type=struct].net.amount", value: "Reviewed net value", reason: "Fixture", evidenceIds: ["field:1:source-description"] },
];

test("native request → Task/Run/Decision → human approval → CAS → stored outcome → reload", async () => {
  const f = semanticPublicationFixture();
  f.state.dataset.globalTags.value.tags[0].context = "Human note";
  const before = structuredClone(f.state.dataset.globalTags.value);
  const prepared = await f.prepare();
  assert.equal(prepared.state, "PENDING"); assert.equal(f.writes.submissions, 0);
  assert.equal(f.writes.recordWrites, 3);
  assert.equal(JSON.stringify(prepared).includes("NOT_FOR_MODEL"), false);
  const reconnected = await f.call({ ...f.writes.pending, uiRequestId: "fixture-ui" });
  assert.equal(reconnected.planDigest, prepared.planDigest); assert.equal(f.writes.recordWrites, 3);
  const published = await f.command(prepared, "approve_review");
  assert.equal(published.state, "ATTEMPTED"); assert.equal(f.writes.submissions, 1);
  assert.equal(published.publication.status, "VERIFIED_CURRENT_VALUES");
  assert.equal(JSON.parse(published.attempt.outcomeJson).status, "VERIFIED_CURRENT_VALUES");
  assert.equal(published.reconciliation.status, "MATCHED_CLAIMED_ATTEMPT");
  assert.deepEqual(f.state.dataset.globalTags.value.tags[0], before.tags[0]);
  const reloaded = await f.command(prepared, "read_review");
  assert.equal(reloaded.state, "ATTEMPTED");
  assert.equal(reloaded.attempt.attemptId, published.attempt.attemptId);
  await assert.rejects(f.command(reloaded, "publish_review"), /already_attempted/);
  assert.equal(f.writes.submissions, 1);
});

test("model tool retains read-only recovery locators from an unconfirmed preparation", async () => {
  let tool;
  semanticExtension({ on() {}, registerTool(value) { tool = value; } });
  const result = await tool.execute("fixture", { action: "prepare_review", sourceUrn, datasetUrn }, new AbortController().signal, undefined,
    { mode: "rpc", sessionManager: { getSessionId: () => "11111111-1111-4111-8111-111111111111" }, ui: { async input(_title, body) {
      const request = JSON.parse(body);
      return JSON.stringify({ error: "task_write_unconfirmed", reconciliation: { runUrn: "urn:li:dataProcessInstance:fixture", taskUrn: "urn:li:dataJob:fixture", decisionId: request.requestId } });
    } } });
  assert.equal(result.details.format, "datahub-semantic.error/1"); assert.equal(result.details.retryAllowed, false);
  assert.equal(result.details.reconciliation.decisionId, result.details.requestId);
  assert.equal(result.details.reconciliation.runUrn, "urn:li:dataProcessInstance:fixture");
});

test("Steward provenance cannot grant a later legacy publisher whole-Aspect ownership", async () => {
  const f = semanticPublicationFixture(), initial = await f.prepare();
  await f.command(initial, "approve_review");
  const store = taskRecords({ ...f.context, recompilePublication: async (value) => value });
  let run = await store.getRun(initial.reviewRef.runUrn);
  const old = run.value.decisions[0].publicationReview;
  const review = makePublicationReview({ purpose: "SEMANTIC", source: old.source, sourceId: old.sourceId,
    snapshotSha256: old.snapshotSha256, candidateDigest: old.candidateDigest, analysisVersion: "legacy-fixture", candidateIds: old.candidateIds,
    datasets: old.datasets, expiresAt: old.expiresAt,
    changes: [{ urn: datasetUrn, aspect: "globalTags", expectedVersion: f.state.dataset.globalTags.systemMetadata.version,
      valueJson: canonicalPublicationJson({ tags: [] }) }] });
  run = await store.appendPublicationReview(run.urn, run.version, run.value.sessionId, { id: "legacy-adoption", question: "Must not own human values", choices: [] }, review);
  run = await store.respondPublicationReview(run.urn, run.version, run.value.sessionId, "legacy-adoption", { verdict: "APPROVE", planDigest: review.planDigest });
  await assert.rejects(store.publishPublication(run.urn, run.version, run.value.sessionId, "legacy-adoption", review), /publication_target_not_owned/);
  assert.equal(f.writes.submissions, 1);
  assert.equal(f.state.dataset.globalTags.value.tags.length, 2);
});

test("selection is a new immutable plan; old Decision rejected atomically, no approval copied", async () => {
  const f = semanticPublicationFixture(), initial = await f.prepare(candidates);
  const selected = await f.command(initial, "select_review", { candidateIds: [initial.candidateIds[1]] });
  assert.notEqual(selected.planDigest, initial.planDigest);
  assert.equal(selected.history.length, 2); assert.equal(selected.history[0].verdict, "REJECT");
  assert.equal(selected.state, "PENDING"); assert.equal(f.writes.submissions, 0);
  await assert.rejects(f.command(initial, "approve_review"), /revision_conflict/);
  await f.command(selected, "approve_review");
  assert.equal(f.state.dataset.globalTags.value.tags.length, 1);
  assert.equal(f.state.dataset.editableSchemaMetadata.value.editableSchemaFieldInfo.length, 2);
  assert.equal((await f.command(initial, "read_review")).state, "REJECT");
});

test("reject and forged/past native UI requests cannot publish or create records", async () => {
  const f = semanticPublicationFixture(), initial = await f.prepare();
  const rejected = await f.command(initial, "reject_review");
  assert.equal(rejected.state, "REJECT");
  await assert.rejects(f.command(rejected, "publish_review"), /trusted_publication_consent_required/);
  const count = f.writes.recordWrites;
  f.writes.pending = null;
  await assert.rejects(f.call({ action: "prepare_review", requestId: "00000000-0000-4000-8000-000000000077", sessionId: f.sessionId, uiRequestId: "forged" }), /publication_not_authorized|native_request/);
  assert.equal(f.writes.recordWrites, count); assert.equal(f.writes.submissions, 0);
});

test("human value/version change, source change, expiry and policy revocation block writes", async () => {
  for (const change of [
    (f) => { f.state.dataset.globalTags = envelope({ tags: [{ tag: "urn:li:tag:Manual" }] }, "2"); },
    (f) => { f.state.sourceVersion = "2"; },
    (f) => { f.writes.now += 600001; },
    (f) => { f.policy.semanticPublicationApproved = false; },
    (f) => { f.state.denied.add(datasetUrn); },
    (f) => { f.state.denied.add("urn:li:tag:Reviewed"); },
  ]) {
    const f = semanticPublicationFixture(), prepared = await f.prepare(); change(f);
    await assert.rejects(f.command(prepared, "approve_review"));
    assert.equal(f.writes.submissions, 0);
  }
});

test("target CAS race preserves manual value and permanently consumes attempt", async () => {
  const f = semanticPublicationFixture(), prepared = await f.prepare();
  f.writes.beforeTarget = () => { f.state.dataset.globalTags = envelope({ tags: [{ tag: "urn:li:tag:Race" }] }, "2"); };
  await assert.rejects(f.command(prepared, "approve_review"), /publication_write_unconfirmed/);
  assert.equal(f.writes.targetWrites, 0);
  const read = await f.command(prepared, "read_review");
  assert.equal(read.state, "ATTEMPTED"); assert.equal(read.reconciliation.status, "INCOMPLETE_OR_CHANGED");
  assert.equal(JSON.parse(read.attempt.outcomeJson).status, "UNKNOWN_OR_CONTEXT_CHANGED");
  await assert.rejects(f.command(read, "publish_review"), /already_attempted/);
  assert.equal(f.writes.submissions, 1);
});

test("partial multi-Aspect/lost ACK reconciles current values without any replay", async () => {
  const f = semanticPublicationFixture(), prepared = await f.prepare(candidates);
  f.writes.lossAfter = 1;
  await assert.rejects(f.command(prepared, "approve_review"), /publication_write_unconfirmed/);
  const read = await f.command(prepared, "read_review");
  assert.equal(read.reconciliation.observations.filter((row) => row.state === "MATCHED").length, 1);
  assert.equal(read.reconciliation.status, "INCOMPLETE_OR_CHANGED");
  await assert.rejects(f.command(read, "publish_review"), /already_attempted/);
  assert.equal(f.writes.submissions, 1); assert.equal(f.writes.targetWrites, 1);
});

test("complete write with lost ACK is distinguishable from its immutable UNKNOWN receipt", async () => {
  const f = semanticPublicationFixture(), prepared = await f.prepare(); f.writes.lossAfter = 1;
  await assert.rejects(f.command(prepared, "approve_review"), /publication_write_unconfirmed/);
  const read = await f.command(prepared, "read_review");
  assert.equal(read.reconciliation.status, "MATCHED_CLAIMED_ATTEMPT");
  assert.equal(JSON.parse(read.attempt.outcomeJson).status, "UNKNOWN_OR_CONTEXT_CHANGED");
  assert.equal(f.writes.submissions, 1);
});

test("schema/source race after CAS cannot become trusted success", async () => {
  const f = semanticPublicationFixture(), prepared = await f.prepare();
  f.writes.afterTarget = () => { f.state.sourceVersion = "2"; };
  await assert.rejects(f.command(prepared, "approve_review"), /publication_write_unconfirmed/);
  const read = await f.command(prepared, "read_review");
  assert.equal(read.reconciliation.status, "MATCHED_CLAIMED_ATTEMPT");
  assert.equal(JSON.parse(read.attempt.outcomeJson).status, "UNKNOWN_OR_CONTEXT_CHANGED");
  assert.equal(read.stale, true);
});

test("five supported definition kinds create separately; same-name replays require reuse review", async () => {
  for (const kind of ["domain", "node", "term", "tag", "property"]) {
    const f = semanticPublicationFixture(); f.policy.semanticDefinitionCreationApproved = true;
    const definition = { kind, name: `New ${kind}`, description: "Synthetic definition",
      ...(kind === "property" ? { valueType: "string", cardinality: "SINGLE", allowedValues: ["fixture"] } : {}) };
    const initial = await prepareInput(f, { definition, reason: "Fixture", evidenceIds: ["dataset:source-description"] });
    assert.equal(initial.preview.definition.operation, "PROPOSED_CREATE_ONLY");
    const published = await f.command(initial, "approve_review");
    assert.equal(published.publication.status, "VERIFIED_CURRENT_VALUES");
    assert.equal(f.writes.targetWrites, 1);
    assert.equal(f.state.dataset.globalTags.value.tags.length, 1, "definition approval never associates it");
    const seen = await f.run({ action: "preview_definition", snapshotDigest: (await f.run()).snapshotDigest,
      definition, reason: "Fixture", evidenceIds: ["dataset:source-description"] });
    assert.deepEqual(seen.definition.conflicts, ["existing_name_requires_reuse_review"]);
  }
});

test("unapproved audit audience and pre-existing definition tombstones block preparation", async () => {
  const f = semanticPublicationFixture(); delete f.policy.semanticAuditAudience;
  await assert.rejects(f.prepare(), /audit_visibility_not_approved/);
  assert.equal(f.writes.recordWrites, 0);
  f.policy.semanticAuditAudience = "EXISTING_TASK_RUN_ACL"; f.policy.semanticDefinitionCreationApproved = true;
  const definition = { kind: "tag", name: "Tombstone", description: "Must not adopt or resurrect" };
  const inspected = await f.run();
  const preview = await f.run({ action: "preview_definition", snapshotDigest: inspected.snapshotDigest, definition, reason: "Fixture", evidenceIds: ["dataset:source-description"] });
  f.state.definitions[preview.definition.proposedUrn] = { status: envelope({ removed: true }) };
  await assert.rejects(prepareInput(f, { definition, reason: "Fixture", evidenceIds: ["dataset:source-description"] }), /definition_target_exists/);
  assert.equal(f.writes.recordWrites, 0); assert.equal(f.writes.submissions, 0);
});

test("field property materialization binds exact escaped field identity and native CAS", async () => {
  const f = semanticPublicationFixture(), fieldPath = "quoted,(column)";
  f.state.dataset.schemaMetadata.value.fields.push({ fieldPath, nativeDataType: "varchar" });
  f.state.definitions["urn:li:structuredProperty:fieldLabel"] = { propertyDefinition: envelope({ qualifiedName: "fieldLabel", valueType: "urn:li:dataType:datahub.string", cardinality: "SINGLE", entityTypes: ["urn:li:entityType:datahub.schemaField"] }) };
  const initial = await prepareInput(f, { candidates: [{ kind: "property", fieldPath, value: "urn:li:structuredProperty:fieldLabel", values: ["label"], reason: "Fixture", evidenceIds: ["field:2:path"] }] }, { fieldPath });
  const published = await f.command(initial, "approve_review");
  assert.equal(published.publication.status, "VERIFIED_CURRENT_VALUES");
  const urn = `urn:li:schemaField:(${datasetUrn},quoted%2C%28column%29)`;
  assert.deepEqual(f.state.fields[urn].schemaFieldKey.value, { parent: datasetUrn, fieldPath: "quoted%2C%28column%29" });
  assert.equal(f.writes.targetWrites, 2);
});

test("policy-backed owners and documents preserve populated manual content", async () => {
  const f = semanticPublicationFixture();
  f.policy.semanticOwners = [{ urn: "urn:li:corpuser:steward", type: "DATA_STEWARD", rule: "Selected fixture stewardship rule" }];
  f.policy.semanticDocumentationOrigins = ["https://docs.example.test"];
  f.state.definitions["urn:li:corpuser:steward"] = { corpUserKey: envelope({ username: "steward" }) };
  f.state.dataset.ownership = envelope({ owners: [{ owner: "urn:li:corpuser:human", type: "TECHNICAL_OWNER", source: { type: "MANUAL", url: "https://docs.example.test/owner" } }], lastModified: { actor: "urn:li:corpuser:human", time: 1 } });
  f.state.dataset.institutionalMemory = envelope({ elements: [{ url: "https://docs.example.test/manual", description: "Human", createStamp: { actor: "urn:li:corpuser:human", time: 1 } }] });
  const owner = structuredClone(f.state.dataset.ownership.value.owners[0]), doc = structuredClone(f.state.dataset.institutionalMemory.value.elements[0]);
  const initial = await f.prepare([
    { kind: "owner", value: "urn:li:corpuser:steward", ownerType: "DATA_STEWARD", reason: "Rule", evidenceIds: ["policy:owner:0"] },
    { kind: "documentation", value: "https://docs.example.test/new", description: "New reference", reason: "Fixture", evidenceIds: ["dataset:source-description"] },
  ]);
  assert.equal((await f.command(initial, "approve_review")).publication.status, "VERIFIED_CURRENT_VALUES");
  assert.deepEqual(f.state.dataset.ownership.value.owners[0], owner);
  assert.deepEqual(f.state.dataset.institutionalMemory.value.elements[0], doc);
});

test("lost Task creation ACK cannot replay an incomplete preparation", async () => {
  const f = semanticPublicationFixture(); f.writes.recordLossAt = 1;
  await assert.rejects(f.prepare(), /task_write_unconfirmed/);
  await assert.rejects(f.call({ ...f.writes.pending, uiRequestId: "fixture-ui" }), /semantic_preparation_incomplete/);
  assert.equal(f.writes.recordWrites, 1); assert.equal(f.writes.submissions, 0);
});

test("lost approval ACK never automatically dispatches; explicit human publication is separate", async () => {
  const f = semanticPublicationFixture(), initial = await f.prepare(); f.writes.recordLossAt = 4;
  await assert.rejects(f.command(initial, "approve_review"), /task_write_unconfirmed/);
  assert.equal(f.writes.submissions, 0);
  const current = await f.command(initial, "read_review"); assert.equal(current.state, "APPROVE");
  assert.equal((await f.command(current, "publish_review")).publication.status, "VERIFIED_CURRENT_VALUES");
  assert.equal(f.writes.submissions, 1);
});

test("concurrent close after admission preserves closure and records NOT_DISPATCHED", async () => {
  const f = semanticPublicationFixture(), initial = await f.prepare(); let closed = false;
  f.writes.afterRecord = async (aspect, value) => {
    if (aspect !== "ekopAgentRun" || closed || !value.decisions[0]?.publicationAttempt) return;
    closed = true;
    const store = taskRecords(f.context), run = await store.getRun(initial.reviewRef.runUrn);
    await store.closeRun(run.urn, run.version, run.value.sessionId);
  };
  await assert.rejects(f.command(initial, "approve_review"), /publication_not_dispatched/);
  const current = await f.command(initial, "read_review");
  assert.equal(current.closed, true); assert.equal(current.state, "ATTEMPTED");
  assert.equal(JSON.parse(current.attempt.outcomeJson).status, "NOT_DISPATCHED");
  assert.equal(f.writes.submissions, 0);
});

test("actor changes and extra arbitrary payload fields cannot authorize this review", async () => {
  const f = semanticPublicationFixture(), prepared = await f.prepare();
  await assert.rejects(f.command(prepared, "approve_review", { actor: actor.urn, changes: [] }), /invalid_semantic_request/);
  f.context.actor = { ...actor, tenant: "other", key: "b".repeat(48) };
  await assert.rejects(f.command(prepared, "read_review"), /actor_scope_mismatch/);
  f.context.actor = actor;
  f.state.meUrn = "urn:li:corpuser:someone-else";
  await assert.rejects(f.command(prepared, "read_review"), /identity_denied/);
  assert.equal(f.writes.submissions, 0);
});

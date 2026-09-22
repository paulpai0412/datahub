import test from "node:test";
import assert from "node:assert/strict";
import { semanticCheckpointFixture, datasetUrn, sourceUrn, requestId, envelope, actor } from "./fixtures/semantic-fixture.mjs";
import { compileSemanticPublication, recompileSemanticPublication } from "../extensions/datahub-agent/integration/semantic-publication.mjs";
import { validateStewardChange } from "../extensions/datahub-agent/integration/semantic-preservation.mjs";
import { makePublicationReview, canonicalPublicationJson as canonical } from "../extensions/datahub-agent/integration/publication-review.mjs";
import { ingestionPolicies } from "../extensions/datahub-agent/integration/ingestion-policy.mjs";

function fixture() {
  const f = semanticCheckpointFixture();
  f.policy.semanticPublicationApproved = true;
  f.policy.semanticAuditAudience = "EXISTING_TASK_RUN_ACL";
  f.policy.semanticAgentUrn = "urn:li:aiAgent:fixture-semantic";
  return f;
}
const tag = { kind: "tag", value: "urn:li:tag:Reviewed", reason: "Fixture evidence only", evidenceIds: ["dataset:source-description"] };
async function proposal(f, candidates = [tag], extra = {}) {
  const inspected = await f.run(extra);
  return { action: "preview", requestId, sourceUrn, datasetUrn, snapshotDigest: inspected.snapshotDigest, candidates, ...extra };
}

test("Steward compiler preserves populated human members and binds before/version/evidence/policy", async () => {
  const f = fixture();
  f.state.dataset.globalTags.value.tags[0].context = "Human annotation";
  f.state.dataset.globalTags.value.extensions = { human: "keep exactly" };
  const request = await proposal(f);
  const review = await compileSemanticPublication(request, f.context);
  assert.equal(review.changes.length, 1);
  const change = review.changes[0];
  assert.deepEqual(JSON.parse(change.beforeValueJson), f.state.dataset.globalTags.value);
  assert.deepEqual(JSON.parse(change.valueJson), { ...f.state.dataset.globalTags.value, tags: [...f.state.dataset.globalTags.value.tags, { tag: tag.value }] });
  assert.ok(validateStewardChange(review, change, f.state.dataset.globalTags.value, actor.urn));
  assert.equal((await recompileSemanticPublication(review, f.context)).planDigest, review.planDigest);
  f.policy.semanticDocumentationOrigins = ["https://docs.example.test"];
  await assert.rejects(recompileSemanticPublication(review, f.context), /snapshot_conflict|review_stale/);
  assert.ok(f.state.calls.every((call) => !call.path.endsWith("/generic")));
});

test("human descriptions, assignments, removals and arbitrary root audit members cannot be adopted", async () => {
  const f = fixture();
  await assert.rejects(compileSemanticPublication(await proposal(f, [{ ...tag, kind: "description", value: "Replace human" }]), f.context), /candidate_not_publishable/);
  const review = await compileSemanticPublication(await proposal(f), f.context);
  const change = review.changes[0];
  const before = JSON.parse(change.beforeValueJson);
  assert.equal(validateStewardChange(review, { ...change, valueJson: canonical({ tags: [] }) }, before, actor.urn), false);
  assert.equal(validateStewardChange(review, { ...change, valueJson: canonical({ tags: [{ tag: "urn:li:tag:Other" }] }) }, before, actor.urn), false);
  assert.equal(validateStewardChange(review, change, { tags: [] }, actor.urn), false);
  const withUnknown = { ...before, auditStamp: { human: "not the globalTags schema audit" } };
  assert.equal(validateStewardChange(review, { ...change, beforeValueJson: canonical(withUnknown), valueJson: canonical({ ...before, auditStamp: { actor: actor.urn, time: JSON.parse(review.semanticContextJson).createdAt } }) }, withUnknown, actor.urn), false);
});

test("exact v2 field merge preserves other edits and ordered associations", async () => {
  const f = fixture(), path = "[version=2.0].[type=struct].net.amount";
  f.state.dataset.editableSchemaMetadata.value.extra = { preserve: true };
  const review = await compileSemanticPublication(await proposal(f, [{ ...tag, kind: "description", fieldPath: path, value: "Reviewed net amount" }]), f.context);
  const change = review.changes[0], after = JSON.parse(change.valueJson);
  assert.equal(change.aspect, "editableSchemaMetadata");
  assert.deepEqual(after.editableSchemaFieldInfo[0], f.state.dataset.editableSchemaMetadata.value.editableSchemaFieldInfo[0]);
  assert.deepEqual(after.extra, { preserve: true });
  assert.equal(after.editableSchemaFieldInfo[1].fieldPath, path);
  assert.ok(validateStewardChange(review, change, f.state.dataset.editableSchemaMetadata.value, actor.urn));
});

test("empty existing property assignment is filled, not duplicated", async () => {
  const f = fixture();
  f.state.dataset.structuredProperties.value.properties[0].values = [];
  const review = await compileSemanticPublication(await proposal(f, [{ ...tag, kind: "property", value: "urn:li:structuredProperty:priority", values: ["high"] }]), f.context);
  assert.deepEqual(JSON.parse(review.changes[0].valueJson).properties, [{ propertyUrn: "urn:li:structuredProperty:priority", values: [{ string: "high" }] }]);
});

test("default policy grants no publication; new definitions remain separately opted-in and create-only", async () => {
  const f = fixture(), request = await proposal(f);
  delete f.policy.semanticPublicationApproved;
  await assert.rejects(compileSemanticPublication(request, f.context), /publication_not_authorized/);
  f.policy.semanticPublicationApproved = true;
  const inspected = await f.run();
  const definitionRequest = { action: "preview_definition", requestId, sourceUrn, datasetUrn, snapshotDigest: inspected.snapshotDigest,
    definition: { kind: "tag", name: "Fixture New Tag", description: "Human review still required" }, reason: "fixture", evidenceIds: ["dataset:source-description"] };
  await assert.rejects(compileSemanticPublication(definitionRequest, f.context), /creation_not_authorized/);
  f.policy.semanticDefinitionCreationApproved = true;
  const review = await compileSemanticPublication(definitionRequest, f.context);
  assert.equal(review.changes[0].expectedVersion, "-1");
  assert.equal(review.changes[0].beforeValueJson, "null");
  const { planDigest: _digest, ...input } = review;
  assert.throws(() => makePublicationReview({ ...input, changes: [{ ...input.changes[0], expectedVersion: "1", beforeValueJson: "{}" }] }), /create_only/);
  const { semanticContextJson: _context, ...legacy } = input;
  assert.throws(() => makePublicationReview(legacy), /invalid_semantic_review/);
  assert.ok(ingestionPolicies({ [actor.key]: [f.policy] }).get(actor.key)[0].semanticPublicationApproved);
  assert.throws(() => ingestionPolicies({ [actor.key]: [{ ...f.policy, semanticAgentUrn: undefined }] }), /invalid_ingestion_policy/);
});

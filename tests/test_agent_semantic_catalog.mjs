import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { semanticCatalogFixture as fixture, catalogEvidence as evidence } from "./fixtures/semantic-catalog-fixture.mjs";
import { actor, datasetUrn, sourceUrn } from "./fixtures/semantic-fixture.mjs";
import { nativeSemantic } from "../extensions/datahub-agent/integration/native-semantic.mjs";
import { compileSemanticPublication, recompileSemanticPublication } from "../extensions/datahub-agent/integration/semantic-publication.mjs";
import { validateStewardChange } from "../extensions/datahub-agent/integration/semantic-preservation.mjs";
import { catalogTypes, vocabularyTypes, catalogContract, catalogStewardVersion, catalogCandidateTarget } from "../extensions/datahub-agent/integration/semantic-catalog-contract.mjs";
import { makePublicationReview, canonicalPublicationJson as canonical } from "../extensions/datahub-agent/integration/publication-review.mjs";
import { ingestionPolicies } from "../extensions/datahub-agent/integration/ingestion-policy.mjs";

test("Catalog vocabulary and publication do not require a fake Dataset anchor", async () => {
  const f = fixture();
  delete f.policy.taskDatasets;
  f.state.denied.add("urn:li:tag:Existing");
  const vocabulary = await nativeSemantic(JSON.stringify({ contract: catalogContract, action: "search_vocabulary", requestId: randomUUID(), sourceUrn, assetUrn: f.assets.chart, kind: "tag", query: "*" }), f.context);
  assert.deepEqual(vocabulary.vocabulary.definitions.map((d) => d.urn), ["urn:li:tag:Reviewed"]);
  assert.equal(vocabulary.vocabulary.hiddenResultsOmitted, true);
  assert.equal(vocabulary.vocabulary.complete, false);
  const proposal = await f.prepare(await f.request([{ kind: "description", operation: "set", value: "Chart metadata only", ...evidence }], f.assets.chart));
  assert.deepEqual(proposal.preview.assetUrn, f.assets.chart);
  assert.equal((await f.command(proposal, "approve_review")).state, "ATTEMPTED");
  assert.equal(f.state.calls.some((call) => call.path === "/openapi/v3/entity/dataset/batchGet"), false);
});

for (const kind of Object.keys(catalogTypes)) test(`Catalog ${kind}: native scope, exact update, human publication and no replay`, async () => {
  const f = fixture(), urn = f.assets[kind];
  const before = await f.inspect(urn);
  assert.equal(before.assetType, kind);
  assert.equal(before.membership.status, "NATIVE_CATALOG_SCOPE");
  assert.equal(before.scope.ingestionMembershipVerified, false);
  assert.equal(JSON.stringify(before).includes("PRESERVE_NOT_FOR_MODEL"), false);
  assert.equal(JSON.stringify(before).includes("NOT_FOR_MODEL"), false);
  const req = await f.request([{ kind: "description", operation: "set", value: "Reviewed changed definition", ...evidence },
    { kind: "tag", operation: "add", value: "urn:li:tag:Reviewed", ...evidence },
    { kind: "property", operation: "set", value: "urn:li:structuredProperty:priority", values: ["high"], ...evidence }], urn);
  const review = await compileSemanticPublication(req, f.context);
  assert.equal(review.analysisVersion, catalogStewardVersion);
  assert.deepEqual(review.assets, [urn]);
  assert.deepEqual(review.datasets, kind === "dataset" ? [urn] : []);
  assert.equal((await recompileSemanticPublication(review, f.context)).planDigest, review.planDigest);
  for (const change of review.changes) assert.ok(validateStewardChange(review, change, JSON.parse(change.beforeValueJson), actor.urn));
  const prepared = await f.prepare(req);
  assert.equal(f.writes.targetWrites, 0);
  const result = await f.command(prepared, "approve_review");
  assert.equal(result.state, "ATTEMPTED");
  assert.equal(result.currentContext.status, "SOURCE_SCHEMA_REFERENCES_RECHECKED");
  const stored = kind === "dataset" ? f.state.dataset : f.state.definitions[urn];
  assert.equal(stored[catalogTypes[kind].editable].value.description, "Reviewed changed definition");
  assert.equal(stored.globalTags.value.tags.at(-1).tag, "urn:li:tag:Reviewed");
  if (kind !== "dataset") assert.deepEqual(stored[catalogTypes[kind].editable].value.unknown, { preserve: true });
  const writes = f.writes.targetWrites;
  const history = await f.command(result, "read_review");
  assert.equal(history.state, "ATTEMPTED");
  assert.equal(f.writes.targetWrites, writes);
  await assert.rejects(f.command(result, "approve_review"));
  assert.equal(f.writes.targetWrites, writes);
});

for (const kind of Object.keys(vocabularyTypes)) test(`Catalog definition ${kind}: create then update same URN, preserving unselected fields`, async () => {
  const f = fixture();
  const definition = { kind, operation: "create", name: `Fixture mainline ${kind}`, description: "Initial fixture definition",
    ...(["node", "term"].includes(kind) ? { parentUrn: "urn:li:glossaryNode:Commerce" } : {}),
    ...(kind === "property" ? { valueType: "string", cardinality: "SINGLE", entityTypes: ["dataset", "chart", "schemaField"], allowedValues: ["normal", "high"] } : {}),
  };
  const req = await f.definitionRequest(definition);
  const prepared = await f.prepare(req);
  const created = await f.command(prepared, "approve_review");
  const urn = created.preview.definition.proposedUrn, aspect = vocabularyTypes[kind].aspect;
  assert.equal(created.currentContext.status, "SOURCE_SCHEMA_REFERENCES_RECHECKED");
  const existing = f.state.definitions[urn][aspect];
  existing.value.extension = { preserved: ["native", "metadata"] };
  const update = { kind, operation: "update", urn, version: existing.systemMetadata.version, description: "Updated existing fixture definition" };
  const second = await f.prepare(await f.definitionRequest(update));
  assert.equal(second.preview.definition.proposedUrn, urn);
  assert.equal(second.preview.definition.operation, "PROPOSED_UPDATE");
  const published = await f.command(second, "approve_review");
  assert.equal(published.currentContext.status, "SOURCE_SCHEMA_REFERENCES_RECHECKED");
  assert.deepEqual(f.state.definitions[urn][aspect].value.extension, { preserved: ["native", "metadata"] });
  assert.equal(f.state.definitions[urn][aspect].value[["node", "term"].includes(kind) ? "definition" : "description"], update.description);
  assert.equal(f.state.definitions[urn][aspect].systemMetadata.version, "2");
});

test("association remove/set only changes selected values; field source metadata and annotations survive", async () => {
  const f = fixture();
  f.state.dataset.globalTags.value.tags[0].context = "human note";
  const originalSchema = structuredClone(f.state.dataset.schemaMetadata);
  const path = "order_id";
  f.state.dataset.editableSchemaMetadata.value.editableSchemaFieldInfo[0].globalTags = { tags: [{ tag: "urn:li:tag:Existing", context: "field human note" }] };
  const req = await f.request([{ kind: "tag", operation: "set", values: ["urn:li:tag:Existing", "urn:li:tag:Reviewed"], ...evidence },
    { kind: "term", operation: "remove", value: "urn:li:glossaryTerm:Order", ...evidence },
    { kind: "description", operation: "set", fieldPath: path, value: "Changed field description", ...evidence }]);
  const after = await f.command(await f.prepare(req), "approve_review");
  assert.equal(after.currentContext.status, "SOURCE_SCHEMA_REFERENCES_RECHECKED");
  assert.equal(f.state.dataset.globalTags.value.tags[0].context, "human note");
  assert.deepEqual(f.state.dataset.glossaryTerms.value.terms, []);
  assert.equal(f.state.dataset.editableSchemaMetadata.value.editableSchemaFieldInfo[0].globalTags.tags[0].context, "field human note");
  assert.deepEqual(f.state.dataset.schemaMetadata, originalSchema);
  const fieldReq = await f.request([{ kind: "property", operation: "set", fieldPath: path, value: "urn:li:structuredProperty:priority", values: ["high"], ...evidence }], datasetUrn, { fieldPath: path });
  const fieldResult = await f.command(await f.prepare(fieldReq), "approve_review");
  assert.equal(fieldResult.currentContext.status, "SOURCE_SCHEMA_REFERENCES_RECHECKED");
  assert.deepEqual(f.state.fields[catalogCandidateTarget(datasetUrn, fieldReq.candidates[0]).urn].structuredProperties.value.properties[0].values, [{ string: "high" }]);
});

test("no operator opt-in, revoked assets, unsupported properties, parent cycles and stale snapshots fail closed", async () => {
  const f = fixture();
  assert.doesNotThrow(() => ingestionPolicies({ [actor.key]: [f.policy] }));
  delete f.policy.semanticCatalogUpdatesApproved;
  await assert.rejects(f.inspect(), /not_configured/);
  f.policy.semanticCatalogUpdatesApproved = true;
  f.state.denied.add(datasetUrn);
  await assert.rejects(f.inspect(), /read_forbidden/);
  f.state.denied.clear();
  const req = await f.request([{ kind: "property", operation: "set", value: "urn:li:structuredProperty:priority", values: [42], ...evidence }]);
  await assert.rejects(compileSemanticPublication(req, f.context), /invalid_property/);
  const definition = { kind: "node", operation: "update", urn: "urn:li:glossaryNode:Commerce", version: "1", parentUrn: "urn:li:glossaryNode:Commerce" };
  await assert.rejects(compileSemanticPublication(await f.definitionRequest(definition), f.context), /parent_cycle/);
  const valid = await f.request([{ kind: "tag", operation: "add", value: "urn:li:tag:Reviewed", ...evidence }]);
  f.state.dataset.globalTags.systemMetadata.version = "2";
  await assert.rejects(compileSemanticPublication(valid, f.context), /snapshot_conflict/);
  assert.equal(f.writes.targetWrites, 0);
});

test("mutation protection rejects rewritten unknown fields, another asset, unapproved definitions and malformed legacy JSON", async () => {
  const f = fixture(), req = await f.request([{ kind: "description", operation: "set", value: "Reviewed definition", ...evidence }]);
  const review = await compileSemanticPublication(req, f.context), change = review.changes[0];
  const { planDigest: _digest, ...input } = review;
  assert.throws(() => makePublicationReview({ ...input, changes: [{ ...change, valueJson: canonical({ description: "Attacker changed intent" }) }] }), /outside_intent/);
  assert.equal(validateStewardChange(review, { ...change, urn: f.assets.chart }, JSON.parse(change.beforeValueJson), actor.urn), false);
  f.policy.semanticDefinitionUpdatesApproved = false;
  await assert.rejects(compileSemanticPublication(await f.definitionRequest({ kind: "tag", operation: "update", urn: "urn:li:tag:Reviewed", version: "1", description: "New description" }), f.context), /updates_not_authorized/);
  assert.equal(validateStewardChange({ purpose: "SEMANTIC", analysisVersion: "semantic-steward/1", semanticContextJson: "not-json" }, {}, null, actor.urn), false);
});

test("pending review marks referenced vocabulary and existing-definition revisions stale before approval", async () => {
  for (const definition of [false, true]) {
    const f = fixture();
    const request = definition
      ? await f.definitionRequest({ kind: "tag", operation: "update", urn: "urn:li:tag:Reviewed", version: "1", description: "Reviewed new definition" })
      : await f.request([{ kind: "tag", operation: "add", value: "urn:li:tag:Reviewed", ...evidence }]);
    const prepared = await f.prepare(request);
    f.state.definitions["urn:li:tag:Reviewed"].tagProperties.systemMetadata.version = "2";
    f.state.definitions["urn:li:tag:Reviewed"].tagProperties.value.description = "Concurrent human revision";
    const current = await f.command(prepared, "read_review");
    assert.equal(current.stale, true);
    await assert.rejects(f.command(current, "approve_review"));
    assert.equal(f.writes.targetWrites, 0);
  }
});

test("human reject writes no target; partial/lost acknowledgement cannot be replayed", async () => {
  const f = fixture();
  const candidates = [{ kind: "description", operation: "set", value: "Changed description", ...evidence }, { kind: "tag", operation: "add", value: "urn:li:tag:Reviewed", ...evidence }];
  const rejected = await f.command(await f.prepare(await f.request(candidates)), "reject_review");
  assert.equal(rejected.state, "REJECT"); assert.equal(f.writes.targetWrites, 0);
  const prepared = await f.prepare(await f.request(candidates));
  f.writes.lossAfter = 1;
  await assert.rejects(f.command(prepared, "approve_review"), (error) => error.message === "publication_write_unconfirmed" && error.reconciliation.targetRequestInvoked === true);
  const result = await f.command(prepared, "read_review");
  assert.equal(result.state, "ATTEMPTED"); assert.equal(f.writes.targetWrites, 1);
  const before = f.writes.submissions;
  await f.command(result, "read_review");
  await assert.rejects(f.command(result, "approve_review"));
  assert.equal(f.writes.submissions, before);
});

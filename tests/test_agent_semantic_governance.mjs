import assert from "node:assert/strict";
import test from "node:test";
import { semanticFixture, actor, datasetUrn, sourceUrn, envelope } from "./fixtures/semantic-fixture.mjs";
import { ingestionPolicies } from "../extensions/datahub-agent/integration/ingestion-policy.mjs";

const property = "urn:li:structuredProperty:priority";
const fieldPath = "[version=2.0].[type=struct].net.amount";
const fieldUrn = `urn:li:schemaField:(${datasetUrn},${fieldPath})`;
const owner = "urn:li:corpGroup:analytics";
const ownerRule = { urn: owner, type: "DATA_STEWARD", rule: "Approved analytics group stewards this source." };
const change = (extra = {}) => ({ kind: "property", value: property, values: ["high"], reason: "Fixture only", evidenceIds: ["dataset:source-description"], ...extra });
async function preview(f, candidates, selection = {}) {
  const snapshot = await f.run(selection);
  return f.run({ action: "preview", snapshotDigest: snapshot.snapshotDigest, candidates, ...selection });
}
function fieldFixture() {
  const f = semanticFixture();
  f.state.fields[fieldUrn] = { schemaFieldKey: envelope({ parent: datasetUrn, fieldPath }),
    structuredProperties: envelope({ properties: [{ propertyUrn: property, values: [{ string: "normal" }] }] }) };
  f.state.definitions[property].propertyDefinition.value.entityTypes.push("urn:li:entityType:datahub.schemaField");
  return f;
}
function governanceFixture() {
  const f = semanticFixture();
  f.policy.semanticOwners = [ownerRule];
  f.policy.semanticDocumentationOrigins = ["https://docs.example"];
  f.state.definitions[owner] = { corpGroupKey: envelope({ name: "analytics" }) };
  f.state.dataset.ownership = envelope({ owners: [{ owner: actor.urn, type: "TECHNICAL_OWNER" }] });
  f.state.dataset.institutionalMemory = envelope({ elements: [{ url: "https://docs.example/existing", description: "Human document", createStamp: { actor: actor.urn, time: 1 } }] });
  return f;
}

test("operator owner/documentation rules are validated, copied and immutable; absence grants nothing", () => {
  const f = governanceFixture();
  const policy = ingestionPolicies({ [actor.key]: [f.policy] }).get(actor.key)[0];
  assert.ok(Object.isFrozen(policy.semanticOwners[0]));
  assert.ok(Object.isFrozen(policy.semanticDocumentationOrigins));
  for (const extra of [
    { semanticOwners: [{ ...ownerRule, type: "ADMIN" }] }, { semanticOwners: [{ ...ownerRule, rule: " " }] },
    { semanticOwners: [{ ...ownerRule, urn: "urn:li:dataset:wrong" }] }, { semanticOwners: [ownerRule, ownerRule] },
    { semanticOwners: [{ ...ownerRule, allowOverwrite: true }] },
    { semanticDocumentationOrigins: ["http://docs.example"] }, { semanticDocumentationOrigins: ["https://docs.example/path"] },
    { semanticDocumentationOrigins: ["https://user:password@docs.example"] },
  ]) assert.throws(() => ingestionPolicies({ [actor.key]: [{ ...f.policy, ...extra }] }), /invalid_ingestion_policy/);
});

test("column property reads and candidates bind exact parent, field path, ACL and aspect version", async () => {
  const f = fieldFixture(), before = structuredClone(f.state.fields);
  const inspected = await f.run({ fieldPath });
  assert.equal(inspected.selectedField.urn, fieldUrn);
  assert.equal(inspected.selectedField.materialized, true);
  assert.deepEqual(inspected.selectedField.properties[0].values, ["normal"]);
  const result = await f.run({ action: "preview", fieldPath, snapshotDigest: inspected.snapshotDigest, candidates: [change({ fieldPath })] });
  assert.deepEqual(result.changes[0].before, ["normal"]);
  assert.deepEqual(result.changes[0].after, ["high"]);
  assert.deepEqual(result.changes[0].conflicts, ["existing_property_value_protected"]);
  assert.equal(result.publicationAuthorized, false);
  assert.deepEqual(f.state.fields, before);
  f.state.fields[fieldUrn].structuredProperties.systemMetadata.version = "2";
  await assert.rejects(f.run({ action: "preview", fieldPath, snapshotDigest: inspected.snapshotDigest, candidates: [change({ fieldPath })] }), /semantic_snapshot_conflict/);
  f.state.denied.add(fieldUrn);
  await assert.rejects(f.run({ fieldPath }), /semantic_read_forbidden/);
});

test("field properties reject unselected field, absent schema path, wrong key, removed field and unsupported definition", async () => {
  await assert.rejects(preview(fieldFixture(), [change({ fieldPath })]), /semantic_field_snapshot_required/);
  for (const mutate of [
    (f) => { f.state.fields[fieldUrn].schemaFieldKey.value.parent = "other"; },
    (f) => { f.state.fields[fieldUrn].schemaFieldKey.value.fieldPath = "net.amount"; },
    (f) => { f.state.fields[fieldUrn].status = envelope({ removed: true }); },
    (f) => { delete f.state.fields[fieldUrn].schemaFieldKey; },
  ]) { const f = fieldFixture(); mutate(f); await assert.rejects(f.run({ fieldPath }), /semantic_field_binding_conflict|semantic_field_removed/); }
  const f = fieldFixture();
  await assert.rejects(f.run({ fieldPath: "net.amount" }), /semantic_invalid_field/);
  f.state.definitions[property].propertyDefinition.value.entityTypes = ["urn:li:entityType:datahub.dataset"];
  await assert.rejects(preview(f, [change({ fieldPath })], { fieldPath }), /semantic_invalid_property/);
  f.state.definitions[property].propertyDefinition.value.entityTypes.push("urn:li:entityType:datahub.schemaField");
  f.state.definitions[property].propertyDefinition.value.immutable = true;
  await assert.rejects(preview(f, [change({ fieldPath })], { fieldPath }), /semantic_immutable_property/);
});

test("native field encoding preserves v2 and detects percent/reserved collisions instead of normalizing fields", async () => {
  const f = semanticFixture();
  const path = "quoted,(列)";
  f.state.dataset.schemaMetadata.value.fields.push({ fieldPath: path });
  const result = await f.run({ fieldPath: path });
  assert.equal(result.selectedField.urn, `urn:li:schemaField:(${datasetUrn},quoted%2C%28列%29)`);
  assert.equal(result.selectedField.materialized, false);
  assert.equal(result.selectedField.propertiesVersion, "-1");
  f.state.dataset.schemaMetadata.value.fields.push({ fieldPath: "quoted%2C%28列%29" });
  await assert.rejects(f.run({ fieldPath: path }), /semantic_field_encoding_ambiguous/);
  f.state.dataset.schemaMetadata.value.fields.push({ fieldPath: "a␟b" });
  await assert.rejects(f.run({ fieldPath: "a␟b" }), /semantic_field_encoding_unsupported/);
});

test("ownership needs a bound organizational rule and live owner reference; existing owners remain intact", async () => {
  const f = governanceFixture(), before = structuredClone(f.state.dataset);
  const candidate = change({ kind: "owner", value: owner, values: undefined, ownerType: "DATA_STEWARD", evidenceIds: ["policy:owner:0"] });
  const result = await preview(f, [candidate]);
  assert.deepEqual(result.changes[0].after, [{ owner: actor.urn, type: "TECHNICAL_OWNER" }, { owner, type: "DATA_STEWARD" }]);
  assert.deepEqual(f.state.dataset, before);
  await assert.rejects(preview(f, [{ ...candidate, evidenceIds: ["dataset:source-description"] }]), /semantic_owner_policy_required/);
  await assert.rejects(preview(f, [{ ...candidate, ownerType: "BUSINESS_OWNER" }]), /semantic_owner_policy_required/);
  f.state.denied.add(owner);
  await assert.rejects(preview(f, [candidate]), /semantic_read_forbidden/);
  f.state.denied.clear(); f.state.definitions[owner].status = envelope({ removed: true });
  await assert.rejects(preview(f, [candidate]), /semantic_reference_removed/);
});

test("documents are approved-origin HTTPS references, never fetched; human text cannot be overwritten", async () => {
  const f = governanceFixture(), before = structuredClone(f.state.dataset);
  const candidate = change({ kind: "documentation", value: "https://docs.example/definitions", values: undefined, description: "Reviewed business definitions" });
  const result = await preview(f, [candidate]);
  assert.equal(result.changes[0].after.length, 2);
  assert.deepEqual(result.changes[0].before, [{ url: "https://docs.example/existing", description: "Human document" }]);
  assert.deepEqual(f.state.dataset, before);
  for (const value of ["javascript:alert(1)", "https://unapproved.example/page", "http://docs.example/page", "https://user:password@docs.example/page", "https://docs.example/page?token=secret", "https://docs.example/page#token"]) {
    await assert.rejects(preview(f, [{ ...candidate, value }]), /semantic_documentation_policy_required/);
  }
  await assert.rejects(preview(f, [{ ...candidate, value: "https://docs.example/existing" }]), /semantic_existing_documentation_protected/);
  const same = await preview(f, [{ ...candidate, value: "https://docs.example/existing", description: "Human document" }]);
  assert.equal(same.changes[0].operation, "NO_CHANGE");
  const snapshot = await f.run(); f.policy.semanticDocumentationOrigins = [];
  await assert.rejects(f.run({ action: "preview", snapshotDigest: snapshot.snapshotDigest, candidates: [candidate] }), /semantic_snapshot_conflict/);
});

test("impact is a paged native dependency observation with ACL/model-scope redaction, not global approval", async () => {
  const f = semanticFixture(), second = "urn:li:dataset:(urn:li:dataPlatform:mssql,Fixture.reporting.customers,DEV)";
  f.policy.taskDatasets.push(second);
  f.state.impactRows = [datasetUrn, second, "urn:li:dataset:PRIVATE", "urn:li:chart:PRIVATE"].map((urn) => ({ type: "TaggedWith", direction: "INCOMING", entity: { urn } }));
  const result = await f.run({ action: "inspect_impact", kind: "tag", referenceUrn: "urn:li:tag:Existing" });
  assert.deepEqual(result.impact.references.map((r) => r.urn), [datasetUrn, second]);
  assert.equal(result.impact.references[1].outsideContextDataset, true);
  assert.equal(result.impact.hiddenOrUnapprovedReferencesOmitted, true);
  assert.equal(result.impact.sharedDefinitionImpactVerified, false);
  assert.equal(result.impact.sharedDefinitionUpdateAuthorized, false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  f.state.denied.add(second);
  assert.equal((await f.run({ action: "inspect_impact", kind: "tag", referenceUrn: "urn:li:tag:Existing" })).impact.references.length, 1);
});

test("dependency paging pins definition versions; graph direction/type and property public EXISTS filter are checked", async () => {
  const f = semanticFixture();
  f.state.impactRows = Array.from({ length: 23 }, () => ({ type: "IsPartOf", direction: "INCOMING", entity: { urn: "urn:li:glossaryTerm:Order" } }));
  const request = { action: "inspect_impact", kind: "node", referenceUrn: "urn:li:glossaryNode:Commerce" };
  const first = await f.run(request);
  assert.equal(first.impact.nextStart, 20);
  await assert.rejects(f.run({ ...request, start: 20 }), /invalid_semantic_request/);
  const last = await f.run({ ...request, start: 20, definitionVersion: "1" });
  assert.equal(last.impact.references.length, 3);
  f.state.definitions[request.referenceUrn].glossaryNodeInfo.systemMetadata.version = "2";
  await assert.rejects(f.run({ ...request, start: 20, definitionVersion: "1" }), /semantic_definition_version_conflict/);
  f.state.impactRows[0].direction = "OUTGOING";
  await assert.rejects(f.run(request), /semantic_impact_invalid/);
  f.state.impactRows = [{ entity: { urn: datasetUrn } }];
  const propertyImpact = await f.run({ action: "inspect_impact", kind: "property", referenceUrn: property });
  assert.equal(propertyImpact.impact.basis, "current_property_search_index");
  assert.equal(propertyImpact.impact.references[0].urn, datasetUrn);
  assert.ok(propertyImpact.impact.limitations.includes("historical_property_versions_not_enumerated"));
  const query = f.state.calls.findLast((c) => c.body?.variables?.input?.orFilters);
  assert.equal(query.body.variables.input.orFilters[0].and[0].field, "structuredProperties.priority");
});

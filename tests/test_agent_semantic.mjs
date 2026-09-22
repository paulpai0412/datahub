import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { nativeSemantic } from "../extensions/datahub-agent/integration/native-semantic.mjs";
import { ingestionPolicies } from "../extensions/datahub-agent/integration/ingestion-policy.mjs";
import semanticExtension from "../extensions/datahub-agent/pi-web/lib/datahub-semantic-extension.ts";
import { semanticFixture, sourceUrn, datasetUrn, requestId, actor, envelope } from "./fixtures/semantic-fixture.mjs";

const candidate = (extra = {}) => ({ kind: "description", value: "Proposed order description", reason: "Based on the existing source description", evidenceIds: ["dataset:source-description"], ...extra });
async function preview(f, candidates) {
  const inspected = await f.run();
  return f.run({ action: "preview", snapshotDigest: inspected.snapshotDigest, candidates });
}

test("policy opt-in is explicit, typed, and preserves existing ingestion compatibility", () => {
  const f = semanticFixture();
  for (const flag of [true, false, undefined]) {
    const policy = { ...f.policy };
    if (flag === undefined) delete policy.semanticModelContextApproved;
    else policy.semanticModelContextApproved = flag;
    assert.equal(ingestionPolicies({ [actor.key]: [policy] }).get(actor.key)[0].semanticModelContextApproved, flag);
  }
  assert.throws(() => ingestionPolicies({ [actor.key]: [{ ...f.policy, semanticModelContextApproved: "true" }] }));
});

test("lists only explicitly model-approved sources; no Dataset reads in listing", async () => {
  const f = semanticFixture();
  const run = () => nativeSemantic(JSON.stringify({ action: "list_sources", requestId }), f.context);
  assert.deepEqual((await run()).sources.map((s) => s.urn), [sourceUrn]);
  delete f.policy.semanticModelContextApproved;
  assert.deepEqual((await run()).sources, []);
  assert.ok(f.state.calls.every((c) => c.path === "/api/v2/graphql" || c.path === "/openapi/v3/entity/datahubingestionsource/batchGet"));
});

test("source subset never claims full ingestion inventory or exposes recipe", async () => {
  const f = semanticFixture();
  const result = await nativeSemantic(JSON.stringify({ action: "inspect_source", requestId, sourceUrn }), f.context);
  assert.equal(result.scope.basis, "operator_allowlist_subset");
  assert.equal(result.scope.ingestionMembershipVerified, false);
  assert.equal(result.scope.completeSourceInventory, false);
  assert.equal(result.publicationAuthorized, false);
  assert.doesNotMatch(JSON.stringify(result), /SOURCE_PASSWORD|DATAHUB_TOKEN/);
  delete f.policy.taskDatasets;
  const empty = await nativeSemantic(JSON.stringify({ action: "inspect_source", requestId, sourceUrn }), f.context);
  assert.ok(empty.blockers.includes("source_asset_scope_not_configured"));
});

test("inventory projects exact field paths and existing human content; excludes arbitrary metadata", async () => {
  const f = semanticFixture();
  const before = structuredClone(f.state.dataset);
  const result = await f.run();
  assert.equal(result.current.description, "Human maintained fixture definition");
  assert.equal(result.fields[1].fieldPath, "[version=2.0].[type=struct].net.amount");
  assert.deepEqual(result.current.properties[0].values, ["normal"]);
  assert.equal(result.gaps.fieldsWithoutDescription, 0);
  assert.equal(result.gaps.propertyRequirementsKnown, false);
  assert.doesNotMatch(JSON.stringify(result), /NOT_FOR_MODEL|SOURCE_PASSWORD|DATAHUB_TOKEN/);
  assert.deepEqual(f.state.dataset, before);
});

test("field pages bind the full snapshot; cannot stitch changed schema or human metadata", async () => {
  const f = semanticFixture();
  f.state.dataset.schemaMetadata.value.fields = Array.from({ length: 23 }, (_, i) => ({ fieldPath: `f${i}` }));
  const first = await f.run();
  assert.equal(first.fields.length, 20);
  assert.equal(first.nextOffset, 20);
  const last = await f.run({ offset: 20, snapshotDigest: first.snapshotDigest });
  assert.equal(last.fields.length, 3);
  assert.equal(last.nextOffset, null);
  assert.equal(last.snapshotDigest, first.snapshotDigest);
  assert.ok(last.evidence.every((e) => !e.id.startsWith("field:") || Number(e.id.split(":")[1]) >= 20));
  await assert.rejects(f.run({ offset: 20 }), /invalid_semantic_request/);
  await assert.rejects(f.run({ offset: 25, snapshotDigest: first.snapshotDigest }), /semantic_invalid_page/);
  f.state.dataset.editableDatasetProperties = envelope({ description: "Concurrent human edit" }, "2");
  await assert.rejects(f.run({ offset: 20, snapshotDigest: first.snapshotDigest }), /semantic_snapshot_conflict/);
  await assert.rejects(f.run({ action: "preview", snapshotDigest: first.snapshotDigest, candidates: [candidate()] }), /semantic_snapshot_conflict/);
});

test("preview preserves existing edited value as conflict, and remains unapproved", async () => {
  const f = semanticFixture();
  const before = structuredClone(f.state.dataset);
  const result = await preview(f, [candidate(), candidate({ fieldPath: "order_id", value: "Same source key", evidenceIds: ["field:0:source-description"] })]);
  assert.equal(result.changes[0].before, "Human maintained fixture definition");
  assert.deepEqual(result.changes[0].conflicts, ["existing_edited_value_protected"]);
  assert.equal(result.changes[1].before, "Human: source key");
  for (const change of result.changes) {
    assert.equal(change.businessMeaningVerified, false);
    assert.equal(change.requiresHumanReview, true);
    assert.equal(change.evidenceAssessment, "LOCATION_VERIFIED_MEANING_UNVERIFIED");
  }
  assert.equal(result.publicationAuthorized, false);
  assert.deepEqual(f.state.dataset, before);
});

test("references use proper GraphQL enums, preserve associations and detect NO_CHANGE", async () => {
  const f = semanticFixture();
  const result = await preview(f, [
    candidate({ kind: "domain", value: "urn:li:domain:Sales" }),
    candidate({ kind: "tag", value: "urn:li:tag:Reviewed" }),
    candidate({ kind: "term", value: "urn:li:glossaryTerm:Order" }),
    candidate({ kind: "property", value: "urn:li:structuredProperty:priority", values: ["normal"] }),
  ]);
  assert.deepEqual(result.changes.map((c) => c.operation), ["NO_CHANGE", "PROPOSED", "NO_CHANGE", "NO_CHANGE"]);
  assert.deepEqual(result.changes[1].after, ["urn:li:tag:Existing", "urn:li:tag:Reviewed"]);
  assert.equal(result.changes[2].definition.description, "Fixture order term");
});

test("field associations include ingested values, preventing duplicate editable additions", async () => {
  const f = semanticFixture();
  f.state.dataset.schemaMetadata.value.fields[0].glossaryTerms = { terms: [{ urn: "urn:li:glossaryTerm:Order" }] };
  const result = await preview(f, [candidate({ kind: "term", value: "urn:li:glossaryTerm:Order", fieldPath: "order_id" })]);
  assert.equal(result.changes[0].operation, "NO_CHANGE");
});

test("property assignment supports native numbers and rejects invalid or unsupported constraints", async () => {
  const numeric = semanticFixture();
  Object.assign(numeric.state.definitions["urn:li:structuredProperty:priority"].propertyDefinition.value, {
    valueType: "urn:li:dataType:datahub.number", allowedValues: [{ value: { double: 7 } }],
  });
  numeric.state.dataset.structuredProperties.value.properties[0].values = [{ double: 7 }];
  const same = await preview(numeric, [candidate({ kind: "property", value: "urn:li:structuredProperty:priority", values: [7] })]);
  assert.equal(same.changes[0].operation, "NO_CHANGE");
  assert.deepEqual(same.changes[0].before, [7]);
  const cases = [
    { values: [123] }, { values: ["urgent"] }, { values: ["normal", "high"] },
    { values: ["high"], definition: { immutable: true } },
    { values: ["high"], definition: { valueType: "urn:li:dataType:datahub.date" } },
    { values: ["high"], definition: { allowedPlatforms: ["urn:li:dataPlatform:hive"] } },
    { values: ["high"], definition: { entityTypes: ["urn:li:entityType:datahub.schemaField"] } },
    { values: ["high", "high"], definition: { cardinality: "MULTIPLE" } },
  ];
  for (const item of cases) {
    const f = semanticFixture();
    Object.assign(f.state.definitions["urn:li:structuredProperty:priority"].propertyDefinition.value, item.definition);
    await assert.rejects(preview(f, [candidate({ kind: "property", value: "urn:li:structuredProperty:priority", values: item.values })]), /semantic_(invalid_property|immutable_property|property_constraints_unsupported)/);
  }
});

test("unbound evidence, unsupported operations, duplicate proposals and wrong fields fail", async () => {
  for (const changes of [
    [candidate({ evidenceIds: ["fabricated"] })], [candidate({ evidenceIds: [] })],
    [candidate({ fieldPath: "net.amount" })], [candidate({ kind: "delete" })],
    [candidate({ kind: "node", value: "urn:li:glossaryNode:Commerce" })],
    [candidate(), candidate()], [candidate({ kind: "domain", fieldPath: "order_id", value: "urn:li:domain:Sales" })],
    [candidate({ value: " " })], [candidate({ actor: "admin" })],
  ]) await assert.rejects(preview(semanticFixture(), changes), /semantic_(invalid|duplicate)/);
});

test("cross actor/source/asset, revoked grant, recipe drift, ACL and deleted objects fail closed", async () => {
  const f = semanticFixture();
  await assert.rejects(f.run({ datasetUrn: "urn:li:dataset:outside" }), /not_authorized/);
  assert.ok(f.state.calls.every((c) => !c.path.includes("/dataset/")));
  f.state.meUrn = "urn:li:corpuser:other";
  await assert.rejects(f.run(), /semantic_identity_required/);
  f.state.meUrn = actor.urn;
  f.state.active = false;
  await assert.rejects(f.run(), /grant_revoked/);
  f.state.active = true;
  f.state.recipe += " ";
  await assert.rejects(f.run(), /source_revision_conflict/);
  for (const mode of ["acl", "removed", "reference-acl", "reference-removed", "model-context"]) {
    const x = semanticFixture();
    if (mode === "acl") x.state.denied.add(datasetUrn);
    if (mode === "removed") x.state.dataset.status.value.removed = true;
    if (mode === "reference-acl") x.state.denied.add("urn:li:domain:Sales");
    if (mode === "reference-removed") x.state.definitions["urn:li:domain:Sales"].status.value.removed = true;
    if (mode === "model-context") delete x.policy.semanticModelContextApproved;
    await assert.rejects(preview(x, [candidate({ kind: "domain", value: "urn:li:domain:Sales" })]), /forbidden|removed|not_approved/);
  }
});

test("malformed Catalog and oversized output are not truncated successful previews", async () => {
  for (const mutate of [
    (s) => { s.dataset.globalTags.value.tags = "invalid"; },
    (s) => { s.dataset.schemaMetadata.value.fields.push(s.dataset.schemaMetadata.value.fields[0]); },
    (s) => { delete s.dataset.schemaMetadata; },
    (s) => { s.dataset.datasetKey.systemMetadata.version = ""; },
    (s) => { s.dataset.datasetKey.systemMetadata.version = 1; },
    (s) => { s.dataset.schemaMetadata.systemMetadata.pipelineName = { excluded: "NOT_FOR_MODEL" }; },
    (s) => { s.dataset.datasetProperties.value.description = "x".repeat(48000); },
  ]) {
    const f = semanticFixture(); mutate(f.state);
    await assert.rejects(f.run(), /semantic_(catalog_invalid|catalog_incomplete|response_too_large)/);
  }
});

test("arbitrary action, endpoint, actor, fields and oversized intents rejected before I/O", async () => {
  const f = semanticFixture();
  for (const request of [{ action: "publish" }, { actor: "admin" }, { endpoint: "http://secret.invalid" }, { sourceUrn: "x".repeat(25000) }]) {
    await assert.rejects(f.run(request), /invalid_semantic_request/);
  }
  assert.equal(f.state.calls.length, 0);
});

test("actual Pi extension discovers Skill and reaches native Host without SDK/model/credentials", async () => {
  let tool, discover;
  semanticExtension({ on(name, handler) { assert.equal(name, "resources_discover"); discover = handler; }, registerTool(value) { tool = value; } });
  const path = discover().skillPaths[0];
  assert.match(await readFile(path, "utf8"), /name: datahub-semantic/);
  assert.equal(tool.name, "datahub_semantic");
  const f = semanticFixture();
  const ctx = { mode: "rpc", ui: { async input(title, body) {
    assert.equal(title, "DataHub semantic request");
    return JSON.stringify(await nativeSemantic(body, f.context));
  } } };
  const result = await tool.execute("test", { action: "inspect_dataset", sourceUrn, datasetUrn }, undefined, undefined, ctx);
  assert.equal(result.details.current.description, "Human maintained fixture definition");
  assert.deepEqual(JSON.parse(result.content[0].text), result.details);
  assert.deepEqual(JSON.parse(JSON.stringify(result)).details, result.details, "native tool details persist without a custom state store");
  await assert.rejects(tool.execute("test", { action: "list_sources" }, undefined, undefined, { mode: "tui" }), /datahub_host_required/);
  for (const response of [undefined, "{", JSON.stringify({ error: "server detail with secrets" }), JSON.stringify({ requestId: "other", publicationAuthorized: true })]) {
    await assert.rejects(tool.execute("test", { action: "list_sources" }, undefined, undefined, { mode: "rpc", ui: { input: async () => response } }), /semantic_/);
  }
  const abort = new AbortController(); abort.abort();
  await assert.rejects(tool.execute("test", { action: "list_sources" }, abort.signal, undefined, ctx), { name: "AbortError" });
});

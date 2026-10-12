/** Export actual compiler output for the pinned Core Pegasus codec; synthetic, no writes. */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { semanticPublicationFixture } from "./fixtures/semantic-publication-fixture.mjs";
import { semanticCatalogFixture, catalogEvidence } from "./fixtures/semantic-catalog-fixture.mjs";
import { vocabularyTypes } from "../extensions/datahub-agent/integration/semantic-catalog-contract.mjs";
import { actor, sourceUrn, datasetUrn, requestId, envelope } from "./fixtures/semantic-fixture.mjs";
import { compileSemanticPublication } from "../extensions/datahub-agent/integration/semantic-publication.mjs";
const output = process.argv[2]; assert.ok(output, "output JSON path required");
const classes = {
  editableDatasetProperties: "dataset.EditableDatasetProperties", editableSchemaMetadata: "schema.EditableSchemaMetadata",
  editableContainerProperties: "container.EditableContainerProperties", editableDataFlowProperties: "datajob.EditableDataFlowProperties",
  editableDataJobProperties: "datajob.EditableDataJobProperties", editableChartProperties: "chart.EditableChartProperties", editableDashboardProperties: "dashboard.EditableDashboardProperties",
  globalTags: "common.GlobalTags", glossaryTerms: "common.GlossaryTerms", domains: "domain.Domains",
  structuredProperties: "structured.StructuredProperties", ownership: "common.Ownership", institutionalMemory: "common.InstitutionalMemory",
  schemaFieldKey: "metadata.key.SchemaFieldKey", domainKey: "metadata.key.DomainKey", domainProperties: "domain.DomainProperties",
  glossaryNodeKey: "metadata.key.GlossaryNodeKey", glossaryNodeInfo: "glossary.GlossaryNodeInfo",
  glossaryTermKey: "metadata.key.GlossaryTermKey", glossaryTermInfo: "glossary.GlossaryTermInfo",
  tagKey: "metadata.key.TagKey", tagProperties: "tag.TagProperties",
  structuredPropertyKey: "metadata.key.StructuredPropertyKey", propertyDefinition: "structured.StructuredPropertyDefinition",
};
const shapes = [];
async function capture(f, intent, extra = {}) {
  const inspected = await f.run(extra);
  const review = await compileSemanticPublication({ action: intent.definition ? "preview_definition" : "preview", sourceUrn, datasetUrn, requestId,
    snapshotDigest: inspected.snapshotDigest, ...extra, ...intent }, f.context);
  for (const change of review.changes) {
    assert.ok(classes[change.aspect], change.aspect);
    shapes.push({ aspect: change.aspect, recordClass: `com.linkedin.${classes[change.aspect]}`, value: JSON.parse(change.valueJson) });
  }
  assert.equal(f.writes.recordWrites, 0); assert.equal(f.writes.submissions, 0);
}
const f = semanticPublicationFixture();
for (const aspect of ["editableDatasetProperties", "domains", "glossaryTerms", "structuredProperties"]) delete f.state.dataset[aspect];
f.policy.semanticOwners = [{ urn: actor.urn, type: "DATA_STEWARD", rule: "Fixture owner rule" }];
f.policy.semanticDocumentationOrigins = ["https://docs.example.test"];
f.state.definitions[actor.urn] = { corpUserKey: envelope({ username: "semantic-fixture" }), corpUserStatus: envelope({ active: true }) };
const base = { reason: "Synthetic codec fixture", evidenceIds: ["dataset:source-description"] };
await capture(f, { candidates: [
  { ...base, kind: "description", value: "Dataset meaning" },
  { ...base, kind: "description", fieldPath: "[version=2.0].[type=struct].net.amount", value: "Field meaning" },
  { ...base, kind: "tag", value: "urn:li:tag:Reviewed" },
  { ...base, kind: "term", value: "urn:li:glossaryTerm:Order" },
  { ...base, kind: "domain", value: "urn:li:domain:Sales" },
  { ...base, kind: "property", value: "urn:li:structuredProperty:priority", values: ["high"] },
  { ...base, kind: "owner", value: actor.urn, ownerType: "DATA_STEWARD", evidenceIds: ["policy:owner:0"] },
  { ...base, kind: "documentation", value: "https://docs.example.test/catalog", description: "Reference" },
] });
const field = semanticPublicationFixture();
field.state.definitions["urn:li:structuredProperty:priority"].propertyDefinition.value.entityTypes = ["urn:li:entityType:datahub.schemaField"];
await capture(field, { candidates: [{ ...base, kind: "property", fieldPath: "order_id", value: "urn:li:structuredProperty:priority", values: ["high"] }] }, { fieldPath: "order_id" });
const numeric = semanticPublicationFixture();
numeric.state.definitions["urn:li:structuredProperty:amount"] = { propertyDefinition: envelope({ qualifiedName: "amount", displayName: "Amount",
  valueType: "urn:li:dataType:datahub.number", cardinality: "SINGLE", entityTypes: ["urn:li:entityType:datahub.dataset"] }) };
await capture(numeric, { candidates: [{ ...base, kind: "property", value: "urn:li:structuredProperty:amount", values: [12.5] }] });
for (const kind of ["domain", "node", "term", "tag", "property", "number-property"]) {
  const def = semanticPublicationFixture(); def.policy.semanticDefinitionCreationApproved = true;
  await capture(def, { ...base, definition: { kind: kind === "number-property" ? "property" : kind, name: `Codec ${kind}`, description: "Synthetic native shape",
    ...(kind === "property" ? { valueType: "string", cardinality: "SINGLE", allowedValues: ["low", "high"] } : {}),
    ...(kind === "number-property" ? { valueType: "number", cardinality: "MULTIPLE", allowedValues: [1.5, 2.5] } : {}),
    ...(["node", "term"].includes(kind) ? { parentUrn: "urn:li:glossaryNode:Commerce" } : {}),
  } });
}
const catalog = semanticCatalogFixture();
// Unknown future-field sentinels belong to preservation tests, not this pinned
// schema codec check. Remove them from the fixture BEFORE compiling anything.
for (const row of Object.values(catalog.state.definitions)) for (const aspect of Object.values(row)) delete aspect.value.unknown;
async function captureCatalog(request) {
  const review = await compileSemanticPublication(request, catalog.context);
  for (const change of review.changes) {
    assert.ok(classes[change.aspect], change.aspect);
    shapes.push({ aspect: change.aspect, recordClass: `com.linkedin.${classes[change.aspect]}`, value: JSON.parse(change.valueJson) });
  }
  shapes.push({ aspect: "ekopAgentPublicationReview", recordClass: "com.ekop.agent.EkopAgentPublicationReview", value: review });
  return review;
}
for (const urn of Object.values(catalog.assets)) await captureCatalog(await catalog.request([
  { ...catalogEvidence, kind: "description", operation: "set", value: "Reviewed Catalog description" },
  { ...catalogEvidence, kind: "tag", operation: "add", value: "urn:li:tag:Reviewed" },
  { ...catalogEvidence, kind: "term", operation: "remove", value: "urn:li:glossaryTerm:Order" },
  { ...catalogEvidence, kind: "domain", operation: "set", values: [] },
  { ...catalogEvidence, kind: "property", operation: "set", value: "urn:li:structuredProperty:priority", values: ["high"] },
], urn));
for (const kind of Object.keys(vocabularyTypes)) {
  const definition = { kind, operation: "create", name: `Catalog codec ${kind}`, description: "Catalog codec fixture",
    ...(["node", "term"].includes(kind) ? { parentUrn: "urn:li:glossaryNode:Commerce" } : {}),
    ...(kind === "property" ? { valueType: "number", cardinality: "SINGLE", entityTypes: ["dataset", "schemaField", "container", "dataFlow", "dataJob", "chart", "dashboard"], allowedValues: [1.5, 2.5] } : {}) };
  const created = await captureCatalog(await catalog.definitionRequest(definition));
  const change = created.changes[0];
  catalog.state.definitions[change.urn] = { [change.aspect]: envelope(JSON.parse(change.valueJson)) };
  await captureCatalog(await catalog.definitionRequest({ kind, operation: "update", urn: change.urn, version: "1", description: "Updated same Catalog definition" }));
}
await captureCatalog(await catalog.request([{ ...catalogEvidence, kind: "property", operation: "set", fieldPath: "order_id", value: "urn:li:structuredProperty:priority", values: ["high"] }], datasetUrn, { fieldPath: "order_id" }));
assert.equal(catalog.writes.recordWrites, 0); assert.equal(catalog.writes.submissions, 0);
await writeFile(output, JSON.stringify(shapes, null, 2) + "\n");
console.log(JSON.stringify({ shapes: shapes.length, distinctAspects: new Set(shapes.map((x) => x.aspect)).size, simulatedWrites: 0, liveCalls: 0 }));

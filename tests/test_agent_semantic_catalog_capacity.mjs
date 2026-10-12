import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { loadSemanticReview } from "../extensions/datahub-agent/mfe/semantic-review.js";
import { maintenanceSelection } from "../extensions/datahub-agent/integration/semantic-maintenance-plan.mjs";
import { semanticCatalogFixture } from "./fixtures/semantic-catalog-fixture.mjs";
import { actor, datasetUrn, sourceUrn, envelope } from "./fixtures/semantic-fixture.mjs";
import { compileCatalogPublication, recompileCatalogPublication } from "../extensions/datahub-agent/integration/semantic-catalog-publication.mjs";
import { inspectCatalogIntent } from "../extensions/datahub-agent/integration/native-semantic-catalog.mjs";
import { canonicalPublicationJson as canonical, validatePublicationReview, compactCatalogPreview, expandCatalogPreview, publicationReviewDigest } from "../extensions/datahub-agent/integration/publication-review.mjs";

async function wideProposal() {
  const f = semanticCatalogFixture(), term = "urn:li:glossaryTerm:DetailedTerm", node = "urn:li:glossaryNode:DetailedGroup";
  f.state.definitions[node] = { glossaryNodeInfo: envelope({ name: "共用業務詞彙", definition: "受控合成階層說明。".repeat(170) }), status: envelope({ removed: false }) };
  f.state.definitions[term] = { glossaryTermInfo: envelope({ name: "完整合成詞彙", definition: "繁體中文的受控定義與限制。".repeat(145), parentNode: node }), status: envelope({ removed: false }) };
  f.state.dataset.schemaMetadata.value.fields = Array.from({ length: 27 }, (_, i) => ({ fieldPath: `field_${i}`, nativeDataType: "bigint", description: "合成欄位證據" }));
  const candidates = f.state.dataset.schemaMetadata.value.fields.map(({ fieldPath }) => ({ kind: "term", operation: "add", fieldPath, value: term, reason: "受控合成證據；不冒充真實語義", evidenceIds: ["asset:identity"] }));
  const request = await f.request(candidates);
  const planning = { runUrn: `urn:li:dataProcessInstance:semantic-${actor.key}-00000000-0000-4000-8000-000000000031`, definitions: {}, priorChanges: [], governance: { sourceUrn, focus: "all", assetScopeBasis: "NATIVE_TASK_SELECTED_ASSETS" } };
  return { f, request, planning };
}

test("27 field candidates with repeated full Chinese definition paths fit without dropping intent or increasing review limits", async () => {
  const { f, request, planning } = await wideProposal();
  const original = (await inspectCatalogIntent(request, f.context, { governance: planning.governance })).preview;
  assert(original.changes.length === 27);
  const review = await compileCatalogPublication(request, f.context, { planning, expiresAt: Number.MAX_SAFE_INTEGER });
  assert(review.semanticContextJson.length <= 80000);
  assert(Buffer.byteLength(canonical(review)) <= 131072);
  assert.equal(review.candidateIds.length, 27);
  assert.equal(review.changes.length, 1);
  const after = JSON.parse(review.changes[0].valueJson);
  for (const { fieldPath } of request.candidates) assert(after.editableSchemaFieldInfo.find(x => x.fieldPath === fieldPath).glossaryTerms.terms.some(t => t.urn === request.candidates[0].value));
  assert.deepEqual(after.editableSchemaFieldInfo[0], f.state.dataset.editableSchemaMetadata.value.editableSchemaFieldInfo[0]);
  validatePublicationReview(review);
  const { asOf: _clock, reviewPolicy: _guidance, ...stable } = original;
  assert.deepEqual(expandCatalogPreview(JSON.parse(review.semanticContextJson).preview), stable);
  assert.equal((await recompileCatalogPublication(review, f.context)).planDigest, review.planDigest);
  assert.equal(f.writes.targetWrites, 0);
  assert.equal(f.writes.recordWrites, 0);
});

test("definition context encoding is lossless, content-keyed and rejects altered or missing references", () => {
  const definition = { urn: "urn:li:glossaryTerm:Same", kind: "term", name: "共同名稱", hierarchy: [{ urn: "urn:li:glossaryNode:A", name: "階層 A" }] };
  const otherPath = { ...definition, hierarchy: [{ urn: "urn:li:glossaryNode:B", name: "階層 B" }] };
  const preview = { changes: [{ definitions: [definition, definition] }, { definitions: [otherPath] }] };
  const encoded = compactCatalogPreview(preview);
  assert.equal(Object.keys(encoded.definitionContexts.values).length, 2);
  assert.deepEqual(expandCatalogPreview(encoded), preview);
  const changed = structuredClone(encoded);
  Object.values(changed.definitionContexts.values)[0].name = "改過內容";
  assert.throws(() => expandCatalogPreview(changed), /invalid_catalog_definition_context/);
  const missing = structuredClone(encoded);
  missing.changes[0].definitions[0].definitionContextDigest = "a".repeat(64);
  assert.throws(() => expandCatalogPreview(missing), /invalid_catalog_definition_context/);
  const wrongFormat = structuredClone(encoded);
  wrongFormat.definitionContexts.format = "other/1";
  assert.throws(() => expandCatalogPreview(wrongFormat), /invalid_catalog_definition_context/);
});

test("stored compact review validation rejects tampered definitions even with a newly calculated outer digest", async () => {
  const { f, request, planning } = await wideProposal();
  const review = await compileCatalogPublication(request, f.context, { planning });
  const stored = JSON.parse(review.semanticContextJson);
  Object.values(stored.preview.definitionContexts.values)[0].name = "錯誤定義";
  const tampered = { ...review, semanticContextJson: canonical(stored) };
  tampered.planDigest = publicationReviewDigest(tampered);
  assert.throws(() => validatePublicationReview(tampered), /invalid_catalog_definition_context/);
});

test("small legacy-shaped review remains unencoded and recompiles with the same digest", async () => {
  const f = semanticCatalogFixture();
  const request = await f.request([{ kind: "tag", operation: "add", value: "urn:li:tag:Reviewed", reason: "合成證據", evidenceIds: ["asset:identity"] }]);
  const review = await compileCatalogPublication(request, f.context);
  assert.equal(JSON.parse(review.semanticContextJson).preview.definitionContexts, undefined);
  assert.equal((await recompileCatalogPublication(review, f.context)).planDigest, review.planDigest);
});

test("Host stages one whole 27-field item; parent detail expands every path; exact approval publishes once and preserves human metadata", async () => {
  const { f, request } = await wideProposal();
  async function write(input) {
    f.writes.pending = { requestId: randomUUID(), sessionId: f.sessionId, ...input };
    return f.call({ ...f.writes.pending, uiRequestId: "fixture-ui" });
  }
  const root = await write({ action: "start_maintenance", sourceUrn, assetUrns: [datasetUrn] });
  const staged = await write({ ...request, action: "prepare_maintenance", maintenanceRunUrn: root.maintenanceRunUrn, version: root.runVersion });
  assert.equal(staged.totalItems, 1);
  assert.equal(f.writes.targetWrites, 0);
  const ready = await write({ action: "seal_maintenance", maintenanceRunUrn: root.maintenanceRunUrn });
  assert.equal(ready.state, "READY");
  const detail = await loadSemanticReview(ready.items[0].reviewRef, input => f.call(input), new AbortController().signal);
  assert.equal(detail.candidateIds.length, 27);
  assert.equal(detail.preview.definitionContexts, undefined);
  for (const change of detail.preview.changes) {
    assert.equal(change.definitions[0].name, "完整合成詞彙");
    assert.equal(change.definitions[0].hierarchy.length, 2);
    assert.equal(change.definitions[0].hierarchy[0].name, "共用業務詞彙");
  }
  const publish = () => f.call({ action: "publish_maintenance_item", maintenanceRunUrn: ready.maintenanceRunUrn, planDigest: ready.planDigest, itemId: ready.items[0].id });
  await assert.rejects(publish(), /semantic_maintenance_consent_required/);
  assert.equal(f.writes.targetWrites, 0);
  await f.call({ action: "approve_maintenance", maintenanceRunUrn: ready.maintenanceRunUrn, version: ready.runVersion, planDigest: ready.planDigest, selection: maintenanceSelection(ready.totalItems, [0]) });
  assert.equal((await publish()).status, "VERIFIED_CURRENT_VALUES");
  assert.equal(f.writes.targetWrites, 1);
  const audit = await loadSemanticReview(ready.items[0].reviewRef, input => f.call(input), new AbortController().signal);
  assert.equal(audit.preview.changes.length, 27);
  assert.equal(audit.preview.changes[0].definitions[0].hierarchy.length, 2);
  assert.equal(f.state.dataset.editableSchemaMetadata.value.editableSchemaFieldInfo[0].description, "Human: source key");
  await assert.rejects(publish(), /already_attempted|publication_attempted|already_published/);
  assert.equal(f.writes.targetWrites, 1);
});

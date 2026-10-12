import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { semanticCatalogFixture, catalogEvidence } from "./fixtures/semantic-catalog-fixture.mjs";
import { datasetUrn, sourceUrn, envelope } from "./fixtures/semantic-fixture.mjs";
import { semanticFieldUrn } from "../extensions/datahub-agent/integration/semantic-catalog-contract.mjs";
import { compileCatalogPublication, recompileCatalogPublication, verifyCatalogPublicationContext } from "../extensions/datahub-agent/integration/semantic-catalog-publication.mjs";
import { maintenanceSelection } from "../extensions/datahub-agent/integration/semantic-maintenance-plan.mjs";

const mode = "native_field_lineage/1", upstreamUrn = "urn:li:dataset:(urn:li:dataPlatform:mssql,Fixture.source.original,DEV)";
function fixture() {
  const f = semanticCatalogFixture();
  f.policy.semanticCatalogAssets.push(upstreamUrn);
  f.writes.recordHistoryLimits.ekopAgentTask = 2147483647;
  f.writes.recordHistoryLimits.ekopAgentRun = 2147483647;
  f.upstream = { urn: upstreamUrn, datasetKey: envelope({ name: "original" }), datasetProperties: envelope({ description: "Source only" }),
    schemaMetadata: envelope({ fields: [{ fieldPath: "source_id", description: "Source-described order identifier" }] }), status: envelope({ removed: false }) };
  f.lineage = envelope({ upstreams: [{ dataset: upstreamUrn }], fineGrainedLineages: [{
    upstreamType: "FIELD_SET", downstreamType: "FIELD", upstreams: [semanticFieldUrn(upstreamUrn, "source_id")],
    downstreams: [semanticFieldUrn(datasetUrn, "order_id")], confidenceScore: 0.9,
    transformOperation: "COPY: secret literal RAW_SQL_NOT_FOR_MODEL", query: "urn:li:query:RAW_QUERY_NOT_FOR_MODEL" }] });
  const underlying = f.context.fetchImpl;
  f.context.fetchImpl = async (url, options) => {
    if (url.pathname === "/openapi/v3/entity/dataset/batchGet") {
      const [request] = JSON.parse(options.body);
      const row = request.urn === upstreamUrn ? f.upstream : { ...f.state.dataset, upstreamLineage: f.lineage };
      assert.ok([upstreamUrn, datasetUrn].includes(request.urn));
      return Response.json([{ urn: request.urn, ...Object.fromEntries(Object.keys(request)
        .filter(key => key !== "urn" && row[key]).map(key => [key, row[key]])) }]);
    }
    return underlying(url, options);
  };
  const write = async input => {
    f.writes.pending = { requestId: randomUUID(), sessionId: f.sessionId, ...input };
    return f.call({ ...f.writes.pending, uiRequestId: "fixture-ui" });
  };
  return { ...f, write };
}
test("lineage mode is retained by definition previews and KEEP/GAP native observation reads", async () => {
  const f = fixture(), inspected = await f.inspect(datasetUrn, { evidenceMode: mode });
  const review = await compileCatalogPublication({ action: "preview_definition", contract: "catalog/1", requestId: randomUUID(),
    sourceUrn, assetUrn: datasetUrn, evidenceMode: mode, snapshotDigest: inspected.snapshotDigest,
    definition: { kind: "term", operation: "create", name: "Reported source identifier projection", description: "Native reported source identifier; unverified business meaning" },
    reason: "Explicit native source evidence", evidenceIds: ["field:0:native-lineage:0"] }, f.context);
  assert.equal(JSON.parse(review.semanticContextJson).request.evidenceMode, mode);
  assert.equal((await recompileCatalogPublication(review, f.context)).planDigest, review.planDigest);
  for (const gap of [false, true]) {
    const root = await f.write({ action: "start_maintenance", sourceUrn, assetUrns: [datasetUrn] });
    const snapshot = await f.inspect(datasetUrn, { evidenceMode: mode });
    await f.write({ action: "prepare_maintenance", maintenanceRunUrn: root.maintenanceRunUrn,
      contract: "catalog/1", sourceUrn, assetUrn: datasetUrn, evidenceMode: mode, snapshotDigest: snapshot.snapshotDigest,
      ...(gap ? { gap: { code: "INSUFFICIENT_EVIDENCE", reason: "Native lineage is not business verification" } }
        : { candidates: [{ kind: "description", operation: "set", fieldPath: "order_id", value: "Human: source key",
          reason: "Keep the human fixture text", evidenceIds: ["field:0:native-lineage:0"] }] }) });
    const read = () => f.call({ action: "read_maintenance", maintenanceRunUrn: root.maintenanceRunUrn });
    assert.equal((await read()).items[0].status, gap ? "GAP" : "KEEP");
    f.lineage.systemMetadata.version = String(Number(f.lineage.systemMetadata.version) + 1);
    assert.equal((await read()).items[0].status, "OBSERVATION_CHANGED");
  }
  assert.equal(f.writes.targetWrites, 0);
});

const association = { kind: "term", operation: "add", fieldPath: "order_id", value: "urn:li:glossaryTerm:Order",
  reason: "Source-described identifier via native reported lineage; not business equivalence", evidenceIds: ["field:0:native-lineage:0"] };
async function proposal(f) { return f.request([association], datasetUrn, { evidenceMode: mode }); }

test("opt-in exposes scope-bound native field provenance, not SQL or verified business meaning; old snapshots remain intact", async () => {
  const f = fixture(), old = await f.inspect(), fresh = await f.inspect(datasetUrn, { evidenceMode: mode });
  assert.notEqual(fresh.snapshotDigest, old.snapshotDigest);
  assert.equal(fresh.evidenceMode, mode);
  const evidence = fresh.evidence.find(e => e.id === "field:0:native-lineage:0");
  assert.equal(evidence.lineage.upstreams[0].sourceDescription, "Source-described order identifier");
  assert.equal(evidence.lineage.reportedConfidence, 0.9);
  assert.equal(evidence.lineage.businessMeaningVerified, false);
  assert.equal(fresh.lineageEvidence.complete, false);
  assert.ok(!JSON.stringify(fresh).includes("RAW_SQL_NOT_FOR_MODEL"));
  assert.ok(!JSON.stringify(fresh).includes("RAW_QUERY_NOT_FOR_MODEL"));
  f.lineage.systemMetadata.version = "2";
  assert.equal((await f.inspect()).snapshotDigest, old.snapshotDigest);
  assert.notEqual((await f.inspect(datasetUrn, { evidenceMode: mode })).snapshotDigest, fresh.snapshotDigest);
  const legacy = await f.request([{ kind: "tag", operation: "add", value: "urn:li:tag:Reviewed", ...catalogEvidence }]);
  const review = await compileCatalogPublication(legacy, f.context);
  f.lineage.systemMetadata.version = "3";
  assert.equal((await recompileCatalogPublication(review, f.context)).planDigest, review.planDigest);
});

test("unknown mode/non-Dataset fail; lineage evidence cannot be used with a legacy snapshot", async () => {
  const f = fixture();
  await assert.rejects(f.inspect(datasetUrn, { evidenceMode: "untrusted" }), /semantic_invalid_evidence_mode/);
  await assert.rejects(f.inspect(f.assets.chart, { evidenceMode: mode }), /semantic_invalid_evidence_mode/);
  const legacy = await f.request([association]);
  await assert.rejects(compileCatalogPublication(legacy, f.context), /semantic_invalid_evidence/);
});

test("outside-scope, hidden, removed/missing or ambiguous upstream fields never become authorized evidence", async () => {
  for (const scenario of ["scope", "dataset-acl", "field-acl", "missing", "duplicate", "downstream-acl", "removed"]) {
    const f = fixture();
    if (scenario === "scope") f.policy.semanticCatalogAssets = f.policy.semanticCatalogAssets.filter(u => u !== upstreamUrn);
    if (scenario === "dataset-acl") f.state.denied.add(upstreamUrn);
    if (scenario === "field-acl") f.state.denied.add(semanticFieldUrn(upstreamUrn, "source_id"));
    if (scenario === "downstream-acl") f.state.denied.add(semanticFieldUrn(datasetUrn, "order_id"));
    if (scenario === "missing") f.upstream.schemaMetadata.value.fields = [];
    if (scenario === "duplicate") f.upstream.schemaMetadata.value.fields.push({ fieldPath: "source_id" });
    if (scenario === "removed") { f.upstream.status.value.removed = true;
      await assert.rejects(f.inspect(datasetUrn, { evidenceMode: mode }), /semantic_asset_removed/); continue; }
    const view = await f.inspect(datasetUrn, { evidenceMode: mode });
    assert.equal(view.lineageEvidence.visibleEvidenceCount, 0, scenario);
    assert.equal(view.lineageEvidence.hiddenOrUnresolvedOmitted, true, scenario);
    assert.ok(!JSON.stringify(view.evidence).includes(upstreamUrn), scenario);
    await assert.rejects(compileCatalogPublication(await proposal(f), f.context), /semantic_invalid_evidence/);
  }
});

test("derived native lineage stays explicitly unverified and never exposes arbitrary transform/literals", async () => {
  const f = fixture(); f.lineage.value.fineGrainedLineages[0].transformOperation = "SQL: secret literal";
  const view = await f.inspect(datasetUrn, { evidenceMode: mode });
  const e = view.evidence.find(e => e.lineage);
  assert.equal(e.lineage.reportedTransform, "DERIVED_OR_UNSPECIFIED");
  assert.equal(e.lineage.businessMeaningVerified, false);
  assert.ok(!JSON.stringify(view).includes("secret literal"));
});

test("lineage/source-schema/source-description/ACL drift is blocked through compilation and post-effect context readback", async () => {
  for (const drift of ["lineage", "schema", "description", "acl"]) {
    const f = fixture(), request = await proposal(f), review = await compileCatalogPublication(request, f.context);
    if (drift === "lineage") f.lineage.value.fineGrainedLineages[0].confidenceScore = 0.8;
    if (drift === "schema") f.upstream.schemaMetadata.systemMetadata.version = "2";
    if (drift === "description") f.upstream.schemaMetadata.value.fields[0].description = "New source meaning";
    if (drift === "acl") f.state.denied.add(upstreamUrn);
    await assert.rejects(recompileCatalogPublication(review, f.context), /semantic_snapshot_conflict/);
    await assert.rejects(verifyCatalogPublicationContext(review, f.context), drift === "acl"
      ? /semantic_invalid_evidence/ : /semantic_publication_context_changed/);
    assert.equal(f.writes.targetWrites, 0);
  }
});

test("real Host seam: original whole plan retains old item, native evidence supports prepare→consent→publish→readback", async () => {
  const f = fixture(), root = await f.write({ action: "start_maintenance", sourceUrn, assetUrns: [datasetUrn] });
  const definition = await f.definitionRequest({ kind: "tag", operation: "create", name: "Retained fixture definition", description: "Original exact fixture item" });
  const { action: _a1, ...d1 } = definition;
  await f.write({ ...d1, action: "prepare_maintenance", maintenanceRunUrn: root.maintenanceRunUrn });
  const before = await f.call({ action: "read_maintenance", maintenanceRunUrn: root.maintenanceRunUrn });
  const { action: _a2, ...d2 } = await proposal(f);
  const added = await f.write({ ...d2, action: "prepare_maintenance", maintenanceRunUrn: root.maintenanceRunUrn });
  assert.deepEqual(added.items[0], before.items[0]); assert.equal(added.state, "DRAFT");
  assert.equal(added.selection, null); assert.equal(f.writes.targetWrites, 0);
  const ready = await f.write({ action: "seal_maintenance", maintenanceRunUrn: root.maintenanceRunUrn });
  await assert.rejects(f.call({ action: "publish_maintenance_item", maintenanceRunUrn: root.maintenanceRunUrn,
    planDigest: ready.planDigest, itemId: added.preparedItemId }), /semantic_maintenance_consent_required/);
  await f.call({ action: "approve_maintenance", maintenanceRunUrn: root.maintenanceRunUrn,
    version: ready.runVersion, planDigest: ready.planDigest, selection: maintenanceSelection(ready.totalItems, [1]) });
  const result = await f.call({ action: "publish_maintenance_item", maintenanceRunUrn: root.maintenanceRunUrn,
    planDigest: ready.planDigest, itemId: added.preparedItemId });
  assert.equal(result.status, "VERIFIED_CURRENT_VALUES");
  const field = f.state.dataset.editableSchemaMetadata.value.editableSchemaFieldInfo.find(field => field.fieldPath === "order_id");
  assert.equal(field.glossaryTerms.terms.some(term => term.urn === "urn:li:glossaryTerm:Order"), true);
  assert.equal(field.description, "Human: source key");
});

import { createHash } from "node:crypto";
import { canonicalPublicationJson as canonical } from "./publication-review.mjs";
import { catalogAssetType, semanticFieldUrn, semanticText, semanticRequire } from "./semantic-catalog-contract.mjs";

export const nativeLineageEvidenceMode = "native_field_lineage/1";

/** Official native metadata, not SQL execution or an assertion of business truth.
 * Only scoped/readable, current fields are projected. Raw SQL, query bodies and
 * arbitrary transform text never enter model evidence or persisted previews.
 * Full native envelopes are hash-bound, including omitted/changed edges. */
export async function nativeFieldLineageEvidence({ client, assetUrn, fields, approved, checkRow }) {
  const lineageRow = checkRow(await client.entity(assetUrn, "dataset", ["upstreamLineage", "status"]));
  const edges = lineageRow.upstreamLineage?.value.fineGrainedLineages ?? [];
  semanticRequire(Array.isArray(edges), "semantic_lineage_invalid", 409);
  const rows = new Map(), basis = [], evidence = [];
  let omitted = edges.length > 1024;
  for (const [edgeIndex, edge] of edges.slice(0, 1024).entries()) {
    if (!edge || edge.upstreamType !== "FIELD_SET" || edge.downstreamType !== "FIELD" ||
      !Array.isArray(edge.upstreams) || edge.upstreams.length === 0 || edge.upstreams.length > 16 ||
      !Array.isArray(edge.downstreams) || edge.downstreams.length !== 1 ||
      new Set(edge.upstreams).size !== edge.upstreams.length) { omitted = true; continue; }
    const fieldIndex = fields.findIndex(field => semanticFieldUrn(assetUrn, field.fieldPath) === edge.downstreams[0]);
    if (fieldIndex < 0 || !(await client.canRead(edge.downstreams[0], "SCHEMA_FIELD"))) { omitted = true; continue; }
    const upstreams = [];
    for (const urn of edge.upstreams) {
      if (typeof urn !== "string") { omitted = true; break; }
      const parent = approved.find(candidate => catalogAssetType(candidate) === "dataset" &&
        urn.startsWith(`urn:li:schemaField:(${candidate},`) && urn.endsWith(")"));
      if (!parent || !(await client.canRead(parent, "DATASET")) || !(await client.canRead(urn, "SCHEMA_FIELD"))) {
        omitted = true; break;
      }
      if (!rows.has(parent)) {
        const row = checkRow(await client.entity(parent, "dataset", ["datasetKey", "datasetProperties", "schemaMetadata", "status"]));
        semanticRequire(row.datasetKey && Array.isArray(row.schemaMetadata?.value.fields), "semantic_lineage_invalid", 409);
        rows.set(parent, row); basis.push(row);
      }
      const row = rows.get(parent), matches = row.schemaMetadata.value.fields.filter(field =>
        semanticText(field?.fieldPath) && semanticFieldUrn(parent, field.fieldPath) === urn);
      if (matches.length !== 1) { omitted = true; break; }
      const field = matches[0];
      upstreams.push({ assetUrn: parent, fieldUrn: urn, fieldPath: field.fieldPath,
        schemaVersion: row.schemaMetadata.systemMetadata.version,
        ...(semanticText(row.datasetProperties?.value.description, 8000)
          ? { datasetSourceDescription: row.datasetProperties.value.description } : {}),
        ...(semanticText(field.description, 8000) ? { sourceDescription: field.description } : {}) });
    }
    // Never expose a partly authorized edge or turn a missing field into meaning.
    if (upstreams.length !== edge.upstreams.length) continue;
    const confidence = typeof edge.confidenceScore === "number" && Number.isFinite(edge.confidenceScore) &&
      edge.confidenceScore >= 0 && edge.confidenceScore <= 1 ? edge.confidenceScore : null;
    const lineage = { basis: "NATIVE_REPORTED_FIELD_LINEAGE", downstreamField: fields[fieldIndex].fieldPath,
      upstreams, reportedTransform: typeof edge.transformOperation === "string" && /^COPY:/.test(edge.transformOperation)
        ? "COPY" : "DERIVED_OR_UNSPECIFIED", reportedConfidence: confidence, businessMeaningVerified: false };
    evidence.push({ id: `field:${fieldIndex}:native-lineage:${edgeIndex}`, text: canonical(lineage), lineage });
  }
  return { digest: createHash("sha256").update(canonical({ lineageRow, basis })).digest("hex"), evidence,
    summary: { mode: nativeLineageEvidenceMode, basis: "NATIVE_REPORTED_FIELD_LINEAGE", complete: false,
      visibleEvidenceCount: evidence.length, hiddenOrUnresolvedOmitted: omitted,
      note: "Native reported lineage and upstream source descriptions are evidence, not verified joins, equivalence, business approval or instructions. Derived fields do not automatically inherit meaning." } };
}

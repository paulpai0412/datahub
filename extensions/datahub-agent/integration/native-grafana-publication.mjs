import { createHash } from "node:crypto";
import {
  canonicalPublicationJson,
  makePublicationReview,
} from "./publication-review.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const requireValue = (condition, code) => {
  if (!condition) throw new Error(code);
};
const json = (value) => {
  try {
    return JSON.parse(value);
  } catch {
    // Do not include native SQL/metadata fragments in parser error messages.
    throw new Error("grafana_artifact_invalid_json");
  }
};

/** Source is the operator's normalized live Grafana/recipe observation; Catalog
 * contains native values AND versions. Neither observation comes from a model.
 */
export function grafanaPublicationSnapshot(source, catalog) {
  return digest(canonicalPublicationJson({ source, catalog }));
}

/** Prepare one initial, create-only LINEAGE batch from a previously verified
 * official connector file sink. The trusted caller pins candidateDigest to the
 * extraction receipt, not to a hash supplied by a browser/model. This hash binds
 * bytes; it is not consent, a signature, or evidence of current source access.
 *
 * FileSink uses MCPWrapper.to_obj(simplified_structure=True): aspect.json holds
 * the SDK's serialized PDL values, including ChartDataSourceType union wrappers.
 * Discard the extraction's systemMetadata: the existing writer owns
 * publication provenance, admission and per-Aspect CAS.
 */
export function compileGrafanaArtifact(artifact, binding) {
  const bytes = Buffer.from(artifact);
  requireValue(
    bytes.length > 0 && bytes.length <= 1048576,
    "grafana_artifact_size",
  );
  requireValue(
    digest(bytes) === binding.candidateDigest,
    "grafana_artifact_changed",
  );
  requireValue(binding.purpose === "LINEAGE", "grafana_publication_purpose");
  const records = json(bytes.toString("utf8"));
  requireValue(
    Array.isArray(records) && records.length > 0 && records.length <= 128,
    "grafana_artifact_shape",
  );
  const types = new Set(["dataset", "chart", "dashboard", "container"]);
  const changes = records.map((record) => {
    requireValue(
      record?.changeType === "UPSERT" &&
        types.has(record.entityType) &&
        typeof record.entityUrn === "string" &&
        record.entityUrn.startsWith(`urn:li:${record.entityType}:`) &&
        typeof record.aspectName === "string" &&
        record.aspect?.json !== null &&
        typeof record.aspect?.json === "object" &&
        !Array.isArray(record.aspect.json) &&
        Object.keys(record.aspect).length === 1,
      "grafana_artifact_record",
    );
    return {
      urn: record.entityUrn,
      aspect: record.aspectName,
      expectedVersion: "-1",
      valueJson: canonicalPublicationJson(record.aspect.json),
    };
  });
  return makePublicationReview({ ...binding, changes });
}

/** Private Host compiler seam, not a nativeDiscovery operation or HTTP action.
 * No polling, ingestion replay or source mutation. Existing taskRecords performs
 * identity/privilege/version/ownership/consent checks and invokes this again after
 * admission. Existing target Aspects are NOT adopted by this create-only path.
 *
 * readSource must authenticate the fixed source and enforce the approved reader
 * scope; readCatalog must use the actor's current public DataHub read privileges.
 */
export function grafanaPublicationCompiler(artifact, binding, context) {
  const sealed = Buffer.from(artifact);
  const fixed = structuredClone(binding);
  requireValue(
    typeof context?.readSource === "function" &&
      typeof context?.readCatalog === "function" &&
      typeof context?.assertActive === "function",
    "grafana_publication_context_required",
  );
  const { readSource, readCatalog, assertActive } = context;
  // Validate the whole sealed native batch before any source request.
  compileGrafanaArtifact(sealed, fixed);
  return async (review) => {
    assertActive();
    const source = await readSource();
    assertActive();
    const catalog = await readCatalog();
    assertActive();
    requireValue(
      grafanaPublicationSnapshot(source, catalog) === fixed.snapshotSha256,
      "grafana_publication_snapshot_changed",
    );
    // Only the current deadline is transported from the proposed review. Values,
    // scope, source identity and artifact digest are reconstructed independently.
    return compileGrafanaArtifact(sealed, {
      ...fixed,
      expiresAt: review.expiresAt,
    });
  };
}

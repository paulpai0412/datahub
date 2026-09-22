import { createHash } from "node:crypto";

/** Typed consent for Host-compiled metadata, not an executor or a policy store. */
export class PublicationReviewError extends Error {}
const fail = (code) => {
  throw new PublicationReviewError(code);
};
const digestPattern = /^[a-f0-9]{64}$/;
const text = (v, max) =>
  typeof v === "string" && v.trim().length > 0 && v.length <= max;
const version = (v) => typeof v === "string" && /^(?:-1|[1-9][0-9]*)$/.test(v);
const fields = [
  "purpose",
  "source",
  "sourceId",
  "snapshotSha256",
  "candidateDigest",
  "analysisVersion",
  "candidateIds",
  "datasets",
  "expiresAt",
  "changes",
  "planDigest",
];
const structural = {
  dataPlatform: ["dataPlatformInfo"],
  dataFlow: [
    "dataPlatformInstance",
    "dataFlowInfo",
    "editableDataFlowProperties",
  ],
  dataJob: [
    "dataJobInfo",
    "dataJobInputOutput",
    "dataPlatformInstance",
    "browsePathsV2",
    "editableDataJobProperties",
  ],
  dataset: [
    "datasetProperties",
    "schemaMetadata",
    "status",
    "subTypes",
    "viewProperties",
    "upstreamLineage",
    "container",
    "browsePathsV2",
    "dataPlatformInstance",
  ],
  chart: [
    "chartInfo",
    "inputFields",
    "status",
    "dataPlatformInstance",
    "browsePathsV2",
    "container",
  ],
  dashboard: [
    "dashboardInfo",
    "status",
    "dataPlatformInstance",
    "browsePathsV2",
    "container",
  ],
  container: [
    "containerProperties",
    "status",
    "dataPlatformInstance",
    "subTypes",
    "browsePathsV2",
    "container",
  ],
};
const semantic = {
  dataset: ["globalTags", "glossaryTerms"],
  chart: ["globalTags", "glossaryTerms"],
  dashboard: ["globalTags", "glossaryTerms"],
  dataFlow: ["globalTags", "glossaryTerms"],
  dataJob: ["globalTags", "glossaryTerms"],
  tag: ["tagKey", "tagProperties", "status"],
  glossaryTerm: ["glossaryTermInfo", "status"],
};
const semanticKeys = new Set([
  "globalTags",
  "glossaryTerms",
  "ownership",
  "domains",
  "structuredProperties",
]);
function object(value, allowed) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    fail("invalid_publication_review");
}
function unique(values, max, check) {
  if (
    !Array.isArray(values) ||
    !values.length ||
    values.length > max ||
    values.some((v) => !check(v)) ||
    new Set(values).size !== values.length
  )
    fail("invalid_publication_review");
}
/** Canonical JSON for this Host-owned protocol; it is not a signature. */
export function canonicalPublicationJson(value, depth = 0) {
  if (depth > 32) fail("publication_value_too_deep");
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((v) => canonicalPublicationJson(v, depth + 1)).join(",")}]`;
  if (
    value &&
    typeof value === "object" &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalPublicationJson(value[key], depth + 1)}`,
      )
      .join(",")}}`;
  fail("invalid_publication_value");
}
function hasSemanticContent(value) {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, item]) => semanticKeys.has(key) || hasSemanticContent(item),
  );
}
function datasetReferencesInScope(value, datasets) {
  if (typeof value === "string") {
    if (value.startsWith("urn:li:dataset:")) return datasets.includes(value);
    if (value.startsWith("urn:li:schemaField:"))
      return datasets.some(
        (dataset) =>
          value.startsWith(`urn:li:schemaField:(${dataset},`) &&
          value.endsWith(")"),
      );
    return true;
  }
  return (
    !value ||
    typeof value !== "object" ||
    Object.values(value).every((item) =>
      datasetReferencesInScope(item, datasets),
    )
  );
}
export function publicationReviewDigest(review) {
  const { planDigest: _digest, ...proposal } = review;
  return createHash("sha256")
    .update(canonicalPublicationJson(proposal))
    .digest("hex");
}
/** Input comes only from the Host compiler; never accept this from a model tool. */
export function makePublicationReview(input) {
  object(
    input,
    fields.filter((key) => key !== "planDigest"),
  );
  const review = structuredClone(input);
  review.planDigest = publicationReviewDigest(review);
  return validatePublicationReview(review);
}
export function validatePublicationReview(review, now) {
  object(review, fields);
  if (
    !["LINEAGE", "SEMANTIC"].includes(review.purpose) ||
    !text(review.source, 1024) ||
    !review.source.startsWith("urn:li:dataHubIngestionSource:") ||
    !text(review.sourceId, 128) ||
    !text(review.analysisVersion, 64) ||
    !digestPattern.test(review.snapshotSha256 ?? "") ||
    !digestPattern.test(review.candidateDigest ?? "") ||
    !Number.isSafeInteger(review.expiresAt) ||
    review.expiresAt <= 0 ||
    !digestPattern.test(review.planDigest ?? "")
  )
    fail("invalid_publication_review");
  unique(
    review.candidateIds,
    512,
    (v) => typeof v === "string" && /^cand_[0-9a-f]{24}$/.test(v),
  );
  unique(
    review.datasets,
    16,
    (v) => text(v, 1024) && v.startsWith("urn:li:dataset:"),
  );
  if (
    !Array.isArray(review.changes) ||
    !review.changes.length ||
    review.changes.length > 128
  )
    fail("invalid_publication_changes");
  const seen = new Set();
  for (const change of review.changes) {
    object(change, ["urn", "aspect", "expectedVersion", "valueJson"]);
    const entity = /^urn:li:([A-Za-z][A-Za-z0-9]*):.+$/.exec(
      change.urn ?? "",
    )?.[1];
    const allowed = (review.purpose === "LINEAGE" ? structural : semantic)[
      entity
    ];
    if (
      !text(change.urn, 1024) ||
      !allowed?.includes(change.aspect) ||
      !version(change.expectedVersion) ||
      !text(change.valueJson, 131072)
    )
      fail("publication_change_outside_purpose");
    const key = `${change.urn}\n${change.aspect}`;
    if (seen.has(key)) fail("duplicate_publication_change");
    seen.add(key);
    let value;
    try {
      value = JSON.parse(change.valueJson);
    } catch {
      fail("invalid_publication_value");
    }
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      canonicalPublicationJson(value) !== change.valueJson
    )
      fail("noncanonical_publication_value");
    if (review.purpose === "LINEAGE" && hasSemanticContent(value))
      fail("semantic_content_requires_separate_review");
    if (
      (entity === "dataset" && !review.datasets.includes(change.urn)) ||
      !datasetReferencesInScope(value, review.datasets)
    )
      fail("publication_dataset_outside_scope");
  }
  if (Buffer.byteLength(canonicalPublicationJson(review), "utf8") > 131072)
    fail("publication_review_too_large");
  if (publicationReviewDigest(review) !== review.planDigest)
    fail("publication_review_digest_mismatch");
  if (
    now !== undefined &&
    (!Number.isSafeInteger(now) || now >= review.expiresAt)
  )
    fail("publication_review_expired");
  return structuredClone(review);
}
/** Validate a stored, freshly read decision against the CURRENT Host proposal.
 * Still not permission to send writes: source/ACL/CAS and one-attempt admission
 * must be checked by the Host publisher. A serialized claim is never sufficient.
 */
export function assertPublicationConsent(
  decision,
  expectedReview,
  actorUrn,
  now,
) {
  const expected = validatePublicationReview(expectedReview, now);
  const stored = validatePublicationReview(decision.publicationReview, now);
  const response = decision.response;
  const verdict = response?.publicationVerdict;
  if (
    stored.planDigest !== expected.planDigest ||
    response?.actor !== actorUrn ||
    response?.action !== "RESPOND" ||
    verdict?.verdict !== "APPROVE" ||
    verdict?.planDigest !== expected.planDigest ||
    verdict?.purpose !== expected.purpose ||
    !Number.isSafeInteger(decision.requestedAt) ||
    decision.requestedAt < 0 ||
    !Number.isSafeInteger(response?.respondedAt) ||
    response.respondedAt > now ||
    response.respondedAt >= expected.expiresAt ||
    response.respondedAt < decision.requestedAt
  )
    fail("trusted_publication_consent_required");
  return {
    purpose: expected.purpose,
    planDigest: expected.planDigest,
    actor: response.actor,
    respondedAt: response.respondedAt,
    expiresAt: expected.expiresAt,
  };
}

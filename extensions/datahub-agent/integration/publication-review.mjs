import { createHash } from "node:crypto";
import { stewardAspects, stewardVersion } from "./semantic-preservation.mjs";
import {
  maintenanceStewardVersion,
  isCatalogSteward,
  semanticCandidateLimit,
  catalogContract,
  catalogAspects,
  catalogAssetType,
  validateCatalogStewardChange,
} from "./semantic-catalog-contract.mjs";

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
  "assets",
  "expiresAt",
  "changes",
  "semanticContextJson",
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
function unique(values, max, check, allowEmpty = false) {
  if (
    !Array.isArray(values) ||
    (!allowEmpty && !values.length) ||
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
/** Lossless storage encoding for repeated Catalog definition paths. Only the
 * Host compiler produces it; transport readers expand it before presentation.
 * The complete object, not its URN/name alone, determines the reference key. */
export function compactCatalogPreview(preview) {
  if (!Array.isArray(preview?.changes) || preview.definitionContexts !== undefined) return preview;
  const values = {};
  const changes = preview.changes.map((change) => ({ ...change,
    ...(Array.isArray(change.definitions) ? { definitions: change.definitions.map((definition) => {
      const key = createHash("sha256").update(canonicalPublicationJson(definition)).digest("hex");
      values[key] = structuredClone(definition);
      return { definitionContextDigest: key };
    }) } : {}),
  }));
  if (!Object.keys(values).length) return preview;
  return { ...preview, changes, definitionContexts: { format: "datahub-semantic.definition-contexts/1", values } };
}

export function expandCatalogPreview(preview) {
  if (preview?.definitionContexts === undefined) return preview;
  const index = preview.definitionContexts;
  object(index, ["format", "values"]);
  if (index.format !== "datahub-semantic.definition-contexts/1" || !Array.isArray(preview.changes) ||
      !index.values || typeof index.values !== "object" || Array.isArray(index.values)) fail("invalid_catalog_definition_context");
  for (const [key, definition] of Object.entries(index.values)) {
    if (!digestPattern.test(key) || !definition || typeof definition !== "object" || Array.isArray(definition) ||
        createHash("sha256").update(canonicalPublicationJson(definition)).digest("hex") !== key)
      fail("invalid_catalog_definition_context");
  }
  const used = new Set();
  const changes = preview.changes.map((change) => ({ ...change,
    ...(Array.isArray(change.definitions) ? { definitions: change.definitions.map((reference) => {
      object(reference, ["definitionContextDigest"]);
      const key = reference.definitionContextDigest;
      if (!digestPattern.test(key ?? "") || !Object.hasOwn(index.values, key)) fail("invalid_catalog_definition_context");
      used.add(key);
      return structuredClone(index.values[key]);
    }) } : {}),
  }));
  if (used.size !== Object.keys(index.values).length) fail("invalid_catalog_definition_context");
  const { definitionContexts: _index, ...expanded } = preview;
  return { ...expanded, changes };
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
    semanticCandidateLimit,
    (v) => typeof v === "string" && /^cand_[0-9a-f]{24}$/.test(v),
  );
  const catalog = isCatalogSteward(review.analysisVersion);
  const maintenance = review.analysisVersion === maintenanceStewardVersion;
  unique(
    review.datasets,
    16,
    (v) => text(v, 1024) && v.startsWith("urn:li:dataset:"),
    catalog,
  );
  if (catalog) unique(review.assets, 16, (v) => Boolean(catalogAssetType(v)));
  else if (review.assets !== undefined) fail("invalid_semantic_review");
  if (
    !Array.isArray(review.changes) ||
    !review.changes.length ||
    review.changes.length > 128
  )
    fail("invalid_publication_changes");
  const steward = review.semanticContextJson !== undefined;
  let context;
  if (steward) {
    if (
      review.purpose !== "SEMANTIC" ||
      (!catalog && review.analysisVersion !== stewardVersion) ||
      !text(review.semanticContextJson, 80000)
    )
      fail("invalid_semantic_review");
    try {
      context = JSON.parse(review.semanticContextJson);
    } catch {
      fail("invalid_semantic_review");
    }
    object(context, [
      "actor",
      "createdAt",
      "request",
      "preview",
      "policySha256",
      "guards",
      ...(catalog ? ["domainsAspectVersion"] : []),
      ...(maintenance ? ["maintenance"] : []),
    ]);
    if (
      !text(context.actor, 512) ||
      !Number.isSafeInteger(context.createdAt) ||
      context.createdAt < 0 ||
      context.createdAt >= review.expiresAt ||
      canonicalPublicationJson(context) !== review.semanticContextJson ||
      context.request?.sourceUrn !== review.source ||
      context.request?.snapshotDigest !== review.snapshotSha256 ||
      !["preview", "preview_definition"].includes(context.request?.action) ||
      (!catalog && !review.datasets.includes(context.request?.datasetUrn))
    )
      fail("invalid_semantic_review");
    if (
      catalog &&
      (context.request?.contract !== catalogContract ||
        review.assets.length !== 1 ||
        review.assets[0] !== context.request.assetUrn ||
        canonicalPublicationJson(review.datasets) !==
          canonicalPublicationJson(
            catalogAssetType(context.request.assetUrn) === "dataset"
              ? [context.request.assetUrn]
              : [],
          ))
    )
      fail("invalid_semantic_review");
    if (catalog) expandCatalogPreview(context.preview);
    if (maintenance) {
      object(context.maintenance, ["runUrn", "definitions", "priorChanges", "ownedDefinition", "ownedImpact", "supersedes", "governance"]);
      if (context.maintenance.governance !== undefined) {
        const governance = context.maintenance.governance;
        object(governance, ["sourceUrn", "focus", "assetScopeBasis"]);
        if (governance.sourceUrn !== review.source || governance.assetScopeBasis !== "NATIVE_TASK_SELECTED_ASSETS" ||
          !["all", "glossary", "tag", "table", "field"].includes(governance.focus) ||
          canonicalPublicationJson(context.preview?.governance) !== canonicalPublicationJson(governance))
          fail("invalid_semantic_review");
      }
      if (context.maintenance.supersedes !== undefined) {
        const prior = context.maintenance.supersedes;
        object(prior, ["id", "digest", "childVersion"]);
        if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(prior.id) ||
          !/^[a-f0-9]{64}$/.test(prior.digest) || !/^[1-9][0-9]*$/.test(prior.childVersion)) fail("invalid_semantic_review");
      }
      if (context.maintenance.ownedDefinition !== undefined) {
        const owned = context.maintenance.ownedDefinition, impact = context.maintenance.ownedImpact;
        object(owned, ["creationRef", "basis", "unknownGlobalImpact"]);
        object(owned.creationRef, ["runUrn", "decisionId", "attemptId"]);
        if (!text(owned.creationRef.runUrn, 1024) || !text(owned.creationRef.decisionId, 128) || !text(owned.creationRef.attemptId, 128) ||
          owned.basis !== "native_initial_success_and_intact_current_agent_version" || owned.unknownGlobalImpact !== true ||
          context.request.definition?.operation !== "update" || !impact || impact.complete !== false || impact.unknownGlobalImpact !== true ||
          !Array.isArray(impact.references) || impact.references.length > 1000 || impact.references.some((urn) => !text(urn, 1024))) fail("invalid_semantic_review");
      } else if (context.maintenance.ownedImpact !== undefined) fail("invalid_semantic_review");
      if (!text(context.maintenance.runUrn, 1024) ||
          !context.maintenance.runUrn.startsWith("urn:li:dataProcessInstance:semantic-") ||
          !context.maintenance.definitions || Array.isArray(context.maintenance.definitions) ||
          typeof context.maintenance.definitions !== "object" ||
          !Array.isArray(context.maintenance.priorChanges)) fail("invalid_semantic_review");
    }
  } else if (catalog) fail("invalid_semantic_review");
  const seen = new Set();
  for (const change of review.changes) {
    object(change, [
      "urn",
      "aspect",
      "expectedVersion",
      "valueJson",
      "beforeValueJson",
    ]);
    const entity = /^urn:li:([A-Za-z][A-Za-z0-9]*):.+$/.exec(
      change.urn ?? "",
    )?.[1];
    const allowed = (
      steward
        ? catalog
          ? catalogAspects
          : stewardAspects
        : review.purpose === "LINEAGE"
          ? structural
          : semantic
    )[entity];
    let before;
    if (steward) {
      try {
        before = JSON.parse(change.beforeValueJson);
      } catch {
        fail("invalid_semantic_before_value");
      }
      if (
        canonicalPublicationJson(before) !== change.beforeValueJson ||
        (before === null) !== (change.expectedVersion === "-1") ||
        (before !== null &&
          (typeof before !== "object" || Array.isArray(before)))
      )
        fail("invalid_semantic_before_value");
      if (
        entity === "schemaField" &&
        !review.datasets.some(
          (urn) =>
            change.urn.startsWith(`urn:li:schemaField:(${urn},`) &&
            change.urn.endsWith(")"),
        )
      )
        fail("publication_dataset_outside_scope");
      if (
        !catalog &&
        !["dataset", "schemaField"].includes(entity) &&
        change.expectedVersion !== "-1"
      )
        fail("semantic_definition_create_only");
    } else if (change.beforeValueJson !== undefined)
      fail("invalid_semantic_review");
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
      (!catalog && !datasetReferencesInScope(value, review.datasets))
    )
      fail("publication_dataset_outside_scope");
    if (
      catalog &&
      !validateCatalogStewardChange(review, change, before, context.actor)
    )
      fail("semantic_change_outside_intent");
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

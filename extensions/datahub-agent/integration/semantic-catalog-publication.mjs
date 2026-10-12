import { createHash } from "node:crypto";
import { inspectCatalogIntent } from "./native-semantic-catalog.mjs";
import {
  catalogStewardVersion,
  maintenanceStewardVersion,
  isCatalogSteward,
  catalogAssetType,
  vocabularyTypes,
  catalogCandidateTarget,
  applyCatalogCandidates,
  encodedSemanticField,
  semanticRequire as requireValue,
} from "./semantic-catalog-contract.mjs";
import {
  canonicalPublicationJson as canonical,
  makePublicationReview,
  PublicationReviewError,
  compactCatalogPreview,
} from "./publication-review.mjs";

const hash = (value) =>
  createHash("sha256").update(canonical(value)).digest("hex");
const versions = (row) =>
  Object.fromEntries(
    Object.entries(row ?? {})
      .filter(([name]) => name !== "urn")
      .map(([name, value]) => [name, value.systemMetadata.version]),
  );
function guards(result) {
  return {
    ...(result.lineageDigest ? { lineageDigest: result.lineageDigest } : {}),
    asset: versions(result.row),
    field: versions(result.fieldRow),
    ...(result.fieldRows?.size ? { fields: Object.fromEntries([...result.fieldRows].map(([urn, row]) => [urn, versions(row)])) } : {}),
    references: Object.fromEntries(
      [...result.references].map(([urn, value]) => [
        urn,
        { kind: value.kind, versions: versions(value.row) },
      ]),
    ),
  };
}
function savedReview(review) {
  try {
    const value = JSON.parse(review.semanticContextJson);
    requireValue(
      value && typeof value === "object" && value.request && value.guards,
      "invalid_semantic_review",
      409,
    );
    return value;
  } catch {
    requireValue(false, "invalid_semantic_review", 409);
  }
}
function publicationPolicy(result, request) {
  const policy = result.policy;
  requireValue(
    policy.semanticPublicationApproved === true &&
      policy.semanticAgentUrn &&
      policy.semanticAuditAudience === "EXISTING_TASK_RUN_ACL",
    "semantic_publication_not_authorized",
    403,
  );
  if (request.definition)
    requireValue(
      request.definition.operation === "create"
        ? policy.semanticDefinitionCreationApproved === true
        : policy.semanticDefinitionUpdatesApproved === true,
      request.definition.operation === "create"
        ? "semantic_definition_creation_not_authorized"
        : "semantic_definition_updates_not_authorized",
      403,
    );
  return policy;
}

export async function compileCatalogPublication(request, context, timing = {}) {
  requireValue(
    ["preview", "preview_definition"].includes(request.action),
    "invalid_semantic_proposal",
  );
  const planning = timing.planning;
  const result = await inspectCatalogIntent(request, context, {
    plannedDefinitions: new Map(Object.entries(planning?.definitions ?? {})),
    priorChanges: planning?.priorChanges ?? [],
    governance: planning?.governance,
  });
  const policy = publicationPolicy(result, request),
    preview = result.preview;
  if (planning?.ownedDefinition) preview.definition = { ...preview.definition,
    impact: planning.ownedImpact, ownedUpdate: planning.ownedDefinition,
    note: "This project-created definition has an intact native Agent baseline. Indexed references are NOT globally complete; the human confirms this exact update once as part of the batch." };
  const createdAt = timing.createdAt ?? (context.now ?? Date.now)(),
    expiresAt = timing.expiresAt ?? createdAt + 600000;
  const stamp = { actor: context.actor.urn, time: createdAt };
  const changes = [];
  function change(urn, aspect, row, value) {
    const before = row?.[aspect]?.value ?? null;
    requireValue(
      canonical(before) !== canonical(value),
      "semantic_no_change",
      409,
    );
    changes.push({
      urn,
      aspect,
      expectedVersion: row?.[aspect]?.systemMetadata.version ?? "-1",
      beforeValueJson: canonical(before),
      valueJson: canonical(value),
    });
  }
  let candidates;
  if (request.definition) {
    requireValue(
      preview.definition.conflicts.length === 0,
      "semantic_definition_reuse_required",
      409,
    );
    candidates = [request.definition];
    change(
      preview.definition.proposedUrn,
      preview.definition.aspect,
      result.definitionTarget,
      result.definitionAfter,
    );
  } else {
    requireValue(
      preview.changes.every(
        (item) => item.operation === "PROPOSED" && item.conflicts.length === 0,
      ),
      "semantic_candidate_not_publishable",
      409,
    );
    candidates = request.candidates;
    const targets = new Map();
    for (const candidate of candidates) {
      const target = catalogCandidateTarget(request.assetUrn, candidate),
        key = `${target.urn}\n${target.aspect}`;
      if (!targets.has(key)) targets.set(key, { ...target, candidates: [] });
      targets.get(key).candidates.push(candidate);
    }
    for (const target of targets.values()) {
      const row =
        target.urn === request.assetUrn ? result.row : result.fieldRows?.get(target.urn) ?? result.fieldRow;
      if (
        target.urn !== request.assetUrn &&
        !row.schemaFieldKey &&
        target.candidates.some((c) => c.operation === "set")
      ) {
        change(target.urn, "schemaFieldKey", row, {
          parent: request.assetUrn,
          fieldPath: encodedSemanticField(target.candidates[0].fieldPath),
        });
      }
      change(
        target.urn,
        target.aspect,
        row,
        applyCatalogCandidates(
          row?.[target.aspect]?.value ?? null,
          target.aspect,
          target.candidates,
          stamp,
        ),
      );
    }
  }
  // Exclude delivery-only capability guidance from historical plan digests;
  // publication policy itself is still pinned in semanticContextJson.
  const { asOf: _time, reviewPolicy: _reviewPolicy, ...stablePreview } = preview;
  const proposal = {
    purpose: "SEMANTIC",
    source: request.sourceUrn,
    sourceId: "semantic-catalog",
    snapshotSha256: request.snapshotDigest,
    candidateDigest: hash({ request, preview: stablePreview }),
    analysisVersion: planning ? maintenanceStewardVersion : catalogStewardVersion,
    candidateIds: candidates.map((c) => `cand_${hash(c).slice(0, 24)}`),
    datasets:
      catalogAssetType(request.assetUrn) === "dataset"
        ? [request.assetUrn]
        : [],
    assets: [request.assetUrn],
    expiresAt,
    changes,
    semanticContextJson: canonical({
      actor: context.actor.urn,
      createdAt,
      request,
      preview: stablePreview,
      policySha256: hash(policy),
      guards: guards(result),
      ...(planning ? { maintenance: { runUrn: planning.runUrn,
        ...(planning.governance ? { governance: planning.governance } : {}),
        priorChanges: planning.priorChanges ?? [],
        ...(planning.supersedes ? { supersedes: planning.supersedes } : {}),
        ...(planning.ownedDefinition ? { ownedDefinition: planning.ownedDefinition, ownedImpact: planning.ownedImpact } : {}),
        definitions: Object.fromEntries([...result.references].filter(([, value]) => value.planned)
          .map(([urn, value]) => [urn, value.planned])) } } : {}),
      ...(changes.some((change) => change.aspect === "domains")
        ? { domainsAspectVersion: 2 }
        : {}),
    }),
  };
  try {
    // Preserve the byte representation and digest of every existing, fitting
    // review. Compaction is only a lossless fallback at the pure size boundary.
    return makePublicationReview(proposal);
  } catch (error) {
    if (!(error instanceof PublicationReviewError) ||
        !(error.message === "publication_review_too_large" ||
          (error.message === "invalid_semantic_review" && proposal.semanticContextJson.length > 80000))) throw error;
    const stored = JSON.parse(proposal.semanticContextJson);
    stored.preview = compactCatalogPreview(stored.preview);
    return makePublicationReview({ ...proposal, semanticContextJson: canonical(stored) });
  }
}

export async function recompileCatalogPublication(review, context) {
  requireValue(
    isCatalogSteward(review.analysisVersion),
    "semantic_compiler_mismatch",
    409,
  );
  const saved = savedReview(review);
  const fresh = await compileCatalogPublication(saved.request, context, {
    createdAt: saved.createdAt,
    expiresAt: review.expiresAt,
    ...(saved.maintenance ? { planning: { runUrn: saved.maintenance.runUrn, definitions: saved.maintenance.definitions,
      priorChanges: saved.maintenance.priorChanges, supersedes: saved.maintenance.supersedes,
      ownedDefinition: saved.maintenance.ownedDefinition, ownedImpact: saved.maintenance.ownedImpact,
      governance: saved.maintenance.governance } } : {}),
  });
  requireValue(
    fresh.planDigest === review.planDigest,
    "semantic_review_stale",
    409,
  );
  return fresh;
}

// A history read must not recompile an already consumed request with its old
// definition version. It only rechecks current identity/scope and reports drift.
export async function readCatalogReviewContext(review, context, { write = false } = {}) {
  const saved = savedReview(review);
  const result = await inspectCatalogIntent(saved.request, context, {
    readback: true,
    plannedDefinitions: new Map(Object.entries(saved.maintenance?.definitions ?? {})),
    priorChanges: saved.maintenance?.priorChanges ?? [],
    governance: saved.maintenance?.governance,
  });
  // inspectCatalogIntent rechecks identity, Source and asset/reference ACLs.
  // Current write grants are not required to read a stored review. Mutation
  // callers retain the original publication AND definition-specific checks.
  if (write) publicationPolicy(result, saved.request);
  const definitionChanged =
    saved.request.definition &&
    review.changes.some(
      (change) =>
        (result.definitionTarget?.[change.aspect]?.systemMetadata.version ??
          "-1") !== change.expectedVersion,
    );
  const encodingChanged =
    review.changes.some((change) => change.aspect === "domains") &&
    saved.domainsAspectVersion !== 2;
  return {
    result,
    stale:
      encodingChanged ||
      result.preview.snapshotDigest !== saved.request.snapshotDigest ||
      hash(result.policy) !== saved.policySha256 ||
      canonical(guards(result).references) !==
        canonical(saved.guards.references) ||
      canonical(guards(result).fields ?? {}) !== canonical(saved.guards.fields ?? {}) ||
      Boolean(definitionChanged),
  };
}

export async function verifyCatalogPublicationContext(review, context) {
  const saved = savedReview(review);
  const { result } = await readCatalogReviewContext(review, context);
  publicationPolicy(result, saved.request);
  requireValue(
    hash(result.policy) === saved.policySha256 &&
      canonical(result.preview.source) === canonical(saved.preview.source),
    "semantic_publication_context_changed",
    409,
  );
  const current = guards(result);
  requireValue(current.lineageDigest === saved.guards.lineageDigest, "semantic_publication_context_changed", 409);
  for (const group of ["asset", "field"]) {
    const urn =
      group === "asset" ? saved.request.assetUrn : result.fieldRow?.urn;
    for (const aspect of new Set([
      ...Object.keys(saved.guards[group]),
      ...Object.keys(current[group]),
    ])) {
      if (!review.changes.some((c) => c.urn === urn && c.aspect === aspect))
        requireValue(
          current[group][aspect] === saved.guards[group][aspect],
          "semantic_publication_context_changed",
          409,
        );
    }
  }
  for (const urn of new Set([...Object.keys(saved.guards.fields ?? {}), ...Object.keys(current.fields ?? {})])) {
    const before = saved.guards.fields?.[urn] ?? {}, after = current.fields?.[urn] ?? {};
    for (const aspect of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!review.changes.some(change => change.urn === urn && change.aspect === aspect))
        requireValue(before[aspect] === after[aspect], "semantic_publication_context_changed", 409);
    }
  }
  requireValue(
    canonical(current.references) === canonical(saved.guards.references),
    "semantic_publication_context_changed",
    409,
  );
  if (saved.request.definition) {
    const aspect = vocabularyTypes[saved.request.definition.kind].aspect;
    requireValue(
      result.definitionTarget?.[aspect] &&
        canonical(result.definitionTarget[aspect].value) ===
          review.changes[0].valueJson,
      "semantic_publication_context_changed",
      409,
    );
  }
  return {
    status: "SOURCE_SCHEMA_REFERENCES_RECHECKED",
    observedAt: (context.now ?? Date.now)(),
  };
}

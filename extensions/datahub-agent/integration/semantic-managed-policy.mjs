import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { catalogStewardVersion, semanticCandidateLimit } from "./semantic-catalog-contract.mjs";
import { canonicalPublicationJson } from "./publication-review.mjs";
import { preservesSemanticValue } from "./semantic-preservation.mjs";
import { SemanticError } from "./semantic-native-client.mjs";

const deny = (code = "semantic_managed_policy_exception") => {
  throw new SemanticError(code, 409);
};
const requireSafe = (condition, code) => {
  if (!condition) deny(code);
};
const sha = (value) =>
  createHash("sha256").update(canonicalPublicationJson(value)).digest("hex");
const kinds = new Set(["description", "domain", "tag", "term", "property"]);
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const targetKey = (target) =>
  JSON.stringify([target.assetUrn, target.fieldPath ?? null]);
const configuredTarget = (target, source) =>
  object(target) &&
  Object.keys(target).every((key) => ["assetUrn", "fieldPath"].includes(key)) &&
  source.taskDatasets?.includes(target.assetUrn) &&
  (target.fieldPath === undefined ||
    (typeof target.fieldPath === "string" &&
      target.fieldPath.length > 0 && target.fieldPath.length <= 500));

/** Shape only: validating a historical policy does not activate it. */
export function validManagedPolicyConfiguration(policy, source) {
  return (
    object(policy) &&
    Object.keys(policy).every((key) =>
      ["id", "mode", "runUrn", "expiresAt", "allowedKinds", "allowedTargets", "allowAgentDescriptionUpdates"].includes(key),
    ) &&
    ["AUTO", "REVIEW"].includes(policy.mode) &&
    typeof policy.id === "string" && /^[a-z][a-z0-9._-]{2,63}$/.test(policy.id) &&
    typeof policy.runUrn === "string" &&
    /^urn:li:dataHubExecutionRequest:[a-f0-9-]{36}$/.test(policy.runUrn) &&
    Number.isSafeInteger(policy.expiresAt) && policy.expiresAt > 0 &&
    (policy.allowAgentDescriptionUpdates === undefined || typeof policy.allowAgentDescriptionUpdates === "boolean") &&
    Array.isArray(policy.allowedKinds) &&
    policy.allowedKinds.length > 0 && policy.allowedKinds.length <= 5 &&
    new Set(policy.allowedKinds).size === policy.allowedKinds.length &&
    policy.allowedKinds.every((kind) => kinds.has(kind)) &&
    (policy.allowedTargets === undefined
      ? policy.mode === "REVIEW"
      : Array.isArray(policy.allowedTargets) &&
        policy.allowedTargets.length > 0 && policy.allowedTargets.length <= 128 &&
        policy.allowedTargets.every((target) => configuredTarget(target, source)) &&
        new Set(policy.allowedTargets.map(targetKey)).size === policy.allowedTargets.length)
  );
}

/** Explicit operator-owned audit authority, mutually exclusive with publication.
 * The old policy is an immutable historical digest preimage, never live consent.
 */
export function validManagedAuditRecoveryConfiguration(source, actorKey) {
  const grant = source?.semanticAuditRecovery;
  const prefix = `urn:li:dataProcessInstance:semantic-${actorKey}-`;
  if (
    !/^[a-f0-9]{48}$/.test(actorKey ?? "") || !object(grant) ||
    !Object.keys(grant).every((key) => [
      "id", "cycleRunUrn", "sessionId", "scopeFingerprint",
      "expiresAt", "originalPolicy", "targets",
    ].includes(key)) ||
    typeof grant.id !== "string" || !/^[a-z][a-z0-9._-]{2,63}$/.test(grant.id) ||
    typeof grant.cycleRunUrn !== "string" ||
    !grant.cycleRunUrn.startsWith(prefix) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      grant.cycleRunUrn.slice(prefix.length),
    ) ||
    typeof grant.sessionId !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(grant.sessionId) ||
    typeof grant.scopeFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(grant.scopeFingerprint) ||
    !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= 0 ||
    !validManagedPolicyConfiguration(grant.originalPolicy, source) ||
    grant.originalPolicy.mode !== "AUTO" ||
    !Array.isArray(grant.targets) || grant.targets.length === 0 || grant.targets.length > 128 ||
    !grant.targets.every((target) => configuredTarget(target, source)) ||
    new Set(grant.targets.map(targetKey)).size !== grant.targets.length ||
    source.semanticPublicationApproved !== false || source.semanticAutoManagement !== undefined ||
    source.semanticModelContextApproved !== true || source.semanticCatalogUpdatesApproved !== true ||
    typeof source.semanticAgentUrn !== "string" ||
    !/^urn:li:aiAgent:[^\s]{1,480}$/.test(source.semanticAgentUrn) ||
    source.semanticAuditAudience !== "EXISTING_TASK_RUN_ACL"
  ) return false;
  const originallyAllowed = new Set(
    grant.originalPolicy.allowedTargets.map(targetKey),
  );
  return grant.targets.every((target) => !originallyAllowed.has(targetKey(target)));
}

/** Called again synchronously after the last awaited identity read of each CAS. */
export function authorizeManagedAuditRecovery(
  source,
  { scope, cycle, run, task, actor, input, now },
) {
  const grant = source?.semanticAuditRecovery;
  requireSafe(
    validManagedAuditRecoveryConfiguration(source, actor.key) &&
      Number.isSafeInteger(now) && now < grant.expiresAt &&
      grant.expiresAt <= now + 1800000,
    "semantic_audit_recovery_not_active",
  );
  requireSafe(
    input.code === "POLICY_DENIED" &&
      grant.cycleRunUrn === run.urn && input.cycleRunUrn === run.urn &&
      grant.sessionId === run.value.sessionId && input.sessionId === run.value.sessionId &&
      run.value.closedAt === undefined && now >= cycle.createdAt &&
      task.value.agent === source.semanticAgentUrn &&
      grant.scopeFingerprint === scope.fingerprint && grant.scopeFingerprint === cycle.scopeFingerprint &&
      grant.originalPolicy.id === cycle.policyId && sha(grant.originalPolicy) === cycle.policyDigest &&
      grant.originalPolicy.runUrn === scope.executionUrn &&
      grant.targets.every((target) => scope.datasets.some((row) =>
        row.urn === target.assetUrn &&
        (target.fieldPath === undefined || row.fields.includes(target.fieldPath)),
      )) &&
      grant.targets.some((target) => targetKey(target) === targetKey(input)),
    "semantic_audit_recovery_scope_mismatch",
  );
  return {
    id: grant.id,
    grantDigest: sha(grant),
    policyDigest: cycle.policyDigest,
    scopeFingerprint: scope.fingerprint,
    expiresAt: grant.expiresAt,
  };
}

/** A revocable, deployment-owned policy, not a parameter the model may set.
 * Its exact successful Run and expiry are mandatory; absence means read-only.
 */
export function managedPolicy(source, scope, now = Date.now()) {
  const policy = source?.semanticAutoManagement;
  requireSafe(
    source?.semanticPublicationApproved === true &&
      source?.semanticCatalogUpdatesApproved === true &&
      source?.semanticModelContextApproved === true &&
      source?.semanticAuditAudience === "EXISTING_TASK_RUN_ACL" &&
      validManagedPolicyConfiguration(policy, source) &&
      ["AUTO", "REVIEW"].includes(policy?.mode) &&
      /^urn:li:dataHubExecutionRequest:[a-f0-9-]{36}$/.test(
        policy.runUrn ?? "",
      ) &&
      /^[a-z][a-z0-9._-]{2,63}$/.test(policy.id ?? "") &&
      Number.isSafeInteger(policy.expiresAt) &&
      now < policy.expiresAt &&
      policy.expiresAt <= now + 90 * 86400000 &&
      Array.isArray(policy.allowedKinds) &&
      policy.allowedKinds.length > 0 &&
      new Set(policy.allowedKinds).size === policy.allowedKinds.length &&
      policy.allowedKinds.every((item) => kinds.has(item)) &&
      (policy.allowedTargets === undefined
        ? policy.mode === "REVIEW"
        : Array.isArray(policy.allowedTargets) &&
          policy.allowedTargets.length > 0 &&
          policy.allowedTargets.length <= 128 &&
          policy.allowedTargets.every((target) =>
            scope?.datasets?.some(
              (dataset) =>
                dataset.urn === target.assetUrn &&
                (target.fieldPath === undefined ||
                  dataset.fields.includes(target.fieldPath)),
            ),
          )) &&
      scope?.format === "datahub-semantic.managed-scope/1" &&
      scope.completeEnumeratedRecipeScope === true &&
      scope.sourceUrn === source.urn &&
      scope.executionUrn === policy.runUrn &&
      /^[a-f0-9]{64}$/.test(scope.fingerprint ?? ""),
    "semantic_managed_policy_not_active",
  );
  return {
    policy,
    policyDigest: sha(policy),
    scopeFingerprint: scope.fingerprint,
  };
}

/** Evidence-backed fills and explicitly enabled updates to intact, selected
 * Agent descriptions. No blanket Aspect ownership or shared-definition authority.
 */
export function verifyManagedProposal(
  request,
  review,
  scope,
  source,
  now = Date.now(),
) {
  const seal = managedPolicy(source, scope, now);
  requireSafe(seal.policy.mode === "AUTO", "semantic_managed_policy_not_auto");
  requireSafe(
    request?.contract === "catalog/1" &&
      request.sourceUrn === source.urn &&
      scope.datasets.some((item) => item.urn === request.assetUrn) &&
      review?.analysisVersion === catalogStewardVersion &&
      review.source === source.urn &&
      review.datasets?.length === 1 &&
      review.datasets[0] === request.assetUrn &&
      review.assets?.length === 1 &&
      review.assets[0] === request.assetUrn &&
      request.definition === undefined &&
      Array.isArray(request.candidates) &&
      request.candidates.length > 0 &&
      request.candidates.length <= semanticCandidateLimit &&
      request.candidates.every((item) =>
        seal.policy.allowedTargets.some(
          (target) =>
            target.assetUrn === request.assetUrn &&
            target.fieldPath === item.fieldPath,
        ),
      ) &&
      review.candidateIds?.length === request.candidates.length &&
      Array.isArray(review.changes) &&
      review.changes.length > 0,
    "semantic_managed_proposal_outside_scope",
  );
  const dataset = scope.datasets.find((item) => item.urn === request.assetUrn);
  let saved;
  try {
    saved = JSON.parse(review.semanticContextJson);
  } catch {
    deny();
  }
  requireSafe(
    saved.policySha256 === sha(source) &&
      isDeepStrictEqual(saved.request, request) &&
      saved.preview?.assetUrn === request.assetUrn &&
      Array.isArray(saved.preview.changes) &&
      saved.preview.changes.length === request.candidates.length &&
      saved.preview.changes.every(
        (item) => item.operation === "PROPOSED" && item.conflicts?.length === 0,
      ),
    "semantic_managed_proposal_changed",
  );
  let humanReviewRequired = false;
  for (const [i, candidate] of request.candidates.entries()) {
    const item = saved.preview.changes[i];
    const evidenceIds = Array.isArray(candidate.evidenceIds)
      ? candidate.evidenceIds
      : [];
    requireSafe(item.priorAgent?.status !== "UNVERIFIED_AGENT_BASELINE", "semantic_managed_prior_attempt_unverified");
    const sourceEvidence =
      item.evidence?.filter(
        (e) =>
          evidenceIds.includes(e.id) &&
          (e.id.endsWith("source-description") ||
            /^field:[0-9]+:contract-metric-[0-9]+$/.test(e.id) ||
            /^(asset|field:[0-9]+):contract-statement-[0-9]+$/.test(e.id)) &&
          typeof e.text === "string" &&
          e.text.trim().length > 0,
      ) ?? [];
    const directSourceEvidence = sourceEvidence.filter((e) =>
      e.id.endsWith("source-description"),
    );
    requireSafe(
      seal.policy.allowedKinds.includes(candidate.kind) &&
        item.kind === candidate.kind &&
        item.fieldPath === candidate.fieldPath &&
        (candidate.fieldPath === undefined ||
          dataset.fields.includes(candidate.fieldPath)) &&
        (candidate.operation ===
          (candidate.kind === "description" || candidate.kind === "property" ? "set" : "add") ||
          (candidate.kind !== "description" && ["set", "remove"].includes(candidate.operation))) &&
        evidenceIds.length > 0 &&
        evidenceIds.some(
          (id) =>
            id === "asset:source-description" ||
            /^field:[0-9]+:(source-description|contract-metric-[0-9]+)$/.test(id) ||
            /^(asset|field:[0-9]+):contract-statement-[0-9]+$/.test(id),
        ) &&
        sourceEvidence.length > 0 &&
        (candidate.kind !== "description" ||
          sourceEvidence.some(
            (e) => e.text.trim() === candidate.value.trim(),
          )) &&
        (candidate.kind === "description" ||
          (Array.isArray(item.definitions) &&
            item.definitions.length > 0 &&
            item.definitions.every(
              (definition) =>
                typeof definition.name === "string" &&
                definition.name.trim().length >= 3 &&
                directSourceEvidence.some((e) =>
                  e.text
                    .toLocaleLowerCase()
                    .includes(definition.name.trim().toLocaleLowerCase()),
                ),
            ))) &&
        !item.businessMeaningVerified &&
        item.requiresHumanReview === true,
      "semantic_managed_evidence_exception",
    );
    // Check every candidate's evidence before routing the batch to human review;
    // an earlier protected value cannot hide a later missing-evidence failure.
    if (candidate.kind !== "description" && candidate.operation !== (candidate.kind === "property" ? "set" : "add"))
      humanReviewRequired = true;
    if ((candidate.kind === "description" || candidate.kind === "property") && !(
        item.before === null ||
        (Array.isArray(item.before) && item.before.length === 0) ||
        (candidate.kind === "description" && seal.policy.allowAgentDescriptionUpdates === true &&
          item.priorAgent?.status === "VERIFIED_AGENT_BASELINE" && item.priorAgent.schemaUnchanged === true &&
          item.before === item.priorAgent.value))) humanReviewRequired = true;
  }
  requireSafe(!humanReviewRequired, "semantic_managed_existing_value_exception");
  for (const change of review.changes) {
    requireSafe(
      change.urn === request.assetUrn ||
        change.urn.startsWith("urn:li:schemaField:"),
      "semantic_managed_shared_definition_exception",
    );
    let before, after;
    try {
      before = JSON.parse(change.beforeValueJson);
      after = JSON.parse(change.valueJson);
    } catch {
      deny();
    }
    const descriptionUpdates = request.candidates.filter((candidate, index) =>
      candidate.kind === "description" && saved.preview.changes[index].before !== null &&
      (candidate.fieldPath === undefined
        ? change.aspect === "editableDatasetProperties"
        : change.aspect === "editableSchemaMetadata"));
    // Remove only the descriptions proven above from the preservation comparison;
    // every other human field, association, stamp and unknown member still survives.
    const protectedBefore = structuredClone(before);
    for (const candidate of descriptionUpdates) {
      if (candidate.fieldPath === undefined) delete protectedBefore.description;
      else {
        const field = protectedBefore.editableSchemaFieldInfo?.find((entry) => entry.fieldPath === candidate.fieldPath);
        if (field) delete field.description;
      }
    }
    requireSafe(
      before === null ||
        preservesSemanticValue(
          protectedBefore,
          after,
          { actor: saved.actor, time: saved.createdAt },
          change.aspect,
        ),
      "semantic_managed_existing_value_exception",
    );
  }
  return {
    policyId: seal.policy.id,
    policyDigest: seal.policyDigest,
    scopeFingerprint: seal.scopeFingerprint,
  };
}

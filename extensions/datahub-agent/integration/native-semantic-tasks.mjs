import { randomUUID, createHash } from "node:crypto";
import { canonicalPublicationJson, expandCatalogPreview } from "./publication-review.mjs";
import { inspectCatalogIntent, managedRetentionValuesDigest, parseCatalogRequest } from "./native-semantic-catalog.mjs";
import { isDeepStrictEqual } from "node:util";
import { nativeSemantic, SemanticError } from "./native-semantic.mjs";
import { taskRecords, TaskRecordError } from "./task-records.mjs";
import {
  compileSemanticPublication,
  recompileSemanticPublication,
  verifySemanticPublicationContext,
  semanticCandidateId,
} from "./semantic-publication.mjs";
import { stewardVersion } from "./semantic-preservation.mjs";
import { catalogStewardVersion, maintenanceStewardVersion, isCatalogSteward, catalogCandidateTarget, catalogDefinitionUrn } from "./semantic-catalog-contract.mjs";
import { maintenancePlan, maintenanceActions, maintenanceWriteActions, MaintenanceInputRejection, maintenanceStartLocators } from "./semantic-maintenance-plan.mjs";
import { readCatalogReviewContext } from "./semantic-catalog-publication.mjs";
import { readManagedIngestionScope } from "./semantic-managed-scope.mjs";
import { selectManagedCycle, readManagedDefinition } from "./semantic-managed-maintenance.mjs";
import {
  managedPolicy,
  verifyManagedProposal,
  authorizeManagedAuditRecovery,
} from "./semantic-managed-policy.mjs";
import {
  managedCycleInstructions,
  managedException,
  managedRetention,
  managedDefinitionLink,
  initiallyVerifiedManagedPublication,
  managedDecisionTargets,
  parseManagedCycle,
  managedCycleProjection,
} from "./semantic-managed-cycle.mjs";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const proposalKeys = [
  "contract",
  "assetUrn",
  "sourceUrn",
  "datasetUrn",
  "snapshotDigest",
  "evidenceMode",
  "fieldPath",
  "candidates",
  "definition",
  "reason",
  "evidenceIds",
];
const actions = {
  start_managed_cycle: [
    "requestId",
    "sessionId",
    "uiRequestId",
    "contract",
    "sourceUrn",
    "scopeFingerprint",
    "cycleRunUrn",
    "cycleTaskUrn",
    "previousCycleRunUrn",
  ],
  read_managed_cycle: ["requestId", "cycleRunUrn", "offset"],
  link_managed_definition: ["requestId", "sessionId", "uiRequestId", "cycleRunUrn", "cycleTaskUrn", "runUrn", "decisionId"],
  record_managed_exception: [
    "requestId",
    "sessionId",
    "uiRequestId",
    "cycleRunUrn",
    "cycleTaskUrn",
    "assetUrn",
    "fieldPath",
    "code",
  ],
  finish_managed_cycle: [
    "requestId",
    "sessionId",
    "uiRequestId",
    "cycleRunUrn",
    "cycleTaskUrn",
  ],
  prepare_review: ["requestId", "sessionId", "uiRequestId", ...proposalKeys],
  prepare_managed: [
    "requestId",
    "sessionId",
    "uiRequestId",
    "scopeFingerprint",
    "cycleRunUrn",
    "cycleTaskUrn",
    ...proposalKeys,
  ],
  read_review: ["requestId", "runUrn", "decisionId"],
  read_review_detail: ["requestId", "runUrn", "decisionId", "version", "planDigest", "detailDigest", "offset"],
  select_review: [
    "runUrn",
    "decisionId",
    "version",
    "planDigest",
    "candidateIds",
  ],
  approve_review: ["runUrn", "decisionId", "version", "planDigest"],
  reject_review: ["runUrn", "decisionId", "version", "planDigest"],
  publish_review: ["runUrn", "decisionId", "version", "planDigest"],
};
const fail = (code, ref) => {
  throw new TaskRecordError(code, 409, ref);
};

/** Exact document segmentation. Count UTF-8 bytes of the entire wire envelope,
 * including JSON escaping; never truncate a value or lift native record limits. */
export function semanticReviewDetailPage(serialized, offset, header) {
  const page = (end) => ({ ...header, length: serialized.length, offset,
    nextOffset: end === serialized.length ? null : end, chunk: serialized.slice(offset, end) });
  let low = offset + 1, high = Math.min(serialized.length, offset + 524288);
  if (Buffer.byteLength(JSON.stringify(page(high))) <= 524288) return page(high);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(page(middle))) <= 524288) low = middle;
    else high = middle - 1;
  }
  const result = page(low);
  if (Buffer.byteLength(JSON.stringify(result)) > 524288) fail("semantic_review_detail_page_invalid");
  return result;
}

/** Authenticated parent Host only. The MFE accepts only prepare/read intents
 * from the iframe; selection, consent and publication originate in its own UI.
 * No new session, prompt, datastore or automatic recovery/retry is introduced.
 */
export async function semanticHost(raw, context) {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new SemanticError("invalid_semantic_request");
  }
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Buffer.byteLength(raw) > 24000
  )
    throw new SemanticError("invalid_semantic_request");
  if (Object.hasOwn(maintenanceActions, input.action)) {
    // The plan validates shape at its pure pre-write boundary. Only its typed,
    // request-bound input rejection is eligible for a NEW model intent.
    try { return await maintenancePlan(context).handle(input); }
    catch (error) {
      if (error instanceof TaskRecordError && !(error instanceof MaintenanceInputRejection) && maintenanceWriteActions.includes(input.action))
        error.reconciliation = { ...error.reconciliation,
          ...(input.action === "start_maintenance" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(input.requestId)
            ? maintenanceStartLocators(context.actor.key, input.requestId) : {}),
          ...(input.maintenanceRunUrn ? { maintenanceRunUrn: input.maintenanceRunUrn } : {}),
          ...(input.requestId ? { requestId: input.requestId } : {}),
          ...(input.action === "recover_maintenance" ? { itemId: input.itemId,
            runUrn: `urn:li:dataProcessInstance:semantic-${context.actor.key}-${input.itemId}` } : {}), retryAllowed: false };
      throw error;
    }
  }
  if (!Object.hasOwn(actions, input.action))
    return nativeSemantic(raw, context);
  if (
    Object.keys(input).some(
      (key) => key !== "action" && !(key === "responseMode" && ["prepare_review", "prepare_managed", "read_review", "select_review", "approve_review", "reject_review", "publish_review"].includes(input.action)) && !actions[input.action].includes(key),
    )
  )
    fail("invalid_semantic_request");
  if (input.responseMode !== undefined && input.responseMode !== "receipt") fail("invalid_semantic_request");
  async function authorizeManagedPublication(review, proof, { run, task }) {
    if (
      !proof ||
      typeof proof !== "object" ||
      Array.isArray(proof) ||
      Object.keys(proof).sort().join(",") !==
        "policyDigest,policyId,scopeFingerprint"
    )
      fail("semantic_managed_policy_invalid");
    let saved;
    try {
      saved = JSON.parse(review.semanticContextJson);
    } catch {
      fail("semantic_managed_policy_invalid");
    }
    await requireManagedDependencies(run, saved.request);
    const scope = await readManagedIngestionScope(context, review.source);
    // Scope is read after other publication reads. Recheck both the cycle lease
    // and current deployment policy/time synchronously at target dispatch.
    const recheck = () => {
      const at = (context.now ?? Date.now)();
      const cycle = parseManagedCycle(
        run,
        task,
        scope,
        context.actor,
        at,
        true,
      );
      const source = context.sources.find(
        (entry) => entry.urn === review.source,
      );
      const expected = verifyManagedProposal(
        saved.request,
        review,
        scope,
        source,
        at,
      );
      if (
        !isDeepStrictEqual(proof, expected) ||
        cycle.policyId !== expected.policyId ||
        cycle.policyDigest !== expected.policyDigest
      )
        fail("semantic_managed_policy_stale");
    };
    recheck();
    return recheck;
  }
  const records = taskRecords({
    ...context,
    authorizeManagedPublication,
    authorizeMaintenancePublication: (review, proof, binding) => maintenancePlan(context).authorizePublication(review, proof, binding),
    recompilePublication: (review) =>
      recompileSemanticPublication(review, context),
    verifyPublicationReadback: async (review) => {
      try {
        return await verifySemanticPublicationContext(review, context);
      } catch (error) {
        throw new TaskRecordError(
          error instanceof SemanticError
            ? error.message
            : "semantic_readback_unverified",
        );
      }
    },
  });
  const now = context.now ?? Date.now;
  function policy(source, { write = true } = {}) {
    const entry = context.sources.find((entry) => entry.urn === source);
    if (
      entry?.semanticModelContextApproved !== true ||
      (write && entry.semanticPublicationApproved !== true) ||
      !entry.semanticAgentUrn
    )
      fail("semantic_publication_not_authorized");
    if (entry.semanticAuditAudience !== "EXISTING_TASK_RUN_ACL")
      fail("semantic_audit_visibility_not_approved");
    return entry;
  }
  async function read(runUrn, decisionId, writable = true) {
    const prefix = `urn:li:dataProcessInstance:semantic-${context.actor.key}-`;
    if (!runUrn.startsWith(prefix) || !uuid.test(runUrn.slice(prefix.length)))
      fail("semantic_review_actor_scope_mismatch");
    const run = await records.getRun(runUrn);
    if (run.value.actor !== context.actor.urn) fail("task_owner_mismatch");
    // Historical evidence requires current read authority, not permission to publish.
    policy(run.value.source, { write: writable });
    const decision = run.value.decisions.find(
      (entry) => entry.id === decisionId,
    );
    if (
      ![stewardVersion, catalogStewardVersion, maintenanceStewardVersion].includes(
        decision?.publicationReview?.analysisVersion,
      )
    )
      fail("semantic_review_not_found", {
        runUrn,
        taskUrn: run.value.task,
        decisionId,
        retryAllowed: false,
      });
    const review = decision.publicationReview;
    let saved;
    try {
      saved = JSON.parse(review.semanticContextJson);
    } catch {
      fail("semantic_review_not_found", {
        runUrn,
        taskUrn: run.value.task,
        decisionId,
        retryAllowed: false,
      });
    }
    if (
      saved.actor !== context.actor.urn ||
      saved.request.sourceUrn !== run.value.source
    )
      fail("semantic_review_binding_mismatch");
    // Do not expose saved evidence after Catalog/Source read authority is revoked.
    if (isCatalogSteward(review.analysisVersion)) {
      const { stale } = await readCatalogReviewContext(review, context, { write: writable });
      return { run, decision, review, saved, stale };
    }
    const inspected = await nativeSemantic(
      JSON.stringify({
        action: "inspect_dataset",
        requestId: randomUUID(),
        sourceUrn: review.source,
        datasetUrn: saved.request.datasetUrn,
        ...(saved.request.fieldPath
          ? { fieldPath: saved.request.fieldPath }
          : {}),
      }),
      context,
    );
    await nativeSemantic(
      JSON.stringify({
        ...saved.request,
        snapshotDigest: inspected.snapshotDigest,
      }),
      context,
    );
    return {
      run,
      decision,
      review,
      saved,
      stale: inspected.snapshotDigest !== saved.request.snapshotDigest,
    };
  }
  async function view(value, publication) {
    const { run, decision, review, saved } = value;
    let reconciliation, currentContext;
    if (decision.publicationAttempt) {
      reconciliation = await records.reconcilePublication(run.urn, decision.id);
      try {
        currentContext = await verifySemanticPublicationContext(
          review,
          context,
        );
      } catch (error) {
        currentContext = {
          status: "CONTEXT_CHANGED_OR_UNVERIFIED",
          reason:
            error instanceof SemanticError
              ? error.message
              : "semantic_readback_unverified",
        };
      }
    }
    const state = decision.publicationAttempt
      ? "ATTEMPTED"
      : (decision.response?.publicationVerdict?.verdict ?? "PENDING");
    const result = {
      format: "datahub-semantic.review/1",
      action: input.action,
      ...(input.requestId ? { requestId: input.requestId } : {}),
      publicationAuthorized: false,
      // UI affordance only; every mutation independently checks current policy.
      readOnly: policy(run.value.source, { write: false }).semanticPublicationApproved !== true,
      reviewRef: { runUrn: run.urn, decisionId: decision.id },
      taskUrn: run.value.task,
      runVersion: run.version,
      planDigest: review.planDigest,
      expiresAt: review.expiresAt,
      expired: now() >= review.expiresAt,
      closed: run.value.closedAt !== undefined,
      stale: currentContext
        ? currentContext.status !== "SOURCE_SCHEMA_REFERENCES_RECHECKED"
        : value.stale,
      state,
      preview: {
        ...expandCatalogPreview(saved.preview),
        asOf: new Date(saved.createdAt).toISOString(),
      },
      candidateIds: review.candidateIds,
      ...(saved.maintenance ? { maintenanceRunUrn: saved.maintenance.runUrn } : {}),
      // Only projected semantic evidence returns to the model. Raw preserved
      // Aspect members/before-values remain in the native audit record.
      history: run.value.decisions
        .filter((entry) =>
          [stewardVersion, catalogStewardVersion, maintenanceStewardVersion].includes(
            entry.publicationReview?.analysisVersion,
          ),
        )
        .map((entry) => ({
          decisionId: entry.id,
          planDigest: entry.publicationReview.planDigest,
          verdict: entry.response?.publicationVerdict?.verdict ?? "PENDING",
          requestedAt: entry.requestedAt,
          ...(entry.response
            ? {
                respondedAt: entry.response.respondedAt,
                actor: entry.response.actor,
                approvalMode: entry.response.text?.startsWith(
                  "semantic-auto/1:",
                )
                  ? "OPERATOR_POLICY"
                  : "HUMAN",
              }
            : {}),
        })),
      ...(decision.publicationAttempt
        ? {
            attempt: decision.publicationAttempt,
            reconciliation,
            currentContext,
          }
        : {}),
      ...(publication ? { publication } : {}),
      auditAudience: "EXISTING_TASK_RUN_ACL",
      note: "Records follow native Task/Run ACL, not a private chat ACL. Approval is bound to this stored revision. An attempt is permanently consumed, including partial/unknown effects. Never replay it.",
    };
    // Native records are the only authority. Delivery is a bounded receipt plus
    // exact JSON document segments: even a single large definition/evidence item
    // can span pages, without truncation or a second state store. Each page is
    // freshly authorized and bound to the same Run, plan and observation digest.
    const document = { ...result, action: "read_review" };
    delete document.requestId;
    delete document.publication; // One-shot return only; initial outcome remains in attempt.
    // A healthy recheck has a new observation time, not a new native document.
    // Deliver that time on the fresh receipt; keep state/version/ACL changes
    // bound to this digest and preserve the stored attempt outcome verbatim.
    if (document.currentContext?.observedAt !== undefined) {
      const { observedAt: _observedAt, ...stableContext } = document.currentContext;
      document.currentContext = stableContext;
    }
    const serialized = canonicalPublicationJson(document);
    const detailDigest = createHash("sha256").update(serialized).digest("hex");
    if (input.action === "read_review_detail") {
      if (input.version !== run.version || input.planDigest !== review.planDigest || input.detailDigest !== detailDigest)
        fail("semantic_review_detail_changed", result.reviewRef);
      if (!Number.isSafeInteger(input.offset) || input.offset < 0 || input.offset >= serialized.length)
        fail("semantic_review_detail_page_invalid");
      return semanticReviewDetailPage(serialized, input.offset, {
        format: "datahub-semantic.review-detail/1", action: input.action,
        ...(input.requestId ? { requestId: input.requestId } : {}), publicationAuthorized: false,
        reviewRef: result.reviewRef, runVersion: run.version, planDigest: review.planDigest, detailDigest,
      });
    }
    // Small legacy callers remain readable. New clients always request receipt;
    // oversized legacy responses must never turn a completed write into a size error.
    if (input.responseMode !== "receipt" && Buffer.byteLength(JSON.stringify(result)) <= 524288) return result;
    let initialStatus = "UNKNOWN";
    try { initialStatus = JSON.parse(decision.publicationAttempt?.outcomeJson)?.status ?? "UNKNOWN"; } catch { /* never infer from current readback */ }
    const { preview, candidateIds, history: _history, attempt, reconciliation: observed, currentContext: checked, publication: published, ...header } = result;
    return { ...header, delivery: "receipt", candidateCount: candidateIds.length,
      preview: { source: preview.source, ...(preview.assetUrn ? { assetUrn: preview.assetUrn } : { datasetUrn: preview.datasetUrn }) },
      details: { format: "datahub-semantic.review-detail/1", digest: detailDigest, length: serialized.length, pageSize: 524288 },
      ...(attempt ? { attempt: { attemptId: attempt.attemptId }, initialOutcome: { status: initialStatus },
        reconciliation: { status: observed.status, attemptId: observed.attemptId }, currentContext: { status: checked.status, ...(checked.observedAt === undefined ? {} : { observedAt: checked.observedAt }) } } : {}),
      ...(published ? { publication: { status: published.status } } : {}) };
  }
  async function requireManagedDependencies(run, request) {
    const references = new Set((request.candidates ?? []).flatMap((item) =>
      item.kind === "description" ? [] : item.kind === "property" || item.operation !== "set" ? [item.value] : item.values));
    if (!references.size) return;
    const scope = await readManagedIngestionScope(context, run.value.source);
    for (const entry of run.value.decisions) {
      const link = managedDecisionTargets(entry, scope).shared;
      if (!link || !references.has(link.definitionUrn)) continue;
      const child = await readManagedDefinition(context, run, link);
      if (!child.decision.publicationAttempt && child.decision.response?.publicationVerdict?.verdict === "REJECT") continue;
      if (entry.response?.action !== "RESPOND" || entry.response.text !== entry.question ||
          entry.response.actor !== context.actor.urn || !initiallyVerifiedManagedPublication(child.decision))
        fail("semantic_managed_definition_dependency_unverified");
      const observation = await records.reconcilePublication(child.run.urn, link.decisionId);
      if (observation.status !== "MATCHED_CLAIMED_ATTEMPT" || observation.attemptId !== child.decision.publicationAttempt.attemptId)
        fail("semantic_managed_definition_dependency_unverified");
    }
  }

  async function pendingUi() {
    if (
      !uuid.test(input.requestId) ||
      !uuid.test(input.sessionId) ||
      typeof input.uiRequestId !== "string" ||
      !context.runtime
    )
      fail("semantic_native_request_required");
    const result = await context.runtime.state(input.sessionId);
    const ui = result.state?.extensionUiRequests?.find(
      (entry) =>
        entry.id === input.uiRequestId &&
        entry.method === "input" &&
        entry.title === "DataHub semantic request",
    );
    let body;
    try {
      body = JSON.parse(ui?.placeholder);
    } catch {
      fail("semantic_native_request_not_pending");
    }
    const { uiRequestId: _ui, ...expected } = input;
    if (
      result.running !== true ||
      result.state.sessionId !== input.sessionId ||
      !isDeepStrictEqual(body, expected)
    )
      fail("semantic_native_request_mismatch");
  }
  async function readCycle(runUrn, writable = false) {
    const prefix = `urn:li:dataProcessInstance:semantic-${context.actor.key}-`;
    if (
      typeof runUrn !== "string" ||
      !runUrn.startsWith(prefix) ||
      !uuid.test(runUrn.slice(prefix.length))
    )
      fail("semantic_managed_cycle_actor_scope_mismatch");
    const run = await records.getRun(runUrn),
      task = await records.getTask(run.value.task, run.value.taskVersion);
    if (input.cycleTaskUrn !== undefined && input.cycleTaskUrn !== task.urn)
      fail("semantic_managed_cycle_ref_mismatch");
    const scope = await readManagedIngestionScope(context, run.value.source);
    const source = context.sources.find((entry) => entry.urn === run.value.source);
    // This is a separate explicit authority for audit notes, never a fallback
    // for expired publication consent, a new Run, or a renewed old lease.
    const recovery = writable && input.action === "record_managed_exception" && source?.semanticAuditRecovery !== undefined;
    const cycle = parseManagedCycle(
      run,
      task,
      scope,
      context.actor,
      now(),
      writable && !recovery,
    );
    const auditProof = recovery ? authorizeManagedAuditRecovery(source, {
      scope, cycle, run, task, actor: context.actor, input, now: now(),
    }) : undefined;
    if (writable && !recovery) {
      const approval = managedPolicy(policy(run.value.source), scope, now());
      if (
        cycle.policyId !== approval.policy.id ||
        cycle.policyDigest !== approval.policyDigest
      )
        fail("semantic_managed_policy_stale");
    }
    return { run, task, scope, cycle, auditProof };
  }
  function allowManagedPendingReviews(run) {
    if (run.value.decisions.some((decision) => decision.id !== input.requestId && !decision.response &&
        (decision.publicationReview?.analysisVersion !== catalogStewardVersion || decision.publicationAttempt)))
      fail("task_decision_pending");
    return true;
  }
  function requireAvailableTargets(run, scope, proposedKeys) {
    for (const decision of run.value.decisions) {
      const { keys } = managedDecisionTargets(decision, scope);
      if (
        decision.publicationReview !== undefined &&
        !decision.publicationAttempt &&
        decision.response?.publicationVerdict?.verdict === "REJECT"
      )
        continue;
      if (keys.some((key) => proposedKeys.has(key)))
        fail("semantic_managed_target_conflict", {
          runUrn: run.urn,
          decisionId: decision.id,
          retryAllowed: false,
        });
    }
  }
  async function cycleProjection(runUrn, requireVerifiedPublications = false) {
    const { run, scope, cycle } = await readCycle(runUrn);
    const observations = new Map();
    for (const decision of run.value.decisions) {
      const { retention, shared } = managedDecisionTargets(decision, scope);
      if (shared) {
        try {
          const child = await readManagedDefinition(context, run, shared);
          let status = !child.decision.publicationAttempt && child.decision.response?.publicationVerdict?.verdict === "REJECT" ? "REJECTED" : "PENDING";
          if (child.decision.publicationAttempt) {
            const observation = await records.reconcilePublication(child.run.urn, shared.decisionId);
            status = initiallyVerifiedManagedPublication(child.decision) && observation.status === "MATCHED_CLAIMED_ATTEMPT" &&
              observation.attemptId === child.decision.publicationAttempt.attemptId ? "VERIFIED" : "UNKNOWN_OR_CHANGED";
          }
          observations.set(decision.id, { status });
        } catch {
          observations.set(decision.id, { status: "UNCONFIRMED" });
        }
      }
      if (retention) {
        try {
          const current = await inspectCatalogIntent({ action: "inspect_asset", contract: "catalog/1", requestId: randomUUID(),
            sourceUrn: scope.sourceUrn, assetUrn: retention.assetUrn,
            ...(retention.fieldPath === undefined ? {} : { fieldPath: retention.fieldPath }) }, context);
          observations.set(decision.id, { status: managedRetentionValuesDigest(current, retention.selectors) === retention.valuesDigest ? "CURRENT_NO_CHANGE" : "CHANGED" });
        } catch {
          observations.set(decision.id, { status: "UNVERIFIED" });
        }
      }
      if (decision.publicationAttempt) {
        try {
          observations.set(
            decision.id,
            await records.reconcilePublication(runUrn, decision.id),
          );
        } catch {
          observations.set(decision.id, { status: "UNVERIFIED" });
        }
      }
    }
    const projection = managedCycleProjection(
      run,
      scope,
      observations,
      input.offset ?? 0,
      cycle.policyDigest,
    );
    if (requireVerifiedPublications) {
      if (projection.pendingCount !== 0 || projection.publicationCount === 0)
        fail("semantic_audit_recovery_unverified_cycle");
      // Check every publication, not only the first projected receipt page.
      for (let offset = 0; offset < projection.publicationCount; offset += 20)
        if (managedCycleProjection(run, scope, observations, offset, cycle.policyDigest).publications.some((entry) => entry.status !== "VERIFIED"))
          fail("semantic_audit_recovery_unverified_cycle");
    }
    const result = {
      ...projection,
      runVersion: run.version,
      action: input.action,
      requestId: input.requestId,
      publicationAuthorized: false,
      expiresAt: cycle.expiresAt,
      taskUrn: run.value.task,
      generation: cycle.generation ?? 1,
      ...(cycle.previousCycleRunUrn ? { previousCycleRunUrn: cycle.previousCycleRunUrn } : {}),
      closed: run.value.closedAt !== undefined,
    };
    if (Buffer.byteLength(JSON.stringify(result)) > 524288)
      fail("semantic_response_too_large", { runUrn });
    return result;
  }
  if (input.action === "start_managed_cycle") {
    if (
      input.contract !== "catalog/1" ||
      !/^[a-f0-9]{64}$/.test(input.scopeFingerprint ?? "")
    )
      fail("semantic_managed_scope_required");
    await pendingUi();
    const source = policy(input.sourceUrn),
      scope = await readManagedIngestionScope(context, input.sourceUrn);
    if (scope.fingerprint !== input.scopeFingerprint)
      fail("semantic_managed_scope_changed");
    const approval = managedPolicy(source, scope, now());
    const selected = await selectManagedCycle(context, scope, approval);
    const { runUrn, taskUrn } = selected.ref;
    if (input.cycleRunUrn !== runUrn ||
        (input.cycleTaskUrn !== undefined && input.cycleTaskUrn !== taskUrn) ||
        input.previousCycleRunUrn !== selected.previousCycleRunUrn)
      fail("semantic_managed_cycle_ref_mismatch");
    if (selected.run) {
      if (selected.run.value.sessionId !== input.sessionId) fail("semantic_managed_cycle_mismatch");
      return cycleProjection(runUrn); // Existing generation: read-only reconciliation.
    }
    const proof = { policyId: approval.policy.id, policyDigest: approval.policyDigest, scopeFingerprint: scope.fingerprint };
    const instructions = managedCycleInstructions(scope, proof, now(), {
      generation: selected.generation, currentCycleRunUrn: runUrn,
      ...(selected.previousCycleRunUrn ? { previousCycleRunUrn: selected.previousCycleRunUrn } : {}),
    });
    await pendingUi();
    // Source/scope is re-read before allocation; the policy/expiry is checked
    // synchronously after each write's final awaited identity read.
    const currentScope = await readManagedIngestionScope(context, source.urn);
    if (currentScope.fingerprint !== scope.fingerprint) fail("semantic_managed_scope_changed");
    const beforeSubmit = () => {
      const current = managedPolicy(context.sources.find((entry) => entry.urn === source.urn), currentScope, now());
      if (current.policyDigest !== approval.policyDigest) fail("semantic_managed_policy_stale");
    };
    try {
      const task = selected.task
        ? await records.advanceSemanticTask(taskUrn, selected.task.version, instructions, beforeSubmit)
        : await records.createTask(taskUrn, {
            agent: source.semanticAgentUrn, source: source.urn,
            datasets: scope.datasets.map((row) => row.urn), assets: scope.datasets.map((row) => row.urn),
            instructions, allowDecisions: true,
          }, beforeSubmit);
      await records.bindRun(runUrn, taskUrn, task.version, input.sessionId, beforeSubmit);
      return cycleProjection(runUrn);
    } catch (error) {
      throw new TaskRecordError(error instanceof TaskRecordError || error instanceof SemanticError
        ? error.message : "semantic_managed_cycle_unconfirmed", 409, { taskUrn, runUrn, retryAllowed: false });
    }
  }
  if (input.action === "read_managed_cycle")
    return cycleProjection(input.cycleRunUrn);
  if (input.action === "link_managed_definition") {
    if (typeof input.runUrn !== "string" || !uuid.test(input.decisionId ?? "")) fail("invalid_semantic_request");
    await pendingUi();
    const parent = await readCycle(input.cycleRunUrn, true);
    if (parent.run.value.sessionId !== input.sessionId) fail("semantic_managed_cycle_session_mismatch");
    const source = policy(parent.run.value.source), approval = managedPolicy(source, parent.scope, now());
    const child = await read(input.runUrn, input.decisionId);
    if (child.run.value.sessionId !== input.sessionId || child.run.value.source !== source.urn ||
        child.saved.request.contract !== "catalog/1" || !child.saved.request.definition ||
        !parent.scope.datasets.some((row) => row.urn === child.saved.request.assetUrn))
      fail("semantic_managed_definition_link_mismatch");
    const definition = child.saved.request.definition;
    // Indexed, bounded observations do not establish global shared-update safety.
    if (definition.operation === "update" && (child.saved.preview.definition.impact?.complete !== true ||
        child.saved.preview.definition.impact.references.some((item) => !parent.scope.datasets.some((row) => row.urn === item.urn))))
      fail("semantic_managed_shared_impact_unverified");
    const link = { assetUrn: child.saved.request.assetUrn,
      definitionUrn: catalogDefinitionUrn(definition, context.actor.tenant, source.urn), kind: definition.kind,
      runUrn: child.run.urn, taskUrn: child.run.value.task, decisionId: input.decisionId, planDigest: child.review.planDigest,
      requestDigest: createHash("sha256").update(canonicalPublicationJson(child.saved.request)).digest("hex") };
    await readManagedDefinition(context, parent.run, link);
    const question = managedDefinitionLink(link, parent.scope);
    const existing = parent.run.value.decisions.find((item) => item.id === input.requestId);
    if (existing) {
      if (existing.question !== question) fail("semantic_preparation_mismatch");
      return cycleProjection(parent.run.urn); // An uncertain link ACK is never replayed.
    }
    for (const entry of parent.run.value.decisions) {
      const previous = managedDecisionTargets(entry, parent.scope).shared;
      if (previous?.definitionUrn === link.definitionUrn) {
        const prior = await readManagedDefinition(context, parent.run, previous);
        if (prior.decision.publicationAttempt || prior.decision.response?.publicationVerdict?.verdict !== "REJECT")
          fail("semantic_managed_definition_target_conflict");
      }
    }
    const currentScope = await readManagedIngestionScope(context, source.urn);
    if (currentScope.fingerprint !== parent.scope.fingerprint) fail("semantic_managed_scope_changed");
    const beforeSubmit = ({ run, task }) => {
      parseManagedCycle(run, task, currentScope, context.actor, now(), true);
      if (managedPolicy(policy(source.urn), parent.scope, now()).policyDigest !== approval.policyDigest)
        fail("semantic_managed_policy_stale");
      return allowManagedPendingReviews(run);
    };
    await pendingUi();
    try {
      const appended = await records.appendDecision(parent.run.urn, parent.run.version, input.sessionId,
        { id: input.requestId, question, choices: [] }, beforeSubmit);
      await records.respondDecision(parent.run.urn, appended.version, input.sessionId, input.requestId,
        { action: "RESPOND", text: question }, beforeSubmit);
      return cycleProjection(parent.run.urn);
    } catch (error) {
      throw new TaskRecordError(error instanceof TaskRecordError || error instanceof SemanticError ? error.message : "semantic_managed_definition_link_unconfirmed",
        409, { runUrn: parent.run.urn, taskUrn: parent.task.urn, decisionId: input.requestId, retryAllowed: false });
    }
  }
  if (input.action === "record_managed_exception") {
    await pendingUi();
    const { run, scope, cycle, auditProof } = await readCycle(input.cycleRunUrn, true);
    if (run.value.sessionId !== input.sessionId)
      fail("semantic_managed_cycle_session_mismatch");
    const question = managedException({ ...input, ...(auditProof ? { auditRecovery: auditProof } : {}) }, scope);
    const existing = run.value.decisions.find(
      (entry) => entry.id === input.requestId,
    );
    if (existing) {
      if (existing.question !== question)
        fail("semantic_managed_exception_mismatch");
      return cycleProjection(run.urn); // Read-only reconciliation, including an unanswered intent.
    }
    if (auditProof) await cycleProjection(run.urn, true);
    const beforeSubmit = auditProof ? ({ run: currentRun, task }) => {
      const at = now();
      const cycle = parseManagedCycle(currentRun, task, scope, context.actor, at);
      const current = authorizeManagedAuditRecovery(
        context.sources.find((entry) => entry.urn === currentRun.value.source),
        { scope, cycle, run: currentRun, task, actor: context.actor, input, now: at },
      );
      if (!isDeepStrictEqual(current, auditProof)) fail("semantic_audit_recovery_changed");
    } : ({ run: currentRun, task }) => {
      parseManagedCycle(currentRun, task, scope, context.actor, now(), true);
      if (managedPolicy(policy(currentRun.value.source), scope, now()).policyDigest !== cycle.policyDigest)
        fail("semantic_managed_policy_stale");
      return allowManagedPendingReviews(currentRun);
    };
    requireAvailableTargets(
      run,
      scope,
      new Set([JSON.stringify([input.assetUrn, input.fieldPath ?? null])]),
    );
    await pendingUi();
    try {
      const appended = await records.appendDecision(
        run.urn,
        run.version,
        input.sessionId,
        { id: input.requestId, question, choices: [] },
        beforeSubmit,
      );
      await records.respondDecision(
        run.urn,
        appended.version,
        input.sessionId,
        input.requestId,
        { action: "RESPOND", text: question },
        beforeSubmit,
      );
      return cycleProjection(run.urn);
    } catch (error) {
      throw new TaskRecordError(
        error instanceof TaskRecordError || error instanceof SemanticError
          ? error.message
          : "semantic_managed_exception_unconfirmed",
        409,
        { runUrn: run.urn, decisionId: input.requestId, retryAllowed: false },
      );
    }
  }
  if (input.action === "finish_managed_cycle") {
    await pendingUi();
    const { run } = await readCycle(input.cycleRunUrn);
    if (run.value.sessionId !== input.sessionId)
      fail("semantic_managed_cycle_session_mismatch");
    const projected = await cycleProjection(run.urn);
    if (
      projected.status !== "SCOPE_ACCOUNTED_WITH_ITEM_RECEIPTS" ||
      run.value.closedAt !== undefined
    )
      return projected;
    await pendingUi();
    try {
      await records.closeRun(run.urn, run.version, input.sessionId);
      return cycleProjection(run.urn);
    } catch {
      fail("semantic_managed_cycle_close_unconfirmed", {
        runUrn: run.urn,
        retryAllowed: false,
      });
    }
  }
  if (["prepare_review", "prepare_managed"].includes(input.action)) {
    const managed = input.action === "prepare_managed";
    if (
      managed &&
      (input.contract !== "catalog/1" ||
        !/^[a-f0-9]{64}$/.test(input.scopeFingerprint ?? ""))
    )
      fail("semantic_managed_scope_required");
    if (managed && input.definition !== undefined)
      fail("semantic_managed_definition_not_supported");
    if (
      !uuid.test(input.requestId) ||
      !uuid.test(input.sessionId) ||
      typeof input.uiRequestId !== "string" ||
      !context.runtime
    )
      fail("semantic_native_request_required");
    const source = policy(input.sourceUrn);
    await pendingUi();
    const id = `semantic-${context.actor.key}-${input.requestId}`;
    const runUrn = `urn:li:dataProcessInstance:${id}`;
    const taskUrn = `urn:li:dataJob:(urn:li:dataFlow:(pi,ekop-agent-${context.actor.key},DEV),${id})`;
    const request = {
      action: input.definition ? "preview_definition" : "preview",
      requestId: input.requestId,
      ...Object.fromEntries(
        proposalKeys
          .filter((key) => input[key] !== undefined)
          .map((key) => [key, input[key]]),
      ),
    };
    if (request.contract === "catalog/1") parseCatalogRequest(request);
    if (managed) {
      const cycle = await readCycle(input.cycleRunUrn);
      if (
        cycle.run.value.source !== input.sourceUrn ||
        cycle.run.value.sessionId !== input.sessionId ||
        cycle.scope.fingerprint !== input.scopeFingerprint ||
        !cycle.scope.datasets.some((item) => item.urn === input.assetUrn)
      )
        fail("semantic_managed_cycle_mismatch");
      const existing = cycle.run.value.decisions.find((entry) => entry.id === input.requestId);
      if (existing) {
        const { retention } = managedDecisionTargets(existing, cycle.scope);
        if (retention) {
          if (retention.requestDigest !== createHash("sha256").update(canonicalPublicationJson(request)).digest("hex"))
            fail("semantic_preparation_mismatch");
          return cycleProjection(cycle.run.urn); // Never replay an unanswered retention intent.
        }
        const previous = await read(cycle.run.urn, input.requestId);
        if (!isDeepStrictEqual(previous.saved.request, request))
          fail("semantic_preparation_mismatch");
        return view(previous); // Never replay an existing decision or consumed attempt.
      }
      const fresh = await readCycle(input.cycleRunUrn, true);
      const approval = managedPolicy(source, fresh.scope, now());
      if (
        !Array.isArray(request.candidates) ||
        request.candidates.length === 0 ||
        request.candidates.some(
          (candidate) =>
            !approval.policy.allowedKinds.includes(candidate.kind) ||
            (approval.policy.allowedTargets !== undefined &&
              !approval.policy.allowedTargets.some(
                (target) =>
                  target.assetUrn === request.assetUrn &&
                  target.fieldPath === candidate.fieldPath,
              )),
        )
      )
        fail("semantic_managed_policy_outside_allowed_targets");
      requireAvailableTargets(
        fresh.run,
        fresh.scope,
        new Set(
          request.candidates.map((candidate) =>
            JSON.stringify([request.assetUrn, candidate.fieldPath ?? null]),
          ),
        ),
      );
      await requireManagedDependencies(fresh.run, request);
      // A normal KEEP decision is not a publication or a fabricated exception.
      // Persist only versioned observation hashes/targets, not a second datastore.
      const inspected = await inspectCatalogIntent(request, context);
      if (inspected.preview.changes.some((item) => item.priorAgent?.status === "UNVERIFIED_AGENT_BASELINE"))
        fail("semantic_managed_prior_attempt_unverified");
      if (inspected.preview.changes.every((item) => item.operation === "NO_CHANGE")) {
        const selectors = request.candidates.map((item) => ({ kind: item.kind, aspect: catalogCandidateTarget(request.assetUrn, item).aspect,
          ...(item.fieldPath === undefined ? {} : { fieldPath: item.fieldPath }),
          ...(item.kind === "property" ? { propertyUrn: item.value } : {}),
        }));
        const question = managedRetention({ assetUrn: request.assetUrn,
          selectors, valuesDigest: managedRetentionValuesDigest(inspected, selectors),
          fieldPaths: [...new Set(request.candidates.map((item) => item.fieldPath ?? null))],
          ...(request.fieldPath === undefined ? {} : { fieldPath: request.fieldPath }),
          snapshotDigest: request.snapshotDigest,
          requestDigest: createHash("sha256").update(canonicalPublicationJson(request)).digest("hex"),
          observedAt: now(),
        }, fresh.scope);
        const beforeSubmit = ({ run, task }) => {
          parseManagedCycle(run, task, fresh.scope, context.actor, now(), true);
          const current = managedPolicy(policy(input.sourceUrn), fresh.scope, now());
          if (current.policyDigest !== approval.policyDigest) fail("semantic_managed_policy_stale");
          return allowManagedPendingReviews(run);
        };
        await pendingUi();
        try {
          const appended = await records.appendDecision(fresh.run.urn, fresh.run.version, input.sessionId,
            { id: input.requestId, question, choices: [] }, beforeSubmit);
          await records.respondDecision(fresh.run.urn, appended.version, input.sessionId, input.requestId,
            { action: "RESPOND", text: question }, beforeSubmit);
          return cycleProjection(fresh.run.urn);
        } catch (error) {
          throw new TaskRecordError(error instanceof TaskRecordError || error instanceof SemanticError ? error.message : "semantic_managed_retention_unconfirmed",
            409, { runUrn: fresh.run.urn, taskUrn: fresh.task.urn, decisionId: input.requestId, retryAllowed: false });
        }
      }
      // The append uses this exact Run version. A competing reservation loses
      // that CAS before either consent or target dispatch.
      const review = await compileSemanticPublication(request, context);
      let managedProof, reviewReason;
      if (approval.policy.mode === "AUTO") {
        try {
          managedProof = verifyManagedProposal(request, review, fresh.scope, source, now());
        } catch (error) {
          // An in-scope, versioned, publishable proposal can require judgment.
          // Route only semantic eligibility failures to the existing human review;
          // revocation, stale plans, scope and policy failures still stop admission.
          if (!(error instanceof SemanticError) || ![
            "semantic_managed_existing_value_exception",
            "semantic_managed_shared_definition_exception",
          ].includes(error.message)) throw error;
          reviewReason = error.message;
        }
      }
      await pendingUi();
      try {
        const prepared = await records.appendPublicationReview(
          fresh.run.urn,
          fresh.run.version,
          input.sessionId,
          {
            id: input.requestId,
            question: managedProof
              ? `Operator policy ${managedProof.policyId} permits this exact scoped maintenance plan; no human verdict is implied.`
              : `Review exact managed-scope changes${reviewReason ? ` (${reviewReason})` : ""}; the human must approve this Decision. No automatic consent.`,
            choices: [],
          },
          review,
          ({ run, task }) => {
            // Managed semantic decisions reserve disjoint targets, unlike a
            // generic native question (which still permits only one pending).
            parseManagedCycle(run, task, fresh.scope, context.actor, now(), true);
            if (managedPolicy(policy(input.sourceUrn), fresh.scope, now()).policyDigest !== approval.policyDigest)
              fail("semantic_managed_policy_stale");
            requireAvailableTargets(run, fresh.scope, new Set(request.candidates.map((candidate) =>
              JSON.stringify([request.assetUrn, candidate.fieldPath ?? null]))));
            return allowManagedPendingReviews(run);
          },
        );
        if (!managedProof)
          return view(await read(fresh.run.urn, input.requestId));
        const approved = await records.respondPublicationReview(
          fresh.run.urn,
          prepared.version,
          input.sessionId,
          input.requestId,
          { verdict: "APPROVE", planDigest: review.planDigest },
          managedProof,
        );
        const publication = await records.publishPublication(
          fresh.run.urn,
          approved.version,
          input.sessionId,
          input.requestId,
          review,
        );
        return view(await read(fresh.run.urn, input.requestId), publication);
      } catch (error) {
        throw new TaskRecordError(
          error instanceof TaskRecordError || error instanceof SemanticError
            ? error.message
            : "semantic_preparation_unconfirmed",
          409,
          {
            ...error.reconciliation,
            taskUrn: fresh.task.urn,
            runUrn: fresh.run.urn,
            decisionId: input.requestId,
            retryAllowed: false,
          },
        );
      }
    }
    try {
      const previous = await read(runUrn, input.requestId);
      if (!isDeepStrictEqual(previous.saved.request, request))
        fail("semantic_preparation_mismatch");
      return view(previous); // A reconnect can only read an existing preparation.
    } catch (error) {
      if (
        !(error instanceof TaskRecordError) ||
        error.message !== "task_record_not_found"
      )
        throw error;
    }
    try {
      await records.getTask(taskUrn);
      fail("semantic_preparation_incomplete", { taskUrn, runUrn });
    } catch (error) {
      if (
        !(error instanceof TaskRecordError) ||
        error.message !== "task_record_not_found"
      )
        throw error;
    }
    const review = await compileSemanticPublication(request, context);
    await pendingUi();
    try {
      const task = await records.createTask(taskUrn, {
        agent: source.semanticAgentUrn,
        source: input.sourceUrn,
        datasets: review.datasets,
        ...(review.assets ? { assets: review.assets } : {}),
        instructions:
          "Semantic Steward: review the persisted evidence and exact versioned changes. No SQL, ingestion or blanket Aspect ownership.",
        allowDecisions: true,
      });
      const run = await records.bindRun(
        runUrn,
        taskUrn,
        task.version,
        input.sessionId,
      );
      await records.appendPublicationReview(
        runUrn,
        run.version,
        input.sessionId,
        {
          id: input.requestId,
          question:
            "Review exact Semantic Steward changes; replacement/removal requires this explicit approval. Unselected metadata is preserved.",
          choices: [],
        },
        review,
      );
      return await view(await read(runUrn, input.requestId));
    } catch (error) {
      throw new TaskRecordError(
        error instanceof TaskRecordError || error instanceof SemanticError
          ? error.message
          : "semantic_preparation_unconfirmed",
        409,
        {
          ...error.reconciliation,
          taskUrn,
          runUrn,
          decisionId: input.requestId,
          retryAllowed: false,
        },
      );
    }
  }
  if (typeof input.runUrn !== "string" || typeof input.decisionId !== "string")
    fail("invalid_semantic_request");
  const readOnlyAction = ["read_review", "read_review_detail"].includes(input.action);
  const current = await read(input.runUrn, input.decisionId, !readOnlyAction);
  if (readOnlyAction) return view(current);
  const { run, review, saved, decision } = current;
  if (saved.maintenance) fail("semantic_maintenance_use_plan_confirmation");
  if (run.version !== input.version || review.planDigest !== input.planDigest)
    fail("semantic_review_revision_conflict");
  if (input.action === "select_review") {
    if (
      !Array.isArray(input.candidateIds) ||
      !input.candidateIds.length ||
      new Set(input.candidateIds).size !== input.candidateIds.length ||
      input.candidateIds.some((id) => !review.candidateIds.includes(id)) ||
      saved.request.definition
    )
      fail("semantic_selection_invalid");
    const request = {
      ...saved.request,
      candidates: saved.request.candidates.filter((item) =>
        input.candidateIds.includes(semanticCandidateId(item)),
      ),
    };
    const next = await compileSemanticPublication(request, context, {
      createdAt: saved.createdAt,
      expiresAt: review.expiresAt,
    });
    const nextId = randomUUID();
    await records.selectPublicationReview(
      run.urn,
      run.version,
      run.value.sessionId,
      decision.id,
      review.planDigest,
      next,
      nextId,
    );
    return view(await read(run.urn, nextId));
  }
  if (input.action === "reject_review") {
    await records.respondPublicationReview(
      run.urn,
      run.version,
      run.value.sessionId,
      decision.id,
      { verdict: "REJECT", planDigest: review.planDigest },
    );
    return view(await read(run.urn, decision.id));
  }
  let version = run.version;
  if (input.action === "approve_review") {
    const approved = await records.respondPublicationReview(
      run.urn,
      version,
      run.value.sessionId,
      decision.id,
      { verdict: "APPROVE", planDigest: review.planDigest },
    );
    version = approved.version;
  }
  const publication = await records.publishPublication(
    run.urn,
    version,
    run.value.sessionId,
    decision.id,
    review,
  );
  return view(await read(run.urn, decision.id), publication);
}

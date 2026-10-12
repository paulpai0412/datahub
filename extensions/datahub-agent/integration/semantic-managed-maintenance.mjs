import { taskRecords, TaskRecordError } from "./task-records.mjs";
import { catalogDefinitionUrn, catalogCandidateTarget } from "./semantic-catalog-contract.mjs";
import { createHash } from "node:crypto";
import { canonicalPublicationJson } from "./publication-review.mjs";
import {
  managedCycleRef, readManagedCycleInstructions, parseManagedCycle,
  managedDecisionTargets, initiallyVerifiedManagedPublication,
} from "./semantic-managed-cycle.mjs";

export async function readManagedDefinition(context, parent, link) {
  const records = taskRecords(context), run = await records.getRun(link.runUrn);
  const task = await records.getTask(run.value.task, run.value.taskVersion);
  const decision = run.value.decisions.find((item) => item.id === link.decisionId);
  let request;
  try { request = JSON.parse(decision?.publicationReview?.semanticContextJson ?? "null")?.request; } catch {}
  if (run.value.actor !== parent.value.actor || run.value.source !== parent.value.source ||
      run.value.sessionId !== parent.value.sessionId || task.urn !== link.taskUrn || task.version !== run.value.taskVersion ||
      task.value.actor !== parent.value.actor || task.value.source !== parent.value.source ||
      !task.value.datasets?.includes(link.assetUrn) ||
      task.value.agent !== context.sources.find((item) => item.urn === parent.value.source)?.semanticAgentUrn ||
      decision?.publicationReview?.planDigest !== link.planDigest || request?.sourceUrn !== parent.value.source ||
      request?.assetUrn !== link.assetUrn || request?.definition?.kind !== link.kind ||
      createHash("sha256").update(canonicalPublicationJson(request)).digest("hex") !== link.requestDigest ||
      catalogDefinitionUrn(request.definition, context.actor.tenant, parent.value.source) !== link.definitionUrn)
    throw new TaskRecordError("semantic_managed_definition_link_mismatch");
  return { run, task, decision, request };
}

/** One native Task CAS is the allocation authority. A missing successor Run
 * after allocation is uncertain, never a reason to allocate/replay another Run.
 */
export async function selectManagedCycle(context, scope, approval) {
  const root = managedCycleRef(context.actor.key, scope, approval.policy.id);
  const records = taskRecords(context);
  let task;
  try {
    task = await records.getTask(root.taskUrn);
  } catch (error) {
    if (!(error instanceof TaskRecordError) || error.message !== "task_record_not_found") throw error;
    return { ref: root, generation: 1 };
  }
  const cycle = readManagedCycleInstructions(task);
  const generation = cycle.generation ?? 1;
  const current = managedCycleRef(context.actor.key, scope, approval.policy.id, generation);
  let run;
  try {
    run = await records.getRun(current.runUrn);
  } catch (error) {
    if (!(error instanceof TaskRecordError) || error.message !== "task_record_not_found") throw error;
    throw new TaskRecordError("semantic_managed_cycle_incomplete", 409, { ...current, retryAllowed: false });
  }
  parseManagedCycle(run, task, scope, context.actor, (context.now ?? Date.now)());
  if (cycle.policyId !== approval.policy.id || cycle.policyDigest !== approval.policyDigest ||
      task.value.agent !== context.sources.find((item) => item.urn === scope.sourceUrn)?.semanticAgentUrn)
    throw new TaskRecordError("semantic_managed_policy_stale");
  if (run.value.closedAt === undefined)
    return { ref: current, task, run, generation,
      ...(cycle.previousCycleRunUrn ? { previousCycleRunUrn: cycle.previousCycleRunUrn } : {}) };
  // A generic owner close is not proof of a completed semantic attempt. Require
  // initial success, not later MATCHED observations, before any successor.
  const accounted = new Set();
  for (const decision of run.value.decisions) {
    const target = managedDecisionTargets(decision, scope);
    if (target.shared) {
      const child = await readManagedDefinition(context, run, target.shared);
      if (decision.response?.text !== decision.question || decision.response?.action !== "RESPOND" ||
          decision.response.actor !== context.actor.urn ||
          !(child.decision.publicationAttempt ? initiallyVerifiedManagedPublication(child.decision)
            : child.decision.response?.publicationVerdict?.verdict === "REJECT"))
        throw new TaskRecordError("semantic_managed_previous_cycle_unverified");
      continue;
    }
    const observed = target.exception || target.retention;
    const settled = observed ? decision.response?.text === decision.question &&
      decision.response?.action === "RESPOND" && decision.response.actor === context.actor.urn &&
      Number.isSafeInteger(decision.response.respondedAt) && decision.response.respondedAt >= decision.requestedAt
      : decision.publicationAttempt ? initiallyVerifiedManagedPublication(decision)
      : decision.response?.publicationVerdict?.verdict === "REJECT";
    if (!settled) throw new TaskRecordError("semantic_managed_previous_cycle_unverified");
    if (!observed && !decision.publicationAttempt) continue;
    for (const key of target.keys) {
      if (accounted.has(key)) throw new TaskRecordError("semantic_managed_target_conflict");
      accounted.add(key);
    }
  }
  if (accounted.size !== scope.datasetCount + scope.fieldCount)
    throw new TaskRecordError("semantic_managed_previous_cycle_unverified");
  return { ref: managedCycleRef(context.actor.key, scope, approval.policy.id, generation + 1),
    task, previousRun: run, generation: generation + 1, previousCycleRunUrn: run.urn };
}

/** Resolve only a selected description from native, initially verified history.
 * The whole Aspect is deliberately not adopted. ACL failures are not hidden.
 */
export async function priorManagedDescription(context, policy, row, assetUrn, fieldPath) {
  const aspect = fieldPath === undefined ? "editableDatasetProperties" : "editableSchemaMetadata";
  if (!row[aspect] || policy.semanticAuditAudience !== "EXISTING_TASK_RUN_ACL")
    return { status: "NO_AGENT_BASELINE" };
  return taskRecords(context).priorSemanticDescription(
    assetUrn, fieldPath, policy.urn, row[aspect], row.schemaMetadata?.systemMetadata.version,
  );
}

export async function priorManagedSelection(context, policy, row, assetUrn, candidate, fieldRow) {
  const target = catalogCandidateTarget(assetUrn, candidate);
  const current = (target.urn === assetUrn ? row : fieldRow)?.[target.aspect];
  if (!current || policy.semanticAuditAudience !== "EXISTING_TASK_RUN_ACL") return { status: "NO_AGENT_BASELINE" };
  return taskRecords(context).priorSemanticSelection(assetUrn, {
    kind: candidate.kind, fieldPath: candidate.fieldPath,
    ...(candidate.kind === "property" ? { propertyUrn: candidate.value } : {}),
  }, policy.urn, current, row.schemaMetadata?.systemMetadata.version);
}

/** Written statements only. Identity/name/type are never meaning evidence.
 * Conflicting written statements are surfaced, not silently ranked by an LLM.
 */
export async function managedDescriptionPlan({ context, policy, approval, row, assetUrn, fields, evidence, offset }) {
  const edits = row.editableSchemaMetadata?.value.editableSchemaFieldInfo ?? [];
  const targets = [
    ...(offset === 0 ? [{ fieldPath: undefined, before: row.editableDatasetProperties?.value.description ?? null,
      ids: evidence.filter((item) => item.id === "asset:source-description" || /^asset:contract-statement-[0-9]+$/.test(item.id)).map((item) => item.id) }] : []),
    ...fields.slice(offset, offset + 20).map((field, index) => ({
      fieldPath: field.fieldPath,
      before: edits.find((item) => item.fieldPath === field.fieldPath)?.description ?? null,
      ids: evidence.filter((item) => item.id === `field:${offset + index}:source-description` ||
        item.id.startsWith(`field:${offset + index}:contract-metric-`) ||
        item.id.startsWith(`field:${offset + index}:contract-statement-`)).map((item) => item.id),
    })),
  ];
  const items = [];
  for (const target of targets) {
    const proof = evidence.filter((item) => target.ids.includes(item.id) && typeof item.text === "string" && item.text.trim());
    const values = [...new Set(proof.map((item) => item.text.trim()))];
    const priorAgent = await priorManagedDescription(context, policy, row, assetUrn, target.fieldPath);
    const after = values.length === 1 ? values[0] : null;
    const disposition = values.length === 0 ? "INSUFFICIENT_EVIDENCE"
      : values.length > 1 ? "AMBIGUOUS_MEANING"
      : target.before === after ? "KEEP"
      : target.before === null ? "ADD"
      : priorAgent.status === "VERIFIED_AGENT_BASELINE" && priorAgent.schemaUnchanged ? "UPDATE_AGENT"
      : "REVIEW_HUMAN_OR_CHANGED_VALUE";
    const allowed = approval?.policy.allowedKinds.includes("description") &&
      (approval.policy.allowedTargets === undefined || approval.policy.allowedTargets.some((item) =>
        item.assetUrn === assetUrn && item.fieldPath === target.fieldPath));
    const routing = priorAgent.status === "UNVERIFIED_AGENT_BASELINE" ? "BLOCKED_UNVERIFIED_ATTEMPT"
      : after === null ? "NEEDS_EVIDENCE" : disposition === "KEEP" ? "NO_WRITE"
      : !approval ? "READ_ONLY" : !allowed ? "POLICY_DENIED"
      : approval.policy.mode === "REVIEW" || disposition === "REVIEW_HUMAN_OR_CHANGED_VALUE" ||
        (disposition === "UPDATE_AGENT" && approval.policy.allowAgentDescriptionUpdates !== true)
        ? "HUMAN_REVIEW" : "OPERATOR_POLICY";
    items.push({
      assetUrn, ...(target.fieldPath === undefined ? {} : { fieldPath: target.fieldPath }),
      kind: "description", disposition, routing, before: target.before, after, priorAgent, evidence: proof,
      impact: { assets: [assetUrn], sharedDefinitionChanged: false },
      ...(after === null ? {} : {
        candidate: {
          kind: "description", operation: "set", value: after,
          ...(target.fieldPath === undefined ? {} : { fieldPath: target.fieldPath }),
          reason: "Use the exact observed written statement; protect human values and require native prior-Agent history for automatic updates.",
          evidenceIds: proof.map((item) => item.id),
        },
      }),
    });
  }
  return {
    items,
    supportedAutomaticChanges: ["description_fill", "explicitly_enabled_intact_agent_description_update"],
    otherKinds: ["domain", "node", "term", "tag", "property"],
    note: "Other semantic kinds use existing vocabulary inspection, exact preview and human review. This plan does not infer their meaning, global uniqueness or safe shared impact. KEEP can record a native no-change observation without writing target metadata; it is not a publication receipt.",
  };
}

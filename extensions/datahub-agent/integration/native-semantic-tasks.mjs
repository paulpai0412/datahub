import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { nativeSemantic, SemanticError } from "./native-semantic.mjs";
import { taskRecords, TaskRecordError } from "./task-records.mjs";
import { compileSemanticPublication, recompileSemanticPublication, verifySemanticPublicationContext, semanticCandidateId } from "./semantic-publication.mjs";
import { stewardVersion } from "./semantic-preservation.mjs";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const proposalKeys = ["sourceUrn", "datasetUrn", "snapshotDigest", "fieldPath", "candidates", "definition", "reason", "evidenceIds"];
const actions = {
  prepare_review: ["requestId", "sessionId", "uiRequestId", ...proposalKeys],
  read_review: ["requestId", "runUrn", "decisionId"],
  select_review: ["runUrn", "decisionId", "version", "planDigest", "candidateIds"],
  approve_review: ["runUrn", "decisionId", "version", "planDigest"],
  reject_review: ["runUrn", "decisionId", "version", "planDigest"],
  publish_review: ["runUrn", "decisionId", "version", "planDigest"],
};
const fail = (code, ref) => { throw new TaskRecordError(code, 409, ref); };

/** Authenticated parent Host only. The MFE accepts only prepare/read intents
 * from the iframe; selection, consent and publication originate in its own UI.
 * No new session, prompt, datastore or automatic recovery/retry is introduced.
 */
export async function semanticHost(raw, context) {
  let input;
  try { input = JSON.parse(raw); } catch { throw new SemanticError("invalid_semantic_request"); }
  if (!input || typeof input !== "object" || Array.isArray(input) || Buffer.byteLength(raw) > 24000) throw new SemanticError("invalid_semantic_request");
  if (!Object.hasOwn(actions, input.action)) return nativeSemantic(raw, context);
  if (Object.keys(input).some((key) => key !== "action" && !actions[input.action].includes(key))) fail("invalid_semantic_request");
  const records = taskRecords({ ...context,
    recompilePublication: (review) => recompileSemanticPublication(review, context),
    verifyPublicationReadback: async (review) => {
      try { return await verifySemanticPublicationContext(review, context); }
      catch (error) { throw new TaskRecordError(error instanceof SemanticError ? error.message : "semantic_readback_unverified"); }
    } });
  const now = context.now ?? Date.now;
  function policy(source) {
    const entry = context.sources.find((entry) => entry.urn === source);
    if (entry?.semanticModelContextApproved !== true || entry.semanticPublicationApproved !== true || !entry.semanticAgentUrn) fail("semantic_publication_not_authorized");
    if (entry.semanticAuditAudience !== "EXISTING_TASK_RUN_ACL") fail("semantic_audit_visibility_not_approved");
    return entry;
  }
  async function read(runUrn, decisionId) {
    const prefix = `urn:li:dataProcessInstance:semantic-${context.actor.key}-`;
    if (!runUrn.startsWith(prefix) || !uuid.test(runUrn.slice(prefix.length))) fail("semantic_review_actor_scope_mismatch");
    const run = await records.getRun(runUrn);
    if (run.value.actor !== context.actor.urn) fail("task_owner_mismatch");
    policy(run.value.source);
    const decision = run.value.decisions.find((entry) => entry.id === decisionId);
    if (decision?.publicationReview?.analysisVersion !== stewardVersion) fail("semantic_review_not_found", { runUrn, taskUrn: run.value.task, decisionId, retryAllowed: false });
    const review = decision.publicationReview;
    const saved = JSON.parse(review.semanticContextJson);
    if (saved.actor !== context.actor.urn || saved.request.sourceUrn !== run.value.source) fail("semantic_review_binding_mismatch");
    // Do not expose saved evidence after Dataset/Source read authority is revoked.
    const inspected = await nativeSemantic(JSON.stringify({ action: "inspect_dataset", requestId: randomUUID(),
      sourceUrn: review.source, datasetUrn: saved.request.datasetUrn, ...(saved.request.fieldPath ? { fieldPath: saved.request.fieldPath } : {}) }), context);
    await nativeSemantic(JSON.stringify({ ...saved.request, snapshotDigest: inspected.snapshotDigest }), context);
    return { run, decision, review, saved, stale: inspected.snapshotDigest !== saved.request.snapshotDigest };
  }
  async function view(value, publication) {
    const { run, decision, review, saved } = value;
    let reconciliation, currentContext;
    if (decision.publicationAttempt) {
      reconciliation = await records.reconcilePublication(run.urn, decision.id);
      try { currentContext = await verifySemanticPublicationContext(review, context); }
      catch (error) { currentContext = { status: "CONTEXT_CHANGED_OR_UNVERIFIED", reason: error instanceof SemanticError ? error.message : "semantic_readback_unverified" }; }
    }
    const state = decision.publicationAttempt ? "ATTEMPTED" : decision.response?.publicationVerdict?.verdict ?? "PENDING";
    const result = { format: "datahub-semantic.review/1", action: input.action, ...(input.requestId ? { requestId: input.requestId } : {}),
      publicationAuthorized: false, reviewRef: { runUrn: run.urn, decisionId: decision.id }, taskUrn: run.value.task,
      runVersion: run.version, planDigest: review.planDigest, expiresAt: review.expiresAt,
      expired: now() >= review.expiresAt, closed: run.value.closedAt !== undefined,
      stale: currentContext ? currentContext.status !== "SOURCE_SCHEMA_REFERENCES_RECHECKED" : value.stale, state,
      preview: { ...saved.preview, asOf: new Date(saved.createdAt).toISOString() }, candidateIds: review.candidateIds,
      // Only projected semantic evidence returns to the model. Raw preserved
      // Aspect members/before-values remain in the native audit record.
      history: run.value.decisions.filter((entry) => entry.publicationReview?.analysisVersion === stewardVersion).map((entry) => ({
        decisionId: entry.id, planDigest: entry.publicationReview.planDigest,
        verdict: entry.response?.publicationVerdict?.verdict ?? "PENDING", requestedAt: entry.requestedAt,
        ...(entry.response ? { respondedAt: entry.response.respondedAt, actor: entry.response.actor } : {}) })),
      ...(decision.publicationAttempt ? { attempt: decision.publicationAttempt, reconciliation, currentContext } : {}),
      ...(publication ? { publication } : {}),
      auditAudience: "EXISTING_TASK_RUN_ACL",
      note: "Records follow native Task/Run ACL, not a private chat ACL. Approval is bound to this stored revision. An attempt is permanently consumed, including partial/unknown effects. Never replay it." };
    if (Buffer.byteLength(JSON.stringify(result)) > 48000) fail("semantic_response_too_large", result.reviewRef);
    return result;
  }
  if (input.action === "prepare_review") {
    if (!uuid.test(input.requestId) || !uuid.test(input.sessionId) || typeof input.uiRequestId !== "string" || !context.runtime) fail("semantic_native_request_required");
    const source = policy(input.sourceUrn);
    async function pending() {
      const result = await context.runtime.state(input.sessionId);
      const ui = result.state?.extensionUiRequests?.find((entry) => entry.id === input.uiRequestId && entry.method === "input" && entry.title === "DataHub semantic request");
      let body;
      try { body = JSON.parse(ui?.placeholder); } catch { fail("semantic_native_request_not_pending"); }
      const { uiRequestId: _ui, ...expected } = input;
      if (result.running !== true || result.state.sessionId !== input.sessionId || !isDeepStrictEqual(body, expected)) fail("semantic_native_request_mismatch");
    }
    await pending();
    const id = `semantic-${context.actor.key}-${input.requestId}`;
    const runUrn = `urn:li:dataProcessInstance:${id}`;
    const taskUrn = `urn:li:dataJob:(urn:li:dataFlow:(pi,ekop-agent-${context.actor.key},DEV),${id})`;
    const request = { action: input.definition ? "preview_definition" : "preview", requestId: input.requestId,
      ...Object.fromEntries(proposalKeys.filter((key) => input[key] !== undefined).map((key) => [key, input[key]])) };
    try {
      const previous = await read(runUrn, input.requestId);
      if (!isDeepStrictEqual(previous.saved.request, request)) fail("semantic_preparation_mismatch");
      return view(previous); // A reconnect can only read an existing preparation.
    } catch (error) { if (!(error instanceof TaskRecordError) || error.message !== "task_record_not_found") throw error; }
    try { await records.getTask(taskUrn); fail("semantic_preparation_incomplete", { taskUrn, runUrn }); }
    catch (error) { if (!(error instanceof TaskRecordError) || error.message !== "task_record_not_found") throw error; }
    const review = await compileSemanticPublication(request, context);
    await pending();
    try {
      const task = await records.createTask(taskUrn, { agent: source.semanticAgentUrn, source: input.sourceUrn,
        datasets: review.datasets, instructions: "Semantic Steward: review the persisted evidence and exact versioned additions. No SQL, ingestion or blanket Aspect ownership.", allowDecisions: true });
      const run = await records.bindRun(runUrn, taskUrn, task.version, input.sessionId);
      await records.appendPublicationReview(runUrn, run.version, input.sessionId,
        { id: input.requestId, question: "Review selected Semantic Steward additions; preserve human values.", choices: [] }, review);
      return await view(await read(runUrn, input.requestId));
    } catch (error) {
      throw new TaskRecordError(error instanceof TaskRecordError || error instanceof SemanticError ? error.message : "semantic_preparation_unconfirmed", 409,
        { ...error.reconciliation, taskUrn, runUrn, decisionId: input.requestId, retryAllowed: false });
    }
  }
  if (typeof input.runUrn !== "string" || typeof input.decisionId !== "string") fail("invalid_semantic_request");
  const current = await read(input.runUrn, input.decisionId);
  if (input.action === "read_review") return view(current);
  const { run, review, saved, decision } = current;
  if (run.version !== input.version || review.planDigest !== input.planDigest) fail("semantic_review_revision_conflict");
  if (input.action === "select_review") {
    if (!Array.isArray(input.candidateIds) || !input.candidateIds.length || new Set(input.candidateIds).size !== input.candidateIds.length ||
        input.candidateIds.some((id) => !review.candidateIds.includes(id)) || saved.request.definition) fail("semantic_selection_invalid");
    const request = { ...saved.request, candidates: saved.request.candidates.filter((item) => input.candidateIds.includes(semanticCandidateId(item))) };
    const next = await compileSemanticPublication(request, context, { createdAt: saved.createdAt, expiresAt: review.expiresAt });
    const nextId = randomUUID();
    await records.selectPublicationReview(run.urn, run.version, run.value.sessionId, decision.id, review.planDigest, next, nextId);
    return view(await read(run.urn, nextId));
  }
  if (input.action === "reject_review") {
    await records.respondPublicationReview(run.urn, run.version, run.value.sessionId, decision.id, { verdict: "REJECT", planDigest: review.planDigest });
    return view(await read(run.urn, decision.id));
  }
  let version = run.version;
  if (input.action === "approve_review") {
    const approved = await records.respondPublicationReview(run.urn, version, run.value.sessionId, decision.id, { verdict: "APPROVE", planDigest: review.planDigest });
    version = approved.version;
  }
  const publication = await records.publishPublication(run.urn, version, run.value.sessionId, decision.id, review);
  return view(await read(run.urn, decision.id), publication);
}

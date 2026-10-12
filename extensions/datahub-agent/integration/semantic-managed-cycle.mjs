import { createHash } from "node:crypto";
import { canonicalPublicationJson } from "./publication-review.mjs";
import { SemanticError } from "./semantic-native-client.mjs";

const prefix = "semantic-managed-cycle/1:";
const exceptionPrefix = "semantic-managed-exception/1:";
const retentionPrefix = "semantic-managed-retention/1:";
const definitionPrefix = "semantic-managed-definition/1:";
const valid = (condition, code = "semantic_managed_cycle_invalid") => {
  if (!condition) throw new SemanticError(code, 409);
};
const text = (value) => typeof value === "string" && value.length > 0;
export function managedCycleRef(actorKey, scope, policyId, generation = 1) {
  valid(
    /^[a-f0-9]{48}$/.test(actorKey ?? "") &&
      text(scope?.sourceUrn) &&
      /^[a-f0-9]{64}$/.test(scope?.fingerprint ?? "") &&
      text(policyId) && Number.isSafeInteger(generation) && generation >= 1,
  );
  const rootHex = createHash("sha256")
    .update(
      canonicalPublicationJson([
        actorKey,
        scope.sourceUrn,
        scope.fingerprint,
        policyId,
      ]),
    )
    .digest("hex")
    .slice(0, 32);
  const hex = generation === 1 ? rootHex : createHash("sha256").update(canonicalPublicationJson([rootHex, generation])).digest("hex").slice(0, 32);
  const key = (value) => `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
  return {
    runUrn: `urn:li:dataProcessInstance:semantic-${actorKey}-${key(hex)}`,
    taskUrn: `urn:li:dataJob:(urn:li:dataFlow:(pi,ekop-agent-${actorKey},DEV),semantic-${actorKey}-${key(rootHex)})`,
  };
}
const exceptionCodes = new Set([
  "INSUFFICIENT_EVIDENCE",
  "HUMAN_VALUE",
  "SHARED_IMPACT",
  "AMBIGUOUS_MEANING",
  "UNSUPPORTED_CHANGE",
  "POLICY_DENIED",
]);

export function managedCycleInstructions(scope, proof, createdAt, round = {}) {
  valid(
    scope?.completeEnumeratedRecipeScope === true &&
      text(scope.fingerprint) &&
      Number.isSafeInteger(createdAt) &&
      proof?.scopeFingerprint === scope.fingerprint &&
      text(proof.policyId) &&
      text(proof.policyDigest),
  );
  const value = {
    scopeFingerprint: scope.fingerprint,
    executionUrn: scope.executionUrn,
    policyId: proof.policyId,
    policyDigest: proof.policyDigest,
    datasetCount: scope.datasetCount,
    fieldCount: scope.fieldCount,
    createdAt,
    expiresAt: createdAt + 7200000,
    ...round,
  };
  const instructions = prefix + canonicalPublicationJson(value);
  valid(instructions.length <= 2048);
  return instructions;
}

export function readManagedCycleInstructions(task) {
  try {
    valid(task?.value?.instructions?.startsWith(prefix));
    const cycle = JSON.parse(task.value.instructions.slice(prefix.length));
    valid(cycle && typeof cycle === "object" && !Array.isArray(cycle));
    return cycle;
  } catch {
    valid(false);
  }
}

/** Initial success is immutable evidence, independent of later observations. */
export function initiallyVerifiedManagedPublication(decision) {
  try {
    const attempt = decision?.publicationAttempt;
    const outcome = JSON.parse(attempt?.outcomeJson ?? "null");
    return outcome?.status === "VERIFIED_CURRENT_VALUES" &&
      Number.isSafeInteger(outcome.recordedAt) && outcome.recordedAt >= attempt.claimedAt &&
      outcome.contextVerification?.status === "SOURCE_SCHEMA_REFERENCES_RECHECKED" &&
      Array.isArray(outcome.observations) && outcome.observations.length === decision.publicationReview.changes.length &&
      outcome.observations.every((item, index) => item.state === "MATCHED" &&
        item.urn === decision.publicationReview.changes[index].urn && item.aspect === decision.publicationReview.changes[index].aspect);
  } catch {
    return false;
  }
}

export function parseManagedCycle(
  run,
  task,
  scope,
  actor,
  now,
  writable = false,
) {
  const cycle = readManagedCycleInstructions(task);
  valid(
    run?.value?.task === task.urn && run.value.taskVersion === task.version &&
      run.value.source === task.value.source &&
      run.value.actor === actor.urn &&
      task.value.actor === actor.urn &&
      task.value.source === scope.sourceUrn &&
      task.value.agent &&
      run.value.sessionId &&
      task.value.datasets?.length === scope.datasetCount &&
      task.value.datasets.every((urn, i) => urn === scope.datasets[i]?.urn) &&
      cycle.scopeFingerprint === scope.fingerprint &&
      cycle.executionUrn === scope.executionUrn &&
      cycle.datasetCount === scope.datasetCount &&
      cycle.fieldCount === scope.fieldCount &&
      Number.isSafeInteger(cycle.createdAt) &&
      Number.isSafeInteger(cycle.expiresAt) &&
      cycle.expiresAt === cycle.createdAt + 7200000 &&
      text(cycle.policyId) &&
      text(cycle.policyDigest) &&
      (cycle.generation === undefined ||
        (Number.isSafeInteger(cycle.generation) && cycle.generation >= 1 &&
          cycle.currentCycleRunUrn === run.urn &&
          (cycle.generation === 1 ? cycle.previousCycleRunUrn === undefined : text(cycle.previousCycleRunUrn)))) &&
      Array.isArray(run.value.decisions),
  );
  if (writable)
    valid(
      run.value.closedAt === undefined &&
        now < cycle.expiresAt &&
        now >= cycle.createdAt,
      "semantic_managed_cycle_closed_or_expired",
    );
  return cycle;
}

export function managedException(input, scope) {
  valid(
    input?.code &&
      exceptionCodes.has(input.code) &&
      scope.datasets.some(
        (row) =>
          row.urn === input.assetUrn &&
          (input.fieldPath === undefined ||
            row.fields.includes(input.fieldPath)),
      ),
    "semantic_managed_exception_invalid",
  );
  const audit = input.auditRecovery;
  if (audit !== undefined)
    valid(audit !== null && typeof audit === "object" && !Array.isArray(audit) &&
      Object.keys(audit).every((key) => ["id", "grantDigest", "policyDigest", "scopeFingerprint", "expiresAt"].includes(key)) &&
      input.code === "POLICY_DENIED" && typeof audit.id === "string" && /^[a-z][a-z0-9._-]{2,63}$/.test(audit.id) &&
      typeof audit.grantDigest === "string" && /^[a-f0-9]{64}$/.test(audit.grantDigest) &&
      typeof audit.policyDigest === "string" && /^[a-f0-9]{64}$/.test(audit.policyDigest) &&
      audit.scopeFingerprint === scope.fingerprint && Number.isSafeInteger(audit.expiresAt) && audit.expiresAt > 0,
      "semantic_managed_exception_invalid");
  const entry = {
    assetUrn: input.assetUrn,
    code: input.code,
    ...(input.fieldPath === undefined ? {} : { fieldPath: input.fieldPath }),
    ...(audit === undefined ? {} : { auditRecovery: audit }),
  };
  return exceptionPrefix + canonicalPublicationJson(entry);
}

/** The persisted Decision owns the logical targets, not a caller's requestId.
 * Shared by write admission and readback so an exception cannot hide an attempt.
 */
export function managedRetention(value, scope) {
  valid(value && Object.keys(value).every((key) => ["assetUrn", "fieldPaths", "fieldPath", "snapshotDigest", "requestDigest", "valuesDigest", "selectors", "observedAt"].includes(key)) &&
    scope.datasets.some((row) => row.urn === value.assetUrn &&
    Array.isArray(value.fieldPaths) && value.fieldPaths.length > 0 && value.fieldPaths.length <= 8 &&
    new Set(value.fieldPaths).size === value.fieldPaths.length &&
    value.fieldPaths.every((path) => path === null || row.fields.includes(path))) &&
    /^[a-f0-9]{64}$/.test(value.snapshotDigest ?? "") && /^[a-f0-9]{64}$/.test(value.requestDigest ?? "") &&
    /^[a-f0-9]{64}$/.test(value.valuesDigest ?? "") && Array.isArray(value.selectors) && value.selectors.length > 0 && value.selectors.length <= 8 &&
    value.selectors.every((item) => item && Object.keys(item).every((key) => ["kind", "aspect", "fieldPath", "propertyUrn"].includes(key)) &&
      ["description", "domain", "tag", "term", "property"].includes(item.kind) &&
      item.aspect === (item.fieldPath === undefined ? { description: "editableDatasetProperties", domain: "domains", tag: "globalTags", term: "glossaryTerms", property: "structuredProperties" }[item.kind]
        : item.kind === "property" ? "structuredProperties" : item.kind === "domain" ? null : "editableSchemaMetadata") &&
      value.fieldPaths.includes(item.fieldPath ?? null) &&
      (item.kind === "property" ? text(item.propertyUrn) && item.propertyUrn.startsWith("urn:li:structuredProperty:") &&
        (item.fieldPath === undefined || item.fieldPath === value.fieldPath) : item.propertyUrn === undefined)) &&
    value.fieldPaths.every((path) => value.selectors.some((item) => (item.fieldPath ?? null) === path)) &&
    Number.isSafeInteger(value.observedAt) && value.observedAt >= 0 &&
    (value.fieldPath === undefined || scope.datasets.find((row) => row.urn === value.assetUrn).fields.includes(value.fieldPath)),
    "semantic_managed_retention_invalid");
  const question = retentionPrefix + canonicalPublicationJson(value);
  valid(question.length <= 2048, "semantic_managed_retention_too_large");
  return question;
}

export function managedDefinitionLink(value, scope) {
  valid(value && Object.keys(value).every((key) => ["assetUrn", "definitionUrn", "kind", "runUrn", "taskUrn", "decisionId", "planDigest", "requestDigest"].includes(key)) &&
    scope.datasets.some((row) => row.urn === value.assetUrn) &&
    ["domain", "node", "term", "tag", "property"].includes(value.kind) &&
    text(value.definitionUrn) && text(value.runUrn) && text(value.taskUrn) && text(value.decisionId) &&
    /^[a-f0-9]{64}$/.test(value.planDigest ?? "") && /^[a-f0-9]{64}$/.test(value.requestDigest ?? ""),
    "semantic_managed_definition_link_invalid");
  const question = definitionPrefix + canonicalPublicationJson(value);
  valid(question.length <= 2048, "semantic_managed_definition_link_invalid");
  return question;
}

export function managedDecisionTargets(decision, scope) {
  if (decision.question?.startsWith(definitionPrefix)) {
    let shared;
    try { shared = JSON.parse(decision.question.slice(definitionPrefix.length)); } catch { valid(false); }
    valid(!decision.publicationReview && !decision.publicationAttempt && managedDefinitionLink(shared, scope) === decision.question,
      "semantic_managed_definition_link_invalid");
    return { keys: [], shared };
  }
  if (decision.question?.startsWith(retentionPrefix)) {
    let retention;
    try { retention = JSON.parse(decision.question.slice(retentionPrefix.length)); } catch { valid(false); }
    valid(!decision.publicationReview && !decision.publicationAttempt && managedRetention(retention, scope) === decision.question);
    return { keys: retention.fieldPaths.map((path) => JSON.stringify([retention.assetUrn, path])), retention };
  }
  if (decision.question?.startsWith(exceptionPrefix)) {
    let exception;
    try {
      exception = JSON.parse(decision.question.slice(exceptionPrefix.length));
    } catch {
      valid(false);
    }
    valid(
      !decision.publicationReview &&
        !decision.publicationAttempt &&
        managedException(exception, scope) === decision.question,
    );
    return {
      keys: [JSON.stringify([exception.assetUrn, exception.fieldPath ?? null])],
      exception,
    };
  }
  if (!decision.publicationReview) {
    valid(!decision.publicationAttempt);
    return { keys: [] };
  }
  let request;
  try {
    request = JSON.parse(decision.publicationReview.semanticContextJson).request;
  } catch {
    valid(false);
  }
  const dataset = scope.datasets.find((row) => row.urn === request?.assetUrn);
  valid(
    request?.sourceUrn === scope.sourceUrn &&
      dataset &&
      Array.isArray(request.candidates) &&
      request.candidates.length > 0 &&
      request.candidates.every(
        (item) => item && (item.fieldPath === undefined || dataset.fields.includes(item.fieldPath)),
      ),
  );
  return {
    keys: [...new Set(request.candidates.map((item) =>
      JSON.stringify([request.assetUrn, item.fieldPath ?? null]),
    ))],
  };
}

export function managedCycleProjection(
  run,
  scope,
  observations = new Map(),
  offset = 0,
  policyDigest,
) {
  valid(Number.isSafeInteger(offset) && offset >= 0 && offset <= 1000);
  const targets = new Map(
    scope.datasets.flatMap((row) => [
      [JSON.stringify([row.urn, null]), [row.urn, null]],
      ...row.fields.map((field) => [
        JSON.stringify([row.urn, field]),
        [row.urn, field],
      ]),
    ]),
  );
  const accounted = new Set(),
    reserved = new Set(),
    exceptions = [],
    publications = [],
    retentions = [],
    definitions = [],
    pending = [];
  for (const decision of run.value.decisions) {
    const { keys, exception, retention, shared } = managedDecisionTargets(decision, scope);
    const rejected =
      decision.publicationReview !== undefined &&
      !decision.publicationAttempt &&
      decision.response?.publicationVerdict?.verdict === "REJECT";
    // A rejected/superseded unattempted proposal may be replaced. An attempt
    // (even NOT_DISPATCHED), pending proposal or exception permanently owns its slot.
    if (!rejected) {
      valid(keys.every((key) => !reserved.has(key)), "semantic_managed_target_conflict");
      for (const key of keys) reserved.add(key);
    }
    if (shared) {
      const acknowledged = decision.response?.action === "RESPOND" && decision.response.actor === run.value.actor && decision.response.text === decision.question;
      const status = acknowledged ? observations.get(decision.id)?.status ?? "UNCONFIRMED" : "LINK_UNCONFIRMED";
      definitions.push({ decisionId: decision.id, ...shared, status });
      if (!["VERIFIED", "REJECTED"].includes(status)) pending.push({ decisionId: decision.id, status: `DEFINITION_${status}` });
      continue;
    }
    if (retention) {
      const acknowledged = decision.response?.action === "RESPOND" && decision.response.actor === run.value.actor &&
        decision.response.text === decision.question && Number.isSafeInteger(decision.response.respondedAt) &&
        decision.response.respondedAt >= decision.requestedAt && decision.requestedAt >= retention.observedAt;
      const confirmed = acknowledged && observations.get(decision.id)?.status === "CURRENT_NO_CHANGE";
      if (confirmed) for (const key of keys) accounted.add(key);
      else pending.push({ decisionId: decision.id, status: acknowledged ? "RETENTION_CHANGED_OR_UNVERIFIED" : "RETENTION_RESPONSE_UNCONFIRMED" });
      retentions.push({ decisionId: decision.id, assetUrn: retention.assetUrn, fieldPaths: retention.fieldPaths,
        observedAt: retention.observedAt, status: confirmed ? "OBSERVED_NO_CHANGE" : "CHANGED_OR_UNVERIFIED" });
      continue;
    }
    if (exception) {
      valid(
        decision.response?.action === "RESPOND" &&
          decision.response.actor === run.value.actor &&
          Number.isSafeInteger(decision.response.respondedAt) &&
          decision.response.respondedAt >= decision.requestedAt &&
          decision.response.text === decision.question,
      );
      if (exception.auditRecovery)
        valid(exception.auditRecovery.policyDigest === policyDigest &&
          Number.isSafeInteger(decision.requestedAt) &&
          decision.requestedAt >= exception.auditRecovery.expiresAt - 1800000 &&
          decision.requestedAt < exception.auditRecovery.expiresAt &&
          decision.response.respondedAt < exception.auditRecovery.expiresAt,
          "semantic_managed_audit_receipt_invalid");
      accounted.add(keys[0]);
      exceptions.push({ decisionId: decision.id, ...exception });
      continue;
    }
    if (!decision.publicationReview) {
      pending.push({ decisionId: decision.id, status: "UNRECOGNIZED" });
      continue;
    }
    const observation = observations.get(decision.id);
    let initialOutcome;
    try {
      if (decision.publicationAttempt?.outcomeJson)
        initialOutcome = JSON.parse(decision.publicationAttempt.outcomeJson);
    } catch {
      valid(false);
    }
    const confirmed =
      initiallyVerifiedManagedPublication(decision) &&
      observation?.attemptId === decision.publicationAttempt?.attemptId &&
      observation?.status === "MATCHED_CLAIMED_ATTEMPT";
    const status = confirmed
      ? "VERIFIED"
      : initialOutcome?.status === "NOT_DISPATCHED"
        ? "NOT_DISPATCHED"
        : decision.publicationAttempt
          ? "UNKNOWN_OR_CHANGED"
          : rejected
            ? "REJECTED"
            : "NO_ATTEMPT";
    if (confirmed) for (const key of keys) accounted.add(key);
    else if (!["NOT_DISPATCHED", "REJECTED"].includes(status))
      pending.push({ decisionId: decision.id, status });
    publications.push({
      decisionId: decision.id,
      status,
      targets: keys.map((key) => targets.get(key)),
    });
  }
  const missing = [...targets]
    .filter(([key]) => !accounted.has(key))
    .map(([, value]) => value);
  const pendingCount = pending.length,
    page = (items) => items.slice(offset, offset + 20);
  return {
    format: "datahub-semantic.managed-cycle/1",
    runUrn: run.urn,
    sourceUrn: scope.sourceUrn,
    scopeFingerprint: scope.fingerprint,
    executionUrn: scope.executionUrn,
    datasetCount: scope.datasetCount,
    fieldCount: scope.fieldCount,
    targetCount: targets.size,
    accountedCount: accounted.size,
    missingCount: missing.length,
    missing: page(missing),
    exceptionCount: exceptions.length,
    exceptions: page(exceptions),
    publicationCount: publications.length,
    publications: page(publications),
    retentionCount: retentions.length,
    retentions: page(retentions),
    definitionCount: definitions.length,
    definitions: page(definitions),
    pendingCount,
    pending: page(pending),
    offset,
    nextMissingOffset: offset + 20 < missing.length ? offset + 20 : null,
    nextReceiptOffset:
      offset + 20 <
      Math.max(exceptions.length, publications.length, retentions.length, definitions.length, pending.length)
        ? offset + 20
        : null,
    status:
      missing.length === 0 && pendingCount === 0
        ? "SCOPE_ACCOUNTED_WITH_ITEM_RECEIPTS"
        : "INCOMPLETE_OR_UNVERIFIED",
    note: "Coverage means targets were recorded, not that every possible business meaning is known or published. Exceptions and UNKNOWN attempts remain visible.",
  };
}

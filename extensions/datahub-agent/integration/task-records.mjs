import { isDeepStrictEqual } from "node:util";
import { randomUUID, createHash } from "node:crypto";
import { datahubSessionCookie } from "./datahub-identity.mjs";
import { validateStewardChange } from "./semantic-preservation.mjs";
import {
  validatePublicationReview,
  canonicalPublicationJson,
  assertPublicationConsent,
  PublicationReviewError,
} from "./publication-review.mjs";
import {
  validateFixedEtlReview,
  validateFixedEtlReceipt,
  assertFixedEtlConsent,
  FixedEtlReviewError,
} from "./fixed-etl-review.mjs";

export class TaskRecordError extends Error {
  constructor(code, status = 409, reconciliation) {
    super(code);
    this.status = status;
    this.reconciliation = reconciliation;
  }
}

const definitions = {
  task: ["dataJob", "ekopAgentTask"],
  run: ["dataProcessInstance", "ekopAgentRun"],
};
const versionPattern = /^[1-9][0-9]*$/;
const text = (value, max) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;
function requireValue(condition, code = "invalid_task_request", status = 400) {
  if (!condition) throw new TaskRecordError(code, status);
}
function keys(value, allowed) {
  requireValue(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).every((key) => allowed.includes(key)),
  );
}
function urn(kind, value) {
  requireValue(
    text(value, 1024) && value.startsWith(`urn:li:${definitions[kind][0]}:`),
  );
}

// DataHub v1.7.0.1 updates runId but retains OLD systemMetadata.properties on
// Aspect updates. Keep the complete locator in the mutable native field, not
// properties from the ACK. The locator selects records; it never grants authority.
const publicationRunPrefix = "dataflow-discovery/1:";
function nativePublicationRunId(runUrn, decisionId, attemptId) {
  return publicationRunPrefix + JSON.stringify([runUrn, decisionId, attemptId]);
}
function nativePublicationProvenance(metadata) {
  const raw = metadata?.runId;
  if (!text(raw, 8192)) return undefined;
  let coordinates;
  if (raw.startsWith(publicationRunPrefix)) {
    try {
      coordinates = JSON.parse(raw.slice(publicationRunPrefix.length));
    } catch {
      return undefined;
    }
    if (!Array.isArray(coordinates) || coordinates.length !== 3)
      return undefined;
  } else {
    if (raw.startsWith("dataflow-discovery/")) return undefined;
    // Previously created Aspects can have a complete legacy locator. An opaque
    // UUID alone is NOT sufficient to discover ownership of an existing target.
    coordinates = [
      metadata.properties?.dataflowDiscoveryRunUrn,
      metadata.properties?.dataflowDiscoveryDecisionId,
      raw,
    ];
  }
  const [runUrn, decisionId, attemptId] = coordinates;
  if (
    !text(runUrn, 1024) ||
    !runUrn.startsWith("urn:li:dataProcessInstance:") ||
    !text(decisionId, 128) ||
    !text(attemptId, 128)
  )
    return undefined;
  if (
    raw.startsWith(publicationRunPrefix) &&
    raw !== nativePublicationRunId(runUrn, decisionId, attemptId)
  )
    return undefined;
  return { runUrn, decisionId, attemptId };
}

/** Per-request DataHub record boundary. No worker, cache, polling or local store.
 * The Host supplies a freshly verified actor and operator-owned source policy.
 * Session IDs passed to mutation methods MUST come from the Host's native Pi
 * session binding, not an unverified browser/model assertion. This module does
 * not start, resume or stop Pi, and a closed record is not proof of a stopped Pi.
 */
export function taskRecords({
  actor,
  sources,
  frontendOrigin,
  cookieHeader,
  assertActive,
  fetchImpl = fetch,
  now = Date.now,
  recompilePublication,
  verifyPublicationReadback,
  publicationAdoption,
  authorizeFixedEtl,
  recompileFixedEtl,
}) {
  requireValue(
    actor &&
      text(actor.urn, 512) &&
      actor.urn.startsWith("urn:li:corpuser:") &&
      Array.isArray(sources) &&
      typeof assertActive === "function",
    "invalid_task_host_context",
  );
  // Optional one-batch operator authorization, never an HTTP/model parameter.
  // It binds the exact review digest and original native values/creation stamps;
  // ordinary source compilation or a human publication verdict does not supply it.
  const adoption =
    publicationAdoption === undefined
      ? undefined
      : structuredClone(publicationAdoption);
  const cookie = datahubSessionCookie(cookieHeader);
  async function call(path, body, mutation) {
    assertActive();
    let response;
    try {
      response = await fetchImpl(new URL(path, frontendOrigin), {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(8000),
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if ([401, 403, 404, 412].includes(response.status))
          throw new TaskRecordError(
            "datahub_task_request_denied",
            response.status,
          );
        throw new Error("unexpected_datahub_status");
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 1048576) throw new Error("oversized_datahub_response");
        chunks.push(chunk);
      }
      const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (result.errors?.length)
        throw new TaskRecordError("task_identity_denied", 403);
      assertActive();
      return result;
    } catch (error) {
      if (error instanceof TaskRecordError) throw error;
      throw new TaskRecordError(
        mutation ? "task_write_unconfirmed" : "datahub_task_unavailable",
        502,
        mutation,
      );
    }
  }
  async function identity() {
    const result = await call("/api/v2/graphql", {
      query: "query { me { corpUser { urn } } }",
    });
    requireValue(
      result.data?.me?.corpUser?.urn === actor.urn,
      "task_identity_denied",
      403,
    );
  }
  function scope(task) {
    requireValue(task.actor === actor.urn, "task_owner_mismatch", 403);
    const source = sources.find((entry) => entry.urn === task.source);
    requireValue(
      source &&
        Array.isArray(source.taskDatasets) &&
        Array.isArray(task.datasets) &&
        task.datasets.length > 0 &&
        task.datasets.every((dataset) => source.taskDatasets.includes(dataset)),
      "task_scope_not_approved",
      403,
    );
  }
  function record(kind, id, items) {
    const [, aspect] = definitions[kind];
    // v3 batchGet reports an absent entity as HTTP 200 with an empty batch.
    if (Array.isArray(items) && items.length === 0)
      throw new TaskRecordError("task_record_not_found", 404);
    requireValue(
      Array.isArray(items) && items.length === 1 && items[0]?.urn === id,
      "invalid_datahub_task_response",
      502,
    );
    const value = items[0][aspect];
    requireValue(
      value?.value && versionPattern.test(value.systemMetadata?.version),
      "task_record_not_found",
      404,
    );
    return {
      urn: id,
      version: value.systemMetadata.version,
      value: value.value,
    };
  }
  async function read(kind, id, version) {
    urn(kind, id);
    requireValue(version === undefined || versionPattern.test(version));
    const [entity, aspect] = definitions[kind];
    const result = await call(
      `/openapi/v3/entity/${entity.toLowerCase()}/batchGet?systemMetadata=true`,
      [
        {
          urn: id,
          [aspect]:
            version === undefined
              ? {}
              : { headers: { "If-Version-Match": version } },
        },
      ],
    );
    return record(kind, id, result);
  }
  async function write(kind, id, value, expectedVersion, beforeSubmit) {
    urn(kind, id);
    requireValue(
      expectedVersion === "-1" || versionPattern.test(expectedVersion),
    );
    requireValue(
      Buffer.byteLength(JSON.stringify(value), "utf8") <= 524288,
      "task_record_too_large",
      400,
    );
    // Recheck the human identity immediately before the conditional write.
    await identity();
    // Time-sensitive consent may expire during this awaited identity read.
    beforeSubmit?.();
    const [entity, aspect] = definitions[kind];
    const reconciliation = { urn: id, expectedVersion };
    const result = await call(
      "/openapi/v3/entity/generic?async=false&systemMetadata=true",
      {
        [entity]: [
          {
            urn: id,
            [aspect]: {
              value,
              headers: { "If-Version-Match": expectedVersion },
            },
          },
        ],
      },
      reconciliation,
    );
    try {
      const acknowledged = record(kind, id, result[entity]);
      // Read the ACK's exact version: a concurrent later close must not turn a
      // successful write into a false readback mismatch or cause a resend.
      const stored = await read(kind, id, acknowledged.version);
      requireValue(
        isDeepStrictEqual(stored.value, value),
        "task_readback_mismatch",
        502,
      );
      return stored;
    } catch {
      throw new TaskRecordError("task_write_unconfirmed", 502, reconciliation);
    }
  }
  async function getTask(id, version) {
    await identity();
    // Metadata reads follow DataHub's native ACL. Only execution/mutation
    // operations below impose Task ownership; do not make Catalog data private.
    return read("task", id, version);
  }
  async function getRun(id, version) {
    await identity();
    const result = await read("run", id, version);
    const task = await read(
      "task",
      result.value.task,
      result.value.taskVersion,
    );
    requireValue(
      task.value.actor === result.value.actor &&
        task.value.source === result.value.source,
      "task_run_binding_mismatch",
      403,
    );
    return result;
  }
  async function activeRun(id, expectedVersion, nativeSessionId) {
    requireValue(versionPattern.test(expectedVersion));
    const run = await getRun(id);
    requireValue(run.value.actor === actor.urn, "task_owner_mismatch", 403);
    requireValue(
      run.value.sessionId === nativeSessionId && text(nativeSessionId, 128),
      "task_session_mismatch",
      403,
    );
    requireValue(run.value.closedAt === undefined, "task_run_closed");
    requireValue(run.version === expectedVersion, "task_run_revision_conflict");
    const task = await read("task", run.value.task);
    scope(task.value);
    requireValue(
      task.version === run.value.taskVersion &&
        task.value.source === run.value.source,
      "task_revision_conflict",
    );
    requireValue(Array.isArray(run.value.decisions), "invalid_task_run", 409);
    return { run, task };
  }
  function publication(review, task) {
    let checked;
    try {
      checked = validatePublicationReview(review, now());
    } catch (error) {
      if (error instanceof PublicationReviewError)
        throw new TaskRecordError(error.message);
      throw error;
    }
    requireValue(
      checked.source === task.value.source &&
        checked.datasets.every((dataset) =>
          task.value.datasets.includes(dataset),
        ),
      "publication_task_scope_mismatch",
      403,
    );
    return checked;
  }
  async function publicationVersions(review, requireMatch = true) {
    // Use the same authenticated public API as Run reads, grouped by entity.
    // Never infer target versions from the Run revision or caller's digest.
    const groups = new Map();
    for (const change of review.changes) {
      const entity = change.urn.split(":", 3)[2].toLowerCase();
      if (!groups.has(entity)) groups.set(entity, new Map());
      const group = groups.get(entity);
      if (!group.has(change.urn)) group.set(change.urn, { urn: change.urn });
      group.get(change.urn)[change.aspect] = {};
    }
    const observed = new Map();
    for (const [entity, requests] of groups) {
      const rows = await call(
        `/openapi/v3/entity/${entity}/batchGet?systemMetadata=true`,
        [...requests.values()],
      );
      requireValue(
        Array.isArray(rows),
        "invalid_publication_target_response",
        502,
      );
      for (const row of rows) {
        const request = requests.get(row?.urn);
        requireValue(
          request &&
            !observed.has(row.urn) &&
            Object.keys(row).every((key) => Object.hasOwn(request, key)),
          "invalid_publication_target_response",
          502,
        );
        observed.set(row.urn, row);
      }
    }
    for (const change of review.changes) {
      const envelope = observed.get(change.urn)?.[change.aspect];
      let version = "-1";
      if (envelope !== undefined) {
        requireValue(
          envelope?.value &&
            typeof envelope.value === "object" &&
            !Array.isArray(envelope.value) &&
            typeof envelope.systemMetadata?.version === "string" &&
            versionPattern.test(envelope.systemMetadata.version),
          "invalid_publication_target_response",
          502,
        );
        version = envelope.systemMetadata.version;
      }
      if (requireMatch)
        requireValue(
          version === change.expectedVersion,
          "publication_target_version_conflict",
        );
    }
    // This read is not a cross-Aspect transaction. Actual writes still need
    // their own expected-version CAS and one-attempt admission.
    return observed;
  }
  async function recompile(review) {
    requireValue(
      typeof recompilePublication === "function",
      "publication_compiler_not_configured",
      503,
    );
    let actual;
    try {
      // Native target values are Host-read, never supplied by review JSON.
      // The compiler needs them to retain existing edge evidence in its diff.
      const targets = await publicationVersions(review);
      actual = await recompilePublication(structuredClone(review), targets);
    } catch {
      throw new TaskRecordError("publication_source_not_verified");
    }
    try {
      const checked = validatePublicationReview(actual, now());
      requireValue(
        checked.planDigest === review.planDigest,
        "publication_source_not_verified",
      );
    } catch (error) {
      if (error instanceof PublicationReviewError)
        throw new TaskRecordError(error.message);
      throw error;
    }
  }
  async function publicationGrants(review) {
    const types = {
      dataset: "DATASET",
      dataFlow: "DATA_FLOW",
      dataJob: "DATA_JOB",
      chart: "CHART",
      dashboard: "DASHBOARD",
      container: "CONTAINER",
      dataPlatform: "DATA_PLATFORM",
      tag: "TAG",
      glossaryTerm: "GLOSSARY_TERM",
      domain: "DOMAIN", glossaryNode: "GLOSSARY_NODE",
      structuredProperty: "STRUCTURED_PROPERTY", schemaField: "SCHEMA_FIELD",
    };
    const targets = new Set(review.changes.map((change) => change.urn));
    for (const id of new Set([...review.datasets, ...targets])) {
      const result = await call("/api/v2/graphql", {
        query:
          "query($input:GetGrantedPrivilegesInput!){getGrantedPrivileges(input:$input){privileges}}",
        variables: {
          input: {
            actorUrn: actor.urn,
            resourceSpec: {
              resourceType: types[id.split(":")[2]],
              resourceUrn: id,
            },
          },
        },
      });
      const privileges = result.data?.getGrantedPrivileges?.privileges;
      requireValue(
        Array.isArray(privileges) &&
          privileges.some((p) =>
            ["GET_ENTITY", "VIEW_ENTITY_PAGE", "EDIT_ENTITY"].includes(p),
          ) &&
          (!targets.has(id) ||
            privileges.some((p) =>
              ["CREATE_ENTITY", "EDIT_ENTITY"].includes(p),
            )),
        "publication_privilege_denied",
        403,
      );
    }
  }
  function historicalConsent(decision) {
    const attempt = decision?.publicationAttempt;
    requireValue(
      attempt &&
        text(attempt.attemptId, 128) &&
        Number.isSafeInteger(attempt.claimedAt) &&
        attempt.claimedAt >= 0 &&
        attempt.claimedAt <= now(),
      "publication_attempt_missing",
    );
    try {
      assertPublicationConsent(
        decision,
        decision.publicationReview,
        actor.urn,
        attempt.claimedAt,
      );
    } catch (error) {
      if (error instanceof PublicationReviewError)
        throw new TaskRecordError(error.message);
      throw error;
    }
    return decision.publicationReview;
  }
  async function ownedPublicationTargets(review, rows) {
    const owners = new Map();
    for (const change of review.changes) {
      const current = rows.get(change.urn)?.[change.aspect];
      if (review.semanticContextJson !== undefined) {
        requireValue(typeof recompilePublication === "function" && typeof verifyPublicationReadback === "function", "semantic_compiler_required");
        requireValue(validateStewardChange(review, change, current?.value, actor.urn), "semantic_human_value_conflict");
        continue; // Addition/fill-only, never ownership/adoption of the whole Aspect.
      }
      if (!current) continue; // Absence is checked again by native per-Aspect CAS.
      requireValue(
        canonicalPublicationJson(current.value) !== change.valueJson,
        "publication_noop_requires_recompile",
      );
      const metadata = current.systemMetadata,
        properties = metadata.properties;
      const provenance = nativePublicationProvenance(metadata);
      const priorRun = provenance?.runUrn;
      const priorDecision = provenance?.decisionId;
      const grant = Array.isArray(adoption?.targets)
        ? adoption.targets.find(
            (item) => item.urn === change.urn && item.aspect === change.aspect,
          )
        : undefined;
      if (
        review.purpose === "LINEAGE" &&
        change.aspect === "dataJobInputOutput" &&
        adoption?.actor === actor.urn &&
        adoption?.planDigest === review.planDigest &&
        grant &&
        properties?.dataflowDiscoveryRunUrn === undefined &&
        properties?.dataflowDiscoveryDecisionId === undefined &&
        metadata.runId === undefined &&
        metadata.aspectCreated?.actor === actor.urn &&
        Number.isSafeInteger(metadata.aspectCreated?.time) &&
        metadata.aspectCreated.time >= 0 &&
        isDeepStrictEqual(grant.aspectCreated, metadata.aspectCreated) &&
        grant.beforeValueSha256 ===
          createHash("sha256")
            .update(canonicalPublicationJson(current.value))
            .digest("hex")
      )
        continue;
      requireValue(provenance !== undefined, "publication_target_not_owned");
      if (!owners.has(priorRun)) owners.set(priorRun, await getRun(priorRun));
      const owner = owners.get(priorRun);
      requireValue(
        owner.value.actor === actor.urn && owner.value.source === review.source,
        "publication_target_not_owned",
        403,
      );
      requireValue(
        Array.isArray(owner.value.decisions),
        "invalid_task_run",
        409,
      );
      const decision = owner.value.decisions.find(
        (d) => d.id === priorDecision,
      );
      const previous = historicalConsent(decision);
      // A Steward locator proves only the selected additions, never ownership
      // of all preserved human members for a later legacy publisher.
      requireValue(previous.semanticContextJson === undefined, "publication_target_not_owned");
      requireValue(
        previous.source === review.source &&
          previous.sourceId === review.sourceId &&
          previous.purpose === review.purpose &&
          decision.publicationAttempt.attemptId === provenance.attemptId,
        "publication_target_not_owned",
      );
      const before = previous.changes.find(
        (c) => c.urn === change.urn && c.aspect === change.aspect,
      );
      requireValue(
        before && before.valueJson === canonicalPublicationJson(current.value),
        "publication_manual_metadata_conflict",
      );
      requireValue(
        before.expectedVersion === "-1" ||
          BigInt(current.systemMetadata.version) >
            BigInt(before.expectedVersion),
        "publication_target_not_owned",
      );
    }
  }
  function publicationReadback(review, rows, id, decisionId, attemptId) {
    return review.changes.map((change) => {
      const item = rows.get(change.urn)?.[change.aspect];
      if (!item)
        return { urn: change.urn, aspect: change.aspect, state: "ABSENT" };
      const json = canonicalPublicationJson(item.value);
      const provenance = nativePublicationProvenance(item.systemMetadata);
      const matches =
        json === change.valueJson &&
        provenance?.runUrn === id &&
        provenance.decisionId === decisionId &&
        provenance.attemptId === attemptId;
      return {
        urn: change.urn,
        aspect: change.aspect,
        state: matches ? "MATCHED" : "DIFFERENT",
        version: item.systemMetadata.version,
        valueDigest: createHash("sha256").update(json).digest("hex"),
      };
    });
  }
  function availableConsent(decision, review) {
    requireValue(
      decision.executionReview === undefined &&
        decision.executionAttempt === undefined,
      "mixed_decision_purpose",
    );
    requireValue(
      decision.publicationAttempt === undefined,
      "publication_already_attempted",
      409,
    );
    try {
      return assertPublicationConsent(decision, review, actor.urn, now());
    } catch (error) {
      if (error instanceof PublicationReviewError)
        throw new TaskRecordError(error.message);
      throw error;
    }
  }
  async function publicationConsentContext(
    id,
    expectedVersion,
    nativeSessionId,
    decisionId,
    expectedReview,
  ) {
    const { run, task } = await activeRun(id, expectedVersion, nativeSessionId);
    requireValue(task.value.allowDecisions === true, "task_decisions_disabled");
    const review = publication(expectedReview, task);
    const decision = run.value.decisions.find(
      (entry) => entry.id === decisionId,
    );
    requireValue(decision, "task_decision_not_found", 404);
    availableConsent(decision, review);
    await publicationVersions(review);
    const consent = availableConsent(decision, review);
    return { run, decision, review, consent };
  }
  async function appendDecision(
    id,
    expectedVersion,
    nativeSessionId,
    input,
    proposal,
  ) {
    keys(input, ["id", "question", "choices"]);
    requireValue(
      text(input.id, 128) &&
        text(input.question, 2048) &&
        Array.isArray(input.choices) &&
        input.choices.length <= 8 &&
        input.choices.every((choice) => text(choice, 256)),
    );
    const { run, task } = await activeRun(id, expectedVersion, nativeSessionId);
    requireValue(task.value.allowDecisions === true, "task_decisions_disabled");
    const existing = run.value.decisions.find(
      (decision) => decision.id === input.id,
    );
    // A native question gets its ID at tool execution, before Host preparation.
    // Only the private compiler seam may attach a first review to that SAME
    // unanswered question. Never reinterpret a human response as typed consent.
    requireValue(
      !existing ||
        (proposal !== undefined &&
          existing.response === undefined &&
          existing.publicationReview === undefined &&
          existing.publicationAttempt === undefined &&
          existing.executionReview === undefined &&
          existing.executionAttempt === undefined &&
          isDeepStrictEqual(
            { question: existing.question, choices: existing.choices },
            { question: input.question, choices: input.choices },
          )),
      "task_decision_exists",
    );
    requireValue(
      run.value.decisions.every(
        (decision) => decision === existing || decision.response !== undefined,
      ),
      "task_decision_pending",
    );
    const review =
      proposal === undefined ? undefined : publication(proposal, task);
    if (review) await publicationVersions(review);
    const decision = {
      ...(existing ?? { ...input, requestedAt: now() }),
      ...(review ? { publicationReview: review } : {}),
    };
    return write(
      "run",
      id,
      {
        ...run.value,
        decisions: existing
          ? run.value.decisions.map((item) =>
              item === existing ? decision : item,
            )
          : [...run.value.decisions, decision],
      },
      expectedVersion,
      review ? () => publication(review, task) : undefined,
    );
  }
  async function claimPublicationConsent(
    id,
    expectedVersion,
    nativeSessionId,
    decisionId,
    expectedReview,
  ) {
    const { run, decision, review, consent } = await publicationConsentContext(
      id,
      expectedVersion,
      nativeSessionId,
      decisionId,
      expectedReview,
    );
    const publicationAttempt = { attemptId: randomUUID(), claimedAt: now() };
    const reconciliation = {
      urn: id,
      expectedVersion,
      decisionId,
      attemptId: publicationAttempt.attemptId,
      planDigest: review.planDigest,
    };
    try {
      const stored = await write(
        "run",
        id,
        {
          ...run.value,
          decisions: run.value.decisions.map((entry) =>
            entry.id === decisionId ? { ...entry, publicationAttempt } : entry,
          ),
        },
        expectedVersion,
        () => {
          availableConsent(decision, review);
          requireValue(
            publicationAttempt.claimedAt >= consent.respondedAt &&
              publicationAttempt.claimedAt <= now(),
            "invalid_publication_attempt_time",
          );
        },
      );
      return {
        runUrn: stored.urn,
        runVersion: stored.version,
        decisionId,
        ...consent,
        ...publicationAttempt,
      };
    } catch (error) {
      if (error instanceof TaskRecordError && error.reconciliation)
        error.reconciliation = reconciliation;
      throw error;
    }
  }
  // Immutable initial observation, separate from a later current-value read.
  // A crash before this write leaves the permanent attempt marker UNKNOWN.
  async function recordPublicationOutcome(id, decisionId, attemptId, outcome) {
    const run = await read("run", id);
    requireValue(run.value.actor === actor.urn, "task_owner_mismatch", 403);
    const decision = run.value.decisions?.find((entry) => entry.id === decisionId);
    requireValue(decision?.publicationAttempt?.attemptId === attemptId, "publication_attempt_mismatch");
    requireValue(decision.publicationAttempt.outcomeJson === undefined, "publication_outcome_already_recorded");
    const outcomeJson = canonicalPublicationJson({ ...outcome, recordedAt: now() });
    requireValue(Buffer.byteLength(outcomeJson) <= 65536, "publication_outcome_too_large");
    return write("run", id, { ...run.value, decisions: run.value.decisions.map((entry) => entry === decision
      ? { ...entry, publicationAttempt: { ...entry.publicationAttempt, outcomeJson } } : entry) }, run.version);
  }
  // Only the owning fixed-process supervisor calls this seam. No result-writing
  // operation is exposed to the model/browser. Preserve closed/revoked history;
  // finishing an admitted attempt does not authorize new work or reopen a Run.
  async function recordExecutionOutcome(
    id,
    expectedVersion,
    nativeSessionId,
    decisionId,
    attemptId,
    outcome,
  ) {
    keys(outcome, ["state", "receipt", "code"]);
    const run = await getRun(id);
    requireValue(run.value.actor === actor.urn, "task_owner_mismatch", 403);
    requireValue(
      run.value.sessionId === nativeSessionId && text(nativeSessionId, 128),
      "task_session_mismatch",
      403,
    );
    requireValue(run.version === expectedVersion, "task_run_revision_conflict");
    const decision = run.value.decisions.find(
      (entry) => entry.id === decisionId,
    );
    const prior = decision?.executionAttempt;
    requireValue(
      prior?.attemptId === attemptId &&
        ["ADMITTED", "COMMIT_AUTHORIZED"].includes(prior.state),
      "fixed_etl_attempt_mismatch",
    );
    let result;
    if (outcome.state === "COMMITTED") {
      requireValue(
        prior.state === "COMMIT_AUTHORIZED" && outcome.code === undefined,
        "fixed_etl_commit_not_authorized",
      );
      try {
        result = validateFixedEtlReceipt(outcome.receipt);
      } catch (error) {
        if (error instanceof FixedEtlReviewError)
          throw new TaskRecordError(error.message);
        throw error;
      }
      requireValue(
        Date.parse(result.source_observation.started_at) >= prior.admittedAt &&
          Date.parse(result.readback_at) <= prior.deadlineAt &&
          Date.parse(result.readback_at) <= now(),
        "fixed_etl_receipt_outside_attempt",
      );
    } else {
      requireValue(
        ["FAILED", "UNKNOWN"].includes(outcome.state) &&
          outcome.receipt === undefined &&
          [
            "etl_failed_before_commit",
            "commit_or_readback_unconfirmed",
            "process_unconfirmed",
            "execution_deadline",
            "cancel_requested",
            "preflight_failed",
          ].includes(outcome.code),
        "invalid_fixed_etl_outcome",
      );
      requireValue(
        outcome.state !== "FAILED" || prior.state === "ADMITTED",
        "fixed_etl_commit_uncertain",
      );
      result = { code: outcome.code };
    }
    const executionAttempt = {
      ...prior,
      state: outcome.state,
      finishedAt: now(),
      resultJson: canonicalPublicationJson(result),
    };
    return write(
      "run",
      id,
      {
        ...run.value,
        decisions: run.value.decisions.map((entry) =>
          entry === decision ? { ...entry, executionAttempt } : entry,
        ),
      },
      expectedVersion,
    );
  }
  // Private fixed-ETL seams: reuse record identity/CAS, never metadata consent.
  function execution(review, task) {
    let checked;
    try {
      checked = validateFixedEtlReview(review, now());
    } catch (error) {
      if (error instanceof FixedEtlReviewError)
        throw new TaskRecordError(error.message);
      throw error;
    }
    requireValue(
      checked.source === task.value.source &&
        isDeepStrictEqual(
          [...checked.datasets].sort(),
          [...task.value.datasets].sort(),
        ),
      "execution_task_scope_mismatch",
      403,
    );
    return checked;
  }
  async function checkExecution(review, task, run) {
    requireValue(
      typeof authorizeFixedEtl === "function" &&
        typeof recompileFixedEtl === "function",
      "fixed_etl_not_configured",
      503,
    );
    const checked = execution(review, task);
    await identity();
    // Catalog/Task ownership is not a source SELECT or target DML grant.
    requireValue(
      (await authorizeFixedEtl(
        structuredClone({ actor, task, run, review: checked }),
      )) === true,
      "fixed_etl_forbidden",
      403,
    );
    const fresh = await recompileFixedEtl(structuredClone(checked));
    requireValue(
      isDeepStrictEqual(execution(fresh, task), checked),
      "fixed_etl_source_changed",
    );
    assertActive();
    return execution(checked, task);
  }
  function executionConsent(decision, review) {
    try {
      return assertFixedEtlConsent(decision, review, actor.urn, now());
    } catch (error) {
      if (error instanceof FixedEtlReviewError)
        throw new TaskRecordError(error.message);
      throw error;
    }
  }
  async function appendExecutionReview(
    id,
    expectedVersion,
    nativeSessionId,
    input,
    proposal,
  ) {
    keys(input, ["id", "question", "choices"]);
    const { run, task } = await activeRun(id, expectedVersion, nativeSessionId);
    requireValue(task.value.allowDecisions === true, "task_decisions_disabled");
    const existing = run.value.decisions.find((entry) => entry.id === input.id);
    requireValue(
      existing &&
        !existing.response &&
        !existing.publicationReview &&
        !existing.publicationAttempt &&
        !existing.executionReview &&
        !existing.executionAttempt &&
        isDeepStrictEqual(
          { question: existing.question, choices: existing.choices },
          { question: input.question, choices: input.choices },
        ),
      "task_decision_not_attachable",
    );
    requireValue(
      run.value.decisions.every(
        (entry) => entry === existing || entry.response !== undefined,
      ),
      "task_decision_pending",
    );
    const review = await checkExecution(proposal, task, run);
    return write(
      "run",
      id,
      {
        ...run.value,
        decisions: run.value.decisions.map((entry) =>
          entry === existing ? { ...entry, executionReview: review } : entry,
        ),
      },
      expectedVersion,
      () => execution(review, task),
    );
  }
  async function respondExecutionReview(
    id,
    expectedVersion,
    nativeSessionId,
    decisionId,
    input,
  ) {
    keys(input, ["verdict", "planDigest"]);
    requireValue(["APPROVE", "REJECT"].includes(input.verdict));
    const { run, task } = await activeRun(id, expectedVersion, nativeSessionId);
    requireValue(task.value.allowDecisions === true, "task_decisions_disabled");
    const decision = run.value.decisions.find(
      (entry) => entry.id === decisionId,
    );
    requireValue(decision, "task_decision_not_found", 404);
    requireValue(!decision.response, "task_decision_already_answered");
    requireValue(
      !decision.publicationReview && !decision.publicationAttempt,
      "mixed_decision_purpose",
    );
    const review = await checkExecution(decision.executionReview, task, run);
    requireValue(
      input.planDigest === review.planDigest,
      "fixed_etl_review_digest_mismatch",
    );
    const response = {
      action: "RESPOND",
      actor: actor.urn,
      respondedAt: now(),
      text: `FIXED_ETL review ${input.verdict} recorded; no SQL has been executed.`,
      executionVerdict: {
        purpose: "FIXED_ETL",
        planDigest: review.planDigest,
        verdict: input.verdict,
      },
    };
    return write(
      "run",
      id,
      {
        ...run.value,
        decisions: run.value.decisions.map((entry) =>
          entry === decision ? { ...entry, response } : entry,
        ),
      },
      expectedVersion,
      () => execution(review, task),
    );
  }
  async function claimExecutionConsent(
    id,
    expectedVersion,
    nativeSessionId,
    decisionId,
    expectedReview,
  ) {
    const { run, task } = await activeRun(id, expectedVersion, nativeSessionId);
    requireValue(task.value.allowDecisions === true, "task_decisions_disabled");
    requireValue(
      run.value.decisions.every(
        (entry) => entry.executionAttempt === undefined,
      ),
      "fixed_etl_already_attempted",
    );
    const decision = run.value.decisions.find(
      (entry) => entry.id === decisionId,
    );
    requireValue(decision, "task_decision_not_found", 404);
    const review = await checkExecution(expectedReview, task, run);
    executionConsent(decision, review);
    const admittedAt = now(),
      deadlineAt = admittedAt + 300000;
    requireValue(deadlineAt <= review.expiresAt, "fixed_etl_window_too_short");
    const executionAttempt = {
      attemptId: randomUUID(),
      planDigest: review.planDigest,
      admittedAt,
      deadlineAt,
      state: "ADMITTED",
    };
    const reconciliation = {
      urn: id,
      expectedVersion,
      decisionId,
      ...executionAttempt,
      retryAllowed: false,
    };
    try {
      const stored = await write(
        "run",
        id,
        {
          ...run.value,
          decisions: run.value.decisions.map((entry) =>
            entry === decision ? { ...entry, executionAttempt } : entry,
          ),
        },
        expectedVersion,
        () => {
          executionConsent(decision, review);
          requireValue(now() < deadlineAt, "fixed_etl_deadline");
        },
      );
      return {
        runUrn: id,
        runVersion: stored.version,
        decisionId,
        ...executionAttempt,
      };
    } catch (error) {
      if (error instanceof TaskRecordError && error.reconciliation)
        error.reconciliation = reconciliation;
      throw error;
    }
  }
  async function authorizeExecutionCommit(
    id,
    expectedVersion,
    nativeSessionId,
    decisionId,
    attemptId,
    expectedReview,
  ) {
    const { run, task } = await activeRun(id, expectedVersion, nativeSessionId);
    requireValue(task.value.allowDecisions === true, "task_decisions_disabled");
    const decision = run.value.decisions.find(
      (entry) => entry.id === decisionId,
    );
    requireValue(decision, "task_decision_not_found", 404);
    const review = await checkExecution(expectedReview, task, run);
    executionConsent(decision, review);
    const prior = decision.executionAttempt;
    requireValue(
      prior?.attemptId === attemptId &&
        prior.planDigest === review.planDigest &&
        prior.state === "ADMITTED" &&
        Number.isSafeInteger(prior.admittedAt) &&
        Number.isSafeInteger(prior.deadlineAt) &&
        prior.admittedAt >= decision.response.respondedAt &&
        prior.admittedAt <= now() &&
        prior.deadlineAt === prior.admittedAt + 300000 &&
        prior.deadlineAt <= review.expiresAt,
      "fixed_etl_attempt_mismatch",
    );
    const executionAttempt = {
      ...prior,
      state: "COMMIT_AUTHORIZED",
      commitAuthorizedAt: now(),
    };
    const stored = await write(
      "run",
      id,
      {
        ...run.value,
        decisions: run.value.decisions.map((entry) =>
          entry === decision ? { ...entry, executionAttempt } : entry,
        ),
      },
      expectedVersion,
      () => {
        executionConsent(decision, review);
        requireValue(now() < prior.deadlineAt, "fixed_etl_deadline");
      },
    );
    return {
      runUrn: id,
      runVersion: stored.version,
      decisionId,
      ...executionAttempt,
    };
  }
  return {
    getTask,
    getRun,
    // Registry metadata is association, not runtime authority. Choose only an
    // unambiguous visible native record; never invent an Agent URN.
    async resolveTaskAgent() {
      await identity();
      const result = await call(
        "/openapi/v3/entity/scroll?count=2&systemMetadata=true",
        {
          entities: ["aiAgent"],
          aspects: ["aiAgentInfo"],
        },
      );
      requireValue(
        result.totalCount === 1 && result.entities?.length === 1,
        "task_agent_selection_required",
      );
      const entity = result.entities[0];
      requireValue(
        text(entity.urn, 512) &&
          entity.urn.startsWith("urn:li:aiAgent:") &&
          text(entity.aiAgentInfo?.value?.name, 512) &&
          versionPattern.test(entity.aiAgentInfo?.systemMetadata?.version),
        "invalid_task_agent",
      );
      return entity.urn;
    },
    appendExecutionReview,
    respondExecutionReview,
    claimExecutionConsent,
    authorizeExecutionCommit,
    recordExecutionOutcome,
    authorizeRun: activeRun,
    async createTask(id, input) {
      keys(input, [
        "agent",
        "source",
        "datasets",
        "instructions",
        "allowDecisions",
      ]);
      requireValue(
        text(input.agent, 512) &&
          input.agent.startsWith("urn:li:aiAgent:") &&
          text(input.instructions, 2048) &&
          Array.isArray(input.datasets) &&
          input.datasets.length <= 16 &&
          new Set(input.datasets).size === input.datasets.length &&
          (input.allowDecisions === undefined ||
            typeof input.allowDecisions === "boolean"),
      );
      const value = {
        ...input,
        actor: actor.urn,
        allowDecisions: input.allowDecisions ?? true,
      };
      scope(value);
      return write("task", id, value, "-1");
    },
    async bindRun(id, taskId, taskVersion, nativeSessionId) {
      requireValue(
        text(nativeSessionId, 128) && versionPattern.test(taskVersion),
      );
      const task = await getTask(taskId);
      scope(task.value);
      requireValue(task.version === taskVersion, "task_revision_conflict");
      return write(
        "run",
        id,
        {
          actor: actor.urn,
          source: task.value.source,
          task: taskId,
          taskVersion,
          sessionId: nativeSessionId,
          decisions: [],
        },
        "-1",
      );
    },
    async appendDecision(id, expectedVersion, nativeSessionId, input) {
      return appendDecision(id, expectedVersion, nativeSessionId, input);
    },
    /** Internal Host compiler seam only. There is deliberately no JSON route
     * accepting a proposal from an agent/browser. Source validation and actual
     * mutation compilation must precede this call; schema validity isn't proof.
     */
    async appendPublicationReview(
      id,
      expectedVersion,
      nativeSessionId,
      input,
      proposal,
    ) {
      requireValue(proposal !== undefined, "publication_proposal_required");
      return appendDecision(
        id,
        expectedVersion,
        nativeSessionId,
        input,
        proposal,
      );
    },
    /** Host-only narrowing: one Run CAS rejects the prior pending plan and
     * appends its selected replacement. No consent is carried forward. */
    async selectPublicationReview(id, expectedVersion, nativeSessionId, decisionId, expectedDigest, proposal, nextId) {
      const { run, task } = await activeRun(id, expectedVersion, nativeSessionId);
      requireValue(task.value.allowDecisions === true, "task_decisions_disabled");
      const previous = run.value.decisions.find((entry) => entry.id === decisionId);
      requireValue(previous && !previous.response && !previous.publicationAttempt, "task_decision_already_answered");
      const old = publication(previous.publicationReview, task), review = publication(proposal, task);
      requireValue(old.semanticContextJson && review.semanticContextJson && old.planDigest === expectedDigest &&
        review.candidateIds.every((key) => old.candidateIds.includes(key)), "semantic_selection_mismatch");
      requireValue(text(nextId, 128) && !run.value.decisions.some((entry) => entry.id === nextId), "task_decision_exists");
      await publicationVersions(review);
      const at = now();
      const replacement = { id: nextId, question: previous.question, choices: [], requestedAt: at, publicationReview: review };
      return write("run", id, { ...run.value, decisions: [...run.value.decisions.map((entry) => entry === previous
        ? { ...entry, response: { action: "RESPOND", actor: actor.urn, respondedAt: at, text: `Selection superseded by ${nextId}; no consent carried forward.`,
          publicationVerdict: { purpose: old.purpose, planDigest: old.planDigest, verdict: "REJECT" } } } : entry), replacement] },
        expectedVersion, () => publication(review, task));
    },
    async respondPublicationReview(
      id,
      expectedVersion,
      nativeSessionId,
      decisionId,
      input,
    ) {
      keys(input, ["verdict", "planDigest"]);
      requireValue(["APPROVE", "REJECT"].includes(input.verdict));
      const { run, task } = await activeRun(
        id,
        expectedVersion,
        nativeSessionId,
      );
      requireValue(
        task.value.allowDecisions === true,
        "task_decisions_disabled",
      );
      const decision = run.value.decisions.find(
        (entry) => entry.id === decisionId,
      );
      requireValue(decision, "task_decision_not_found", 404);
      requireValue(
        decision.response === undefined,
        "task_decision_already_answered",
      );
      requireValue(
        !decision.executionReview && !decision.executionAttempt,
        "mixed_decision_purpose",
      );
      const review = publication(decision.publicationReview, task);
      requireValue(
        input.planDigest === review.planDigest,
        "publication_review_digest_mismatch",
      );
      if (input.verdict === "APPROVE") {
        await publicationVersions(review);
        if (review.semanticContextJson !== undefined) {
          await recompile(review);
          await publicationGrants(review);
          await ownedPublicationTargets(review, await publicationVersions(review));
        }
      }
      const response = {
        action: "RESPOND",
        actor: actor.urn,
        respondedAt: now(),
        text: `${review.purpose} review ${input.verdict} recorded; no metadata was published.`,
        publicationVerdict: {
          purpose: review.purpose,
          planDigest: review.planDigest,
          verdict: input.verdict,
        },
      };
      return write(
        "run",
        id,
        {
          ...run.value,
          decisions: run.value.decisions.map((entry) =>
            entry.id === decisionId ? { ...entry, response } : entry,
          ),
        },
        expectedVersion,
        () => publication(review, task),
      );
    },
    /** Read current authoritative records, never accept a serialized approval
     * claim. This does not consume consent or enable the draft publisher.
     */
    async requirePublicationConsent(
      id,
      expectedVersion,
      nativeSessionId,
      decisionId,
      expectedReview,
    ) {
      const { run, consent } = await publicationConsentContext(
        id,
        expectedVersion,
        nativeSessionId,
        decisionId,
        expectedReview,
      );
      return {
        runUrn: run.urn,
        runVersion: run.version,
        decisionId,
        ...consent,
      };
    },
    /** Internal Host admission only; no JSON route and no target writes.
     * Exactly one Run CAS can consume this Decision. A lost ACK is UNKNOWN:
     * inspect the returned reconciliation reference, never retry automatically.
     * The marker is not a lease, portable capability or execution receipt.
     */
    claimPublicationConsent,
    /** Host-only conditional publisher. A genuine source/MCP compiler must be
     * configured by Host code; no function, MCP or endpoint comes from JSON.
     * Existing Aspects need native provenance + a prior approved Run value.
     * No automatic adoption, merge, retry or rollback of manual metadata.
     */
    async publishPublication(
      id,
      expectedVersion,
      nativeSessionId,
      decisionId,
      expectedReview,
    ) {
      requireValue(
        typeof recompilePublication === "function",
        "publication_compiler_not_configured",
        503,
      );
      const { review } = await publicationConsentContext(
        id,
        expectedVersion,
        nativeSessionId,
        decisionId,
        expectedReview,
      );
      await recompile(review);
      await publicationGrants(review);
      await ownedPublicationTargets(review, await publicationVersions(review));
      const admitted = await claimPublicationConsent(
        id,
        expectedVersion,
        nativeSessionId,
        decisionId,
        review,
      );
      let targetRequestInvoked = false,
        observations;
      try {
        await recompile(review);
        await publicationGrants(review);
        const targets = await publicationVersions(review);
        await ownedPublicationTargets(review, targets);
        const { run, task } = await activeRun(
          id,
          admitted.runVersion,
          nativeSessionId,
        );
        const decision = run.value.decisions.find((d) => d.id === decisionId);
        requireValue(
          decision?.publicationAttempt?.attemptId === admitted.attemptId,
          "publication_attempt_mismatch",
        );
        publication(review, task);
        assertPublicationConsent(decision, review, actor.urn, now());
        const body = {};
        for (const change of review.changes) {
          const entity = change.urn.split(":")[2];
          const items = (body[entity] ??= []);
          let item = items.find((entry) => entry.urn === change.urn);
          if (!item) {
            item = { urn: change.urn };
            items.push(item);
          }
          item[change.aspect] = {
            value: JSON.parse(change.valueJson),
            headers: { "If-Version-Match": change.expectedVersion },
            systemMetadata: {
              runId: nativePublicationRunId(id, decisionId, admitted.attemptId),
              lastObserved: now(),
              properties: {
                ...targets.get(change.urn)?.[change.aspect]?.systemMetadata
                  .properties,
              },
            },
          };
        }
        requireValue(
          Buffer.byteLength(JSON.stringify(body), "utf8") <= 524288,
          "publication_batch_too_large",
        );
        // Nothing is awaited between the final expiry check and target dispatch.
        publication(review, task);
        targetRequestInvoked = true;
        const ack = await call(
          "/openapi/v3/entity/generic?async=false&systemMetadata=true",
          body,
          admitted,
        );
        const versions = review.changes.map((change) => {
          const items = ack?.[change.urn.split(":")[2]];
          requireValue(Array.isArray(items), "invalid_publication_ack");
          const matches = items.filter((item) => item?.urn === change.urn);
          requireValue(matches.length === 1, "invalid_publication_ack");
          const item = matches[0][change.aspect];
          requireValue(
            typeof item?.systemMetadata?.version === "string" &&
              versionPattern.test(item.systemMetadata.version) &&
              (change.expectedVersion === "-1" ||
                BigInt(item.systemMetadata.version) >
                  BigInt(change.expectedVersion)),
            "invalid_publication_ack",
          );
          return item.systemMetadata.version;
        });
        observations = publicationReadback(
          review,
          await publicationVersions(review, false),
          id,
          decisionId,
          admitted.attemptId,
        );
        requireValue(
          observations.every(
            (item, index) =>
              item.state === "MATCHED" && item.version === versions[index],
          ),
          "publication_readback_mismatch",
        );
        let contextVerification;
        if (review.semanticContextJson !== undefined) {
          contextVerification = await verifyPublicationReadback(review);
          await recordPublicationOutcome(id, decisionId, admitted.attemptId, {
            status: "VERIFIED_CURRENT_VALUES", observations, contextVerification,
          });
        }
        return { status: "VERIFIED_CURRENT_VALUES", ...admitted, observations, ...(contextVerification ? { contextVerification } : {}) };
      } catch (error) {
        // Even a batch 412 or failed readback may follow partial native writes.
        const reason =
          error instanceof TaskRecordError &&
          /^(?:publication|task|datahub|semantic)_[a-z_]{1,100}$/.test(error.message)
            ? error.message
            : "publication_validation_failed";
        let outcomeRecordingConfirmed = false;
        if (review.semanticContextJson !== undefined) {
          try {
            await recordPublicationOutcome(id, decisionId, admitted.attemptId, {
              status: targetRequestInvoked ? "UNKNOWN_OR_CONTEXT_CHANGED" : "NOT_DISPATCHED",
              reason, ...(observations ? { observations } : {}),
            });
            outcomeRecordingConfirmed = true;
          } catch { /* Keep original error and consumed admission; read-only reconciliation only. */ }
        }
        throw new TaskRecordError(
          targetRequestInvoked
            ? "publication_write_unconfirmed"
            : "publication_not_dispatched",
          502,
          {
            urn: id,
            decisionId,
            attemptId: admitted.attemptId,
            planDigest: review.planDigest,
            targetRequestInvoked,
            reason,
            ...(review.semanticContextJson !== undefined ? { outcomeRecordingConfirmed } : {}),
            ...(observations ? { observations } : {}),
          },
        );
      }
    },
    /** Read-only reconciliation. Never restores admission, even if nothing is
     * currently visible. An absent Aspect is not proof that a request was unsent.
     */
    async reconcilePublication(id, decisionId) {
      const run = await getRun(id);
      requireValue(run.value.actor === actor.urn, "task_owner_mismatch", 403);
      const task = await read("task", run.value.task);
      scope(task.value);
      requireValue(Array.isArray(run.value.decisions), "invalid_task_run", 409);
      const decision = run.value.decisions.find(
        (entry) => entry.id === decisionId,
      );
      const review = historicalConsent(decision);
      requireValue(
        review.source === run.value.source &&
          review.source === task.value.source &&
          review.datasets.every((dataset) =>
            task.value.datasets.includes(dataset),
          ),
        "publication_task_scope_mismatch",
        403,
      );
      const rows = await publicationVersions(review, false);
      const observations = publicationReadback(
        review,
        rows,
        id,
        decisionId,
        decision.publicationAttempt.attemptId,
      );
      // Read-only recovery for the already-observed UUID-only legacy attempt.
      // This uses the explicitly selected, authoritative approved Decision;
      // it does not synthesize a locator or authorize a later target write.
      for (const [index, observation] of observations.entries()) {
        if (observation.state !== "DIFFERENT") continue;
        const change = review.changes[index];
        const item = rows.get(change.urn)?.[change.aspect];
        const metadata = item.systemMetadata;
        const modified = metadata.aspectModified;
        const expectedVersion =
          change.expectedVersion === "-1"
            ? 1n
            : BigInt(change.expectedVersion) + 1n;
        if (
          canonicalPublicationJson(item.value) === change.valueJson &&
          metadata.runId === decision.publicationAttempt.attemptId &&
          metadata.properties?.dataflowDiscoveryRunUrn === undefined &&
          metadata.properties?.dataflowDiscoveryDecisionId === undefined &&
          modified?.actor === run.value.actor &&
          Number.isSafeInteger(modified.time) &&
          modified.time >= decision.publicationAttempt.claimedAt &&
          modified.time <= now() &&
          BigInt(metadata.version) === expectedVersion
        )
          observation.state = "MATCHED_KNOWN_LEGACY_ATTEMPT";
      }
      const fullyLocated = observations.every(
        (item) => item.state === "MATCHED",
      );
      const knownLegacy = observations.every((item) =>
        ["MATCHED", "MATCHED_KNOWN_LEGACY_ATTEMPT"].includes(item.state),
      );
      let status = "INCOMPLETE_OR_CHANGED";
      if (fullyLocated) status = "MATCHED_CLAIMED_ATTEMPT";
      else if (knownLegacy) status = "MATCHED_KNOWN_LEGACY_ATTEMPT";
      return {
        runUrn: id,
        decisionId,
        attemptId: decision.publicationAttempt.attemptId,
        status,
        observations,
        ...(knownLegacy && !fullyLocated
          ? { legacyTargetsRequireOwnershipReview: true }
          : {}),
        retryAllowed: false,
      };
    },
    async respondDecision(
      id,
      expectedVersion,
      nativeSessionId,
      decisionId,
      input,
    ) {
      keys(input, ["action", "text"]);
      requireValue(
        input.action === "RESPOND"
          ? text(input.text, 2048)
          : input.action === "DISMISS" && input.text === undefined,
      );
      const { run, task } = await activeRun(
        id,
        expectedVersion,
        nativeSessionId,
      );
      requireValue(
        task.value.allowDecisions === true,
        "task_decisions_disabled",
      );
      const index = run.value.decisions.findIndex(
        (decision) => decision.id === decisionId,
      );
      requireValue(index >= 0, "task_decision_not_found", 404);
      requireValue(
        run.value.decisions[index].response === undefined,
        "task_decision_already_answered",
      );
      requireValue(
        input.action === "DISMISS" ||
          run.value.decisions[index].publicationReview === undefined,
        "typed_publication_response_required",
      );
      requireValue(
        input.action === "DISMISS" ||
          run.value.decisions[index].executionReview === undefined,
        "typed_execution_response_required",
      );
      const at = now();
      const decisions = run.value.decisions.map((decision, i) =>
        i === index
          ? {
              ...decision,
              response: { ...input, actor: actor.urn, respondedAt: at },
            }
          : decision,
      );
      return write(
        "run",
        id,
        {
          ...run.value,
          decisions,
          ...(input.action === "DISMISS" ? { closedAt: at } : {}),
        },
        expectedVersion,
      );
    },
    async closeRun(id, expectedVersion, nativeSessionId) {
      // Revoked source/task scope must not prevent the owner from stopping a run.
      requireValue(versionPattern.test(expectedVersion));
      const run = await getRun(id);
      requireValue(run.value.actor === actor.urn, "task_owner_mismatch", 403);
      requireValue(
        run.value.sessionId === nativeSessionId && text(nativeSessionId, 128),
        "task_session_mismatch",
        403,
      );
      requireValue(
        run.version === expectedVersion,
        "task_run_revision_conflict",
      );
      if (run.value.closedAt !== undefined) return run;
      return write(
        "run",
        id,
        { ...run.value, closedAt: now() },
        expectedVersion,
      );
    },
  };
}

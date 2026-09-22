import { isDeepStrictEqual } from "node:util";
import { taskRecords, TaskRecordError } from "./task-records.mjs";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fields = {
  list_scopes: [],
  prepare_workspace_import: [
    "requestId",
    "uiRequestId",
    "sessionId",
    "analysis",
  ],
  respond_workspace_import: [
    "runUrn",
    "requestId",
    "uiRequestId",
    "version",
    "verdict",
    "planDigest",
    "actionValue",
  ],
  read_workspace_import: ["runUrn", "requestId"],
  create_task: [
    "requestId",
    "agent",
    "source",
    "datasets",
    "instructions",
    "allowDecisions",
  ],
  get_task: ["taskUrn", "version"],
  start_task: ["requestId", "taskUrn", "taskVersion"],
  get_run: ["runUrn", "version"],
  prepare_decision: [
    "runUrn",
    "requestId",
    "uiRequestId",
    "question",
    "choices",
  ],
  respond_decision: [
    "runUrn",
    "requestId",
    "uiRequestId",
    "version",
    "actionValue",
    "text",
  ],
  respond_publication_review: [
    "runUrn",
    "requestId",
    "uiRequestId",
    "version",
    "verdict",
    "planDigest",
  ],
  respond_execution_review: [
    "runUrn",
    "requestId",
    "uiRequestId",
    "version",
    "verdict",
    "planDigest",
  ],
  cancel_run: ["runUrn", "version"],
};
const reject = (code, status = 409) => {
  throw new TaskRecordError(code, status);
};
// In-flight ordering only, not Task state/storage. The single Host must not let
// stop finish while an earlier start is still preparing its native prompt.
const controls = new Map();

/** Called only by the authenticated DataHub Host, never by a runtime origin.
 * DataHub owns records; Pi owns model turns. Fixed SQL execution stays in the
 * trusted Host and is never dispatched by this question/consent endpoint.
 */
export async function nativeTasks(text, context) {
  let input;
  try {
    input = JSON.parse(text);
  } catch {
    reject("invalid_task_request", 400);
  }
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    typeof input.action !== "string" ||
    !Object.hasOwn(fields, input.action) ||
    Object.keys(input).some(
      (key) => key !== "action" && !fields[input.action].includes(key),
    )
  )
    reject("invalid_task_request", 400);
  const runUrn = ["start_task", "prepare_workspace_import"].includes(
    input.action,
  )
    ? `urn:li:dataProcessInstance:ekop-agent-${context.actor.key}-${input.requestId}`
    : input.action === "respond_workspace_import" ||
        input.action === "cancel_run" ||
        (input.action === "respond_decision" && input.actionValue === "DISMISS")
      ? input.runUrn
      : undefined;
  if (typeof runUrn !== "string") return dispatch(input, context);
  const key = `${context.actor.key}:${runUrn}`;
  const previous = controls.get(key) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  controls.set(key, current);
  await previous;
  try {
    context.assertActive();
    return await dispatch(input, context);
  } finally {
    release();
    if (controls.get(key) === current) controls.delete(key);
  }
}

async function dispatch(input, context) {
  const records = taskRecords(context);
  const runtime = context.runtime;
  const runId = () => {
    if (
      !uuid.test(input.requestId) ||
      !/^[a-f0-9]{48}$/.test(context.actor.key)
    )
      reject("invalid_task_request", 400);
    return `ekop-agent-${context.actor.key}-${input.requestId}`;
  };
  const needRuntime = () => {
    if (!runtime) reject("task_runtime_not_configured", 503);
  };
  async function pending(run, requestId, uiRequestId) {
    needRuntime();
    if (run.value.actor !== context.actor.urn)
      reject("task_owner_mismatch", 403);
    if (run.value.closedAt !== undefined) reject("task_run_closed");
    const result = await runtime.state(run.value.sessionId);
    const state = result.state;
    if (
      result.running !== true ||
      state?.sessionId !== run.value.sessionId ||
      !Array.isArray(state.extensionUiRequests)
    )
      reject("task_native_request_not_pending");
    const ui = state.extensionUiRequests.find(
      (entry) =>
        entry.id === uiRequestId &&
        entry.method === "input" &&
        entry.title === "DataHub task decision",
    );
    let request;
    try {
      request = JSON.parse(ui?.placeholder);
    } catch {
      reject("task_native_request_not_pending");
    }
    if (
      !request ||
      request.runUrn !== run.urn ||
      request.requestId !== requestId ||
      !uuid.test(requestId)
    )
      reject("task_native_request_mismatch");
    return request;
  }
  async function pendingWorkspace(sessionId, requestId, uiRequestId, analysis) {
    needRuntime();
    if (
      !uuid.test(sessionId) ||
      !uuid.test(requestId) ||
      analysis?.requestId !== requestId
    )
      reject("invalid_task_request", 400);
    const result = await runtime.state(sessionId);
    if (!Array.isArray(result.state?.extensionUiRequests))
      reject("task_native_request_not_pending");
    const ui = result.state.extensionUiRequests.find(
      (entry) =>
        entry.id === uiRequestId &&
        entry.method === "input" &&
        entry.title === "DataHub workspace import",
    );
    let request;
    try {
      request = JSON.parse(ui?.placeholder);
    } catch {
      reject("task_native_request_not_pending");
    }
    if (
      result.running !== true ||
      result.state.sessionId !== sessionId ||
      !request ||
      request.action !== "import_workspace" ||
      request.requestId !== requestId ||
      request.sessionId !== sessionId ||
      !isDeepStrictEqual(request.analysis, analysis)
    )
      reject("task_native_request_mismatch");
  }
  async function workspaceIntent(run) {
    if (run.value.actor !== context.actor.urn)
      reject("task_owner_mismatch", 403);
    const task = await records.getTask(run.value.task, run.value.taskVersion);
    let saved;
    try {
      saved = JSON.parse(task.value.instructions);
    } catch {
      reject("workspace_import_binding_missing");
    }
    if (
      saved?.format !== "datahub-etl.import/1" ||
      !saved.analysis ||
      saved.analysis.requestId !== input.requestId
    )
      reject("workspace_import_binding_missing");
    return saved.analysis;
  }
  async function workspaceResult(run) {
    const decision = run.value.decisions.find(
      (item) => item.id === input.requestId,
    );
    if (!decision?.publicationReview)
      reject("workspace_import_preparation_incomplete");
    const publication = decision.publicationAttempt
      ? await records.reconcilePublication(run.urn, input.requestId)
      : undefined;
    return {
      run,
      decision,
      importWorkspace: true,
      ...(publication ? { publication } : {}),
    };
  }
  async function stop(run) {
    needRuntime();
    // Admission is already closed before any native cancellation call. Failure
    // leaves the closure intact; the UI must read state, never report stopped.
    try {
      const result = await runtime.stop(run.value.sessionId);
      return { run, ...result };
    } catch {
      return { run, stopObserved: false, state: "stop_unconfirmed" };
    }
  }
  switch (input.action) {
    case "prepare_workspace_import": {
      if (typeof context.prepareWorkspaceImport !== "function")
        reject("workspace_import_not_configured", 503);
      await pendingWorkspace(
        input.sessionId,
        input.requestId,
        input.uiRequestId,
        input.analysis,
      );
      const id = runId();
      const runUrn = `urn:li:dataProcessInstance:${id}`;
      const taskUrn = `urn:li:dataJob:(urn:li:dataFlow:(pi,ekop-agent-${context.actor.key},DEV),${id})`;
      // An existing key is reconciliation only, including after a lost ACK.
      let existing;
      try {
        existing = await records.getRun(runUrn);
      } catch (error) {
        if (!(error instanceof TaskRecordError) || error.status !== 404)
          throw error;
      }
      if (existing) {
        if (
          existing.value.sessionId !== input.sessionId ||
          !isDeepStrictEqual(await workspaceIntent(existing), input.analysis)
        )
          reject("task_native_request_mismatch");
        return workspaceResult(existing);
      }
      let priorTask;
      try {
        priorTask = await records.getTask(taskUrn);
      } catch (error) {
        if (!(error instanceof TaskRecordError) || error.status !== 404)
          throw error;
      }
      if (priorTask) reject("workspace_import_preparation_incomplete");
      const prepared = await context.prepareWorkspaceImport(input.analysis);
      const agent = await records.resolveTaskAgent();
      const instructions = JSON.stringify({
        format: "datahub-etl.import/1",
        analysis: input.analysis,
      });
      if (instructions.length > 2048)
        reject("workspace_import_intent_too_large", 400);
      await pendingWorkspace(
        input.sessionId,
        input.requestId,
        input.uiRequestId,
        input.analysis,
      );
      const task = await records.createTask(taskUrn, {
        agent,
        source: prepared.review.source,
        datasets: prepared.review.datasets,
        instructions,
        allowDecisions: true,
      });
      const bound = await records.bindRun(
        runUrn,
        task.urn,
        task.version,
        input.sessionId,
      );
      const run = await records.appendPublicationReview(
        runUrn,
        bound.version,
        input.sessionId,
        {
          id: input.requestId,
          question:
            "Import this selected source snapshot's exact lineage metadata changes into DataHub? No ETL or SQL will run.",
          choices: [],
        },
        prepared.review,
      );
      return workspaceResult(run);
    }
    case "read_workspace_import": {
      const run = await records.getRun(input.runUrn);
      await workspaceIntent(run);
      const result = await workspaceResult(run);
      return {
        runUrn: run.urn,
        runVersion: run.version,
        requestId: input.requestId,
        response: result.decision.response,
        publication: result.publication ?? null,
        publicationAuthorized: false,
        retryAllowed: false,
      };
    }
    case "respond_workspace_import": {
      const current = await records.getRun(input.runUrn);
      const analysis = await workspaceIntent(current);
      await pendingWorkspace(
        current.value.sessionId,
        input.requestId,
        input.uiRequestId,
        analysis,
      );
      const decision = current.value.decisions.find(
        (item) => item.id === input.requestId,
      );
      if (!decision?.publicationReview)
        reject("workspace_import_binding_missing");
      if (input.actionValue === "DISMISS") {
        if (input.verdict !== undefined || input.planDigest !== undefined)
          reject("invalid_task_request", 400);
        const run = await records.respondDecision(
          current.urn,
          input.version,
          current.value.sessionId,
          input.requestId,
          { action: "DISMISS" },
        );
        return stop(run);
      }
      if (input.actionValue !== undefined) reject("invalid_task_request", 400);
      if (typeof context.workspaceImportCompiler !== "function")
        reject("workspace_import_not_configured", 503);
      const publisher = taskRecords({
        ...context,
        recompilePublication: context.workspaceImportCompiler(
          analysis,
          current.value.source,
        ),
      });
      // This route is the trusted parent's explicit Approve AND import action.
      // A response/attempt already present cannot dispatch targets a second time.
      const run = await publisher.respondPublicationReview(
        current.urn,
        input.version,
        current.value.sessionId,
        input.requestId,
        { verdict: input.verdict, planDigest: input.planDigest },
      );
      if (input.verdict === "REJECT") return workspaceResult(run);
      const publication = await publisher.publishPublication(
        run.urn,
        run.version,
        run.value.sessionId,
        input.requestId,
        decision.publicationReview,
      );
      const latest = await records.getRun(run.urn);
      return {
        run: latest,
        decision: latest.value.decisions.find(
          (item) => item.id === input.requestId,
        ),
        importWorkspace: true,
        publication,
      };
    }
    case "list_scopes":
      return {
        sources: context.sources
          .filter((source) => source.taskDatasets?.length)
          .map((source) => ({
            urn: source.urn,
            datasets: source.taskDatasets,
          })),
      };
    case "create_task": {
      const id = runId();
      const { action: _action, requestId: _requestId, ...value } = input;
      return {
        task: await records.createTask(
          `urn:li:dataJob:(urn:li:dataFlow:(pi,ekop-agent-${context.actor.key},DEV),${id})`,
          value,
        ),
      };
    }
    case "get_task":
      return { task: await records.getTask(input.taskUrn, input.version) };
    case "get_run": {
      const run = await records.getRun(input.runUrn, input.version);
      // Historical metadata reads do not revive a native Pi session.
      if (
        input.version !== undefined ||
        !runtime ||
        run.value.actor !== context.actor.urn
      )
        return { run };
      return { run, pi: await runtime.state(run.value.sessionId) };
    }
    case "start_task": {
      needRuntime();
      const id = `urn:li:dataProcessInstance:${runId()}`;
      // A repeated start key never repeats the prompt, even after an ambiguous
      // prior response. The existing Run/session is returned for reconciliation.
      try {
        const run = await records.getRun(id);
        if (run.value.actor !== context.actor.urn)
          reject("task_owner_mismatch", 403);
        if (
          run.value.task !== input.taskUrn ||
          run.value.taskVersion !== input.taskVersion
        )
          reject("task_start_key_conflict");
        return {
          run,
          submission: "existing_do_not_resend",
          pi: await runtime.state(run.value.sessionId),
        };
      } catch (error) {
        if (!(error instanceof TaskRecordError) || error.status !== 404)
          throw error;
      }
      const task = await records.getTask(input.taskUrn);
      if (task.value.actor !== context.actor.urn)
        reject("task_owner_mismatch", 403);
      if (task.version !== input.taskVersion) reject("task_revision_conflict");
      const source = context.sources.find(
        (source) => source.urn === task.value.source,
      );
      if (
        !source?.taskDatasets?.length ||
        !task.value.datasets.every((dataset) =>
          source.taskDatasets.includes(dataset),
        )
      )
        reject("task_scope_not_approved", 403);
      const sessionId = await runtime.createSession();
      const run = await records.bindRun(id, task.urn, task.version, sessionId);
      try {
        await runtime.name(sessionId, `DataHub Task ${input.requestId}`);
        context.assertActive();
        await runtime.prompt(
          sessionId,
          [
            "Execute this user-confirmed metadata Task using the configured read-only DataHub MCP tools.",
            "Task metadata is not authorization for SQL, ingestion, metadata writes, credentials or approval of a business relationship.",
            "When human input is needed, call datahub_decision with the exact runUrn below and wait. Do not answer your own decision.",
            JSON.stringify({
              runUrn: run.urn,
              taskUrn: task.urn,
              source: task.value.source,
              datasets: task.value.datasets,
              instructions: task.value.instructions,
            }),
          ].join("\n"),
        );
        return { run, submission: "accepted" };
      } catch {
        return { run, submission: "unconfirmed_do_not_resend" };
      }
    }
    case "prepare_decision": {
      const current = await records.getRun(input.runUrn);
      const request = await pending(
        current,
        input.requestId,
        input.uiRequestId,
      );
      await records.authorizeRun(
        current.urn,
        current.version,
        current.value.sessionId,
      );
      if (
        !isDeepStrictEqual(
          { question: request.question, choices: request.choices },
          { question: input.question, choices: input.choices },
        )
      )
        reject("task_native_request_mismatch");
      const existing = current.value.decisions.find(
        (decision) => decision.id === input.requestId,
      );
      if (existing) {
        if (
          !isDeepStrictEqual(
            { question: existing.question, choices: existing.choices },
            { question: input.question, choices: input.choices },
          )
        )
          reject("task_decision_exists");
        // Replay is limited to the SAME still-pending native UI request. It does
        // not launch a prompt or apply an answer to a new session/request.
        return { run: current, decision: existing };
      }
      const run = await records.appendDecision(
        current.urn,
        current.version,
        current.value.sessionId,
        {
          id: input.requestId,
          question: input.question,
          choices: input.choices,
        },
      );
      return { run, decision: run.value.decisions.at(-1) };
    }
    case "respond_decision":
    case "respond_publication_review":
    case "respond_execution_review": {
      const current = await records.getRun(input.runUrn);
      const request = await pending(
        current,
        input.requestId,
        input.uiRequestId,
      );
      const decision = current.value.decisions.find(
        (decision) => decision.id === input.requestId,
      );
      if (
        !decision ||
        !isDeepStrictEqual(
          { question: decision.question, choices: decision.choices },
          { question: request.question, choices: request.choices },
        )
      )
        reject("task_native_request_mismatch");
      const run =
        input.action === "respond_decision"
          ? await records.respondDecision(
              current.urn,
              input.version,
              current.value.sessionId,
              input.requestId,
              {
                action: input.actionValue,
                ...(input.text === undefined ? {} : { text: input.text }),
              },
            )
          : await (input.action === "respond_execution_review"
              ? records.respondExecutionReview
              : records.respondPublicationReview)(
              current.urn,
              input.version,
              current.value.sessionId,
              input.requestId,
              { verdict: input.verdict, planDigest: input.planDigest },
            );
      if (input.actionValue === "DISMISS") return stop(run);
      return {
        run,
        decision: run.value.decisions.find(
          (decision) => decision.id === input.requestId,
        ),
      };
    }
    case "cancel_run": {
      needRuntime();
      const current = await records.getRun(input.runUrn);
      const run = await records.closeRun(
        current.urn,
        input.version,
        current.value.sessionId,
      );
      return stop(run);
    }
  }
}

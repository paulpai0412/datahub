import { createHash } from "node:crypto";
import { datahubSessionCookie } from "./datahub-identity.mjs";

export class IngestionError extends Error {
  constructor(code, status = 403) {
    super(code);
    this.status = status;
  }
}
const executionPattern =
  /^urn:li:dataHubExecutionRequest:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const actions = new Set([
  "list_sources",
  "inspect_source",
  "test_connection",
  "run",
  "get_execution",
  "cancel",
]);
const endpoint = (entity, urn, aspect) =>
  `/openapi/v3/entity/${entity}/${encodeURIComponent(urn)}/${aspect}`;

/** Fixed public APIs only. Cookie pair is captured once per authorized host request.
 * No runtime-supplied endpoint, recipe, actor, CLI, credentials or executor. */
export async function nativeIngestion(
  text,
  {
    actor,
    sources,
    frontendOrigin,
    cookieHeader,
    assertActive,
    fetchImpl = fetch,
  },
) {
  let request;
  try {
    request = JSON.parse(text);
  } catch {
    throw new IngestionError("invalid_ingestion_request", 400);
  }
  if (
    !request ||
    typeof request !== "object" ||
    Array.isArray(request) ||
    Object.keys(request).some(
      (key) =>
        ![
          "requestId",
          "action",
          "sourceUrn",
          "executionUrn",
          "expectedSourceVersion",
        ].includes(key),
    ) ||
    !actions.has(request.action) ||
    !executionPattern.test(
      `urn:li:dataHubExecutionRequest:${request.requestId}`,
    )
  )
    throw new IngestionError("invalid_ingestion_request", 400);
  const cookie = datahubSessionCookie(cookieHeader);
  async function call(path, options = {}) {
    let response;
    try {
      response = await fetchImpl(new URL(path, frontendOrigin), {
        ...options,
        headers: { "content-type": "application/json", cookie },
        redirect: "manual",
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new IngestionError(
          "datahub_request_denied",
          response.status === 404 ? 404 : 502,
        );
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 1048576)
          throw new IngestionError("datahub_response_too_large", 502);
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (body.errors?.length)
        throw new IngestionError("datahub_request_denied");
      return body;
    } catch (error) {
      if (error instanceof IngestionError) throw error;
      throw new IngestionError("datahub_unavailable", 502);
    }
  }
  const graphql = (query, variables = {}) =>
    call("/api/v2/graphql", {
      method: "POST",
      body: JSON.stringify({ query, variables }),
    });
  async function authorize() {
    assertActive();
    const me = (
      await graphql(
        "query { me { corpUser { urn } platformPrivileges { manageIngestion } } }",
      )
    ).data?.me;
    if (
      me?.corpUser?.urn !== actor.urn ||
      me?.platformPrivileges?.manageIngestion !== true
    )
      throw new IngestionError("ingestion_forbidden");
  }
  await authorize();
  const policy = sources.find((source) => source.urn === request.sourceUrn);
  if (request.action === "list_sources") {
    if (request.sourceUrn !== undefined || request.executionUrn !== undefined)
      throw new IngestionError("invalid_ingestion_request", 400);
    return {
      sources: sources.map((source) => ({
        urn: source.urn,
        cliVersion: source.cliVersion,
      })),
    };
  }
  if (!policy) throw new IngestionError("source_not_approved");
  const jobAction = ["get_execution", "cancel"].includes(request.action);
  if (
    jobAction
      ? !executionPattern.test(request.executionUrn)
      : request.executionUrn !== undefined
  )
    throw new IngestionError("invalid_ingestion_request", 400);

  async function execution(urn) {
    const input = await call(
      endpoint("datahubexecutionrequest", urn, "datahubexecutionrequestinput"),
    );
    if (
      input.value?.actorUrn !== actor.urn ||
      input.value?.source?.ingestionSource !== policy.urn
    )
      throw new IngestionError("execution_scope_mismatch");
    return input.value;
  }
  if (jobAction) {
    await execution(request.executionUrn);
    if (request.action === "cancel") {
      await authorize();
      assertActive();
      try {
        const body = await graphql(
          "mutation($input:CancelIngestionExecutionRequestInput!){cancelIngestionExecutionRequest(input:$input)}",
          {
            input: {
              ingestionSourceUrn: policy.urn,
              executionRequestUrn: request.executionUrn,
            },
          },
        );
        return {
          executionUrn: request.executionUrn,
          state:
            body.data?.cancelIngestionExecutionRequest === true
              ? "cancel_requested"
              : "cancel_not_accepted",
        };
      } catch {
        return {
          executionUrn: request.executionUrn,
          state: "unknown",
          note: "Reconcile cancellation; do not assume the worker stopped or metadata was rolled back.",
        };
      }
    }
    const body = await graphql(
      "query($urn:String!){executionRequest(urn:$urn){result{status durationMs structuredReport{contentType serializedValue}}}}",
      { urn: request.executionUrn },
    );
    const result = body.data?.executionRequest?.result;
    let capable;
    try {
      if (result?.structuredReport?.contentType === "application/json")
        capable = JSON.parse(result.structuredReport.serializedValue)
          ?.basic_connectivity?.capable;
    } catch {
      /* Malformed report is not a PASS. Never return raw report/logs. */
    }
    return {
      executionUrn: request.executionUrn,
      state: result?.status ?? "NOT_VISIBLE",
      durationMs: result?.durationMs,
      ...(typeof capable === "boolean"
        ? { basicConnectivityCapable: capable }
        : {}),
      note: "Job status is not metadata readback. Cancellation does not roll back already emitted metadata.",
    };
  }

  const source = await call(
    `${endpoint("datahubingestionsource", policy.urn, "datahubingestionsourceinfo")}?systemMetadata=true`,
  );
  const config = source.value?.config;
  if (
    typeof config?.recipe !== "string" ||
    config.version !== policy.cliVersion ||
    config.executorId !== "default" ||
    config.debugMode === true ||
    Object.keys(config.extraArgs ?? {}).length
  )
    throw new IngestionError("source_configuration_not_approved", 409);
  const hash = createHash("sha256").update(config.recipe).digest("hex");
  if (hash !== policy.recipeSha256)
    throw new IngestionError("source_revision_conflict", 409);
  let recipe;
  try {
    recipe = JSON.parse(config.recipe);
  } catch {
    throw new IngestionError("source_recipe_invalid", 409);
  }
  const reference = (value) =>
    typeof value === "string" && /^\$\{[A-Z][A-Z0-9_]*\}$/.test(value);
  if (
    recipe?.source?.type !== "mssql" ||
    !reference(recipe.source.config?.password) ||
    recipe?.sink?.type !== "datahub-rest" ||
    !reference(recipe.sink.config?.token) ||
    recipe.sink.config.server !== "http://datahub-gms:8080"
  )
    throw new IngestionError("source_secret_binding_not_approved", 409);
  const configSource = recipe.source.config;
  const summary = {
    sourceUrn: policy.urn,
    name: source.value.name,
    sourceVersion: source.systemMetadata?.version,
    recipeSha256: hash,
    cliVersion: policy.cliVersion,
    scope: Object.fromEntries(
      [
        "database",
        "platform_instance",
        "schema_pattern",
        "table_pattern",
        "view_pattern",
        "include_tables",
        "include_views",
        "include_view_lineage",
        "include_view_column_lineage",
        "include_jobs",
        "include_stored_procedures",
        "include_query_lineage",
        "include_usage_statistics",
        "profiling",
        "stateful_ingestion",
      ]
        .filter((key) => key in configSource)
        .map((key) => [key, configSource[key]]),
    ),
  };
  if (request.action === "inspect_source") return summary;
  if (
    typeof request.expectedSourceVersion !== "string" ||
    request.expectedSourceVersion !== summary.sourceVersion
  )
    throw new IngestionError("source_revision_conflict", 409);
  const executionUrn = `urn:li:dataHubExecutionRequest:${request.requestId}`;
  const task = request.action === "run" ? "RUN_INGEST" : "TEST_CONNECTION";
  const snapshot = {
    ...(task === "RUN_INGEST" ? recipe : { source: recipe.source }),
    run_id: executionUrn,
    pipeline_name: policy.urn,
  };
  const input = {
    task,
    args: {
      recipe: JSON.stringify(snapshot),
      version: policy.cliVersion,
      debug_mode: "false",
    },
    executorId: "default",
    source: { type: "MANUAL_INGESTION_SOURCE", ingestionSource: policy.urn },
    requestedAt: Date.now(),
    actorUrn: actor.urn,
  };
  // One immutable native request per intent. Existing input must match before a replay is acknowledged.
  try {
    const prior = await execution(executionUrn);
    if (
      prior.task !== task ||
      Object.keys(prior.args ?? {}).length !== 3 ||
      Object.entries(input.args).some(
        ([key, value]) => prior.args[key] !== value,
      )
    )
      throw new IngestionError("execution_id_conflict", 409);
    return { executionUrn, state: "already_submitted" };
  } catch (error) {
    if (!(error instanceof IngestionError) || error.status !== 404) throw error;
  }
  await authorize();
  assertActive();
  try {
    await call(
      `${endpoint("datahubexecutionrequest", executionUrn, "datahubexecutionrequestinput")}?createIfNotExists=true&systemMetadata=true`,
      {
        method: "POST",
        body: JSON.stringify({
          value: input,
          headers: { "If-Version-Match": "-1" },
        }),
      },
    );
    return { executionUrn, state: "submitted", ...summary };
  } catch {
    return {
      executionUrn,
      state: "unknown",
      note: "Submission outcome unknown. Read this execution; do not submit a new run to discover the outcome.",
    };
  }
}

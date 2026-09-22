#!/usr/bin/env node
// One explicitly approved operator batch, not an Agent tool or recurring job.
import { readFile, writeFile, chmod, access } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { nativeIngestion } from "../extensions/datahub-agent/integration/native-ingestion.mjs";

const origin = "http://127.0.0.1:9002";
const sourceUrn =
  "urn:li:dataHubIngestionSource:a513e611-5631-4cf2-8b96-3fa9fd1fee51";
const recipeHash =
  "37002133b89a16959e7360e7caeb5041f73077b5ef61010d598d915e8b58be86";
const previousHash =
  "b5fe9c11ee6c7117abc5a0918da29a86d2edaff49ea20918b5b2277916ed2d70";
const priorReceiptPath =
  ".local/evidence/dataflow-discovery/dm01-canary-run-20260914.json";
const resumeCreateMode412 =
  process.argv[2] === "--resume-reconciled-create-mode-412";
const receiptPath = resumeCreateMode412
  ? ".local/evidence/dataflow-discovery/dm01-canary-resumed-20260914.json"
  : priorReceiptPath;
const proposalPath =
  ".local/evidence/dataflow-discovery/dm01-canary-proposal-20260914.json";
const terminal = new Set([
  "SUCCESS",
  "SUCCEEDED",
  "FAILED",
  "FAILURE",
  "CANCELLED",
  "CANCELED",
  "TIMED_OUT",
  "TIMEOUT",
]);
const sha = (text) => createHash("sha256").update(text).digest("hex");
const endpoint = (entity, urn, aspect) =>
  `/openapi/v3/entity/${entity}/${encodeURIComponent(urn)}/${aspect}?systemMetadata=true`;
let cookie = "";
const receipt = {
  sourceUrn,
  requestId: randomUUID(),
  startedAt: Date.now(),
  status: "IN_PROGRESS",
  phase: "preflight",
  sourceMutationAttempted: false,
  executionMutationAttempted: false,
};
const save = async () => {
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n", {
    mode: 0o600,
  });
  await chmod(receiptPath, 0o600);
};
async function call(path, options = {}, absent = false) {
  const response = await fetch(new URL(path, origin), {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
  });
  if (absent && response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`http_${response.status}`);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 2_000_000) throw new Error("response_limit");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const body = text ? JSON.parse(text) : {};
  if (body.errors?.length) throw new Error("graphql_error");
  return body;
}
const graphql = (query, variables = {}) =>
  call("/api/v2/graphql", {
    method: "POST",
    body: JSON.stringify({ query, variables }),
  });
async function noActiveExecutions() {
  const history = [];
  for (let start = 0; start < 1000; start += 100) {
    const result = await graphql(
      "query($urn:String!,$start:Int!){ingestionSource(urn:$urn){executions(start:$start,count:100){total executionRequests{urn input{task requestedAt} result{status}}}}}",
      { urn: sourceUrn, start },
    );
    const page = result.data?.ingestionSource?.executions;
    if (
      !page ||
      !Number.isInteger(page.total) ||
      !Array.isArray(page.executionRequests)
    )
      throw new Error("execution_history_unknown");
    for (const run of page.executionRequests)
      history.push({
        urn: run.urn,
        task: run.input?.task,
        requestedAt: run.input?.requestedAt,
        status: run.result?.status ?? "NOT_VISIBLE",
      });
    if (start + page.executionRequests.length >= page.total) {
      receipt.previousExecutions = history;
      await save();
      if (history.some((run) => !terminal.has(run.status)))
        throw new Error("existing_execution_not_terminal");
      return;
    }
    if (!page.executionRequests.length)
      throw new Error("execution_history_incomplete");
  }
  throw new Error("execution_history_limit");
}

async function main() {
  if (process.argv[2] !== "--execute-approved-batch" && !resumeCreateMode412)
    throw new Error("explicit_batch_flag_required");
  try {
    await access(receiptPath);
    throw new Error("receipt_exists_reconcile_do_not_replay");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await save();
  if (resumeCreateMode412) {
    const prior = JSON.parse(await readFile(priorReceiptPath, "utf8"));
    if (
      prior.sourceUrn !== sourceUrn ||
      prior.phase !== "conditional_source_update" ||
      prior.error !== "http_412" ||
      prior.executionMutationAttempted !== false ||
      prior.sourceMutationAttempted !== true ||
      !/^[a-f0-9-]{36}$/.test(prior.requestId)
    )
      throw new Error("resume_precondition_not_proven");
    receipt.requestId = prior.requestId;
    receipt.previousReceipt = priorReceiptPath;
    receipt.previousReceiptSha256 = sha(
      await readFile(priorReceiptPath, "utf8"),
    );
    // Fresh Source version/hash and non-running checks below still apply.
    await save();
  }
  const proposal = JSON.parse(await readFile(proposalPath, "utf8"));
  if (
    proposal.source_urn !== sourceUrn ||
    proposal.expected_source_version !== "3" ||
    proposal.expected_recipe_sha256 !== previousHash ||
    sha(proposal.proposed_recipe) !== recipeHash
  )
    throw new Error("approved_proposal_mismatch");
  const password = (await readFile(".local/user.props", "utf8"))
    .split(/\r?\n/)
    .find((line) => line.startsWith("datahub:"))
    ?.slice("datahub:".length)
    .trim();
  if (!password) throw new Error("login_entry_missing");
  const login = await fetch(origin + "/logIn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "datahub", password }),
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
  });
  if (!login.ok) {
    await login.body?.cancel();
    throw new Error("official_login_failed");
  }
  cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  await login.body?.cancel();
  const me = (
    await graphql(
      "query{me{corpUser{urn} platformPrivileges{manageIngestion}}}",
    )
  ).data?.me;
  if (
    me?.corpUser?.urn !== "urn:li:corpuser:datahub" ||
    me?.platformPrivileges?.manageIngestion !== true
  )
    throw new Error("operator_not_authorized");
  receipt.actor = me.corpUser.urn;
  await noActiveExecutions();
  const path = endpoint(
    "datahubingestionsource",
    sourceUrn,
    "datahubingestionsourceinfo",
  );
  const source = await call(path);
  const config = source.value?.config;
  if (
    String(source.systemMetadata?.version) !== "3" ||
    sha(config?.recipe ?? "") !== previousHash ||
    config.version !== "1.7.0.9" ||
    config.executorId !== "default" ||
    config.debugMode === true ||
    Object.keys(config.extraArgs ?? {}).length ||
    source.value.schedule
  )
    throw new Error("source_precondition_changed");
  receipt.phase = "conditional_source_update";
  receipt.sourceMutationAttempted = true;
  await save();
  // This specific-aspect endpoint defaults to CREATE, not UPSERT. Select
  // update semantics explicitly while retaining the version precondition.
  await call(path + "&createIfNotExists=false&async=false", {
    method: "POST",
    body: JSON.stringify({
      value: {
        ...source.value,
        name: "AdventureWorks2019 - metadata-only (7 tables)",
        config: { ...config, recipe: proposal.proposed_recipe },
      },
      headers: { "If-Version-Match": "3" },
    }),
  });
  const updated = await call(path);
  if (
    sha(updated.value?.config?.recipe ?? "") !== recipeHash ||
    updated.value?.name !== "AdventureWorks2019 - metadata-only (7 tables)" ||
    String(updated.systemMetadata?.version) === "3"
  )
    throw new Error("source_update_not_read_back");
  receipt.sourceVersion = String(updated.systemMetadata.version);
  receipt.recipeSha256 = recipeHash;
  receipt.phase = "source_read_back";
  await save();
  await noActiveExecutions();
  const context = {
    actor: { urn: receipt.actor },
    sources: [
      { urn: sourceUrn, cliVersion: "1.7.0.9", recipeSha256: recipeHash },
    ],
    frontendOrigin: origin,
    cookieHeader: cookie,
    assertActive() {
      if (Date.now() - receipt.startedAt > 600000)
        throw new Error("operator_batch_timeout");
    },
  };
  receipt.executionUrn = `urn:li:dataHubExecutionRequest:${receipt.requestId}`;
  receipt.phase = "submit_native_execution";
  receipt.executionMutationAttempted = true;
  await save();
  const submitted = await nativeIngestion(
    JSON.stringify({
      action: "run",
      requestId: receipt.requestId,
      sourceUrn,
      expectedSourceVersion: receipt.sourceVersion,
    }),
    context,
  );
  receipt.submission = submitted;
  await save();
  if (!["submitted", "already_submitted"].includes(submitted.state))
    throw new Error("submission_unknown_do_not_resend");
  console.log(
    JSON.stringify({
      phase: "submitted",
      executionUrn: receipt.executionUrn,
      sourceVersion: receipt.sourceVersion,
    }),
  );
  receipt.phase = "observe_execution";
  await save();
  let finished = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const status = await nativeIngestion(
      JSON.stringify({
        action: "get_execution",
        requestId: receipt.requestId,
        sourceUrn,
        executionUrn: receipt.executionUrn,
      }),
      context,
    );
    if (status.state !== receipt.execution?.state)
      console.log(JSON.stringify({ executionState: status.state }));
    receipt.execution = status;
    await save();
    if (terminal.has(status.state)) {
      finished = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  if (!finished) throw new Error("execution_not_terminal_do_not_resend");
  if (!["SUCCESS", "SUCCEEDED"].includes(receipt.execution.state))
    throw new Error("execution_failed_reconcile");
  receipt.phase = "metadata_readback";
  receipt.datasets = [];
  await save();
  const rawSchema = await readFile(
    ".local/evidence/dataflow-discovery/source-schema-20260914.tsv",
    "utf8",
  );
  receipt.expectedSchemaSha256 = sha(rawSchema);
  const expected = new Map();
  for (const line of rawSchema.trim().split(/\r?\n/)) {
    const [schema, table, , field, type, , , nullable] = line.split("|");
    const key = `AdventureWorks2019.${schema}.${table}`;
    if (!expected.has(key)) expected.set(key, []);
    expected.get(key).push({ field, type, nullable: nullable === "YES" });
  }
  const approvedTables = new Set(
    [
      "Sales.SalesOrderHeader",
      "Sales.SalesOrderDetail",
      "Sales.Customer",
      "Sales.SalesTerritory",
      "Production.Product",
      "Production.ProductSubcategory",
      "Production.ProductCategory",
    ].map((name) => "AdventureWorks2019." + name),
  );
  if (
    expected.size !== 7 ||
    [...expected.keys()].some((name) => !approvedTables.has(name))
  )
    throw new Error("expected_schema_scope_mismatch");
  const normalizeType = (type) =>
    ({ integer: "int", numeric: "decimal" })[type] ?? type;
  for (const [name, columns] of expected) {
    const urn = `urn:li:dataset:(urn:li:dataPlatform:mssql,${name.toLowerCase()},PROD)`;
    const aspect = await call(endpoint("dataset", urn, "schemametadata"));
    const fields = aspect.value?.fields;
    const observation = {
      urn,
      sourceColumns: columns.length,
      catalogColumns: fields?.length,
      systemMetadata: aspect.systemMetadata,
      checks: [],
    };
    receipt.datasets.push(observation);
    if (!Array.isArray(fields) || fields.length !== columns.length) {
      await save();
      throw new Error("schema_field_count_mismatch");
    }
    for (const column of columns) {
      const matches = fields.filter(
        (field) =>
          field.fieldPath?.toLowerCase() === column.field.toLowerCase(),
      );
      const actual = matches[0];
      const baseType = actual?.nativeDataType
        ?.match(/^[a-zA-Z0-9_]+/)?.[0]
        .toLowerCase();
      const pass =
        matches.length === 1 &&
        normalizeType(baseType) === normalizeType(column.type) &&
        actual.nullable === column.nullable;
      observation.checks.push({
        sourceField: column.field,
        catalogField: actual?.fieldPath,
        nativeDataType: actual?.nativeDataType,
        nullable: actual?.nullable,
        pass,
      });
    }
    // Installed Actions maps ExecutionRequest URN -> its id, then overwrites
    // recipe.run_id with that exec_id. Require that exact UUID and pipeline.
    observation.freshRunIdMatch =
      aspect.systemMetadata?.runId === receipt.requestId &&
      aspect.systemMetadata?.pipelineName === sourceUrn &&
      Number.isSafeInteger(aspect.systemMetadata?.lastObserved) &&
      aspect.systemMetadata.lastObserved >= receipt.startedAt;
    await save();
    if (
      !observation.freshRunIdMatch ||
      observation.checks.some((check) => !check.pass)
    )
      throw new Error("schema_readback_not_verified");
  }
  receipt.status = "PASS";
  receipt.phase = "complete";
  receipt.completedAt = Date.now();
  await save();
  console.log(
    JSON.stringify({
      status: receipt.status,
      receiptPath,
      executionUrn: receipt.executionUrn,
      datasets: receipt.datasets.length,
      fields: receipt.datasets.reduce(
        (sum, value) => sum + value.catalogColumns,
        0,
      ),
      sourceOnly: true,
      discoveryE2EAccepted: false,
    }),
  );
}
main().catch(async (error) => {
  // No cookies, credentials, raw server reports, or response bodies in receipts.
  if (
    error.message === "receipt_exists_reconcile_do_not_replay" ||
    error.message === "explicit_batch_flag_required"
  ) {
    console.log(JSON.stringify({ status: "REFUSED", code: error.message }));
    process.exitCode = 1;
    return;
  }
  receipt.status = "INCOMPLETE_RECONCILE_DO_NOT_RESEND";
  receipt.error = /^[a-z0-9_]+$/.test(error.message)
    ? error.message
    : error.name;
  await save();
  console.log(
    JSON.stringify({
      status: receipt.status,
      phase: receipt.phase,
      error: receipt.error,
      receiptPath,
      executionUrn: receipt.executionUrn,
    }),
  );
  process.exitCode = 1;
});

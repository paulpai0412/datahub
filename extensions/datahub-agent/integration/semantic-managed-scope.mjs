import { createHash } from "node:crypto";
import { canonicalPublicationJson } from "./publication-review.mjs";
import {
  SemanticError,
  semanticNativeClient,
} from "./semantic-native-client.mjs";

const valid = (condition, code = "semantic_managed_scope_unverified") => {
  if (!condition) throw new SemanticError(code, 409);
};
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const version = (value) =>
  typeof value === "string" && /^[1-9][0-9]*$/.test(value);
const sha = (value) => createHash("sha256").update(value).digest("hex");

// The only closed-enumeration mode supported by the pinned MSSQL connector.
// General regexes, excludes, instance ambiguity and other connectors must not
// be mistaken for a complete ingestion inventory.
export function exactMssqlInventory(recipe) {
  const source = recipe?.source,
    config = source?.config;
  valid(source?.type === "mssql" && object(config));
  valid(
    config.env === "PROD" &&
      config.convert_urns_to_lowercase === true &&
      config.convert_column_urns_to_lowercase === true &&
      config.include_tables === true &&
      config.include_views === true &&
      config.profiling?.enabled === false &&
      config.stateful_ingestion?.enabled === false,
  );
  valid(typeof config.database === "string");
  const database = config.database.toLowerCase();
  valid(/^[a-z][a-z0-9_]{0,63}$/.test(database));
  valid(
    config.database_pattern?.ignoreCase === false &&
      canonicalPublicationJson(config.database_pattern.allow) ===
        canonicalPublicationJson([`^${config.database}$`]),
  );
  const schemas = config.schema_pattern?.allow;
  valid(
    config.schema_pattern?.ignoreCase === false &&
      Array.isArray(schemas) &&
      schemas.length > 0 &&
      schemas.every((s) => /^\^[a-z][a-z0-9_]{0,63}\$$/.test(s)) &&
      new Set(schemas).size === schemas.length,
  );
  const allowedSchemas = new Set(schemas.map((s) => s.slice(1, -1)));
  valid(
    config.table_pattern?.ignoreCase === false &&
      config.view_pattern?.ignoreCase === false,
  );
  const parse = (patterns) => {
    valid(
      Array.isArray(patterns) && patterns.length > 0 && patterns.length <= 16,
    );
    const names = [];
    for (const pattern of patterns) {
      valid(
        typeof pattern === "string" &&
          pattern.startsWith(`^${database}\\.`) &&
          pattern.endsWith("$") &&
          pattern.length <= 1024,
      );
      const remainder = pattern.slice(database.length + 3, -1);
      const match =
        /^(?<schema>[a-z][a-z0-9_]{0,63})\\\.\((?<group>[a-z][a-z0-9_|]{0,767})\)$/.exec(
          remainder,
        ) ??
        /^(?<schema>[a-z][a-z0-9_]{0,63})\\\.(?<group>[a-z][a-z0-9_]{0,63})$/.exec(
          remainder,
        );
      valid(match && allowedSchemas.has(match.groups.schema));
      for (const table of match.groups.group.split("|")) {
        valid(/^[a-z][a-z0-9_]{0,63}$/.test(table));
        names.push(`${database}.${match.groups.schema}.${table}`);
      }
    }
    return names;
  };
  const names = [
    ...parse(config.table_pattern?.allow),
    ...parse(config.view_pattern?.allow),
  ];
  valid(
    names.length > 0 &&
      names.length <= 64 &&
      new Set(names).size === names.length &&
      !config.table_pattern.deny?.length &&
      !config.view_pattern.deny?.length &&
      !config.database_pattern.deny?.length &&
      !config.schema_pattern.deny?.length,
  );
  return names.map(
    (name) => `urn:li:dataset:(urn:li:dataPlatform:mssql,${name},PROD)`,
  );
}

/** Public API readback; no catalog search, source credentials or new ingestion.
 * A successful Run plus a fully enumerable recipe and exact current schema
 * provenance certifies only those explicitly scoped Dataset members.
 */
export async function readManagedIngestionScope(context, sourceUrn) {
  const policy = context.sources?.find((entry) => entry.urn === sourceUrn);
  valid(
    policy?.semanticModelContextApproved === true,
    "semantic_source_not_authorized",
  );
  const client = semanticNativeClient(context);
  await client.identity();
  await client.authorize(sourceUrn, "INGESTION_SOURCE");
  const sourceRow = await client.entity(sourceUrn, "dataHubIngestionSource", [
    "dataHubIngestionSourceInfo",
  ]);
  const info = sourceRow.dataHubIngestionSourceInfo;
  valid(
    object(info?.value) &&
      version(info.systemMetadata?.version) &&
      typeof info.value.config?.recipe === "string",
  );
  const recipeSha256 = sha(info.value.config.recipe);
  valid(
    recipeSha256 === policy.recipeSha256 &&
      info.value.config.version === policy.cliVersion &&
      info.value.config.executorId === "default",
  );
  let recipe;
  try {
    recipe = JSON.parse(info.value.config.recipe);
  } catch {
    valid(false);
  }
  const members = exactMssqlInventory(recipe);
  const ceiling = new Set(policy.taskDatasets ?? []);
  valid(
    members.every((urn) => ceiling.has(urn)),
    "semantic_managed_scope_not_approved",
  );
  const result = await client.call("/api/v2/graphql", {
    query:
      "query($urn:String!){ingestionSource(urn:$urn){urn latestSuccessfulExecution{urn}}}",
    variables: { urn: sourceUrn },
  });
  valid(result.data?.ingestionSource?.urn === sourceUrn);
  const executionUrn =
    result.data.ingestionSource.latestSuccessfulExecution?.urn;
  const runId = /^urn:li:dataHubExecutionRequest:([a-f0-9-]{36})$/.exec(
    executionUrn ?? "",
  )?.[1];
  valid(runId && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(runId));
  await client.authorize(executionUrn, "EXECUTION_REQUEST");
  const execution = await client.entity(
    executionUrn,
    "dataHubExecutionRequest",
    ["dataHubExecutionRequestInput", "dataHubExecutionRequestResult"],
  );
  const input = execution.dataHubExecutionRequestInput,
    output = execution.dataHubExecutionRequestResult;
  valid(
    version(input?.systemMetadata?.version) &&
      version(output?.systemMetadata?.version) &&
      input.value?.task === "RUN_INGEST" &&
      input.value?.source?.ingestionSource === sourceUrn &&
      input.value?.args?.version === policy.cliVersion &&
      input.value?.executorId === info.value.config.executorId &&
      output.value?.status === "SUCCESS",
  );
  let executedRecipe;
  try {
    executedRecipe = JSON.parse(input.value.args.recipe);
  } catch {
    valid(false);
  }
  valid(
    canonicalPublicationJson(executedRecipe) ===
      canonicalPublicationJson({
        ...recipe,
        run_id: executionUrn,
        pipeline_name: recipe.pipeline_name || sourceUrn,
      }),
  );
  const datasets = [];
  for (const urn of members) {
    await client.authorize(urn, "DATASET");
    const row = await client.entity(urn, "dataset", [
      "datasetKey",
      "schemaMetadata",
      "status",
    ]);
    const schema = row.schemaMetadata;
    valid(
      row.datasetKey?.value &&
        row.status?.value?.removed !== true &&
        version(schema?.systemMetadata?.version) &&
        schema.systemMetadata.runId === runId &&
        schema.systemMetadata.pipelineName === sourceUrn &&
        Array.isArray(schema.value?.fields) &&
        schema.value.fields.every(
          (field) =>
            typeof field.fieldPath === "string" && field.fieldPath.length > 0,
        ),
    );
    const paths = schema.value.fields.map((field) => field.fieldPath);
    valid(new Set(paths).size === paths.length);
    datasets.push({
      urn,
      schemaVersion: schema.systemMetadata.version,
      fields: paths,
    });
  }
  await client.identity();
  const fingerprint = sha(
    canonicalPublicationJson({
      sourceUrn,
      sourceVersion: info.systemMetadata.version,
      recipeSha256,
      executionUrn,
      executionVersion: output.systemMetadata.version,
      datasets,
    }),
  );
  return {
    format: "datahub-semantic.managed-scope/1",
    sourceUrn,
    sourceName: info.value.name,
    sourceVersion: info.systemMetadata.version,
    recipeSha256,
    executionUrn,
    executionVersion: output.systemMetadata.version,
    scopeBasis: "successful_run_exact_recipe_and_current_schema",
    completeEnumeratedRecipeScope: true,
    fullDatabaseInventory: false,
    checkpointVerified: false,
    datasets,
    datasetCount: datasets.length,
    fieldCount: datasets.reduce((n, row) => n + row.fields.length, 0),
    fingerprint,
  };
}

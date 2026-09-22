import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { nativeSemantic } from "../../extensions/datahub-agent/integration/native-semantic.mjs";

export const sourceUrn = "urn:li:dataHubIngestionSource:00000000-0000-4000-8000-000000000001";
export const datasetUrn = "urn:li:dataset:(urn:li:dataPlatform:mssql,Fixture.reporting.orders,DEV)";
export const executionUrn = "urn:li:dataHubExecutionRequest:00000000-0000-4000-8000-000000000099";
export const requestId = "00000000-0000-4000-8000-000000000002";
export const actor = { urn: "urn:li:corpuser:semantic-fixture", key: "a".repeat(48), tenant: "fixture" };
const recipe = JSON.stringify({
  source: { type: "mssql", config: { password: "${SOURCE_PASSWORD}", database: "Fixture" } },
  sink: { type: "datahub-rest", config: { server: "http://datahub-gms:8080", token: "${DATAHUB_TOKEN}" } },
});
export const envelope = (value, version = "1") => ({ value, systemMetadata: { version } });
export function semanticFixture() {
  const policy = {
    urn: sourceUrn, recipeSha256: createHash("sha256").update(recipe).digest("hex"),
    cliVersion: "1.7.0.9", taskDatasets: [datasetUrn], semanticModelContextApproved: true,
  };
  const state = {
    active: true, meUrn: actor.urn, manageIngestion: true, denied: new Set(), calls: [], recipe,
    sourceType: "mssql", executorId: "default", sourceVersion: "1", latestSuccessfulExecution: executionUrn,
    fields: {}, impactRows: [], checkpoint: null,
    execution: {
      urn: executionUrn,
      dataHubExecutionRequestInput: envelope({ task: "RUN_INGEST", executorId: "default", source: { ingestionSource: sourceUrn },
        args: { version: "1.7.0.9", recipe: JSON.stringify({ ...JSON.parse(recipe), run_id: executionUrn, pipeline_name: sourceUrn }) } }),
      dataHubExecutionRequestResult: envelope({ status: "SUCCESS", report: "EXECUTION_REPORT_NOT_FOR_MODEL" }),
    },
    dataset: {
      urn: datasetUrn,
      datasetKey: envelope({ platform: "urn:li:dataPlatform:mssql", name: "Fixture.reporting.orders", origin: "DEV" }),
      status: envelope({ removed: false }),
      datasetProperties: envelope({ description: "Fixture only: orders after discounts.", customProperties: { excluded: "NOT_FOR_MODEL" } }),
      editableDatasetProperties: envelope({ description: "Human maintained fixture definition" }),
      schemaMetadata: envelope({ fields: [
        { fieldPath: "order_id", nativeDataType: "bigint", description: "Order identifier" },
        { fieldPath: "[version=2.0].[type=struct].net.amount", nativeDataType: "decimal(18,2)", description: "Amount after discounts" },
      ], platformSchema: { secret: "RAW_SCHEMA_NOT_FOR_MODEL" } }),
      editableSchemaMetadata: envelope({ editableSchemaFieldInfo: [{ fieldPath: "order_id", description: "Human: source key" }] }),
      globalTags: envelope({ tags: [{ tag: "urn:li:tag:Existing" }] }),
      glossaryTerms: envelope({ terms: [{ urn: "urn:li:glossaryTerm:Order" }] }),
      domains: envelope({ domains: ["urn:li:domain:Sales"] }),
      structuredProperties: envelope({ properties: [{ propertyUrn: "urn:li:structuredProperty:priority", values: [{ string: "normal" }] }] }),
    },
    definitions: {
      "urn:li:domain:Sales": { domainProperties: envelope({ name: "Sales", description: "Fixture domain" }), status: envelope({ removed: false }) },
      "urn:li:tag:Existing": { tagProperties: envelope({ name: "Existing" }) },
      "urn:li:tag:Reviewed": { tagProperties: envelope({ name: "Reviewed" }) },
      "urn:li:glossaryNode:Commerce": { glossaryNodeInfo: envelope({ name: "Commerce", definition: "Commercial operations" }) },
      "urn:li:glossaryTerm:Order": { glossaryTermInfo: envelope({ name: "Order", definition: "Fixture order term" }) },
      "urn:li:structuredProperty:priority": { propertyDefinition: envelope({
        qualifiedName: "priority", displayName: "Priority", valueType: "urn:li:dataType:datahub.string",
        cardinality: "SINGLE", entityTypes: ["urn:li:entityType:datahub.dataset"],
        allowedValues: [{ value: { string: "normal" } }, { value: { string: "high" } }],
      }) },
    },
  };
  const context = {
    actor, sources: [policy], frontendOrigin: "http://datahub.invalid",
    cookieHeader: "OTHER=excluded; PLAY_SESSION=fixture-only; actor=fixture",
    assertActive() { if (!state.active) throw new Error("fixture_grant_revoked"); },
    async fetchImpl(url, options) {
      assert.equal(url.origin, "http://datahub.invalid");
      assert.equal(options.headers.cookie, "PLAY_SESSION=fixture-only; actor=fixture");
      assert.equal(options.redirect, "manual");
      const body = options.body ? JSON.parse(options.body) : undefined;
      state.calls.push({ path: url.pathname, method: options.method ?? "GET", body });
      if (url.pathname === "/api/v2/graphql") {
        assert.ok(body.query.startsWith("query"), "No GraphQL mutations");
        if (body.query.includes("getGrantedPrivileges")) {
          const spec = body.variables.input.resourceSpec;
          assert.equal(body.variables.input.actorUrn, actor.urn);
          const expected = spec.resourceUrn.startsWith("urn:li:glossaryTerm:") ? "GLOSSARY_TERM"
            : spec.resourceUrn.startsWith("urn:li:structuredProperty:") ? "STRUCTURED_PROPERTY"
              : spec.resourceUrn.startsWith("urn:li:glossaryNode:") ? "GLOSSARY_NODE"
                : ({ schemaField: "SCHEMA_FIELD", corpuser: "CORP_USER", corpGroup: "CORP_GROUP", dataJob: "DATA_JOB" }[spec.resourceUrn.split(":")[2]] ?? spec.resourceUrn.split(":")[2].toUpperCase());
          assert.equal(spec.resourceType, expected);
          return Response.json({ data: { getGrantedPrivileges: { privileges: state.denied.has(spec.resourceUrn) ? [] : ["GET_ENTITY"] } } });
        }
        if (body.query.includes("latestSuccessfulExecution")) {
          assert.equal(body.variables.urn, sourceUrn);
          return Response.json({ data: { ingestionSource: { urn: sourceUrn, latestSuccessfulExecution: state.latestSuccessfulExecution ? { urn: state.latestSuccessfulExecution } : null } } });
        }
        if (body.query.includes("relationships(input:")) {
          const { start, count, direction, includeSoftDelete } = body.variables.input;
          assert.equal(count, 20); assert.equal(direction, "INCOMING"); assert.equal(includeSoftDelete, false);
          return Response.json({ data: { entity: { urn: body.variables.urn, relationships: { start, count, total: state.impactRows.length, relationships: state.impactRows.slice(start, start + count) } } } });
        }
        if (body.query.includes("searchAcrossEntities") && body.variables.input.orFilters) {
          const { start, count, orFilters } = body.variables.input;
          assert.equal(orFilters[0].and[0].condition, "EXISTS");
          assert.match(orFilters[0].and[0].field, /^structuredProperties\./);
          return Response.json({ data: { searchAcrossEntities: { start, count, total: state.impactRows.length, searchResults: state.impactRows.slice(start, start + count) } } });
        }
        if (body.query.includes("searchAcrossEntities")) {
          const { types, query, start, count } = body.variables.input;
          const nativeTypes = { DOMAIN: "domain", TAG: "tag", GLOSSARY_NODE: "glossaryNode", GLOSSARY_TERM: "glossaryTerm", STRUCTURED_PROPERTY: "structuredProperty" };
          assert.equal(types.length, 1); assert.ok(nativeTypes[types[0]]); assert.equal(count, 20);
          const matches = Object.entries(state.definitions).filter(([urn, row]) => {
            const value = Object.values(row)[0].value;
            return urn.startsWith(`urn:li:${nativeTypes[types[0]]}:`) && (query === "*" || (value.name ?? value.displayName ?? "").toLowerCase().includes(query.toLowerCase()));
          }).map(([urn]) => ({ entity: { urn } }));
          return Response.json({ data: { searchAcrossEntities: { start, count, total: matches.length, searchResults: matches.slice(start, start + count) } } });
        }
        return Response.json({ data: { me: { corpUser: { urn: state.meUrn }, platformPrivileges: { manageIngestion: state.manageIngestion } } } });
      }
      if (url.pathname === "/api/gms/aspects") {
        assert.equal(url.search, "?action=getTimeseriesAspectValues");
        assert.equal(options.method, "POST");
        assert.equal(body.entity, "dataJob"); assert.equal(body.aspect, "datahubIngestionCheckpoint"); assert.equal(body.limit, 1);
        assert.deepEqual(body.filter, { or: [{ and: [{ field: "pipelineName", values: [sourceUrn], condition: "EQUAL" }] }] });
        return Response.json({ value: { values: state.checkpoint ? [{ aspect: { value: JSON.stringify(state.checkpoint) } }] : [] } });
      }
      if (url.pathname.endsWith("/datahubingestionsourceinfo")) {
        assert.equal(options.body, undefined);
        return Response.json(envelope({ name: "Synthetic Sales Source", config: { recipe: state.recipe, version: "1.7.0.9", executorId: "default", debugMode: false } }));
      }
      assert.equal(options.method, "POST");
      assert.ok(url.pathname.endsWith("/batchGet"), "Only public read batchGet permitted");
      assert.equal(body.length, 1);
      if (url.pathname === "/openapi/v3/entity/datahubingestionsource/batchGet") {
        assert.equal(body[0].urn, sourceUrn);
        return Response.json([{ urn: sourceUrn, dataHubIngestionSourceInfo: envelope({ name: "Synthetic Sales Source", type: state.sourceType,
          config: { recipe: state.recipe, version: "1.7.0.9", executorId: state.executorId, debugMode: false } }, state.sourceVersion) }]);
      }
      if (url.pathname === "/openapi/v3/entity/datahubexecutionrequest/batchGet") {
        assert.equal(body[0].urn, state.latestSuccessfulExecution);
        return Response.json([state.execution]);
      }
      if (url.pathname === "/openapi/v3/entity/dataset/batchGet") {
        assert.equal(body[0].urn, datasetUrn);
        return Response.json([state.dataset]);
      }
      const urn = body[0].urn;
      if (url.pathname === "/openapi/v3/entity/schemafield/batchGet") return Response.json([{ urn, ...state.fields[urn] }]);
      if (urn.includes(":ekop-semantic-") && !Object.hasOwn(state.definitions, urn)) return Response.json([]);
      assert.ok(Object.hasOwn(state.definitions, urn), "Fixture has no such definition");
      return Response.json([{ urn, ...state.definitions[urn] }]);
    },
  };
  return { state, policy, context,
    run: (request = {}) => nativeSemantic(JSON.stringify({ requestId, action: "inspect_dataset", sourceUrn, datasetUrn, ...request }), context),
  };
}

export function semanticCheckpointFixture() {
  const f = semanticFixture();
  const recipe = JSON.parse(f.state.recipe);
  recipe.source.config.stateful_ingestion = { enabled: true, remove_stale_metadata: true, ignore_old_state: true };
  f.state.recipe = JSON.stringify(recipe);
  f.policy.recipeSha256 = createHash("sha256").update(f.state.recipe).digest("hex");
  f.state.execution.dataHubExecutionRequestInput.value.args.recipe = JSON.stringify({ ...recipe, run_id: executionUrn, pipeline_name: sourceUrn });
  Object.assign(f.state.dataset.schemaMetadata.systemMetadata, { runId: executionUrn.split(":").at(-1), lastRunId: "prior-run", pipelineName: sourceUrn });
  f.state.checkpoint = {
    timestampMillis: 1790056000000, pipelineName: sourceUrn, runId: executionUrn.split(":").at(-1),
    platformInstanceId: "", config: "", partitionSpec: { partition: "FULL_TABLE_SNAPSHOT", type: "FULL_TABLE" },
    state: { formatVersion: "1.0", serde: "utf-8", payload: JSON.stringify({ urns: [datasetUrn] }) },
  };
  return f;
}

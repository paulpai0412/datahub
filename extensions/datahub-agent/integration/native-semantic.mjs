import { createHash } from "node:crypto";
import { datahubSessionCookie } from "./datahub-identity.mjs";
import { canonicalPublicationJson } from "./publication-review.mjs";
import { semanticCheckpoint, CheckpointAdapterError } from "./semantic-checkpoint.mjs";

export class SemanticError extends Error {
  constructor(code, status = 400) { super(code); this.status = status; }
}
const fail = (code, status) => { throw new SemanticError(code, status); };
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v, max = 2048) => typeof v === "string" && v.trim().length > 0 && v.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v);
const digest = (v) => createHash("sha256").update(canonicalPublicationJson(v)).digest("hex");
const version = (v) => typeof v === "string" && /^[1-9][0-9]*$/.test(v);
const aspects = ["datasetKey", "status", "schemaMetadata", "datasetProperties", "editableDatasetProperties", "editableSchemaMetadata", "domains", "globalTags", "glossaryTerms", "structuredProperties", "ownership", "institutionalMemory"];
const referenceTypes = {
  domain: ["domain", "domainProperties"],
  node: ["glossaryNode", "glossaryNodeInfo", "GLOSSARY_NODE"],
  tag: ["tag", "tagProperties"],
  term: ["glossaryTerm", "glossaryTermInfo", "GLOSSARY_TERM"],
  property: ["structuredProperty", "propertyDefinition", "STRUCTURED_PROPERTY"],
};
const LIMIT = 48000;
function bounded(value) {
  if (Buffer.byteLength(JSON.stringify(value)) > LIMIT) fail("semantic_response_too_large", 413);
  return value;
}
function parseRequest(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 24000) fail("invalid_semantic_request");
  let r;
  try { r = JSON.parse(raw); } catch { fail("invalid_semantic_request"); }
  const keys = {
    list_sources: [], inspect_source: ["sourceUrn"],
    inspect_dataset: ["sourceUrn", "datasetUrn", "offset", "snapshotDigest", "fieldPath"],
    preview: ["sourceUrn", "datasetUrn", "snapshotDigest", "candidates", "fieldPath"],
    search_vocabulary: ["sourceUrn", "kind", "query", "start"],
    inspect_impact: ["sourceUrn", "datasetUrn", "kind", "referenceUrn", "start", "definitionVersion"],
    preview_definition: ["sourceUrn", "datasetUrn", "snapshotDigest", "definition", "reason", "evidenceIds"],
  };
  if (!object(r) || !Object.hasOwn(keys, r.action) ||
      !/^[a-f0-9-]{36}$/.test(r.requestId ?? "") ||
      Object.keys(r).some((k) => !["action", "requestId", ...keys[r.action]].includes(k))) fail("invalid_semantic_request");
  if (r.action !== "list_sources" && !text(r.sourceUrn, 1024)) fail("invalid_semantic_request");
  if (["inspect_dataset", "preview", "preview_definition", "inspect_impact"].includes(r.action) && !text(r.datasetUrn, 1024)) fail("invalid_semantic_request");
  if (r.snapshotDigest !== undefined && !/^[a-f0-9]{64}$/.test(r.snapshotDigest)) fail("invalid_semantic_request");
  if (r.offset !== undefined && (!Number.isSafeInteger(r.offset) || r.offset < 0 || !r.snapshotDigest)) fail("invalid_semantic_request");
  if (r.action === "preview" && (!r.snapshotDigest || !Array.isArray(r.candidates) || !r.candidates.length || r.candidates.length > 8)) fail("invalid_semantic_request");
  if (r.action === "search_vocabulary" && (!Object.hasOwn(referenceTypes, r.kind) || !text(r.query, 128) ||
      (r.start !== undefined && (!Number.isSafeInteger(r.start) || r.start < 0 || r.start > 980)))) fail("invalid_semantic_request");
  if (r.fieldPath !== undefined && !text(r.fieldPath)) fail("invalid_semantic_request");
  if (r.action === "inspect_impact" && (!Object.hasOwn(referenceTypes, r.kind) || !text(r.referenceUrn, 1024) ||
      (r.start !== undefined && (!Number.isSafeInteger(r.start) || r.start < 0 || r.start > 980)) ||
      (r.definitionVersion !== undefined && !version(r.definitionVersion)) || (r.start > 0 && !r.definitionVersion))) fail("invalid_semantic_request");
  if (r.action === "preview_definition" && (!r.snapshotDigest || !object(r.definition) || !text(r.reason, 2000) ||
      !Array.isArray(r.evidenceIds) || !r.evidenceIds.length || r.evidenceIds.length > 20)) fail("invalid_semantic_request");
  return r;
}

function scalar(v) {
  const plain = object(v) && Object.keys(v).length === 1 ? (v.string ?? v.double) : v;
  if (typeof plain !== "string" && (typeof plain !== "number" || !Number.isFinite(plain))) fail("semantic_catalog_invalid", 409);
  return plain;
}
// Fixed-version public SDK/Core encode (), and comma, not the full fieldPath.
// Never downgrade v2 paths or silently conflate a literal %2C with a comma.
const encodedFieldPath = (path) => path.replace(/[(),]/g, (c) => ({ "(": "%28", ")": "%29", ",": "%2C" })[c]);
const fieldUrn = (dataset, path) => `urn:li:schemaField:(${dataset},${encodedFieldPath(path)})`;
function propertyAssignments(value) {
  const entries = value?.properties ?? [];
  if (!Array.isArray(entries) || entries.some((p) => !text(p?.propertyUrn) || !Array.isArray(p.values)) ||
      new Set(entries.map((p) => p.propertyUrn)).size !== entries.length) fail("semantic_catalog_invalid", 409);
  return entries.map((p) => ({ propertyUrn: p.propertyUrn, values: p.values.map(scalar) }));
}
const normalizedName = (name) => name.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
function definitionProposal(definition, tenant) {
  const { kind, name, description, parentUrn, valueType, cardinality, allowedValues } = definition;
  const keys = ["kind", "name", "description", ...(["domain", "node", "term"].includes(kind) ? ["parentUrn"] : []),
    ...(kind === "property" ? ["valueType", "cardinality", "allowedValues"] : [])];
  if (!Object.hasOwn(referenceTypes, kind) || Object.keys(definition).some((key) => !keys.includes(key)) ||
      !text(name, 160) || !text(description, 8000)) fail("semantic_invalid_definition");
  const parentType = kind === "domain" ? "domain" : "glossaryNode";
  if (parentUrn !== undefined && (!text(parentUrn, 1024) || !parentUrn.startsWith(`urn:li:${parentType}:`))) fail("semantic_invalid_definition");
  const id = `ekop-semantic-${digest({ tenant, kind, name: normalizedName(name), parentUrn: parentUrn ?? null })}`;
  const [entity, aspect] = referenceTypes[kind];
  let value = { name: name.trim(), ...(kind === "node" || kind === "term" ? { definition: description } : { description }) };
  if (kind === "term") value.termSource = "INTERNAL";
  if (parentUrn) value[kind === "domain" ? "parentDomain" : "parentNode"] = parentUrn;
  if (kind === "property") {
    if (!["string", "number"].includes(valueType) || !["SINGLE", "MULTIPLE"].includes(cardinality)) fail("semantic_invalid_definition");
    if (allowedValues !== undefined && (!Array.isArray(allowedValues) || !allowedValues.length || allowedValues.length > 64 ||
        new Set(allowedValues).size !== allowedValues.length || allowedValues.some((v) => valueType === "number" ? typeof v !== "number" || !Number.isFinite(v) : !text(v, 500)))) fail("semantic_invalid_definition");
    value = { qualifiedName: `ekop.semantic.${id.slice(14)}`, displayName: name.trim(), description,
      valueType: `urn:li:dataType:datahub.${valueType}`, cardinality, entityTypes: ["urn:li:entityType:datahub.dataset"],
      ...(allowedValues ? { allowedValues: allowedValues.map((v) => ({ value: { [valueType === "number" ? "double" : "string"]: v } })) } : {}) };
  }
  return { kind, name: name.trim(), proposedUrn: `urn:li:${entity}:${id}`, aspect, value };
}

/** Fixed public reads only. No write action, arbitrary URL/Aspect, SQL or filesystem. */
export async function nativeSemantic(raw, context) {
  const r = parseRequest(raw);
  const { actor, assertActive, frontendOrigin, cookieHeader, fetchImpl = fetch } = context;
  if (!actor?.urn || !actor?.key || !actor?.tenant) fail("semantic_identity_required", 403);
  if (!Array.isArray(context.sources)) fail("semantic_source_policy_required", 403);
  const sources = context.sources.filter((s) => s.semanticModelContextApproved === true);
  const common = { format: "datahub-semantic.preview/1", action: r.action, requestId: r.requestId, publicationAuthorized: false, asOf: new Date().toISOString() };
  const cookie = datahubSessionCookie(cookieHeader);
  const signal = AbortSignal.timeout(20000);
  async function call(path, body) {
    assertActive();
    try {
      const response = await fetchImpl(new URL(path, frontendOrigin), {
        method: body === undefined ? "GET" : "POST", redirect: "manual", signal,
        headers: { "content-type": "application/json", cookie },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(); }
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 1048576) throw new Error();
        chunks.push(chunk);
      }
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (value?.errors !== undefined && (!Array.isArray(value.errors) || value.errors.length)) throw new Error();
      assertActive();
      return value;
    } catch { fail("semantic_catalog_unavailable", 409); }
  }
  async function canRead(urn, type) {
    const data = await call("/api/v2/graphql", {
      query: "query($input:GetGrantedPrivilegesInput!){getGrantedPrivileges(input:$input){privileges}}",
      variables: { input: { actorUrn: actor.urn, resourceSpec: { resourceType: type, resourceUrn: urn } } },
    });
    const privileges = data.data?.getGrantedPrivileges?.privileges;
    return Array.isArray(privileges) && privileges.some((p) => ["GET_ENTITY", "VIEW_ENTITY_PAGE", "EDIT_ENTITY"].includes(p));
  }
  async function authorize(urn, type) {
    if (!await canRead(urn, type)) fail("semantic_read_forbidden", 403);
  }
  async function identity() {
    const value = await call("/api/v2/graphql", { query: "query { me { corpUser { urn } platformPrivileges { manageIngestion } } }" });
    if (value.data?.me?.corpUser?.urn !== actor.urn) fail("semantic_identity_required", 403);
    // DataHub's public Source resolver still requires MANAGE_INGESTION. Do not bypass it
    // by exploiting a more permissive generic entity reader.
    if (value.data.me.platformPrivileges?.manageIngestion !== true) fail("semantic_source_forbidden", 403);
  }
  async function entity(urn, type, names) {
    const rows = await call(`/openapi/v3/entity/${type.toLowerCase()}/batchGet?systemMetadata=true`, [
      { urn, ...Object.fromEntries(names.map((name) => [name, {}])) },
    ]);
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.urn !== urn) fail("semantic_catalog_invalid", 409);
    return rows[0];
  }
  async function readSource(policy) {
    const row = await entity(policy.urn, "dataHubIngestionSource", ["dataHubIngestionSourceInfo"]);
    const envelope = row.dataHubIngestionSourceInfo;
    const info = envelope?.value;
    if (!object(info) || !text(info.name) || !text(info.type, 128) || !version(envelope.systemMetadata?.version) ||
        typeof info.config?.recipe !== "string") fail("semantic_source_invalid", 409);
    const recipeSha256 = createHash("sha256").update(info.config.recipe).digest("hex");
    if (recipeSha256 !== policy.recipeSha256 || info.config.version !== policy.cliVersion) fail("semantic_source_revision_conflict", 409);
    let recipe;
    try { recipe = JSON.parse(info.config.recipe); } catch { fail("semantic_source_invalid", 409); }
    if (!object(recipe) || recipe.source?.type !== info.type) fail("semantic_source_invalid", 409);
    return { recipe, info, source: { urn: policy.urn, name: info.name, type: info.type, version: envelope.systemMetadata.version, recipeSha256 } };
  }
  async function successfulRun(current) {
    const result = await call("/api/v2/graphql", {
      query: "query($urn:String!){ingestionSource(urn:$urn){urn latestSuccessfulExecution{urn}}}",
      variables: { urn: current.source.urn },
    });
    const origin = result.data?.ingestionSource;
    if (origin?.urn !== current.source.urn) fail("semantic_source_invalid", 409);
    if (origin.latestSuccessfulExecution === null) return { status: "NO_SUCCESSFUL_RUN" };
    const urn = origin.latestSuccessfulExecution?.urn;
    if (!text(urn, 1024) || !/^urn:li:dataHubExecutionRequest:[^\s]+$/.test(urn)) fail("semantic_execution_invalid", 409);
    const row = await entity(urn, "dataHubExecutionRequest", ["dataHubExecutionRequestInput", "dataHubExecutionRequestResult"]);
    const input = row.dataHubExecutionRequestInput, output = row.dataHubExecutionRequestResult;
    if (!object(input?.value) || !object(output?.value) || !version(input.systemMetadata?.version) || !version(output.systemMetadata?.version)) fail("semantic_execution_invalid", 409);
    // Managed execution uses the UUID in Catalog system metadata. Accept only the
    // exact native UUID alias, not arbitrary suffixes or an unrelated historical run.
    const runId = /^urn:li:dataHubExecutionRequest:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(urn)?.[1] ?? null;
    const binding = { urn, runId, inputVersion: input.systemMetadata.version, resultVersion: output.systemMetadata.version };
    const expected = { ...current.recipe, run_id: urn, pipeline_name: current.recipe.pipeline_name || current.source.urn };
    if (!text(expected.pipeline_name)) return { ...binding, status: "RUN_RECIPE_UNVERIFIED" };
    let recipe;
    try { recipe = JSON.parse(input.value.args?.recipe); } catch { return { ...binding, status: "RUN_RECIPE_UNVERIFIED" }; }
    if (input.value.task !== "RUN_INGEST" || input.value.source?.ingestionSource !== current.source.urn || output.value.status !== "SUCCESS") {
      return { ...binding, status: "RUN_SOURCE_UNVERIFIED" };
    }
    if (digest(recipe) !== digest(expected) || input.value.args.version !== current.info.config.version ||
        input.value.executorId !== current.info.config.executorId) return { ...binding, status: "RUN_RECIPE_UNVERIFIED" };
    return { ...binding, status: "SUCCESSFUL_RUN_RECIPE_MATCH", pipelineName: expected.pipeline_name };
  }
  async function checkpointProjection(payload) {
    assertActive();
    try {
      const result = await semanticCheckpoint(payload);
      assertActive();
      return result;
    } catch (error) {
      if (error instanceof CheckpointAdapterError) fail(error.code, 409);
      throw error;
    }
  }
  async function sourceInventory(current, execution, approved) {
    const config = current.recipe.source?.config?.stateful_ingestion;
    if (config?.enabled !== true || config.remove_stale_metadata === false || config.ignore_new_state === true) {
      return { status: "CHECKPOINT_NOT_ENABLED" };
    }
    if (current.info.type !== "mssql" || current.info.config.version !== "1.7.0.9") return { status: "CONNECTOR_CHECKPOINT_UNVERIFIED" };
    if (execution.status !== "SUCCESSFUL_RUN_RECIPE_MATCH") return { status: "SUCCESSFUL_RUN_UNVERIFIED" };
    const identity = await checkpointProjection({ mode: "identity", pipelineName: execution.pipelineName });
    await authorize(identity.jobUrn, "DATA_JOB");
    const response = await call("/api/gms/aspects?action=getTimeseriesAspectValues", {
      urn: identity.jobUrn, entity: "dataJob", aspect: "datahubIngestionCheckpoint", limit: 1,
      filter: { or: [{ and: [{ field: "pipelineName", values: [execution.pipelineName], condition: "EQUAL" }] }] },
    });
    const values = response?.value?.values;
    if (!Array.isArray(values) || values.length > 1) fail("semantic_checkpoint_invalid", 409);
    if (!values.length) return { status: "CHECKPOINT_NOT_FOUND" };
    let aspect;
    try { aspect = JSON.parse(values[0]?.aspect?.value); } catch { fail("semantic_checkpoint_invalid", 409); }
    if (!object(aspect) || !Number.isSafeInteger(aspect.timestampMillis) || aspect.timestampMillis <= 0 || aspect.timestampMillis > 8640000000000000 ||
        aspect.pipelineName !== execution.pipelineName || !text(aspect.runId)) fail("semantic_checkpoint_invalid", 409);
    const binding = { jobUrn: identity.jobUrn, executionUrn: execution.urn, timestampMillis: aspect.timestampMillis, digest: digest(aspect) };
    if (aspect.runId !== execution.urn && aspect.runId !== execution.runId) return { ...binding, status: "CHECKPOINT_RUN_MISMATCH" };
    const decoded = await checkpointProjection({ mode: "decode", pipelineName: execution.pipelineName, aspect });
    if (decoded.jobUrn !== identity.jobUrn || decoded.runId !== aspect.runId || !Array.isArray(decoded.datasetUrns) ||
        new Set(decoded.datasetUrns).size !== decoded.datasetUrns.length) fail("semantic_checkpoint_invalid", 409);
    // taskDatasets is an authorization ceiling, not an ingestion manifest (it can
    // also contain downstream publication targets). Only native members within
    // that readable ceiling belong to this Source; never change the Task policy.
    const authorizedDatasetUrns = decoded.datasetUrns.filter((u) => approved.includes(u));
    const matches = decoded.datasetUrns.length > 0 && authorizedDatasetUrns.length === decoded.datasetUrns.length;
    return { ...binding, authorizedDatasetUrns, status: matches ? "NATIVE_CHECKPOINT_MATCH" : "APPROVED_SCOPE_DIFFERS_FROM_CHECKPOINT",
      ...(matches ? { datasetCount: authorizedDatasetUrns.length } : {}),
      scopeMeaning: "datasets_observed_in_named_successful_execution_not_all_historical_catalog_or_database_assets" };
  }
  async function vocabularyDefinition(kind, urn) {
    const [type, aspect, resourceType = type.toUpperCase()] = referenceTypes[kind];
    if (!text(urn, 1024) || !urn.startsWith(`urn:li:${type}:`) || urn.length <= `urn:li:${type}:`.length) fail("semantic_invalid_reference");
    await authorize(urn, resourceType);
    const row = await entity(urn, type, [aspect, "status"]);
    const envelope = row[aspect], v = envelope?.value;
    if (!object(v) || !version(envelope.systemMetadata?.version)) fail("semantic_reference_unverified", 409);
    if (row.status?.value?.removed === true) fail("semantic_reference_removed", 409);
    const name = v.name ?? v.displayName ?? v.qualifiedName ?? null;
    const description = v.description ?? v.definition ?? null;
    const parentUrn = v.parentNode ?? v.parentDomain ?? null;
    if ([name, description, parentUrn].some((x) => x !== null && typeof x !== "string")) fail("semantic_catalog_invalid", 409);
    let constraints;
    if (kind === "property") {
      if (!text(v.valueType) || !["SINGLE", "MULTIPLE"].includes(v.cardinality ?? "SINGLE") || !Array.isArray(v.entityTypes) || v.entityTypes.some((x) => !text(x)) ||
          (v.allowedValues !== undefined && !Array.isArray(v.allowedValues)) ||
          (v.allowedPlatforms !== undefined && (!Array.isArray(v.allowedPlatforms) || v.allowedPlatforms.some((x) => !text(x)))) ||
          (v.immutable !== undefined && typeof v.immutable !== "boolean") || (v.version !== undefined && typeof v.version !== "string")) fail("semantic_catalog_invalid", 409);
      constraints = { qualifiedName: v.qualifiedName, valueType: v.valueType, cardinality: v.cardinality ?? "SINGLE", entityTypes: v.entityTypes,
        definitionVersion: v.version ?? null, immutable: v.immutable ?? false, hasTypeQualifier: Boolean(v.typeQualifier),
        allowedPlatforms: v.allowedPlatforms ?? [], allowedValues: v.allowedValues?.map((item) => {
          if (!object(item) || (item.description !== undefined && typeof item.description !== "string")) fail("semantic_catalog_invalid", 409);
          return { value: scalar(item.value), description: item.description ?? null };
        }) ?? null };
    }
    return { kind, urn, version: envelope.systemMetadata.version, name, description, parentUrn, ...(constraints ? { constraints } : {}) };
  }
  async function searchVocabulary(kind, query, start = 0) {
    const [type, , searchType = type.toUpperCase()] = referenceTypes[kind];
    const response = await call("/api/v2/graphql", {
      query: "query($input:SearchAcrossEntitiesInput!){searchAcrossEntities(input:$input){start count total searchResults{entity{urn}}}}",
      variables: { input: { types: [searchType], query, start, count: 20 } },
    });
    const page = response.data?.searchAcrossEntities;
    if (!page || page.start !== start || !Number.isSafeInteger(page.total) || page.total < 0 ||
        !Array.isArray(page.searchResults) || page.searchResults.length > 20 ||
        (!page.searchResults.length && page.total > start)) fail("semantic_search_invalid", 409);
    const definitions = [], seen = new Set();
    for (const match of page.searchResults) {
      const urn = match?.entity?.urn;
      if (seen.has(urn)) fail("semantic_search_invalid", 409);
      seen.add(urn);
      try { definitions.push(await vocabularyDefinition(kind, urn)); }
      catch (error) {
        if (!(error instanceof SemanticError) || !["semantic_read_forbidden", "semantic_reference_removed"].includes(error.message)) throw error;
      }
    }
    const end = start + page.searchResults.length;
    return { kind, query, start, definitions, nextStart: end < page.total && end <= 980 ? end : null,
      searchWindowExhausted: end >= 1000 && end < page.total,
      hiddenResultsOmitted: definitions.length !== page.searchResults.length,
      duplicateAbsenceVerified: false, sharedDefinitionImpactVerified: false,
      note: "Visible native search candidates only. Search paging is not an atomic inventory or proof of semantic uniqueness; reference versions must be rechecked before reuse." };
  }
  async function definitionImpact(policy, datasetUrn) {
    const definition = await vocabularyDefinition(r.kind, r.referenceUrn);
    if (r.definitionVersion && r.definitionVersion !== definition.version) fail("semantic_definition_version_conflict", 409);
    const start = r.start ?? 0;
    let page, rows, basis;
    const relationships = { domain: ["AssociatedWith", "IsPartOf"], node: ["IsPartOf"], tag: ["TaggedWith"], term: ["TermedWith", "IsA", "HasA"] };
    if (r.kind === "property") {
      const name = definition.constraints.qualifiedName;
      if (typeof name !== "string" || !/^[A-Za-z0-9_.-]{1,256}$/.test(name)) fail("semantic_property_impact_unsupported", 409);
      const response = await call("/api/v2/graphql", {
        query: "query($input:SearchAcrossEntitiesInput!){searchAcrossEntities(input:$input){start count total searchResults{entity{urn}}}}",
        variables: { input: { query: "*", start, count: 20, orFilters: [{ and: [{ field: `structuredProperties.${name}`, condition: "EXISTS" }] }] } },
      });
      page = response.data?.searchAcrossEntities;
      rows = page?.searchResults?.map((row) => ({ ...row, type: "structured_property_assignment" }));
      basis = "current_property_search_index";
    } else {
      const response = await call("/api/v2/graphql", {
        query: "query($urn:String!,$input:RelationshipsInput!){entity(urn:$urn){urn relationships(input:$input){start count total relationships{type direction entity{urn}}}}}",
        variables: { urn: r.referenceUrn, input: { types: relationships[r.kind], direction: "INCOMING", start, count: 20, includeSoftDelete: false } },
      });
      if (response.data?.entity?.urn !== r.referenceUrn) fail("semantic_reference_unverified", 409);
      page = response.data.entity.relationships;
      rows = page?.relationships;
      if (Array.isArray(rows) && rows.some((row) => !relationships[r.kind].includes(row?.type) || row.direction !== "INCOMING")) fail("semantic_impact_invalid", 409);
      basis = "native_incoming_relationships";
    }
    if (!page || page.start !== start || !Number.isSafeInteger(page.total) || page.total < 0 || !Array.isArray(rows) || rows.length > 20 ||
        (!rows.length && page.total > start)) fail("semantic_impact_invalid", 409);
    const references = [], checkedSources = new Set([policy.urn]);
    let omitted = false;
    const types = { dataset: "DATASET", schemaField: "SCHEMA_FIELD", ...Object.fromEntries(Object.values(referenceTypes).map(([entity, , type]) => [entity, type ?? entity.toUpperCase()])) };
    for (const row of rows) {
      const urn = row.entity?.urn, type = typeof urn === "string" ? urn.split(":")[2] : null;
      if (!text(urn, 4096) || !Object.hasOwn(types, type) || !urn.startsWith(`urn:li:${type}:`)) { omitted = true; continue; }
      let approvedSources = [];
      if (["dataset", "schemaField"].includes(type)) {
        approvedSources = sources.filter((s) => s.taskDatasets?.some((dataset) => type === "dataset" ? urn === dataset : urn.startsWith(`urn:li:schemaField:(${dataset},`) && urn.endsWith(")")));
        if (!approvedSources.length) { omitted = true; continue; }
        for (const source of approvedSources) if (!checkedSources.has(source.urn)) { await readSource(source); checkedSources.add(source.urn); }
      }
      try {
        if (type === "schemaField") {
          const parent = approvedSources.flatMap((s) => s.taskDatasets).find((d) => urn.startsWith(`urn:li:schemaField:(${d},`));
          await authorize(parent, "DATASET");
        }
        await authorize(urn, types[type]);
      } catch (error) {
        if (!(error instanceof SemanticError) || error.message !== "semantic_read_forbidden") throw error;
        omitted = true; continue;
      }
      references.push({ urn, relationship: row.type, sourceUrns: approvedSources.map((s) => s.urn),
        scope: approvedSources.length ? "operator_approved_subset" : "shared_vocabulary", outsideContextDataset: urn !== datasetUrn && !urn.startsWith(`urn:li:schemaField:(${datasetUrn},`) });
    }
    const end = start + rows.length;
    return { definition, basis, start, references, hiddenOrUnapprovedReferencesOmitted: omitted,
      nextStart: end < page.total && end <= 980 ? end : null, searchWindowExhausted: end >= 1000 && end < page.total,
      sharedDefinitionImpactVerified: false, sharedDefinitionUpdateAuthorized: false,
      limitations: ["indexed_non_atomic_observation", "visibility_and_model_scope_limited", ...(r.kind === "property" ? ["historical_property_versions_not_enumerated"] : [])] };
  }
  await identity();
  if (r.action === "list_sources") {
    // Read-only source validation is connector-neutral; ingestion execution retains its
    // separate connector, executor, sink, debug and command restrictions unchanged.
    const items = [];
    for (const policy of sources) items.push((await readSource(policy)).source);
    await identity();
    return bounded({ ...common, sources: items });
  }
  const policy = sources.find((s) => s.urn === r.sourceUrn);
  if (!policy) fail("semantic_source_not_approved", 403);
  const sourceState = await readSource(policy);
  const { source } = sourceState;
  let datasetUrns = [];
  // Scope URNs themselves are metadata. Native ACL can narrow the configured
  // model scope; do not disclose revoked members or block other readable assets.
  for (const urn of policy.taskDatasets ?? []) {
    if (await canRead(urn, "DATASET")) datasetUrns.push(urn);
    else if (r.datasetUrn === urn) fail("semantic_read_forbidden", 403);
  }
  const scope = { basis: "operator_allowlist_subset", ingestionMembershipVerified: false, completeSourceInventory: false, datasetUrns };
  const blockers = ["source_inventory_incomplete", "trusted_semantic_review_required"];
  if (r.action === "search_vocabulary") {
    if (!datasetUrns.length) fail("semantic_source_asset_scope_not_configured", 403);
    const vocabulary = await searchVocabulary(r.kind, r.query, r.start);
    await identity();
    return bounded({ ...common, source, scope, blockers, vocabulary });
  }
  const execution = await successfulRun(sourceState);
  const { authorizedDatasetUrns, ...inventory } = await sourceInventory(sourceState, execution, datasetUrns);
  if (authorizedDatasetUrns !== undefined) {
    datasetUrns = authorizedDatasetUrns;
    scope.datasetUrns = datasetUrns;
  }
  scope.inventory = inventory;
  if (inventory.status === "NATIVE_CHECKPOINT_MATCH") {
    scope.basis = "native_checkpoint_reconciled_operator_scope";
    scope.ingestionMembershipVerified = true;
    scope.completeSourceInventory = true;
    blockers.splice(blockers.indexOf("source_inventory_incomplete"), 1);
  }
  if (r.action === "inspect_source") {
    await identity();
    return bounded({ ...common, source, scope, execution, blockers: datasetUrns.length ? blockers : ["source_asset_scope_not_configured", ...blockers] });
  }
  if (!datasetUrns.includes(r.datasetUrn)) fail("semantic_dataset_not_authorized", 403);
  const data = await call("/openapi/v3/entity/dataset/batchGet?systemMetadata=true", [
    { urn: r.datasetUrn, ...Object.fromEntries(aspects.map((a) => [a, {}])) },
  ]);
  if (!Array.isArray(data) || data.length !== 1 || data[0]?.urn !== r.datasetUrn) fail("semantic_catalog_invalid", 409);
  const snapshot = {};
  for (const name of aspects) {
    const envelope = data[0][name];
    if (envelope === undefined) {
      if (["datasetKey", "schemaMetadata"].includes(name)) fail("semantic_catalog_incomplete", 409);
      snapshot[name] = null;
    } else {
      if (!object(envelope?.value) || !version(envelope.systemMetadata?.version)) fail("semantic_catalog_invalid", 409);
      snapshot[name] = { value: envelope.value, version: envelope.systemMetadata.version };
    }
  }
  const value = (name) => snapshot[name]?.value ?? {};
  if (value("status").removed === true) fail("semantic_dataset_removed", 409);
  const fields = value("schemaMetadata").fields;
  const edits = value("editableSchemaMetadata").editableSchemaFieldInfo ?? [];
  if (!Array.isArray(fields) || !Array.isArray(edits) || fields.some((f) => !text(f?.fieldPath)) ||
      new Set(fields.map((f) => f.fieldPath)).size !== fields.length ||
      edits.some((f) => !text(f?.fieldPath)) || new Set(edits.map((f) => f.fieldPath)).size !== edits.length) fail("semantic_catalog_invalid", 409);
  const metadata = data[0].schemaMetadata.systemMetadata;
  // v1.7.0.1 applyUpsert stores incoming runId and moves the prior stored runId
  // into lastRunId. Native readback confirms this; the PDL prose is misleading.
  const provenance = { runId: metadata.runId ?? null, lastRunId: metadata.lastRunId ?? null, pipelineName: metadata.pipelineName ?? null };
  if (Object.values(provenance).some((v) => v !== null && !text(v))) fail("semantic_catalog_invalid", 409);
  const membership = {
    datasetUrn: r.datasetUrn,
    status: execution.status === "SUCCESSFUL_RUN_RECIPE_MATCH" && provenance.runId !== null &&
      (provenance.runId === execution.urn || provenance.runId === execution.runId) && provenance.pipelineName === execution.pipelineName
      ? "NATIVE_RUN_MATCH" : "UNVERIFIED",
    execution, provenance, completeSourceInventory: false,
  };
  if (membership.status !== "NATIVE_RUN_MATCH") blockers.push("source_membership_not_verified");
  let selectedField = null, fieldState = null;
  if (r.fieldPath !== undefined) {
    if (!fields.some((f) => f.fieldPath === r.fieldPath)) fail("semantic_invalid_field");
    if (r.fieldPath.includes("␟")) fail("semantic_field_encoding_unsupported", 409);
    const urn = fieldUrn(r.datasetUrn, r.fieldPath);
    if (fields.filter((f) => fieldUrn(r.datasetUrn, f.fieldPath) === urn).length !== 1) fail("semantic_field_encoding_ambiguous", 409);
    await authorize(urn, "SCHEMA_FIELD");
    fieldState = await entity(urn, "schemaField", ["schemaFieldKey", "structuredProperties", "status"]);
    for (const name of ["schemaFieldKey", "structuredProperties", "status"]) {
      const e = fieldState[name];
      if (e !== undefined && (!object(e.value) || !version(e.systemMetadata?.version))) fail("semantic_catalog_invalid", 409);
    }
    const key = fieldState.schemaFieldKey?.value;
    if (key && (key.parent !== r.datasetUrn || key.fieldPath !== encodedFieldPath(r.fieldPath))) fail("semantic_field_binding_conflict", 409);
    if (fieldState.status?.value.removed === true) fail("semantic_field_removed", 409);
    if (!key && fieldState.structuredProperties) fail("semantic_field_binding_conflict", 409);
    selectedField = { urn, fieldPath: r.fieldPath, materialized: Boolean(key), properties: propertyAssignments(fieldState.structuredProperties?.value),
      propertiesVersion: fieldState.structuredProperties?.systemMetadata.version ?? "-1" };
  }
  const governance = { owners: policy.semanticOwners ?? [], documentationOrigins: policy.semanticDocumentationOrigins ?? [] };
  const snapshotDigest = digest({ actor, source, scope, datasetUrn: r.datasetUrn, snapshot, membership, fieldState, governance });
  if (r.snapshotDigest && r.snapshotDigest !== snapshotDigest) fail("semantic_snapshot_conflict", 409);
  // Private Host compiler seam; never a request field or part of the model DTO.
  context.captureSemanticSnapshot?.({ snapshot: structuredClone(snapshot), fieldState: structuredClone(fieldState), selectedField: structuredClone(selectedField) });
  // Project only known semantic content; never forward customProperties, recipes or raw schema.
  const associations = (items, key) => {
    if (!Array.isArray(items) || items.some((x) => !text(x?.[key]))) fail("semantic_catalog_invalid", 409);
    return [...new Set(items.map((x) => x[key]))];
  };
  const tags = (v) => associations(v?.tags ?? [], "tag");
  const terms = (v) => associations(v?.terms ?? [], "urn");
  const description = (v) => {
    if (v !== undefined && v !== null && typeof v !== "string") fail("semantic_catalog_invalid", 409);
    return v ?? null;
  };
  const evidence = [];
  function evidenceFor(id, content) {
    if (typeof content === "string" && content.trim()) evidence.push({ id, text: content });
  }
  evidenceFor("dataset:source-description", value("datasetProperties").description);
  evidenceFor("dataset:edited-description", value("editableDatasetProperties").description);
  governance.owners.forEach((owner, index) => evidenceFor(`policy:owner:${index}`, owner.rule));
  const editMap = new Map(edits.map((e) => [e.fieldPath, e]));
  const projected = fields.map((f, index) => {
    const edit = editMap.get(f.fieldPath) ?? {};
    evidenceFor(`field:${index}:path`, f.fieldPath);
    evidenceFor(`field:${index}:source-description`, f.description);
    evidenceFor(`field:${index}:edited-description`, edit.description);
    return { fieldPath: f.fieldPath, nativeType: description(f.nativeDataType),
      sourceDescription: description(f.description), editedDescription: description(edit.description),
      sourceTags: tags(f.globalTags), tags: tags(edit.globalTags),
      sourceTerms: terms(f.glossaryTerms), terms: terms(edit.glossaryTerms) };
  });
  const domains = value("domains").domains ?? [];
  const properties = value("structuredProperties").properties ?? [];
  if (!Array.isArray(domains) || domains.some((x) => !text(x)) || !Array.isArray(properties) ||
      properties.some((p) => !text(p?.propertyUrn) || !Array.isArray(p.values)) ||
      new Set(properties.map((p) => p.propertyUrn)).size !== properties.length) fail("semantic_catalog_invalid", 409);
  if (!Array.isArray(value("ownership").owners ?? []) || !Array.isArray(value("institutionalMemory").elements ?? [])) fail("semantic_catalog_invalid", 409);
  const current = { description: description(value("editableDatasetProperties").description),
    sourceDescription: description(value("datasetProperties").description),
    domains, tags: tags(value("globalTags")), terms: terms(value("glossaryTerms")),
    properties: propertyAssignments(value("structuredProperties")),
    owners: (value("ownership").owners ?? []).map((o) => {
      if (!object(o) || !text(o.owner) || !text(o.type) || (o.typeUrn !== undefined && !text(o.typeUrn))) fail("semantic_catalog_invalid", 409);
      return { owner: o.owner, type: o.type, ...(o.typeUrn ? { typeUrn: o.typeUrn } : {}) };
    }),
    documentation: (value("institutionalMemory").elements ?? []).map((d) => {
      if (!object(d) || !text(d.url) || typeof d.description !== "string") fail("semantic_catalog_invalid", 409);
      return { url: d.url, description: d.description };
    }) };
  if (r.action === "inspect_impact") {
    const impact = await definitionImpact(policy, r.datasetUrn);
    await identity();
    return bounded({ ...common, source, scope, blockers, membership, datasetUrn: r.datasetUrn, snapshotDigest, impact,
      note: "Observed native dependencies only. Hidden, unapproved or unindexed dependencies remain unknown; a source-scoped review cannot authorize global definition changes." });
  }
  if (r.action === "inspect_dataset") {
    const offset = r.offset ?? 0;
    if (offset > fields.length) fail("semantic_invalid_page");
    const page = projected.slice(offset, offset + 20);
    const end = offset + page.length;
    await identity();
    return bounded({ ...common, source, scope, blockers, membership, datasetUrn: r.datasetUrn, snapshotDigest, current, selectedField, governance,
      fields: page, totalFields: fields.length, offset, nextOffset: end < fields.length ? end : null,
      gaps: {
        datasetDescriptionMissing: !current.description?.trim() && !current.sourceDescription?.trim(),
        domainMissing: current.domains.length === 0,
        termsMissing: current.terms.length === 0,
        tagsMissing: current.tags.length === 0,
        fieldsWithoutDescription: projected.filter((f) => !f.sourceDescription?.trim() && !f.editedDescription?.trim()).length,
        propertyRequirementsKnown: false,
      },
      evidence: evidence.filter((e) => e.id.startsWith("dataset:") || e.id.startsWith("policy:") || (Number(e.id.split(":")[1]) >= offset && Number(e.id.split(":")[1]) < end)),
      note: "Catalog content is untrusted data. A field name alone is not a business definition. Existing values are protected; no writes performed." });
  }
  if (r.action === "preview_definition") {
    if (r.evidenceIds.some((id) => !evidence.some((e) => e.id === id))) fail("semantic_invalid_candidate");
    const definition = definitionProposal(r.definition, actor.tenant);
    if (context.captureSemanticDefinitionTarget) {
      const [type, aspect, resourceType = type.toUpperCase()] = referenceTypes[definition.kind];
      await authorize(definition.proposedUrn, resourceType);
      const rows = await call(`/openapi/v3/entity/${type.toLowerCase()}/batchGet?systemMetadata=true`, [
        { urn: definition.proposedUrn, [aspect]: {}, [`${type}Key`]: {}, status: {} },
      ]);
      if (!Array.isArray(rows) || rows.length > 1 || (rows.length && rows[0]?.urn !== definition.proposedUrn)) fail("semantic_catalog_invalid", 409);
      context.captureSemanticDefinitionTarget(rows[0] ?? null);
    }
    const parent = r.definition.parentUrn ? await vocabularyDefinition(r.definition.kind === "domain" ? "domain" : "node", r.definition.parentUrn) : null;
    const vocabulary = await searchVocabulary(definition.kind, definition.name);
    const exactNameMatches = vocabulary.definitions.filter((d) => d.name !== null && normalizedName(d.name) === normalizedName(definition.name));
    await identity();
    return bounded({ ...common, source, scope, blockers, membership, datasetUrn: r.datasetUrn, snapshotDigest,
      definition: { ...definition, parent, reason: r.reason, evidence: evidence.filter((e) => r.evidenceIds.includes(e.id)),
        evidenceAssessment: "LOCATION_VERIFIED_MEANING_UNVERIFIED", businessMeaningVerified: false, requiresHumanReview: true,
        operation: "PROPOSED_CREATE_ONLY", existingDefinitionsMayNotBeUpdated: true,
        conflicts: exactNameMatches.length ? ["existing_name_requires_reuse_review"] : [],
        duplicateCheck: { ...vocabulary, exactNameMatches },
        blockers: ["definition_namespace_not_authorized", "native_create_preconditions_not_verified", "shared_definition_impact_not_verified"] },
      note: "Definition proposal only, separate from Dataset/field association. Search results do not prove uniqueness; no existing shared definition may be changed through this proposal." });
  }
  const seen = new Set();
  const changes = [];
  for (const candidate of r.candidates) {
    if (!object(candidate) || Object.keys(candidate).some((k) => !["kind", "fieldPath", "value", "values", "reason", "evidenceIds", "ownerType", "description"].includes(k)) ||
        !["description", "domain", "tag", "term", "property", "owner", "documentation"].includes(candidate.kind) || !text(candidate.value) || !text(candidate.reason) ||
        !Array.isArray(candidate.evidenceIds) || !candidate.evidenceIds.length || candidate.evidenceIds.length > 8 ||
        candidate.evidenceIds.some((id) => !evidence.some((e) => e.id === id))) fail("semantic_invalid_candidate");
    const field = candidate.fieldPath === undefined ? null : projected.find((f) => f.fieldPath === candidate.fieldPath);
    if (candidate.fieldPath !== undefined && (!field || !["description", "tag", "term", "property"].includes(candidate.kind))) fail("semantic_invalid_field");
    if (candidate.kind === "property" && field && selectedField?.fieldPath !== field.fieldPath) fail("semantic_field_snapshot_required", 409);
    if ((candidate.ownerType !== undefined && candidate.kind !== "owner") || (candidate.description !== undefined && candidate.kind !== "documentation")) fail("semantic_invalid_candidate");
    const target = field ?? current;
    const key = JSON.stringify([candidate.fieldPath ?? null, candidate.kind, candidate.kind === "description" ? "" : candidate.value, candidate.ownerType ?? null]);
    if (seen.has(key)) fail("semantic_duplicate_candidate");
    seen.add(key);
    const kind = candidate.kind;
    if (kind !== "property" && candidate.values !== undefined) fail("semantic_invalid_candidate");
    let before, after, definition;
    if (kind === "owner") {
      const index = governance.owners.findIndex((o) => o.urn === candidate.value && o.type === candidate.ownerType);
      if (index < 0 || !candidate.evidenceIds.includes(`policy:owner:${index}`)) fail("semantic_owner_policy_required", 403);
      const user = candidate.value.startsWith("urn:li:corpuser:");
      await authorize(candidate.value, user ? "CORP_USER" : "CORP_GROUP");
      const key = user ? "corpUserKey" : "corpGroupKey";
      const owner = await entity(candidate.value, user ? "corpuser" : "corpGroup", [key, "status", ...(user ? ["corpUserStatus"] : [])]);
      if (!object(owner[key]?.value) || !version(owner[key].systemMetadata?.version)) fail("semantic_reference_unverified", 409);
      if (owner.status?.value.removed === true || owner.corpUserStatus?.value.active === false) fail("semantic_reference_removed", 409);
      before = current.owners;
      after = before.some((o) => o.owner === candidate.value && o.type === candidate.ownerType) ? before : [...before, { owner: candidate.value, type: candidate.ownerType }];
      definition = { urn: candidate.value, version: owner[key].systemMetadata.version, rule: governance.owners[index].rule };
    } else if (kind === "documentation") {
      if (!text(candidate.description)) fail("semantic_invalid_candidate");
      let url;
      try { url = new URL(candidate.value); } catch { fail("semantic_invalid_documentation"); }
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.href !== candidate.value ||
          !governance.documentationOrigins.includes(url.origin)) fail("semantic_documentation_policy_required", 403);
      before = current.documentation;
      const existing = before.find((d) => d.url === candidate.value);
      if (existing && existing.description !== candidate.description) fail("semantic_existing_documentation_protected", 409);
      after = existing ? before : [...before, { url: candidate.value, description: candidate.description }];
    } else if (kind === "description") {
      before = field ? field.editedDescription : current.description;
      after = candidate.value;
    } else {
      const [entity, aspect, resourceType = entity.toUpperCase()] = referenceTypes[kind];
      if (!candidate.value.startsWith(`urn:li:${entity}:`) || candidate.value.length <= `urn:li:${entity}:`.length) fail("semantic_invalid_reference");
      await authorize(candidate.value, resourceType);
      const refs = await call(`/openapi/v3/entity/${entity.toLowerCase()}/batchGet?systemMetadata=true`, [
        { urn: candidate.value, [aspect]: {}, status: {} },
      ]);
      const ref = Array.isArray(refs) && refs.length === 1 && refs[0]?.urn === candidate.value ? refs[0][aspect] : null;
      if (!object(ref?.value) || !version(ref.systemMetadata?.version)) fail("semantic_reference_unverified", 409);
      if (refs[0].status?.value?.removed === true) fail("semantic_reference_removed", 409);
      definition = { urn: candidate.value, version: ref.systemMetadata.version,
        name: description(ref.value.name ?? ref.value.displayName ?? ref.value.qualifiedName),
        description: description(ref.value.description ?? ref.value.definition) };
      if (kind === "property") {
        const p = ref.value;
        if (!Array.isArray(candidate.values) || !candidate.values.length || candidate.values.length > 16 ||
            !Array.isArray(p.entityTypes) || !p.entityTypes.includes(field ? "urn:li:entityType:datahub.schemaField" : "urn:li:entityType:datahub.dataset") ||
            !["SINGLE", "MULTIPLE"].includes(p.cardinality ?? "SINGLE") ||
            ((p.cardinality ?? "SINGLE") === "SINGLE" && candidate.values.length !== 1)) fail("semantic_invalid_property");
        const type = p.valueType;
        if (!["urn:li:dataType:datahub.string", "urn:li:dataType:datahub.number"].includes(type) || p.allowedPlatforms?.length || p.typeQualifier) fail("semantic_property_constraints_unsupported", 409);
        if (new Set(candidate.values).size !== candidate.values.length) fail("semantic_invalid_property");
        for (const v of candidate.values) {
          if (type.endsWith(".number") ? typeof v !== "number" || !Number.isFinite(v) : !text(v)) fail("semantic_invalid_property");
          if (p.allowedValues && (!Array.isArray(p.allowedValues) || !p.allowedValues.some((a) => (object(a.value) ? a.value.string ?? a.value.double : a.value) === v))) fail("semantic_invalid_property");
        }
        before = (field ? selectedField.properties : current.properties).find((p) => p.propertyUrn === candidate.value)?.values ?? [];
        after = candidate.values;
        if (p.immutable && before.length && canonicalPublicationJson(before) !== canonicalPublicationJson(after)) fail("semantic_immutable_property", 409);
      } else {
        before = target[kind === "domain" ? "domains" : kind === "tag" ? "tags" : "terms"];
        if (field) before = [...new Set([...before, ...field[kind === "tag" ? "sourceTags" : "sourceTerms"]])];
        after = before.includes(candidate.value) ? before : [...before, candidate.value];
      }
    }
    changes.push({ ...candidate, before, after, ...(definition ? { definition } : {}),
      operation: canonicalPublicationJson(before) === canonicalPublicationJson(after) ? "NO_CHANGE" : "PROPOSED",
      requiresHumanReview: true, businessMeaningVerified: false,
      conflicts: kind === "description" && before !== null && before !== after ? ["existing_edited_value_protected"] :
        kind === "property" && before.length && canonicalPublicationJson(before) !== canonicalPublicationJson(after) ? ["existing_property_value_protected"] : [],
      evidenceAssessment: "LOCATION_VERIFIED_MEANING_UNVERIFIED",
      evidence: evidence.filter((e) => candidate.evidenceIds.includes(e.id)) });
  }
  await identity();
  return bounded({ ...common, source, scope, blockers, membership, datasetUrn: r.datasetUrn, snapshotDigest, selectedField, governance, changes,
    note: "Read-only proposals, not approval or publication. References and evidence locations checked; business meaning and maintenance ownership remain unverified." });
}

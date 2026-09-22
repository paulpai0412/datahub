import { createHash } from "node:crypto";
import { invokePythonBridge } from "./python-bridge.mjs";
import { isAbsolute } from "node:path";
import { datahubSessionCookie } from "./datahub-identity.mjs";
import {
  canonicalPublicationJson,
  makePublicationReview,
  validatePublicationReview,
} from "./publication-review.mjs";

export class DiscoveryError extends Error {
  constructor(code, status = 403) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
const digest = /^[a-f0-9]{64}$/;
const sourceId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const requestId =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const only = (value, keys) =>
  object(value) && Object.keys(value).every((key) => keys.includes(key));

function pythonAnalysisPolicy(value, paths) {
  // Two explicit policy versions, never a failed-resolution fallback. The
  // connection form is expanded by Python from freshly captured source only.
  const scopeField =
    object(value) && Object.hasOwn(value, "scopesByConnection")
      ? "scopesByConnection"
      : "scopesByContext";
  const idPattern =
    scopeField === "scopesByConnection"
      ? /^connection:[a-f0-9]{64}$/
      : /^sql-use:[a-f0-9]{64}$/;
  if (
    !only(value, ["path", "entrypoint", scopeField, "modelContextApproved"]) ||
    !paths.includes(value.path) ||
    !value.path.endsWith(".py") ||
    typeof value.entrypoint !== "string" ||
    !/^[A-Za-z_]\w{0,127}$/.test(value.entrypoint) ||
    value.modelContextApproved !== true ||
    !object(value[scopeField]) ||
    !Object.keys(value[scopeField]).length ||
    Object.keys(value[scopeField]).length > 128 ||
    Buffer.byteLength(JSON.stringify(value)) > 65536
  )
    throw new DiscoveryError("invalid_discovery_policy");
  return Object.freeze({
    ...value,
    [scopeField]: catalogScopes(value[scopeField], idPattern),
  });
}

function catalogScopes(input, idPattern) {
  if (!object(input) || Object.keys(input).length > 128)
    throw new DiscoveryError("invalid_discovery_policy");
  const urns = new Set();
  const scopes = {};
  for (const [id, scope] of Object.entries(input)) {
    if (
      !idPattern.test(id) ||
      !only(scope, [
        "database",
        "default_schema",
        "env",
        "lowercase_urns",
        "lowercase_fields",
        "allowed_dataset_urns",
      ]) ||
      typeof scope.database !== "string" ||
      !scope.database ||
      !(
        scope.default_schema === null ||
        (typeof scope.default_schema === "string" && scope.default_schema)
      ) ||
      typeof scope.env !== "string" ||
      !scope.env ||
      typeof scope.lowercase_urns !== "boolean" ||
      typeof scope.lowercase_fields !== "boolean" ||
      !Array.isArray(scope.allowed_dataset_urns) ||
      !scope.allowed_dataset_urns.length ||
      scope.allowed_dataset_urns.some(
        (urn) =>
          typeof urn !== "string" ||
          urn.length > 1024 ||
          !urn.startsWith("urn:li:dataset:(urn:li:dataPlatform:mssql,"),
      ) ||
      new Set(scope.allowed_dataset_urns).size !==
        scope.allowed_dataset_urns.length
    )
      throw new DiscoveryError("invalid_discovery_policy");
    scope.allowed_dataset_urns.forEach((urn) => urns.add(urn));
    scopes[id] = Object.freeze({
      ...scope,
      allowed_dataset_urns: Object.freeze([...scope.allowed_dataset_urns]),
    });
  }
  if (urns.size > 64) throw new DiscoveryError("invalid_discovery_policy");
  return Object.freeze(scopes);
}

function workspacePolicy(source) {
  if (
    !only(source, [
      "sourceId",
      "root",
      "workspace",
      "modelContextApproved",
      "catalogScopes",
    ]) ||
    typeof source.sourceId !== "string" ||
    !sourceId.test(source.sourceId) ||
    typeof source.root !== "string" ||
    !isAbsolute(source.root) ||
    source.root === "/" ||
    source.root.endsWith("/") ||
    source.root
      .split("/")
      .slice(1)
      .some((part) => !part || part === "." || part === "..") ||
    /[\\\\\x00-\x1f\x7f]/.test(source.root) ||
    source.modelContextApproved !== true ||
    Buffer.byteLength(JSON.stringify(source)) > 65536
  )
    throw new DiscoveryError("invalid_discovery_policy");
  return Object.freeze({
    ...source,
    catalogScopes: catalogScopes(source.catalogScopes, sourceId),
  });
}

/** Deployment policy, never browser/model input. Exact bytes approved for model context. */
export function discoveryPolicies(value = {}) {
  if (!object(value)) throw new DiscoveryError("invalid_discovery_policy");
  const policies = new Map();
  for (const [actor, sources] of Object.entries(value)) {
    if (
      !/^[a-f0-9]{48}$/.test(actor) ||
      !Array.isArray(sources) ||
      sources.length > 8
    )
      throw new DiscoveryError("invalid_discovery_policy");
    const seen = new Set();
    const approved = sources.map((source) => {
      if (source?.workspace === true) {
        const policy = workspacePolicy(source);
        if (seen.has(policy.sourceId))
          throw new DiscoveryError("invalid_discovery_policy");
        seen.add(policy.sourceId);
        return policy;
      }
      if (
        !only(source, [
          "sourceId",
          "root",
          "paths",
          "snapshotSha256",
          "modelContextApproved",
          "pythonAnalysis",
        ]) ||
        typeof source.sourceId !== "string" ||
        !sourceId.test(source.sourceId) ||
        seen.has(source.sourceId) ||
        typeof source.root !== "string" ||
        !isAbsolute(source.root) ||
        typeof source.snapshotSha256 !== "string" ||
        !digest.test(source.snapshotSha256) ||
        source.modelContextApproved !== true ||
        !Array.isArray(source.paths) ||
        !source.paths.length ||
        source.paths.length > 128 ||
        source.paths.some(
          (path) =>
            typeof path !== "string" ||
            !path ||
            path.length > 512 ||
            path.startsWith("/") ||
            path
              .split("/")
              .some((part) => !part || part === "." || part === ".."),
        ) ||
        new Set(source.paths).size !== source.paths.length
      )
        throw new DiscoveryError("invalid_discovery_policy");
      seen.add(source.sourceId);
      return Object.freeze({
        ...source,
        paths: Object.freeze([...source.paths]),
        ...(source.pythonAnalysis === undefined
          ? {}
          : {
              pythonAnalysis: pythonAnalysisPolicy(
                source.pythonAnalysis,
                source.paths,
              ),
            }),
      });
    });
    policies.set(actor, Object.freeze(approved));
  }
  return policies;
}

function parseRequest(text) {
  let request;
  try {
    if (typeof text !== "string" || Buffer.byteLength(text) > 8192)
      throw new Error();
    request = JSON.parse(text);
  } catch {
    throw new DiscoveryError("invalid_discovery_request", 400);
  }
  if (
    !only(request, [
      "requestId",
      "action",
      "sourceId",
      "offset",
      "limit",
      "candidateDigest",
      "selection",
      "pythonPath",
      "entrypoint",
      "snapshotSha256",
      "connections",
    ]) ||
    typeof request.requestId !== "string" ||
    !requestId.test(request.requestId) ||
    ![
      "list_sources",
      "analyze",
      "list_workspaces",
      "analyze_workspace",
    ].includes(request.action)
  )
    throw new DiscoveryError("invalid_discovery_request", 400);
  if (["list_sources", "list_workspaces"].includes(request.action)) {
    if (
      Object.keys(request).some((key) => !["requestId", "action"].includes(key))
    )
      throw new DiscoveryError("invalid_discovery_request", 400);
  } else if (request.action === "analyze_workspace") {
    if (
      !only(request, [
        "requestId",
        "action",
        "sourceId",
        "selection",
        "pythonPath",
        "entrypoint",
        "snapshotSha256",
        "connections",
      ]) ||
      typeof request.sourceId !== "string" ||
      !sourceId.test(request.sourceId) ||
      typeof request.selection !== "string" ||
      !request.selection ||
      request.selection.length > 1024 ||
      (request.pythonPath !== undefined &&
        (typeof request.pythonPath !== "string" ||
          request.pythonPath.length > 512)) ||
      (request.entrypoint !== undefined &&
        (typeof request.entrypoint !== "string" ||
          !/^[A-Za-z_]\w{0,127}$/.test(request.entrypoint))) ||
      (request.snapshotSha256 !== undefined &&
        (typeof request.snapshotSha256 !== "string" ||
          !digest.test(request.snapshotSha256))) ||
      (request.connections !== undefined &&
        (!request.snapshotSha256 ||
          !object(request.connections) ||
          Object.keys(request.connections).length > 128 ||
          Object.entries(request.connections).some(
            ([id, scope]) =>
              !/^connection:[a-f0-9]{64}$/.test(id) ||
              typeof scope !== "string" ||
              !sourceId.test(scope),
          )))
    )
      throw new DiscoveryError("invalid_discovery_request", 400);
  } else if (
    !only(request, [
      "requestId",
      "action",
      "sourceId",
      "offset",
      "limit",
      "candidateDigest",
    ]) ||
    Buffer.byteLength(text) > 2048 ||
    typeof request.sourceId !== "string" ||
    !sourceId.test(request.sourceId) ||
    !Number.isSafeInteger(request.offset ?? 0) ||
    (request.offset ?? 0) < 0 ||
    (request.offset ?? 0) > 10000 ||
    !Number.isSafeInteger(request.limit ?? 5) ||
    (request.limit ?? 5) < 1 ||
    (request.limit ?? 5) > 10 ||
    (((request.offset ?? 0) > 0 || request.candidateDigest !== undefined) &&
      (typeof request.candidateDigest !== "string" ||
        !digest.test(request.candidateDigest)))
  )
    throw new DiscoveryError("invalid_discovery_request", 400);
  return request;
}

const bridgeErrors = new Set([
  "invalid_discovery_page",
  "discovery_snapshot_rejected",
  "discovery_source_drift",
  "discovery_analysis_drift",
  "discovery_validation_failed",
  "discovery_candidate_exceeds_page_limit",
  "discovery_policy_too_large",
  "discovery_analysis_failed",
  "discovery_publication_rejected",
  "discovery_catalog_rejected",
  "discovery_workspace_rejected",
  "discovery_workspace_too_large",
  "workspace_source_drift",
  "workspace_entrypoint_rejected",
  "workspace_scope_rejected",
  "workspace_lineage_incomplete",
  "host_connection_selection_required",
  "connection_origin_unresolved",
  "invalid_workspace_selection",
  "source_changed_during_capture",
  "source_unavailable_or_symlink",
  "sensitive_content",
  "workspace_directory_limit",
  "workspace_entry_limit",
]);

/** Shared fixed subprocess transport; never executes captured source. */
async function invokeBridge(payload, maxBuffer) {
  const { failed, stdout } = await invokePythonBridge("discovery", payload, maxBuffer);
  let result;
  try { result = JSON.parse(stdout); } catch { /* Never return stderr. */ }
  if (object(result) && bridgeErrors.has(result.error)) {
    throw new DiscoveryError(result.error, 409);
  }
  if (failed || !object(result)) throw new DiscoveryError("discovery_analysis_unavailable", 503);
  return result;
}

/** Fixed trusted parser executable; never a shell, analyzed program or runtime worker. */
export async function analyzeDiscovery(policy, request, catalog) {
  const payload = {
    policy,
    request,
    ...(catalog === undefined ? {} : { catalog }),
  };
  if (Buffer.byteLength(JSON.stringify(payload)) > 131072)
    throw new DiscoveryError("discovery_policy_too_large", 409);
  const result = await invokeBridge(payload, 60000);
  if (
    result.format !==
      (policy.pythonAnalysis
        ? "dataflow-discovery.agent-python-fields/2"
        : "dataflow-discovery.agent-page/1") ||
    result.sourceId !== policy.sourceId ||
    result.snapshotSha256 !== policy.snapshotSha256 ||
    result.publicationAuthorized !== false
  )
    throw new DiscoveryError("discovery_analysis_unavailable", 503);
  return result;
}

function workspaceSelection(root, input) {
  if (
    /[\\\\\x00-\x1f\x7f:]/.test(input) ||
    input.split("/").some((part) => part === "..")
  )
    throw new DiscoveryError("invalid_workspace_selection", 400);
  if (input === root) return ".";
  if (isAbsolute(input)) {
    if (!input.startsWith(`${root}/`))
      throw new DiscoveryError("discovery_source_not_authorized");
    return input.slice(root.length + 1);
  }
  return input;
}

/** Fixed source-only/Catalog preview. This operation cannot publish or execute ETL. */
export async function analyzeWorkspace(
  policy,
  request,
  catalog,
  relatedCatalog,
) {
  const payload = {
    operation: "workspace_analyze",
    policy,
    request,
    ...(catalog === undefined ? {} : { catalog }),
    ...(relatedCatalog === undefined ? {} : { relatedCatalog }),
  };
  if (Buffer.byteLength(JSON.stringify(payload)) > 131072)
    throw new DiscoveryError("discovery_policy_too_large", 409);
  const result = await invokeBridge(payload, 60000);
  if (
    result.format !== "datahub-etl.preview/3" ||
    result.sourceId !== policy.sourceId ||
    !digest.test(result.snapshotSha256) ||
    result.publicationAuthorized !== false ||
    result.complete !== false
  )
    throw new DiscoveryError("discovery_analysis_unavailable", 503);
  return result;
}

/** Trusted preparation only: reproduce selected source and Catalog bindings.
 * Desired native values are not merged diffs, adoption, or publication consent.
 */
export async function compileWorkspacePublication(
  policy,
  request,
  catalog,
  relatedCatalog,
) {
  const payload = {
    operation: "workspace_compile",
    policy,
    request,
    catalog,
    ...(relatedCatalog === undefined ? {} : { relatedCatalog }),
  };
  if (Buffer.byteLength(JSON.stringify(payload)) > 131072)
    throw new DiscoveryError("discovery_policy_too_large", 409);
  const result = await invokeBridge(payload, 150000);
  if (
    result.format !== "datahub-etl.desired-aspects/1" ||
    result.sourceId !== policy.sourceId ||
    result.snapshotSha256 !== request.snapshotSha256 ||
    result.publicationAuthorized !== false ||
    result.nativeMergeRequired !== true ||
    !Array.isArray(result.aspects) ||
    !result.aspects.length ||
    result.aspects.length > 128
  )
    throw new DiscoveryError("discovery_publication_rejected", 409);
  return result;
}

/** Resolve captured Grafana datasource/panel identities through native metadata.
 * Search is bounded and complete or rejected; no guessed connector URNs.
 */
export async function readWorkspaceBiCatalog(requests, context) {
  if (!Array.isArray(requests) || requests.length > 128)
    throw new DiscoveryError("workspace_bi_catalog_rejected", 409);
  if (!requests.length) return [];
  const cookie = datahubSessionCookie(context.cookieHeader);
  async function call(path, body) {
    context.assertActive();
    const r = await (context.fetchImpl ?? fetch)(
      new URL(path, context.frontendOrigin),
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
        redirect: "manual",
      },
    );
    if (!r.ok) {
      await r.body?.cancel();
      throw new DiscoveryError("workspace_bi_catalog_rejected");
    }
    let size = 0;
    const chunks = [];
    for await (const chunk of r.body) {
      size += chunk.length;
      if (size > 1048576)
        throw new DiscoveryError("workspace_bi_catalog_rejected");
      chunks.push(chunk);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (value.errors?.length)
      throw new DiscoveryError("workspace_bi_catalog_rejected");
    context.assertActive();
    return value;
  }
  const found = await call("/api/v2/graphql", {
    query:
      "query($input:SearchAcrossEntitiesInput!){searchAcrossEntities(input:$input){total searchResults{entity{urn}}}}",
    variables: {
      input: {
        types: ["DATASET"],
        query: "*",
        start: 0,
        count: 100,
        orFilters: [
          {
            and: [
              {
                field: "platform",
                values: ["urn:li:dataPlatform:grafana"],
                condition: "EQUAL",
              },
            ],
          },
        ],
      },
    },
  });
  const result = found.data?.searchAcrossEntities;
  if (
    !Number.isSafeInteger(result?.total) ||
    result.total > 100 ||
    !Array.isArray(result.searchResults) ||
    result.searchResults.length !== result.total
  )
    throw new DiscoveryError("workspace_bi_catalog_incomplete", 409);
  const urns = result.searchResults.map((item) => item.entity?.urn);
  if (
    !urns.length ||
    new Set(urns).size !== urns.length ||
    urns.some(
      (urn) =>
        typeof urn !== "string" ||
        !urn.startsWith("urn:li:dataset:(urn:li:dataPlatform:grafana,"),
    )
  )
    throw new DiscoveryError("workspace_bi_catalog_incomplete", 409);
  for (const urn of urns) {
    const granted = await call("/api/v2/graphql", {
      query:
        "query($input:GetGrantedPrivilegesInput!){getGrantedPrivileges(input:$input){privileges}}",
      variables: {
        input: {
          actorUrn: context.actor.urn,
          resourceSpec: { resourceType: "DATASET", resourceUrn: urn },
        },
      },
    });
    const values = granted.data?.getGrantedPrivileges?.privileges;
    if (
      !Array.isArray(values) ||
      !values.some((v) =>
        ["GET_ENTITY", "VIEW_ENTITY_PAGE", "EDIT_ENTITY"].includes(v),
      )
    )
      throw new DiscoveryError("workspace_bi_catalog_rejected");
  }
  const aspects = [
    "datasetProperties",
    "schemaMetadata",
    "upstreamLineage",
    "viewProperties",
    "status",
  ];
  const rows = await call(
    "/openapi/v3/entity/dataset/batchGet?systemMetadata=true",
    urns.map((urn) => ({
      urn,
      ...Object.fromEntries(aspects.map((name) => [name, {}])),
    })),
  );
  if (
    !Array.isArray(rows) ||
    new Set(rows.map((row) => row.urn)).size !== urns.length ||
    rows.some((row) => !urns.includes(row.urn))
  )
    throw new DiscoveryError("workspace_bi_catalog_incomplete", 409);
  const selected = rows.filter((row) => {
    const props = row.datasetProperties?.value?.customProperties;
    return (
      props?.type === "mssql" &&
      requests.some(
        (item) =>
          item.dashboardUid === props.dashboard_uid &&
          item.datasourceUid === props.datasource_uid,
      )
    );
  });
  for (const item of requests.filter((item) => item.kind === "panel")) {
    if (
      selected.filter((row) => {
        const p = row.datasetProperties.value.customProperties;
        return (
          p.dashboard_uid === item.dashboardUid &&
          p.datasource_uid === item.datasourceUid &&
          p.panel_id === String(item.id)
        );
      }).length !== 1
    )
      throw new DiscoveryError("workspace_bi_catalog_incomplete", 409);
  }
  return selected.map((row) => ({
    urn: row.urn,
    ...Object.fromEntries(
      aspects.map((name) => {
        const aspect = row[name];
        if (
          !object(aspect?.value) ||
          !/^[1-9][0-9]*$/.test(aspect.systemMetadata?.version ?? "")
        )
          throw new DiscoveryError("workspace_bi_catalog_incomplete", 409);
        return [
          name,
          { value: aspect.value, version: aspect.systemMetadata.version },
        ];
      }),
    ),
  }));
}

/** Preserve existing native metadata while preparing a conditional additive diff.
 * This is not an ownership/adoption exception in the Task publisher.
 */
export function mergeWorkspaceAspect(aspect, desired, current) {
  if (!object(desired) || (current !== undefined && !object(current)))
    throw new DiscoveryError(
      "discovery_publication_preservation_conflict",
      409,
    );
  if (current === undefined) return structuredClone(desired);
  const merged = structuredClone(current);
  const union = (left, right) => [
    ...new Set([...(left ?? []), ...(right ?? [])]),
  ];
  if (["dataFlowInfo", "dataJobInfo"].includes(aspect)) {
    for (const name of ["name", "type", "flowUrn", "env"]) {
      if (desired[name] === undefined) continue;
      // Native union values (e.g. type: { string: "COMMAND" }) are JSON
      // values, not shared object references after SDK/API serialization.
      if (
        current[name] !== undefined &&
        canonicalPublicationJson(current[name]) !==
          canonicalPublicationJson(desired[name])
      )
        throw new DiscoveryError(
          "discovery_publication_preservation_conflict",
          409,
        );
      merged[name] = desired[name];
    }
    merged.customProperties = {
      ...current.customProperties,
      ...desired.customProperties,
    };
  } else if (aspect === "dataJobInputOutput") {
    for (const [legacy, edge] of [
      ["inputDatasets", "inputDatasetEdges"],
      ["outputDatasets", "outputDatasetEdges"],
      ["inputDatajobs", "inputDatajobEdges"],
    ]) {
      const existing = new Set([
        ...(current[legacy] ?? []),
        ...(current[edge] ?? []).map((e) => e.destinationUrn),
      ]);
      const additions = (desired[legacy] ?? []).filter(
        (urn) => !existing.has(urn),
      );
      if (Object.hasOwn(current, edge))
        merged[edge] = [
          ...current[edge],
          ...additions.map((destinationUrn) => ({ destinationUrn })),
        ];
      else merged[legacy] = union(current[legacy], additions);
    }
  } else if (aspect === "upstreamLineage") {
    merged.upstreams = [...(current.upstreams ?? [])];
    for (const edge of desired.upstreams ?? [])
      if (!merged.upstreams.some((item) => item.dataset === edge.dataset))
        merged.upstreams.push(structuredClone(edge));
    merged.fineGrainedLineages = [...(current.fineGrainedLineages ?? [])];
    const identity = (edge) =>
      canonicalPublicationJson({
        upstreamType: edge.upstreamType,
        downstreamType: edge.downstreamType,
        upstreams: [...(edge.upstreams ?? [])].sort(),
        downstreams: [...(edge.downstreams ?? [])].sort(),
      });
    for (const edge of desired.fineGrainedLineages ?? [])
      if (
        !merged.fineGrainedLineages.some(
          (item) => identity(item) === identity(edge),
        )
      )
        merged.fineGrainedLineages.push(structuredClone(edge));
  } else
    throw new DiscoveryError(
      "discovery_publication_preservation_conflict",
      409,
    );
  return merged;
}

/** Host-only source compilation + native reads. No metadata writes or consent.
 * The existing Task publisher must still validate provenance, ACL and CAS.
 */
export async function prepareWorkspacePublication(
  policy,
  request,
  source,
  context,
) {
  const scopes = Object.fromEntries(
    Object.entries(request.connections).map(([id, scope]) => [
      id,
      policy.catalogScopes[scope],
    ]),
  );
  const catalog = await readDiscoveryCatalog(
    { pythonAnalysis: { scopesByConnection: scopes } },
    context,
  );
  const descriptorRequest = { ...request };
  delete descriptorRequest.connections;
  const descriptor = await analyzeWorkspace(policy, descriptorRequest);
  const relatedCatalog = await readWorkspaceBiCatalog(
    descriptor.relatedCatalogRequests,
    context,
  );
  const compiled = await compileWorkspacePublication(
    policy,
    request,
    catalog,
    relatedCatalog,
  );
  const cookie = datahubSessionCookie(context.cookieHeader);
  async function call(path, body) {
    context.assertActive();
    const response = await (context.fetchImpl ?? fetch)(
      new URL(path, context.frontendOrigin),
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        redirect: "manual",
        signal: AbortSignal.timeout(10000),
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new DiscoveryError("discovery_catalog_rejected");
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 1048576)
        throw new DiscoveryError("discovery_catalog_rejected");
      chunks.push(chunk);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (value.errors?.length)
      throw new DiscoveryError("discovery_catalog_rejected");
    context.assertActive();
    return value;
  }
  const groups = new Map();
  for (const item of compiled.aspects) {
    const kind = /^urn:li:(dataFlow|dataJob|dataset):/.exec(item.urn)?.[1];
    if (!kind) throw new DiscoveryError("discovery_publication_rejected", 409);
    if (!groups.has(kind)) groups.set(kind, new Map());
    const group = groups.get(kind);
    group.set(item.urn, {
      ...(group.get(item.urn) ?? { urn: item.urn }),
      [item.aspect]: {},
    });
  }
  const observed = new Map();
  for (const [kind, group] of groups) {
    for (const urn of group.keys()) {
      const value = await call("/api/v2/graphql", {
        query:
          "query($input:GetGrantedPrivilegesInput!){getGrantedPrivileges(input:$input){privileges}}",
        variables: {
          input: {
            actorUrn: context.actor.urn,
            resourceSpec: {
              resourceType: {
                dataFlow: "DATA_FLOW",
                dataJob: "DATA_JOB",
                dataset: "DATASET",
              }[kind],
              resourceUrn: urn,
            },
          },
        },
      });
      const grants = value.data?.getGrantedPrivileges?.privileges;
      if (
        !Array.isArray(grants) ||
        !grants.some((p) =>
          [
            "GET_ENTITY",
            "VIEW_ENTITY_PAGE",
            "EDIT_ENTITY",
            "CREATE_ENTITY",
          ].includes(p),
        )
      )
        throw new DiscoveryError("discovery_catalog_rejected");
    }
    const rows = await call(
      `/openapi/v3/entity/${kind.toLowerCase()}/batchGet?systemMetadata=true`,
      [...group.values()],
    );
    if (
      !Array.isArray(rows) ||
      new Set(rows.map((row) => row.urn)).size !== rows.length ||
      rows.some((row) => !group.has(row.urn) || observed.has(row.urn))
    )
      throw new DiscoveryError("discovery_catalog_rejected");
    for (const row of rows) observed.set(row.urn, row);
  }
  const changes = [],
    unchanged = [];
  for (const item of compiled.aspects) {
    const native = observed.get(item.urn)?.[item.aspect];
    if (
      native &&
      (!object(native.value) ||
        typeof native.systemMetadata?.version !== "string" ||
        !/^[1-9][0-9]*$/.test(native.systemMetadata.version))
    )
      throw new DiscoveryError("discovery_catalog_rejected");
    const valueJson = canonicalPublicationJson(
      mergeWorkspaceAspect(item.aspect, item.value, native?.value),
    );
    if (native && valueJson === canonicalPublicationJson(native.value))
      unchanged.push({ urn: item.urn, aspect: item.aspect });
    else
      changes.push({
        urn: item.urn,
        aspect: item.aspect,
        expectedVersion: native?.systemMetadata.version ?? "-1",
        valueJson,
      });
  }
  const identity = await call("/api/v2/graphql", {
    query: "query { me { corpUser { urn } } }",
  });
  if (identity.data?.me?.corpUser?.urn !== context.actor.urn)
    throw new DiscoveryError("discovery_identity_required");
  const review =
    changes.length && source !== undefined
      ? makePublicationReview({
          purpose: "LINEAGE",
          source,
          sourceId: compiled.sourceId,
          snapshotSha256: compiled.snapshotSha256,
          candidateDigest: compiled.candidateDigest,
          analysisVersion: compiled.analysisVersion,
          candidateIds: compiled.candidateIds,
          datasets: compiled.datasets,
          expiresAt: Date.now() + 600000,
          changes,
        })
      : null;
  return {
    format: "datahub-etl.native-diff/1",
    review,
    changes,
    unchanged,
    compiled,
    publicationAuthorized: false,
    complete: false,
    requiresTaskConsentAndCoverage: true,
    reviewRequiresSourceBinding: source === undefined,
  };
}

/** Prepare a same-chat import from intent only. Policy, Task scope and every
 * Aspect are resolved here; neither the browser nor the model supplies them.
 */
export async function prepareWorkspaceImport(input, context) {
  const request = parseRequest(JSON.stringify(input));
  const policy = context.discoverySources.find(
    (item) => item.sourceId === request.sourceId,
  );
  if (
    request.action !== "analyze_workspace" ||
    policy?.workspace !== true ||
    policy.modelContextApproved !== true ||
    !request.snapshotSha256 ||
    !request.connections ||
    !Object.keys(request.connections).length ||
    Object.values(request.connections).some(
      (id) => !Object.hasOwn(policy.catalogScopes, id),
    )
  )
    throw new DiscoveryError("workspace_import_not_ready", 409);
  request.selection = workspaceSelection(policy.root, request.selection);
  const prepared = await prepareWorkspacePublication(
    policy,
    request,
    undefined,
    context,
  );
  const eligible = context.sources.filter((source) =>
    prepared.compiled.datasets.every((dataset) =>
      source.taskDatasets?.includes(dataset),
    ),
  );
  if (eligible.length !== 1)
    throw new DiscoveryError(
      eligible.length
        ? "workspace_task_source_ambiguous"
        : "task_scope_not_approved",
      403,
    );
  const source = eligible[0].urn;
  const compiled = prepared.compiled;
  if (!prepared.changes.length)
    throw new DiscoveryError("workspace_no_changes", 409);
  const review = makePublicationReview({
    purpose: "LINEAGE",
    source,
    sourceId: compiled.sourceId,
    snapshotSha256: compiled.snapshotSha256,
    candidateDigest: compiled.candidateDigest,
    analysisVersion: compiled.analysisVersion,
    candidateIds: compiled.candidateIds,
    datasets: compiled.datasets,
    expiresAt: Date.now() + 600000,
    changes: prepared.changes,
  });
  return {
    review,
    request,
    recompilePublication: workspacePublicationCompiler(
      policy,
      request,
      source,
      context,
    ),
  };
}

/** Reconstitute only the compiler from the native Task's saved intent. Unlike
 * preparation, this never generates a new review/expiry or replaces consent.
 */
export function workspaceImportCompiler(input, source, context) {
  const request = parseRequest(JSON.stringify(input));
  const policy = context.discoverySources.find(
    (item) => item.sourceId === request.sourceId,
  );
  if (
    request.action !== "analyze_workspace" ||
    policy?.workspace !== true ||
    policy.modelContextApproved !== true ||
    !request.connections ||
    Object.values(request.connections).some(
      (id) => !Object.hasOwn(policy.catalogScopes, id),
    )
  )
    throw new DiscoveryError("workspace_import_not_ready", 409);
  request.selection = workspaceSelection(policy.root, request.selection);
  return workspacePublicationCompiler(policy, request, source, context);
}

/** Existing Task publisher callback for the complete workspace diff.
 * Selection/policy come from the Host's preparation, not the review JSON.
 * Re-capture source, native schemas, related declarations and target versions;
 * a subset, drift or already-changed target cannot reuse the prior consent.
 */
export function workspacePublicationCompiler(policy, request, source, context) {
  const fixedPolicy = structuredClone(policy),
    fixedRequest = structuredClone(request);
  return async (review, observedTargets) => {
    const checked = validatePublicationReview(review);
    if (
      checked.purpose !== "LINEAGE" ||
      checked.source !== source ||
      !(observedTargets instanceof Map)
    )
      throw new DiscoveryError("discovery_publication_rejected", 409);
    for (const change of checked.changes) {
      const native = observedTargets.get(change.urn)?.[change.aspect];
      if ((native?.systemMetadata?.version ?? "-1") !== change.expectedVersion)
        throw new DiscoveryError("discovery_source_drift", 409);
    }
    const prepared = await prepareWorkspacePublication(
      fixedPolicy,
      fixedRequest,
      undefined,
      context,
    );
    const compiled = prepared.compiled;
    if (
      ["sourceId", "snapshotSha256", "candidateDigest", "analysisVersion"].some(
        (key) => checked[key] !== compiled[key],
      ) ||
      canonicalPublicationJson([...checked.candidateIds].sort()) !==
        canonicalPublicationJson([...compiled.candidateIds].sort()) ||
      canonicalPublicationJson([...checked.datasets].sort()) !==
        canonicalPublicationJson([...compiled.datasets].sort()) ||
      canonicalPublicationJson(checked.changes) !==
        canonicalPublicationJson(prepared.changes)
    )
      throw new DiscoveryError("discovery_source_drift", 409);
    const proposal = { ...checked, changes: prepared.changes };
    delete proposal.planDigest;
    context.assertActive();
    return makePublicationReview(proposal);
  };
}

export async function compileDiscoveryPublication(policy, plan, catalog) {
  const payload = {
    operation: "compile_publication",
    policy,
    plan,
    ...(catalog === undefined ? {} : { catalog }),
  };
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > 131072)
    throw new DiscoveryError("discovery_policy_too_large", 409);
  const result = await invokeBridge(payload, 150000);
  if (
    result.format !== "dataflow-discovery.compiled-aspects/1" ||
    result.sourceId !== policy.sourceId ||
    result.snapshotSha256 !== policy.snapshotSha256 ||
    result.publicationAuthorized !== false ||
    !Array.isArray(result.aspects) ||
    !result.aspects.length ||
    result.aspects.length > 128
  )
    throw new DiscoveryError("discovery_publication_rejected", 409);
  return result;
}

/** Project table I/O onto a native value without replacing its edge evidence.
 * Existing relationships and every other field are retained. A removal or a
 * richer compiler output needs its own explicit handling, never a silent merge.
 * This is value preparation only, not ownership/adoption or write authority.
 */
export function preserveDiscoveryJobIO(desired, current) {
  const reject = () => {
    throw new DiscoveryError(
      "discovery_publication_preservation_conflict",
      409,
    );
  };
  if (!only(desired, ["inputDatasets", "outputDatasets"]) || !object(current))
    reject();
  const result = structuredClone(current);
  for (const side of ["input", "output"]) {
    const legacyKey = `${side}Datasets`,
      edgeKey = `${side}DatasetEdges`;
    const expected = desired[legacyKey];
    const legacy = Object.hasOwn(current, legacyKey) ? current[legacyKey] : [];
    const edges = Object.hasOwn(current, edgeKey) ? current[edgeKey] : [];
    if (
      !Array.isArray(expected) ||
      !Array.isArray(legacy) ||
      !Array.isArray(edges) ||
      [...expected, ...legacy].some((urn) => typeof urn !== "string") ||
      edges.some(
        (edge) => !object(edge) || typeof edge.destinationUrn !== "string",
      )
    )
      reject();
    const before = new Set([
      ...legacy,
      ...edges.map((edge) => edge.destinationUrn),
    ]);
    const wanted = new Set(expected);
    if ([...before].some((urn) => !wanted.has(urn))) reject();
    const additions = [...wanted].filter((urn) => !before.has(urn)).sort();
    if (!additions.length) continue;
    if (Object.hasOwn(current, edgeKey))
      result[edgeKey] = [
        ...result[edgeKey],
        ...additions.map((destinationUrn) => ({ destinationUrn })),
      ];
    else result[legacyKey] = [...legacy, ...additions];
  }
  return result;
}

/** Supply this callback only from the Host's trusted preparation path. The plan
 * and source binding are retained by value, never reconstructed from review JSON.
 * Every approved change must match a newly compiled MCP. Unselected initial SDK
 * Aspects remain untouched; this neither adopts them nor declares the full plan published.
 * Host still owns fresh Catalog identity resolution and public-metadata classification.
 */
export function discoveryPublicationCompiler(
  policy,
  plan,
  source,
  catalogContext,
) {
  const fixedPolicy = structuredClone(policy),
    fixedPlan = structuredClone(plan);
  return async (review, observedTargets) => {
    const checked = validatePublicationReview(review);
    if (checked.purpose !== "LINEAGE" || checked.source !== source)
      throw new DiscoveryError("discovery_publication_rejected", 409);
    if (fixedPolicy.pythonAnalysis && !catalogContext)
      throw new DiscoveryError("discovery_catalog_rejected", 409);
    const catalog = fixedPolicy.pythonAnalysis
      ? await readDiscoveryCatalog(fixedPolicy, catalogContext)
      : undefined;
    const compiled = await compileDiscoveryPublication(
      fixedPolicy,
      fixedPlan,
      catalog,
    );
    catalogContext?.assertActive();
    const fields = [
      "sourceId",
      "snapshotSha256",
      "candidateDigest",
      "analysisVersion",
    ];
    if (
      fields.some((key) => checked[key] !== compiled[key]) ||
      canonicalPublicationJson([...checked.candidateIds].sort()) !==
        canonicalPublicationJson([...compiled.candidateIds].sort()) ||
      canonicalPublicationJson([...checked.datasets].sort()) !==
        canonicalPublicationJson([...compiled.datasets].sort())
    )
      throw new DiscoveryError("discovery_publication_rejected", 409);
    const values = new Map();
    for (const item of compiled.aspects) {
      const key = `${item.urn}\n${item.aspect}`;
      if (values.has(key))
        throw new DiscoveryError("discovery_publication_rejected", 409);
      values.set(key, item.value);
    }
    const changes = checked.changes.map((change) => {
      let value = values.get(`${change.urn}\n${change.aspect}`);
      if (!value)
        throw new DiscoveryError("discovery_publication_rejected", 409);
      if (
        change.aspect === "dataJobInputOutput" &&
        change.expectedVersion !== "-1"
      ) {
        const current = observedTargets?.get(change.urn)?.[change.aspect];
        if (current?.systemMetadata?.version !== change.expectedVersion)
          throw new DiscoveryError("discovery_publication_rejected", 409);
        value = preserveDiscoveryJobIO(value, current.value);
      }
      const valueJson = canonicalPublicationJson(value);
      if (valueJson !== change.valueJson)
        throw new DiscoveryError("discovery_publication_rejected", 409);
      return { ...change, valueJson };
    });
    const proposal = { ...checked, changes };
    delete proposal.planDigest;
    return makePublicationReview(proposal);
  };
}

/** Fresh, fixed public read APIs. Catalog envelopes remain inside the Host;
 * Python receives no session cookie. This is neither source SQL nor an ingestion.
 */
export async function readDiscoveryCatalog(
  policy,
  { actor, frontendOrigin, cookieHeader, assertActive, fetchImpl = fetch },
) {
  const cookie = datahubSessionCookie(cookieHeader);
  const signal = AbortSignal.timeout(10000);
  async function call(path, body) {
    assertActive();
    try {
      const response = await fetchImpl(new URL(path, frontendOrigin), {
        method: "POST",
        redirect: "manual",
        signal,
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error();
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 1048576) throw new Error();
        chunks.push(chunk);
      }
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (value.errors?.length) throw new Error();
      assertActive();
      return value;
    } catch {
      throw new DiscoveryError("discovery_catalog_rejected");
    }
  }
  async function identity() {
    const value = await call("/api/v2/graphql", {
      query: "query { me { corpUser { urn } } }",
    });
    if (value.data?.me?.corpUser?.urn !== actor.urn)
      throw new DiscoveryError("discovery_identity_required");
  }
  await identity();
  const urns = [
    ...new Set(
      Object.values(
        Object.hasOwn(policy.pythonAnalysis, "scopesByConnection")
          ? policy.pythonAnalysis.scopesByConnection
          : policy.pythonAnalysis.scopesByContext,
      ).flatMap((scope) => scope.allowed_dataset_urns),
    ),
  ].sort();
  for (const urn of urns) {
    const value = await call("/api/v2/graphql", {
      query:
        "query($input:GetGrantedPrivilegesInput!){getGrantedPrivileges(input:$input){privileges}}",
      variables: {
        input: {
          actorUrn: actor.urn,
          resourceSpec: { resourceType: "DATASET", resourceUrn: urn },
        },
      },
    });
    const granted = value.data?.getGrantedPrivileges?.privileges;
    if (
      !Array.isArray(granted) ||
      !granted.some((p) =>
        ["GET_ENTITY", "VIEW_ENTITY_PAGE", "EDIT_ENTITY"].includes(p),
      )
    )
      throw new DiscoveryError("discovery_catalog_rejected");
  }
  const aspects = ["datasetKey", "status", "schemaMetadata"];
  const values = await call(
    "/openapi/v3/entity/dataset/batchGet?systemMetadata=true",
    urns.map((urn) => ({
      urn,
      ...Object.fromEntries(aspects.map((name) => [name, {}])),
    })),
  );
  if (!Array.isArray(values) || values.length !== urns.length)
    throw new DiscoveryError("discovery_catalog_rejected");
  const catalog = {};
  for (const item of values) {
    if (!urns.includes(item?.urn) || Object.hasOwn(catalog, item.urn))
      throw new DiscoveryError("discovery_catalog_rejected");
    const selected = {};
    for (const name of aspects) {
      const aspect = item[name];
      if (
        !object(aspect?.value) ||
        typeof aspect.systemMetadata?.version !== "string" ||
        !/^[1-9][0-9]*$/.test(aspect.systemMetadata.version)
      )
        throw new DiscoveryError("discovery_catalog_rejected");
      // Native versions and values bind pagination. Volatile read times and
      // unrelated systemMetadata must not invalidate otherwise unchanged pages.
      selected[name] = {
        value: aspect.value,
        version: aspect.systemMetadata.version,
      };
    }
    catalog[item.urn] = selected;
  }
  await identity();
  return catalog;
}

/** Fresh verified actor + active parent grant required; no cookies passed to Python. */
export async function nativeDiscovery(
  text,
  {
    actor,
    sources,
    assertActive,
    analyze = analyzeDiscovery,
    frontendOrigin,
    cookieHeader,
    fetchImpl = fetch,
  },
) {
  const request = parseRequest(text);
  assertActive();
  if (!actor?.key || !actor?.tenant || !actor?.urn || !Array.isArray(sources))
    throw new DiscoveryError("discovery_identity_required");
  if (request.action === "list_sources")
    return {
      requestId: request.requestId,
      sources: sources
        .filter((s) => s.workspace !== true)
        .map((s) => ({
          sourceId: s.sourceId,
          snapshotSha256: s.snapshotSha256,
          ...(s.pythonAnalysis
            ? { analysisKind: "python-field-declarations" }
            : {}),
        })),
      publicationAuthorized: false,
    };
  if (request.action === "list_workspaces")
    return {
      requestId: request.requestId,
      workspaces: sources
        .filter((s) => s.workspace === true)
        .map((s) => ({ sourceId: s.sourceId, root: s.root })),
      publicationAuthorized: false,
    };
  const policy = sources.find((source) => source.sourceId === request.sourceId);
  if (!policy || policy.modelContextApproved !== true)
    throw new DiscoveryError("discovery_source_not_authorized");
  if (request.action === "analyze_workspace") {
    if (policy.workspace !== true)
      throw new DiscoveryError("discovery_source_not_authorized");
    const selection = workspaceSelection(policy.root, request.selection);
    let catalog, relatedCatalog;
    if (request.connections !== undefined) {
      const scopes = {};
      for (const [connection, id] of Object.entries(request.connections)) {
        if (!Object.hasOwn(policy.catalogScopes, id))
          throw new DiscoveryError("workspace_scope_rejected");
        scopes[connection] = policy.catalogScopes[id];
      }
      if (Object.keys(scopes).length === 0)
        throw new DiscoveryError("workspace_scope_rejected");
      catalog = await readDiscoveryCatalog(
        { pythonAnalysis: { scopesByConnection: scopes } },
        { actor, frontendOrigin, cookieHeader, assertActive, fetchImpl },
      );
      const descriptorRequest = { ...request, selection };
      delete descriptorRequest.connections;
      const descriptor = await analyzeWorkspace(policy, descriptorRequest);
      relatedCatalog = await readWorkspaceBiCatalog(
        descriptor.relatedCatalogRequests,
        { actor, frontendOrigin, cookieHeader, assertActive, fetchImpl },
      );
    }
    const result = await analyzeWorkspace(
      policy,
      { ...request, selection },
      catalog,
      relatedCatalog,
    );
    if (result.nativePlan?.compiled === true) {
      const prepared = await prepareWorkspacePublication(
        policy,
        { ...request, selection },
        undefined,
        { actor, frontendOrigin, cookieHeader, assertActive, fetchImpl },
      );
      if (
        prepared.compiled.catalogDigest !== result.catalogDigest ||
        prepared.compiled.relatedCatalogDigest !== result.relatedCatalogDigest
      )
        throw new DiscoveryError("discovery_source_drift", 409);
      const targets = [
        ...new Set(
          [...prepared.changes, ...prepared.unchanged].map((item) => item.urn),
        ),
      ];
      result.nativePlan = {
        ...result.nativePlan,
        targets,
        changes: prepared.changes.map((item) => ({
          target: targets.indexOf(item.urn),
          aspect: item.aspect,
          expectedVersion: item.expectedVersion,
        })),
        unchanged: prepared.unchanged.map((item) => ({
          target: targets.indexOf(item.urn),
          aspect: item.aspect,
        })),
        diffDigest: createHash("sha256")
          .update(canonicalPublicationJson(prepared.changes))
          .digest("hex"),
        nativeMergeRequired: false,
        trustedConsentRequired: true,
      };
      result.blockers = result.blockers.map((item) =>
        item.reason === "native_merge_and_trusted_consent_required"
          ? {
              reason: "trusted_consent_and_task_publication_required",
              count: 1,
            }
          : item,
      );
    }
    assertActive();
    const response = {
      ...result,
      requestId: request.requestId,
      observedAt: new Date().toISOString(),
    };
    if (Buffer.byteLength(JSON.stringify(response)) > 60000)
      throw new DiscoveryError("discovery_workspace_too_large", 409);
    return response;
  }
  if (policy.workspace === true)
    throw new DiscoveryError("discovery_source_not_authorized");
  const catalog = policy.pythonAnalysis
    ? await readDiscoveryCatalog(policy, {
        actor,
        frontendOrigin,
        cookieHeader,
        assertActive,
        fetchImpl,
      })
    : undefined;
  const result = await analyze(policy, request, catalog);
  assertActive();
  return { ...result, requestId: request.requestId };
}

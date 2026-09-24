import { datahubSessionCookie } from "./datahub-identity.mjs";

/** Catalog queries run as the current DataHub browser actor, never the MCP service reader.
 * Fixed public GraphQL documents; no caller-controlled query, URL, credentials or mutations. */
export class CatalogError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.status = status;
  }
}
const fail = (code, status) => {
  throw new CatalogError(code, status);
};
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v, n = 2048) =>
  typeof v === "string" &&
  v.length > 0 &&
  v.length <= n &&
  !/[\x00-\x1f\x7f]/.test(v);
const types = Object.freeze({
  dataset: "DATASET",
  dataFlow: "DATA_FLOW",
  dataJob: "DATA_JOB",
  chart: "CHART",
  dashboard: "DASHBOARD",
  tag: "TAG",
  glossaryTerm: "GLOSSARY_TERM",
  domain: "DOMAIN",
  corpuser: "CORP_USER",
  corpGroup: "CORP_GROUP",
  schemaField: "SCHEMA_FIELD",
  container: "CONTAINER",
});
// Fixed native search indexes: GlobalTags, SchemaField, GlossaryTermAssociation,
// Owner and Domains in the pinned public datamodel. These are not inferred joins.
const associationFields = Object.freeze({
  TAG: ["tags", "fieldTags"],
  GLOSSARY_TERM: ["glossaryTerms", "fieldGlossaryTerms"],
  DOMAIN: ["domains"],
  CORP_USER: ["owners"],
  CORP_GROUP: ["owners"],
});
// Pinned native createBrowseV2SearchFilter uses the visible U+241F symbol.
const browseSeparator = "\u241f";
const routes = {
  DATASET: "dataset",
  DATA_FLOW: "dataFlow",
  DATA_JOB: "dataJob",
  CHART: "chart",
  DASHBOARD: "dashboard",
  TAG: "tag",
  GLOSSARY_TERM: "glossaryTerm",
  DOMAIN: "domain",
  CORP_USER: "user",
  CORP_GROUP: "group",
  CONTAINER: "container",
};
export function catalogPolicies(value = {}) {
  if (!object(value)) fail("catalog_configuration_invalid", 503);
  const policies = new Map();
  for (const [key, policy] of Object.entries(value)) {
    if (
      !/^[a-f0-9]{48}$/.test(key) ||
      !object(policy) ||
      policy.modelContextApproved !== true ||
      Object.keys(policy).some(
        (k) => !["modelContextApproved", "propertyNames"].includes(k),
      ) ||
      !Array.isArray(policy.propertyNames) ||
      policy.propertyNames.length > 100 ||
      policy.propertyNames.some((s) => !text(s, 128))
    )
      fail("catalog_configuration_invalid", 503);
    policies.set(key, { propertyNames: [...policy.propertyNames] });
  }
  return policies;
}
function entityType(urn, browseAncestor = false) {
  if (!text(urn) || !urn.startsWith("urn:li:")) return undefined;
  const kind = urn.slice(7, urn.indexOf(":", 7));
  if (Object.hasOwn(types, kind)) return types[kind];
  // A platform instance can be a native Browse V2 ancestor without becoming a
  // separately queryable Catalog entity. Its ACL is still checked below.
  return browseAncestor && kind === "dataPlatformInstance"
    ? "DATA_PLATFORM_INSTANCE"
    : undefined;
}
// Metadata URLs are data, not instructions to contact arbitrary hosts or endpoints.
// The pinned bootstrap contract puts built-in visual assets under assets/.
export function managedCatalogImageUrl(value, frontendOrigin) {
  if (!text(value)) return null;
  let origin, url;
  try {
    origin =
      frontendOrigin instanceof URL ? frontendOrigin : new URL(frontendOrigin);
    url = new URL(value, origin);
  } catch {
    return null;
  }
  if (
    url.origin !== origin.origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.startsWith("/assets/") ||
    url.pathname.includes("//") ||
    !/^\/assets\/[A-Za-z0-9._~/-]+\.(?:avif|gif|jpe?g|png|svg|webp)$/i.test(
      url.pathname,
    )
  )
    return null;
  return url.href;
}
function parse(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 8192)
    fail("invalid_catalog_request");
  let r;
  try {
    r = JSON.parse(raw);
  } catch {
    fail("invalid_catalog_request");
  }
  const allowed = {
    search: [
      "query",
      "types",
      "filters",
      "relatedTo",
      "browsePath",
      "offset",
      "limit",
    ],
    entity: ["urn", "offset", "limit", "fieldPath", "fieldQuery", "fieldSort"],
    lineage: ["urn", "direction", "offset", "limit"],
    fieldLineage: ["urn", "fieldPath", "direction", "offset", "limit"],
  };
  if (
    !object(r) ||
    !Object.hasOwn(allowed, r.action) ||
    Object.keys(r).some(
      (k) => !["action", "requestId", ...allowed[r.action]].includes(k),
    ) ||
    !text(r.requestId, 36) ||
    !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(r.requestId)
  )
    fail("invalid_catalog_request");
  r.offset ??= 0;
  r.limit ??= 10;
  if (
    !Number.isSafeInteger(r.offset) ||
    r.offset < 0 ||
    r.offset > 9900 ||
    !Number.isSafeInteger(r.limit) ||
    r.limit < 1 ||
    r.limit > 20
  )
    fail("invalid_catalog_pagination");
  if (r.action === "search") {
    if (
      !text(r.query, 512) ||
      (r.types !== undefined &&
        (!Array.isArray(r.types) ||
          !r.types.length ||
          r.types.length > 10 ||
          r.types.some(
            (t) => !Object.values(types).includes(t) || t === "SCHEMA_FIELD",
          )))
    )
      fail("invalid_catalog_search");
    if (
      r.browsePath !== undefined &&
      (!Array.isArray(r.browsePath) ||
        !r.browsePath.length ||
        r.browsePath.length > 20 ||
        r.browsePath.some((id) => !text(id) || id.includes(browseSeparator)))
    )
      fail("invalid_catalog_browse_path");
    if (
      r.relatedTo !== undefined &&
      !Object.hasOwn(associationFields, entityType(r.relatedTo))
    )
      fail("catalog_association_not_supported", 422);
    // Public SearchAcrossEntitiesInput + indexed DatasetKey/DataPlatformInstance fields.
    if (
      r.filters !== undefined &&
      (!object(r.filters) ||
        Object.entries(r.filters).some(
          ([field, value]) =>
            !["platform", "platformInstance", "origin"].includes(field) ||
            !text(value),
        ))
    )
      fail("invalid_catalog_search");
  } else if (!entityType(r.urn)) fail("invalid_catalog_entity");
  if (r.action === "entity") {
    if (
      (r.fieldPath !== undefined && !text(r.fieldPath)) ||
      (r.fieldQuery !== undefined && !text(r.fieldQuery, 512)) ||
      (r.fieldSort !== undefined && !["path", "type"].includes(r.fieldSort)) ||
      (r.fieldPath !== undefined &&
        (r.fieldQuery !== undefined || r.offset !== 0))
    )
      fail("invalid_catalog_field_request");
    if (
      (r.fieldPath !== undefined ||
        r.fieldQuery !== undefined ||
        r.fieldSort !== undefined) &&
      entityType(r.urn) !== "DATASET"
    )
      fail("catalog_schema_not_supported", 422);
  }
  if (
    r.action === "fieldLineage" &&
    (entityType(r.urn) !== "DATASET" || !text(r.fieldPath))
  )
    fail("invalid_catalog_field_request");
  if (
    ["lineage", "fieldLineage"].includes(r.action) &&
    !["UPSTREAM", "DOWNSTREAM"].includes(r.direction)
  )
    fail("invalid_catalog_direction");
  return r;
}
const overview = `urn type
  ... on Dataset { name lastIngested subTypes { typeNames } platform { urn name properties { displayName logoUrl } } dataPlatformInstance { urn instanceId properties { name } } properties { name description origin customProperties { key value } } editableProperties { description } browsePathV2 { path { name entity { urn type ... on Container { properties { name } subTypes { typeNames } } ... on DataPlatformInstance { instanceId instanceProperties: properties { name } } } } } }
  ... on Container { properties { name description } subTypes { typeNames } }
  ... on DataFlow { properties { name description } }
  ... on DataJob { properties { name description } }
  ... on Chart { properties { name description } }
  ... on Dashboard { properties { name description } }
  ... on Tag { properties { name description } }
  ... on GlossaryTerm { properties { name definition } }
  ... on Domain { properties { name description } }
  ... on CorpUser { username properties { displayName fullName title } editableProperties { displayName title aboutMe pictureLink } }
  ... on CorpGroup { name properties { displayName description } editableProperties { description pictureLink } }
  ... on SchemaFieldEntity { fieldPath parent { urn type } }`;
// Pinned public entity.graphql fields; these describe reads, never permissions.
const governanceReads = {
  DATASET: ["Dataset", ["Owner", "Tag", "Term", "Domain"]],
  CONTAINER: ["Container", ["Owner", "Tag", "Term", "Domain"]],
  DATA_FLOW: ["DataFlow", ["Owner", "Tag", "Term", "Domain"]],
  DATA_JOB: ["DataJob", ["Owner", "Tag", "Term", "Domain"]],
  CHART: ["Chart", ["Owner", "Tag", "Term", "Domain"]],
  DASHBOARD: ["Dashboard", ["Owner", "Tag", "Term", "Domain"]],
  TAG: ["Tag", ["Owner"]],
  GLOSSARY_TERM: ["GlossaryTerm", ["Owner", "Domain", "Tag"]],
  DOMAIN: ["Domain", ["Owner"]],
  CORP_USER: ["CorpUser", ["Tag"]],
  CORP_GROUP: ["CorpGroup", ["Owner"]],
  SCHEMA_FIELD: ["SchemaFieldEntity", ["Tag", "Term"]],
};
const governanceFields = {
  Owner:
    "ownership { owners { owner { ... on CorpUser { urn type } ... on CorpGroup { urn type } } } }",
  Tag: "tags { tags { tag { urn type } } }",
  Term: "glossaryTerms { terms { term { urn type } } }",
  Domain: "domain { domain { urn type } }",
};
const governance = Object.values(governanceReads)
  .map(
    ([type, kinds]) =>
      `... on ${type} { ${kinds.map((kind) => governanceFields[kind]).join(" ")} }`,
  )
  .join(" ");
const dataset = `... on Dataset {
  schemaMetadata { version createdAt fields { fieldPath label jsonPath nativeDataType type description nullable isPartOfKey isPartitioningKey recursive tags { tags { tag { urn type } } } glossaryTerms { terms { term { urn type } } } schemaFieldEntity { urn type } } }
  editableSchemaMetadata { editableSchemaFieldInfo { fieldPath description tags { tags { tag { urn type } } } glossaryTerms { terms { term { urn type } } } } }
}`;
const lineagePart = `lineage(input:$input) { start count total relationships { type degree createdOn updatedOn entity { urn type } } }`;
export const CATALOG_QUERIES = Object.freeze({
  identity: "query CatalogIdentity { me { corpUser { urn } } }",
  privileges:
    "query CatalogPrivileges($input:GetGrantedPrivilegesInput!){getGrantedPrivileges(input:$input){privileges}}",
  search:
    "query CatalogSearch($input:SearchAcrossEntitiesInput!){searchAcrossEntities(input:$input){start count total searchResults{entity{urn type}}}}",
  entity: `query CatalogEntity($urn:String!){entity(urn:$urn){${overview} ${dataset} ${governance}}}`,
  summary: `query CatalogSummary($urn:String!){entity(urn:$urn){${overview}}}`,
  fieldMetadata: `query CatalogFieldMetadata($urn:String!){entity(urn:$urn){urn type ... on SchemaFieldEntity { parent { urn } tags { tags { tag { urn type } } } glossaryTerms { terms { term { urn type } } } }}}`,
  // SchemaFieldRef.urn is a DATASET URN in this pinned API; path is separate.
  // Do not fetch query / transformOperation, which may contain sensitive SQL.
  fieldLineage: `query CatalogFieldLineage($urn:String!){entity(urn:$urn){${overview} ... on Dataset { schemaMetadata { fields { fieldPath schemaFieldEntity { urn type } } } fineGrainedLineages { upstreams { urn path } downstreams { urn path } } }}}`,
  lineage: `query CatalogLineage($urn:String!,$input:LineageInput!){entity(urn:$urn){urn type ${["Dataset", "DataFlow", "DataJob", "Chart", "Dashboard", "SchemaFieldEntity"].map((t) => `... on ${t} { ${lineagePart} }`).join(" ")}}}`,
});

export async function nativeCatalog(
  raw,
  {
    actor,
    frontendOrigin,
    cookieHeader,
    assertActive,
    propertyNames = [],
    fetchImpl = fetch,
  },
) {
  const r = parse(raw);
  if (!actor?.urn || !actor?.key || !actor?.tenant)
    fail("catalog_identity_required", 403);
  if (!Array.isArray(propertyNames) || propertyNames.some((s) => !text(s, 128)))
    fail("catalog_configuration_invalid", 503);
  let origin;
  try {
    origin = new URL(frontendOrigin);
  } catch {
    fail("catalog_configuration_invalid", 503);
  }
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    fail("catalog_configuration_invalid", 503);
  const cookie = datahubSessionCookie(cookieHeader);
  const signal = AbortSignal.timeout(20000);
  async function call(query, variables = {}) {
    assertActive();
    try {
      const response = await fetchImpl(new URL("/api/v2/graphql", origin), {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ query, variables }),
        redirect: "manual",
        signal,
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        fail(
          [401, 403].includes(response.status)
            ? "catalog_read_denied"
            : "catalog_unavailable",
          [401, 403].includes(response.status) ? 403 : 502,
        );
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 1048576) fail("catalog_response_too_large", 502);
        chunks.push(chunk);
      }
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (
        !object(value?.data) ||
        (value.errors !== undefined &&
          (!Array.isArray(value.errors) || value.errors.length))
      )
        fail("catalog_read_unavailable", 502);
      assertActive();
      return value.data;
    } catch (error) {
      if (error instanceof CatalogError) throw error;
      fail("catalog_unavailable", 502);
    }
  }
  const me = await call(CATALOG_QUERIES.identity);
  if (me.me?.corpUser?.urn !== actor.urn)
    fail("catalog_identity_required", 403);
  const permissions = new Map(); // Per-request only; never an ACL cache across requests/actors.
  async function canRead(urn, browseAncestor = false) {
    const type = entityType(urn, browseAncestor);
    if (!type) return false;
    if (!permissions.has(urn)) {
      const result = await call(CATALOG_QUERIES.privileges, {
        input: {
          actorUrn: actor.urn,
          resourceSpec: { resourceType: type, resourceUrn: urn },
        },
      });
      const p = result.getGrantedPrivileges?.privileges;
      permissions.set(
        urn,
        Array.isArray(p) &&
          p.some((s) => ["GET_ENTITY", "VIEW_ENTITY_PAGE"].includes(s)),
      );
    }
    return permissions.get(urn);
  }
  async function authorize(urn) {
    if (!(await canRead(urn))) fail("catalog_read_denied", 403);
  }
  const string = (v) => (typeof v === "string" ? v : null);
  async function project(e) {
    if (!e || !entityType(e.urn) || e.type !== entityType(e.urn))
      fail("catalog_invalid_response", 502);
    // A schema-field permission must never bypass its dataset permission.
    if (e.type === "SCHEMA_FIELD") {
      if (!e.parent || !(await canRead(e.parent.urn)))
        fail("catalog_read_denied", 403);
    }
    let browsePath = null;
    if (e.browsePathV2 != null) {
      const path = e.browsePathV2.path;
      if (!Array.isArray(path)) fail("catalog_invalid_response", 502);
      if (path.length > 20) fail("catalog_result_too_large", 502);
      browsePath = [];
      for (const entry of path) {
        if (!object(entry) || !text(entry.name))
          fail("catalog_invalid_response", 502);
        const linked = entry.entity;
        const linkedType = object(linked)
          ? entityType(linked.urn, true)
          : undefined;
        if (linked && (!linkedType || linkedType !== linked.type))
          fail("catalog_invalid_response", 502);
        // Omit the entire locator rather than leak a hidden ancestor or invent
        // a shortened prefix that would mean a different indexed scope.
        if (
          (linked && !(await canRead(linked.urn, true))) ||
          (!linked && entry?.name?.startsWith("urn:li:"))
        ) {
          browsePath = null;
          break;
        }
        // The public mapper exposes the indexed BrowsePathEntry.id as name.
        const id = entry.name;
        if (id.includes(browseSeparator) || (linked && id !== linked.urn))
          fail("catalog_invalid_response", 502);
        const subTypes = linked?.subTypes?.typeNames ?? [];
        if (
          !Array.isArray(subTypes) ||
          subTypes.some((type) => !text(type, 128))
        )
          fail("catalog_invalid_response", 502);
        browsePath.push({
          id,
          urn: linked?.urn ?? null,
          name: string(
            linkedType === "DATA_PLATFORM_INSTANCE"
              ? (linked.instanceProperties?.name ?? linked.instanceId)
              : linked
                ? linked.properties?.name
                : entry.name,
          ),
          subTypes,
        });
      }
    }
    const p = e.properties;
    const subTypes = e.subTypes?.typeNames ?? [];
    if (!Array.isArray(subTypes) || subTypes.some((type) => !text(type, 128)))
      fail("catalog_invalid_response", 502);
    const route = routes[e.type];
    return {
      urn: e.urn,
      type: e.type,
      subTypes,
      // Match pinned UserEntity.displayName using current public properties;
      // do not infer a full name from username or request deprecated info.
      name:
        string(
          e.type === "CORP_USER"
            ? e.editableProperties?.displayName ||
                p?.displayName ||
                p?.fullName ||
                e.username ||
                e.urn
            : (p?.name ?? p?.displayName ?? e.name ?? e.fieldPath),
        ) ?? e.urn,
      qualifiedName: string(e.type === "CORP_USER" ? e.username : e.name),
      description: string(
        e.type === "CORP_USER"
          ? e.editableProperties?.aboutMe
          : (e.editableProperties?.description ??
              p?.description ??
              p?.definition),
      ),
      profileTitle:
        e.type === "CORP_USER"
          ? string(e.editableProperties?.title || p?.title)
          : null,
      imageUrl: managedCatalogImageUrl(
        ["CORP_USER", "CORP_GROUP"].includes(e.type)
          ? e.editableProperties?.pictureLink
          : e.platform?.properties?.logoUrl,
        origin,
      ),
      platform: string(e.platform?.name),
      platformDisplayName: string(e.platform?.properties?.displayName),
      platformUrn: string(e.platform?.urn),
      platformInstance: string(
        e.dataPlatformInstance?.properties?.name ||
          e.dataPlatformInstance?.instanceId,
      ),
      platformInstanceUrn: string(e.dataPlatformInstance?.urn),
      environment: string(p?.origin),
      browsePath,
      ingestedAt: Number.isFinite(e.lastIngested) ? e.lastIngested : null,
      url: route
        ? new URL(`/${route}/${encodeURIComponent(e.urn)}`, origin).href
        : null,
      parentUrn: e.type === "SCHEMA_FIELD" ? e.parent.urn : null,
    };
  }
  async function summary(urn) {
    await authorize(urn);
    const { entity } = await call(CATALOG_QUERIES.summary, { urn });
    if (!entity || entity.urn !== urn) fail("catalog_read_denied", 403);
    return project(entity);
  }
  const common = {
    format: "datahub-catalog/1",
    requestId: r.requestId,
    action: r.action,
    readOnly: true,
    queriedAt: new Date().toISOString(),
    request: r,
    limitations: [
      "僅反映當前使用者可讀取、DataHub 已記錄的 metadata；不代表全域完整性或業務影響。",
      "只呈現 DataHub 管理的 /assets 圖片；外部 metadata 圖片網址不會由此檢視載入。",
    ],
  };
  function finish(value) {
    assertActive();
    const result = { ...common, ...value };
    if (Buffer.byteLength(JSON.stringify(result)) > 60000)
      fail("catalog_result_too_large", 502);
    return result;
  }
  function page(value) {
    if (
      !value ||
      !Number.isSafeInteger(value.start) ||
      value.start !== r.offset ||
      !Number.isSafeInteger(value.total) ||
      value.total < 0 ||
      !Number.isSafeInteger(value.count) ||
      value.count < 0 ||
      value.count > r.limit
    )
      fail("catalog_invalid_page", 502);
    // Never publish the unfiltered count/total: the native index may include unreadable entities.
    return {
      offset: r.offset,
      limit: r.limit,
      total: null,
      nextOffset:
        value.count > 0 &&
        r.offset + value.count < value.total &&
        r.offset + value.count <= 9900
          ? r.offset + value.count
          : null,
      completeness: "VISIBLE_PAGE_ONLY",
    };
  }
  async function lineagePage(urn) {
    const { entity } = await call(CATALOG_QUERIES.lineage, {
      urn,
      input: {
        direction: r.direction,
        start: r.offset,
        count: r.limit,
        separateSiblings: true,
        includeGhostEntities: false,
      },
    });
    if (entity?.urn !== urn) fail("catalog_read_denied", 403);
    const pagination = page(entity.lineage);
    if (
      !Array.isArray(entity.lineage.relationships) ||
      entity.lineage.relationships.length > r.limit
    )
      fail("catalog_invalid_response", 502);
    return { relationships: entity.lineage.relationships, pagination };
  }
  if (r.action === "search") {
    // The anchor must itself be readable on every page, before any asset search.
    const relatedTo =
      r.relatedTo === undefined ? undefined : await summary(r.relatedTo);
    const filters = Object.entries(r.filters ?? {}).map(([field, value]) => ({
      field,
      values: [value],
      condition: "EQUAL",
    }));
    if (r.browsePath) {
      for (const id of r.browsePath)
        if (id.startsWith("urn:li:")) await authorize(id);
      filters.push({
        field: "browsePathV2",
        values: [browseSeparator + r.browsePath.join(browseSeparator)],
        condition: "EQUAL",
      });
    }
    const orFilters = relatedTo
      ? associationFields[relatedTo.type].map((field) => ({
          and: [
            ...filters,
            { field, values: [relatedTo.urn], condition: "EQUAL" },
          ],
        }))
      : filters.length
        ? [{ and: filters }]
        : undefined;
    const result = (
      await call(CATALOG_QUERIES.search, {
        input: {
          query: r.query,
          types: r.types ?? [
            "DATASET",
            "DATA_FLOW",
            "DATA_JOB",
            "CHART",
            "DASHBOARD",
          ],
          ...(orFilters ? { orFilters } : {}),
          start: r.offset,
          count: r.limit,
        },
      })
    ).searchAcrossEntities;
    const pagination = page(result);
    if (
      !Array.isArray(result.searchResults) ||
      result.searchResults.length > r.limit
    )
      fail("catalog_invalid_response", 502);
    const entities = [];
    for (const row of result.searchResults)
      if (await canRead(row?.entity?.urn))
        entities.push(await summary(row.entity.urn));
    return finish({
      entities,
      pagination,
      ...(relatedTo
        ? {
            relatedTo,
            limitations: [
              ...common.limitations,
              "關聯依指定 URN 的原生搜尋索引；Tag／Term 包含資產及欄位標記，不從搜尋命中推定具體欄位。",
              "不展開子詞彙、子領域或群組繼承；索引可能延遲，只有本次可見頁，不保證所有關聯均已返回。",
            ],
          }
        : {}),
    });
  }
  await authorize(r.urn);
  if (r.action === "fieldLineage") {
    const datasets = new Map(); // One read only; no persisted schema/ACL cache.
    async function loadDataset(urn) {
      if (!datasets.has(urn)) {
        await authorize(urn);
        const { entity } = await call(CATALOG_QUERIES.fieldLineage, { urn });
        if (entity?.urn !== urn || entity.type !== "DATASET")
          fail("catalog_invalid_response", 502);
        if (
          entity.schemaMetadata?.fields != null &&
          !Array.isArray(entity.schemaMetadata.fields)
        )
          fail("catalog_invalid_response", 502);
        if (
          entity.fineGrainedLineages != null &&
          !Array.isArray(entity.fineGrainedLineages)
        )
          fail("catalog_invalid_response", 502);
        datasets.set(urn, { raw: entity, projected: await project(entity) });
      }
      return datasets.get(urn);
    }
    const center = await loadDataset(r.urn);
    const selected = center.raw.schemaMetadata?.fields?.find(
      (field) => field.fieldPath === r.fieldPath,
    );
    if (
      !selected ||
      entityType(selected.schemaFieldEntity?.urn) !== "SCHEMA_FIELD"
    )
      fail("catalog_field_unavailable", 404);
    await authorize(selected.schemaFieldEntity.urn);
    const groups = [];
    const side = r.direction === "UPSTREAM" ? "downstreams" : "upstreams";
    function matches(group) {
      if (!object(group)) fail("catalog_invalid_response", 502);
      for (const key of ["upstreams", "downstreams"]) {
        if (
          group?.[key] != null &&
          (!Array.isArray(group[key]) ||
            group[key].some(
              (ref) => entityType(ref?.urn) !== "DATASET" || !text(ref?.path),
            ))
        )
          fail("catalog_invalid_response", 502);
      }
      return group?.[side]?.some(
        (ref) => ref.urn === r.urn && ref.path === r.fieldPath,
      );
    }
    async function endpoint(ref) {
      if (!(await canRead(ref.urn))) return null;
      const dataset = await loadDataset(ref.urn);
      const field = dataset.raw.schemaMetadata?.fields?.find(
        (field) => field.fieldPath === ref.path,
      );
      const urn = field?.schemaFieldEntity?.urn;
      if (!urn || entityType(urn) !== "SCHEMA_FIELD" || !(await canRead(urn)))
        return null;
      return { dataset: dataset.projected, path: ref.path, urn };
    }
    async function appendGroup(group, recordedOn) {
      if (!group.upstreams?.length || !group.downstreams?.length) return;
      if (group.upstreams.length + group.downstreams.length > 100)
        fail("catalog_result_too_large", 502);
      const upstreams = [],
        downstreams = [];
      // A hidden/unresolved member removes the whole group, not just that input.
      for (const [refs, output] of [
        [group.upstreams, upstreams],
        [group.downstreams, downstreams],
      ]) {
        for (const ref of refs) {
          const field = await endpoint(ref);
          if (!field) return;
          output.push(field);
        }
      }
      groups.push({ recordedOn, upstreams, downstreams });
      if (groups.length > 20) fail("catalog_result_too_large", 502);
    }
    let pagination;
    if (r.direction === "UPSTREAM") {
      const matching = (center.raw.fineGrainedLineages ?? []).filter(matches);
      for (const group of matching.slice(r.offset, r.offset + r.limit))
        await appendGroup(group, center.projected);
      pagination = {
        offset: r.offset,
        limit: r.limit,
        total: null,
        nextOffset:
          r.offset + r.limit < matching.length && r.offset + r.limit <= 9900
            ? r.offset + r.limit
            : null,
        completeness: "VISIBLE_MAPPING_GROUP_PAGE",
      };
    } else {
      const candidates = await lineagePage(r.urn);
      pagination = {
        ...candidates.pagination,
        completeness: "VISIBLE_DOWNSTREAM_DATASET_PAGE",
      };
      for (const edge of candidates.relationships) {
        if (
          entityType(edge.entity?.urn) !== "DATASET" ||
          !(await canRead(edge.entity.urn))
        )
          continue;
        if (edge.degree !== 1 || !text(edge.type))
          fail("catalog_invalid_response", 502);
        const target = await loadDataset(edge.entity.urn);
        for (const group of (target.raw.fineGrainedLineages ?? []).filter(
          matches,
        ))
          await appendGroup(group, target.projected);
      }
    }
    return finish({
      entity: center.projected,
      fieldPath: r.fieldPath,
      direction: r.direction,
      groups,
      pagination,
      limitations: [
        ...common.limitations,
        "只呈現原生 fineGrainedLineages 群組；不由表級邊、名稱、Join 或相似欄位補造映射。",
        "每組保留公開 API 回傳的完整欄位輸入／輸出集合；原生 API 可能省略非欄位端點。任一欄位端點無法讀取或精確核對 schema，整組不輸出；空頁不表示沒有映射。",
        "上游按匹配群組分頁；下游按一層 Dataset 候選分頁，群組數不等於候選數。未遍歷所有下游，亦非一致性快照。",
        "未讀取原始 query／轉換 SQL；群組不是任意輸入輸出間的笛卡兒積，也不提供未記錄的觀測時間。",
      ],
    });
  }
  if (r.action === "entity") {
    const { entity: e } = await call(CATALOG_QUERIES.entity, { urn: r.urn });
    if (!e || e.urn !== r.urn) fail("catalog_read_denied", 403);
    const entity = await project(e);
    const references = [];
    const linked = [
      ...(e.ownership?.owners ?? []).map((v) => ["Owner", v.owner]),
      ...(e.tags?.tags ?? []).map((v) => ["Tag", v.tag]),
      ...(e.glossaryTerms?.terms ?? []).map((v) => ["Term", v.term]),
      ...(e.domain?.domain ? [["Domain", e.domain.domain]] : []),
    ];
    for (const [kind, ref] of linked.slice(0, 20))
      if (await canRead(ref?.urn))
        references.push({ kind, entity: await summary(ref.urn) });
    const all = e.schemaMetadata?.fields;
    const edits = new Map(
      (e.editableSchemaMetadata?.editableSchemaFieldInfo ?? []).map((f) => [
        f.fieldPath,
        f,
      ]),
    );
    if (all !== undefined && all !== null && !Array.isArray(all))
      fail("catalog_invalid_response", 502);
    const matching = (all ?? []).filter((f) => {
      if (r.fieldPath !== undefined) return f.fieldPath === r.fieldPath;
      if (r.fieldQuery !== undefined)
        return [f.fieldPath, f.nativeDataType, f.type].some(
          (v) =>
            typeof v === "string" &&
            v.toLocaleLowerCase().includes(r.fieldQuery.toLocaleLowerCase()),
        );
      return true;
    });
    if (r.fieldPath !== undefined && matching.length !== 1)
      fail("catalog_field_unavailable", 404);
    if (r.fieldSort)
      matching.sort((a, b) => {
        const left = r.fieldSort === "type" ? a.nativeDataType : a.fieldPath;
        const right = r.fieldSort === "type" ? b.nativeDataType : b.fieldPath;
        return (
          String(left ?? "").localeCompare(String(right ?? "")) ||
          a.fieldPath.localeCompare(b.fieldPath)
        );
      });
    const fields = [];
    for (const f of matching.slice(r.offset, r.offset + r.limit)) {
      let urn = null;
      if (f.schemaFieldEntity?.urn && (await canRead(f.schemaFieldEntity.urn)))
        urn = f.schemaFieldEntity.urn;
      const edited = edits.get(f.fieldPath);
      const fieldReferences = [];
      let referenceTruncated = false;
      if (urn) {
        const { entity: direct } = await call(CATALOG_QUERIES.fieldMetadata, {
          urn,
        });
        if (
          direct?.urn !== urn ||
          direct.type !== "SCHEMA_FIELD" ||
          direct.parent?.urn !== r.urn
        )
          fail("catalog_invalid_response", 502);
        const candidates = new Map();
        for (const [source, metadata] of [
          ["SCHEMA_METADATA", f],
          ["EDITABLE_SCHEMA", edited],
          ["SCHEMA_FIELD_ENTITY", direct],
        ]) {
          for (const [kind, refs] of [
            ["Tag", metadata?.tags?.tags?.map((item) => item.tag) ?? []],
            [
              "Term",
              metadata?.glossaryTerms?.terms?.map((item) => item.term) ?? [],
            ],
          ]) {
            for (const ref of refs) {
              const key = `${kind}:${ref?.urn}`;
              const existing = candidates.get(key);
              if (existing) {
                if (!existing.sources.includes(source))
                  existing.sources.push(source);
              } else candidates.set(key, { kind, ref, sources: [source] });
            }
          }
        }
        referenceTruncated = candidates.size > 20;
        for (const { kind, ref, sources } of [...candidates.values()].slice(
          0,
          20,
        )) {
          if (await canRead(ref?.urn))
            fieldReferences.push({
              kind,
              entity: await summary(ref.urn),
              sources,
            });
        }
      }
      fields.push({
        path: f.fieldPath,
        label: string(f.label),
        jsonPath: string(f.jsonPath),
        partitionKey:
          typeof f.isPartitioningKey === "boolean" ? f.isPartitioningKey : null,
        recursive: typeof f.recursive === "boolean" ? f.recursive : null,
        sourceDescription: string(f.description),
        editedDescription: string(edited?.description),
        references: fieldReferences,
        referenceTruncated,
        nativeType: string(f.nativeDataType),
        type: string(f.type),
        description: string(edited?.description ?? f.description),
        nullable: typeof f.nullable === "boolean" ? f.nullable : null,
        key: typeof f.isPartOfKey === "boolean" ? f.isPartOfKey : null,
        urn,
      });
    }
    const properties = (e.properties?.customProperties ?? [])
      .filter((p) => propertyNames.includes(p.key))
      .map((p) => ({ name: p.key, value: p.value }));
    return finish({
      entity,
      fields,
      references,
      referenceKinds: governanceReads[entity.type][1],
      properties,
      schemaFieldCount: Array.isArray(all) ? all.length : null,
      schemaVersion: e.schemaMetadata?.version ?? null,
      schemaCreatedAt: e.schemaMetadata?.createdAt ?? null,
      pagination: {
        offset: r.offset,
        limit: r.limit,
        total: Array.isArray(all) ? matching.length : null,
        nextOffset:
          Array.isArray(all) &&
          r.offset + r.limit < matching.length &&
          r.offset + r.limit <= 9900
            ? r.offset + r.limit
            : null,
        completeness: Array.isArray(all) ? "SCHEMA_PAGE" : "NOT_RECORDED",
      },
      limitations: [
        ...common.limitations,
        "資產關聯與各欄位治理項目最多各讀取 20 項；未取得 schema 不等於沒有欄位。",
        "欄位治理分列 SchemaMetadata、精確 path 的 EditableSchemaMetadata、可讀 SchemaFieldEntity；不推測 v1/v2 等價 path 或 Business Attribute 繼承。空清單不等於不存在。",
        "描述分列來源 schema 與精確 path 的可編輯 metadata；未讀 Documentation aspect、推斷或傳播描述。原生 API 預設布林值不等於已對來源 SQL 重新驗證。",
        "自訂屬性只顯示部署端明確允許的名稱；不提供原始 Aspect、SQL 或憑證。",
      ],
    });
  }
  const center = await summary(r.urn);
  if (
    ![
      "DATASET",
      "DATA_FLOW",
      "DATA_JOB",
      "CHART",
      "DASHBOARD",
      "SCHEMA_FIELD",
    ].includes(center.type)
  )
    fail("catalog_lineage_not_supported", 422);
  const { relationships, pagination } = await lineagePage(r.urn);
  const edges = [];
  for (const edge of relationships) {
    if (!(await canRead(edge.entity?.urn))) continue;
    if (edge.degree !== 1 || !text(edge.type))
      fail("catalog_invalid_response", 502);
    const related = await summary(edge.entity.urn);
    edges.push({
      related,
      relationship: edge.type,
      degree: edge.degree,
      from: r.direction === "UPSTREAM" ? related.urn : r.urn,
      to: r.direction === "UPSTREAM" ? r.urn : related.urn,
      createdAt: edge.createdOn ?? null,
      updatedAt: edge.updatedOn ?? null,
    });
  }
  return finish({
    entity: center,
    direction: r.direction,
    edges,
    pagination,
    ...(center.type === "SCHEMA_FIELD"
      ? {
          limitations: [
            ...common.limitations,
            "此為 schemaField 實體關係圖，不等同 Dataset 的 fineGrainedLineages；空結果不能否定已記錄欄位映射。請以 Dataset 與精確 fieldPath 查詢欄位群組。",
          ],
        }
      : {}),
  });
}

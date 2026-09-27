import { datahubSessionCookie } from "./datahub-identity.mjs";
import { CATALOG_QUERIES } from "./native-catalog.mjs";

export class QueryError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.status = status;
  }
}
export const rejectQuery = (code, status) => {
  throw new QueryError(code, status);
};
export const isRecord = (x) =>
  x !== null && typeof x === "object" && !Array.isArray(x);
export const exactKeys = (x, required, optional = []) =>
  isRecord(x) &&
  required.every((k) => Object.hasOwn(x, k)) &&
  Object.keys(x).every((k) => [...required, ...optional].includes(k));
export const queryUuid = (x) =>
  typeof x === "string" &&
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
export const datasetUrn = (x) =>
  typeof x === "string" && /^urn:li:dataset:[^\x00-\x1f\x7f]{1,1000}$/.test(x);
const QUERY_SCHEMA =
  "query QuerySchema($urn:String!){entity(urn:$urn){urn type ... on Dataset{platform{name} dataPlatformInstance{urn} properties{origin} schemaMetadata{version fields{fieldPath nativeDataType type schemaFieldEntity{urn}}}}}}";

// Public DatasetKey URN is (platform URN, name, environment). Dataset.name is
// only a display label, and properties.qualifiedName is optional. Keep the
// name component verbatim (case, encoded characters and instance prefix),
// matching the public SDK's three-component key; never decode or guess a name.
function datasetKey(urn) {
  const match =
    /^urn:li:dataset:\(urn:li:dataPlatform:([^,()]+),([^,()]+),([^,()]+)\)$/.exec(
      urn,
    );
  if (!match) rejectQuery("query_metadata_identity_mismatch", 422);
  return { platform: match[1], qualifiedName: match[2], environment: match[3] };
}

/** Only DataHub's current visibility decision grants a query. No actor grant
 * list, special Chart/Panel 5 or extra source SELECT approval is consulted. */
export function queryMetadataReader({ frontendOrigin, fetchImpl = fetch }) {
  let origin;
  try {
    origin = new URL(frontendOrigin);
  } catch {
    throw new Error("query_configuration_invalid");
  }
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new Error("query_configuration_invalid");
  return async (urns, context) => {
    if (
      !Array.isArray(urns) ||
      !urns.length ||
      urns.length > 8 ||
      urns.some((u) => !datasetUrn(u)) ||
      new Set(urns).size !== urns.length
    )
      rejectQuery("query_invalid_request");
    if (!context.actor?.urn || !context.actor?.key || !context.actor?.tenant)
      rejectQuery("query_identity_required", 403);
    let cookie;
    try {
      cookie = datahubSessionCookie(context.cookieHeader);
    } catch {
      rejectQuery("query_identity_required", 403);
    }
    const signal = AbortSignal.any([
      AbortSignal.timeout(20000),
      ...(context.signal ? [context.signal] : []),
    ]);
    async function call(query, variables = {}) {
      context.assertActive();
      try {
        const response = await fetchImpl(new URL("/api/v2/graphql", origin), {
          method: "POST",
          redirect: "manual",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({ query, variables }),
          signal,
        });
        if ([401, 403].includes(response.status))
          rejectQuery("query_metadata_denied", 403);
        if (!response.ok || !response.body)
          rejectQuery("query_metadata_unavailable", 502);
        const reader = response.body.getReader(),
          chunks = [];
        let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 1048576) {
              await reader.cancel();
              rejectQuery("query_metadata_too_large", 502);
            }
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (
          !isRecord(body.data) ||
          (body.errors !== undefined &&
            (!Array.isArray(body.errors) || body.errors.length))
        )
          rejectQuery("query_metadata_unavailable", 502);
        context.assertActive();
        return body.data;
      } catch (error) {
        if (error instanceof QueryError) throw error;
        rejectQuery("query_metadata_unavailable", 502);
      }
    }
    const me = await call(CATALOG_QUERIES.identity);
    if (me.me?.corpUser?.urn !== context.actor.urn)
      rejectQuery("query_identity_required", 403);
    const visible = async (urn, type) => {
      const data = await call(CATALOG_QUERIES.privileges, {
        input: {
          actorUrn: context.actor.urn,
          resourceSpec: { resourceType: type, resourceUrn: urn },
        },
      });
      return (
        Array.isArray(data.getGrantedPrivileges?.privileges) &&
        data.getGrantedPrivileges.privileges.some((p) =>
          ["GET_ENTITY", "VIEW_ENTITY_PAGE"].includes(p),
        )
      );
    };
    const snapshots = [];
    for (const urn of urns) {
      if (!(await visible(urn, "DATASET")))
        rejectQuery("query_metadata_denied", 403);
      const { entity: e } = await call(QUERY_SCHEMA, { urn });
      if (e?.urn !== urn || e.type !== "DATASET")
        rejectQuery("query_metadata_denied", 403);
      const raw = e.schemaMetadata?.fields;
      if (
        !Array.isArray(raw) ||
        !raw.length ||
        raw.length > 4096 ||
        typeof e.platform?.name !== "string" ||
        typeof e.properties?.origin !== "string"
      )
        rejectQuery("query_schema_unavailable", 422);
      const key = datasetKey(e.urn);
      if (
        key.platform !== e.platform.name ||
        key.environment !== e.properties.origin
      )
        rejectQuery("query_metadata_identity_mismatch", 422);
      // Full schema is Host-only. Field visibility is checked only for columns
      // actually referenced, including JOIN, WHERE, grouping and projection.
      snapshots.push({
        urn,
        qualifiedName: key.qualifiedName,
        platform: key.platform,
        platformInstanceUrn: e.dataPlatformInstance?.urn ?? null,
        environment: key.environment,
        schemaVersion: e.schemaMetadata.version,
        fields: raw.map((f) => ({
          path: f.fieldPath,
          nativeType: f.nativeDataType,
          type: f.type,
          urn: f.schemaFieldEntity?.urn ?? null,
        })),
      });
    }
    return { snapshots, visible };
  };
}

export function referencedFields(plan) {
  if (
    !isRecord(plan) ||
    !Array.isArray(plan.datasets) ||
    !Array.isArray(plan.select) ||
    !Array.isArray(plan.filters) ||
    !Array.isArray(plan.joins)
  )
    rejectQuery("query_invalid_request");
  const refs = [
    ...plan.select.map((x) => x?.field).filter((x) => x !== null),
    ...plan.filters.map((x) => x?.field),
  ];
  for (const join of plan.joins) {
    if (!Array.isArray(join?.on)) rejectQuery("query_invalid_request");
    for (const p of join.on) refs.push(p?.left, p?.right);
  }
  if (
    refs.length > 320 ||
    refs.some(
      (r) =>
        !exactKeys(r, ["dataset", "field"]) ||
        typeof r.dataset !== "string" ||
        typeof r.field !== "string",
    )
  )
    rejectQuery("query_invalid_request");
  return refs;
}

export async function authorizeQueryMetadata(plan, reader, context) {
  if (
    !Array.isArray(plan?.datasets) ||
    !plan.datasets.length ||
    plan.datasets.length > 8 ||
    plan.datasets.some(
      (d) =>
        !exactKeys(d, ["urn", "alias"]) ||
        !datasetUrn(d.urn) ||
        typeof d.alias !== "string" ||
        !/^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(d.alias),
    ) ||
    new Set(plan.datasets.map((d) => d.alias.toLowerCase())).size !==
      plan.datasets.length
  )
    rejectQuery("query_invalid_request");
  const { snapshots, visible } = await reader(
    [...new Set(plan.datasets.map((d) => d.urn))],
    context,
  );
  const fields = referencedFields(plan),
    checked = new Set();
  for (const ref of fields) {
    const urn = plan.datasets.find((d) => d.alias === ref.dataset)?.urn;
    const field = snapshots
      .find((s) => s.urn === urn)
      ?.fields.find((f) => f.path === ref.field);
    if (!field) rejectQuery("query_field_unavailable", 422);
    if (field.urn && !checked.has(field.urn)) {
      if (!(await visible(field.urn, "SCHEMA_FIELD")))
        rejectQuery("query_metadata_denied", 403);
      checked.add(field.urn);
    }
  }
  context.assertActive();
  return snapshots;
}

/** First-party presentation contract, not an authorization token. */
export type CatalogReference = {
  urn: string;
  name: string;
  fieldPath?: string;
};
export type CatalogRequest = {
  action: "search" | "entity" | "lineage" | "fieldLineage";
  requestId?: string;
  query?: string;
  urn?: string;
  types?: string[];
  relatedTo?: string;
  browsePath?: string[];
  filters?: Partial<Record<"platform" | "platformInstance" | "origin", string>>;
  fieldPath?: string;
  fieldQuery?: string;
  fieldSort?: "path" | "type";
  direction?: "UPSTREAM" | "DOWNSTREAM";
  offset?: number;
  limit?: number;
};
export type CatalogBrowseEntry = {
  id: string;
  urn: string | null;
  name: string | null;
  subTypes: string[];
};
export type CatalogEntity = {
  urn: string;
  type: string;
  subTypes?: string[];
  name: string;
  qualifiedName: string | null;
  description: string | null;
  platform: string | null;
  imageUrl?: string | null;
  platformDisplayName?: string | null;
  profileTitle?: string | null;
  platformUrn: string | null;
  platformInstance?: string | null;
  platformInstanceUrn: string | null;
  environment: string | null;
  browsePath?: CatalogBrowseEntry[] | null;
  ingestedAt: number | null;
  url: string | null;
  parentUrn: string | null;
};
export type CatalogFieldSource =
  | "SCHEMA_METADATA"
  | "EDITABLE_SCHEMA"
  | "SCHEMA_FIELD_ENTITY";
export type CatalogField = {
  path: string;
  label?: string | null;
  jsonPath?: string | null;
  partitionKey?: boolean | null;
  recursive?: boolean | null;
  sourceDescription?: string | null;
  editedDescription?: string | null;
  references?: {
    kind: "Tag" | "Term";
    entity: CatalogEntity;
    sources: CatalogFieldSource[];
  }[];
  referenceTruncated?: boolean;
  nativeType: string | null;
  type: string | null;
  description: string | null;
  nullable: boolean | null;
  key: boolean | null;
  urn: string | null;
};
export type CatalogFieldEndpoint = {
  dataset: CatalogEntity;
  path: string;
  urn: string;
};
export type CatalogFieldGroup = {
  recordedOn: CatalogEntity;
  upstreams: CatalogFieldEndpoint[];
  downstreams: CatalogFieldEndpoint[];
};
export type CatalogEdge = {
  related: CatalogEntity;
  relationship: string;
  degree: number;
  from: string;
  to: string;
  createdAt: number | null;
  updatedAt: number | null;
};
export type CatalogResult = {
  format: "datahub-catalog/1";
  requestId: string;
  action: CatalogRequest["action"];
  readOnly: true;
  queriedAt: string;
  request: CatalogRequest;
  limitations: string[];
  entity?: CatalogEntity;
  entities?: CatalogEntity[];
  relatedTo?: CatalogEntity;
  fields?: CatalogField[];
  references?: { kind: string; entity: CatalogEntity }[];
  referenceKinds?: ("Owner" | "Tag" | "Term" | "Domain")[];
  properties?: { name: string; value: string }[];
  schemaFieldCount?: number | null;
  schemaVersion?: number | null;
  schemaCreatedAt?: number | null;
  direction?: "UPSTREAM" | "DOWNSTREAM";
  edges?: CatalogEdge[];
  fieldPath?: string;
  groups?: CatalogFieldGroup[];
  pagination: {
    offset: number;
    limit: number;
    total: number | null;
    nextOffset: number | null;
    completeness: string;
  };
};
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const string = (v: unknown): v is string => typeof v === "string";
const nullableString = (v: unknown) => v === null || string(v);
const integer = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const stamp = (v: unknown) =>
  v === null || (integer(v) && v <= 8640000000000000);
const nullableBool = (v: unknown) => v === null || typeof v === "boolean";
const nativeRoutes: Record<string, string> = {
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
function nativeEntityUrl(value: unknown) {
  if (!record(value)) return false;
  const v = value;
  if (v.url === null) return true;
  if (!string(v.url) || !Object.hasOwn(nativeRoutes, String(v.type)))
    return false;
  try {
    const url = new URL(v.url);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname ===
        `/${nativeRoutes[String(v.type)]}/${encodeURIComponent(String(v.urn))}`
    );
  } catch {
    return false;
  }
}
const entity = (v: unknown) =>
  record(v) &&
  string(v.urn) &&
  v.urn.startsWith("urn:li:") &&
  string(v.type) &&
  (v.subTypes === undefined ||
    (Array.isArray(v.subTypes) && v.subTypes.every(string))) &&
  string(v.name) &&
  nullableString(v.qualifiedName) &&
  nullableString(v.description) &&
  nullableString(v.platform) &&
  (v.imageUrl === undefined || nullableString(v.imageUrl)) &&
  (v.platformDisplayName === undefined ||
    nullableString(v.platformDisplayName)) &&
  (v.profileTitle === undefined || nullableString(v.profileTitle)) &&
  nullableString(v.platformUrn) &&
  (v.platformInstance === undefined || nullableString(v.platformInstance)) &&
  nullableString(v.platformInstanceUrn) &&
  nullableString(v.environment) &&
  (v.browsePath === undefined ||
    v.browsePath === null ||
    (Array.isArray(v.browsePath) &&
      v.browsePath.length <= 20 &&
      v.browsePath.every(
        (entry) =>
          record(entry) &&
          string(entry.id) &&
          nullableString(entry.urn) &&
          nullableString(entry.name) &&
          Array.isArray(entry.subTypes) &&
          entry.subTypes.every(string),
      ))) &&
  stamp(v.ingestedAt) &&
  nativeEntityUrl(v) &&
  nullableString(v.parentUrn);
export function catalogNativeUrl(
  value: CatalogEntity,
  tab?: string,
  fieldPath?: string,
) {
  if (!nativeEntityUrl(value) || !value.url) return null;
  try {
    const url = new URL(value.url);
    if (tab === "schema" && value.type === "DATASET") {
      url.pathname = `${url.pathname.replace(/\/$/, "")}/Columns`;
      if (fieldPath) url.searchParams.set("highlightedPath", fieldPath);
    } else if (
      tab === "lineage" &&
      [
        "DATASET",
        "DATA_FLOW",
        "DATA_JOB",
        "CHART",
        "DASHBOARD",
        "SCHEMA_FIELD",
      ].includes(value.type)
    ) {
      url.pathname = `${url.pathname.replace(/\/$/, "")}/Lineage`;
    }
    return url.href;
  } catch {
    return null;
  }
}
export function isCatalogResult(v: unknown): v is CatalogResult {
  try {
    if (new TextEncoder().encode(JSON.stringify(v)).length > 60000)
      return false;
  } catch {
    return false;
  }
  if (
    !record(v) ||
    v.format !== "datahub-catalog/1" ||
    v.readOnly !== true ||
    !string(v.requestId) ||
    !string(v.queriedAt) ||
    !Number.isFinite(Date.parse(v.queriedAt)) ||
    !record(v.request) ||
    v.request.action !== v.action ||
    v.request.requestId !== v.requestId ||
    !["search", "entity", "lineage", "fieldLineage"].includes(
      String(v.action),
    ) ||
    !Array.isArray(v.limitations) ||
    !v.limitations.every(string) ||
    !record(v.pagination)
  )
    return false;
  const p = v.pagination;
  if (
    !integer(p.offset) ||
    !integer(p.limit) ||
    p.limit < 1 ||
    p.limit > 20 ||
    !(p.total === null || integer(p.total)) ||
    !(
      p.nextOffset === null ||
      (integer(p.nextOffset) && p.nextOffset > p.offset)
    ) ||
    !string(p.completeness)
  )
    return false;
  if (v.action === "search")
    return (
      string(v.request.query) &&
      Array.isArray(v.entities) &&
      v.entities.length <= p.limit &&
      v.entities.every(entity) &&
      (v.request.relatedTo === undefined
        ? v.relatedTo === undefined
        : string(v.request.relatedTo) &&
          entity(v.relatedTo) &&
          record(v.relatedTo) &&
          v.relatedTo.urn === v.request.relatedTo)
    );
  if (!entity(v.entity) || !record(v.entity) || v.entity.urn !== v.request.urn)
    return false;
  const requestUrn = v.request.urn;
  if (v.action === "fieldLineage") {
    const endpoint = (field: unknown) =>
      record(field) &&
      entity(field.dataset) &&
      record(field.dataset) &&
      field.dataset.type === "DATASET" &&
      string(field.path) &&
      string(field.urn) &&
      field.urn.startsWith("urn:li:schemaField:");
    const side = v.direction === "UPSTREAM" ? "downstreams" : "upstreams";
    return (
      v.entity.type === "DATASET" &&
      string(v.fieldPath) &&
      v.fieldPath === v.request.fieldPath &&
      ["UPSTREAM", "DOWNSTREAM"].includes(String(v.direction)) &&
      v.direction === v.request.direction &&
      Array.isArray(v.groups) &&
      v.groups.length <= 20 &&
      v.groups.every((group) => {
        if (
          !record(group) ||
          !entity(group.recordedOn) ||
          !record(group.recordedOn) ||
          group.recordedOn.type !== "DATASET" ||
          !Array.isArray(group.upstreams) ||
          !Array.isArray(group.downstreams) ||
          !group.upstreams.length ||
          !group.downstreams.length ||
          group.upstreams.length + group.downstreams.length > 100 ||
          !group.upstreams.every(endpoint) ||
          !group.downstreams.every(endpoint)
        )
          return false;
        return (
          (v.direction !== "UPSTREAM" || group.recordedOn.urn === requestUrn) &&
          (group[side] as Record<string, unknown>[]).some(
            (field) =>
              record(field.dataset) &&
              field.dataset.urn === requestUrn &&
              field.path === v.fieldPath,
          )
        );
      })
    );
  }
  if (v.action === "lineage")
    return (
      ["UPSTREAM", "DOWNSTREAM"].includes(String(v.direction)) &&
      v.direction === v.request.direction &&
      Array.isArray(v.edges) &&
      v.edges.length <= p.limit &&
      v.edges.every(
        (e) =>
          record(e) &&
          entity(e.related) &&
          string(e.relationship) &&
          e.degree === 1 &&
          record(e.related) &&
          e.from ===
            (v.direction === "UPSTREAM" ? e.related.urn : requestUrn) &&
          e.to === (v.direction === "UPSTREAM" ? requestUrn : e.related.urn) &&
          stamp(e.createdAt) &&
          stamp(e.updatedAt),
      )
    );
  return (
    Array.isArray(v.fields) &&
    v.fields.length <= p.limit &&
    v.fields.every(
      (f) =>
        record(f) &&
        string(f.path) &&
        nullableString(f.nativeType) &&
        nullableString(f.type) &&
        nullableString(f.description) &&
        nullableString(f.urn) &&
        nullableBool(f.nullable) &&
        nullableBool(f.key) &&
        ["label", "jsonPath", "sourceDescription", "editedDescription"].every(
          (key) => f[key] === undefined || nullableString(f[key]),
        ) &&
        ["partitionKey", "recursive"].every(
          (key) => f[key] === undefined || nullableBool(f[key]),
        ) &&
        (f.referenceTruncated === undefined ||
          typeof f.referenceTruncated === "boolean") &&
        (f.references === undefined ||
          (Array.isArray(f.references) &&
            f.references.length <= 20 &&
            f.references.every(
              (ref) =>
                record(ref) &&
                ["Tag", "Term"].includes(String(ref.kind)) &&
                entity(ref.entity) &&
                Array.isArray(ref.sources) &&
                ref.sources.length > 0 &&
                ref.sources.every((source) =>
                  [
                    "SCHEMA_METADATA",
                    "EDITABLE_SCHEMA",
                    "SCHEMA_FIELD_ENTITY",
                  ].includes(String(source)),
                ),
            ))),
    ) &&
    (v.referenceKinds === undefined ||
      (Array.isArray(v.referenceKinds) &&
        v.referenceKinds.length <= 4 &&
        new Set(v.referenceKinds).size === v.referenceKinds.length &&
        v.referenceKinds.every((kind) =>
          ["Owner", "Tag", "Term", "Domain"].includes(String(kind)),
        ))) &&
    Array.isArray(v.references) &&
    v.references.every(
      (r) => record(r) && string(r.kind) && entity(r.entity),
    ) &&
    Array.isArray(v.properties) &&
    v.properties.every((p) => record(p) && string(p.name) && string(p.value)) &&
    (v.schemaFieldCount === null || integer(v.schemaFieldCount)) &&
    stamp(v.schemaCreatedAt) &&
    (v.schemaVersion === null || integer(v.schemaVersion))
  );
}
export function catalogErrorText(code: unknown): string {
  const messages: Record<string, string> = {
    catalog_not_configured:
      "此帳號尚未啟用 Catalog 查詢；請由管理者確認可見範圍。",
    catalog_read_denied: "無法取得此資產，或目前身分沒有讀取權限。",
    catalog_identity_required: "DataHub 登入已失效，請重新從 Agent 入口開啟。",
    catalog_lineage_not_supported: "此資產類型尚無可用的血緣檢視。",
    catalog_schema_not_supported: "此資產類型不提供資料表欄位查詢。",
    invalid_catalog_browse_path:
      "來源位置格式不適用；請從實際返回的 Database／Schema 位置重新選擇。",
    catalog_association_not_supported:
      "此類型尚無已支援的治理關聯搜尋；未改成不限定的搜尋。",
    catalog_field_unavailable:
      "目前可見的 schema 中無法取得這個精確欄位；請重新查看欄位清單。",
    catalog_invalid_response:
      "Catalog 回應格式無法確認，未呈現其中資料；請重新查詢。",
    catalog_invalid_page: "Catalog 分頁回應不一致，未將結果當作完整資料。",
    catalog_read_unavailable:
      "DataHub 未完整回覆這項讀取；沒有使用替代查詢或舊資料。",
    catalog_unavailable: "無法讀取 DataHub；請確認連線後重新查詢。",
    catalog_request_timeout: "等待 DataHub 回應逾時；不代表底層查詢已停止。",
    catalog_request_failed: "Catalog 請求未完成；沒有使用替代工具或身分。",
    invalid_catalog_field_request:
      "欄位查詢參數不完整或不適用；請重新選擇欄位。",
    catalog_result_too_large: "資料超過單頁上限，請縮小頁面或查詢範圍。",
    catalog_request_cancelled: "已停止等待此查詢。",
  };
  return typeof code === "string" && Object.hasOwn(messages, code)
    ? messages[code]
    : "無法完成 Catalog 查詢；請確認連線後重新查詢。";
}

/** No credentials in this intent. The parent validates origin/frame and fresh identity. */
export function queryCatalog(
  request: CatalogRequest,
  signal: AbortSignal,
): Promise<CatalogResult> {
  return new Promise((resolve, reject) => {
    if (window.parent === window) {
      reject(new Error("catalog_not_configured"));
      return;
    }
    if (signal.aborted) {
      reject(new Error("catalog_request_cancelled"));
      return;
    }
    const channel = new MessageChannel();
    const requestId = crypto.randomUUID();
    let settled = false;
    const clean = () => {
      clearTimeout(timer);
      channel.port1.close();
      signal.removeEventListener("abort", cancel);
    };
    const stop = (
      code: "catalog_request_cancelled" | "catalog_request_timeout",
    ) => {
      if (settled) return;
      settled = true;
      channel.port1.postMessage({ type: "cancel" });
      clean();
      reject(new Error(code));
    };
    const cancel = () => stop("catalog_request_cancelled");
    const timer = setTimeout(() => stop("catalog_request_timeout"), 30000);
    signal.addEventListener("abort", cancel, { once: true });
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      if (settled) return;
      settled = true;
      clean();
      try {
        if (typeof event.data !== "string" || event.data.length > 65536)
          throw new Error("catalog_invalid_response");
        const value: unknown = JSON.parse(event.data);
        if (record(value) && string(value.error)) throw new Error(value.error);
        if (!isCatalogResult(value) || value.requestId !== requestId)
          throw new Error("catalog_invalid_response");
        resolve(value);
      } catch (e) {
        reject(e instanceof Error ? e : new Error("catalog_invalid_response"));
      }
    };
    window.parent.postMessage(
      {
        type: "datahub-catalog",
        body: JSON.stringify({ ...request, requestId }),
      },
      "*",
      [channel.port2],
    );
  });
}

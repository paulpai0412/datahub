// Imported only below the AppShell / MessageView client boundaries.
import { useContext, useEffect, useId, useRef, useState } from "react";
import {
  CatalogContext,
  type CatalogTab,
  type CatalogSelection,
} from "../lib/catalog-context";
export {
  CatalogContext,
  type CatalogTab,
  type CatalogSelection,
} from "../lib/catalog-context";
import {
  catalogErrorText,
  catalogNativeUrl,
  isCatalogResult,
  queryCatalog,
  type CatalogEntity,
  type CatalogReference,
  type CatalogRequest,
  type CatalogResult,
} from "../lib/catalog-contract";
import s from "./DataHubCatalog.module.css";
import {
  CatalogEntityIcon as NativeIcon,
  CatalogEntityVisual as NativeVisual,
  CatalogTabIcon as DetailIcon,
} from "./DataHubCatalogIcons";
import { DataHubCatalogFieldLineage } from "./DataHubCatalogFieldLineage";
import {
  CatalogFieldGovernance,
  CatalogFieldChips,
} from "./DataHubCatalogField";
import {
  DataHubCatalogLineage,
  initialLineageView,
  type CatalogLineageView,
} from "./DataHubCatalogLineage";

const tabs: { id: CatalogTab; label: string }[] = [
  { id: "about", label: "總覽" },
  { id: "lineage", label: "血緣" },
  { id: "schema", label: "欄位" },
  { id: "properties", label: "屬性" },
  { id: "sources", label: "來源與限制" },
];
const supportsLineage = (type: string) =>
  [
    "DATASET",
    "DATA_FLOW",
    "DATA_JOB",
    "CHART",
    "DASHBOARD",
    "SCHEMA_FIELD",
  ].includes(type);
const supportsAssociations = (type: string) =>
  ["TAG", "GLOSSARY_TERM", "DOMAIN", "CORP_USER", "CORP_GROUP"].includes(type);
const relatedRequest = (urn: string): CatalogRequest => ({
  action: "search",
  query: "*",
  relatedTo: urn,
  offset: 0,
  limit: 10,
});
const date = (v: string | number | null | undefined) =>
  v == null ? "未提供" : new Date(v).toLocaleString("zh-TW");
const label = (e: CatalogEntity) =>
  [
    e.type,
    ...(e.subTypes ?? []),
    e.platformDisplayName ?? e.platform,
    e.platformInstance,
    e.environment,
    e.profileTitle,
    e.qualifiedName,
  ]
    .filter(Boolean)
    .join(" · ");
const requestFor = (urn: string): CatalogRequest => ({
  action: "entity",
  urn,
  offset: 0,
  limit: 10,
});
function lineageFor(
  entity: CatalogEntity,
  direction: "UPSTREAM" | "DOWNSTREAM",
  fieldPath?: string,
): CatalogRequest {
  if (fieldPath !== undefined || entity.type === "SCHEMA_FIELD")
    return {
      action: "fieldLineage",
      urn: entity.type === "SCHEMA_FIELD" ? entity.parentUrn! : entity.urn,
      fieldPath: fieldPath ?? entity.name,
      direction,
    };
  return { action: "lineage", urn: entity.urn, direction };
}

// Presentation-only port of pinned EntityHeaderLoadingSection: avatar + two
// 240×20 title rows. Hidden shapes carry no fake names/counts or catalog data.
function CatalogLoading({ detail = false }: { detail?: boolean }) {
  return (
    <div role="status" aria-live="polite">
      <p>{detail ? "正在讀取目前可見資料…" : "正在查詢 DataHub Catalog…"}</p>
      <div className={s.loadingHeader} aria-hidden="true">
        <span className={s.loadingAvatar} />
        <div className={s.loadingNames}>
          <span />
          <span />
        </div>
      </div>
    </div>
  );
}

/** Intercepts all result states, including unknown versions; never falls back to raw tool JSON. */
export function DataHubCatalogCards({
  value,
  pending,
  error,
}: {
  value: unknown;
  pending: boolean;
  error?: string;
}) {
  const open = useContext(CatalogContext);
  if (pending)
    return (
      <div className={`${s.surface} ${s.card}`}>
        <CatalogLoading />
      </div>
    );
  if (error)
    return (
      <div className={`${s.surface} ${s.card}`} role="status">
        {catalogErrorText(error)}
      </div>
    );
  if (!isCatalogResult(value))
    return (
      <div className={`${s.surface} ${s.card}`} role="status">
        此查詢結果尚無可讀檢視；請重新以 Catalog 查詢。
      </div>
    );
  const entities = value.entities ?? (value.entity ? [value.entity] : []);
  const focusedField = value.fields?.find(
    (f) => f.path === value.request.fieldPath,
  );
  const impactTypes = [
    ...new Set(value.edges?.map((edge) => edge.related.type)),
  ];
  return (
    <section className={s.surface} aria-label="DataHub Catalog 查詢結果">
      {value.action === "search" && (
        <h3>
          {value.relatedTo
            ? `${value.relatedTo.name}：關聯資產`
            : "資產搜尋與選擇"}
        </h3>
      )}
      {value.relatedTo && (
        <p className={s.secondary}>
          依指定治理項目的原生索引查詢；包含資產／欄位標記，不推定具體欄位或繼承關係。
          {value.relatedTo.urn}
        </p>
      )}
      {entities.length === 0 && (
        <div className={s.card}>
          本次可見範圍未找到結果；不代表資產或依賴不存在。
        </div>
      )}
      {entities.map((e) => (
        <article className={s.card} key={e.urn}>
          <button
            className={s.title}
            disabled={!open}
            onClick={() =>
              open?.({
                request: requestFor(e.urn),
                tab: "about",
                title: e.name,
              })
            }
          >
            <NativeVisual entity={e} />
            {e.name}
          </button>
          <div className={s.secondary}>{label(e)}</div>
          <p className={s.description}>
            {e.description == null ? "描述未提供" : e.description.slice(0, 240)}
            {e.description && e.description.length > 240
              ? "…（摘要；完整內容見詳情）"
              : null}
          </p>
          <div className={s.actions}>
            <button
              disabled={!open}
              onClick={() =>
                open?.({
                  request: requestFor(e.urn),
                  tab: "about",
                  title: e.name,
                })
              }
            >
              查看詳情
            </button>
            {supportsAssociations(e.type) && (
              <button
                disabled={!open}
                onClick={() =>
                  open?.({
                    request: relatedRequest(e.urn),
                    tab: "about",
                    title: `${e.name}：關聯資產`,
                  })
                }
              >
                查看關聯資產
              </button>
            )}
            {e.type === "DATASET" && (
              <button
                disabled={!open}
                onClick={() =>
                  open?.({
                    request: requestFor(e.urn),
                    tab: "schema",
                    title: e.name,
                  })
                }
              >
                欄位與 schema
              </button>
            )}
            {supportsLineage(e.type) && (
              <>
                <button
                  disabled={!open}
                  onClick={() =>
                    open?.({
                      request: lineageFor(e, "UPSTREAM"),
                      tab: "lineage",
                      title: e.name,
                    })
                  }
                >
                  上游來源
                </button>
                <button
                  disabled={!open}
                  onClick={() =>
                    open?.({
                      request: lineageFor(e, "DOWNSTREAM"),
                      tab: "lineage",
                      title: e.name,
                    })
                  }
                >
                  下游影響
                </button>
              </>
            )}
            <button
              disabled={!open}
              onClick={() =>
                open?.({
                  request: requestFor(e.urn),
                  tab: "properties",
                  title: e.name,
                })
              }
            >
              屬性
            </button>
            <NativeLink entity={e} />
          </div>
          {value.edges && (
            <p className={s.secondary}>
              本頁 {value.edges.length} 個可見關係 · 部分範圍
            </p>
          )}
        </article>
      ))}
      {value.action === "entity" &&
        value.entity?.type === "DATASET" &&
        !value.request.fieldPath && (
          <article className={s.card} aria-label="欄位清單卡">
            <h3>欄位與 Schema</h3>
            <p className={s.secondary}>
              本頁 {value.fields!.length} 欄；查詢匹配{" "}
              {value.pagination.total ?? "未提供"} 欄；已記錄 schema{" "}
              {value.schemaFieldCount ?? "未提供"} 欄。
            </p>
            <div className={s.scroll}>
              <table className={s.table}>
                <thead>
                  <tr>
                    <th>欄位</th>
                    <th>原生型別</th>
                    <th>描述</th>
                    <th>標籤</th>
                    <th>詞彙</th>
                  </tr>
                </thead>
                <tbody>
                  {value.fields!.map((f) => (
                    <tr key={f.path}>
                      <td>
                        <button
                          className={s.link}
                          disabled={!open}
                          onClick={() =>
                            open?.({
                              request: {
                                action: "entity",
                                urn: value.entity!.urn,
                                fieldPath: f.path,
                              },
                              tab: "schema",
                              title: f.path,
                            })
                          }
                        >
                          {f.path}
                        </button>
                      </td>
                      <td>{f.nativeType ?? "未提供"}</td>
                      <td className={s.description}>
                        {f.description ?? "未填寫"}
                      </td>
                      {(["Tag", "Term"] as const).map((kind) => (
                        <td key={kind}>
                          <CatalogFieldChips
                            field={f}
                            kind={kind}
                            onEntity={
                              open
                                ? (entity) =>
                                    open({
                                      request: requestFor(entity.urn),
                                      tab: "about",
                                      title: entity.name,
                                    })
                                : undefined
                            }
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button
              className={s.link}
              disabled={!open}
              onClick={() =>
                open?.({
                  request: value.request,
                  tab: "schema",
                  title: value.entity!.name,
                })
              }
            >
              搜尋與查看欄位
            </button>
          </article>
        )}
      {focusedField && value.entity && (
        <article className={s.card} aria-label="欄位詳情卡">
          <h3>{focusedField.path}</h3>
          <div className={s.secondary}>
            {value.entity.name} · 原生型別：
            {focusedField.nativeType ?? "未提供"}
          </div>
          <p>{focusedField.description ?? "描述未填寫"}</p>
          <button
            className={s.link}
            disabled={!open}
            onClick={() =>
              open?.({
                request: value.request,
                tab: "schema",
                title: focusedField.path,
              })
            }
          >
            查看欄位詳情
          </button>
        </article>
      )}
      {value.action === "fieldLineage" && (
        <article className={s.card} aria-label="欄位血緣摘要卡">
          <h3>{value.fieldPath} · 原生欄位映射</h3>
          <p>
            {value.direction === "UPSTREAM" ? "上游" : "下游"} · 本頁{" "}
            {value.groups!.length} 組可見映射
          </p>
          {value.groups!.slice(0, 2).map((group, index) => (
            <div key={index}>
              <p>
                輸入：
                {group.upstreams
                  .map((field) => `${field.dataset.name}／${field.path}`)
                  .join("、")}
              </p>
              <p>
                輸出：
                {group.downstreams
                  .map((field) => `${field.dataset.name}／${field.path}`)
                  .join("、")}
              </p>
            </div>
          ))}
          <button
            disabled={!open}
            onClick={() =>
              open?.({
                request: value.request,
                tab: "lineage",
                title: value.fieldPath!,
              })
            }
          >
            查看完整群組與欄位
          </button>
          <p className={s.secondary}>
            摘要最多列兩組。空頁不是沒有映射；分頁與限制見詳情。
          </p>
        </article>
      )}
      {value.action === "lineage" && value.entity && (
        <article className={s.card} aria-label="血緣摘要卡">
          <h3>
            {value.direction === "UPSTREAM" ? "已記錄上游" : "已記錄下游"}
          </h3>
          <p className={s.secondary}>
            本頁 {value.edges!.length} 筆可見關係；箭頭表示資料流向。
          </p>
          <ul>
            {value.edges!.map((edge, index) => (
              <li key={`${edge.from}:${edge.to}:${index}`}>
                {value.direction === "UPSTREAM"
                  ? edge.related.name
                  : value.entity!.name}{" "}
                →{" "}
                {value.direction === "UPSTREAM"
                  ? value.entity!.name
                  : edge.related.name}
                <span className={s.secondary}> · {edge.relationship}</span>
              </li>
            ))}
          </ul>
          {value.edges!.length === 0 && (
            <p>本頁沒有可見關係；不能據此判定沒有依賴。</p>
          )}
          <button
            className={s.link}
            disabled={!open}
            onClick={() =>
              open?.({
                request: value.request,
                tab: "lineage",
                title: value.entity!.name,
              })
            }
          >
            探索血緣
          </button>
        </article>
      )}
      {value.action === "lineage" &&
        value.direction === "DOWNSTREAM" &&
        value.entity && (
          <article className={s.card} aria-label="下游影響卡">
            <h3>下游依賴分類</h3>
            <dl className={s.definition}>
              {impactTypes.map((type) => (
                <div key={type}>
                  <dt>{type}</dt>
                  <dd>
                    {
                      new Set(
                        value
                          .edges!.filter((edge) => edge.related.type === type)
                          .map((edge) => edge.related.urn),
                      ).size
                    }{" "}
                    個本頁可見資產
                  </dd>
                </div>
              ))}
            </dl>
            <p className={s.secondary}>
              只代表本頁已記錄依賴；不是完整業務影響或故障預測。
            </p>
            <button
              className={s.link}
              disabled={!open}
              onClick={() =>
                open?.({
                  request: value.request,
                  tab: "lineage",
                  title: value.entity!.name,
                })
              }
            >
              查看下游與路徑
            </button>
          </article>
        )}
      {value.action === "entity" && value.entity && (
        <article className={s.card} aria-label="屬性摘要卡">
          <h3>治理與自訂屬性</h3>
          <div>
            {value.references!.map((r) => (
              <button
                key={`${r.kind}:${r.entity.urn}`}
                className={s.chip}
                disabled={!open}
                onClick={() =>
                  open?.({
                    request: requestFor(r.entity.urn),
                    tab: "about",
                    title: r.entity.name,
                  })
                }
              >
                {r.kind} · {r.entity.name}
              </button>
            ))}
          </div>
          <p className={s.secondary}>
            {value.properties!.length}{" "}
            項核准顯示的自訂屬性；未取得的內容不當作不存在。
          </p>
          <button
            className={s.link}
            disabled={!open}
            onClick={() =>
              open?.({
                request: requestFor(value.entity!.urn),
                tab: "properties",
                title: value.entity!.name,
              })
            }
          >
            查看屬性
          </button>
        </article>
      )}
      <div className={s.card} aria-label="來源與覆蓋卡">
        <h3>來源與覆蓋</h3>
        <span className={s.chip}>唯讀 · 歷史查詢結果</span>
        <div className={s.secondary}>
          查詢於 {date(value.queriedAt)}；點選詳情將重新查詢及驗證權限。
        </div>
        <div className={s.actions}>
          <button
            disabled={!open}
            onClick={() =>
              open?.({
                request: value.request,
                tab: value.action === "search" ? "about" : "sources",
                title: "來源與覆蓋",
              })
            }
          >
            {value.action === "search" ? "搜尋與完整清單" : "來源與覆蓋"}
          </button>
        </div>
      </div>
    </section>
  );
}

function PropertyValue({
  value,
  depth = 0,
}: {
  value: unknown;
  depth?: number;
}) {
  if (depth > 8) return <span>內容層級過深，請至原生頁檢視。</span>;
  if (value === null) return <span>空值</span>;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        parsed = undefined;
      }
      return parsed === undefined ? (
        <span>此複雜內容尚無可讀檢視。</span>
      ) : (
        <PropertyValue value={parsed} depth={depth + 1} />
      );
    }
    return <span>{value || "空字串"}</span>;
  }
  if (typeof value === "boolean") return <span>{value ? "是" : "否"}</span>;
  if (typeof value === "number") return <span>{value}</span>;
  if (Array.isArray(value))
    return value.length ? (
      <ol>
        {value.slice(0, 50).map((v, i) => (
          <li key={i}>
            <PropertyValue value={v} depth={depth + 1} />
          </li>
        ))}
        {value.length > 50 && <li>僅顯示前 50 項</li>}
      </ol>
    ) : (
      <span>空清單</span>
    );
  if (typeof value === "object")
    return (
      <dl className={s.definition}>
        {Object.entries(value)
          .slice(0, 50)
          .map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>
                <PropertyValue value={v} depth={depth + 1} />
              </dd>
            </div>
          ))}
        {Object.keys(value).length > 50 && <dt>僅顯示前 50 項屬性</dt>}
      </dl>
    );
  return <span>未提供</span>;
}
function NativeLink({
  entity,
  tab,
  fieldPath,
}: {
  entity: CatalogEntity;
  tab?: CatalogTab;
  fieldPath?: string;
}) {
  const href = catalogNativeUrl(entity, tab, fieldPath);
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {tab === "schema"
        ? fieldPath
          ? "在 DataHub 定位欄位"
          : "在 DataHub 開啟欄位"
        : tab === "lineage"
          ? "在 DataHub 開啟血緣"
          : "開 DataHub（離開唯讀檢視）"}
    </a>
  ) : (
    <span>原生連結未提供</span>
  );
}

function SearchFilters({
  result,
  onQuery,
}: {
  result: CatalogResult;
  onQuery: (request: CatalogRequest) => void;
}) {
  const fields = [
    { field: "platform", property: "platformUrn", label: "平台" },
    {
      field: "platformInstance",
      property: "platformInstanceUrn",
      label: "來源 instance",
    },
    { field: "origin", property: "environment", label: "環境" },
  ] as const;
  const locations = new Map<string, { ids: string[]; label: string }>();
  for (const entity of result.entities ?? []) {
    const path = entity.browsePath ?? [];
    path.forEach((entry, index) => {
      const prefix = path.slice(0, index + 1),
        ids = prefix.map((part) => part.id);
      locations.set(JSON.stringify(ids), {
        ids,
        label: `${prefix.map((part) => part.name ?? part.id).join(" › ")}${entry.subTypes.length ? ` · ${entry.subTypes.join("／")}` : ""}`,
      });
    });
  }
  const selectedLocation = result.request.browsePath
    ? JSON.stringify(result.request.browsePath)
    : "";
  if (selectedLocation && !locations.has(selectedLocation))
    locations.set(selectedLocation, {
      ids: result.request.browsePath!,
      label: `目前選定位置：${result.request.browsePath!.join(" › ")}`,
    });
  return (
    <details className={s.section}>
      <summary>篩選搜尋（選项只取自本頁可見資產）</summary>
      {fields.map(({ field, property, label }) => {
        const choices = new Map<string, string>();
        for (const entity of result.entities ?? []) {
          const value = entity[property];
          if (value)
            choices.set(
              value,
              field === "platform"
                ? (entity.platformDisplayName ?? entity.platform ?? value)
                : field === "platformInstance"
                  ? (entity.platformInstance ?? value)
                  : value,
            );
        }
        const selected = result.request.filters?.[field] ?? "";
        if (selected && !choices.has(selected)) choices.set(selected, selected);
        return (
          <label key={field}>
            {label}
            <select
              className={s.input}
              value={selected}
              onChange={(event) => {
                const filters = { ...result.request.filters };
                if (event.target.value) filters[field] = event.target.value;
                else delete filters[field];
                onQuery({ ...result.request, filters, offset: 0 });
              }}
            >
              <option value="">不限定</option>
              {[...choices].map(([value, name]) => (
                <option key={value} value={value}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        );
      })}
      <label>
        Database／Schema／來源位置
        <select
          className={s.input}
          value={selectedLocation}
          onChange={(event) => {
            if (!event.target.value)
              onQuery({ ...result.request, browsePath: undefined, offset: 0 });
            else {
              const location = locations.get(event.target.value);
              if (location)
                onQuery({
                  ...result.request,
                  browsePath: location.ids,
                  offset: 0,
                });
            }
          }}
        >
          <option value="">不限定來源位置</option>
          {[...locations].map(([key, location]) => (
            <option key={key} value={key}>
              {location.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        本頁已見資產類型
        <select
          className={s.input}
          value={
            result.request.types?.length === 1 ? result.request.types[0] : ""
          }
          onChange={(event) =>
            onQuery({
              ...result.request,
              types: event.target.value ? [event.target.value] : undefined,
              offset: 0,
            })
          }
        >
          <option value="">預設資產類型</option>
          {[
            ...new Set([
              ...(result.request.types ?? []),
              ...(result.entities ?? []).map((entity) => entity.type),
            ]),
          ].map((type) => (
            <option key={type}>{type}</option>
          ))}
        </select>
      </label>
      <p className={s.secondary}>
        這不是全域選項清單。來源位置只用原生 Browse V2
        路徑前綴，Database／Schema
        分類來自原生容器；不從點分名稱猜測。沒有可見位置時不推造篩選值。
      </p>
    </details>
  );
}

type View = {
  request: CatalogRequest;
  tab: CatalogTab;
  title: string;
  filter: string;
  graph: boolean;
  lineagePages: CatalogResult[];
  lineageView: CatalogLineageView;
  scroll: number;
};
export function DataHubCatalogDetail({
  selection,
  onClose,
  onQuote,
}: {
  selection: CatalogSelection;
  onClose: () => void;
  onQuote: (reference: CatalogReference) => void;
}) {
  const [view, setView] = useState<View>({
    ...selection,
    filter: selection.request.fieldQuery ?? "",
    graph: false,
    lineagePages: [],
    lineageView: initialLineageView,
    scroll: 0,
  });
  const [history, setHistory] = useState<View[]>([]);
  const [received, setReceived] = useState<{
    request: CatalogRequest;
    value: CatalogResult;
  } | null>(null);
  // Bind visible data to its exact request during render, not only in the next effect.
  // Otherwise A's payload flashes under B's heading for one committed frame.
  const result = received?.request === view.request ? received.value : null;
  const [failure, setFailure] = useState<{
    request: CatalogRequest;
    code: string;
  } | null>(null);
  const error = failure?.request === view.request ? failure.code : null;
  const root = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const body = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [modal, setModal] = useState(false);
  useEffect(() => {
    closeButton.current?.focus();
  }, [selection]);
  useEffect(() => {
    const node = root.current;
    const workbench =
      node?.closest<HTMLElement>(".datahub-workbench") ??
      node?.parentElement?.parentElement;
    if (!node || !workbench) return;
    const resize = new ResizeObserver(() =>
      setModal(workbench.clientWidth < 1024),
    );
    resize.observe(workbench);
    return () => resize.disconnect();
  }, []);
  useEffect(() => {
    if (!modal) return;
    const panel = root.current?.closest<HTMLElement>("#file-panel");
    const siblings = panel?.parentElement
      ? [...panel.parentElement.children].filter(
          (n): n is HTMLElement => n instanceof HTMLElement && n !== panel,
        )
      : [];
    const before = siblings.map((n) => n.inert);
    siblings.forEach((n) => {
      n.inert = true;
    });
    return () => {
      siblings.forEach((n, i) => {
        n.inert = before[i];
      });
    };
  }, [modal]);
  useEffect(() => {
    const abort = new AbortController();
    setReceived(null);
    setFailure(null);
    queryCatalog(view.request, abort.signal)
      .then((value) => {
        if (!abort.signal.aborted) {
          if (!isCatalogResult(value)) {
            setFailure({
              request: view.request,
              code: "catalog_invalid_response",
            });
            return;
          }
          setReceived({ request: view.request, value });
          requestAnimationFrame(() => {
            if (body.current && !abort.signal.aborted)
              body.current.scrollTop = view.scroll;
          });
        }
      })
      .catch((e: unknown) => {
        if (!abort.signal.aborted)
          setFailure({
            request: view.request,
            code: e instanceof Error ? e.message : "catalog_unavailable",
          });
      });
    return () => abort.abort();
  }, [view.request, view.scroll]); // Tab/filter-only changes must not restart a read.
  function navigate(next: CatalogSelection, graph = false) {
    setHistory((h) => [
      ...h,
      { ...view, scroll: body.current?.scrollTop ?? 0 },
    ]);
    setView({
      ...next,
      filter: next.request.fieldQuery ?? "",
      graph,
      lineagePages: [],
      lineageView: initialLineageView,
      scroll: 0,
    });
  }
  function refreshCurrent() {
    // A fresh request identity invalidates visible data and late expansion callbacks
    // during render, including a refresh of the same URN/direction.
    const scroll = body.current?.scrollTop;
    setView((current) => ({
      ...current,
      request: { ...current.request },
      lineagePages: [],
      scroll: scroll ?? current.scroll,
    }));
  }
  function back() {
    const prior = history.at(-1);
    if (!prior) return;
    setHistory((h) => h.slice(0, -1));
    setView(prior);
  }
  function changeTab(tab: CatalogTab) {
    const urn = result?.entity?.urn ?? view.request.urn;
    if (tab === "lineage" && !result?.entity) return;
    if (
      tab === "lineage" &&
      result?.entity &&
      !["lineage", "fieldLineage"].includes(view.request.action)
    )
      navigate({
        request: lineageFor(result.entity, "UPSTREAM", view.request.fieldPath),
        tab,
        title: view.title,
      });
    else if (
      ["about", "schema", "properties"].includes(tab) &&
      urn &&
      ["lineage", "fieldLineage"].includes(view.request.action)
    )
      navigate({
        request: {
          ...requestFor(urn),
          ...(tab === "schema" && view.request.fieldPath
            ? { fieldPath: view.request.fieldPath }
            : {}),
        },
        tab,
        title: view.title,
      });
    else setView((v) => ({ ...v, tab }));
  }
  function entityDetails(e: CatalogEntity) {
    navigate({ request: requestFor(e.urn), tab: "about", title: e.name });
  }
  const e = result?.entity;
  const field = result?.fields?.find((f) => f.path === view.request.fieldPath);
  const selectedFieldPath =
    field?.path ??
    (result?.action === "fieldLineage" ? result.fieldPath : undefined);
  const filteredFields = result?.fields ?? [];
  const filteredProperties = (result?.properties ?? []).filter((p) =>
    p.name.toLocaleLowerCase().includes(view.filter.toLocaleLowerCase()),
  );
  const shownTabs = tabs.filter((t) =>
    view.request.action === "search"
      ? ["about", "sources"].includes(t.id)
      : !e
        ? ["about", "properties", "sources", view.tab].includes(t.id)
        : (t.id !== "schema" || e.type === "DATASET") &&
          (t.id !== "lineage" || supportsLineage(e.type)),
  );
  return (
    <div
      ref={root}
      className={`${s.surface} ${s.root}`}
      role={modal ? "dialog" : "complementary"}
      aria-modal={modal || undefined}
      aria-label="DataHub 資產詳情"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
        if (modal && event.key === "Tab") {
          const controls = [
            ...(root.current?.querySelectorAll<HTMLElement>(
              "button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex]",
            ) ?? []),
          ].filter(
            (element) =>
              element.tabIndex >= 0 &&
              element.getClientRects().length > 0 &&
              !element.closest("[inert]"),
          );
          const first = controls[0],
            last = controls.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <div className={s.content}>
        <header className={s.header}>
          {!!history.length && (
            <button aria-label="返回上一層" onClick={back}>
              ←
            </button>
          )}
          <h2>
            {selectedFieldPath
              ? `欄位 · ${selectedFieldPath}`
              : tabs.find((t) => t.id === view.tab)?.label}
          </h2>
          <button ref={closeButton} aria-label="關閉詳情" onClick={onClose}>
            ×
          </button>
        </header>
        <div
          ref={body}
          className={s.body}
          role="tabpanel"
          id={`${panelId}-panel`}
          aria-labelledby={`${panelId}-tab-${view.tab}`}
          tabIndex={0}
        >
          {error && (
            <section className={s.section} role="status">
              <p>{catalogErrorText(error)}</p>
              <button className={s.link} onClick={refreshCurrent}>
                重新查詢
              </button>
            </section>
          )}
          {!result && !error && <CatalogLoading detail />}
          {result && (
            <>
              {e && (
                <section className={s.section}>
                  <div className={s.title}>
                    <NativeVisual entity={e} />
                    {e.name}
                  </div>
                  <div className={s.secondary}>{label(e)}</div>
                  {selectedFieldPath && e.type === "DATASET" && (
                    <nav className={s.breadcrumb} aria-label="欄位階層">
                      <button
                        className={s.link}
                        onClick={() =>
                          navigate({
                            request: requestFor(e.urn),
                            tab: "schema",
                            title: e.name,
                          })
                        }
                      >
                        {e.name}
                      </button>
                      <span aria-hidden="true">›</span>
                      <span aria-current="page">{selectedFieldPath}</span>
                    </nav>
                  )}
                  <span className={s.chip}>唯讀</span>
                  <div className={s.actions}>
                    <button
                      onClick={() =>
                        onQuote({
                          urn: e.urn,
                          name: e.name,
                          ...(selectedFieldPath
                            ? { fieldPath: selectedFieldPath }
                            : {}),
                        })
                      }
                    >
                      引用到對話
                    </button>
                    <NativeLink
                      entity={e}
                      tab={view.tab}
                      fieldPath={selectedFieldPath}
                    />
                  </div>
                </section>
              )}
              {result.action === "search" && (
                <section className={s.section}>
                  {result.relatedTo && (
                    <div className={s.section}>
                      <h3>{result.relatedTo.name}：關聯資產</h3>
                      <button
                        className={s.link}
                        onClick={() => entityDetails(result.relatedTo!)}
                      >
                        返回定義與詳情
                      </button>
                      <p className={s.secondary}>
                        精確治理項目：{result.relatedTo.urn}
                        。包含資產／欄位標記，搜尋結果本身不指出匹配欄位；不展開子詞彙、子領域或群組繼承。
                      </p>
                    </div>
                  )}
                  <form
                    onSubmit={(ev) => {
                      ev.preventDefault();
                      navigate({
                        request: {
                          ...view.request,
                          action: "search",
                          query: view.filter || view.request.query,
                          offset: 0,
                        },
                        tab: "about",
                        title: "搜尋資產",
                      });
                    }}
                  >
                    <label>
                      搜尋資產
                      <input
                        className={s.input}
                        value={view.filter}
                        placeholder={view.request.query}
                        onChange={(ev) =>
                          setView((v) => ({ ...v, filter: ev.target.value }))
                        }
                      />
                    </label>
                    <button className={s.link} type="submit">
                      搜尋
                    </button>
                  </form>
                  <SearchFilters
                    result={result}
                    onQuery={(request) =>
                      navigate({ request, tab: "about", title: "搜尋資產" })
                    }
                  />
                  {(result.entities ?? []).map((entity) => (
                    <div className={s.section} key={entity.urn}>
                      <button
                        className={s.title}
                        onClick={() => entityDetails(entity)}
                      >
                        <NativeVisual entity={entity} />
                        {entity.name}
                      </button>
                      <div className={s.secondary}>{label(entity)}</div>
                      <button
                        className={s.link}
                        onClick={() =>
                          onQuote({ urn: entity.urn, name: entity.name })
                        }
                      >
                        以此資產查詢
                      </button>
                    </div>
                  ))}
                  {!result.entities?.length && <p>本頁未找到可見資產。</p>}
                </section>
              )}
              {view.tab === "about" && e && (
                <section className={s.section}>
                  {e.type === "DATASET" && (
                    <div className={s.section}>
                      <h3>欄位</h3>
                      <button
                        className={s.link}
                        onClick={() => changeTab("schema")}
                      >
                        {result.schemaFieldCount === null
                          ? "尚未取得 schema"
                          : `${result.schemaFieldCount} 個已記錄欄位`}
                      </button>
                    </div>
                  )}
                  {supportsAssociations(e.type) && (
                    <div className={s.section}>
                      <h3>關聯資產</h3>
                      <button
                        className={s.link}
                        onClick={() =>
                          navigate({
                            request: relatedRequest(e.urn),
                            tab: "about",
                            title: `${e.name}：關聯資產`,
                          })
                        }
                      >
                        查看可見關聯資產
                      </button>
                      <p className={s.secondary}>
                        使用指定項目的原生索引；每次讀取重新核對本項目與結果資產的權限。
                      </p>
                    </div>
                  )}
                  <details className={s.section} open>
                    <summary>
                      {e.type === "CORP_USER"
                        ? "個人簡介"
                        : e.type === "CORP_GROUP"
                          ? "群組說明"
                          : "文件說明"}
                    </summary>
                    <p className={s.description}>
                      {e.description ?? "描述未填寫或未提供"}
                    </p>
                  </details>
                  {supportsLineage(e.type) && (
                    <details className={s.section} open>
                      <summary>血緣</summary>
                      <button
                        className={s.link}
                        onClick={() => changeTab("lineage")}
                      >
                        查詢已記錄關係
                      </button>
                    </details>
                  )}
                  {(
                    [
                      { kind: "Owner", title: "擁有者" },
                      { kind: "Domain", title: "領域" },
                      { kind: "Tag", title: "標籤" },
                      { kind: "Term", title: "詞彙" },
                    ] as const
                  )
                    .filter(({ kind }) => result.referenceKinds?.includes(kind))
                    .map(({ kind, title }) => {
                      const references =
                        result.references?.filter(
                          (reference) => reference.kind === kind,
                        ) ?? [];
                      return (
                        <details key={kind} className={s.section} open>
                          <summary>{title}</summary>
                          {references.length > 0 ? (
                            references.map((reference) => (
                              <button
                                key={reference.entity.urn}
                                className={s.chip}
                                title={reference.entity.name}
                                onClick={() => entityDetails(reference.entity)}
                              >
                                <NativeIcon type={reference.entity.type} />
                                <span className={s.chipLabel}>
                                  {reference.entity.name}
                                </span>
                              </button>
                            ))
                          ) : (
                            <p className={s.secondary}>
                              未取得可見的{title}資訊。
                            </p>
                          )}
                        </details>
                      );
                    })}
                  {!result.referenceKinds && (
                    <p className={s.secondary}>
                      這份結果未列出治理查詢範圍；請重新查詢。不將未讀的 section
                      當成空資料。
                    </p>
                  )}
                  <h3>來源識別與狀態</h3>
                  <dl className={s.definition}>
                    <dt>完整識別碼</dt>
                    <dd>{e.urn}</dd>
                    <dt>Metadata 最近匯入</dt>
                    <dd>{date(e.ingestedAt)}</dd>
                    {e.type === "DATASET" && (
                      <>
                        <dt>平台顯示名稱</dt>
                        <dd>{e.platformDisplayName ?? "本次結果未提供"}</dd>
                        <dt>平台識別</dt>
                        <dd>{e.platformUrn ?? "本次結果未提供"}</dd>
                        <dt>平台 instance</dt>
                        <dd>{e.platformInstance ?? "本次結果未提供"}</dd>
                        <dt>平台 instance 識別</dt>
                        <dd>{e.platformInstanceUrn ?? "本次結果未提供"}</dd>
                        <dt>原生來源位置</dt>
                        <dd>
                          {e.browsePath?.length ? (
                            <ol>
                              {e.browsePath.map((entry) => (
                                <li key={entry.id}>
                                  {entry.urn ? (
                                    <button
                                      className={s.link}
                                      onClick={() =>
                                        navigate({
                                          request: requestFor(entry.urn!),
                                          tab: "about",
                                          title: entry.name ?? entry.urn!,
                                        })
                                      }
                                    >
                                      {entry.name ?? "名稱未提供"}
                                    </button>
                                  ) : (
                                    entry.name
                                  )}
                                  <span className={s.secondary}>
                                    {" "}
                                    {entry.subTypes.join("／")} · {entry.id}
                                  </span>
                                </li>
                              ))}
                            </ol>
                          ) : (
                            "未取得可見來源位置；不從資產名稱推測。"
                          )}
                        </dd>
                      </>
                    )}
                  </dl>
                  {e.parentUrn && (
                    <button
                      className={s.link}
                      onClick={() =>
                        navigate({
                          request: requestFor(e.parentUrn!),
                          tab: "schema",
                          title: "所屬資料表",
                        })
                      }
                    >
                      查看所屬資料表
                    </button>
                  )}
                </section>
              )}
              {view.tab === "schema" && (
                <section className={s.section}>
                  {field ? (
                    <>
                      <button
                        className={s.link}
                        onClick={() =>
                          history.at(-1)?.tab === "schema"
                            ? back()
                            : navigate({
                                request: requestFor(e!.urn),
                                tab: "schema",
                                title: e!.name,
                              })
                        }
                      >
                        ← 返回欄位清單
                      </button>
                      <dl className={s.definition}>
                        <dt>欄位名稱</dt>
                        <dd>{field.path}</dd>
                        <dt>來源顯示標籤</dt>
                        <dd>{field.label ?? "未提供"}</dd>
                        <dt>原生 JSON Path</dt>
                        <dd>{field.jsonPath ?? "未提供"}</dd>
                        <dt>型別</dt>
                        <dd>{field.nativeType ?? "未提供"}</dd>
                        <dt>DataHub 型別</dt>
                        <dd>{field.type ?? "未提供"}</dd>
                        <dt>描述</dt>
                        <dd className={s.description}>
                          {field.description ?? "未填寫"}
                        </dd>
                        <dt>Partition key</dt>
                        <dd>
                          {field.partitionKey == null
                            ? "未提供"
                            : field.partitionKey
                              ? "是"
                              : "否"}
                        </dd>
                        <dt>遞迴型別</dt>
                        <dd>
                          {field.recursive == null
                            ? "未提供"
                            : field.recursive
                              ? "是"
                              : "否"}
                        </dd>
                        <dt>可為空值</dt>
                        <dd>
                          {field.nullable === null
                            ? "未提供"
                            : field.nullable
                              ? "是"
                              : "否"}
                        </dd>
                        <dt>Key</dt>
                        <dd>
                          {field.key === null
                            ? "未提供"
                            : field.key
                              ? "是"
                              : "否"}
                        </dd>
                      </dl>
                      <CatalogFieldGovernance
                        field={field}
                        onEntity={entityDetails}
                      />
                      {field.urn ? (
                        <div className={s.actions}>
                          {(["UPSTREAM", "DOWNSTREAM"] as const).map(
                            (direction) => (
                              <button
                                key={direction}
                                onClick={() =>
                                  navigate({
                                    request: {
                                      action: "fieldLineage",
                                      urn: e!.urn,
                                      fieldPath: field.path,
                                      direction,
                                    },
                                    tab: "lineage",
                                    title: field.path,
                                  })
                                }
                              >
                                {direction === "UPSTREAM"
                                  ? "欄位上游"
                                  : "欄位下游"}
                              </button>
                            ),
                          )}
                        </div>
                      ) : (
                        <p>
                          未取得可讀的原生欄位實體；不能由表級關係推測欄位映射。
                        </p>
                      )}
                    </>
                  ) : (
                    <>
                      <form
                        onSubmit={(event) => {
                          event.preventDefault();
                          navigate({
                            request: {
                              ...view.request,
                              fieldPath: undefined,
                              fieldQuery: view.filter || undefined,
                              offset: 0,
                            },
                            tab: "schema",
                            title: view.title,
                          });
                        }}
                      >
                        <label>
                          搜尋此版本已記錄的欄位名稱／型別
                          <input
                            className={s.input}
                            value={view.filter}
                            onChange={(ev) =>
                              setView((v) => ({
                                ...v,
                                filter: ev.target.value,
                              }))
                            }
                          />
                        </label>
                        <button className={s.link} type="submit">
                          搜尋欄位
                        </button>
                        <label>
                          排序
                          <select
                            className={s.input}
                            value={view.request.fieldSort ?? ""}
                            onChange={(event) =>
                              navigate({
                                request: {
                                  ...view.request,
                                  fieldSort:
                                    event.target.value === ""
                                      ? undefined
                                      : (event.target.value as "path" | "type"),
                                  offset: 0,
                                },
                                tab: "schema",
                                title: view.title,
                              })
                            }
                          >
                            <option value="">來源回傳順序（非 ordinal）</option>
                            <option value="path">欄位名稱</option>
                            <option value="type">原生型別</option>
                          </select>
                        </label>
                        <label>
                          每頁欄位
                          <select
                            className={s.input}
                            value={result.pagination.limit}
                            onChange={(event) =>
                              navigate({
                                request: {
                                  ...view.request,
                                  limit: Number(event.target.value),
                                  offset: 0,
                                },
                                tab: "schema",
                                title: view.title,
                              })
                            }
                          >
                            {[
                              ...new Set([
                                1,
                                5,
                                10,
                                20,
                                result.pagination.limit,
                              ]),
                            ]
                              .sort((a, b) => a - b)
                              .map((limit) => (
                                <option key={limit} value={limit}>
                                  {limit}
                                </option>
                              ))}
                          </select>
                        </label>
                      </form>
                      <p className={s.secondary}>
                        匹配 {result.pagination.total ?? "未提供"} 欄／已記錄{" "}
                        {result.schemaFieldCount ?? "未提供"}{" "}
                        欄；只針對本次取得的 schema 版本。
                      </p>
                      <p className={s.secondary}>
                        精簡欄位表；描述過長會截短。選取欄位可閱讀完整描述與標籤／詞彙。
                      </p>
                      <div
                        className={s.scroll}
                        tabIndex={0}
                        role="region"
                        aria-label="精簡欄位表，可水平捲動"
                      >
                        <table className={`${s.table} ${s.compactSchema}`}>
                          <thead>
                            <tr>
                              <th>欄位</th>
                              <th>描述</th>
                            </tr>
                          </thead>
                          <tbody>
                            {filteredFields.map((f) => (
                              <tr key={f.path}>
                                <td>
                                  <button
                                    className={s.link}
                                    onClick={() =>
                                      navigate({
                                        request: {
                                          action: "entity",
                                          urn: e!.urn,
                                          fieldPath: f.path,
                                        },
                                        tab: "schema",
                                        title: f.path,
                                      })
                                    }
                                  >
                                    {f.path}
                                  </button>
                                  <div className={s.secondary}>
                                    {f.nativeType ?? "原生型別未提供"}
                                  </div>
                                  <div className={s.secondary}>
                                    {f.type ?? "DataHub 型別未提供"}
                                  </div>
                                  {f.key === true && (
                                    <span className={s.chip}>Key</span>
                                  )}
                                  {f.nullable === true && (
                                    <span className={s.chip}>Nullable</span>
                                  )}
                                  {f.partitionKey === true && (
                                    <span className={s.chip}>
                                      Partition key
                                    </span>
                                  )}
                                  {f.recursive === true && (
                                    <span className={s.chip}>Recursive</span>
                                  )}
                                </td>
                                <td title={f.description ?? undefined}>
                                  {f.description ?? "未填寫"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      {!filteredFields.length && (
                        <p>本頁沒有可呈現欄位；不代表不存在。</p>
                      )}
                    </>
                  )}
                </section>
              )}
              {view.tab === "properties" && (
                <section className={s.section}>
                  <h3>治理資訊</h3>
                  {(result.references ?? []).map((r) => (
                    <button
                      key={`${r.kind}:${r.entity.urn}`}
                      className={s.chip}
                      onClick={() => entityDetails(r.entity)}
                    >
                      {r.kind} · {r.entity.name}
                    </button>
                  ))}
                  {!result.references?.length && <p>未取得可見的治理資訊。</p>}
                  <h3>自訂屬性</h3>
                  <label>
                    搜尋本頁屬性
                    <input
                      className={s.input}
                      value={view.filter}
                      onChange={(ev) =>
                        setView((v) => ({ ...v, filter: ev.target.value }))
                      }
                    />
                  </label>
                  <dl className={s.definition}>
                    {filteredProperties.map((p) => (
                      <div key={p.name}>
                        <dt>{p.name}</dt>
                        <dd>
                          <PropertyValue value={p.value} />
                        </dd>
                      </div>
                    ))}
                  </dl>
                  {!filteredProperties.length && (
                    <p>未取得允許顯示的自訂屬性。</p>
                  )}
                </section>
              )}
              {view.tab === "lineage" && (
                <section className={s.section}>
                  <div className={s.actions}>
                    {(["UPSTREAM", "DOWNSTREAM"] as const).map((direction) => (
                      <button
                        key={direction}
                        aria-pressed={result.direction === direction}
                        onClick={() =>
                          navigate({
                            request: lineageFor(
                              e!,
                              direction,
                              result.action === "fieldLineage"
                                ? result.fieldPath
                                : undefined,
                            ),
                            tab: "lineage",
                            title: view.title,
                          })
                        }
                      >
                        {direction === "UPSTREAM" ? "上游來源" : "下游影響"}
                      </button>
                    ))}
                    <button
                      onClick={() =>
                        setView((v) => ({ ...v, graph: !v.graph }))
                      }
                    >
                      {view.graph ? "清單檢視" : "關係檢視"}
                    </button>
                  </div>
                  {result.action === "fieldLineage" && (
                    <>
                      <label>
                        每頁讀取上限
                        <select
                          className={s.input}
                          value={result.pagination.limit}
                          onChange={(event) =>
                            navigate({
                              request: {
                                ...result.request,
                                limit: Number(event.target.value),
                                offset: 0,
                              },
                              tab: "lineage",
                              title: view.title,
                            })
                          }
                        >
                          {[...new Set([1, 5, 10, 20, result.pagination.limit])]
                            .sort((a, b) => a - b)
                            .map((limit) => (
                              <option key={limit} value={limit}>
                                {limit}
                              </option>
                            ))}
                        </select>
                      </label>
                      <DataHubCatalogFieldLineage
                        result={result}
                        graph={view.graph}
                        onEntity={entityDetails}
                        onField={(field) =>
                          navigate({
                            request: {
                              action: "entity",
                              urn: field.dataset.urn,
                              fieldPath: field.path,
                            },
                            tab: "schema",
                            title: field.path,
                          })
                        }
                      />
                    </>
                  )}
                  {result.action === "lineage" && (
                    <DataHubCatalogLineage
                      result={result}
                      pages={view.lineagePages}
                      view={view.lineageView}
                      onView={(change) =>
                        setView((current) =>
                          current.request !== view.request
                            ? current
                            : {
                                ...current,
                                lineageView: {
                                  ...current.lineageView,
                                  ...change,
                                },
                              },
                        )
                      }
                      onCenter={(entity) =>
                        navigate(
                          {
                            request: {
                              action: "lineage",
                              urn: entity.urn,
                              direction: result.direction,
                            },
                            tab: "lineage",
                            title: entity.name,
                          },
                          view.graph,
                        )
                      }
                      graph={view.graph}
                      onOpenEntity={entityDetails}
                      onPage={(page) =>
                        setView((v) =>
                          v.request !== view.request
                            ? v
                            : {
                                ...v,
                                lineagePages: [
                                  ...v.lineagePages.filter(
                                    (p) =>
                                      p.entity?.urn !== page.entity?.urn ||
                                      p.pagination.offset !==
                                        page.pagination.offset,
                                  ),
                                  page,
                                ],
                              },
                        )
                      }
                    />
                  )}
                </section>
              )}
              {view.tab === "sources" && (
                <section className={s.section}>
                  <h3>查詢與來源</h3>
                  <dl className={s.definition}>
                    <dt>查詢時間</dt>
                    <dd>{date(result.queriedAt)}</dd>
                    <dt>Schema 建立時間（非來源資料觀測時間）</dt>
                    <dd>{date(result.schemaCreatedAt)}</dd>
                    <dt>Schema 版本</dt>
                    <dd>{result.schemaVersion ?? "未提供"}</dd>
                    <dt>範圍</dt>
                    <dd>
                      {result.action === "fieldLineage"
                        ? "原生欄位映射群組（分頁單位隨方向分列於限制）"
                        : result.action === "lineage"
                          ? "一層原生血緣"
                          : result.action === "search"
                            ? "目前搜尋頁"
                            : "目前資產／schema 頁"}
                    </dd>
                  </dl>
                </section>
              )}
              <section className={s.section}>
                <div className={s.secondary}>
                  查詢於 {date(result.queriedAt)} ·{" "}
                  {result.pagination.total === null
                    ? "可見總數未核定"
                    : `Schema 共 ${result.pagination.total} 欄`}{" "}
                  · 第{" "}
                  {Math.floor(
                    result.pagination.offset / result.pagination.limit,
                  ) + 1}{" "}
                  頁
                </div>
                <ul className={s.secondary}>
                  {result.limitations.map((v) => (
                    <li key={v}>{v}</li>
                  ))}
                </ul>
                <div className={s.actions}>
                  {result.pagination.offset > 0 && (
                    <button
                      onClick={() =>
                        navigate({
                          request: {
                            ...result.request,
                            offset: Math.max(
                              0,
                              result.pagination.offset -
                                result.pagination.limit,
                            ),
                          },
                          tab: view.tab,
                          title: view.title,
                        })
                      }
                    >
                      上一頁
                    </button>
                  )}
                  {result.pagination.nextOffset !== null && (
                    <button
                      onClick={() =>
                        navigate({
                          request: {
                            ...result.request,
                            offset: result.pagination.nextOffset!,
                          },
                          tab: view.tab,
                          title: view.title,
                        })
                      }
                    >
                      下一頁
                    </button>
                  )}
                  <button onClick={refreshCurrent}>重新查詢</button>
                </div>
              </section>
            </>
          )}
        </div>
      </div>
      <nav
        className={s.tabs}
        role="tablist"
        aria-label="資產詳情分類"
        aria-orientation="vertical"
      >
        {shownTabs.map((t, i) => (
          <button
            key={t.id}
            role="tab"
            id={`${panelId}-tab-${t.id}`}
            aria-controls={`${panelId}-panel`}
            title={t.label}
            aria-label={t.label}
            aria-selected={view.tab === t.id}
            tabIndex={view.tab === t.id ? 0 : -1}
            onClick={() => changeTab(t.id)}
            onKeyDown={(event) => {
              if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                event.preventDefault();
                const index =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? shownTabs.length - 1
                      : (i +
                          (event.key === "ArrowDown" ? 1 : -1) +
                          shownTabs.length) %
                        shownTabs.length;
                (
                  event.currentTarget.parentElement?.children[
                    index
                  ] as HTMLElement
                )?.focus();
                changeTab(shownTabs[index].id);
              }
            }}
          >
            <DetailIcon kind={t.id} />
            <span>{t.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

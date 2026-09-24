// Loaded only beneath DataHubCatalog's client boundary; callbacks stay in-client.
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  catalogErrorText,
  queryCatalog,
  type CatalogEntity,
  type CatalogResult,
} from "../lib/catalog-contract";
import {
  catalogEdgeKey as edgeKey,
  observedCatalogLineage,
  observedCatalogPath,
  observedCatalogCycle,
} from "../lib/catalog-lineage";
import { CatalogEntityVisual } from "./DataHubCatalogIcons";
import s from "./DataHubCatalog.module.css";

export type CatalogLineageView = {
  selectedEdge: string | null;
  selectedNode: string | null;
  entityType: string;
  zoom: number;
  scrollLeft: number;
  scrollTop: number;
};
export const initialLineageView: CatalogLineageView = {
  selectedEdge: null,
  selectedNode: null,
  entityType: "",
  zoom: 1,
  scrollLeft: 0,
  scrollTop: 0,
};
const stamp = (value: string | number | null) =>
  value === null ? "未提供" : new Date(value).toLocaleString("zh-TW");

/** Only draw returned edges. Layout coordinates do not encode catalog knowledge.
 * Presentation reference: pinned DataHub lineageV3/NodeWrapper.tsx and common.ts
 * (320px nodes, 12px radius); no Core registry/runtime or mutation controls. */
export function DataHubCatalogLineage({
  result,
  pages,
  onPage,
  onOpenEntity,
  onCenter,
  view,
  onView,
  graph,
}: {
  result: CatalogResult;
  pages: CatalogResult[];
  onPage: (page: CatalogResult) => void;
  onOpenEntity: (entity: CatalogEntity) => void;
  onCenter: (entity: CatalogEntity) => void;
  view: CatalogLineageView;
  onView: (change: Partial<CatalogLineageView>) => void;
  graph: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const { selectedEdge, selectedNode, entityType, zoom } = view;
  const viewport = useRef<HTMLDivElement>(null);
  const controller = useRef<AbortController | null>(null);
  const marker = useId();
  useEffect(() => () => controller.current?.abort(), []);

  // Restore on graph mount/toggle; persisting the current position is idempotent.
  useLayoutEffect(() => {
    if (graph && viewport.current) {
      viewport.current.scrollLeft = view.scrollLeft;
      viewport.current.scrollTop = view.scrollTop;
    }
  }, [graph, view.scrollLeft, view.scrollTop]);
  const model = useMemo(
    () => observedCatalogLineage(result, pages),
    [result, pages],
  );
  const cyclicEdges = useMemo(
    () =>
      new Set(
        [...model.edges.values()]
          .filter((edge) => observedCatalogCycle(model, edge))
          .map(edgeKey),
      ),
    [model],
  );
  const { center, direction, nodes, edges, observed, distance } = model;
  const connected = [...nodes.values()].filter((node) =>
    distance.has(node.urn),
  );
  const types = [...new Set(connected.map((node) => node.type))].sort();
  const visible = connected.filter(
    (node) =>
      !entityType || node.type === entityType || node.urn === center.urn,
  );
  const visibleUrns = new Set(visible.map((node) => node.urn));
  const visibleEdges = [...edges.values()].filter(
    (edge) => visibleUrns.has(edge.from) && visibleUrns.has(edge.to),
  );
  const positions = new Map<string, { x: number; y: number }>();
  const rows = new Map<number, number>();
  const lastLevel = Math.max(
    0,
    ...visible.map((node) => distance.get(node.urn)!),
  );
  // Node width is ported from the pinned UI; spacing/height are presentation only.
  const nodeWidth = 320,
    nodeHeight = 96,
    columnGap = 64,
    rowGap = 32;
  for (const node of visible) {
    const level = distance.get(node.urn)!;
    const row = rows.get(level) ?? 0;
    rows.set(level, row + 1);
    positions.set(node.urn, {
      x:
        (direction === "UPSTREAM" ? lastLevel - level : level) *
          (nodeWidth + columnGap) +
        16,
      y: row * (nodeHeight + rowGap) + 16,
    });
  }
  const width = (lastLevel + 1) * (nodeWidth + columnGap) + 32;
  const height = Math.max(1, ...rows.values()) * (nodeHeight + rowGap) + 32;
  const detail = selectedEdge ? edges.get(selectedEdge) : undefined;
  const path = selectedNode ? observedCatalogPath(model, selectedNode) : [];
  async function expand(node: CatalogEntity) {
    if (controller.current) return;
    const prior = observed.get(node.urn);
    if (prior && prior.pagination.nextOffset === null) return;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(node.urn);
    setFailure(null);
    try {
      const page = await queryCatalog(
        {
          action: "lineage",
          urn: node.urn,
          direction,
          offset: prior?.pagination.nextOffset ?? 0,
          limit: result.pagination.limit,
        },
        abort.signal,
      );
      if (!abort.signal.aborted) onPage(page);
    } catch (error) {
      if (!abort.signal.aborted)
        setFailure(
          error instanceof Error ? error.message : "catalog_request_failed",
        );
    } finally {
      if (controller.current === abort) controller.current = null;
      if (!abort.signal.aborted) setBusy(null);
    }
  }
  return (
    <>
      <p className={s.secondary}>
        只包含本次明確查詢取得的原生關係；每次展開讀取一層、每頁最多{" "}
        {result.pagination.limit}{" "}
        筆。各頁查詢時間不同，不是一致性快照或完整業務影響。
      </p>
      <div className={s.actions}>
        <label>
          篩選已載入資產類型
          <select
            value={entityType}
            onChange={(event) => onView({ entityType: event.target.value })}
          >
            <option value="">所有已載入類型</option>
            {types.map((type) => (
              <option key={type}>{type}</option>
            ))}
          </select>
        </label>
        {graph && (
          <>
            <button onClick={() => onView({ zoom: zoom * 1.2 })}>放大</button>
            <button onClick={() => onView({ zoom: zoom / 1.2 })}>縮小</button>
            <button
              onClick={() => {
                if (viewport.current)
                  onView({ zoom: viewport.current.clientWidth / width });
              }}
            >
              適合寬度
            </button>
          </>
        )}
      </div>
      <p className={s.secondary}>
        {visible.length} 個已顯示資產、{visibleEdges.length}{" "}
        筆關係。虛線涉及原生欄位實體，實線為其他關係。篩選不發出查詢，也不穿越被隱藏的節點補連線。
      </p>
      {graph && (
        <div
          className={s.graphViewport}
          ref={viewport}
          tabIndex={0}
          onScroll={(event) =>
            onView({
              scrollLeft: event.currentTarget.scrollLeft,
              scrollTop: event.currentTarget.scrollTop,
            })
          }
          aria-label="血緣圖，可水平與垂直捲動；下方有等價清單"
        >
          <div style={{ width: width * zoom, height: height * zoom }}>
            <div
              className={s.graphCanvas}
              style={{ width, height, transform: `scale(${zoom})` }}
            >
              <svg
                width={width}
                height={height}
                className={s.graphEdges}
                aria-label="資料流向"
              >
                <defs>
                  <marker
                    id={marker}
                    viewBox="0 0 10 10"
                    refX="10"
                    refY="5"
                    markerWidth="7"
                    markerHeight="7"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
                  </marker>
                </defs>
                {visibleEdges.map((edge) => {
                  const from = positions.get(edge.from)!,
                    to = positions.get(edge.to)!;
                  const x1 = from.x + nodeWidth,
                    y1 = from.y + nodeHeight / 2,
                    x2 = to.x,
                    y2 = to.y + nodeHeight / 2;
                  const bend = (x1 + x2) / 2;
                  // Back edges route below the row rather than inventing another node.
                  const line =
                    x2 > x1
                      ? `M${x1},${y1} C${bend},${y1} ${bend},${y2} ${x2},${y2}`
                      : `M${x1},${y1} C${x1 + columnGap / 2},${y1 + nodeHeight} ${x2 - columnGap / 2},${y2 + nodeHeight} ${x2},${y2}`;
                  const key = edgeKey(edge);
                  return (
                    <path
                      key={key}
                      d={line}
                      markerEnd={`url(#${marker})`}
                      className={
                        selectedEdge === key ? s.graphEdgeSelected : s.graphEdge
                      }
                      strokeDasharray={
                        nodes.get(edge.from)!.type === "SCHEMA_FIELD" ||
                        nodes.get(edge.to)!.type === "SCHEMA_FIELD"
                          ? "6 4"
                          : undefined
                      }
                      role="button"
                      aria-pressed={selectedEdge === key}
                      tabIndex={0}
                      aria-label={`${nodes.get(edge.from)!.name} → ${nodes.get(edge.to)!.name}：${edge.relationship}`}
                      onClick={() => onView({ selectedEdge: key })}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          onView({ selectedEdge: key });
                        }
                      }}
                    />
                  );
                })}
              </svg>
              {visible.map((node) => (
                <button
                  key={node.urn}
                  className={s.graphNode}
                  style={{
                    ...{
                      left: positions.get(node.urn)!.x,
                      top: positions.get(node.urn)!.y,
                    },
                    width: nodeWidth,
                    height: nodeHeight,
                  }}
                  onClick={() => onOpenEntity(node)}
                  title={`${node.name}\n${node.urn}`}
                >
                  <strong>
                    <CatalogEntityVisual entity={node} />
                    {node.name}
                  </strong>
                  <span>
                    {node.type}
                    {node.platform ? ` · ${node.platform}` : ""}
                  </span>
                  <span>{node.qualifiedName ?? node.urn}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      {failure && <p role="status">{catalogErrorText(failure)}</p>}
      {busy && (
        <div role="status">
          正在讀取 {nodes.get(busy)?.name}…{" "}
          <button
            onClick={() => {
              controller.current?.abort();
              controller.current = null;
              setBusy(null);
            }}
          >
            停止等待
          </button>
        </div>
      )}
      <div className={s.scroll}>
        <table className={s.table}>
          <caption>已載入資產與逐層探索</caption>
          <thead>
            <tr>
              <th>資產</th>
              <th>已讀取時間與範圍</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((node) => {
              const page = observed.get(node.urn);
              return (
                <tr key={node.urn}>
                  <td>
                    <button
                      className={s.link}
                      onClick={() => onOpenEntity(node)}
                    >
                      {node.name}
                    </button>
                    <div className={s.secondary}>
                      {node.type} · {node.qualifiedName ?? node.urn}
                    </div>
                  </td>
                  <td>
                    {page ? (
                      <>
                        {stamp(page.queriedAt)}
                        <br />
                        {page.pagination.nextOffset !== null
                          ? "仍有下一頁"
                          : "此查詢未提供下一頁；不代表全域完整"}
                      </>
                    ) : (
                      "尚未展開此資產"
                    )}
                  </td>
                  <td>
                    <button
                      className={s.link}
                      onClick={() => onView({ selectedNode: node.urn })}
                    >
                      已找到路徑
                    </button>
                    <button
                      className={s.link}
                      disabled={
                        busy !== null ||
                        (!!page && page.pagination.nextOffset === null)
                      }
                      onClick={() => void expand(node)}
                    >
                      {page ? "讀取下一頁" : "展開一層"}
                    </button>
                    <button className={s.link} onClick={() => onCenter(node)}>
                      設為中心
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className={s.scroll}>
        <table className={s.table}>
          <caption>已記錄關係，方向與圖相同</caption>
          <thead>
            <tr>
              <th>起點 → 終點</th>
              <th>種類</th>
              <th>依據</th>
            </tr>
          </thead>
          <tbody>
            {visibleEdges.map((edge) => (
              <tr key={edgeKey(edge)}>
                <td>
                  {nodes.get(edge.from)!.name} → {nodes.get(edge.to)!.name}
                  {cyclicEdges.has(edgeKey(edge)) && (
                    <span className={s.chip}>已載入關係形成循環</span>
                  )}
                </td>
                <td>{edge.relationship}</td>
                <td>
                  <button
                    className={s.link}
                    onClick={() => onView({ selectedEdge: edgeKey(edge) })}
                  >
                    關係詳情
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {visibleEdges.length === 0 && (
        <p>在本次已載入及篩選範圍未找到關係；不表示沒有依賴。</p>
      )}
      {detail && (
        <section className={s.section} aria-label="血緣關係詳情">
          <h3>關係詳情</h3>
          <dl className={s.definition}>
            <dt>資料起點</dt>
            <dd>
              <button
                className={s.link}
                onClick={() => onOpenEntity(nodes.get(detail.from)!)}
              >
                {nodes.get(detail.from)!.name}
              </button>
              <div>{detail.from}</div>
            </dd>
            <dt>資料終點</dt>
            <dd>
              <button
                className={s.link}
                onClick={() => onOpenEntity(nodes.get(detail.to)!)}
              >
                {nodes.get(detail.to)!.name}
              </button>
              <div>{detail.to}</div>
            </dd>
            <dt>關係種類</dt>
            <dd>{detail.relationship}</dd>
            <dt>原生關係建立時間</dt>
            <dd>{stamp(detail.createdAt)}</dd>
            <dt>原生關係更新時間</dt>
            <dd>{stamp(detail.updatedAt)}</dd>
            <dt>查詢時間</dt>
            <dd>{stamp(detail.queriedAt)}</dd>
          </dl>
          <p>此讀取未提供轉換公式或多輸入群組語意；不由圖形推論。</p>
          <button
            className={s.link}
            onClick={() => onView({ selectedEdge: null })}
          >
            收起關係詳情
          </button>
        </section>
      )}
      {selectedNode && (
        <section className={s.section} aria-label="已觀測路徑">
          <h3>已找到的一條路徑</h3>
          {path.length ? (
            <ol>
              {path.map((urn) => (
                <li key={urn}>
                  <button
                    className={s.link}
                    onClick={() => onOpenEntity(nodes.get(urn)!)}
                  >
                    {nodes.get(urn)!.name}
                  </button>
                  <div className={s.secondary}>{urn}</div>
                </li>
              ))}
            </ol>
          ) : (
            <p>本次已載入範圍無法連接到此資產；不補造缺失路徑。</p>
          )}
          <p className={s.secondary}>
            以完整已載入集合、按資料流向列出，不受目前圖形類型篩選限制、不窮舉所有路徑；只證明各段曾被查詢取得，不能把它解釋為整條路徑已核准或目前一致。
          </p>
        </section>
      )}
    </>
  );
}

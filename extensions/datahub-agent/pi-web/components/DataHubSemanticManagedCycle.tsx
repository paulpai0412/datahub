import { DataHubSemanticBatchReview } from "./DataHubSemanticBatchReview";

type Target = [string, string | null];
type Scope = {
  sourceUrn: string;
  sourceName: string;
  executionUrn: string;
  datasetCount: number;
  fieldCount: number;
  fingerprint: string;
  checkpointVerified: false;
  completeEnumeratedRecipeScope: true;
  datasets: { urn: string; fields: string[] }[];
};
type ScopeResult = {
  format: "datahub-semantic.preview/1";
  action: "inspect_managed_scope";
  publicationAuthorized: false;
  scope: Scope;
  managedCycle: null | { runUrn: string; taskUrn: string; generation?: number; previousCycleRunUrn?: string };
};
type CycleResult = {
  format: "datahub-semantic.managed-cycle/1";
  runUrn: string;
  taskUrn?: string;
  generation?: number;
  previousCycleRunUrn?: string;
  publicationAuthorized: false;
  sourceUrn: string;
  executionUrn: string;
  status: string;
  datasetCount: number;
  fieldCount: number;
  targetCount: number;
  accountedCount: number;
  missingCount: number;
  exceptionCount: number;
  publicationCount: number;
  pendingCount: number;
  closed: boolean;
  offset: number;
  nextMissingOffset: number | null;
  nextReceiptOffset: number | null;
  missing: Target[];
  exceptions: {
    decisionId: string;
    assetUrn: string;
    fieldPath?: string;
    code: string;
  }[];
  publications: { decisionId: string; status: string; targets: Target[] }[];
  definitionCount?: number;
  definitions?: { decisionId: string; runUrn: string; definitionUrn: string; kind: string; status: string }[];
  retentionCount?: number;
  retentions?: { decisionId: string; assetUrn: string; fieldPaths: (string | null)[]; observedAt: number; status: string }[];
  pending: { decisionId: string; status: string }[];
};
const obj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 1024;
const count = (v: unknown): v is number =>
  Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 1000;
const generation = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 1;
const target = (v: unknown): v is Target =>
  Array.isArray(v) &&
  v.length === 2 &&
  str(v[0]) &&
  (v[1] === null || str(v[1]));
const page = (v: unknown, item: (row: unknown) => boolean): v is unknown[] =>
  Array.isArray(v) && v.length <= 20 && v.every(item);
const bounded = (v: unknown) => {
  try {
    return new TextEncoder().encode(JSON.stringify(v)).length <= 524288;
  } catch {
    return false;
  }
};

export function isManagedScope(v: unknown): v is ScopeResult {
  if (
    !obj(v) ||
    !bounded(v) ||
    v.format !== "datahub-semantic.preview/1" ||
    v.action !== "inspect_managed_scope" ||
    v.publicationAuthorized !== false ||
    !obj(v.scope)
  )
    return false;
  const s = v.scope;
  return (
    s.completeEnumeratedRecipeScope === true &&
    s.checkpointVerified === false &&
    str(s.sourceUrn) &&
    str(s.sourceName) &&
    str(s.executionUrn) &&
    typeof s.fingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(s.fingerprint) &&
    count(s.datasetCount) &&
    count(s.fieldCount) &&
    Array.isArray(s.datasets) &&
    s.datasets.length === s.datasetCount &&
    s.datasets.length <= 16 &&
    s.datasets.every(
      (row) =>
        obj(row) &&
        str(row.urn) &&
        Array.isArray(row.fields) &&
        row.fields.length <= 1000 &&
        row.fields.every(str),
    ) &&
    s.datasets.reduce((total, row) => total + row.fields.length, 0) ===
      s.fieldCount &&
    (v.managedCycle === null ||
      (obj(v.managedCycle) &&
        str(v.managedCycle.runUrn) &&
        str(v.managedCycle.taskUrn) &&
        (v.managedCycle.generation === undefined || generation(v.managedCycle.generation)) &&
        (v.managedCycle.previousCycleRunUrn === undefined || str(v.managedCycle.previousCycleRunUrn))))
  );
}
export function isManagedCycle(v: unknown): v is CycleResult {
  if (
    !obj(v) ||
    !bounded(v) ||
    v.format !== "datahub-semantic.managed-cycle/1" ||
    v.publicationAuthorized !== false ||
    !str(v.runUrn) ||
    !str(v.sourceUrn) ||
    !str(v.executionUrn) ||
    ![
      "SCOPE_ACCOUNTED_WITH_ITEM_RECEIPTS",
      "INCOMPLETE_OR_UNVERIFIED",
    ].includes(String(v.status)) ||
    typeof v.closed !== "boolean" ||
    (v.taskUrn !== undefined && !str(v.taskUrn)) ||
    (v.generation !== undefined && !generation(v.generation)) ||
    (v.previousCycleRunUrn !== undefined && !str(v.previousCycleRunUrn))
  )
    return false;
  if (
    ![
      "datasetCount",
      "fieldCount",
      "targetCount",
      "accountedCount",
      "missingCount",
      "exceptionCount",
      "publicationCount",
      "pendingCount",
      "offset",
    ].every((key) => count(v[key]))
  )
    return false;
  if (
    (v.accountedCount as number) > (v.targetCount as number) ||
    (v.missingCount as number) > (v.targetCount as number) ||
    (v.nextMissingOffset !== null && !count(v.nextMissingOffset)) ||
    (v.nextReceiptOffset !== null && !count(v.nextReceiptOffset))
  )
    return false;
  return (
    page(v.missing, target) &&
    page(
      v.exceptions,
      (row) =>
        obj(row) &&
        str(row.decisionId) &&
        str(row.assetUrn) &&
        (row.fieldPath === undefined || str(row.fieldPath)) &&
        str(row.code),
    ) &&
    page(
      v.publications,
      (row) =>
        obj(row) &&
        str(row.decisionId) &&
        str(row.status) &&
        page(row.targets, target),
    ) &&
    page(v.pending, (row) => obj(row) && str(row.decisionId) && str(row.status)) &&
    ((v.definitionCount === undefined && v.definitions === undefined) ||
      (count(v.definitionCount) && page(v.definitions, (row) => obj(row) && str(row.decisionId) &&
        str(row.runUrn) && str(row.definitionUrn) && ["domain", "node", "term", "tag", "property"].includes(String(row.kind)) &&
        ["VERIFIED", "REJECTED", "PENDING", "UNKNOWN_OR_CHANGED", "UNCONFIRMED", "LINK_UNCONFIRMED"].includes(String(row.status))) &&
        v.definitions.length <= v.definitionCount)) &&
    (v.retentionCount === undefined && v.retentions === undefined ||
      count(v.retentionCount) && page(v.retentions, (row) => obj(row) && str(row.decisionId) && str(row.assetUrn) &&
        Array.isArray(row.fieldPaths) && row.fieldPaths.length > 0 && row.fieldPaths.length <= 8 &&
        row.fieldPaths.every((path) => path === null || str(path)) && Number.isSafeInteger(row.observedAt) &&
        (row.observedAt as number) >= 0 && ["OBSERVED_NO_CHANGE", "CHANGED_OR_UNVERIFIED"].includes(String(row.status))) &&
        v.retentions.length <= v.retentionCount)
  );
}
const targetLabel = ([urn, field]: Target) =>
  `${urn}${field === null ? " · Dataset" : ` · ${field}`}`;

/** Historical tool results are snapshots. This component cannot grant consent or write metadata. */
export function DataHubSemanticManagedCycle({
  result,
}: {
  result: ScopeResult | CycleResult;
}) {
  if (result.format === "datahub-semantic.preview/1") {
    const { scope, managedCycle } = result;
    return (
      <section
        aria-label="DataHub 成功 ingestion 代管範圍"
        style={{
          padding: 12,
          background: "var(--bg-panel)",
          color: "var(--text)",
          overflowWrap: "anywhere",
        }}
      >
        <h3>代管範圍 · 唯讀快照</h3>
        <p>
          <strong>{scope.sourceName}</strong> · {scope.datasetCount} Dataset／
          {scope.fieldCount} 欄
        </p>
        <p>
          成功 Run：<code>{scope.executionUrn}</code>；固定 recipe 與目前 schema
          provenance 已核對，但沒有 checkpoint 或整庫盤點證明。
        </p>
        <p>
          {managedCycle
            ? "有已配置的代管政策；開始輪次仍須可信 Host 再核對。"
            : "未配置輪次寫政策；此結果不能批准或發布。"}
        </p>
        {managedCycle && (
          <p>
            原生輪次：<code>{managedCycle.runUrn}</code> · 第 {managedCycle.generation ?? 1} 輪
            {managedCycle.previousCycleRunUrn && <>；接續已關閉輪次 <code>{managedCycle.previousCycleRunUrn}</code>，仍須 Host Task CAS 入場。</>}
          </p>
        )}
        <details>
          <summary>檢視全部 {scope.datasetCount} 個 Dataset 與欄位</summary>
          <ul>
            {scope.datasets.map((row) => (
              <li key={row.urn}>
                <strong>{row.urn}</strong> · {row.fields.length} 欄
                <details>
                  <summary>欄位清單</summary>
                  <ul>
                    {row.fields.map((field) => (
                      <li key={field}>{field}</li>
                    ))}
                  </ul>
                </details>
              </li>
            ))}
          </ul>
        </details>
        <p>這是儲存於對話的觀測快照；下一步需重新向 Host 讀回。</p>
      </section>
    );
  }
  return (
    <section
      aria-label="DataHub 語義代管輪次收據"
      style={{
        padding: 12,
        background: "var(--bg-panel)",
        color: "var(--text)",
        overflowWrap: "anywhere",
      }}
    >
      <h3>代管輪次 · 第 {result.generation ?? 1} 輪 · {result.closed ? "已關閉" : "未關閉"}</h3>
      {result.previousCycleRunUrn && <p>前輪：<code>{result.previousCycleRunUrn}</code>；沿用政策，但新提案仍需重新盤點與驗證。</p>}
      <p>
        成功 Run：<code>{result.executionUrn}</code>；{result.datasetCount}{" "}
        Dataset／{result.fieldCount} 欄，逐目標總計 {result.targetCount}。
      </p>
      <dl>
        <dt>已核對發布、保留或明列例外</dt>
        <dd>{result.accountedCount}</dd>
        <dt>未有收據</dt>
        <dd>{result.missingCount}</dd>
        <dt>例外／發布／待對帳</dt>
        <dd>
          {result.exceptionCount}／{result.publicationCount}／
          {result.pendingCount}
        </dd>
        <dt>保留觀測（不是發布）</dt>
        <dd>{result.retentionCount ?? 0}</dd>
        <dt>輪次狀態</dt>
        <dd>{result.status}</dd>
      </dl>
      {result.pendingCount > 0 && (
        <p role="status">
          有尚未確認的 attempt／決策；看到目前值不等於可追認 UNKNOWN。不得重送。
        </p>
      )}
      {!result.closed && <DataHubSemanticBatchReview cycleRunUrn={result.runUrn} />}
      <p>
        以下僅第 {result.offset + 1}–{result.offset + 20}{" "}
        筆可見資料，尚有下一頁時請向 Host 查詢 offset；本卡不自行發出寫入。
      </p>
      <details>
        <summary>未有收據（本頁 {result.missing.length}）</summary>
        <ul>
          {result.missing.map((row, i) => (
            <li key={`${row[0]}-${row[1] ?? "dataset"}-${i}`}>
              {targetLabel(row)}
            </li>
          ))}
        </ul>
      </details>
      <details>
        <summary>明列例外（本頁 {result.exceptions.length}）</summary>
        <ul>
          {result.exceptions.map((e) => (
            <li key={e.decisionId}>
              {e.assetUrn}
              {e.fieldPath ? ` · ${e.fieldPath}` : " · Dataset"}：{e.code}
              （Decision {e.decisionId}）
            </li>
          ))}
        </ul>
      </details>
      <details>
        <summary>發布嘗試（本頁 {result.publications.length}）</summary>
        <ul>
          {result.publications.map((p) => (
            <li key={p.decisionId}>
              {p.status} · {p.targets.map(targetLabel).join("；")}（Decision{" "}
              {p.decisionId}）
            </li>
          ))}
        </ul>
      </details>
      {(result.definitions?.length ?? 0) > 0 && <details>
        <summary>共用定義獨立審核（本頁 {result.definitions?.length}／共 {result.definitionCount}；不計入 Dataset／欄位覆蓋）</summary>
        <ul>{result.definitions?.map((item) => <li key={`${item.runUrn}-${item.decisionId}`}>
          {item.kind} · {item.status} · <code>{item.definitionUrn}</code>
          <p>原生審核：<code>{item.runUrn}</code>／Decision <code>{item.decisionId}</code>。請用 read_review 開啟既有可信人審卡；本紀錄不是同意。</p>
        </li>)}</ul>
      </details>}
      {(result.retentions?.length ?? 0) > 0 && <details>
        <summary>保留觀測（本頁 {result.retentions?.length}；不寫 metadata、不代表業務意義已核准）</summary>
        <ul>{result.retentions?.map((item) => <li key={item.decisionId}>
          {item.status} · {item.fieldPaths.map((path) => targetLabel([item.assetUrn, path])).join("；")}
          （觀測時間 epoch ms：{item.observedAt}；Decision {item.decisionId}）
        </li>)}</ul>
      </details>}
      <p>
        {result.nextMissingOffset !== null || result.nextReceiptOffset !== null
          ? "仍有下一頁；本頁不是完整例外清單。"
          : "此類收據已到末頁；仍需重新讀回才代表目前狀態。"}
      </p>
      <p>覆蓋指有逐項收據，並非全部發布，也不是業務意義獲證實。</p>
    </section>
  );
}

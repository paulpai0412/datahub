"use client";

import { isManagedScope } from "./DataHubSemanticManagedCycle";

type MaintenanceItem = {
  assetUrn: string; fieldPath?: string; kind: "description";
  disposition: string; routing: string; before: string | null; after: string | null;
  priorAgent: { status: string; value?: string }; evidence: { id: string; text: string }[];
};
type Evidence = { id: string; text: string };
type Definition = {
  kind: string; urn?: string; proposedUrn?: string; name?: string | null; version?: string;
  description?: string | null; operation?: string; before?: unknown; after?: unknown;
  parent?: unknown; reason?: string; evidence?: Evidence[]; conflicts?: string[];
  impact?: { references: { urn: string; relationship: string }[]; complete: false; note: string } | null;
};
type PriorAgent = {
  status: string; value?: unknown; ownership?: "SELECTED_CHANGE_ONLY";
  mutation?: string; schemaUnchanged?: boolean;
  changedValues?: { added: unknown[]; removed: unknown[] };
  reviewRef?: { runUrn: string; decisionId: string };
};
type Change = {
  priorAgent?: PriorAgent;
  kind: string; fieldPath?: string; value?: string; values?: (string | number)[];
  mutation: "add" | "remove" | "set"; operation: "PROPOSED" | "NO_CHANGE";
  before: unknown; after: unknown; reason: string; evidence: Evidence[]; conflicts: string[];
};
export type CatalogSemanticPreview = {
  contract: "catalog/1"; format: "datahub-semantic.preview/1"; publicationAuthorized: false;
  action: "list_assets" | "inspect_asset" | "inspect_managed_maintenance" | "inspect_definition" | "search_vocabulary" | "preview" | "preview_definition";
  source: { urn: string; name: string; version: string }; asOf: string;
  scope: { basis: "explicit_catalog_selection"; completeSourceInventory: false; ingestionMembershipVerified: false };
  assetUrn?: string; assetType?: string; snapshotDigest?: string; blockers: string[];
  assets?: { urn: string; type: string; name: string }[];
  current?: Record<string, unknown>; definition?: Definition; changes?: Change[];
  vocabulary?: { definitions: Definition[]; nextStart: number | null; complete: false; note: string };
  fields?: { fieldPath: string; nativeType: string | null; sourceDescription: string | null; editedDescription: string | null; tags: string[]; terms: string[]; sourceTags: string[]; sourceTerms: string[] }[];
  totalFields?: number; offset?: number; nextOffset?: number | null;
  evidence?: Evidence[]; selectedField?: { urn: string; fieldPath: string; properties: unknown[] } | null;
  impact?: Definition["impact"]; note?: string;
  managedScope?: { executionUrn: string };
  maintenance?: { items: MaintenanceItem[]; note: string };
};
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const string = (v: unknown): v is string => typeof v === "string";
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(string);
const kinds = ["dataset", "container", "dataFlow", "dataJob", "chart", "dashboard"];
const evidence = (v: unknown) => Array.isArray(v) && v.length > 0 && v.every((e) => record(e) && string(e.id) && string(e.text));
const number = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const priorAgent = (v: unknown) => record(v) &&
  ["NO_AGENT_BASELINE", "NO_SELECTED_AGENT_BASELINE", "UNVERIFIED_AGENT_BASELINE", "VERIFIED_AGENT_BASELINE", "CURRENT_CHANGED"].includes(String(v.status)) &&
  (v.ownership === undefined || v.ownership === "SELECTED_CHANGE_ONLY") &&
  (v.schemaUnchanged === undefined || typeof v.schemaUnchanged === "boolean") &&
  (v.mutation === undefined || ["add", "remove", "set"].includes(String(v.mutation))) &&
  (v.changedValues === undefined || record(v.changedValues) && Array.isArray(v.changedValues.added) && Array.isArray(v.changedValues.removed)) &&
  (v.reviewRef === undefined || record(v.reviewRef) && string(v.reviewRef.runUrn) && string(v.reviewRef.decisionId));

export function isCatalogSemanticPreview(v: unknown): v is CatalogSemanticPreview {
  try { if (new TextEncoder().encode(JSON.stringify(v)).length > 524288) return false; } catch { return false; }
  if (!record(v) || v.contract !== "catalog/1" || v.format !== "datahub-semantic.preview/1" || v.publicationAuthorized !== false ||
      !record(v.source) || !string(v.source.urn) || !string(v.source.name) || !string(v.source.version) || !string(v.asOf) ||
      !record(v.scope) || v.scope.basis !== "explicit_catalog_selection" || v.scope.completeSourceInventory !== false || v.scope.ingestionMembershipVerified !== false || !strings(v.blockers)) return false;
  if (v.action === "list_assets") return Array.isArray(v.assets) && v.assets.length <= 20 && v.assets.every((a) => record(a) && string(a.urn) && kinds.includes(String(a.type)) && string(a.name)) && number(v.offset) && (v.nextOffset === null || number(v.nextOffset));
  if (!string(v.assetUrn) || !kinds.includes(String(v.assetType)) || !v.assetUrn.startsWith(`urn:li:${v.assetType}:`) || !string(v.snapshotDigest) || !/^[a-f0-9]{64}$/.test(v.snapshotDigest)) return false;
  if (v.selectedField !== undefined && v.selectedField !== null && (!record(v.selectedField) || !string(v.selectedField.urn) || !string(v.selectedField.fieldPath) || !Array.isArray(v.selectedField.properties))) return false;
  if (v.action === "inspect_managed_maintenance") return isManagedScope({ format: v.format, action: "inspect_managed_scope", publicationAuthorized: false,
      scope: v.managedScope, managedCycle: null }) &&
    record(v.managedScope) && v.managedScope.sourceUrn === v.source.urn && v.assetType === "dataset" &&
    Array.isArray(v.managedScope.datasets) && v.managedScope.datasets.some((row) => record(row) && row.urn === v.assetUrn) &&
    number(v.offset) && number(v.totalFields) && v.offset <= v.totalFields &&
    (v.nextOffset === null ? v.offset + 20 >= v.totalFields : number(v.nextOffset) && v.nextOffset === v.offset + 20 && v.nextOffset < v.totalFields) &&
    record(v.maintenance) && string(v.maintenance.note) && Array.isArray(v.maintenance.items) &&
    v.maintenance.items.length <= (v.offset === 0 ? 21 : 20) && v.maintenance.items.every((item) =>
      record(item) && item.assetUrn === v.assetUrn && item.kind === "description" &&
      (item.fieldPath === undefined || string(item.fieldPath)) &&
      ["ADD", "UPDATE_AGENT", "KEEP", "REVIEW_HUMAN_OR_CHANGED_VALUE", "INSUFFICIENT_EVIDENCE", "AMBIGUOUS_MEANING"].includes(String(item.disposition)) &&
      ["NEEDS_EVIDENCE", "NO_WRITE", "READ_ONLY", "POLICY_DENIED", "HUMAN_REVIEW", "OPERATOR_POLICY", "BLOCKED_UNVERIFIED_ATTEMPT"].includes(String(item.routing)) &&
      [item.before, item.after].every((value) => value === null || string(value)) &&
      record(item.priorAgent) && string(item.priorAgent.status) &&
      Array.isArray(item.evidence) && item.evidence.every((entry) => record(entry) && string(entry.id) && string(entry.text)));
  if (v.action === "inspect_asset") return record(v.current) && number(v.totalFields) && number(v.offset) && Array.isArray(v.fields) && v.fields.length <= 20 && v.offset + v.fields.length <= v.totalFields &&
    (v.nextOffset === null ? v.offset + v.fields.length === v.totalFields : number(v.nextOffset) && v.nextOffset === v.offset + v.fields.length && v.nextOffset < v.totalFields) &&
    v.fields.every((f) => record(f) && string(f.fieldPath) && [f.nativeType, f.sourceDescription, f.editedDescription].every((s) => s === null || string(s)) && [f.tags, f.terms, f.sourceTags, f.sourceTerms].every(strings));
  if (v.action === "search_vocabulary") return record(v.vocabulary) && v.vocabulary.complete === false && string(v.vocabulary.note) && Array.isArray(v.vocabulary.definitions) && v.vocabulary.definitions.length <= 20 &&
    v.vocabulary.definitions.every((d) => record(d) && string(d.kind) && string(d.urn) && string(d.version) && (d.name === null || string(d.name))) && (v.vocabulary.nextStart === null || number(v.vocabulary.nextStart));
  if (v.action === "inspect_definition" || v.action === "preview_definition") {
    const d = v.definition;
    if (!record(d) || !["domain", "node", "term", "tag", "property"].includes(String(d.kind))) return false;
    if (v.action === "inspect_definition") return string(d.urn) && string(d.version) && (d.name === null || string(d.name));
    return string(d.name) && string(d.proposedUrn) && ["PROPOSED_CREATE", "PROPOSED_UPDATE"].includes(String(d.operation)) && Object.hasOwn(d, "before") && record(d.after) && string(d.reason) && evidence(d.evidence) && strings(d.conflicts) && d.requiresHumanReview === true && d.businessMeaningVerified === false;
  }
  return v.action === "preview" && Array.isArray(v.changes) && v.changes.length > 0 && v.changes.length <= 1024 && v.changes.every((c) => record(c) &&
    ["description", "domain", "tag", "term", "property"].includes(String(c.kind)) && ["add", "remove", "set"].includes(String(c.mutation)) &&
    ["NO_CHANGE", "PROPOSED"].includes(String(c.operation)) && (c.fieldPath === undefined || string(c.fieldPath)) && Object.hasOwn(c, "before") && Object.hasOwn(c, "after") && (c.priorAgent === undefined || priorAgent(c.priorAgent)) && string(c.reason) && evidence(c.evidence) && strings(c.conflicts) && c.requiresHumanReview === true && c.businessMeaningVerified === false);
}

function Value({ value }: { value: unknown }) {
  return <pre style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "inherit" }}>{value == null ? "（未填）" : typeof value === "string" ? value : JSON.stringify(value, null, 2)}</pre>;
}
const operation = { add: "新增關聯", remove: "移除所選值", set: "設定／替換所選值" };
export function DataHubSemanticCatalogPreview({ preview: p }: { preview: CatalogSemanticPreview }) {
  const definition = p.definition;
  return <section aria-label="DataHub Catalog 語義差異預覽" style={{ padding: 12, background: "var(--bg-panel)", color: "var(--text)", minWidth: 0, overflowWrap: "anywhere" }}>
    <h3>Catalog 語義維護 · {p.action === "preview_definition" ? "詞彙定義差異" : p.action === "preview" ? "資產差異" : "目前資訊"}</h3>
    <p><strong>尚未核准／發布。</strong> {p.maintenance ? "候選仍須由可信 Host 核政策；需判斷者送真人審核。" : "Agent 提出候選，最後由你核對業務意義。"}</p>
    <dl><dt>來源範圍</dt><dd>{p.source.name} · v{p.source.version}</dd>{p.assetUrn && <><dt>資產 · {p.assetType}</dt><dd>{p.assetUrn}</dd></>}<dt>觀測時間</dt><dd>{p.asOf}</dd></dl>
    <p>{p.managedScope ? `已核成功 ingestion ${p.managedScope.executionUrn} 的指定 Dataset；不是整庫盤點。` : "指定 Catalog 子集；不宣稱完整來源 inventory，也不把非 Dataset 說成同次 ingestion 成員。"}</p>
    {p.maintenance && <section aria-label="有依據的維護提案">
      <h4>盤點 → 維護提案（尚未執行）</h4>
      {p.maintenance.items.map((item) => <article key={item.fieldPath ?? "dataset"} style={{ marginTop: 12, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
        <h5>{item.fieldPath ?? "Dataset"} · {item.disposition}</h5>
        <p>處理：{item.routing}；影響限此 Dataset／欄位說明，不修改共用定義。</p>
        <dl><dt>prior-Agent</dt><dd><Value value={item.priorAgent.value ?? item.priorAgent.status} /></dd>
          <dt>current</dt><dd><Value value={item.before} /></dd><dt>new</dt><dd><Value value={item.after} /></dd></dl>
        <details><summary>可追溯證據</summary><ul>{item.evidence.map((entry) => <li key={entry.id}>{entry.id}<Value value={entry.text} /></li>)}</ul></details>
      </article>)}
      <p>{p.maintenance.note}</p>
    </section>}
    {p.assets && <ul>{p.assets.map((a) => <li key={a.urn}><strong>{a.name}</strong> · {a.type}<p>{a.urn}</p></li>)}</ul>}
    {p.vocabulary && <section><h4>既有詞彙（有界搜尋）</h4><ul>{p.vocabulary.definitions.map((d) => <li key={d.urn}><strong>{d.name ?? d.urn}</strong> · {d.kind} · v{d.version}<Value value={d} /></li>)}</ul><p>{p.vocabulary.note}</p>{p.vocabulary.nextStart !== null && <p>還有下一頁；搜尋不是全域唯一性證明。</p>}</section>}
    {p.current && <details><summary>現有資產語義</summary><Value value={p.current} /></details>}
    {p.fields && p.fields.length > 0 && <div role="region" aria-label="Catalog 欄位語義表" tabIndex={0} style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", minWidth: 620, borderCollapse: "collapse" }}><caption>欄位 {p.offset! + 1}–{p.offset! + p.fields.length}／{p.totalFields}</caption>
        <thead><tr><th scope="col">欄位</th><th scope="col">来源說明</th><th scope="col">目前編輯值</th><th scope="col">Terms／Tags</th></tr></thead>
        <tbody>{p.fields.map((f) => <tr key={f.fieldPath}><th scope="row">{f.fieldPath}<small style={{ display: "block" }}>{f.nativeType}</small></th><td><Value value={f.sourceDescription} /></td><td><Value value={f.editedDescription} /></td><td><Value value={[...f.tags, ...f.terms, ...f.sourceTags, ...f.sourceTerms]} /></td></tr>)}</tbody></table>
    </div>}
    {p.nextOffset != null && <p>還有下一頁；目前不是完整盤點。</p>}
    {p.selectedField && <details><summary>選定欄位 Structured Properties：{p.selectedField.fieldPath}</summary><Value value={p.selectedField.properties} /></details>}
    {definition && <article>
      <h4>{definition.name ?? definition.urn} · {definition.kind} · {definition.operation === "PROPOSED_UPDATE" ? "更新同一既有定義" : definition.operation === "PROPOSED_CREATE" ? "新增定義" : "既有定義"}</h4>
      <p>{definition.proposedUrn ?? definition.urn}</p>
      {definition.operation ? <><dl><dt>Before</dt><dd><Value value={definition.before} /></dd><dt>After</dt><dd><Value value={definition.after} /></dd></dl>
        <p>理由：{definition.reason}</p><p>定義維護與資產套用分開。更新共用定義會影響其他引用它的資產；本輪依賴觀測不是全域完整清單。</p></> : <Value value={definition} />}
      {!!definition.conflicts?.length && <p role="alert">有同名詞彙／衝突，不能直接發布：{definition.conflicts.join("、")}</p>}
      {definition.evidence && <details><summary>定義依據</summary><ul>{definition.evidence.map((e) => <li key={e.id}>{e.id}<Value value={e.text} /></li>)}</ul></details>}
    </article>}
    {p.changes?.map((c, i) => <article key={i} style={{ marginTop: 12, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
      <h4>{c.fieldPath ?? "資產層級"} · {c.kind} · {operation[c.mutation]}</h4>
      <p>{c.operation === "NO_CHANGE" ? "無差異，未寫入" : "待你核准的精確變更"}</p>
      <dl>
        {c.priorAgent && <><dt>prior-Agent · {c.priorAgent.status}</dt><dd><Value value={c.priorAgent.value ?? c.priorAgent.status} /></dd></>}
        <dt>current · Before</dt><dd><Value value={c.before} /></dd><dt>new · After</dt><dd><Value value={c.after} /></dd>
      </dl>
      {c.priorAgent?.ownership === "SELECTED_CHANGE_ONLY" && <p>先前核准結果僅供比對，不取得整個集合／Aspect 所有權；被保留的人工關聯仍受保護。</p>}
      {c.priorAgent?.changedValues && <details><summary>先前實際改動（不包含原樣保留的成員）</summary><Value value={c.priorAgent.changedValues} /></details>}
      {c.priorAgent?.reviewRef && <p>先前原生審核：<code>{c.priorAgent.reviewRef.runUrn}</code>／<code>{c.priorAgent.reviewRef.decisionId}</code></p>}
      <p>理由：{c.reason}</p>{c.fieldPath && <p>僅修改 editable 語義；來源 schema、原始註解／Terms／Tags 保留。</p>}
      <details><summary>變更依據</summary><ul>{c.evidence.map((e) => <li key={e.id}>{e.id}<Value value={e.text} /></li>)}</ul></details>
    </article>)}
    <details><summary>限制與快照</summary><p>{p.snapshotDigest}</p><p>{p.note}</p><ul>{p.blockers.map((b) => <li key={b}>{b}</li>)}</ul></details>
  </section>;
}

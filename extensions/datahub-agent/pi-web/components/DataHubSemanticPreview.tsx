"use client";

/** Presentation only. Stored tool details never grant approval or write authority. */
type Evidence = { id: string; text: string };
type Field = {
  fieldPath: string;
  nativeType: string | null;
  sourceDescription: string | null;
  editedDescription: string | null;
  tags: string[];
  sourceTags: string[];
  terms: string[];
  sourceTerms: string[];
};
type Change = {
  kind: string;
  fieldPath?: string;
  value: string;
  before: unknown;
  after: unknown;
  reason: string;
  operation: "NO_CHANGE" | "PROPOSED";
  conflicts: string[];
  evidence: Evidence[];
  requiresHumanReview: true;
  businessMeaningVerified: false;
};
type VocabularyDefinition = { urn: string; name: string | null; description: string | null; version: string };
type DefinitionProposal = {
  kind: string; name: string; proposedUrn: string; aspect: string; value: Record<string, unknown>;
  reason: string; evidence: Evidence[]; conflicts: string[]; blockers: string[];
  operation: "PROPOSED_CREATE_ONLY"; requiresHumanReview: true; businessMeaningVerified: false;
  existingDefinitionsMayNotBeUpdated: true;
  duplicateCheck: { definitions: VocabularyDefinition[]; duplicateAbsenceVerified: false; sharedDefinitionImpactVerified: false; nextStart: number | null };
};
export type SemanticPreview = {
  format: "datahub-semantic.preview/1";
  action: "inspect_dataset" | "preview" | "preview_definition" | "inspect_impact";
  publicationAuthorized: false;
  asOf: string;
  source: { urn: string; name: string; version: string };
  scope: { basis: "operator_allowlist_subset" | "native_checkpoint_reconciled_operator_scope"; ingestionMembershipVerified: boolean; completeSourceInventory: boolean; datasetUrns: string[];
    inventory?: { status: string; digest?: string; jobUrn?: string; executionUrn?: string; timestampMillis?: number; datasetCount?: number } };
  datasetUrn: string;
  snapshotDigest: string;
  blockers: string[];
  note: string;
  current?: Record<string, unknown>;
  fields?: Field[];
  totalFields?: number;
  offset?: number;
  nextOffset?: number | null;
  changes?: Change[];
  definition?: DefinitionProposal;
  selectedField?: { urn: string; fieldPath: string; materialized: boolean; propertiesVersion: string; properties: { propertyUrn: string; values: (string | number)[] }[] } | null;
  impact?: { definition: VocabularyDefinition; basis: string; start: number; nextStart: number | null; searchWindowExhausted: boolean;
    hiddenOrUnapprovedReferencesOmitted: boolean; sharedDefinitionImpactVerified: false; sharedDefinitionUpdateAuthorized: false; limitations: string[];
    references: { urn: string; relationship: string; sourceUrns: string[]; scope: string; outsideContextDataset: boolean }[] };
  membership?: { status: "NATIVE_RUN_MATCH" | "UNVERIFIED"; datasetUrn: string; completeSourceInventory: false };
};
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const string = (v: unknown): v is string => typeof v === "string";
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(string);
const nullableString = (v: unknown) => v === null || string(v);
const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

export function isSemanticPreview(v: unknown): v is SemanticPreview {
  try {
    if (new TextEncoder().encode(JSON.stringify(v)).length > 48000) return false;
  } catch { return false; }
  if (!record(v) || v.format !== "datahub-semantic.preview/1" || v.publicationAuthorized !== false ||
      !["inspect_dataset", "preview", "preview_definition", "inspect_impact"].includes(String(v.action)) || !string(v.asOf) ||
      !record(v.source) || !string(v.source.urn) || !string(v.source.name) || !string(v.source.version) ||
      !record(v.scope) || !["operator_allowlist_subset", "native_checkpoint_reconciled_operator_scope"].includes(String(v.scope.basis)) ||
      typeof v.scope.completeSourceInventory !== "boolean" || v.scope.ingestionMembershipVerified !== v.scope.completeSourceInventory || !strings(v.scope.datasetUrns) ||
      !string(v.datasetUrn) || !v.scope.datasetUrns.includes(v.datasetUrn) ||
      !string(v.snapshotDigest) || !/^[a-f0-9]{64}$/.test(v.snapshotDigest) || !strings(v.blockers) || !string(v.note)) return false;
  if (v.scope.completeSourceInventory) {
    const i = v.scope.inventory;
    if (v.scope.basis !== "native_checkpoint_reconciled_operator_scope" || !record(i) || i.status !== "NATIVE_CHECKPOINT_MATCH" ||
        !string(i.digest) || !/^[a-f0-9]{64}$/.test(i.digest) || !string(i.jobUrn) || !i.jobUrn.startsWith("urn:li:dataJob:") ||
        !string(i.executionUrn) || !i.executionUrn.startsWith("urn:li:dataHubExecutionRequest:") ||
        !integer(i.timestampMillis) || i.timestampMillis === 0 || i.timestampMillis > 8640000000000000 ||
        i.datasetCount !== v.scope.datasetUrns.length || i.datasetCount === 0) return false;
  } else if (v.scope.basis !== "operator_allowlist_subset") return false;
  if (v.membership !== undefined && (!record(v.membership) || !["NATIVE_RUN_MATCH", "UNVERIFIED"].includes(String(v.membership.status)) ||
      v.membership.datasetUrn !== v.datasetUrn || v.membership.completeSourceInventory !== false)) return false;
  if (v.selectedField !== undefined && v.selectedField !== null) {
    const f = v.selectedField;
    if (!record(f) || !string(f.urn) || !string(f.fieldPath) || typeof f.materialized !== "boolean" || !string(f.propertiesVersion) ||
        !Array.isArray(f.properties) || !f.properties.every((p) => record(p) && string(p.propertyUrn) && Array.isArray(p.values) &&
          p.values.every((x) => string(x) || (typeof x === "number" && Number.isFinite(x))))) return false;
  }
  if (v.action === "inspect_impact") {
    const p = v.impact;
    return record(p) && record(p.definition) && string(p.definition.urn) && nullableString(p.definition.name) && string(p.definition.version) &&
      string(p.basis) && integer(p.start) && (p.nextStart === null || integer(p.nextStart)) && typeof p.searchWindowExhausted === "boolean" &&
      typeof p.hiddenOrUnapprovedReferencesOmitted === "boolean" && p.sharedDefinitionImpactVerified === false && p.sharedDefinitionUpdateAuthorized === false && strings(p.limitations) &&
      Array.isArray(p.references) && p.references.length <= 20 && p.references.every((r) => record(r) && string(r.urn) && string(r.relationship) && strings(r.sourceUrns) && string(r.scope) && typeof r.outsideContextDataset === "boolean");
  }
  if (v.action === "preview_definition") {
    const d = v.definition;
    return record(d) && ["domain", "node", "term", "tag", "property"].includes(String(d.kind)) && string(d.name) && string(d.proposedUrn) &&
      string(d.aspect) && record(d.value) && string(d.reason) && strings(d.conflicts) && strings(d.blockers) &&
      d.operation === "PROPOSED_CREATE_ONLY" && d.requiresHumanReview === true && d.businessMeaningVerified === false && d.existingDefinitionsMayNotBeUpdated === true &&
      Array.isArray(d.evidence) && d.evidence.length > 0 && d.evidence.every((e) => record(e) && string(e.id) && string(e.text)) &&
      record(d.duplicateCheck) && d.duplicateCheck.duplicateAbsenceVerified === false && d.duplicateCheck.sharedDefinitionImpactVerified === false &&
      (d.duplicateCheck.nextStart === null || integer(d.duplicateCheck.nextStart)) &&
      Array.isArray(d.duplicateCheck.definitions) && d.duplicateCheck.definitions.length <= 20 &&
      d.duplicateCheck.definitions.every((ref) => record(ref) && string(ref.urn) && nullableString(ref.name) && nullableString(ref.description) && string(ref.version));
  }
  if (v.action === "inspect_dataset") {
    return record(v.current) && integer(v.totalFields) && integer(v.offset) && v.offset <= v.totalFields &&
      Array.isArray(v.fields) && v.fields.length <= 20 && v.offset + v.fields.length <= v.totalFields &&
      (v.nextOffset === null ? v.offset + v.fields.length === v.totalFields :
        integer(v.nextOffset) && v.nextOffset === v.offset + v.fields.length && v.nextOffset > v.offset && v.nextOffset < v.totalFields) &&
      v.fields.every((f) => record(f) && string(f.fieldPath) && nullableString(f.nativeType) &&
        nullableString(f.sourceDescription) && nullableString(f.editedDescription) &&
        strings(f.tags) && strings(f.sourceTags) && strings(f.terms) && strings(f.sourceTerms));
  }
  return Array.isArray(v.changes) && v.changes.length > 0 && v.changes.length <= 8 && v.changes.every((c) =>
    record(c) && ["description", "domain", "tag", "term", "property", "owner", "documentation"].includes(String(c.kind)) &&
    (c.fieldPath === undefined || string(c.fieldPath)) && string(c.value) && string(c.reason) &&
    Object.hasOwn(c, "before") && Object.hasOwn(c, "after") && ["NO_CHANGE", "PROPOSED"].includes(String(c.operation)) &&
    c.requiresHumanReview === true && c.businessMeaningVerified === false && strings(c.conflicts) &&
    Array.isArray(c.evidence) && c.evidence.length > 0 && c.evidence.every((e) => record(e) && string(e.id) && string(e.text)));
}

function DisplayValue({ value }: { value: unknown }) {
  return <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: 0, fontFamily: "inherit" }}>
    {value === null || value === undefined ? "（未填）" : typeof value === "string" ? value : JSON.stringify(value, null, 2)}
  </pre>;
}

export function DataHubSemanticPreview({ preview: p }: { preview: SemanticPreview }) {
  return <section aria-label="DataHub 語義差異預覽" style={{ padding: 12, background: "var(--bg-panel)", color: "var(--text)", overflowWrap: "anywhere", minWidth: 0 }}>
    <h3 style={{ margin: "0 0 8px" }}>語義維護 · {p.action === "inspect_impact" ? "共用定義影響" : p.action === "preview_definition" ? "新定義提案" : p.action === "preview" ? "差異預覽" : "Catalog 盤點"}</h3>
    <p><strong>唯讀・尚未核准／發布</strong>。已填值或引用存在，不代表業務語義已驗證。</p>
    <dl>
      <dt>來源</dt><dd>{p.source.name} · v{p.source.version}</dd>
      <dt>資產</dt><dd>{p.datasetUrn}</dd>
      <dt>觀測時間</dt><dd>{p.asOf}</dd>
      <dt>範圍</dt><dd>{p.scope.completeSourceInventory
        ? `核准範圍與原生 checkpoint 的 ${p.scope.inventory!.datasetCount} 個 Dataset 完整相符；僅指該次成功 Run，不包含所有歷史 Catalog 或來源 DB 物件。`
        : "操作員核准子集；非完整 ingestion 清單。"}</dd>
      {p.scope.completeSourceInventory && <><dt>Checkpoint 時間</dt><dd>{new Date(p.scope.inventory!.timestampMillis!).toISOString()}</dd></>}
      <dt>本資產來源對帳</dt><dd>{p.membership?.status === "NATIVE_RUN_MATCH"
        ? "原生成功 Run、核准 recipe 與本資產 schema provenance 相符；不代表全來源完整或業務語義正確。"
        : "來源成員尚未驗證。"}</dd>
    </dl>
    {p.blockers.length > 0 && <details><summary>尚未完成的條件（{p.blockers.length}）</summary><ul>
      {p.blockers.map((b, i) => <li key={i}>{b}</li>)}
    </ul></details>}
    {p.action === "inspect_dataset" && <>
      <details><summary>現有表級語義</summary><DisplayValue value={p.current} /></details>
      <p>本頁欄位 {p.fields!.length ? p.offset! + 1 : 0}–{p.offset! + p.fields!.length}／{p.totalFields}
        {p.nextOffset !== null ? "；還有下一頁，不能宣稱盤點完成。" : "；此資產欄位頁面已到末頁。"}</p>
      <div role="region" aria-label="欄位語義表，可水平捲動" tabIndex={0} style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", minWidth: 640, borderCollapse: "collapse" }}>
          <caption>欄位說明與既有詞彙（不修改原值）</caption>
          <thead><tr><th scope="col">欄位</th><th scope="col">來源說明</th><th scope="col">人工／既有編輯</th><th scope="col">Tags／Terms</th></tr></thead>
          <tbody>{p.fields!.map((f) => <tr key={f.fieldPath}>
            <th scope="row">{f.fieldPath}<small style={{ display: "block" }}>{f.nativeType}</small></th>
            <td><DisplayValue value={f.sourceDescription} /></td><td><DisplayValue value={f.editedDescription} /></td>
            <td><DisplayValue value={[...new Set([...f.sourceTags, ...f.tags, ...f.sourceTerms, ...f.terms])]} /></td>
          </tr>)}</tbody>
        </table>
      </div>
    </>}
    {p.selectedField && <details><summary>選定欄位屬性：{p.selectedField.fieldPath}</summary>
      <p>{p.selectedField.urn} · v{p.selectedField.propertiesVersion}</p>
      {!p.selectedField.materialized && <p>原生 schemaField 身分尚未確認；未讀到 key 不代表實體不存在，也不代表已發布成功。</p>}
      <DisplayValue value={p.selectedField.properties} />
    </details>}
    {p.action === "inspect_impact" && p.impact && <article>
      <h4>{p.impact.definition.name ?? p.impact.definition.urn} · v{p.impact.definition.version}</h4>
      <p><strong>這是可見原生依賴，不是全域修改授權。</strong> 單一來源的核准不能批准修改共用定義。</p>
      {p.impact.hiddenOrUnapprovedReferencesOmitted && <p>有無法顯示或未獲模型傳送授權的依賴；未揭露其識別。</p>}
      <ul>{p.impact.references.map((r, i) => <li key={i}>{r.urn} · {r.relationship}{r.outsideContextDataset && " · 目前資產以外"}</li>)}</ul>
      <p>{p.impact.nextStart !== null ? "還有下一頁，必須沿用 definitionVersion。" : "本次搜尋頁面已到末頁或窗口上限；不代表全域完整。"}</p>
      <details><summary>影響查詢限制</summary><DisplayValue value={p.impact.limitations} /></details>
    </article>}
    {p.action === "preview_definition" && p.definition && <article style={{ marginTop: 12 }}>
      <h4>{p.definition.name} · {p.definition.kind} · 待審新增定義</h4>
      <p>定義與資產掛載分開；不得藉此修改任何既有共用定義，也沒有取得建立或發布權限。</p>
      {p.definition.conflicts.length > 0 && <p><strong>找到同名詞彙，應先審查重用，不能直接另建。</strong></p>}
      <p>理由：{p.definition.reason}</p>
      <details><summary>原生格式草稿（尚未驗證可建立）</summary><p>{p.definition.proposedUrn}</p><DisplayValue value={p.definition.value} /></details>
      <details><summary>重用候選（{p.definition.duplicateCheck.definitions.length}）</summary>
        <p>搜尋不保證無重複，亦未完成共用定義影響分析。{p.definition.duplicateCheck.nextStart !== null && "搜尋還有下一頁。"}</p>
        <ul>{p.definition.duplicateCheck.definitions.map((d) => <li key={d.urn}><strong>{d.name ?? d.urn}</strong><p>{d.urn} · v{d.version}</p><DisplayValue value={d.description} /></li>)}</ul>
      </details>
      <details><summary>查看新定義依據（意義仍待審）</summary><ul>{p.definition.evidence.map((e) => <li key={e.id}><code>{e.id}</code><DisplayValue value={e.text} /></li>)}</ul></details>
      <ul>{p.definition.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
    </article>}
    {p.changes?.map((c, i) => <article key={i} style={{ marginTop: 12, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
      <h4 style={{ margin: "0 0 8px" }}>{c.fieldPath ?? "表級"} · {c.kind} · {c.operation === "NO_CHANGE" ? "無差異（未寫入）" : "待審候選"}</h4>
      {c.kind !== "description" && <p>{c.value}</p>}
      {c.conflicts.length > 0 && <p><strong>既有編輯值受保護；需處理衝突，不會自動覆寫。</strong></p>}
      <dl><dt>目前值</dt><dd><DisplayValue value={c.before} /></dd><dt>建議值</dt><dd><DisplayValue value={c.after} /></dd></dl>
      <p>理由：{c.reason}</p>
      <details><summary>查看依據（位置已核對，意義仍待審）</summary><ul>
        {c.evidence.map((e, n) => <li key={n}><code>{e.id}</code><DisplayValue value={e.text} /></li>)}
      </ul></details>
    </article>)}
    <details style={{ marginTop: 12 }}><summary>快照與限制</summary><p>{p.snapshotDigest}</p><p>{p.note}</p></details>
  </section>;
}

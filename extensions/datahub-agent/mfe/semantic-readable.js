/** Human-readable presentation of exact native values. No interpretation of
 * source text as HTML/instructions, inferred meaning or replacement payloads. */
export const kindLabel = kind => ({ description: "說明", domain: "資料領域", node: "詞彙群組", term: "詞彙", tag: "標籤", property: "結構化屬性" })[kind] ?? kind ?? "中繼資料";
export const stateLabel = state => ({ PENDING: "待確認", APPROVE: "已確認，待執行", VERIFIED: "已核對", VERIFIED_CURRENT_CHANGED: "目前內容已變更", KEEP: "保留", GAP: "缺少依據", DEFERRED: "暫緩", OBSERVATION_CHANGED: "觀測已變更", ATTEMPTED_UNVERIFIED: "已派送，結果未確認", UNCONFIRMED: "未確認" })[state] ?? state;
const labels = { name: "名稱", description: "說明", parent: "上層", parentNode: "上層詞彙群組", parentDomain: "上層資料領域", parentUrn: "上層定義", version: "版本", digest: "版本摘要", initialOutcome: "原始派送結果", currentReadback: "目前原生核對", currentContext: "目前來源與 schema", domain: "資料領域", domains: "資料領域", terms: "詞彙", tags: "標籤", tag: "標籤", term: "詞彙", properties: "屬性", structuredProperties: "結構化屬性", values: "值", value: "值", allowedValues: "允許值", valueType: "值類型", cardinality: "數量限制", entityTypes: "適用資產類型", propertyUrn: "屬性", urn: "原生定位", status: "狀態", operation: "操作", action: "操作", mutation: "更新方式", fieldPath: "欄位", sourceUrn: "來源定位", assetUrn: "資產定位", datasetUrn: "資料集定位", maintenanceRunUrn: "原計畫定位", runUrn: "執行定位", requestId: "原請求定位", itemId: "項目定位", count: "數量", total: "總數", observedAt: "觀測時間", asOf: "觀測時間", complete: "完整性", limit: "限制", reason: "原因" };
export function assetLabel(urn) {
  if (typeof urn !== "string") return "資產";
  const dataset = /^urn:li:dataset:\(urn:li:dataPlatform:[^,]+,(.*),[^,)]+\)$/.exec(urn);
  return dataset?.[1] ?? urn.replace(/^urn:li:[^:]+:/, "");
}
function node(tag, message, parent) {
  const el = document.createElement(tag); if (message !== undefined) el.textContent = String(message);
  el.style.overflowWrap = "anywhere"; parent.append(el); return el;
}
export function appendReadableValue(parent, value, names = new Map()) {
  if (value === null || value === undefined) { node("span", "尚未設定", parent); return; }
  if (Array.isArray(value)) {
    if (!value.length) { node("span", "無", parent); return; }
    const list = node("ul", undefined, parent); list.style.cssText = "margin:4px 0;padding-left:20px";
    for (const entry of value) appendReadableValue(node("li", undefined, list), entry, names);
  } else if (typeof value === "object") {
    const entries = Object.entries(value);
    if (!entries.length) { node("span", "無明列值", parent); return; }
    const dl = node("dl", undefined, parent); dl.style.cssText = "margin:4px 0;display:grid;grid-template-columns:minmax(60px,auto) minmax(0,1fr);gap:6px 12px";
    for (const [key, val] of entries) {
      node("dt", labels[key] ?? key, dl).style.fontWeight = "600";
      const dd = node("dd", undefined, dl); dd.style.margin = "0"; appendReadableValue(dd, val, names);
    }
  } else if (typeof value === "string" && value.startsWith("urn:li:")) {
    const title = names.get(value) ?? assetLabel(value);
    node("span", title, parent);
    const details = node("details", undefined, parent); node("summary", "原生定位", details);
    node("code", value, details);
  } else node("span", typeof value === "boolean" ? value ? "是" : "否" : value === "" ? "空字串" : value, parent).style.whiteSpace = "pre-wrap";
}
export function appendReadableChange(block, item, preview) {
  const names = new Map(preview.displayNames ?? []);
  for (const definition of item.definitions ?? []) if (definition.urn && definition.name) names.set(definition.urn, definition.name);
  const heading = node("h3", `${kindLabel(item.kind)}${item.fieldPath ? ` · 欄位 ${item.fieldPath}` : ""}`, block);
  heading.style.cssText = "font-size:15px;margin:20px 0 8px;overflow-wrap:anywhere";
  const diff = node("div", undefined, block); diff.style.cssText = "display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:12px";
  for (const [caption, value] of [["目前內容", item.before], ["建議內容", item.after]]) {
    const col = node("section", undefined, diff); col.style.cssText = "min-width:0;padding:12px;background:#f6f7fa;border-radius:4px";
    node("h4", caption, col).style.cssText = "margin:0 0 8px;font-size:13px";
    appendReadableValue(col, value, names);
  }
  if (item.priorAgent !== undefined) {
    const prior = node("details", undefined, block); node("summary", "上次 Agent 維護的內容", prior); appendReadableValue(prior, item.priorAgent, names);
  }
  const hierarchies = item.hierarchy ? [item] : (item.definitions ?? []).filter(definition => definition.hierarchy);
  for (const definition of hierarchies) {
    const path = definition.hierarchy;
    node("p", `完整歸屬：${path.map(part => part.name ?? part.urn).join(" → ")}`, block);
    const ancestry = node("details", undefined, block); node("summary", "群組與祖先的定義及原生定位", ancestry);
    appendReadableValue(ancestry, path, names);
  }
  if (hierarchies.length) node("p", "請核對此路徑是否適用於目前 Source。名稱相同或上游 lineage 不代表歸屬相同；此畫面不宣稱業務範圍已驗證。", block);
  node("p", `建議理由：${item.reason ?? "未附理由"}`, block);
  const evidence = node("details", undefined, block); node("summary", "證據與限制", evidence);
  for (const entry of item.evidence ?? []) node("p", `${entry.id}：${entry.text}`, evidence).style.whiteSpace = "pre-wrap";
  node("p", "證據位置已核對；業務意義仍須由您判斷。只修改明列且選取的內容，保留未選中繼資料與來源 schema。", evidence);
  if (preview.definition) node("p", "共用定義可能影響引用資產。已選相依套用須等定義的原生結果核對；觀測不能證明全域影響已完整。", evidence);
  if (preview.definition?.ownedUpdate) node("p", "本案新建定義更新：原初始成功與目前完整 Agent 版本已核對，尚未觀測到範圍外引用。索引延遲、ACL 過濾及並發引用仍有未知影響；此差異由本輪整批真人確認，並非全域完整證明，也不是背景 AUTO。", evidence);
  if (item.impact) { node("h4", "已觀測影響（不是全域完整清單）", evidence); appendReadableValue(evidence, item.impact, names); }
}

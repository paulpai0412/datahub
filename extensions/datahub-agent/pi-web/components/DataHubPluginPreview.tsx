"use client";
import { useState } from "react";
import type { PluginPreview, PluginEvidence, PluginEndpoint } from "@/lib/discovery-plugin-preview";

const relations = {
  value_dependency: "值依賴", condition_dependency: "條件依賴", reads: "讀取", writes: "寫入",
  calls: "呼叫（不是值流）", contains: "包含（不是值流）", depends_on: "相依（不是值流）",
};
function Evidence({ items }: { items: PluginEvidence[] }) {
  return <details><summary>來源證據 ({items.length})</summary><ul>{items.map((item, index) =>
    <li key={index}><code>{item.path}:{item.startLine}–{item.endLine}</code>
      {item.pointer !== undefined && <div>JSON Pointer：<code>{item.pointer || "(root)"}</code></div>}
      <div>SHA256：<code>{item.fileSha256}</code></div></li>)}</ul></details>;
}

/** Neutral declared graph. No API calls, import/activation controls or invented edges. */
export function DataHubPluginPreview({ preview }: { preview: PluginPreview }) {
  const { result } = preview;
  const { graph, plugin } = result;
  const roots = graph.nodes.filter(node => node.kind !== "port");
  const [selectedId, setSelectedId] = useState(roots[0]?.id ?? "");
  const selected = roots.find(node => node.id === selectedId) ?? roots[0];
  const ports = graph.nodes.filter(node => node.kind === "port" && node.owner === selected?.id);
  const selectedNodes = new Set([selected?.id, ...ports.map(port => port.id)]);
  const edges = graph.edges.filter(edge => selectedNodes.has(edge.target.node) || edge.sources.some(source => selectedNodes.has(source.node)));
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const endpoint = (item: PluginEndpoint) => {
    const node = nodes.get(item.node)!;
    const owner = node.kind === "port" ? `${nodes.get(node.owner)!.name} › ` : "";
    return `${owner}${node.name}${item.field === undefined ? "" : ` › ${item.field}`}`;
  };
  const analyzed = graph.coverage.filter(item => item.state === "analyzed").length;
  return <section aria-label="Discovery 插件預覽" style={{ padding: 12, color: "var(--text)", background: "var(--bg-panel)", minWidth: 0, overflowWrap: "anywhere" }}>
    <h3 style={{ marginTop: 0 }}>Discovery 插件預覽</h3>
    <p><strong>{plugin.id}</strong> v{plugin.version} · {plugin.kind} · {preview.sourceId}</p>
    {preview.observedAt && <p>觀測時間：<time>{preview.observedAt}</time></p>}
    <p role="note">僅靜態宣告；未執行來源或 API，未發布 metadata。端口存在不代表 request → response 值流。</p>
    <p>資產 {graph.nodes.filter(node => node.kind === "asset").length} · 程序 {graph.nodes.filter(node => node.kind === "operation").length} ·
      端口 {graph.nodes.filter(node => node.kind === "port").length} · 宣告關係 {graph.edges.length}</p>
    {selected ? <>
      <label style={{ display: "block" }}>資產／程序 <select aria-label="資產／程序" value={selected.id} onChange={event => setSelectedId(event.target.value)}
        style={{ display: "block", width: "100%", maxWidth: "100%", color: "var(--text)", background: "var(--bg)", border: "1px solid var(--border)", padding: 6 }}>
        {roots.map(node => <option key={node.id} value={node.id}>{node.name}</option>)}
      </select></label>
      <h4>{selected.name}</h4>
      <p>{selected.kind === "asset" ? `資產型別：${selected.assetType}` : selected.kind === "operation" ? `程序型別：${selected.operationType}` : ""}</p>
      <div>原始定位：<code>{selected.localId}</code></div>
      {selected.kind === "operation" && selected.expressionSha256 && <div>Expression SHA256：<code>{selected.expressionSha256}</code></div>}
      <Evidence items={selected.evidence} />
      <h4>端口與欄位</h4>
      {!ports.length && <p>此資產／程序沒有已宣告端口。</p>}
      {ports.map(port => port.kind === "port" && <article key={port.id} aria-label={port.name}
        style={{ border: "1px solid var(--border)", padding: 10, marginBlock: 8, borderRadius: 6 }}>
        <h5 style={{ margin: "0 0 8px" }}>{port.direction === "input" ? "輸入" : port.direction === "output" ? "輸出" : "雙向"} · {port.name}</h5>
        {port.fields.length ? <ul>{port.fields.map(field => <li key={field.path}><code>{field.path}</code> — {field.nativeType}
          {field.nullable === undefined ? "" : field.nullable ? " · nullable" : " · non-nullable"}</li>)}</ul> : <p>沒有已解析欄位；請核對下方限制與缺口。</p>}
        <Evidence items={port.evidence} />
      </article>)}
      <h4>已宣告關係</h4>
      {!edges.length && <p>沒有已宣告關係；不推論欄位值流。</p>}
      {Object.entries(relations).map(([kind, label]) => {
        const items = edges.filter(edge => edge.kind === kind);
        return items.length > 0 && <div key={kind}><h5>{label}</h5><ul>{items.map((edge, index) =>
          <li key={index}><span>{edge.sources.map(endpoint).join(" ＋ ")} → {endpoint(edge.target)}</span><Evidence items={edge.evidence} /></li>)}</ul></div>;
      })}
    </> : <p>沒有可識別的資產／程序；請核對輸入格式、限制與缺口。</p>}
    <h4>覆蓋與缺口</h4>
    <p>已分析檔案 {analyzed}/{graph.coverage.length} · 未支援 {graph.coverage.length - analyzed} · 擷取排除 {preview.manifest.excluded.length} · Findings {graph.findings.length}</p>
    <p>{result.coverageComplete ? "在此插件宣告能力及捕捉範圍內完成分析；不是執行期或全 repo 完整性證明。" : "存在未解或空範圍；不能宣稱完整。"}</p>
    <ul>{graph.coverage.map(item => <li key={item.path}><code>{item.path}</code> · {item.state} · {item.reason}</li>)}</ul>
    {graph.findings.map((item, index) => <div key={index}><strong>{item.code}</strong><Evidence items={item.evidence} /></div>)}
    {preview.manifest.excluded.length > 0 && <details><summary>擷取排除項</summary><ul>{preview.manifest.excluded.map((item, index) =>
      <li key={index}><code>{item.path}</code> · {item.reason}</li>)}</ul></details>}
    <h4>插件限制</h4><ul>{plugin.limitations.map(item => <li key={item}>{item}</li>)}</ul>
    <details><summary>版本與來源綁定</summary><dl>
      <dt>Snapshot</dt><dd><code>{preview.snapshotSha256}</code></dd>
      <dt>Contract v{plugin.contractVersion}</dt><dd><code>{result.contractDigest}</code></dd>
      <dt>Config</dt><dd><code>{result.configDigest}</code></dd>
      <dt>Result</dt><dd><code>{result.resultDigest}</code></dd>
    </dl></details>
  </section>;
}

"use client";

import { useContext, useEffect, useRef, useState } from "react";
import { CatalogContext } from "../lib/catalog-context";
import { MaintenancePanelContext } from "../lib/semantic-maintenance-panel-context";

interface MaintenanceItem {
  id: string;
  status: string;
  assetUrn?: string;
  definition?: { kind: string; name: string; urn: string };
  candidateCount: number;
  dependencies?: string[];
  gap?: { code: string; reason: string };
}
export interface MaintenanceResult {
  format: "datahub-semantic.maintenance/1";
  publicationAuthorized: false;
  delivery?: "incremental";
  maintenanceRunUrn: string;
  sourceUrn: string;
  runVersion: string;
  planDigest: string | null;
  state: "DRAFT" | "READY" | "CONFIRMED";
  readOnly: boolean;
  totalItems: number;
  assetCount: number;
  offset: number;
  nextOffset: number | null;
  items: MaintenanceItem[];
}
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
export function isSemanticMaintenance(value: unknown): value is MaintenanceResult {
  if (!record(value) || value.format !== "datahub-semantic.maintenance/1" || value.publicationAuthorized !== false ||
    typeof value.maintenanceRunUrn !== "string" || value.maintenanceRunUrn.length > 1024 || !value.maintenanceRunUrn.startsWith("urn:li:dataProcessInstance:") ||
    typeof value.sourceUrn !== "string" || !value.sourceUrn.startsWith("urn:li:dataHubIngestionSource:") ||
    typeof value.runVersion !== "string" || !/^[1-9][0-9]*$/.test(value.runVersion) ||
    !["DRAFT", "READY", "CONFIRMED"].includes(value.state as string) || typeof value.readOnly !== "boolean" ||
    !Number.isInteger(value.totalItems) || (value.totalItems as number) < 0 || (value.totalItems as number) > 1024 ||
    !Number.isInteger(value.assetCount) || (value.assetCount as number) < 1 || !Number.isInteger(value.offset) ||
    !Array.isArray(value.items) || value.items.length > 20 ||
    !(value.delivery === undefined || value.delivery === "incremental" && value.state === "DRAFT" &&
      value.items.length === 1 && value.offset === 0 && value.nextOffset === null) ||
    !(value.planDigest === null && value.state === "DRAFT" || typeof value.planDigest === "string" && /^[a-f0-9]{64}$/.test(value.planDigest)) ||
    !(value.nextOffset === null || Number.isInteger(value.nextOffset))) return false;
  return value.items.every((item: unknown) => record(item) && typeof item.id === "string" && /^[a-f0-9-]{36}$/.test(item.id) &&
    typeof item.status === "string" && ["KEEP", "GAP", "DEFERRED", "OBSERVATION_CHANGED", "PENDING", "VERIFIED", "VERIFIED_CURRENT_CHANGED", "ATTEMPTED_UNVERIFIED", "APPROVE", "UNCONFIRMED"].includes(item.status) &&
    Number.isInteger(item.candidateCount) && (item.candidateCount as number) >= 0 &&
    (item.definition === undefined || record(item.definition) && typeof item.definition.kind === "string" &&
      typeof item.definition.name === "string" && typeof item.definition.urn === "string"));
}

/** Snapshot only. The trusted parent independently reloads the native plan,
 * full diffs and evidence before one human confirmation or any publication. */
export function DataHubSemanticMaintenance({ result }: { result: MaintenanceResult }) {
  const catalogControl = useContext(CatalogContext);
  const openWorkspacePanel = useContext(MaintenancePanelContext);
  const dispose = useRef<(() => void) | undefined>(undefined);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  useEffect(() => () => dispose.current?.(), [result.maintenanceRunUrn]);
  function open() {
    if (busy) return;
    if (window.parent === window) { setNotice("請從 DataHub 開啟；此頁不能確認或發布。"); return; }
    if (openWorkspacePanel) {
      openWorkspacePanel(result.maintenanceRunUrn);
      setNotice("已開啟 Pi Web 右側審核面板；內容與真人確認仍由可信 Host 提供。");
      return;
    }
    catalogControl?.(null, false);
    const channel = new MessageChannel(); let closed = false;
    const cleanup = () => { if (closed) return; closed = true; channel.port1.postMessage({ type: "cancel" }); channel.port1.close(); };
    dispose.current = cleanup; setBusy(true);
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      let valid = false;
      try {
        if (typeof event.data === "string" && new TextEncoder().encode(event.data).length <= 524288) {
          const value: unknown = JSON.parse(event.data);
          valid = record(value) && ["datahub-semantic.maintenance/1", "datahub-semantic.maintenance-item/1"].includes(value.format as string) &&
            value.publicationAuthorized === false && value.maintenanceRunUrn === result.maintenanceRunUrn;
        }
      } catch { /* A missing/untrusted reply never proves success. */ }
      cleanup(); setBusy(false);
      setNotice(valid ? "Host 視窗已關閉；請讀回原生計畫與每個結果。此歷史卡片不推定整批成功。" : "結果未確認；只讀對帳，不重送確認／發布。");
    };
    window.parent.postMessage({ type: "datahub-semantic-maintenance", body: JSON.stringify({ maintenanceRunUrn: result.maintenanceRunUrn }) }, "*", [channel.port2]);
  }
  return <section aria-label="DataHub 整批語義維護計畫" style={{ padding: 12, background: "var(--bg-panel)", color: "var(--text)", overflowWrap: "anywhere" }}>
    <h3>整批語義維護 · {result.state === "DRAFT" ? "準備中" : result.state === "READY" ? "待一次確認" : "已確認，逐項核對結果"}</h3>
    <p>目前 Catalog 選定範圍 {result.assetCount} 個資產；{result.totalItems} 個計畫項目。不是最新整庫盤點。</p>
    <p>先核對共用定義，再查看資產與欄位的建議變更。只有您在可信面板確認後才會執行，保留未選內容與人工作品。</p>
    <details><summary>計畫版本與原生定位</summary><p>版本 {result.runVersion} · <code>{result.maintenanceRunUrn}</code></p></details>
    {result.readOnly && <p role="status">Source 發布已停用，目前僅可讀回。</p>}
    <button type="button" disabled={busy} onClick={open} style={{ minHeight: 44, padding: "8px 12px" }}>在 Host 核對整批計畫／原生結果</button>
    <p role="status">{busy ? "請在 DataHub 父頁面核對；此卡片不批准任何內容。" : notice}</p>
    {result.delivery === "incremental" && <p>本次新增／修訂摘要，不是完整計畫；可信面板仍會讀齊所有項目與差異。</p>}
    <details><summary>{result.delivery === "incremental" ? "本次" : "本頁"} {result.items.length} 個項目（全部 {result.totalItems}）</summary><ul>
      {result.items.map((item) => <li key={item.id}>{item.definition ? `${({ domain: "資料領域", node: "詞彙群組", term: "詞彙", tag: "標籤", property: "結構化屬性" } as Record<string, string>)[item.definition.kind] ?? item.definition.kind} · ${item.definition.name}` : item.assetUrn?.match(/^urn:li:dataset:\(urn:li:dataPlatform:[^,]+,(.*),[^,)]+\)$/)?.[1] ?? item.assetUrn?.replace(/^urn:li:[^:]+:/, "")} · {({ PENDING: "待確認", VERIFIED: "已核對", KEEP: "保留", GAP: "缺少依據", DEFERRED: "暫緩", OBSERVATION_CHANGED: "觀測已變更" } as Record<string, string>)[item.status] ?? "請讀回目前狀態"} · {item.gap ? "有待補充證據" : `${item.candidateCount} 項差異／保留`}</li>)}
    </ul></details>
    {result.nextOffset !== null && <p>此卡片只顯示部分項目；右側面板會讀齊全部內容，不能只批准本頁。</p>}
    <p>歷史 UNKNOWN 暫緩、不重送；不阻擋其餘獨立工作送審。暫緩不算維護完成，只讀核對不追認歷史成功。此為對話保存的觀測快照。</p>
  </section>;
}

"use client";

import { useEffect, useRef, useState } from "react";
import { ConfigButton } from "./SettingsUi";
import styles from "./DataHubSourceSettings.module.css";
interface Binding { id: string; platform: string; database: string; environment: string; enabled: boolean }
const errors: Record<string, string> = {
  query_settings_not_configured: "Host尚未啟用資料庫連線設定。",
  query_settings_admin_required: "需要DataHub管理政策及管理ingestion權限。",
  query_settings_version_conflict: "設定已變更，請重新讀取後操作。",
};
/** This iframe never receives passwords or sends a save/test intent. */
export function DataHubConnectionSettings({ active = true }: { active?: boolean }) {
  const [connections, setConnections] = useState<Binding[]>([]), [revision, setRevision] = useState("");
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const mounted = useRef(false), cancel = useRef<(() => void) | null>(null);
  function request(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (window.parent === window) { reject(new Error("請从DataHub Agent入口開啟。")); return; }
      const channel = new MessageChannel(); let done = false;
      function finish(value?: Record<string, unknown>, error?: Error) {
        if (done) return; done = true; clearTimeout(timer); channel.port1.postMessage({ type: "cancel" }); channel.port1.close(); cancel.current = null;
        if (error) reject(error); else resolve(value!);
      }
      const timer = setTimeout(() => finish(undefined, new Error("結果未確認，請重新讀回，不要重送保存。")), 605000);
      cancel.current = () => finish(undefined, new Error("已取消等待，已送出的保存請重新讀回確認。"));
      channel.port1.onmessage = (event: MessageEvent<unknown>) => {
        try {
          if (typeof event.data !== "string" || event.data.length > 131072) throw new Error();
          const v = JSON.parse(event.data) as Record<string, unknown>;
          if (typeof v?.error === "string") { finish(undefined, new Error(errors[v.error] ?? `操作未完成（${v.error}）。`)); return; }
          if (v?.format !== "datahub-connection-settings/1") throw new Error();
          finish(v);
        } catch { finish(undefined, new Error("Host回覆無法確認，請重新讀回。")); }
      };
      window.parent.postMessage({ type: "datahub-connection-settings", body: JSON.stringify(input) }, "*", [channel.port2]);
    });
  }
  async function refresh() {
    const value = await request({ action: "list" });
    if (typeof value.revision !== "string" || !/^[a-f0-9]{64}$/.test(value.revision) || !Array.isArray(value.connections) ||
      !value.connections.every((b: Binding) => b && typeof b.id === "string" && typeof b.platform === "string" && typeof b.database === "string" && typeof b.environment === "string" && typeof b.enabled === "boolean")) throw new Error("連線清單無法確認");
    if (mounted.current) { setRevision(value.revision); setConnections(value.connections as Binding[]); }
  }
  async function run(id?: string, open = false) {
    setBusy(true); setNotice("");
    try {
      if (open) await request({ action: "open", revision, ...(id ? { id } : {}) });
      if (mounted.current) await refresh();
    } catch (error) { if (mounted.current) setNotice(error instanceof Error ? error.message : "操作失敗"); }
    finally { if (mounted.current) setBusy(false); }
  }
  useEffect(() => {
    mounted.current = true;
    if (active) void run();
    return () => { mounted.current = false; cancel.current?.(); };
    // Settings reads do not start or modify an Agent session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
  return <section className={styles.panel} aria-label="資料庫連線">
    <h2>資料庫連線</h2>
    <p>管理共用的Agent SQL／Grafana查詢連線。第一版支援SQL Server；不是語義來源授權，也不會啟用AUTO或ingestion。</p>
    <p>使用者仍依自己的DataHub metadata可見性查詢。主機、帳號與密碼在可信DataHub父頁面設定；密碼不回顯、不進入模型或聊天。</p>
    <div className={styles.actions}>
      <ConfigButton disabled={busy} onClick={() => void run()}>重新讀取連線</ConfigButton>
      <ConfigButton variant="primary" disabled={busy || !revision} onClick={() => void run(undefined, true)}>新增SQL Server連線</ConfigButton>
    </div>
    {busy && <p role="status">正在核對設定；編輯時請使用DataHub父頁面的安全表單。</p>}
    {notice && <p role="status" className={styles.notice}>{notice}</p>}
    <div className={styles.sources}>
      {connections.map((b) => <button key={b.id} type="button" disabled={busy || b.platform !== "mssql"} onClick={() => void run(b.id, true)}>
        <strong>{b.id}</strong><span>{b.platform} · {b.database} · {b.environment} · {b.enabled ? "啟用" : "停用"}</span>
        <span>{b.platform === "mssql" ? "修改／測試／啟用或停用" : "此平台由部署端管理"}</span>
      </button>)}
    </div>
    {!busy && revision && connections.length === 0 && <p>尚未配置查詢連線。請先在DataHub匯入目標資料庫的metadata，再建立連線。</p>}
  </section>;
}

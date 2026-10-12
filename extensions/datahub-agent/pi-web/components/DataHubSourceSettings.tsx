"use client";

import { useEffect, useRef, useState } from "react";
import { ConfigButton } from "./SettingsUi";
import styles from "./DataHubSourceSettings.module.css";

interface Source {
  urn: string;
  name: string;
  type: string;
  enabled: boolean;
  editable: boolean;
  supported: boolean;
  datasetCount: number;
}
interface Publication { review: boolean; createDefinitions: boolean; updateDefinitions: boolean; agentUrn: string | null }
const noPublication: Publication = { review: false, createDefinitions: false, updateDefinitions: false, agentUrn: null };
const isPublication = (p: unknown): p is Publication => record(p) &&
  ["review", "createDefinitions", "updateDefinitions"].every((k) => typeof p[k] === "boolean") &&
  (p.agentUrn === null || typeof p.agentUrn === "string");
interface Inspection {
  revision: string;
  source: { urn: string; name: string; version: string; database: string };
  assets: { urn: string; fieldCount: number; runId: string | null }[];
  selectedDatasetUrns: string[];
  enabled: boolean;
  editable: boolean;
  publication: Publication;
  agentUrns: string[];
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function isInspection(value: unknown): value is Inspection {
  return record(value) && typeof value.revision === "string" && /^[a-f0-9]{64}$/.test(value.revision) &&
    typeof value.enabled === "boolean" && typeof value.editable === "boolean" && isPublication(value.publication) &&
    Array.isArray(value.agentUrns) && value.agentUrns.every((urn: unknown) => typeof urn === "string") &&
    record(value.source) && typeof value.source.urn === "string" && typeof value.source.name === "string" &&
    typeof value.source.version === "string" && typeof value.source.database === "string" &&
    Array.isArray(value.assets) && value.assets.length <= 1024 && value.assets.every((asset: unknown) =>
      record(asset) && typeof asset.urn === "string" && typeof asset.fieldCount === "number" && Number.isSafeInteger(asset.fieldCount) &&
      asset.fieldCount >= 0 && (asset.runId === null || typeof asset.runId === "string")) &&
    Array.isArray(value.selectedDatasetUrns) && value.selectedDatasetUrns.every((urn: unknown) => typeof urn === "string");
}
const errors: Record<string, string> = {
  source_settings_not_configured: "Host尚未啟用來源設定功能。需由部署管理員啟用，不能由Pi Agent自行開啟。",
  source_settings_admin_required: "需要DataHub「管理政策」及「管理ingestion」權限。沒有更改任何設定。",
  source_settings_deployment_managed: "此來源含部署端管理的執行、AUTO或語義政策；此頁不覆寫它。",
  source_settings_agent_not_configured: "請選擇Host已配置的Agent身分；不能由模型或瀏覽器自行新增身分。",
  source_settings_publication_invalid: "新增或修改共用定義須先開啟審核發布；審核發布也須啟用來源metadata。",
  source_settings_publication_confirmation_required: "請重新載入新版設定頁，明確確認語義授權差異。", 
  source_settings_version_conflict: "來源或設定版本已改變，請重新讀取再確認。",
  source_settings_configuration_changed: "部署設定在Host外變更，請由操作者重新載入Host。",
  source_settings_scope_not_authorized: "部分Dataset不再可讀或不屬於此Source，請重新盤點。",
  source_settings_inventory_incomplete: "盤點未完整或超過上限，不允許保存不明範圍。",
  source_settings_connector_not_supported: "第一版僅支援無platform instance的MSSQL來源；此來源尚不支援。",
  source_settings_save_unconfirmed: "保存結果未確認，請重新讀回設定；不要重送保存。",
};

/** User settings UI, not a model tool. Parent confirms native scope before save. */
export function DataHubSourceSettings({ active = true }: { active?: boolean }) {
  const [sources, setSources] = useState<Source[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [enabled, setEnabled] = useState(false);
  const [publication, setPublication] = useState<Publication>(noPublication);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const controllers = useRef(new Set<AbortController>());
  const mounted = useRef(false);

  function request(input: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (window.parent === window) { reject(new Error("請從DataHub的Agent入口開啟來源設定。")); return; }
      const channel = new MessageChannel();
      let done = false;
      const finish = (value?: Record<string, unknown>, error?: Error) => {
        if (done) return; done = true;
        clearTimeout(timer); signal.removeEventListener("abort", abort);
        channel.port1.postMessage({ type: "cancel" }); channel.port1.close();
        if (error) reject(error); else resolve(value!);
      };
      const abort = () => finish(undefined, new Error("已取消；若保存已送出，請讀回確認，不要重送。"));
      const timer = setTimeout(() => finish(undefined, new Error("結果未確認，請重新讀回，不要重送保存。")), 305000);
      signal.addEventListener("abort", abort, { once: true });
      channel.port1.onmessage = (event: MessageEvent<unknown>) => {
        try {
          if (typeof event.data !== "string" || new TextEncoder().encode(event.data).length > 524288) throw new Error();
          const value = JSON.parse(event.data) as Record<string, unknown>;
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
          if (typeof value.error === "string") { finish(undefined, new Error(errors[value.error] ?? `Host結果未確認（${value.error}）。若已送出保存，請讀回核對，不要重送。`)); return; }
          if (value.cancelled !== true && value.format !== "datahub-source-settings/1") throw new Error();
          finish(value);
        } catch { finish(undefined, new Error("Host回覆無法確認，請讀回而不是重送保存。")); }
      };
      if (signal.aborted) { abort(); return; }
      // Match the existing DataHubHostBridge: bootstrap navigation deliberately
      // suppresses referrers. Gateway CSP pins the allowed ancestor; the parent
      // checks the exact iframe/origin, and Host checks identity + parent proof.
      // This intent contains no credentials and cannot directly submit a save.
      window.parent.postMessage({ type: "datahub-source-settings", body: JSON.stringify(input) }, "*", [channel.port2]);
    });
  }
  async function run(input: Record<string, unknown>, receive: (value: Record<string, unknown>) => void) {
    const controller = new AbortController(); controllers.current.add(controller);
    setBusy(true); setNotice("");
    try { const value = await request(input, controller.signal); if (mounted.current && !controller.signal.aborted) receive(value); }
    catch (cause) { if (mounted.current && !controller.signal.aborted) setNotice(cause instanceof Error ? cause.message : "請求失敗"); }
    finally { controllers.current.delete(controller); if (mounted.current) setBusy(controllers.current.size > 0); }
  }
  const list = (offset = 0) => run({ action: "list", offset }, (value) => {
    if (!Array.isArray(value.sources)) throw new Error("來源清單無法確認");
    setSources((current) => offset ? [...current, ...(value.sources as Source[])] : value.sources as Source[]);
    setNextOffset(typeof value.nextOffset === "number" ? value.nextOffset : null);
    if (value.truncated) setNotice("來源清單超過可讀範圍，尚未完整列出。");
  });
  function inspect(urn: string) {
    setInspection(null); setSelection(new Set());
    void run({ action: "inspect", sourceUrn: urn }, (value) => {
      if (!isInspection(value)) throw new Error("範圍無法確認");
      const detail = value;
      setInspection(detail); setEnabled(detail.enabled); setPublication(detail.publication);
      const visible = new Set(detail.assets.map((a) => a.urn));
      setSelection(new Set(detail.selectedDatasetUrns.filter((urn) => visible.has(urn))));
      if (detail.selectedDatasetUrns.some((urn) => !visible.has(urn))) setNotice("原範圍有已失去權限或不可見的資產；本次只列出可核對項目，保存會撤除未選項目。");
    });
  }
  useEffect(() => {
    mounted.current = true;
    const owned = controllers.current;
    if (active) void list();
    return () => { mounted.current = false; for (const c of owned) c.abort(); owned.clear(); };
    // Settings changes do not start or reload an Agent session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
  const save = () => {
    if (!inspection) return;
    void run({ action: "review", sourceUrn: inspection.source.urn, revision: inspection.revision,
      sourceVersion: inspection.source.version, datasetUrns: [...selection].sort(), enabled, publication }, (value) => {
      if (value.cancelled === true) { setNotice("已取消，沒有保存。"); return; }
      if (value.status !== "SAVED_AND_ACTIVE" || !isPublication(value.publication)) throw new Error("保存結果未確認，請重新讀回。");
      setPublication(value.publication);
      setInspection({ ...inspection, revision: String(value.revision), enabled, publication: value.publication,
        selectedDatasetUrns: [...selection] });
      setSources((current) => current.map((source) => source.urn === inspection.source.urn
        ? { ...source, enabled, datasetCount: selection.size } : source));
      setNotice(enabled
        ? (value.publication.review
          ? "Host已保存並立即套用。已允許審核提案與人工核准後發布；共用定義依個別授權及影響範圍檢查。沒有啟用AUTO、SQL或ingestion執行。"
          : "Host已保存並立即套用。只開啟metadata讀取／提案預覽；沒有開啟發布、AUTO、SQL或ingestion執行。")
        : "Host已保存並立即套用，已停用此來源的語義工具存取。既有對話與一般Catalog政策不變。");
    });
  };
  return (
    <section className={styles.panel} aria-label="使用來源">
      <h2>使用來源</h2>
      <p>由目前登入的DataHub管理員設定。只管理自己的來源範圍；密碼及Secret不在此頁設定。</p>
      <p>本設定控制Source綁定的語義工具；一般Catalog查詢仍沿用其既有DataHub／Host政策。</p>
      <p>metadata傳送同意與AUTO發布政策是不同權限。歷史已匯入資產不代表最新成功掃描的完整範圍。</p>
      <ConfigButton disabled={busy} onClick={() => { setInspection(null); void list(); }}>重新讀取來源</ConfigButton>
      {busy && <div className={styles.actions}><p role="status">正在向可信Host核對…</p>
        <ConfigButton onClick={() => {
          for (const controller of controllers.current) controller.abort();
          setNotice("已取消等待。若保存已送出，請重新讀回確認，不要重送。");
        }}>取消等待</ConfigButton></div>}
      {notice && <p role="status" className={styles.notice}>{notice}</p>}
      <div className={styles.layout}>
        <nav aria-label="DataHub Ingestion Sources" className={styles.sources}>
          {sources.map((source) => (
            <button type="button" key={source.urn} disabled={busy || !source.supported}
              aria-current={inspection?.source.urn === source.urn ? "true" : undefined}
              onClick={() => inspect(source.urn)}>
              <strong>{source.name}</strong>
              <span>{source.type} · {source.enabled ? `已啟用（${source.datasetCount}個）` : "未啟用"}</span>
              {!source.editable && <span>部署端管理</span>}
              {!source.supported && <span>第一版尚不支援此connector</span>}
            </button>
          ))}
          {nextOffset !== null && <ConfigButton disabled={busy} onClick={() => void list(nextOffset)}>更多來源</ConfigButton>}
        </nav>
        {inspection && <div className={styles.detail}>
          <h3>{inspection.source.name}</h3><p className={styles.urn}>{inspection.source.urn}</p>
          <p>{inspection.assets.length}個可讀Dataset · {inspection.assets.reduce((n, a) => n + a.fieldCount, 0)}個欄位</p>
          {!inspection.editable && <p>此來源含部署端管理的執行、AUTO或語義政策；此頁不覆寫部署端授權。</p>}
          <fieldset disabled={busy || !inspection.editable}>
            <legend>允許Pi Agent使用的metadata</legend>
            <label><input type="checkbox" checked={enabled} onChange={(e) => {
              setEnabled(e.target.checked);
              if (!e.target.checked) setPublication((p) => ({ ...p, review: false, createDefinitions: false, updateDefinitions: false }));
            }} />啟用模型metadata傳送與提案預覽</label>
            <label><input type="checkbox" checked={publication.review} disabled={!enabled || !inspection.agentUrns.length} onChange={(e) => {
              const checked = e.target.checked;
              setPublication((p) => ({ ...p, review: checked, agentUrn: p.agentUrn ?? inspection.agentUrns[0] ?? null,
                createDefinitions: checked && p.createDefinitions, updateDefinitions: checked && p.updateDefinitions }));
            }} />允許建立審核提案與人工核准後發布</label>
            <label>發布Agent身分（Host已配置）<select aria-label="發布Agent身分" disabled={!publication.review}
              value={publication.agentUrn ?? ""} onChange={(e) => setPublication((p) => ({ ...p, agentUrn: e.target.value || null }))}>
              <option value="">未選擇</option>{inspection.agentUrns.map((urn) => <option key={urn} value={urn}>{urn}</option>)}
            </select></label>
            {!inspection.agentUrns.length && <p>Host尚未為此使用者配置可用Agent身分；不能啟用審核發布。</p>}
            <label><input type="checkbox" checked={publication.createDefinitions} disabled={!publication.review}
              onChange={(e) => setPublication((p) => ({ ...p, createDefinitions: e.target.checked }))} />允許提案新增共用定義</label>
            <label><input type="checkbox" checked={publication.updateDefinitions} disabled={!publication.review}
              onChange={(e) => setPublication((p) => ({ ...p, updateDefinitions: e.target.checked }))} />允許提案修改共用定義</label>
            <p>Domain、Glossary Group／Term、Tag、Structured Property定義與資產關聯分開處理。新增／修改仍須人工核准；跨庫或影響範圍不明不放行。這不是AUTO授權。</p>
            <div className={styles.actions}>
              <ConfigButton onClick={() => setSelection(new Set(inspection.assets.map((a) => a.urn)))}>選取全部已匯入資產</ConfigButton>
              <ConfigButton onClick={() => setSelection(new Set())}>清除選取</ConfigButton>
            </div>
            <div className={styles.assets}>
              {inspection.assets.map((asset) => <label key={asset.urn}>
                <input type="checkbox" checked={selection.has(asset.urn)} onChange={(e) => {
                  const checked = e.target.checked;
                  setSelection((current) => { const next = new Set(current); if (checked) next.add(asset.urn); else next.delete(asset.urn); return next; });
                }} /><span className={styles.urn}>{asset.urn}<small>{asset.fieldCount}欄</small></span>
              </label>)}
            </div>
            <p>已選取{selection.size}個Dataset。保存時還需在可信DataHub父頁面確認精確範圍。</p>
            <ConfigButton variant="primary" disabled={!selection.size || (publication.review && !publication.agentUrn)} onClick={save}>檢查差異並保存</ConfigButton>
          </fieldset>
        </div>}
      </div>
    </section>
  );
}

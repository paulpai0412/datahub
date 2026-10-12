"use client";
import { useEffect, useRef, useState } from "react";
import styles from "./DataHubGrafanaPanel.module.css";

/** Same workspace slot as Grafana. The trusted parent owns the review DOM,
 * selection, acknowledgement and mutation callbacks, never this iframe. */
export function DataHubSemanticMaintenancePanel({ root, expanded, onExpandAction, onCloseAction }: {
  root: string; expanded: boolean; onExpandAction: () => void; onCloseAction: () => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [notice, setNotice] = useState("正在由 Host 讀取目前方案…");
  const closeAction = useRef(onCloseAction);
  useEffect(() => { closeAction.current = onCloseAction; }, [onCloseAction]);
  useEffect(() => {
    closeButton.current?.focus();
    const el = viewport.current;
    if (!el || window.parent === window) { setNotice("請從 DataHub 開啟；此頁不能批准或發布。"); return; }
    const channel = new MessageChannel();
    let closed = false, animation = 0, previous = "", sent = false;
    const stop = () => {
      if (closed) return;
      closed = true; cancelAnimationFrame(animation);
      channel.port1.postMessage({ type: "cancel" }); channel.port1.close();
    };
    const timeout = setTimeout(() => { setNotice("Host 面板未完成掛載。請關閉後只讀核對，不重送任何操作。"); stop(); }, 12000);
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      if (closed) return;
      let reply: Record<string, unknown> | null = null;
      try {
        if (typeof event.data === "string" && new TextEncoder().encode(event.data).length <= 524288) {
          const parsed: unknown = JSON.parse(event.data);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) reply = parsed as Record<string, unknown>;
        }
      } catch { /* Never infer consent or success from an invalid reply. */ }
      if (reply?.status === "mounted") {
        clearTimeout(timeout); setNotice("下方由可信 Host 提供審核與確認；聊天不等於批准。"); return;
      }
      clearTimeout(timeout);
      const bound = reply?.publicationAuthorized === false && reply?.maintenanceRunUrn === root &&
        ["datahub-semantic.maintenance/1", "datahub-semantic.maintenance-item/1"].includes(String(reply?.format));
      setNotice(bound ? "審核已關閉。請讀回原生結果，不以面板關閉推定整批成功。" : "結果未確認。只讀核對，不重送確認或發布。");
      stop();
      if (bound) closeAction.current();
    };
    const tick = () => {
      if (closed) return;
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const layout = { rect: { left: r.left, top: r.top, width: Math.max(1, r.width), height: Math.max(1, r.height) },
        visible: !document.hidden && r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight &&
          (hit === el || (hit !== null && el.contains(hit))) };
      const encoded = JSON.stringify({ action: "reposition", ...layout });
      if (!sent) {
        sent = true;
        window.parent.postMessage({ type: "datahub-semantic-maintenance-portal",
          body: JSON.stringify({ maintenanceRunUrn: root, ...layout }) }, "*", [channel.port2]);
      } else if (encoded !== previous) channel.port1.postMessage(encoded);
      previous = encoded; animation = requestAnimationFrame(tick);
    };
    animation = requestAnimationFrame(tick);
    return () => { clearTimeout(timeout); stop(); };
  }, [root]);
  return <section className={styles.panel} aria-label="語義維護審核工作區" onKeyDown={e => { if (e.key === "Escape") onCloseAction(); }}>
    <header className={styles.header}>
      <h3>語義維護審核</h3>
      <button type="button" onClick={onExpandAction} aria-pressed={expanded}>{expanded ? "還原" : "放大"}</button>
      <button type="button" ref={closeButton} onClick={onCloseAction}>關閉審核面板</button>
    </header>
    <p className={styles.notice} role="status">{notice}</p>
    <div ref={viewport} className={styles.viewport} style={{ background: "var(--bg)" }} aria-label="可信 Host 審核位置" />
  </section>;
}

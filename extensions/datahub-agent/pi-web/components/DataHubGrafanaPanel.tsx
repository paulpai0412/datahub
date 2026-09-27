"use client";
import { useContext, useEffect, useRef, useState } from "react";
import {
  isGrafanaEmbed,
  type GrafanaEmbed,
} from "@/lib/grafana-embed-contract";
import { GrafanaContext } from "@/lib/grafana-context";
import styles from "./DataHubGrafanaPanel.module.css";

/** A historical message is a launcher, never an automatically executing frame. */
export function DataHubGrafanaMessage({
  value,
  pending,
  error,
}: {
  value: unknown;
  pending: boolean;
  error?: string;
}) {
  const open = useContext(GrafanaContext);
  const embed = !error && isGrafanaEmbed(value) ? value : null;
  const [expiredRef, setExpiredRef] = useState<string | null>(null);
  return (
    <section className={styles.message} aria-label="Grafana 儀表板入口">
      <h3>{embed?.title ?? "Grafana 儀表板"}</h3>
      <p>
        {embed?.format === "datahub-grafana.embed/2"
          ? embed.status === "EMPTY"
            ? "查詢已完成，來源回傳空結果"
            : "依本次查詢產生的互動式 Grafana · 淺色主題"
          : "已核權來源聚合 · 尚未與既有 Grafana 面板對帳"}
      </p>
      {embed ? (
        <>
          {embed.format === "datahub-grafana.embed/1" && (
            <p>
              {embed.from} — {embed.to}
            </p>
          )}
          <p className={styles.dataset}>
            {embed.format === "datahub-grafana.embed/2"
              ? embed.datasetUrns.join(" · ")
              : embed.datasetUrn}
          </p>
          <button
            type="button"
            disabled={!open || expiredRef === embed.displayRef}
            onClick={() => {
              if (Date.now() >= embed.resultExpiresAt) {
                setExpiredRef(embed.displayRef);
                return;
              }
              open?.(embed);
            }}
          >
            開啟儀表板
          </button>
          <small>
            {expiredRef === embed.displayRef
              ? "結果已過期，不會重跑 SQL。"
              : `短效結果至 ${new Date(embed.resultExpiresAt).toLocaleTimeString()}；右側重開須核權，不會重跑 SQL。`}
          </small>
        </>
      ) : (
        <p role="status">
          {pending
            ? "正在核對顯示權限…"
            : "沒有可開啟的儀表板；不顯示未核權內容。"}
        </p>
      )}
    </section>
  );
}

/** Right-panel slot only. The authenticated MFE owns the actual same-site iframe. */
export function DataHubGrafanaPanel({
  embed,
  expanded,
  onExpandAction,
  onCloseAction,
}: {
  embed: GrafanaEmbed;
  expanded: boolean;
  onExpandAction: () => void;
  onCloseAction: () => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [state, setState] = useState("正在重新核權…");
  useEffect(() => {
    closeButton.current?.focus();
    const el = viewport.current;
    if (!el || window.parent === window) {
      setState("必須由 DataHub MFE 開啟。");
      return;
    }
    const channel = new MessageChannel();
    let closed = false,
      animation = 0,
      previous = "",
      sent = false;
    const geometry = () => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(
        r.left + r.width / 2,
        r.top + r.height / 2,
      );
      return {
        rect: {
          left: r.left,
          top: r.top,
          width: Math.max(1, r.width),
          height: Math.max(1, r.height),
        },
        visible:
          !document.hidden &&
          r.width > 0 &&
          r.height > 0 &&
          r.bottom > 0 &&
          r.top < window.innerHeight &&
          // A resize handle/tab can cover an edge while the viewing center
          // remains visible. The parent MFE clips the portal to the frame.
          (hit === el || (hit !== null && el.contains(hit))),
      };
    };
    const stop = () => {
      if (closed) return;
      closed = true;
      cancelAnimationFrame(animation);
      channel.port1.postMessage(JSON.stringify({ action: "close" }));
      channel.port1.close();
    };
    const timeout = setTimeout(() => {
      setState("顯示授權逾時，未開啟儀表板。");
      stop();
    }, 12000);
    channel.port1.onmessage = (event) => {
      if (closed) return;
      let reply;
      try {
        if (typeof event.data !== "string" || event.data.length > 512)
          throw new Error();
        reply = JSON.parse(event.data);
      } catch {
        reply = { error: true };
      }
      if (reply?.status === "mounted") {
        clearTimeout(timeout);
        setState(
          "視圖已掛載；登入與資料狀態請見 Grafana，掛載不代表查詢成功。",
        );
      } else if (reply?.error) {
        clearTimeout(timeout);
        setState("顯示權限失效或工作區已切換。請關閉後重新核權開啟。");
        stop();
      }
    };
    // Track layout/resize animations, not message scrolling. Send only changed geometry.
    const tick = () => {
      if (closed) return;
      const layout = geometry();
      const encoded = JSON.stringify({ action: "reposition", ...layout });
      if (!sent) {
        sent = true;
        window.parent.postMessage(
          {
            type: "datahub-grafana-portal",
            body: JSON.stringify({
              action: "open",
              displayRef: embed.displayRef,
              requestId: crypto.randomUUID(),
              ...layout,
            }),
          },
          "*",
          [channel.port2],
        );
      } else if (encoded !== previous) channel.port1.postMessage(encoded);
      previous = encoded;
      animation = requestAnimationFrame(tick);
    };
    // StrictMode discarded effects send nothing.
    animation = requestAnimationFrame(tick);
    return () => {
      clearTimeout(timeout);
      stop();
    };
  }, [embed.displayRef, embed.requestId]);
  return (
    <section
      className={styles.panel}
      aria-label="Grafana 互動工作區"
      onKeyDown={(e) => {
        if (e.key === "Escape") onCloseAction();
      }}
    >
      <header className={styles.header}>
        <h3>{embed.title}</h3>
        <button type="button" onClick={onExpandAction} aria-pressed={expanded}>
          {expanded ? "還原" : "放大"}
        </button>
        <button type="button" ref={closeButton} onClick={onCloseAction}>
          關閉
        </button>
      </header>
      <p className={styles.notice} role="status">
        {state}
      </p>
      <div
        ref={viewport}
        className={styles.viewport}
        aria-label="Grafana 同站視圖位置"
      />
      <footer className={styles.footer}>
        {embed.format === "datahub-grafana.embed/2"
          ? "本次查詢 · 動態 Dashboard · 淺色主題"
          : `來源聚合（未對帳既有面板） · ${embed.from} — ${embed.to}`}{" "}
        · org {embed.orgId}
      </footer>
    </section>
  );
}

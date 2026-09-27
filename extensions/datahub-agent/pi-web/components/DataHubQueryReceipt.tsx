"use client";
import { useEffect, useRef, useState } from "react";
import type { QueryReceipt } from "@/lib/query-contract";
import styles from "./DataHubSqlCard.module.css";

/** User-only SQL preview. Never stored in the model's tool result/history. */
export function DataHubQueryReceipt({ receipt }: { receipt: QueryReceipt }) {
  const [sql, setSql] = useState<string | null>(null);
  const [state, setState] = useState("");
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), [receipt.resultRef]);
  function preview() {
    cleanup.current?.();
    setSql(null);
    if (Date.now() >= receipt.resultExpiresAt || window.parent === window) {
      setState("結果已過期或未在 DataHub 開啟；不會重跑 SQL。");
      return;
    }
    setState("讀取本次已產生的 SQL…");
    const channel = new MessageChannel();
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      channel.port1.postMessage({ type: "cancel" });
      channel.port1.close();
    };
    const timer = setTimeout(() => {
      close();
      setState("SQL 讀回逾時，不會重新執行。");
    }, 25000);
    cleanup.current = close;
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      if (closed) return;
      try {
        if (typeof event.data !== "string" || event.data.length > 1048576)
          throw new Error();
        const result = JSON.parse(event.data);
        if (
          result.format !== "datahub-query.result/1" ||
          result.resultRef !== receipt.resultRef ||
          typeof result.sql !== "string" ||
          result.sql.length > 32768
        )
          throw new Error();
        setSql(result.sql);
        setState(
          result.truncated
            ? "結果已截斷至查詢筆數上限；SQL 中的參數值不在此顯示。"
            : "SQL 由當時可見 metadata 編譯；參數值不在此顯示。",
        );
      } catch {
        setState("結果已過期、權限已變更或讀回失敗，不會重跑 SQL。");
      }
      close();
    };
    window.parent.postMessage(
      {
        type: "datahub-sql-card",
        body: JSON.stringify({
          action: "read_result",
          resultRef: receipt.resultRef,
        }),
      },
      "*",
      [channel.port2],
    );
  }
  return (
    <section className={styles.card} aria-label="DataHub metadata 查詢結果">
      <header className={styles.header}>
        <h3>Metadata SQL 查詢</h3>
        <span className={styles.status}>
          {receipt.state === "EMPTY" ? "來源回傳空結果" : "來源查詢完成"}
        </span>
      </header>
      <div className={styles.body}>
        <p>
          接續的 Grafana 入口會開啟本次動態儀表板；查詢完成不等於圖表已載入。
        </p>
        <p>{receipt.datasetUrns.join(" · ")}</p>
        <button type="button" onClick={preview}>
          查看產生的 SQL（不重執行）
        </button>
        {state && <p role="status">{state}</p>}
        {sql && (
          <pre
            style={{ overflowX: "auto", whiteSpace: "pre-wrap" }}
            aria-label="產生的唯讀 SQL"
          >
            {sql}
          </pre>
        )}
      </div>
    </section>
  );
}

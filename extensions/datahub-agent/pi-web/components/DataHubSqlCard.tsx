"use client";

import { useEffect, useState } from "react";
import { isSqlCard, isSqlReceipt, type SqlCard } from "@/lib/sql-contract";
import styles from "./DataHubSqlCard.module.css";
import { isQueryReceipt } from "@/lib/query-contract";
import { DataHubQueryReceipt } from "./DataHubQueryReceipt";

function decimal(value: string): string {
  const [whole, fraction] = value.split(".");
  return (
    whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") +
    (fraction ? `.${fraction}` : "")
  );
}

const scale = BigInt(1_000_000);
function millionths(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * scale + BigInt(fraction.padEnd(6, "0"));
}
function asDecimal(value: bigint): string {
  return decimal(
    `${value / scale}.${(value % scale).toString().padStart(6, "0")}`,
  );
}
function categoryTotals(points: SqlCard["points"]) {
  const grouped = new Map<string, bigint>();
  for (const point of points)
    grouped.set(
      point.category,
      (grouped.get(point.category) ?? BigInt(0)) +
        millionths(point.salesAmount),
    );
  return [...grouped].sort((a, b) =>
    a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1] > b[1] ? -1 : 1,
  );
}

export function DataHubSqlCard(props: {
  value: unknown;
  pending: boolean;
  error?: string;
}) {
  if (!props.error && isQueryReceipt(props.value))
    return <DataHubQueryReceipt receipt={props.value} />;
  if (isSqlReceipt(props.value)) return <LegacySqlCard {...props} />;
  return (
    <section className={styles.card} aria-label="DataHub metadata 查詢">
      <h3>Metadata SQL 查詢</h3>
      <p role="status">
        {props.pending
          ? "正在以可見 metadata 產生並執行唯讀查詢…"
          : `查詢未完成；${props.error ?? "沒有可展示的結果。"}`}
      </p>
    </section>
  );
}

/** Historical fixed-case receipts remain readable; never replay them. */
function LegacySqlCard({
  value,
  pending,
  error,
}: {
  value: unknown;
  pending: boolean;
  error?: string;
}) {
  const receipt = isSqlReceipt(value) ? value : null;
  const [card, setCard] = useState<SqlCard | null>(null);
  const [state, setState] = useState<"pending" | "expired">("pending");
  useEffect(() => {
    setCard(null);
    setState("pending");
    if (
      !receipt ||
      Date.now() >= receipt.resultExpiresAt ||
      window.parent === window
    ) {
      setState("expired");
      return;
    }
    let finished = false;
    const channel = new MessageChannel();
    const fail = () => {
      if (!finished) {
        finished = true;
        setState("expired");
        channel.port1.close();
      }
    };
    const timer = setTimeout(fail, 27000);
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      if (
        finished ||
        typeof event.data !== "string" ||
        event.data.length > 32768
      ) {
        fail();
        return;
      }
      let response: unknown;
      try {
        response = JSON.parse(event.data);
      } catch {
        fail();
        return;
      }
      if (
        !isSqlCard(response) ||
        response.resultRef !== receipt.resultRef ||
        response.datasetUrn !== receipt.datasetUrn ||
        response.chartUrn !== receipt.chartUrn ||
        response.dashboardUrn !== receipt.dashboardUrn ||
        response.format !==
          (receipt.format === "datahub-sql.source-receipt/1"
            ? "datahub-sql.source-card/1"
            : "datahub-sql.card/1")
      ) {
        fail();
        return;
      }
      finished = true;
      clearTimeout(timer);
      channel.port1.close();
      setCard(response);
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
    return () => {
      clearTimeout(timer);
      if (!finished) channel.port1.postMessage({ type: "cancel" });
      finished = true;
      channel.port1.close();
    };
  }, [
    receipt?.resultRef,
    receipt?.resultExpiresAt,
    receipt?.datasetUrn,
    receipt?.chartUrn,
    receipt?.dashboardUrn,
    receipt?.format,
  ]);

  return (
    <section className={styles.card} aria-label="DataHub 受控銷售查詢">
      <header className={styles.header}>
        <h3>按商品分類的每月銷售額</h3>
        <span className={styles.status}>
          {card
            ? card.format === "datahub-sql.source-card/1"
              ? "來源已查詢 · Grafana 尚未對帳"
              : "來源執行與 Grafana 核對"
            : "需即時核權"}
        </span>
      </header>
      <div className={styles.body}>
        {pending ? (
          <p role="status" className={styles.explanation}>
            等待可信 Host 核權；尚無查詢結果。
          </p>
        ) : !receipt || error ? (
          <p role="status" className={styles.explanation}>
            查詢未完成或不受支援；沒有可展示的數值。
          </p>
        ) : card ? (
          <>
            <p className={styles.explanation}>
              固定報表範圍 {card.from} 至 {card.through}
              ，本地幣別；明細淨額不含稅費。
              {card.format === "datahub-sql.source-card/1"
                ? "這是可信來源結果；僅連結既有 Grafana 資產，並未執行或對帳 Grafana Panel。"
                : "Grafana Panel 5 的分類合計對帳不等於每個月×分類都經原生 panel 驗證。"}
            </p>
            <div className={styles.dashboardPanels}>
              <section className={styles.metricPanel} aria-label="合計指標">
                <h4>銷售淨額合計</h4>
                <p className={styles.total}>
                  {asDecimal(
                    card.points.reduce(
                      (sum, point) => sum + millionths(point.salesAmount),
                      BigInt(0),
                    ),
                  )}
                  <small>所列月份／分類</small>
                </p>
              </section>
              <section className={styles.metricPanel} aria-label="商品分類比較">
                <h4>按商品分類比較</h4>
                <ol className={styles.bars}>
                  {categoryTotals(card.points).map(
                    ([category, value], _, all) => (
                      <li key={category}>
                        <span>{category}</span>
                        <meter
                          className={styles.barTrack}
                          min={0}
                          max={100}
                          value={
                            all[0][1] === BigInt(0)
                              ? 0
                              : Number((value * BigInt(100)) / all[0][1])
                          }
                          aria-label={`${category} 相對比例`}
                        />
                        <strong>{asDecimal(value)}</strong>
                      </li>
                    ),
                  )}
                </ol>
              </section>
            </div>
            <div
              className={styles.tableWrap}
              role="region"
              aria-label="每月分類數值"
              tabIndex={0}
            >
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">月份</th>
                    <th scope="col">分類</th>
                    <th scope="col">銷售額（本地幣別）</th>
                  </tr>
                </thead>
                <tbody>
                  {card.points.map((point) => (
                    <tr key={`${point.month}:${point.category}`}>
                      <td>{point.month}</td>
                      <td>{point.category}</td>
                      <td>{decimal(point.salesAmount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <dl className={styles.meta}>
              <div>
                <dt>來源資產</dt>
                <dd>{card.datasetUrn}</dd>
              </div>
              <div>
                <dt>圖表／儀表板</dt>
                <dd>
                  {card.chartUrn} · {card.dashboardUrn} · Panel {card.panelId}
                </dd>
              </div>
              <div>
                <dt>本次觀測</dt>
                <dd>{card.observedAt}</dd>
              </div>
              <div>
                <dt>資料截至</dt>
                <dd>{card.dataAsOf ?? "未經當次證實；不可視為目前資料時間"}</dd>
              </div>
            </dl>
          </>
        ) : (
          <p role="status" className={styles.explanation}>
            {pending || state === "pending"
              ? "正在向可信 Host 重新核權取得短效數值…"
              : "短效結果已過期或權限不符。請重新提出查詢；歷史卡片不會自動重執行 SQL。"}
          </p>
        )}
      </div>
    </section>
  );
}

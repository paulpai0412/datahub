import { isDashboardDraft } from "@/lib/dashboard-draft-contract";
import styles from "./DataHubDashboardDraft.module.css";

const labels = {
  stat: "單一指標",
  bar: "分類比較",
  line: "時間趨勢",
  table: "明細摘要",
} as const;

/** A proposal, not a Grafana render or a source query. No values are invented. */
export function DataHubDashboardDraft({
  value,
  pending,
  error,
}: {
  value: unknown;
  pending: boolean;
  error?: string;
}) {
  const draft = !error && isDashboardDraft(value) ? value : null;
  return (
    <section className={styles.dashboard} aria-label="DataHub 對話儀表板草稿">
      <header className={styles.header}>
        <div>
          <span className={styles.kicker}>對話儀表板 · 草稿</span>
          <h3>{draft?.title ?? "資料儀表板"}</h3>
        </div>
        <span className={styles.badge}>未授權 · 未執行</span>
      </header>
      {draft ? (
        <div className={styles.panels}>
          <section className={styles.panel} aria-label="指標預覽">
            <span className={styles.panelLabel}>
              {labels[draft.visualization]}
            </span>
            <h4>{draft.metric}</h4>
            <div className={styles.empty} role="status">
              <strong>—</strong>
              <span>尚無可展示的數值</span>
            </div>
            <p>
              查詢、語義與最終 SQL 尚待來源授權，沒有執行 Grafana 或來源查詢。
            </p>
          </section>
          <section className={styles.panel} aria-label="資料範圍">
            <span className={styles.panelLabel}>來源與維度</span>
            <dl>
              <div>
                <dt>Dataset</dt>
                <dd>{draft.datasetName}</dd>
              </div>
              <div>
                <dt>分組</dt>
                <dd>{draft.dimension ?? "未指定"}</dd>
              </div>
              <div>
                <dt>圖型</dt>
                <dd>{labels[draft.visualization]}</dd>
              </div>
              <div>
                <dt>Catalog 讀取</dt>
                <dd>{draft.queriedAt}</dd>
              </div>
            </dl>
          </section>
        </div>
      ) : (
        <p role="status" className={styles.notice}>
          {pending
            ? "正在核對 DataHub 資產可見權限…"
            : "資產不存在、無權查看或草稿無效；不顯示來源數值。"}
        </p>
      )}
      <footer className={styles.footer}>
        {draft && <span>資產：{draft.datasetUrn}</span>}
        <strong>尚未建立 Grafana Dashboard；此卡不代表 Panel 已查值。</strong>
      </footer>
    </section>
  );
}

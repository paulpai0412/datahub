# B／org2 Agent → 固定來源 SQL → 原生 Grafana：2026-09-26 實測

## 範圍與結論

- 入口：真 DataHub `http://localhost:9002/mfe/agent`，既有非管理員 B，模型 `openai-codex/gpt-5.6-sol`；只開 `datahub_catalog`、`datahub_sql`、`datahub_grafana`。B 的 org2 Viewer 讀取新建 `sales-monthly-category` Dashboard；不改 DataHub Core／org1。
- 來源：`SalesDatamart.reporting.v_sales_order_line`，2014-06-01～2014-06-30，固定唯讀聚合 SQL SHA-256 `5cb70f081f4210c9f947c6e7034f412316a65510ddc643aca6a09928932c22cc`；模型只提交意圖，不取得 SQL、來源憑證或業務數值。
- 首次一次性授權：真模型依序使用 Catalog、一次 SQL、Grafana，SQL 與授權皆 HTTP 200，訊息卡可見；但右側 iframe 因邊角命中判斷而隱藏，Grafana 沒有查詢，因此**首次未驗收數值**。原短效結果過期後沒有重送，詳見私有 `b-real-prompt-sql-dashboard-once.json` 與 `post-source-diagnosis.md`。
- 經使用者**另行明確核准**一條完全相同的唯讀 SELECT 和 Agent 修正版切換後，第二次真 B 流程於 `2026-09-26T08:58:56Z` 送出一則自然語言請求；來源只派送一次、HTTP 200、無未知效果或重送；原生 Grafana `/api/ds/query` HTTP 200，右側互動 Dashboard 可見。原生 frame 與 Host 原聚合讀回均為兩筆，逐筆月份／分類／金額比較一致。兩份原始數值及畫面只保存在 gitignored mode600 `.local/`，不置入模型、一般日誌或此文件。模型最終 stop；session 的工具序列為 Catalog → SQL（一次）→ Grafana，無額外工具或已知業務數值。
- 這是**Grafana 顯示結果與同一次來源聚合的端到端核對**，不是重新執行既有 Grafana Panel 5 的獨立來源查詢；不把此項擴張宣稱成既有 Panel 5 對帳，也不關閉更廣的 SQL TODO。

## 失敗、修復與負例

- 視圖原先要求多個可視點全部通過遮擋命中；微小角落遮擋足以讓已掛載 iframe 不可見。合成瀏覽器回歸先重現 RED，調整至中央可視且保留祖先裁切判斷後，13 個情境 GREEN（角落遮擋可顯示、中央遮擋仍須隱藏、展開／關閉、失權、策略替換等）。真 B 第二輪已證明原生 frame 實際可見與資料查詢通過。
- 有效結果期間錯 Grafana Viewer、錯 org、缺 server-only 金鑰均為 403；無效 displayRef 的原生查詢在來源讀取**之前**被拒，無額外來源查詢。修正版映像 `sha256:46423d4cc3953354a7127125ca72d7650b52074d9738e07455917cb169c7e978` 與 223 件瀏覽器資產同源校驗 PASS；556 檔 downstream patch 可精確還原並通過原 506 檔基線；scoped TypeScript、LSP、Grafana 8/8 單測、合成瀏覽器 13 情境通過。未做獨立審查（使用者免除）；這些檢查不替代真 UI 數值收據。
- 驗收後，已移除 B 暫時性 SQL 與 Grafana Host grant／服務金鑰路徑配置，重啟**僅本案 Agent**。B `/mfe/agent`、模型與 org2 Dashboard 仍可讀；Host `/agent/sql`、`/agent/grafana`、舊 `displayRef` 均回 403 `*_not_configured`，未再執行來源。新 org2 Dashboard 保留，但撤權後無可用的即時數值查詢；若將來需要持續使用，須重新核准並設計長期授權，不得用本次已耗盡的測試核准重啟計數。

## 私有原始證據

`.local/evidence/agent-grafana-live-20260926/`：`b-real-prompt-sql-dashboard-second-once.json`、`b-real-numeric-private.json`、`b-real-prompt-dashboard-private.png`、`b-second-session-readonly-reconcile.json`、`b-post-revoke-readonly.json`、`corner-visibility-green-r3.log`、`corner-fix-artifact-check.json`、`corner-fix-downstream-check.log`。該目錄為 gitignored；不可提交、列印其中的原始憑證、opaque refs 或業務值。

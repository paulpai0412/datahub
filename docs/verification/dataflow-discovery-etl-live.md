# ETL 分析插件：真 Agent 驗收

日期：2026-09-27。使用者澄清要驗收「分析 ETL 插件」，不是執行 ETL。

## 結果

**ETL 分析主流程通過；整個 workspace 的原生 BI 綁定尚未通過。**

| 案例 | 輸出欄位 | Jobs | 真 UI 逐欄核對 | 原生對話重載 |
|---|---:|---:|---|---|
| `etl.py::run_etl` | 37/37，未解 0 | 4 | 通過 | 通過 |
| `summary.py::main` | 8/8，未解 0 | 3 | 通過 | 通過 |

- 真 DataHub MFE → 獨立 9141 Agent → `openai-codex/gpt-5.6-sol`（medium/read-only）→ `datahub_etl` → `legacy-static 1.0.3`。
- 每例一次使用者 prompt、4 次真工具呼叫：列插件、列 workspace、描述入口／連線、帶 snapshot 與連線選擇分析。兩例均無工具錯誤、runtime retry 或替代執行路徑。
- Host 使用當次 DataHub 身分／權限檢查與原生 Catalog 讀取，不注入歷史 Catalog。分析觀測時間為 13:58:14Z（ETL）；Summary 的精確時間在原始 preview。
- 來源為 feature worktree 的既有 17 檔；snapshot `52f3802ee776607b2a62b36f05d41f187b0cb28531748335738a48127a849903`，前後未變。
- 完整 graph、workflow、coverage、來源掃描對帳及來源證據與歷史基準相同；**不是只比較欄位數，也不是整份 preview 無差異**。差異只有 request/time/digest 與明確核對的 BI 綁定結果、相關 blockers。
- 真 MessageView 逐一切換目標 Dataset，檢查全部 45 個輸出欄位的型別、來源分類、值來源與條件欄位；展開全部關係，核對來源檔／行號。Jobs 與其來源證據也已核對。
- 即時 reload 與 RPC 正常 idle 結束後的 saved-session reload 均保持原始訊息／結果／usage 不變，沒有重送模型 prompt。

## 語意檢查

沿用先前獨立於分析器答案、由 ETL 原始碼建立的七項斷言，改驗本次真模型收到的原始結果：

1. LineNetAmount 的值來源恰為 OrderQty、UnitPrice、UnitPriceDiscount。
2. SalesOrderHeader.Status 是條件，不是 LineNetAmount 的值來源。
3. DateKey 為日曆生成，不杜撰 OrderDate lineage。
4. Fact ProductKey 的值取自 dim_product.ProductKey。
5. 原始 ProductID 為 lookup 條件，與 lookup 值來源分開。
6. Summary 七個投影各自對應實際 SQL 欄位。
7. COUNT_BIG(*) 的 LineCount 是 rowset 生成，不虛構欄位來源。

七項全部通過。這不驗證數值、交易、SQL 執行或來源資料品質。

## 尚未通過：7 個原生 BI panel schema

兩例都保留 1 個 view／24 欄位、9 個 BI 查詢／18 個輸出宣告；但 `nativePanels=0`、`relatedCoverage.complete=false`。

實際 Host 回 `grafana_native_projection_changed`，再以同一真 DataHub 身分、公開 GraphQL 對確切 7 個既有 Grafana Dataset 核對：

| Panel | 來源／歷史投影 | 當次 Catalog 多出 |
|---|---|---|
| 1–3 | `value` | `time`, `value_none` |
| 4 | `time`, `sales_amount` | `value_none` |
| 5 | `category`, `sales_amount` | `time`, `value_none` |
| 6 | `territory`, `sales_amount` | `time`, `value_none` |
| 7 | `line_count`, `order_count`, `quantity`, `line_net_amount`, `source_line_total` | `time` |

`grafana_schema.bind_native_dashboard_queries` 要求原生欄位清單與 SQL 投影一致，故正確拒絕宣稱綁定完成。這裡證明的是**目前 metadata 與來源宣告不一致**，沒有調查或認定是哪個 ingestion／操作者造成。沒有修改 metadata、放寬比對或重跑 ETL。

預覽另有 `dataflow_job_publication_plan_not_compiled`；本次只驗分析，未授權發布，不能把它改標成已匯入。整體 preview 的 `complete=false`／未匯入／INCONCLUSIVE 保持原樣。

## 範圍與保留的失敗

- 使用者另行明確核准：只把既有 workspace、14 個 Dataset 與對應 BI metadata 加入獨立 9141 唯讀來源清單，重載 9141 並保留 HOME/session。未改 9041、Core、共享 MFE 設定、模型或映像。
- DataHub 瀏覽器登入過期，第一次找不到 iframe、第二次 reload 到 `/login`；均在任何模型 prompt／設定套用前。使用者手動登入後續行，不讀取憑證。
- 準備腳本誤把 actor policies 當 Map；修正為既有函式實際回傳的 array，原失敗保留。產品 parser 未修改。
- 完成兩個模型案例後，額外 V2 `systemMetadata=true` GET 收 HTTP 400：`missing type id property '__type'`。該補充 probe 失敗保留，沒有重播或修 Core；不能宣稱 V2 系統 metadata 讀回通過。主流程使用的是既有 V3 batchGet。上述 BI 欄位差異另由公開 GraphQL 的精確七 URN 唯讀查詢確認。
- 最初高長度元素截圖受 iframe 裁切，不作完整視覺證據；後補 `viewport-header.png` 為實際可視畫面。完整欄位證據是實際 UI 操作與逐欄 readback，不以單張截圖代替。
- 最後補充狀態腳本誤假設 idle-ended RPC 還有 `state.isStreaming`；保留錯誤，依真 `running:false` 核對已結束，沒有重建 session／重跑模型。兩例保存歷史仍可讀。
- 無來源程式 import/執行、SQL、資料列讀取、metadata 寫入、第三方發布、子代理或獨立審查；審查是使用者免除，不是 PASS。
- Browser-only MFE 導向 9141 仍是測試接線，不是共用 9041 或正式導覽部署驗收。

## 原始證據與 session

私有目錄：`.local/discovery-plugin-contract/parallel-test-r1/etl-live-r1/`。

- `authority.json`、`config-before.json`、`config-proposed.json`、`reload-*.json`：授權與唯一設定變更。
- `etl/`、`summary/`：prompt、真 admission、SSE、完整 preview、native history、reload、45 欄 UI readback 與畫面。
- `acceptance-report.json`、`verify-results.py`：完整 payload 差異與七項來源語意核對；不是重新執行模型或 ETL。
- `bi-projection-readback.json`、`bi-projection-comparison.json`：當次七 panel 欄位差異。
- `catalog-readback/`：保留的額外 V2 400，不是成功收據。
- `final-browser-state.json`：兩個 RPC 已 idle 結束，保存訊息／usage 不變。
- `checkpoint.json`：最終 source／config／runtime／evidence hashes 與範圍。

Sessions：

- ETL：`01a0e328-5ad8-77f4-9b7c-668721963bf5`，SDK 72,491 tokens（含 cache read）。
- Summary：`01a0e32d-1f79-77f4-9b7c-6689adc2c28c`，SDK 51,856 tokens（含 cache read）。

## 後續界線

本輪 ETL 分析主流程已有真模型、fresh Catalog、語意與重載證據，不需再重播。若要使整個 workspace 的原生 BI 綁定通過，下一步應核對／對帳上述七個 schema 的來源與意圖；metadata 修正或重新 ingestion 需另准。OpenAPI 發布、CAS/ACL 建設及共用服務切換不是這個分析驗收的前置。

本輪回顧：真入口測試提供了先前保存資料重播找不到的 Catalog 差異；應保留這個差異，而不是擴建框架或把不完整結果改成 PASS。

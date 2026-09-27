# Metadata Query：隔離真 SQL Server 的逾時／取消驗證

2026-09-27。**現行執行器的逾時、HTTP 取消、來源 session 終止、並行名額恢復及相同請求不重跑，已在隔離真 SQL Server 通過。沒有發現需要修改產品執行器的缺陷；本輪新增可重跑測試，不改正式程式或部署。**

## 範圍與授權

使用者要求先補 SQL 執行生命週期，另明確批准一個臨時 SQL Server 容器：固定快取映像、1 CPU／3 GiB／無額外 swap、最多兩個並行來源 SELECT、僅 loopback 隨機埠、合成資料與新測試帳號。首輪停輪後，另批准額外最多五次 SELECT 的新隔離輪。沒有取得或使用既有來源／Grafana 憑證，不碰 SalesDatamart、正式帳號、DataHub 政策、9041 Agent 或其他服務。

- SQL Server 映像：`mcr.microsoft.com/mssql/server@sha256:46f719fd3457d4e7e8e5845fe00c35c20e7bae7ff1e8b9fe595f2a81029f5ba8`，`--pull never`。
- 專用 tmpfs 儲存，沒有既有 volume；每輪只停止／移除該輪精確 ID 與 owner label 的容器。
- 合成 controller 只在新實例建立測試 DB、表格與 SELECT-only reader，持有可 rollback 的寫入鎖，透過該實例 DMV 觀測 reader PID／session／等待／交易狀態。管理監測不冒稱業務 SQL。
- 正式 Agent 仍為 PID `4163284`、Pi image `148737d342c9…`；沒有 build、重啟或重新部署需求。

## 測試層次

1. `tests/test_agent_query_lifecycle.mjs`：真 MessageChannel 的 MFE cancel → 真 loopback HTTP 斷線 → 產品 Host／source child 管理；child 明示為 fixture。確認等待 close 才釋放名額、取消後晚到成功資料不產生收據、40 秒 watchdog 與 1 秒後 kill escalation、相同取消請求不重跑，以及新查詢恢復。
2. `tests/check_agent_query_lifecycle_native.mjs`：產品 gateway／Host／compiler／`query_runner.py`／已安裝 python-tds 對真隔離 SQL Server 執行。DataHub identity／metadata 是明示 fixture；沒有模型、真 DataHub ACL、Grafana 或 UI 注入。使用正常 ticket exchange／heartbeat，沒有延長 TTL、停用認證或改 source timeout。
3. `tests/fixtures/query_lifecycle_control.py` 與 `query-lifecycle-http.mjs`：只供上述隔離測試。前者用 stdin 傳臨時秘密、SQL 綁定值及 SQL Server 原生 quoting 建測試帳號；後者依既有 gateway 測試方式送正確 actor Host／Origin，避免 Node fetch 忽略自訂 Host。

這兩段證據**不能合併宣稱真模型／pi-web Stop 按鈕到資料庫的完整 E2E**；正式 B／org2 的成功數值閉環另見[原生查詢報告](datahub-agent-metadata-query-native-20260926.md)。

## 真實結果（native-r3）

| 情境 | 觀測與結果 |
| --- | --- |
| driver timeout | DMV 先確認 reader 於 `LCK_M_S` 等待鎖；約 **30.239 秒**後回 422 `query_execution_unconfirmed`，不是成功收據。child 正常非零結束，無殘留 reader session；鎖尚未釋放時即確認來源工作消失。 |
| 逾時後相同 requestId | 保留原錯誤，不新增來源 child／SELECT。 |
| 逾時後新查詢 | rollback 測試鎖後，新的 requestId 實際 SELECT 成功；UI-only result 讀回固定合成值，沒有重跑來源。 |
| 兩個並行／第三個請求 | 兩個 reader 均在資料庫等待鎖，第三個回 429 `query_capacity_exhausted`，不新增來源執行。 |
| HTTP cancel | 真 HTTP AbortSignal 斷線傳至產品 child，SIGTERM／close 後原 requestId 回 502 `query_cancelled`。DMV 確認該 reader session 消失，另一個 reader 仍等待原鎖。 |
| 取消後恢復 | 取消請求不重跑；新 requestId 可進入釋放的名額，與原另一個 reader 同時被 DMV 觀測。rollback 鎖後兩者均取得正確合成結果，所有 reader session 消失。 |
| 清理／副作用 | 5 次來源 SELECT dispatch，0 Grafana publication，0 模型提示，0 既有來源查詢；controller exit 0，owned container 移除。 |

「來源 session 消失」由 DMV 獨立觀測，不只依 HTTP error 或 child exit 推斷。取消的 10ms 收據延遲不是 DB 全域取消 SLA。30 秒證據是這次鎖等待下的 driver timeout；持續回傳封包的長查詢、網路黑洞、不可中斷的來源工作及強制 SIGKILL 的真 DB 情境未驗。40 秒／1 秒硬期限只在本地虛擬時鐘測試驗證，不冒稱精確的伺服器 statement-timeout 保證。

## 保留的失敗與修正

- **native-r1：1 次 SELECT。** 約 30.190 秒逾時、child／DB session 結束已確認。其後相同請求的對帳卻回 401：測試只 bootstrap、沒有消耗一次性 ticket；即使 grant lease 是 90 秒，未交換的 ticket 仍會在 30 秒被 sweep。不是來源重試，也不是產品 timeout 失效。原收據維持 `complete:false`，container 已移除。
- **native-r2：0 次 SELECT。** 補 exchange 後，Node fetch 忽略人工指定的 Host，令請求落在錯誤 origin 邊界而回 403。純 loopback 探針確證，沒有碰來源 SQL；container 已移除。改用既有 gateway 測試採用的 `http.request`，不放寬產品 Host／Origin 校驗；正常交換及「heartbeat 不能挽救未交換 ticket」的本地回歸先通過，再沿尚未使用的五次額度續測。
- **native-r3：5 次 SELECT，全情境通過。** 累計測試來源 SELECT 是 **6 次**，不是刪掉前輪後只報五次。每輪為不同 owned fixture，沒有重送未知效果或既有業務查詢。

測試修正只補齊真 MFE 的認證流程。既有產品的認證、timeout、取消及並行限制均未放寬。原始失敗、對應腳本 bytes 與每輪原始收據保留。

## 可重跑檢查

無外部服務／真資料庫的回歸：

```bash
node --test tests/test_agent_query_lifecycle.mjs tests/test_agent_metadata_query.mjs \
  tests/test_agent_metadata_query_gateway.mjs tests/test_agent_gateway.mjs \
  extensions/datahub-agent/mfe/sql.test.mjs
.venv/bin/python tests/test_agent_metadata_query.py
```

本次 **30 Node／6 Python PASS**。四個新測試檔 scoped LSP 無 error；native script 的 JS timer callback 型別推論對 `await heartbeatPending` 留有 80007 hint，仍保留實際等待 heartbeat 完成的行為，不刪掉正確的清理等待。

需先取得隔離操作批准、使用全新私有輸出目錄的真 SQL Server 檢查：

```bash
umask 077
node tests/check_agent_query_lifecycle_native.mjs --approved-isolated \
  --output-dir "$PWD/.local/evidence/<new-owned-round>"
```

CLI flag 本身不是授權。非預期失敗先查該輪 receipt、子程序／容器狀態，不能盲重跑或覆寫舊輸出。

私有證據：`.local/evidence/query-lifecycle-20260927/`，含 `native-r{1,2,3}/receipt.json`、原始失敗腳本、回歸 log 與 `checkpoint.json`。臨時密碼／connection／SQL Server log 均留 mode600 私有檔，不列入公開內容。

## 尚未完成

本次第 1 項在隔離 MSSQL 執行層完成，不等於整項 SQL 驗收。仍缺正式真模型 Stop 按鈕完整鏈、其他來源、結果空值／精度／截斷邊界、metadata 撤權／schema 失效與規則化關係驗證／正式 native audit。下一步建議第 2 項結果邊界；`TODO-51730abb` 維持 open。無 commit／push、DataHub Core 修改、子代理或獨立 review。

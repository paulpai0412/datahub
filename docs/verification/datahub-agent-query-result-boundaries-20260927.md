# 查詢結果邊界收尾（2026-09-27）

**本輪已收尾：8 次隔離真 MSSQL SELECT、原生 Infinity 解析／原生 Dashboard 標題讀回通過；截斷警告經明確批准只重載 Agent Host，已生效於後續新建的 Dashboard。** 不再擴張至撤權、schema 變更、其他來源或關係發布。

## 完成與範圍

| 項目 | 證據 |
| --- | --- |
| 精度與 NULL | 真 MSSQL `bigint` 正負極值、`decimal(38,18)`、NULL、空字串、Unicode、日期與 bool，經產品 compiler／runner／Host／UI-only result 讀回保持語意。大整數／decimal 為精確字串，不轉成 JS Number。 |
| 空結果 | 零列為 `EMPTY`；空集合的 SUM=NULL、COUNT=0 是一列有效結果，不與零列混淆，不宣稱關係驗證 PASS。 |
| limit／truncation | 剛好 3 列不誤判截斷；limit=1 與最大 limit=1000 均多讀一列確認截斷，返回列數受限。 |
| 超量與恢復 | 8193 字元單格及總 UTF-8 超 1 MiB 均回 `query_result_too_large`，沒有成功收據；相同 requestId 不重跑，新請求正常恢復。 |
| 模型隔離 | SQL／rows／columns／truncation 不進模型收據；精確值只經受控結果讀回。重開／刷新不重新執行 SQL。 |
| 原生 Infinity | 固定 Grafana 13.1.2／Infinity 3.11.2 對上述已捕捉合成結果，以官方 inline backend parser 驗證 6 組表格 frame、1 組 numeric frame。表格精確字串與 NULL 保留；圖表數字是明示的浮點投影，不假稱任意精度。 |
| 可見截斷提示 | 所有圖型的圖表與附表標題加上「已截斷，僅含前 N 筆」，不再只放在 Dashboard 說明或 SQL 預覽。隔離原生 Dashboard 寫入／讀回確認標題；模型 embed 標題不夾帶筆數。 |

只改產品 `extensions/datahub-agent/integration/query-grafana.mjs` 的標題，沒有更改查詢、授權、重試、schema、資料來源或收據契約。舊 Dashboard 保留，不批次修改歷史資產。

## 真實操作與部署

- 使用者另批准隔離原生檢查：MSSQL 固定快取 image、1 CPU／3 GiB／無額外 swap、loopback 隨機埠、tmpfs、新合成 DB 與 reader；**8 次來源 SELECT**，完成後 owned 容器移除。
- MSSQL 清理後才建立 Grafana：固定快取 image、1 CPU／512 MiB／無額外 swap、network-none、tmpfs；只複製既有公開 Infinity 插件產物作唯讀掛載，未複製既有設定／DB／憑證。兩輪 owned 容器均移除。
- 原生 Infinity 檢查新增 SQL **0**、模型提示 **0**、既有 Grafana 寫入 **0**。inline 測的是原生解析，**不是新的認證 URL transport／瀏覽器 DOM E2E**；原兩題真入口／URL datasource E2E 沿用[既有 r3 證據](datahub-agent-metadata-query-native-20260926.md)，沒有為修報告重跑來源。
- 使用者再明確批准 **只重載本案 Agent Host**。39 個 Host 程式檔與部署基線相比，只有本輪 builder 修正；重載前後逐檔核 SHA，沒有帶入其他改動。
- 正常 drain 舊 PID **4163284** 與其 owned runtimes，啟動新 PID **2364312**。Pi image 仍為 `sha256:148737d342c96288d4a1b3ce3c17f0ec5f9400e5e4ce61f99aeb7811fabd935f`，設定 bytes／browser assets 不變；無新 SQL、模型提示或 Grafana 寫入。匿名 bootstrap 仍回 401 `authentication_required`。
- 重載會清除記憶體短效結果，不復活舊 grant、不重播查詢。沒有修改 DataHub Core、來源帳號、Grafana org1/org2 或其他服務；無 commit／push／子代理／獨立 review。

## 保留的測試失敗

1. Python 初版把 Decimal 負零字串硬寫成固定小數格式；實際 `-0E-18` 保留相同值、符號與 scale。改核 Decimal tuple，不修改正確產品 serializer。原 RED log 保留。
2. 截斷可見性回歸先 RED：舊面板標題只有「查詢結果」。在既有 builder 加可見標題後 GREEN，涵蓋 table/bar/stat/timeseries。
3. Infinity 第一次原生 frame HTTP200，值與 NULL 都正確，但測試錯誤要求欄位順序等於 request 順序；原生 frame 以欄名排序。離線逐欄對帳證明數值全相等，改以欄名比對後原流程完成；沒有調整產品 parser 或重新執行 SQL。原 FAIL、frame、腳本與修正原因保留。

## 可重跑檢查與證據

- `tests/test_agent_query_result_boundaries.py`：serializer／DB-API 清理、limit lookahead、空結果、精度、非有限值、單格與 byte 邊界。
- `tests/test_agent_query_result_boundaries.mjs`：真 compiler／Host 結果契約、模型隔離、空值與截斷、失敗不重跑及恢復；來源與 publisher 明示 fixture。
- `tests/check_agent_query_result_boundaries_native.py` ＋ `tests/fixtures/query-result-native.mjs`：需重新取得授權的新 MSSQL 隔離輪，不重播本輪腳本。
- `tests/check_agent_query_result_infinity_native.mjs`：需授權的隔離 Grafana 原生解析，使用既有捕捉結果，不執行 SQL。
- 本次最終本地回歸 **34 Node／16 Python PASS**。兩個原生測試檔後續被自動格式化；從本會話原工具寫入還原測試當時 bytes，核對原生收據 SHA 一致，再確認與目前檔案 AST 等值，見 `post-format-readback.json`。不為格式差異重跑 SQL／模型或重新部署。
- scoped LSP 對產品 builder／Python／worker 無錯誤。Infinity 檢查器有 inferred TypeScript 1128 舊診斷；當前 TypeScript parser 零診斷、`node --check` 與真執行均通過，差異存 `parser-readback.json`，不為舊診斷改寫正確語法。
- Python SQL sink scanner 誤報已標記：四個 SQL 呼叫的首參數均是固定字面量，含 `%s` 的呼叫皆獨立綁定參數；AST 證據見 `sql-sink-readback.json`，沒有忽略真正插值 SQL。

私有證據：`.local/evidence/query-result-boundaries-20260927/`，含原始 RED、`sql-native-r1/`、`infinity-native-r{1,2}/`、`agent-reload.json`、`post-reload-readback.json`、最終回歸 log 與 `checkpoint.json`。憑證及合成 raw frames 留在受保護 `.local/`，不提交。

**本輪到此完成。** `TODO-51730abb` 的整體 SQL／可信 Join 工作仍 open；真模型 Stop、metadata 撤權／schema 失效、關係審核／失效及其他來源不是本輪交付，不在此繼續展開。

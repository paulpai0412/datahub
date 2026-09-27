# 通用 Metadata SQL／動態 Grafana：本地驗證

> 本文件保留前輪本地驗證截點。後續的真隔離 Grafana API、相容性修正與候選 image/assets 封裝見[後續驗證](datahub-agent-metadata-query-native-20260926.md)；正式來源閉環仍未驗收。

2026-09-26。**本地實作與回歸通過；未部署，未做真來源／真 Grafana／真模型自由問題驗收。** `TODO-51730abb` 維持 open，不能以本報告或舊固定六月成功宣稱通用產品已可手測。

## 已接上的程式

- Pi 工具的 `datasets / joins / select / filters / groupBy / orderBy / limit / chart` 動態契約；沒有固定資料集、月份或業務指標。支援同來源多表、複合 ON、inner/left/full（MySQL 不支援 full）、聚合、日期分桶與排序；不接受模型 SQL／任意 endpoint／credential。
- 當前登入者的 DataHub metadata／欄位 ACL → 精確來源 binding → SQLAlchemy 參數化 SELECT → 有界 driver child。沒有逐人 SELECT grant、逐題 approval 或 `maxExecutions:1`。DB 帳號拒絕就回錯誤，不冒稱个人 DB/RLS。
- transient typed results 與無數值模型 receipt；UI-only SQL 預覽不重執行。空結果、到期、schema／權限改變與錯 Actor／Viewer／org 都有拒絕路徑。取消等待 child close，不自動 retry。
- 原生 Grafana writer：身分 lookup、每人私有 folder／ACL 讀回、動態 table/bar/time-series/stat Dashboard 與原生讀回。可由部署提供既有帳號的身分對照，與 SQL 查詢授權分離；無對照的一般同名 SSO 使用者不需列入白名單。
- Pi／MFE／server／gateway 接線、右側同站 sibling portal，固定 `theme=light`；歷史舊 receipt 的展示能力保留，但不重播查詢。原生圖表使用數值型別繪圖，附表保留 decimal／大整數原字串。

## 證據與範圍

私有本地收據：`.local/evidence/metadata-query-local-20260926/`。這裡都是合成值，不引用或複製前輪真業務數值。

| 檢查 | 結果 | 實際證明的範圍 |
| --- | --- | --- |
| `tests/test_agent_metadata_query.py` | 6 PASS | 真 SQLAlchemy SELECT tree 在記憶體 SQLite fixture 算出複合 Join 的分區金額與不同 count 查詢；四方言編譯、參數／識別符、拒絕條件、DB-API 模擬、原生 pytds signature、rollback／limit。不是 MSSQL／Oracle 真來源驗收。 |
| Node scoped suites | 149 PASS | Query Host、native API adapter 的合成回應、gateway 真本地 HTTP、SQL/Grafana 工具、MFE、訊息卡、舊路徑與既有工具選擇回歸。涵蓋來源拒絕不重送、未知寫入不重播、先撤權／後撤權、Viewer／org／grant、私有 folder 漂移拒絕、不同登入名映射、長多 Dataset receipt，以及 child 取消 drain。 |
| `check_agent_metadata_query_browser.mjs` | PASS，2 個不同查詢／Dashboard | 真 Chromium、產品 React／Pi tools／Host bridge／MFE／Query Host 接線；複合 Join 聚合與 count/stat 不同 payload、SQL preview、淺色 URL、互動 sibling frame、mobile、撤權拒绝。**DB 與 Grafana frame 是合成替身，模型 prompt = 0、真來源 SQL = 0。** |
| `check_agent_grafana_sidecard_browser.mjs` | 13 情境 PASS | 既有 portal 的角落遮擋、中央遮擋、放大還原、scroll、close/reopen、unmount、mobile、ACL/政策替換等回歸，非真 Grafana。 |
| `tsc --noEmit --incremental false` | PASS | Pi-web 型別檢查；沒有執行本地 `next build`，沒有改 `.next`。 |
| MFE production webpack | PASS | 當前 MFE bundle 可建置；現行 Host 先前已載入的 assets 不因此切換。 |
| downstream reverse + baseline | PASS | 560 個当前 Pi source files，精確 reverse 到原 506-file baseline，原 baseline 三項檢查通過。不是新 runtime image／browser-assets 同源部署驗證。 |

主要原始收據：`python-tests.log`、`node-tests.log`、`browser-query.json`、`browser-legacy.json`、`dynamic-light-synthetic.png`、`typecheck.log`、`mfe-build.log`、`downstream-check.log`、`downstream-refresh.json`。截圖明示 `SYNTHETIC_GRAFANA`，不可當原生 Grafana 成果展示。

Scoped LSP 初次 20 檔無診斷。後續 Host 身分對照修改後，LSP 對 `metadata-query.mjs:139` 回報 inferred-project `1128 Declaration or statement expected`；當前 bytes 的 `node --check`、TypeScript 原生 parser 與所有 Node import/行為測試均通過，原碼未為此輸出重寫。對應 SHA 與零 parse diagnostics 見 `syntax-recheck.json`。這是已記錄的 LSP／當前 bytes 差異，不把無 cache 或 auxiliary scanner silent 稱作全專案乾淨。

## 修正與保留

- 找到 `pytds.connect` 使用 `dsn`，而非通用 `host` keyword；修正 adapter 並以目前安裝的真 driver signature 做不連線回歸，避免「能 compile、卻不能呼叫 driver」。
- 非目前日期的 time-series 使用結果時間範圍；table 不用浮點數吞掉 decimal 精度。新多 Dataset receipt 不再被舊 4 KiB 回應限制截斷。
- Grafana JSON member 順序不屬 API 契約：重排鍵順序的合成讀回先重現 `query_grafana_readback_mismatch`，再改用 Node 原生 `isDeepStrictEqual` 比對完整 panel 結構和值，原回歸轉綠；沒有忽略欄位或放寬實值檢查。原失敗見 `grafana-order-red.log`。
- 首輪訊息卡測試仍期待舊「受控銷售查詢」名稱；更新成通用文案，保留敏感 input／數值不得顯示的原斷言。瀏覽器 resize 檢查改等待真跨 frame 重定位，不靠固定 sleep。
- downstream helper 首輪在私有 `umask 077` 下讓 Git 暫存 reverse 的 mode 變 0600（內容 hash 相同）；只設定該暫存 Git subprocess 的公開 source mode 基準，未改原碼／秘密權限。誤用系統 Python 的缺 `datahub` 模組錯誤亦保留，再用腳本註明的 `.venv/bin/python` 驗證。原失敗收據沒有刪掉。
- downstream snapshot 保留進入本輪前已存在、尚未封入舊 lock 的 11 個 ChatInput／i18n／tool-selection／rpc 檔案；沒有還原或重寫那些 WIP。其清單見 `downstream-initial-snapshot.json`，不把它們冒稱本輪新增功能或獨立審查成果。

## 尚未完成的部署／驗收

1. 為實際來源提供經授權的受保護連線；不借用 ingestion 管理秘密或重啟還原已耗盡的舊 SELECT grant。
2. 確認 Grafana datasource 後端 key／Viewer-org 身分、writer 能力、原生 folder ACL API 在本案固定版本的真相容性。沒有新建真 folder、修改真 ACL 或寫入真 Dashboard。
3. Oracle／PostgreSQL／MySQL driver 本輪未安裝；已有方言與程式接點不等於真連線通過。安裝／版本釘選／来源驗證另需對應環境授權。
4. 新 runtime image、browser assets 同源驗證與本案 Agent 切換尚未執行。再經真 `/mfe/agent` 自由提問至少兩種問題，含多表 Join，逐值核對原生 Grafana frame 與來源結果；包含跨 Viewer metadata/data 拒絕與撤權不重播。

部署設定與原生 API 依據見 [operations](../design/datahub-agent-metadata-query-operations.md)。無 Core patch、新業務 datastore、commit/push、子代理或獨立 review；本輪是主責自查，舊一次性試點額度沒有重用。

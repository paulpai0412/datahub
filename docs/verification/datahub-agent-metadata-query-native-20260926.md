# 通用查詢後續驗證：原生 Grafana API 與候選封裝

2026-09-26～27。**r3 已通過 B／org2 的兩題真三表 Join → 原生 bar/stat 與附表逐值對帳 → 無成功次數攔截的模型正常收尾。** 已補清楚工具的自帶附表說明，經使用者明確確認切換新 Pi 映像／同源 assets。r1 原生失敗及 r2 測試 guard 干預證據完整保留；較廣的 SQL 聚合驗證、安全負例與來源支援尚未全驗，`TODO-51730abb` 維持 open。

## 真原生 API 發現與修正

`tests/check_agent_query_grafana_native.mjs` 使用已快取、固定的 Grafana 13.1.2 映像 `sha256:d177053ab62253815f130d81504f77063baf5fd4ca93299d6048453bd31e047a`。產生合成帳號、org 與 Service Account，使用 tmpfs 與 `--network none`，透過容器內的原生 HTTP 呼叫產品 publisher；不掛現有 volume、憑證或來源，不修改既有 Grafana。

- **RED**：Service Account 的 `/api/user` 確實回 `id:0`，不是合成測試假設的正整數。原 adapter 回 `query_grafana_identity_unavailable`，尚未寫 folder／Dashboard。
- **因果修正**：`integration/query-grafana-folder.mjs` 經官方 Service Account search API 核對原生 name、login、org、啟用狀態與唯一性，再取 ACL principal ID。不猜 opaque UID、不以 0 當 userId、不放寬私有 ACL、不改用真人憑證。
- **GREEN**：同一 Viewer 的兩個不同 table/bar Dashboard 建立、原生完整讀回、私有 folder 重用成功；本人 GET 成功，另一 Viewer 被拒。未知／錯誤身分仍在寫入前拒絕。
- Writer 是隔離 org 的原生 Admin Service Account；未宣稱更窄角色／正式 SSO 已驗證。Grafana 原生 org administrators 的管理權不被此 ACL 機制撤銷。

這是**真 Grafana API 相容性**，不是正式 org2、Infinity query/frame、真業務資料或整條產品 E2E 驗收。合成瀏覽器 frame 仍不能當成原生 Grafana 畫面。

私有收據目錄：`.local/evidence/metadata-query-native-20260926/`。

- `grafana-native-e29f833a-fa37-4180-a806-f523e561aee5.json`：原生 identity RED。
- `grafana-native-828aebb6-7aba-484c-a86e-7b11c2e0b635.json`：原生 API GREEN、兩次發布、所有專用資源清理完成。
- `grafana-native-ae70739e-3c1e-46ba-9d79-d024124deb02.json`：第一次測試尚未呼叫 API 就因 internal network 無 port mapping 停止，容器／網路均清理。後續改為更嚴格的 network-none namespace 內 HTTP，未啟用 host network 或外網。

## 前輪回歸與建置（r2 使用的映像）

| 檢查 | 結果／範圍 |
| --- | --- |
| Scoped Node | 最終 **116 PASS**；含 folder 身分契約 13 項、DatasetKey 定位 6 項及 Infinity URL method 回歸。沒有宣稱重跑前輪所有 149 項。 |
| Python metadata query | **6 PASS**；SQLAlchemy／SQLite／driver 契約，非真 MSSQL 來源。 |
| 通用瀏覽器 | **PASS**；Join 聚合、不同 count/stat、SQL 預覽、淺色 URL、sibling portal、mobile、撤權；2 合成查詢／2 合成 Dashboard，真模型／真來源皆 0。 |
| 既有 portal 瀏覽器 | **13 情境 PASS**。 |
| TypeScript / MFE | `tsc --noEmit --incremental false` 與 production webpack PASS。未在開發 checkout 執行 Next build。 |
| Downstream | **560 files** 精確 reverse 到 **506-file** upstream baseline，原 3 項檢查 PASS。 |
| 原生 Grafana API | 13.1.2 隔離原生 API PASS；沒有 Infinity/frame／來源數值對帳。 |
| Docker candidate | 固定 Dockerfile／lock，專用 builder **1 CPU / 3 GiB / 無額外 swap / serial**；runtime、browser-assets 建置成功。builder 已停止。 |
| Artifact exactness | **223 assets** 與 runtime 同源逐檔 hash 相等；runtime operator scripts、npm lock 亦相等，560 個凍結 source bytes 仍與 checkout 相同。 |
| Scoped LSP | 4 個本轮修正／新增程式檔無診斷；不是全專案掃描。 |

r2 當時使用的 runtime 映像（Host adapter 為獨立 Node 程序；Infinity 修正只需重載 Host；r3 工具說明的新版映像見末節）：

```text
sha256:f1e06bfa1aca251ff029d222b36ee640811f1fab8c0dd4e67784e3574a732bf7
```

候選 assets：`.local/evidence/metadata-query-native-20260926/browser-assets/`。建置輸入見 `build-inputs.json`；結果見 `runtime-build-metadata.json`、`runtime-build.log`、`assets-build.log`、`artifacts-check.json`。只封裝 lock 列出的來源與兩個 runtime operator 檔，沒有帶入開發 HOME／秘密。

## 工作樹與驗證工具

- Pi lock 的 9 檔漂移已核對：5 檔 AST 相同，其餘 4 檔逐項 diff 為括號／JSX whitespace 等格式化。沒有覆寫已有 WIP；更新 downstream patch/lock 並對當前 bytes 重跑回歸。原始 AST 比較不把 JSX 排版當相同，因此保留差異與人工核對，不宣稱 9 檔皆 AST equal。
- `check-agent-downstream.py` 在私有 `umask 077` 下重建 Git patch，會把 upstream 的 0644 改成 0600 而失敗。僅對**暫存 Git apply 子程序**設 `umask=022`，不動 parent mask、真原碼或秘密 permissions；同一 `umask 077` 命令 RED→GREEN。見 `downstream-umask-red.log`／`downstream-check.log`。
- 保留原始失敗，不覆寫上輪收據。不改 DataHub Core、不新增業務 datastore、無子代理／獨立 review、commit／push。

## 核准後的正式操作與目前狀態

使用者明確核准 SalesDatamart 新唯讀查詢帳號（dm/reporting SELECT、30 秒／並行 2）、org2 專用資源、本案 Agent 切換及 B／org2／既有 GPT-5.6 Sol 的兩種真問題驗收。隔離測試證實 Editor 的 `/api/org/users/lookup` 回 403 後，另向使用者揭露並取得 **org2 Admin Service Account** 核准；不是 Server Admin，B 保持 Viewer。

- 新來源帳號 `datahub_agent_query` 已建立並讀回有效權限；沒有 sysadmin/db_owner、寫入、DDL、EXECUTE 或 AdventureWorks2019 存取。未修改業務資料與既有帳號。來源定位為 `mssql`／無 platform instance／`PROD`／`salesdatamart`。
- B 的七個真 Dataset 與欄位 ACL 預查通過。真 API 的 Dataset.name 只回短名、qualifiedName 為 null；`query-metadata.mjs` 改從授權後返回的完整 DatasetKey URN 取精確來源名稱，核對 platform/environment，不以顯示名稱猜資料庫。保留 RED→GREEN 與六項負例。
- org2 建立專用 writer/token、`datahub-query-results` Infinity datasource、backend key 與 B 私有 folder；原生讀回通過。初始環境配置五次已確認寫入，未動 org1、歷史 Dashboard、其他服務或全域主題。
- 第一次切換 Host 為 PID 212457；另獲修正重載與新輪次批准後，r2 Host 為 **2527525**（r3 已再切換，見末節）。兩次前程序與其自有 runtime 均正常停止，HOME 保留。新通用 binding 已啟用；舊 SQL/Grafana grants 設定鍵已移除，沒有恢復歷史一次性額度。回復設定保留在私有 `agent-server-before-query.json`，未執行回復。

收據：`source-principal.json`、`live-metadata-preflight-r2.json`、`grafana-provision.json`、`agent-stage.json`、`agent-restart.json`。秘密僅保存在受保護本機路徑，不納入本文。

## 真入口失敗與因果修正：Infinity URL method

`live-two-queries.json` 記錄真 `/mfe/agent` 的首題：B／GPT-5.6 Sol → 六次 Catalog 呼叫 → 一次 **三表、兩個 Join** 的實際 SELECT（HTTP 200）→ 一次動態 Dashboard 建立與讀回（HTTP 200）→ 淺色 sibling portal。第二題尚未送出，原生 frame／來源值未完成對帳，**不算 E2E 通過**。

- 原始失敗：等待原生 `/api/ds/query` 回應 90 秒逾時；模型 abort 回 200，隨後只讀核对確定模型已 stop，沒有背景 prompt。模型只收到 `datahub-query.receipt/1`、`datahub-grafana.embed/2`，沒有 SQL／rows／URL，也沒有額外工具或來源查詢。
- 真正原因：Infinity **3.11.2** 的 URL query 前端會讀 `url_options.method`；新 builder 漏了 `url_options`，產生 `Cannot read properties of undefined (reading 'method')`，在送出 datasource HTTP 前即失敗。不是 SQL、ACL 或模型回答失敗。
- 修正：`query-grafana.mjs` 在生成的 URL target 明確加入 `url_options: { method: "GET" }`。不改 Core／Infinity、不換 datasource、不放寬權限或加入重試。
- 原生瀏覽器判別：`tests/check_agent_query_infinity_browser.mjs` 讀取**既有失敗 Dashboard**，不寫 Grafana、不送模型／SQL。RED 用原始原生 DTO，重現 method TypeError、零 query request；GREEN 只在瀏覽器的 Dashboard GET 回應套入 builder 的 method，兩個 target 改正後可送原生 query，TypeError 消失。因原 browser grant 已失效，後端按規則拒讀，Grafana 回 400。這證明 client query 路徑恢復與失效保護，**不證明新的圖表數值成功**，也沒有改掉原始失敗 Dashboard。
- 當前磁碟修正的 Node 回歸 **116 PASS**；scoped LSP 無 error，新增 browser check 只有 Playwright `.mjs` declaration hint。query-metadata 的 inferred-project 1128 warning 與當前 TS parser 零診斷／原生執行證據不一致，保留 `metadata-parser-readback.json`，不以靜默掃描冒稱全專案無問題。

關鍵收據：`first-model-readonly-reconcile.json`、`first-dashboard-diagnostic-private.json`、`infinity-url-options-red.log`、`infinity-browser-red-green.json`、`infinity-fix-node-tests.log`。畫面／原始 response 均留私有 evidence，不公開值或秘密。

## 另行批准後的 r2：兩個原生數值主流程通過

使用者在停輪對帳後明確選擇「套用修正並開始新一輪」。暫停期間 11 個 source hash 與配置 hash 仍一致；只重載本案 Host（`agent-restart-r2.json`），未重建帳號／datasource、未改其他服務。載入的 `query-grafana.mjs` SHA 為 `f5238d6c361384bad77c92ece1a659579f67e6ed96b9296c1843e4b3ea6f6333`。

真 `/mfe/agent`、B／org2／既有 GPT-5.6 Sol：

| 問題 | 執行及原生結果 |
| --- | --- |
| 2014-06 各產品分類淨銷售額 | fact + product + date，三表／兩 Join；一次成功 SELECT；新 bar Dashboard，原生表格兩列與同次 Host 結果逐值相等。 |
| 2014 年 US 地區不重複訂單數 | fact + territory + date，三表／兩 Join；不同條件與 count_distinct；一次成功 SELECT；另一 stat Dashboard，原生表格一列逐值相等。 |

兩張 Dashboard 均使用 `theme=light`，原生「查詢結果」panel 可見且可點擊；四個真 datasource request（兩個表格與 bar/stat）皆 200。每題錯 Viewer、org、缺 backend key 各 403。Infinity method error 與 page error 均 0。關閉原瀏覽器後、結果 TTL 尚未到期時，兩個舊 display 只讀回測均 401，證明失去 browser grant 不會因後續同人登入而復活；未送新 SQL。原值只在 mode600 私有收據／畫面；模型成功工具輸出僅四份無值 receipt，沒有 SQL／rows／URL，最後 stop 且無背景 prompt。

### 保留驗收腳本干預，不把失敗改名成無錯

`live-two-queries-r2.json` 原 wrapper 最後 exit1，原因是歷史檢查拒絕任何 tool error，不是前述數值對帳失敗。只讀 session 與逐筆 call arguments 對帳確認：模型每題在建立 bar/stat 後，又提出**相同 plan、chart 改 table** 的附表查詢。每張非 table Dashboard 已自帶完整表格，但工具說明未明講；測試腳本的每題一次 guard 在 Host dispatch 前攔下兩筆額外請求，回 `sql_request_failed`。產品並沒有新增這種日常配額，這也不是來源或 Grafana runtime error。

- 實際 r2 來源執行 **2 次**，額外被腳本阻擋的嘗試 **2 次**；不能報成模型只提出兩次 SQL。
- 不為修報告重做成功 SQL／模型／Grafana 寫入。`r2-native-readback.json` 對原始收據、兩份 private 值、模型停止與錯誤來源做 hash-bound 離線讀回：`TWO_PRIMARY_NATIVE_FLOWS_VERIFIED_WITH_TEST_GUARD_INTERFERENCE`。
- `live-two-queries-r2.json`、首次只讀 reconcile 的不通過狀態與原失敗輪均未覆寫。
- **r2 本身未證明無 guard 干預的完整模型收尾**；工具說明應明確告知圖表已含附表，後續不應靠測試 guard 假造一次查詢效果。廣義 timeout/cancel/truncation、實際 metadata 撤權與其他來源驗收仍不因此完成。

私有收據：`r2-query-1-values-private.json`、`r2-query-2-values-private.json`、`r2-query-*-native-private.png`、`r2-model-readonly-reconcile.json`、`r2-call-arguments-summary.json`、`r2-native-readback.json`、`r2-stale-display-readback.json`。沒有 source 值或秘密納入公開文件。

**r2 回顧**：原生 metadata、Service Account 與 Infinity client 的三個盲點均已修正，r2 已有實際來源到原生圖表數值的恢復證據。同時保留模型額外查詢與驗收 guard 的影響，不把兩個成功主案例等同整項 SQL／可信 Join／全平台驗收。

## r3：附表能力說明與無干預模型收尾（2026-09-27）

### 修正與封裝

- `pi-web/lib/datahub-{sql,grafana}-extension.ts` 明示 bar／timeseries／stat 已包含**同次回傳列與欄位**的結果表，受 limit／truncation 限制；不應只為附表重送同一查詢。聚合結果表不是底層交易明細鑽取，沒有禁止真正不同粒度的新問題。
- 不改 compiler、Host、MFE、權限或每日配額。17 項 scoped Node、TypeScript、560-file downstream reverse／原 506-file baseline 與 3 項原檢查通過；映像內兩套工具測試 6 項通過。新增說明回歸先 RED；首版測試 fixture 錯帶 table/stat 的 x/y 被合法 validator 拒絕，修正 fixture 後通過，失敗紀錄保留，沒有放寬產品 validator。
- 四種圖型的 builder 回歸核同一 display、完整回傳欄位、表格字串精度與 truncation 標記；Pi 工具測試仍可在獨立映像內執行，不依賴 checkout 外部 Host 模組。
- 使用既有 1 CPU／3 GiB／無額外 swap／serial builder，建置後停止；未在 checkout 跑 Next build。560 個 Pi 凍結來源、223 browser assets 與映像逐檔對帳；Host 39 個程式檔未改。
- 使用者另確認 **Agent-only 映像／assets 切換與真測試**。B 切換前沒有執行中的模型工作；PID **2527525 → 4163284**，舊程序及其 runtime 正常 drain。僅變更 `runtimeImageId`、`browserAssetsDirectory`，保留當前通用設定備份，未重建來源或 Grafana 資源。

現行映像：

```text
sha256:148737d342c96288d4a1b3ce3c17f0ec5f9400e5e4ce61f99aeb7811fabd935f
```

私有證據：`.local/evidence/metadata-query-companion-20260927/`；assets 為其 `browser-assets/`，切換前設定為 `agent-server-before.json`（未回復）。

### 真入口與結果

沿 r2 **完全相同的兩題 prompt**，B／org2／既有 `openai-codex/gpt-5.6-sol`，session `01a0e194-add4-70bc-8a08-83d9663b67ad`。沒有追加「已自帶附表」測試提示、fixture／DTO override 或成功次數 guard；來源／prompt 範圍與 runtime 錯誤停輪保護仍保留。

- 兩題各三表／兩 Join，各 **1 次真 SQL、1 次 Grafana**，不同 bar／stat Dashboard；沒有額外 table 查詢、任何 SQL 攔截或工具錯誤。
- 原生結果表 2 列／1 列與同次 Host 結果精確相等；**bar/stat 真 Infinity frame** 也與同次結果依原生數值型別投影相等。表格保留 decimal 字串；不把 chart 浮點投影說成任意精度數值。
- 四次 native datasource HTTP 均 200；淺色 URL、原生 panel 可見可點；page error／Infinity method error 均 0。每題 wrong Viewer／org／missing backend key 均 403。
- 只讀重核原 session：實際載入的 SQL/Grafana 工具描述包含附表能力；active tools 恰為三個 DataHub 工具，9 次 Catalog、2 次 SQL、2 次 Grafana，最後 `stop`、非 streaming／promptRunning。四份成功收據沒有 SQL／rows／URL／columns，assistant 無 SQL-like 文字。
- 關閉原瀏覽器並經同人另次登入後，兩個舊 display 在 TTL 尚未到期時均 401，未復活 grant 或新執行 SQL。
- `r3-native-readback.json` 對私有結果再次離線逐值／SHA 核對；13 份 r2 歷史證據 hash 未變。值、native screenshots、錯誤原件保留私有，不送模型或公開文件。

主要收據：`agent-switch.json`、`artifacts-check.json`、`live-two-queries-r3.json`、`r3-model-readonly-reconcile.json`、`r3-native-readback.json`、`checkpoint.json`。

**完成邊界／回顧**：本輪消除了附表能力未說明的缺口，並移除測試成功次數攔截，原兩題在真部署自然收尾通過；不靠配額或重跑成功 SQL 修報告。這不是任意 prompt 的永不重複保證，也不是整項 SQL／可信 Join 全驗收。實際 timeout／cancel／truncation、metadata 撤權、規則化關係驗證／audit 及 Oracle 等其他來源仍需各自證據。無 commit／push、Core 修改、子代理或獨立 review。

後續第 1 項已在**隔離真 SQL Server**補驗 driver timeout／HTTP cancel、來源 session 終止、並行名額與新查詢恢復、不重跑，見[生命週期報告](datahub-agent-query-lifecycle-20260927.md)。該檢查未改本頁正式部署，DataHub identity／metadata 為 fixture；不擴張成真模型 Stop 按鈕完整 E2E 或其他來源驗收。

後續[結果邊界收尾](datahub-agent-query-result-boundaries-20260927.md)完成 8 次隔離真 SQL 與原生 Infinity inline 解析，並經明確批准只重載 Host：PID4163284 → **2364312**，使新 Dashboard 的圖表／附表顯示可見截斷警告。Pi 映像、assets、設定及本頁 r3 原始證據不變；不重跑原兩題、不修改舊 Dashboard。本轮至此結束，不擴張其他驗收。

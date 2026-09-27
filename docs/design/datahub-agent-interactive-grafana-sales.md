# DataHub MSSQL 聚合 → Agent 訊息卡入口＋Grafana sidecard（歷史試點）

> **2026-09-26 最新決策**：一般產品改採 [Metadata 驅動查詢方案](datahub-agent-metadata-query.md)：可見 metadata 即查詢授權，不再限固定資料集／月份／指標，不再增加逐人或逐次 SELECT 核准。本文下方保留原試點過程，不是通用產品限制。B／org2 第二次另獲核准的真閉環已通過，見 [真入口驗證](../verification/datahub-agent-grafana-b-live-20260926.md)，測後暫時授權已撤銷；下方「尚未部署／尚未驗證」描述是當時狀態，不能用來推定目前能力。通用 SQL／圖表已另完成本地 Join／UI 接線與合成回歸，但尚未部署／真驗收，見 [本地證據](../verification/datahub-agent-metadata-query-local-20260926.md)。

2026-09-26 更新。使用者指定第一筆 `SalesDatamart.reporting.v_sales_order_line`，僅展示聚合、不可顯示明細；互動式 Grafana 是必要條件，靜態圖片或 DataHub 草稿不能替代。這是已取消 Goal 以外的獨立任務。**UI 已改為訊息入口＋sidecard；第二輪已接上來源結果短效 capability 候選，但尚未配置／部署真 Grafana Dashboard、查新來源或通過真入口驗收。**

### 本次受控預檢與真瀏覽器阻擋

- 依限定批准，同一 `localhost:3000` 已建立專用 org ID 2、B Grafana 本機帳號 ID 10（密碼只在 gitignored mode600 `.local/evidence/agent-grafana-message-20260925/grafana-b-credential.json`）、Infinity datasource `datahub-agent-sales-host`、folder `datahub-agent-sales` 及**僅含 `TEST_ONLY` 假資料**的 Dashboard `datahub-agent-sales-probe`；完全沒有加入 MSSQL datasource、修改 org1、改 Grafana 全域設定或查來源。Grafana 將新 org 唯一 datasource 自動設為 `isDefault:true`，首次工具嚴格預期 `false` 而停止；唯讀對帳確證 UID／org ID／URL allowlist 相符，原失敗收據不改、不重寫 datasource。
- B 真 Grafana 登入 200，僅 org2 Viewer、org1 datasource 嘗試 403。Infinity 3.11.2 對 `http://127.0.0.1:19041/api/datahub-grafana-probe` 返回一筆假資料；錯 port／錯 path 的 query 各拒絕。真頂層 Grafana Dashboard 顯示 `TEST_ONLY` 並發出原生查詢；合成探針驗後已停止，保留 Grafana 合成資產供後續精確對帳。
- **真正的 `/mfe/agent` 內巢狀 Grafana iframe 不可用**：同一瀏覽器、同一 B，頂層 dashboard 可讀；進入 DataHub→隔離 Pi iframe→Grafana 時，`/d/datahub-agent-sales-probe` 302 到 `/login`。獨立 cookie 名稱檢查證明 Grafana session cookie 為 `SameSite=Lax`、`Secure:false`；頂層 dashboard request 有 `grafana_session`，巢狀 request **沒有**，因此不是模型清單、Dashboard URL 或來源 SQL 故障，也不能只加 Viewer 解決。受保護截圖及各階段收據在上述 `.local/evidence/agent-grafana-message-20260925/`；沒有輸出 cookie 值。Grafana HTML 在這次觀測無 X-Frame-Options／frame-ancestors 拒絕，但不等於已驗所有嵌入政策。**不得自改全域 SameSite／Secure、重啟其他專案 Grafana 或將 Grafana 替換為公開 iframe。**
- 後續純瀏覽器區別實驗：把同一 Grafana iframe **暫時**插在 DataHub `localhost:9002` MFE 頁面的頂層、作為 Pi actor 子域 iframe 的兄弟節點，B 的 Grafana session cookie 正常帶入、Dashboard HTML 200、標題可見；這證實無須立即改全域 cookie 設定。因合成探針在前一測後已停止，畫面是 `No data`；這不是數值 E2E。此預檢之後，使用者改採右側 sidecard（見下節），不再在 message block 內定位 iframe；仍需可信 MFE 同站 portal／定位橋、生命週期與跨 origin 驗證。不得由 Pi frame 動態注入未檢 URL 或放寬 actor 子域隔離。

## 目標與安全邊界

真 `/mfe/agent` 中的自然語言選擇經核准的指標與範圍，模型只提交意圖。可信 Host 查 DataHub 中精確 Dataset／目前 Actor 的 ACL、有限期 source SELECT policy 和固定 SQL 版本；對本案 MSSQL 查詢有界聚合，不向模型／瀏覽器提供來源憑證或任意 SQL。message block 保存摘要與「開啟儀表板」入口；完整 Grafana Dashboard 顯示於右側 sidecard，可放大至工作區、小螢幕全頁。時間／商品分類等互動只能在核准期間及資料範圍內篩選既有短效結果；刷新／重開不得自動執行新 SQL。每筆 Grafana datasource 請求都不得越過 Host 的短效 capability／當前政策。撤權、過期、來源未知、版本漂移及換 Actor 不可繼續查數、冒充成功或自動重播 SQL。只交付已核准的指標；其他可見 Dataset 仍是待審草稿。

- DataHub 存 metadata，不儲存 SQL Server 業務資料列；真查值必須進 `SalesDatamart` 受控來源。
- 同一 `localhost:3000` 為 Grafana OSS 13.1.2；新 org 在同 instance 隔離 org1，不是第二台 Grafana。官方[org 文件](https://grafana.com/docs/grafana/latest/administration/organization-management/)列 datasource／Dashboard 的 org 隔離。
- 官方[安全文件](https://grafana.com/docs/grafana/latest/setup-grafana/configure-security/#limit-viewer-query-permissions/)指出 OSS Viewer 可送該 org 任意 datasource 查詢，**不能**直接給 B 目前 MSSQL datasource：現有 reporting view 含 SalesOrderID、SalesOrderDetailID、SourceCustomerID，既有 Grafana SQL 登入有整個 reporting schema 的 SELECT。新 org 也無法單獨解決任意 SQL／來源逐次授權。
- 現場已安裝 `yesoreyeram-infinity-datasource` 3.11.2。優先重用它在新 org 僅向**可信 Host 的固定聚合端點**查詢，不把 MSSQL datasource、SQL、目標 URL 或秘密給 B；Grafana 面板與資料互動是真 Grafana 執行。官方 [Infinity URL 設定](https://grafana.com/docs/plugins/yesoreyeram-infinity-datasource/latest/advanced-features/url/)有 allowed hosts，但不能僅以設定字串聲稱本版拒絕 SSRF／任意查詢；實際 plugin 及 Host 拒絕路徑須在無秘密隔離預檢通過才可用。
- Grafana 不攜 DataHub Actor cookie 給 backend datasource。原設計要求由已登入的 `/mfe/agent` parent 為 B／scope 核發與模型 receipt 不同的短效隨機 query capability；但任何放入 Grafana iframe URL 的 bearer 仍會暴露給瀏覽器，**不得部署原接線**。下述替代候選讓短效 `displayRef` 只作資料定位，由 Grafana 後端安全欄位持有服務憑證並代送不可由 Viewer 覆寫的本人／org metadata；服務憑證只證明後端來源，不能單獨冒充 B 授權。Host 還必須逐次核 DataHub Actor、撤權及原來源結果。2026-09-26 後續使用者已核准**僅 B/org2 的受限替代方向**先做負例，並最新指示**不用獨立審查**；因此只可稱主責自查／負例，不能稱有獨立安全結論。實際佈建／部署與新來源查詢時窗仍須另行明確確認。不能信任 query 中自稱的 Actor、Grafana 用戶名、SQL、URL、table 或 filter。
- 只用固定 `sales_by_category` 契約作首例：`SalesDatamart.reporting.v_sales_order_line` 的有界日期／分類聚合；原固定模板 SHA `5cb70f081f4210c9f947c6e7034f412316a65510ddc643aca6a09928932c22cc`。此前 B 的來源 grant 已過期。互動範圍不能被 Grafana dashboard 的自由時間／URL 參數擴張；一旦需新增最終 SQL／指標，先另審。
- 原生 Grafana iframe 還需驗證 B 本人的 Grafana 登入、frame sandbox／CSP／cookie 與 `allow_embedding`；後者可能是影響其他 org 的全域安全變更，未明確核准不得修改。Grafana externally shared dashboard 的 OSS anyone-with-link 會公開；[官方文件](https://grafana.com/docs/grafana/latest/visualizations/dashboards/share-dashboards-panels/shared-dashboards/)的特定使用者分享仍為 private preview／可能收費，不採用公開分享、匿名或借用 Admin Query 權。

## 2026-09-26 核准的 UI／實作調整

- **訊息卡不是 iframe**：只保存 Dashboard 身分、Dataset、核准顯示日期與當次狀態；不保存業務數值、Grafana cookie、來源憑證或 query capability。自然語言工具返回 descriptor，使用者按鈕開啟右側互動視圖；歷史卡每次重新核權，不自動查 SQL。
- 沿用 `AppShell` 的右側 Details 工作區；Grafana 與 Catalog／檔案／Terminal 互斥顯示，不建立任意 URL 瀏覽器。支援調寬、放大／還原、關閉及焦點回到原按鈕；窄畫面使用全寬視圖。
- 真 iframe 由 DataHub MFE 管理為 Pi iframe 的**同站兄弟節點**，對齊 sidecard 的內容區；Pi 只傳 Host 核發的短效 displayRef 與內容區座標，不可指定 URL、org、Actor 或額外 SQL／filter。Parent 驗 frame origin／source，Host 經目前 DataHub 身分、原生資產權限及上一筆來源結果重新核權後，才回 parent-only operator 配置的 Grafana origin／Dashboard URL。裁切不得覆蓋 DataHub 外部 UI；只有一個 Grafana iframe，切換／關閉／unmount／換 session 清除。
- 顯示 lease 短效、定期重新核權；失敗或到期卸載，不改稱成功、不自动重新查來源。跨 origin 的 iframe load／掛載只標示「已掛載，資料狀態請見 Grafana」，不冒稱登入或查數成功。
- **登入與資料授權仍是不同邊界**：Grafana 使用瀏覽器自己的登入與原生 org ACL，Host 的顯示准許不是 Grafana 本人身分證明。替代候選以 Grafana 後端祕鑰／可信 Viewer metadata 加上 Host 對短效 `displayRef` 及當前 Actor 的逐次檢查取代 URL bearer；UI lease／服務祕鑰各自都不能取代資料授權。Host GET 僅讀來源 SQL 的 60 秒記憶體聚合，每次重新檢查 DataHub Actor、原生權限、browser grant 與未過期來源政策；不從 Grafana GET 重跑 SQL。operator 顯示設定預設不配置即拒絕，須與 Actor 的 `maxExecutions:1` source-only SQL policy、Dataset 與時窗對齊。現存 org2 datasource/Dashboard **仍為已停止的 TEST_ONLY 探針**；候選程式不等於 Grafana 已供真數值。
- 不修改共用 Grafana cookie、org1 或 DataHub Core，不增加 datastore。OAuth 模型登入與此顯示橋無關，不要求模型 API key。

## 本地實作與驗證（非 live 驗收）

- `DataHubGrafanaMessage` 是訊息入口；`AppShell` 以 session／目前檔案分頁區分顯示，沿用右側面板；`DataHubGrafanaPanel` 提供放大、還原、關閉及內容定位。MFE `grafana.js` 負責單一 iframe、座標裁切、關閉和短效顯示 lease。
- `/agent/grafana` 沿用 parent origin、DataHub identity、grant/revoke proof 邊界。Host `native-grafana.mjs` 預設拒絕；僅接受 operator 對 Actor／Dataset／Dashboard／org／origin／到期時間的明確設定。以之前真來源 SQL 的不透明 `resultRef` 授權，只在 Host 記憶體保留短效資料；**原候選把 bearer capability 放進 Grafana iframe URL，會暴露給瀏覽器，已撤銷這個未部署的做法**。新候選 URL 僅帶與訊息卡相同的 `displayRef`，不是查詢憑證；Infinity 由後端透過 encrypted `secureJsonData` 發送 Host 專用祕鑰和 `${__user.login}`、`${__org.id}` datasource-level metadata headers，Host 再比對 Grafana Viewer 身分、org、短效 DataHub grant、原結果與 Dataset 權限。GET 只能讀原聚合，不執行 SQL。首輪獨立於來源的真 org2 Infinity 探針確認祕鑰與 B Viewer login 後端標頭有效，但 org 標頭**不等於數字 `2`**；原 Host 拒絕、測試 datasource 刪除讀回 404。版本原始碼顯示 `${__org.id}` 取 `PluginContext.Namespace`，Grafana OSS 13.1.2 org2 namespace 為 `org-2`；探針未記錄標頭原文，精確值仍需修正後真讀回確認。已將本地相容性 Adapter 改為比對精確 namespace，20 項 scoped 單元重測通過；隨後獲新授權的**第二個獨立一次性**合成探針，B 真 Viewer 原生查詢返回 `TEST_ONLY` frame、`org-2` header 精確吻合；login／org／祕鑰覆寫均被重複標頭檢查拒絕，錯 path／port 在送達探針前被拒，B 改 org1 得 403、匿名得 401。新 datasource 同樣刪除讀回 404。這只驗 Infinity／org2 安全前提，**未驗 DataHub Host 端到端、來源 SQL、Grafana 真業務數值或右側 sidecard**。SQL 政策以 `maxExecutions:1` 限制本 Host 生命週期的本次核准嘗試，timeout／UNKNOWN 不補發次數；**跨 Host 重啟不得盲目重送**，操作員必須以新授權及實際執行對帳為準。
- 58 項 scoped 回歸通過（含原 SQL/Catalog/gateway 路徑）。Chromium 的**合成 Host 身分／Grafana 替身**檢查產品 React component、MFE bridge、Host 共 11 個情境：歷史不掛載、同站兄弟 iframe、iframe 互動、放大還原、捲動不重載、關閉、重開核權、unmount、窄屏裁切、ACL 拒絕及 lease 到期。這不是部署中的 AppShell、真模型、Grafana 登入或 MSSQL E2E；不把測試 Shell 換 session 的結果當作完整正式 session 切換驗收。
- TypeScript、12 個變更檔 primary LSP、新增 TypeScript 的 ESLint、隔離 MFE webpack 建置通過。Downstream 556 檔 bytes/mode 與 patch 反向回原 506 檔通過，原 upstream lock 未改；只更新這次 12 個 pi-web 檔案的差異，未重新核准其他既有工作。
- 驗證產物：`.local/evidence/agent-grafana-sidecard-20260926/{tests.log,browser.json,mfe-build.log,downstream-check.log,downstream-refresh.json}`。本輪未讀登入憑證、送模型 prompt、改 live 設定、重啟服務、建立 Grafana 資產或執行來源 SQL。
- 回顧：瀏覽器回歸捕捉到 descriptor 物件重建可能重掛 iframe；effect 已改依穩定 request／Dashboard／日期欄位運作，放大及捲動不重載的測試恢復通過。另 `native-sql.mjs` 333 行檔案的 L334 警告為既知過期診斷，本輪 primary LSP／語法和 scoped cache 無 error，不修改無關 SQL。

第二輪 scoped 契約單元測試 33 PASS、TS／ESLint／MFE build 與 556 檔 downstream reverse（原 506 檔）通過；只證明未部署候選的離線契約，不算真實 E2E。首次 downstream 命令誤用系統 Python 3.14（缺 `datahub` SDK）失敗，按腳本明示改用既有 `.venv/bin/python` 後原樣檢查 PASS，無安裝套件或放寬檢查。B 真 `/mfe/agent`（DataHub 登入 200）在既有 B cwd 的 `/api/models` 200、`modelList` **0**，runtime 預設 cwd 查詢 403；現行映像內 pi-ai 0.85.1 的 built-in catalog 沒有 `gpt-6-sol`，仍不能單憑這點斷言模型數為零的唯一原因。沒有發 prompt；現有 source-only grant 已過期，沒有送任何新 SQL。真 Grafana org2 datasource 仍僅允許已停用的合成探針路徑。第二輪收據：`.local/evidence/agent-grafana-live-20260926/`。

後續真 B OAuth 裝置碼由使用者在自己的 ChatGPT 瀏覽器核准；新 B browser 讀回 `openai-codex` 已連線、8 款模型，使用者同意首測 `gpt-5.6-sol`。後續在 B 真 `/mfe/agent` 選擇原 B cwd、`gpt-5.6-sol` 與僅聊天／零工具，**只送一次**非來源模型 prompt；起初讀到串流中的半句而錯判未驗，未重送。獨立唯讀 session 回查證實模型輸出完整指定字串、`openai-codex/gpt-5.6-sol`、22 output tokens、`stopReason=stop`、工具清單空。這只證明真模型入口，不是 Catalog／MCP／SQL／Grafana 閉環。此前一次 B DataHub 登入 HTTP 500（frontend `NoHttpResponseException`）發生在建立 session 前，原收據保留。使用者**暫不核准**上述 Grafana 後端祕鑰／Viewer metadata 授權改造，後續為了真實 Dashboard 驗收，使用者改為核准 B/org2 受限新接線準備與負例，並在後續明確指示**不用獨立審查**，**不是**佈建／部署或新來源查詢授權；它仍是未部署本地草稿，沒有獨立審查結論。使用者另核准**一個**可刪除、合成值、org2-only Infinity datasource 的真外掛安全預檢；第一次按原契約完整執行，但正例因 org namespace 格式拒絕，在 1 個查詢後停止，清理已讀回。它不是給失敗請求的自動重試許可；修正後新一輪測試已另得明確核准並通過（`org2-auth-probe-r2.json`，8 個合成正反例）。測後兩輪臨時 datasource 均已刪除，現有 `TEST_ONLY` 探針未修改。原 URL bearer 候選同樣不可部署，絕不能用現有合成 Dashboard 冒充交付。

**仍未交付的完整閉環**：新端點及 Dashboard 在真 org2 的安全佈建與 native query 數值對帳、使用中 Agent 的固定映像／assets 部署、B 實際模型流程、真同站 portal 登入與正式 AppShell 的焦點／session／Actor 切換驗收。原始受控來源 grant 到期；要新查詢必須先取得精確新時窗／同一筆核准，UNKNOWN 即停。不能把此前合成預檢或本地候選充當真驗收。

## 必須先完成的相容性與負例

1. 在不碰 org1 真資料的隔離預檢驗 Infinity 3.11.2：只准固定 Host 端點，跨路徑、跨主機、額外 HTTP method、伪造 ref／Actor 都拒絕；不能對來源資料庫發 SQL。
2. 若核准替代方案，DataHub parent→Host→Grafana backend→Host 的結果授權必須短效、精確範圍、可撤銷、不進 Pi session；服務祕鑰不進瀏覽器，模型只見 opaque receipt，無授權瀏覽器、另一 Actor、過期及刷新後均無資料。必須證明本版 Infinity 的登入者 metadata 在後端插值且 Viewer 不能覆寫；驗一條核准查詢及同卡時間／分類篩選，不能只截圖空白 panel。
3. 在 Grafana/B 真身份與受控 SQL 的**新一次精確授權**之下真測來源彙總、Grafana frame 及 native query 讀回、與 Host 同一版本化來源值對帳；分別驗網路失敗、容量、結果上限、取消及未知不顯示 PASS。確認 frame 掛載與卸載及歷史重開，保留 org1 可見性／查詢隔離。所有真 SQL、Admin 佈建、憑證使用、嵌入設定及部署是獨立副作用，不能由本方案文件或舊 Goal 授權推定。

如果 Infinity 在本版無法阻止 viewer 改用其他 URL、無法以後端欄位／登入者 metadata 維持當前 Actor 授權，停止，不換成直接 MSSQL Viewer／公開分享；再就官方 Grafana datasource plugin 或另個受限聚合資料模型取捨請使用者確認。本文件是預檢與實作邊界，不宣稱安全或 E2E 已通過。

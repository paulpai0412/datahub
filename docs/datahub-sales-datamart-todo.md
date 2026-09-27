# DataFlow Discovery／SalesDatamart v1 實作 TODO

> **2026-09-24 TODO 轉接**：`TODO-dc390fa8` 與關聯母任務 `TODO-a2daa81d` 均以 **superseded** 關閉，不表示產品完整驗收。剩餘 DataFlow 安全邊界、完整欄位與業務語義由 `TODO-09b76307` 承接；真 Agent 操作入口 `TODO-a064929f`、同源交付 `TODO-db4b9c85`；一般受控來源 SQL 是另一項 `TODO-51730abb`，不能以已驗的固定 ETL 取代。本文件 DM01–DM09 及下方 Goal／授權紀錄保留為歷史範圍和收據，不能作為新一輪憑證、SQL、metadata 寫入、部署或推送授權。

建立：2026-09-13；執行順序更新：2026-09-20。原任務：`TODO-dc390fa8`（表級發布／Agent查詢及固定ETL人工核准閉環已實證，剩餘安全邊界與業務語義未完成）；原關聯母任務：`TODO-a2daa81d`。

目前原生 pi-goal-x：`mu997j34-x0bo0m`（2026-09-20 確認，八項剩餘成果）；`fixed-etl` 真實功能閉環已完成，見下方驗收節。原生task標記最後讀回仍為3/8／fixed-etl pending，目前可用Goal工具沒有單task完成操作，尚未將此功能成果冒稱為原生狀態更新。依使用者要求，本輪止於fixed-etl。舊 Goal `mtzxzwn6-1zw7vn` 已 paused／archived，10/18 為歷史限定成果，不是目前 Goal 的進度。Skill：**DataFlow Discovery（資料流探索）**，ID `dataflow-discovery`。

設計：[DataFlow Discovery／銷售 Datamart／Grafana／DataHub v1](research/datahub-sales-datamart-v1.md)。

### SQL／聊天數值卡當前切片（2026-09-25，來源限定實測、整體未完成）

依使用者指定先處理 `TODO-51730abb`，本地加入固定 `sales_by_category` 有界意圖、operator-only 銷售 view／Panel 5 精確 URN 及版本 SHA grant、Host 的 Actor／grant 續查、每次最多兩個併行、短效記憶體結果及重新授權讀卡。Pi tool 的聊天歷史只保存 opaque receipt、不保存數值；MFE 分開模型意圖與卡片讀取通道，歷史結果過期不自動重執行。數值卡用精確 decimal 加總、標示本地幣別與未知資料截至時間，**不能把 Panel 5 的分類彙總說成每月×分類原生 panel 已核對**。來源不完整或零列拒絕；Host 現又核對月份落在意圖範圍，並將每月分類額以 decimal 六位加總，只有原生 Grafana 比對回覆含固定 Chart／Dashboard／SHA／Panel 與**逐分類完整精確總額**時才建立結果；比較 callback 不能修改已驗來源值。`extensions/sales-datamart/src/sales_datamart/agent_query.py` 固定唯讀 view 的單句 `TOP (201)` 分組 SQL（SHA `5cb70f08…`），只綁兩個日期參數，201 列或空結果拒絕，Decimal 精確投影；`sql_cli.py` 在同一 DB 連線先檢 `ORIGINAL_LOGIN`／DB／有效 SELECT 與寫入／db_owner 權限。Host runner 凍結 Python bytes、僅在子程序環境傳 reporting login 密碼、限界輸出且取消後待進程退出；Actor 授權器逐次查原生 `me`、三個精確資產的 VIEW 與存在性。合成 Host／gateway／MFE／SSR、Python 與 Node tests 只證本地契約，不能當來源或原生 Panel 數值。

**2026-09-25 來源-only 真批次，非 Agent E2E：**使用者先核准既有 `SalesDatamart.reporting.v_sales_order_line`、既有 reporting-only 登入、2014-06-01～06-30、前置權限檢查後最多一條固定參數化分組 SELECT、30 秒／條、每來源最多兩併行；後指定由主代理選用非管理員 Actor。沿既有 mode600 測試帳號選 `urn:li:corpuser:catalog-acl-b14147f5062cc8@example.invalid`，一次登入與當次四項非管理員權限讀回、`me`＋Dataset／Chart／Dashboard 精確資產 grant／存在性前後共 **15 次原生唯讀 API 全為 200**。受保護 Host 子程序的 SQL login／SELECT 權限預檢後，同一連線**一條**固定來源聚合 SELECT 成功，回傳六月範圍 **2 組**；資料值及分類名稱只留 gitignored mode600 收據，沒有送往模型或普通日誌；`observedAt=2026-09-25T07:05:47.504Z`，`dataAsOf` 未知。原生收據 `.local/evidence/agent-p0-20260924/agent-sql-source-nonadmin-20260924.json` SHA-256 `187cd50a06e0eb4885227640c3e882540ccf6bf89345e759cf4aaefed22bf380`；只證這個 scope 的真來源結果及當時授權，非每個 Actor 或新一般 SQL 權限。未重試、未變更政策／metadata、未部署。

**仍未接入 `server.mjs` 生產 Host；真 Agent 路由預設 `sql_not_configured`。**未執行 Grafana 原生 query 或來源／Panel 對帳、沒有真 Agent→Host→來源入口的正反例、超時／取消／超量與歷史重開驗收，fixture 不充當實證。本機 Grafana 13.1.2 為 `grafana/grafana`；官方文件指 OSS 不具單一 datasource Query 權限，org Viewer 可查 org1 所有 datasource。使用者選擇維持隔離，故未升權 None metadata reader、未使用 Admin 憑證，Panel 5 原生數值對帳暫停待可限定的 Query 身分／隔離方案。不能用來源-only 結果替代，不得沿用固定 ETL、clone 或 metadata 唯讀批准。本 TODO 與 Goal SQL Task 仍 open；其他 DataFlow 門檻不變。

### 2026-09-25 自然語言 message-block 儀表板候選（未部署／未完成）

使用者指定：在真 `/mfe/agent` UI 以自然語言要求儀表板，結果可直接呈現在 message block；選擇**來源供數並對應既有 Grafana**，不授權新建 Grafana Dashboard／借用 Admin Query 權限。任意 DataHub Dataset／指標可**提出草稿**，但只有逐項核准來源 SELECT、語義／Join 與最終 SQL 的項目才能查數；不可把固定銷售模板冒稱任意指標已可執行。

本地加 `datahub_dashboard` 工具，以現有 Catalog Host 橋重新核 Actor／精確 Dataset 可見性後，產出沒有 SQL、數值、Grafana 查詢或寫入的 `datahub-dashboard.draft/1`；`MessageView` 顯示明確「未授權、未執行」的儀表板草稿，不展示 raw tool input、錯誤或不認識的歷史 payload。使用既有報表結果的 `DataHubSqlCard` 增合計與分類比較 panel、原逐月表格；Host 現有**明確分離**的 `grafanaQueryApproved` 對帳格式，以及需 operator `sourceOnlyApproved` 的來源-only 格式，UI 分別標「Grafana 核對」與「尚未對帳」，兩種模式都不把數值放入 Pi session、且讀卡重新核 Actor／政策。`server.mjs` 只在 operator 提供有效單 Actor 的 source-only grant 及保護的密碼檔路徑時才注入固定 runner，沒有配置一律拒絕。第二個**待審示例**可由使用者說「請以 SalesDatamart `reporting.v_sales_order_line` 按月顯示訂單數」產生草稿；這不批准 Panel 2 的 SQL，也不是新來源查詢。27 項 Host／gateway／MFE 加 20 項工具／SSR 合成測試、`tsc --noEmit` 與 scoped LSP 通過；並非真瀏覽器驗收。`server.mjs` **目前使用中的配置仍沒有 SQL handler grant／原生 Grafana Query 身分**；候選未部署、未再查來源、未建立 Grafana Dashboard，原 SQL Task 仍 open。

**2026-09-25 部署預檢停止：**使用者另明確批准本案 Agent 的 commit/build/deployment 與限定 Actor B／固定 view／日期重複測試（結果不明不得盲重送），但還沒有啟動第二條真 SQL。真 `/mfe/agent` 回 200，Agent gateway `localhost:9041` 不可達；現場 `.local/agent-server.json` mode600 無任何 SQL grant 或密碼路徑。資源預檢（舊 checker 門檻是否仍有效與 README 有差異）回 `BLOCKED`：可用記憶體約 3.9 GiB、Windows 系統磁碟剩餘約 3.15 GiB；正式 `.venv/bin/python scripts/check-agent-downstream.py` 在 `unreviewed source files` 停止，現工作樹 28 個 pi-web 檔未納入 lock，包含 Catalog、Semantic、ETL 與本次 SQL/dashboard，不能把混合候選整批提交／建置／切換。本次沒有 commit、build、部署、Grafana 寫入或來源重查。需先有足夠磁碟／可信 build 資源及隔離且逐檔核對的 downstream 差異，再決定安全切換；HTML 200 不算 Agent／UI 功能成功。

## 已核准範圍與狀態

- [x] 確認 AdventureWorks 銷售訂單明細，四個 dimensions＋一個 fact。
- [x] 確認既有測試 MSSQL instance 新建獨立 `SalesDatamart`；來源唯讀、僅新 Datamart 寫入。這是限定業務 database 例外，不是 Extension 狀態庫。
- [x] 既有 Grafana 已定位 org1／13.1.2，本案專用 folder／datasource／dashboard 已部署實測，不影響其他專案。
- [x] 確認單次執行、每次寫入／明確批次人工核准，首版無排程。
- [x] 生成設計文件與本清單，連回既有 Agent TODO。

- [x] 使用者更正：DataFlow Discovery 必須實作，SalesDatamart 僅為第一個驗證案例，不 hardcode 分析答案。
- [x] 原生 pi-goal-x原12項任務已依2026-09-19盤點確認重整為18項；已同步Goal／設計／本清單，保留原DM01–DM09全部驗收。

**以上只代表決策／範圍文件完成；產品實作及現場驗收仍未完成。** 主 agent 獨自開發與驗證，不使用 team-flow、subagent、reviewer／auditor child、mission／watchdog／其他控制器；不 commit／push。外部副作用須定位精確目標、核對既有授權或批准新操作批次；auto-continue 不授權任意 DB／憑證／部署操作。

### 2026-09-20 測試授權更新

使用者已明確授權「目前實作中所有需要的測試權限」。本Goal／本案既有測試環境所需的有界診斷、憑證使用與短期測試token不再逐次請准；不是其他專案／破壞性正式操作／架構擴充授權，不取代既有metadata發布的人審與CAS。私有授權及執行收據仍逐批保留，失敗先對帳，不盲重播。

## 2026-09-20 最新核准順序：先打通完整 flow，再補其餘邊界

主 agent 獨自開發／測試／自查，不使用 Agent Teams 或子代理，不自行擴充架構。重用既有庫、ETL、Grafana 與有效證據；不重做成功批次。

1. [x] `flow-discovery`：真來源候選、DataFlow／DataJob、來源／目標表及 I/O 整合。**限定編譯接線完成，當時Goal登記1/8；發布與目前3/8狀態見下節**。先前11檔候選與Host Catalog接線已進main（197 Python／70 Node PASS）。最新4檔隔離候選修正record/helper傳遞，真source＋同日recorded Catalog經Node→隔離Python→SDK編譯出23條I/O（原13條）；201 Python／22受影響Host tests PASS。此4檔經明確批准已套用（未重啟）；Grafana唯讀預檢完成。DataHub第一次漏actor cookie的操作腳本已修正；另經批准的一次唯讀登入／24 requests成功，fresh 13 Datasets／149欄位經main Host重編譯仍為23 I/O。兩個Job的離線保留式diff各加5 inputs、無刪除／output變動；該編譯批次沒有發布。其後限定真寫入結果見下方最新交接。詳[9/20接線證據](verification/dataflow-discovery-publication-review.md)。
2. [x] `flow-publish-grafana`：**已完成；以下保留前段歷史，9/21真發布結果見最新節。**必要可信核准／條件發布，加上真 Grafana ingestion，讀回完整 flow。已核准的兩個canary接管意圖接入Host私有選項，精確digest／原值／creation stamp與同actor綁定，75項本機tests通過；不開放model／HTTP接管參數，尚未發布。Grafana帳號9已為None＋本folder View，既有ACL不變、無datasource query grant。兩個批准批次共28 requests：folder讀回通過；search讀到本folder內目標與另一preview，腳本錯誤的單筆斷言停止。其後另准真擷取批次：reader已完整讀回目標v2／7 panels；官方connector＋既有Transformer已實際執行，但回報`PipelineExecutionError`、file sink為空（0 records），不是成功ingestion。token8／9／10皆僅在記憶體、600秒expiry已讀回；批次全部關閉，沒有DataHub metadata寫入或自動重試。**後續已恢復真SDK擷取**：追加診斷定位`catalog_read_failed`，同一view公開SDK讀取401，原PAT已於9/10到期。沿用既有DataHub reader service account，短期測試token使key／status／schema讀取成功，原connector＋Transformer產出121 Aspects／17資產（7 query datasets、7 Charts、1 Dashboard、2 containers）。原操作驗證把不完整fixture的120筆當固定總数而停止；已不重跑擷取，直接驗證既有產物與完整container父鏈。fixture補上原先遺漏的`meta.folderId`即重現121筆；缺父鏈、錯Chart input、重複Aspect、外部上游負例均拒絕。兩枚本輪DataHub測試token已確認撤銷，舊憑證／帳號／ACL不變。**真file sink成功，不等於已寫入DataHub或整條flow驗收**。後續26次唯讀預檢確認17個Grafana資產尚不存在、兩個canary IO仍存在；另經明確部署核准，官方loader已熱載入模型0.1.3，舊Task／Run值與版本、舊插件及容器身份均不變，零重啟／發布。公共fixture已補folderId並檢查完整container父鏈：2 Node tests、17 Python tests（含1個既有expected failure）通過。其後另經明確部署核准，Host已加入既有AdventureWorks／SalesDatamart Source的13／8 Dataset Task範圍；真MFE讀回含原T03的2／13／8範圍，16上限不變。只重啟本案Agent gateway／runtime，原image／HOME／session保留；同reader短期token更新至既有受保護Pi HOME，角色／工具不变。初次後檢誤讀MFE grant envelope，自己擋下唯讀request而逾時；修正驗證器後只讀對帳成功，未再次部署。其後可信準備caller、真Task／Decision及另准typed API人審已接通；兩個Job的條件寫入已發生，但完整provenance讀回未過，禁止重送。Grafana仍只有驗證完成的file sink。詳下方最新交接及publication證據。
3. [x] `flow-web-agent`：真 WebUI／Agent 查詢／導覽全鏈，API 對帳、完整回答及 reload。3回合20次MCP讀取零工具錯誤，七組query→Chart逐項對帳原生值，reload訊息完全相同。**前三項優先完成線已通過，不代表全Goal完成。**
4. [x] `fixed-etl`：**功能閉環已驗證**。真Agent／typed UI APPROVE → 一次ETL 1.0.1 → 新連線品質檢查 → 原生Run v7／COMMITTED、真UI及同模型結果讀回／reload。185,013ms；source／fact／view各75,284筆，金額對帳一致。詳[fixed-etl驗收](verification/fixed-etl-20260921.md)。原生task標記登記與功能證據分開，不宣稱整體Goal完成。
5. [ ] `data-safety`：補齊 DDL／ETL 有界執行、品質、並行／取消與恢復負例。2026-09-24 DDL 切片：修正四處 fact index 存在性查詢，同名 index 僅在各 table/view 內唯一，改依 fact `object_id`＋名稱判斷；另在選定目標資料庫後、建 schema／表／Unknown 成員前，以 `sys.schemas`／`sys.objects` 拒絕本案例五表一 view 的既存同名錯型物件，避免較後段才報錯而前段已寫入。五段實際 catalog SELECT 通過 T-SQL 解析、diff check 通過；**沒有真庫錯型負例或執行 DDL**。真 DataHub Catalog 唯讀回傳同一 fact 完整 13 欄，與本版 DDL 欄名及正規化型別逐項一致；`schemaCreatedAt` 未提供，這只是記錄值，不是當前 SQL Server table／index／constraint 結構保證。私有收據 `.local/evidence/agent-p0-20260924/datamart-fact-catalog-schema.json`。未執行 DDL／真庫碰撞負例，未解決既存表／index shape 檢查或整體安全驗收。固定 ETL 本輪唯讀原始碼對帳：`etl.py` 的 pytds `timeout=30` 為**每次 query**（非整趟 ETL deadline），`run_etl` 在 target transaction／`sp_getapplock` 之內先擷取來源再載入、驗證，`source_observation` 明列 `consistent_snapshot:false`；Host `native-fixed-etl.mjs` 另以原生 admission deadline、`SIGTERM`／5秒後 `SIGKILL`、一次 commit permission 及 Run attempt 讀回處理拒絕／UNKNOWN，不是使用者取消或 SQL Server 後端 rollback 的現場成功證據。現有 unit 測試覆蓋模擬 lock 拒絕、提交前 pipe EOF、核准／拒絕路徑，不證明實際 SQL timeout、中途取消、殺進程後資料保留或多 writer 同時進入。真負例與目標 shape 仍需精確 SQL／環境授權後在隔離庫執行，已成功的批次不重送。

   續行的確切誤判：`_validate_target` 原以**全 view 歷史筆數**單向對比本次 scope fact 筆數；範圍外舊列替代範圍內漏列時，總筆數即使相等仍會通過。Host 原有收據 gate 要求全 view 筆數等於 fact，會擋一般全 view 增量，**不會擋這種等數替代**；同筆數下 view 的金額／數量／order 也未受核對。`etl.py` 在原本掃描 view 的同一查詢中，比對同日期／狀態／本幣 scope 的筆數、數量、兩項金額及 distinct orders 與已驗的 target fact；`reporting_view_count` 仍是全 view，舊 receipt shape 保持不變。離線回歸涵蓋等數替代漏列、匹配正例、fan-out、多種同數異值，**12/12 PASS**，新 T-SQL SELECT 經 sqlglot 解析；離線回歸本身不冒充下述 SQL Server 真查，更不代表跨來源一致 snapshot、完整 view SQL／維度語義、政策／同源部署驗收。固定 ETL 程式 digest 已改，既有核准不能沿用。另發現三個 dimension 的 target `Source*ID=0` 已保留給 Unknown 成員，但先前 `_ensure_unique` 只驗重複；若真來源給出 ID 0，`_UPDATE_*` 會更新 Unknown row，抹去其哨兵語義。已在來源抽取完成／target 寫入前拒絕這三種 ID 0，保留正數既有路徑；離線正例及三種負例納入 ETL 測試，**13/13 PASS**。不宣稱既有 target Unknown 成員目前內容已驗或新負例已在 SQL Server 重現。

   另經使用者**單次批准**，僅用既有本機 `sales_datamart_loader`、固定 `SalesDatamart`／容器 ID／image／port，單連線依次發出版本化 ETL 中兩條參數化聚合 SELECT（fact＋dim_date、reporting view），每條 timeout 30 秒。私有 mode600 收據 `.local/evidence/agent-p0-20260924/sales-datamart-view-aggregate-20260924.json` 已封存成功嘗試 `fact`、`view`、查詢與 source digest：目前 view 全域 count、同 scope count、quantity、兩金額、distinct orders 均與目前 fact 聚合相等，差異欄位空；結果未回傳業務列／未改資料或重跑 ETL。這**只證真 SQL Server 當次的兩條聚合查詢可執行與值相符**；沒有來源 DB 一致 snapshot、現有 view SQL 本文比對、錯誤 view 負例、目標 Unknown row 內容驗證、提交／取消／rollback、原生發布或 Agent 真入口驗收，亦不使舊 consent 對新版 ETL 生效。此單次授權已用完，不重送。

   續行的**離線 source-bound 欄位重算**（不取新憑證、不讀活的 Catalog）：目前 `extensions/sales-datamart` 15 個檔案 snapshot `9a93f24c…`，ETL SHA `a8ce788c…`，僅與 9/20 已保存的 13 筆 native Catalog 快照 SHA `a51a7f49…` 及本地重建的 source／target scope 候選一起分析。上輪新加的 `any(... for ...)` 令分析器對延遲 generator 產生四項 trace 阻擋；已在 ETL 的同一檢查改成等價字典比較，而非豁免分析器。可重跑的目前 source 連線 trace：source 8／target 17 SQL contexts、trace findings 0；source coverage 對選定入口完整（原 48 個廣域 unresolved 中 39 個明列為其他入口／provisioning，9 個被選定 write 證據綁定），37 個 target field 宣告分為 27 個來源依賴／10 個 generated。`LineNetAmount` 的靜態欄位 origins 是 `OrderQty`、`UnitPrice`、`UnitPriceDiscount`；1 個 view／24 欄及 7 panel＋2 variable 查詢在**保存 Catalog** 上靜態綁定，沒有當次 native 查回、公式／rounding runtime 證明、current ACL 或 Grafana live 值。分析器將目前程式分成 `extract`、`_load_dimensions`、`_load_facts`、`_validate_target` 四個候選 Job，與既有原生三 Job 不同；不得自行把它們當同一身份採用、發布或疊加 lineage。`tests/test_dataflow_discovery_python_catalog.py` 新增不需 Catalog／憑證的真 ETL trace 回歸，連同 ETL 測試目前 **25/25 Python PASS**；既有 Host→CLI／CAS 的合成 ETL 測試 **3/3 PASS**（不執行 SQL）。另以通過本地 `_validate_extracted` 的合成兩訂單六位小數 tie 重現 receipt AOV 原用 Decimal 預設 half-even 得 `0.500000`，但既有 panel／契約是 half-away `0.500001`；`_receipt` 改用既有 `ROUND_HALF_UP`，紅→綠已驗。上輪成功的兩條真 SQL SELECT 的**查詢 SHA 不變**，但整個 ETL SHA 已變；原單次授權與既有 COMMITTED consent 皆不授權新版 ETL。此分析不能充當真人 semantic 審核、native merge 或發布讀回。

   **Job 身分離線對帳（非採用核准）：**用同份目前 source／已保存 Catalog 形成的 `_load_dimensions` 9入／4出、`_load_facts` 6入／1出，逐 URN 均與 9/20 未批准的既有 3 Job 保留式 diff 之 `load_dimensions`／`load_sales_fact` 目標集合相同；`_validate_target` 3入／0出也與較早原生 `validate_datamart` 快照一致。另個 `extract` 候選讀7個來源、寫0個資料集，已是前兩個 Job 的來源傳遞證據之一，**不能只為了讓 generic compiler 通過就另造第四個真 Job**。建議後續保留既有三 Job 的原生 URN／歷史，在可信 Host 讀取當時現值及來源證據後，以可審差異決定是否接入欄位 lineage；不得把這份歷史集合相等視為目前 native 相等、Runtime success、Task 審核或新 Job 採用授權。目前 `compile_workspace_lineage` 會生成整批 Flow／四 Job／Dataset aspects，而既有 Task publisher 依完整重編 diff 審核；不能在輸出後私下丟棄第四 Job aspect 或手填原生 URN 冒充已驗相容性。以最新 ETL source＋已核准取得的 fresh Catalog／原生 Flow／Job 快照離線核對 URN：generic compiler 將產生**另一個** Flow，四個候選 Job 的 URN 與現存三 Job 交集 **0**；若不處理身份，並非既有 flow 的欄位擴充，而是平行新 flow。此為當時邊界建議；其後的本地候選如下，**仍未發布**。

   **既有 Flow／三 Job 的身分保留式本地候選（2026-09-24）：**可信 operator workspace policy 可選 `adoption`，固定 source snapshot SHA、既有 Python Flow URN、三個來源函式→既有 Job URN、各自原生 Key／Info／I/O Aspect 版本，以及只列證據的 `extract`；不接受模型提供身分。隔離 Python 編譯前核對四候選涵蓋、同一 Flow、環境、source snapshot，且 `extract` 無寫入且讀取已被映射下游消費；輸出**僅三 Job**，保留原生 Flow／Job 名稱及其他 Info 屬性，對原生 I/O 與 Dataset lineage 形成待審 diff。Host 在準備及再次 admission 編譯時要求該三 Job／Flow 現有 Key、Info／I/O 的原生版本**等於 policy 預先固定版本**且 owner source marker 相符；缺失、版本漂移、跨 source 或別的 Job URN 一律拒絕，不 fallback 新建。當前 source snapshot `e8875e75…`（sourceId `sales-datamart-case-v1`）配先前**有界** 9/24 原生 13 Dataset／1 Flow／3 Job 快照及**更舊的** 9/21 Grafana 7 query 快照，經 Node→隔離 Python 全路徑只讀編譯得 12 個待審 Aspects、三 Job URN 集合完全等於保存原生集合，`publicationAuthorized:false`；這不是 fresh Grafana／Actor／權限或現場 CAS 證據。新增負例覆蓋過期 source、跨 Flow、缺既有 native Aspect、source owner 衝突與 `extract` 無 downstream；受影響 93 Python、26 Node tests 通過。**尚未設定／部署 operator 採用 policy、建立真人審核、執行 metadata 寫入或真 `/mfe/agent` 讀回**；先取得同版 native＋Grafana fresh diff、真人語義審核與精確發布授權，不沿用舊 consent。原本 generic 新 Flow／四 Job 行為仍在未採用 policy 的離線編譯路徑，不能用於本案例發布。

   **無採用 policy 的發布邊界補正（本地）：**原 Host 即使沒有 `adoption` 也可能以 generic 編譯生成平行新 Flow／第四 Job 的 native diff，與已選定保留既有身分衝突。現在無 policy 仍可唯讀分析，但 `nativePlan.compiled:false`、四候選都不取得原生 URN，明列 `workspace_identity_policy_required`；可信發布準備在任何 native 讀取前拒絕。採用模式的 `_workflow_preview` 則保留 `extract` 的候選與相依證據，URN 留空，不再因未映射第四 Job 而 KeyError。以目前15檔 ETL source、先前保存的9/24 native Catalog 與**較舊**9/21 BI 快照，Node→隔離 Python 的兩種預覽分別為 56,566／56,776 bytes；原橋接56,000-byte限制會拒絕此已核定範圍的完整欄位圖，故限定預覽上限調至58,000 bytes，Host 最終60,000-byte上限未改；58,001-byte 負例仍拒絕。這些只是離線保存值與合成邊界檢查，非真 native 讀回、Agent 顯示或發布驗收。上列受影響測試數已含此修正。

   **固定七筆 BI 讀取與現場預檢停點（2026-09-24）：**使用者核准 Actor A 一次登入、最多40次公開唯讀 API，固定 13 MSSQL Dataset、7 Grafana query Dataset、1 Flow／3 Job，不授權 SQL／ETL／metadata 寫入。原 BI reader 先搜尋所有 Grafana Dataset，不符本次固定七筆範圍；本地 `adoption.relatedCatalogUrns` 改為 operator 固定七個 URN，直接對其逐一查權、批取原生 Aspect，無全域搜尋；正反例與完整受影響測試 27 Node／93 Python 通過，未部署。首次本地探針錯將保存的13筆分成來源8／目標5，於收據建立／憑證讀取／登入之前停止；原 SHA 及 0 外部呼叫另存 mode600 `.local/evidence/agent-p0-20260924/dataflow-adoption-local-preflight-failure-20260924.json`。保存快照實為來源7／目標6，離線編譯只對目標中的5筆產生待審 lineage、合計12 Aspects；修訂探針鏈接原失敗收據，未重跑原腳本。單次現場修訂批次 mode600 `.local/evidence/agent-p0-20260924/dataflow-adoption-native-preflight-revision-20260924.json`（SHA `8e27a7f9…`）：登入1次、**24/40** 公開 API 回200、session已關；13筆 MSSQL `datasetKey/status/schemaMetadata` 的逐 Aspect 版本與值符合 9/24 基線，七筆 BI 的逐資產讀權均過，但其 batchGet 與 9/21 保存快照至少一項**版本或值不符**，本地按規則 `STOPPED_NO_REPLAY`。收據只封存回覆 hash，未保存七筆的新版本／值，不能定位哪項改變或宣稱真 BI 語義漂移；Flow／三 Job 的本輪讀取、完整保留式 native diff／人審均**未發生**。本次授權已用完，不重送、不因 HTTP 200 當作通過。若要診斷，須另核准只讀七筆精確 URN／五個 Aspects 的有界批次，僅封存版本與安全摘要，不帶 raw SQL；其後仍需新授權與真人審查才可產生/核准完整 diff，更不含發布。

   **七筆 BI 精確差異診斷（另次核准、唯讀，2026-09-24）：**在上批 24 次停止並封存後，使用者另核准 Actor A 一次登入／最多10次公開 API，僅對**同七個精確 Grafana Dataset**進行前後身分確認、逐筆讀權及單筆 batchGet，對保存的9/21版本只比版本與 canonical 值 SHA，不輸出或保存 raw SQL。mode600 `.local/evidence/agent-p0-20260924/dataflow-bi-seven-native-diagnostic-20260924.json`（SHA `3116a499…`）記錄 **1 login、10/10 API 200、已關 session、35 Aspect 比較**：七筆資產只有 `schemaMetadata` 各由 v1→v2 且 canonical 值摘要不同，其他每筆的 `datasetProperties`、`upstreamLineage`、`viewProperties`、`status`（共28項）版本及值摘要與舊基線相符。此為有界版本／摘要差異定位，不揭示 v2 schema 內容，**不能證明欄位語義與查詢公式未變，也不能把舊審核或 9/21 BI 快照換成新基線**。本診斷授權已耗盡，不重查、無 native merge／人審／發布／SQL／部署；下一步需要獨立核准在可信環境有界檢查 v2 schema 內容並做完整 fresh diff，再由真人判讀，不能據摘要逕行 metadata 寫入。

   **第1關口徑核查（目前來源，非發布人審）：**以現行 ETL SHA `6848ac66…`、DDL SHA `266d21ad…`、Dashboard SHA `f68c4a79…` 及已核准的 `metadata/metrics.md`，只做本地證據對照：fact 一列為 `(SalesOrderID, SalesOrderDetailID)`；`LineNetAmount = OrderQty × UnitPrice × (1−UnitPriceDiscount)`，Decimal／6位 half-away；view 以四個 dimension key 做內連接，映出原明細且不自行創造新金額。固定範圍為 status=5、2011-05-31～2014-06-30、`CurrencyRateID IS NULL`；金額不是含稅／運費或已收款，幣別只稱 local；歷史 `scope_id` 雖含 `usd` 字樣，不可據此宣稱 USD，也不改寫既有 Run 身分。七 panel 的版本化 SQL 都從 reporting view 讀取：1/3/4/5/6/7 使用 line net，2 使用 distinct orders，3 為同一篩選範圍淨額／distinct orders、分母0為 NULL；7另呈 quantity／source line total。`UnitPrice` 靜態來源經 ETL 影響 line net 與上述六個 panel，**不是**由其直接導出訂單數或 quantity；來源 `SourceLineTotal` 與 `UnitPrice` 的計算依賴未由本案 ETL 證明。已成功的舊 Run 來源觀測為 2026-09-21 08:18:10～08:18:12 UTC、commit/readback 08:21:15 UTC、非一致 snapshot；舊 `as_of` 不等於目前資料時間。這是既有口徑與版本化 source 的對照，不是新 v2 BI schema／現場數值或真人 publication 核准：七筆 `schemaMetadata` v2 內容只保存 hash，須在**同一次實際準備人審／發布的 fresh 讀取**核欄位、grain、公式與 Run 時間；無法證明即停，不先做第三輪零碎 probe。

   **第2關隔離目標無寫盤點：**依使用者選擇只核本案既有 `dataflow-discovery-restore-check`：目前容器 `004e0b85…` 已停止，固定 SQL Server 2019 image `46f719fd…`、`network=none`、無 port binding；原 volume 仍在，未刪或啟動。9/14 兩份 AdventureWorks／SalesDatamart backup 是受保護檔、bytes 與 SHA 均符合原收據；但當時兩 DB restore 後的 compare **`command_exit_1`／`INCOMPLETE_RECONCILE_BEFORE_RETRY`**，不能將此 clone 當成已驗乾淨環境。既有 9/14 ETL 注入 `before_commit` rollback 收據證事前／事後 fact count 與淨額未變，僅涵蓋舊版交易接點；新版哨兵／view guard、DDL 錯型、真 timeout／取消／並行仍無真負例。另經明確核准，僅對**同一 clone** 啟動一次、用其容器內既有受保護 SA 環境變數發4條 metadata／聚合 SELECT（30秒／條）、停止一次，沒有新秘密輸出或 SQL 寫入；mode600 `.local/evidence/agent-p0-20260924/recovery-clone-target-readonly-20260924.json`（SHA `6bac6ab9…`）：兩 DB ONLINE、來源七表、目標五表一view可見，fact/view皆75,284筆且淨額各72,418,506.319091；容器已恢復 stopped、volume保留。這只核克隆中**所比項**，不把 9/14 原全量 restore compare 失敗改稱已解，也未跑新 ETL 或真負例。其後另次明確核准、單次執行 clone-only 的固定負例計畫 `7e359c16…`，收據 `.local/evidence/agent-p0-20260924/recovery-clone-negatives-20260924.json`（SHA `4196ce2f…`、mode600）記錄：`tempdb.dm.dim_product` 故意建成 view 後，同一 DDL 預檢回 51004，查得未在 `tempdb.dm` 建表；clone 目標 Unknown 產品以單交易暫改、同一 ETL sentinel SELECT 回 `canonical=0`，rollback 後同 SQL 回 `1`。接著 `locker_session_identity` 查詢結果格式／筆數不符，**沒有**執行預期的 lock timeout、KILL 取消、事後金額讀回；依計畫立即 `STOPPED_NO_REPLAY`，容器已停止且 volume 保留。不能把 SQL Server clone 停止視為已讀回證明該未完成鎖交易的回復。經**另一單次核准**重啟相同 clone 僅執行三 SELECT，mode600 `.local/evidence/agent-p0-20260924/recovery-clone-after-negatives-20260924.json`（SHA `63fe5c7a…`）綁原失敗 SHA：兩 DB ONLINE、原四 Unknown 的同一 SQL `canonical=1`，fact/view 仍各75,284筆／各72,418,506.319091；clone 已停止、無新 SQL 寫入。這證**所查 key0 和彙總值**恢復，非所有資料列、完整 restore compare 或取消已成功。原批次及三 SELECT 授權都已用完；lock timeout／取消及新版 ETL 真執行仍未驗，先查原辨識失敗原因，不重跑原批次，也不在現用 SalesDatamart 製造負例。

   **Host fresh Catalog 有界請求修正（僅本地）：**`native-discovery.mjs::readDiscoveryCatalog` 原先將同一個 10 秒 `AbortSignal` 共用於前後 Actor 確認、逐資產 ACL 與批次 Aspect 讀取，導致每一條公開 API 都及時回覆、但總和逾 10 秒時後續查詢會被前一條已過期的信號拒絕。現將原本的逐請求時限建立移到單次 `call` 內，`assertActive`、逐資產權限及前後 Actor 確認均保留；離線回歸在首筆已完成後讓前一信號過期，驗證後續讀取仍須以自己的有效信號完成。相鄰的 Grafana native BI／發布 diff 讀取對 malformed JSON 改回傳既有 fail-closed Discovery 錯誤，不回傳原生解析例外。`tests/test_agent_discovery*.mjs` **23/23 PASS**、三檔 JS LSP clean、`git diff --check` PASS；其中原有測試把分析版號寫死為舊 `1.0.2`，已依當前原始碼 `1.0.3` 更新。這些均為合成 Host 測試，**沒有當次 fresh DataHub Catalog／ACL 或真 `/mfe/agent` 驗收，也未部署**。隨後使用者另批的一次 native 唯讀批次**未完成**：單次受保護憑證讀取及 `datahub` 登入回應200 後，在第一條原生 API 前即停止，實際 native request **0**；mode600 原始封存 `.local/evidence/agent-p0-20260924/dataflow-fresh-native-20260924.json`（SHA `e7c4ecf4…`）、狀態 `STOPPED_NO_REPLAY`／已關閉 session。原因由本地腳本與 `datahubSessionCookie` 現行原始碼可重現：腳本只從登入 session 保留 `PLAY_SESSION`，而 Host 明確要求 `PLAY_SESSION` **及** `actor` cookie；缺少後者會在網路呼叫前擲 `authentication_required`，原封存將非白名單錯誤記為 `native_batch_failed`。此為探針錯誤，**不是 native ACL 拒絕或 live DataFlow 比對**。該次登入授權已用完、原批不重送；新 revision 在本地改為同時選兩 cookie、鏈接原失敗 SHA，語法／合成 cookie 契約已驗。使用者隨後**另行核准**修訂版：mode600 `.local/evidence/agent-p0-20260924/dataflow-fresh-native-revision-20260924.json` 封存 login 1 次、公開 native API 23/23 回200、已關閉 session；受保護 `-catalog-revision-20260924.json` 與 `-flow-jobs-revision-20260924.json` 記錄目前 13 個 Dataset／149 欄、1 Flow＋3 Jobs 的固定 Aspects 與版本，無 SQL、ETL、metadata 寫入。13 筆 Dataset 的 `datasetKey/status/schemaMetadata` **值及原生版本**與 9/20 既存快照相同，但只證此次 allowlist，不代表全域 Catalog。以此 fresh Catalog 綁目前 ETL 再離線重算，三個來源函式對**當次原生三 Job** 的資料集輸入／輸出 URN 集合逐筆完全相同：9／4（I/O 版本2）、6／1（版本2）、3／0（版本1）；另個 `extract` 候選讀7／寫0，並未取得第四 Job 原生身分。這是原生 base＋靜態 source reconciliation，不是欄位 lineage／公式 runtime、人審、native 發布、Actor B ACL 或真 `/mfe/agent` 讀回；修訂版授權也已用完。原第一輪失敗收據保持原樣。

   另經使用者**新的一次**批准、固定同一容器／`SalesDatamart`／既有 `sales_datamart_loader`，只嘗試兩條 target SELECT；封存 mode600 `.local/evidence/agent-p0-20260924/sales-datamart-unknown-view-20260924.json`。第一條只在四個維表 surrogate key=0 讀聚合，四筆各 `sentinelCount=1`／`canonicalCount=1`，與目前 DDL 的 Unknown seed 值相符，**只證當時這四筆的固定欄位值**。第二條已發出 `sys.sql_modules` 的 view definition 唯讀 SELECT，但結果本地判為 `view_definition_unavailable`（可能零列、NULL／空定義；原探針未保存回傳筆數，因此不能定因）；批次 `completed:false`，沒有 view SQL 內容或 AST 比對成功。`002_provision_principals.sql` 對 loader 只授 SELECT，未明列 VIEW DEFINITION；`003_provision_metadata_reader.sql` 對 metadata 帳號有精確的 view 定義讀權，這與權限不足假說相容，**不是現場原因證明**。原失敗與已成功 Unknown 讀回保留，**不重送**該批、不自行換用另一帳號或放寬權限；後續單獨核准、無寫的 metadata 檢查才可補這個洞。此結果不證 view 定義等於版本化 DDL，也非錯型／並發／rollback 負例。

   上述失敗批次封存後，使用者**另批一次**既有 `datahub_ingest`，對同一固定容器／`SalesDatamart` 只發 **1 條** view 的 `sys.sql_modules.definition` 唯讀 SELECT。mode600 `.local/evidence/agent-p0-20260924/sales-datamart-view-definition-ingest-20260924.json` 與原失敗收據 SHA 綁定：回覆1列且定義非空，在記憶體將**完整 view CREATE AST（忽略部署動詞 CREATE／CREATE OR ALTER 差異，不忽略 view options、投影、JOIN／條件）**與目前版本化 DDL SHA `266d21ad…` 比對，AST digest 相同；僅保存 SHA／摘要而未保存／輸出 SQL 原文。證據僅為這次目標庫觀測，未核未來漂移、資料列與原生發布內容，也沒有來源 snapshot／並發保證。metadata 帳號成功與 loader 失敗符合讀權差異假說，但 loader 首輪沒有保存回覆形狀，**不能倒推唯一失敗原因**；兩次批准均已用完，不重送。

   **ETL 既有 Unknown 成員漂移拒絕（本地候選）：**上面一次唯讀查詢只證當時四筆 canonical；既存 DDL 僅在 key0 不存在時插入、不重驗其後欄位，原 ETL `_load_dimensions` 則先按 Source ID 更新，若 key0 的 Source ID 已被外部改為真 ID，可能把真來源路由至 Unknown surrogate key。現於該函式的**第一個寫入前**，在 target transaction／既有 `sp_getapplock` 下以單條有界 `TOP (2)` SELECT 檢四表 key0 且全部 DDL seed 欄位相符；以 `UPDLOCK,HOLDLOCK` 對各表限定列維持更新／序列化鎖至交易結束，避免成功檢查後由一般並行 writer 改寫哨兵（仍需真 SQL Server 並行負例確認）。缺列、非 canonical、重複或回覆型別異常均拒絕，不補造／更新資料。舊程式對三種負例的聚焦測試紅，修後負例與正常映射綠；本地 ETL／Discovery **27/27 PASS**，T-SQL parser 見四表 SELECT、fresh Catalog 離線重算 source trace 0 阻擋，四候選 Job 及現存三 Job 的 9／4、6／1、3／0 I/O 集合沒有因新 SELECT 改變。**新版 `_UNKNOWN_MEMBERS_SQL` 未在 SQL Server 執行，鎖衝突／逾時與真正錯列負例未驗；新 ETL SHA `6848ac66…` 使舊 COMMITTED consent 更不適用。**不把此本地 guard 當作 DDL race、完整 rollback 或人工語義驗收。

   使用者另核准一輪既有 `datahub_ingest`／`SalesDatamart`、最多三條僅 `sys.*` 的唯讀 shape 查詢。固定本機 SQL Server container／image 預檢及 metadata-only 登入成功；**只發第一條 columns SELECT**，取得回覆後探針的本地判定 `target_objects_missing_or_wrong_type`，即停下，constraints/indexes 未查。原探針在判定前未封存該回覆，故不能斷言真物件錯型或權限縮減。原 mode600 失敗收據 `.local/evidence/agent-p0-20260924/sales-datamart-target-shape-20260924.json` 保留；離線已修訂探針先保存回覆、對 `sys.objects.type` 的 `char(2)` 空白正規化，**尚未重新登入或查庫**。這是原因候選，不是已證明的根因；重查需新的明確授權。無業務列、DDL/DML、ETL 或其他憑證。

   使用者**另行批准**修訂版一次唯讀批次後，同一固定 SQL Server container／image、`SalesDatamart`／`datahub_ingest` 執行了**恰好三條** `sys.*` SELECT（columns、constraints、indexes），依序 61／19／14 列，六物件全可見；六物件合計五表37欄＋view24欄，19條 constraint、13個 index（14列含複合 PK 的兩個 key）。私有 mode600 原生查回 `.local/evidence/agent-p0-20260924/sales-datamart-target-shape-revision-20260924.json`。實際 `sys.objects.type` 為 `char(2)` 含填充空白；這與第一輪誤判**相容**，但首輪值未保存，不能事後宣稱唯一根因。離線以同一 DDL SHA／sqlglot AST 與此原生快照對照：五表37欄的名稱／型別／長度或精度／NULL／identity、19個 constraint 的名稱／FK欄位與目標／啟用可信狀態及5個 CHECK 的解析樹、13個 index 的鍵序／unique／type，以及 view24欄投影名稱與順序，均無所比項差異。首個本地 comparator 對 PK/UQ 的 AST 取欄方式錯誤而假報九筆 index drift，原收據保留；修正後 v3 結果 `differences:[]`，見 mode600 `.local/evidence/agent-p0-20260924/sales-datamart-target-shape-comparison-v3-20260924.json`。**未比對當前 view SQL 本文、identity seed／increment、資料列、物件建立時間或 DDL 並發 race；此次快照不是未來形狀保證或真錯型負例，亦未執行新 ETL。**
6. [ ] `access-boundaries`：真跨 Actor、Grafana reader、秘密及 SQL 權限分離。
7. [ ] `publication-boundaries`：發布／執行版本、過期、重複、部分失敗／UNKNOWN 對帳。
8. [ ] `final-delivery`：必要欄位／語義、真 run／as_of、全鏈回歸與回復 runbook／文件／驗收。

不要求所有純量／helper 語義完成才接通可獨立證明的表級 flow；必要欄位與業務語義仍保留於最終交付，不以表級結果假稱全部完成。現有認證、scope、秘密隔離、人工核准、版本條件及人工 metadata 保護不降低；目前實作所需測試操作沿用本日最新測試授權，仍須限定目標並保留操作／對帳收據；metadata發布走既有人審／條件寫入，不以測試授權替代。非前置的全面安全優化留在第一完成線之後。

原平台可信 Join 完整生命週期、一般受控 SQL、Oracle、Agent 排程與其餘 T06／T07 留在原 TODO，不屬本次完成條件。以下歷史18項／DM01–DM09證據保留；後續以本節八項與新 Goal 為執行順序。

### 2026-09-20 Host部署交接（14:48歷史，下節取代目前runtime狀態）

`flow-host-scope-deployment-run-20260920.json`保留原後檢逾時；`flow-host-scope-readback-run-20260920.json`證實實際MFE scope、原image／HOME及歷史session hash一致。新gateway PID1770369、runtime `04adf0e90624…`持續服務；本批零Task／Run／Catalog寫入、SQL及模型prompt（另有一枚原生reader測試token建立）。該token於2026-09-20 15:27:45 UTC到期；不是永久憑證生命周期修復。舊WebSocket error前四次模型工具回合成功，原因仍未證實，不混同MCP token到期問題。最新Goal讀回為**paused、1/8**，未自動續建Run或發布。

### 2026-09-20 發布與MFE結果（原始狀態；下方9/21進度接續）

- 真MFE Task／Run已取得模型的`datahub_get_me`、`datahub_get_entities`回應，讀到既有Flow／Jobs；工具省略Job I/O不代表原生I/O不存在。同一Run後續真`datahub_decision`已完成，沒有假造pending state。
- 可信Host重編真source／fresh Catalog，將精確保留式review附至同一未回答Decision（Run v3）；使用者另准既有authenticated typed API核准（v4），不是UI點選驗收。原native問題收到儲存中的APPROVE後正常停止，未自行發布。
- 唯一Host admission使Run變成v5；只送出一次、兩個`dataJobInputOutput`皆帶v1條件。讀回兩個Job已為v2，值與核准提案完全一致：`load_dimensions` **9→4**、`load_sales_fact` **6→1**；`validate_datamart`仍v1／**3→0**。已讀的非I/O Aspects及第三個Job未變。
- **未通過完整發布驗收**：原生`systemMetadata.runId`符合attempt，但`dataflowDiscoveryRunUrn`／`dataflowDiscoveryDecisionId`未讀回。Host正確回報`publication_write_unconfirmed`；尚未證實標記遺失的具體環節，不能宣稱API必然不支援。未重送、回滾、補寫或放寬ownership檢查。新增此實際回覆形狀的回歸；57 Host tests通過。
- 原MFE檔案切換未更新gateway啟動時快取；經另外明確批准，在native Run結束後只重啟9041 gateway／單一runtime。HTTP現在供應核准`70.js`（`09dc42d2…`）；原image、HOME、兩份session歷史及MCP設定hash完全保留。新gateway PID **2124417**、runtime **`80f469dbfe5d…`**。前置腳本誤要求已結束的Pi程序仍running，第一次在SIGTERM前停止；只讀查明`running:false`代表程序已退出，修正驗證器後才執行唯一重啟。
- **Grafana尚未發布，完整Agent／WebUI flow未驗收**。MCP測試token已於15:27:45 UTC到期，本批沒有刷新。Goal最後原生讀回仍**paused、1/8**（15:18使用者暫停），限定後續批准不等於自動恢復Goal。下一步先診斷／處理發布標記缺口；任何補寫都需新的精確方案，不重用已消耗的review。

### 2026-09-21 前段：Adapter已核准驗證，既有admission只讀對帳成功

恢復後，原生診斷Task重現固定Core更新保留舊properties、ACK帶新properties、runId成功更新；`EntityServiceImpl.applyUpsert`吻合該結果。使用者核准最小相容性修正：新runId保存版本化Run／Decision／attempt定位，但權限仍須查權威紀錄；不改Core、不加服務／資料庫，不豁免ownership、no-op、fresh consent或CAS。

65項Host／runtime／Grafana fixture測試通過；既有不執行診斷Task的一次v2→v3更新，證實新格式可完整原生讀回。兩個Job經既有Host對真正Run v5／Decision／admission只讀對帳，得到`MATCHED_KNOWN_LEGACY_ATTEMPT`，精確值與修改audit／版本吻合；維持9→4、6→1，第三Job仍3→0。**沒有Job／Run重寫；`retryAllowed:false`，舊UUID-only目標仍需明確ownership review才可再寫。** 原unconfirmed收據保留，不改稱當次全量成功。

Goal原生讀回為**running、1/8**。Grafana121-Aspect真產物仍未發布，下一步接妥保留產物的fresh source／Catalog／target-bound準備與真typed核准；不重播成功擷取。完整WebUI／Agent回答、固定ETL及其餘驗收仍未完成，過期MCP測試token未刷新。證據：`flow-native-runid-adapter-ready-20260921.json`及其所列65-test、native storage、只讀對帳收據；沒有本輪部署或獨立審查。

證據：私有`flow-canary-publication-run-20260920.json`、`flow-canary-publication-reconciliation-run-20260920.json`、`flow-mfe-post-terminal-restart-run-retry1-20260920.json`、`flow-systemmetadata-causal-finding-20260920.json`及`flow-integration-checkpoint-20260920.json`。詳細過程見[publication最新結果](verification/dataflow-discovery-publication-review.md)。

### 2026-09-21 前置：Grafana可信準備通過、MCP憑證已更新

既有Host新增私有Grafana產物compiler，固定原始file sink SHA，重新核對source／Catalog，再產生create-only提案；沒有公開model發布端點或重跑擷取。真產物是官方簡化MCP `aspect.json`（先前觀察的`aspect.value`是SDK轉換後物件），保留原生PDL namespace／union。67項相關Node tests及3檔primary LSP通過。

獨立收據的預檢以20次Grafana／30次DataHub requests驗證目前dashboard／權限／view schema／目標不存在及發布privileges：**121 Aspects／17資產、8 Dataset scope**。僅有未核准草稿，未建立新Task／Decision或發布；原失敗與token400只讀對帳保留。來源與版本仍須在真正發布時重查。

使用者明確指示「自行更新mcp 憑證」後，已為**同一只讀service account**建立一小時token，公開SDK成功讀取既有view的key／status／schema，只原子更新受保護Pi HOME的MCP Authorization。有效至 **2026-09-21 02:53:46 UTC**；工具／URL／角色／image不變、兩份history hash保留，無重啟或新prompt。這不是永久自動續期，也尚未證明新Agent回合的MCP E2E。

證據：私有 `flow-grafana-compiler-ready-20260921.json`、`flow-grafana-publication-preflight-run-retry3-20260921.json`、`flow-grafana-agent-reader-refresh-run-retry1-20260921.json`。Goal維持**running、1/8**；下一步是真Task／Decision、fresh typed人審與條件發布，再完成WebUI／Agent flow讀回。

### 2026-09-21 最新：真UI核准、Grafana發布與完整Agent查詢通過

當時Goal為 **running、3/8，current fixed-etl**；最新暫停狀態見下節。Task建立502與review存入失敗定位至原生URN存在性驗證：提案包含尚未發布的Grafana Datasets。經逐次批准熱載入，現行模型 **0.1.6** 僅將Task及PublicationReview的datasets改用原生支援的平面`UrnValidation`／`exist:false`；actor／agent／Source、Host scope、privileges、fresh consent與CAS不放寬，Core未改、服務未重啟。0.1.4巢狀設定無效的失敗收據保留。

- 真Agent建立pending Decision；使用者批准精確digest `99a2397702b6f3a32158fb669919edfa917acf89b0cead0079313aedfb95bfdc` 後，在真MFE點選typed APPROVE，Run v4；native問題收到已存答案並結束。不是以API代替UI點擊。
- 既有Host重查來源／Catalog／權限／版本，一次Run admission及一次create-only批次發布 **121 Aspects／17資產**。所有值、版本及版本化runId provenance完整讀回；舊Job沒有重寫。獨立native讀回包含Flow、三Job（9→4／6→1／3→0）、13既有Datasets、view五上游與17 Grafana資產。
- 真WebUI同一既有模型、3回合 **20次MCP讀取／零工具錯誤**，回答完整來源→Jobs→目標→view→七組query→Charts→Dashboard，列可核對URN／連結及未證實語義。官方path工具只回兩條，因此改查七個Chart的直接上游；逐項對帳原生`chartInfo.inputs`，不以同名猜測。terminal與reload前後全訊息相等。
- 真DataHub導覽Flow→三Jobs及Job Lineage、Dashboard與Chart；點擊原生Grafana連結落到正確Dashboard／panel。這次刻意擋下datasource執行，只驗導覽，不宣稱重跑SQL或驗證panel數值。
- 原WebSocket錯誤根因仍未證實；本輪同模型的完整查詢已成功，不把MCP token到期混稱其原因。新reader token有效至 **2026-09-21 03:57:04 UTC**，仍不是永久續期方案。

私有證據：`flow-model-016-deployment-run-retry2-20260921.json`、`flow-grafana-ui-consent-fixed-20260921.json`、`flow-grafana-publication-run-20260921.json`、`flow-complete-native-readback-20260921.json`、`flow-web-agent-acceptance-20260921.json`、`flow-web-agent-seven-edges-20260921.json`、`flow-grafana-links-live-20260921.json`。

必要欄位lineage、公式／grain／as_of、UnitPrice影響、真正固定ETL人工核准執行及其餘邊界仍保留。回顧：真接點直接揭露模型annotation與官方MCP回傳範圍的差異；沿既有能力修正／補查，不新增框架、不重播已成功發布。操作驗證器的誤欄位與過早terminal判定收據保留，以後續原生結果對帳，未重送同一模型prompt。

### 固定ETL接線準備（歷史；後續已完成真執行）

已查明既有`native-ingestion.mjs`僅接受固定MSSQL metadata recipe，不改成ETL／shell runner。ETL已有單一target transaction與application lock，但目前先擷取再取鎖，且`.all()`沒有列數上限。隔離候選 `.local/work/fixed-etl-20260921/` 補DBAPI timeout、100,000筆fetch上限與結果關閉，並將既有target鎖提前至source extraction之前；23項既有／聚焦檢查及兩檔primary LSP通過。這是本地候選，不是完整wall-clock／取消保護或live SQL證據。

真源碼／recorded Catalog接縫檢查確認SQL context ID綁定完整snapshot；不能用舊policy套新ETL。修改已隔離，active source恢復原snapshot `ed276f258c…`，原Host／SDK重新編譯仍為23 I/O（9→4、6→1、3→0），未發布或執行SQL。下一步補既有Task／Decision內的ETL專用核准、一次admission／結果及固定CLI監督，對候選重新綁source policy；部署與寫入批次仍需精確批准。證據：`fixed-etl-candidate-checkpoint-20260921.json`、`fixed-etl-bounds-local-20260921.log`。

### 2026-09-21 固定ETL候選與使用者暫停交接（歷史）

所有新功能仍在 `.local/work/fixed-etl-20260921/`，**未部署、未執行SQL、未新增DataHub紀錄**。現行ETL及已驗收flow保持不動；Goal未新增完成項目。

- 候選沿用Task／Decision／Run，加入獨立ETL review／typed verdict、一次CAS admission、提交前授權及聚合結果；operator grant限一個actor／Run／code digest／期限，預設不授權，沒有model／HTTP任意SQL入口。
- 固定CLI使用凍結程式、受保護credential env、提交許可pipe、有界輸出／deadline／資源；父程序EOF不放行提交，UNKNOWN不重跑。新增提交後target讀回及明列非跨表snapshot的source觀測時間。這些尚無真SQL驗收。
- 真Python CLI／stdin＋Host CAS的合成ETL檢查通過允許／拒絕路徑；Chromium fixture驗證獨立ETL核准、digest、focus及390px controls。64項Host中間版回歸通過；**最後的runtime pin／operator policy／API接線尚待最終source檢查**，不以中間版測試當全量通過。
- 新安全取數寫法曾使現有辨識漏掉10條來源邊。只在既有mapping-result辨識補精確的bounded fetch／拒絕overflow／finally close型態，並分開dry-run local；9項query-decoder檢查通過。保留原13-edge失敗，重新綁25個context後，候選snapshot `e6f71e55cd…`經既有SDK恢復 **23 I/O（9→4／6→1／3→0）**；沒有手寫來源→Job mapping或發布。
- 模型 **0.1.7** 已在原隔離／離線工具鏈建置，legacy與ETL codec roundtrip、annotation check通過。首輪shared inline enum無法解析的失敗保留；改獨立purpose schema後成功。MFE已建置，均未切換使用中版本；Core保持乾淨。

私有完整hash／證據／缺口：`fixed-etl-execution-control-checkpoint-20260921.json`。原生Goal最新事件為使用者暫停，已停止後續工作。恢復後先核對checkpoint並補最終限定檢查，再準備精確部署／fresh preflight與人工核准的單次ETL批次；不得重播舊ETL、發布或模型prompt。

### 2026-09-21 最新：fixed-etl真實闭環通過，本輪停止於此task

使用者核准限定部署／靜止來源窗口，再核准精確review `24600f42dc…` 的真UI點擊。模型0.1.7已熱載入；本案gateway只重啟一次，原image／HOME／session保留。固定ETL唯一attempt `1cc50ec6-610b-453e-9cb7-afe9c30d581b` 已提交，Run v7／COMMITTED；source／fact／view各75,284筆，17,489訂單，金額72,418,506.319091對帳一致，耗時185,013ms。提交後以新target連線驗證，再以原生get_run、Tasks UI及同一gpt-5.6-sol會話讀回；terminal及reload一致。

沒有SQL重跑、DDL／DELETE、權限縮減、Core／DB設定變更；沒有展開其餘tasks。來源不是跨語句一致snapshot，本次依核准靜止窗口執行。模型收到的是實際Host get_run讀回結果，不冒稱MCP直接支援custom Run Aspect。現行68 Host／10 ETL unit tests通過；原始操作腳本的路徑錯誤、啟動回覆不完整與過早terminal判定均保留，採讀回對帳而非重播。詳細證據及限制見[固定ETL驗收](verification/fixed-etl-20260921.md)。

## 歷史實際進度（2026-09-19，依使用者要求重新盤點）

**2/12是舊任務切法，不是產品只完成兩項功能。** DM02混入後續發布／權限／Agent全閉環，且跨任務成果未同步；本次已確認18項成果任務並登記10項限定里程碑complete，8項仍需完成。完整盤點、原要求移轉及證據見 [專案盤點](verification/datahub-progress-inventory-20260919.md)。不以任務比例宣稱產品完成百分比。

原生Goal盤點時paused；`set_goal_tasks`已確認18項。續行時讀回running，已用`update_goal_task`補登八項完成並start `discovery-validator`；再次`get_goal`確認**10/18 complete、current discovery-validator、next pending data-safety**。下表證據齊的十項已登記，限定本地交付不冒稱live發布完成。

| 新成果 | 判定 | 仍保留的後續工作 |
| --- | --- | --- |
| scope-discovery／dm01 | 已complete | 原記錄保留；備份回復不重做 |
| model-canary（取代過大的DM02） | 證據齊：星型／指標、Flow＋三Job、19 Aspects／13 direct I/O／真UI | 完整來源／Job相依／run／欄位與語義歸dm06 |
| dm03 | 證據齊：4dims＋fact＋view／keys／權限已建置 | 同名／重複建置防護歸data-safety |
| dm04 | 證據齊：真ETL初載／重跑對帳／失敗rollback | timeout／有界擷取／穩定keys與完整品質負例歸data-safety |
| dm05 | 證據齊：專用Grafana v2、7 panels、8真場景 | 非owner／folder-datasource ACL歸access-boundaries |
| catalog-native | 證據齊：13 Dataset／149欄、view五上游／24欄位lineage／UI | 不是Python ETL lineage或Grafana metadata發布 |
| discovery-skill | 證據齊：snapshot／基礎候選／真Agent唯讀入口 | 完整Python欄位鏈、fresh Catalog與變更驗收歸discovery-validator |
| grafana-adapter | 本地交付證據齊：schema／Chart各14欄、官方file-sink與120技術Aspects準備 | live reader／發布另驗 |
| publication-host | 本地交付證據齊：模型0.1.3、typed review／CAS admission／conditional writer／source重編 | 未部署；真正Host caller、人工操作及live API歸publication-live |
| discovery-validator／data-safety | 待整合／修補 | 收斂既有解析與ETL，不再擴架構 |
| access-boundaries／publication-live | 部分已有，待精確授權／接線／部署／真驗 | 不用fixture當live或舊批准重播 |
| dm07／dm06／dm08／dm09 | 固定ETL可信操作／完整發布／查詢／最終交付仍未完成 | 原完成線全部保留 |

**使用者最新取捨：Grafana 只需可用，不再精修 UI；主線是 DataFlow Discovery 在 DataHub WebUI 與真 Agent 的正確呈現。** 目前轉向 target metadata／身份／lineage／語義／可信發布與讀回，不以 Grafana 外觀工作延後主線。

**2026-09-15 使用者要求收斂：不可自行擴架構，停止新增解析層／日期解析。** 原生API canary已經使用者核准，另准補一筆Python平台metadata後，完成1 Flow／3 Jobs及共19個明確新Aspect、13條direct SQL Dataset I/O的API/UI/reload驗證。六個既有Dataset的key/status/schema及版本前後未變；不是完整Skill發布，這批不可重播。詳 [精確範圍及既有接點缺口](verification/dataflow-discovery-dm02-compatibility.md)。不把一般Decision回覆當publication授權，不新增替代核准權威或狀態庫。

最新 DM01 證據：[native canary 與範圍結論](verification/dataflow-discovery-dm01-canary.md)、[隔離回復](verification/sales-datamart-recovery-20260914.md)。後續完成線未縮減，不因已建庫／跑 ETL 就自動把未驗的相容性與負例勾掉。

### 2026-09-19 現場唯讀預檢（A／A1／A2 歷史，B 前觀測）

經使用者限定批准，以真`readDiscoveryCatalog`讀回13 Dataset／149欄／39 Aspects，version皆1、值與歷史一致，17 HTTP全成功。**Agent尚未恢復**：9041無listener，原owned runtime已於9/15退出（255、OOM=false；原因未證實），設定仍未啟用field mode。HOME mount吻合，但volume owner讀回因一次性verifier格式錯誤未完成；修正只經離線fixture驗證，未再查live。沒有服務／權限／metadata變更、SQL或模型呼叫。下一步先收斂既有Host恢復與field-preview的相容性／精確授權，不再增parser；Goal仍10/18。詳[現況與原始證據](verification/dataflow-discovery-field-host-integration.md)。

### 2026-09-19 最新：C 已恢復並保留 Host，既有模型回合仍有錯誤

C 經另行核准完成：原 image／HOME、同一 field policy 保留；真 session 證明 B 的驗收器綁錯 ID，四份工具結果與 B 收據逐值一致。舊 digest／注入 catalog 分別得到409／400，零新模型生成。既有 assistant 只有部分摘要，`stopReason:error`，缺 decoder 鏈說明與完成標記；未做回答 reload，E2E 仍未通過。錯誤原因尚未讀回，不重新啟動或重送 prompt。詳[C結果／現況](verification/dataflow-discovery-host-reconciliation-result.md)，Goal仍10/18。

### 2026-09-19 歷史：B 真欄位工具回應已取得，驗收未完成後回復

經另行明確批准，B 完成真 HOME owner 驗證，原 image／HOME 啟動成功，真 Agent 取得四個 Discovery HTTP 200（list＋三頁欄位／decoder），仍是56 slots／19 contexts／311 decoder nodes、INCONCLUSIVE／不可發布。但驗收器誤以 UI 外預建的 idle session 綁 Send，等待 ACK timeout；最後模型回答、實際 session、reload及兩個負例尚未讀回。已按核准 graceful close 新服務、保留 HOME、還原 config，原／新 container 均移除，不重送 prompt或重播B。離線用真SDK及registry函式已重現空session不列history的前提缺陷；下一步只讀對帳已送出的回合，需新批准恢復同一Host。詳[B結果／診斷](verification/dataflow-discovery-host-recovery-result.md)及[C限定提案](verification/dataflow-discovery-host-reconciliation-proposal.md)。Goal仍10/18，不以四個工具成功當完整E2E或語義驗收。

### 2026-09-19 續行：欄位分析已接既有Host協定（以下為本地實作證據）

原`analyze`只呼叫基礎analyzer；現以Host可選`pythonAnalysis`接入既有query→record→SQL slot／lookup分析。Host核actor／逐URN授權、讀native key/status/schema與版本，隔離Python無cookie；模型不能注入entrypoint／scope／Catalog。每頁摘要綁source／全部分析／Catalog版本，schema或scope漂移拒舊頁，所有未驗語義維持INCONCLUSIVE，不新增parser或寫入入口。

現行81 Node／141 Python PASS；九檔真source以歷史Catalog＋HTTP fixture經同一Host與隔離bridge核得56slots、49record-linked、8lookup、19contexts、1423 transport nodes／331unresolved，6頁欄位與所有contexts可讀。同日修補bridge遺失decoder證據及同名ref歧義：v2以graphId分開transport／decoder，四個既有decoder summaries及311 nodes完整讀回，舊v1游標拒絕；沒有再增解析層。續修既有Graph的try正常延續判斷，實際`_as_decimal`僅一個helper節點由錯誤prior恢復assignment；吞錯及例外路徑保持未解，漏掉的except* guard已補上，不宣告轉換或runtime成功。真改名／算式變更負例及合法重分析已有合成同流程回歸；不是首例全語義或live驗收。接下來收斂既有轉換／成功條件与真正entrypoint policy，部署／fresh Catalog／真人入口另批；`discovery-validator`不提前complete。詳[接縫與證據](verification/dataflow-discovery-field-host-integration.md)。

## 重整後的依賴與執行順序

已登記10個限定里程碑，不重建／重載／重發成功成果。剩餘主線為：

`discovery-validator（接通既有欄位／Catalog能力）→ publication-live（真Host準備／核准／writer）→ dm06（完整技術／語義metadata）→ dm08（真查詢）→ dm09（最終交付）`

`data-safety → dm07（固定ETL可信操作）`提供安全的真run；`access-boundaries`提供Grafana reader及真跨Actor驗證。這兩支按實際依賴與批准插入主線，不再等待一個涵蓋整案的DM02。缺外部授權不妨礙其他已授權本地整合。

以下保留原DM01–DM09詳細要求以追溯；各未完成項依[移轉表](verification/datahub-progress-inventory-20260919.md#原要求不遺失的移轉表)承接，不是刪除要求。母T06/T07、排程不自動結案或全數列為本Goal前置。

### DM01 — 來源、環境與安全操作範圍

**已完成**（見 [native canary](verification/dataflow-discovery-dm01-canary.md)）：[DM01環境與恢復證據](verification/dataflow-discovery-environment.md)。已用現有 Microsoft AdventureWorks2019 backup 恢復固定 SQL Server 2019 image：`wferp-mssql-test`／`14334:1433`／named volume；WSL與DataHub Actions的 `host.docker.internal:14334` 均可連。七個候選表、日期、key／orphan及唯讀帳號已核對；`datahub_ingest` 密碼依使用者指定設定但不記錄，SA仍為受保護隨機值。Grafana已定位13.1.2／:3000／org1，未改設定；舊 `wferp-test` datasource仍指向未建立的`wferp_test`，不是本案AdventureWorks datasource。SalesDatamart／ETL 已有真資料、重跑及 rollback 證據。新增 [隔離回復演練](verification/sales-datamart-recovery-20260914.md) 已驗兩庫還原、226 項對帳及三個最小權限登入。DataHub 官方管理登入與 Source/Secret 名稱讀取已成功；七表 metadata-only canary 已依核准完成，Source version 4，單次 SUCCESS、7 Dataset／88 欄位含本次 runId 已讀回；不冒充 Discovery／Grafana／Agent E2E。

- [x] 定位恢復後 MSSQL 版本／instance／AdventureWorks2019／SalesDatamart；原部署不接管或覆寫其他物件。證據見環境文件、ETL receipts 與隔離回復報告。
- [x] 盤點七個 Sales／Production 候選 tables 的聚合範圍／筆數／日期／狀態／CurrencyRateID及key／orphan checks；必要欄位與PII排除仍由ETL schema契約另定。
- [x] 已界定本次靜態還原樣本／單次人工執行與 native SQL timeout 30 秒、login 5 秒；未啟 snapshot isolation／Query Store／profiling。分次讀取不宣稱跨表 snapshot 一致性；ETL 有界執行缺口留 DM04 補，不冒稱已具備。
- [x] 已定位 Grafana :3000／org1／13.1.2；本案 folder `dataflow-discovery`、datasource `dataflow-salesdatamart`、dashboard `dataflow-sales-v1` 已定，舊資產不接管；實際部署／碰撞檢查與查詢屬 DM05。
- [x] 核對本機 backup 並完成 restore；恢復後資料放入 named volume。兩庫新 COPY_ONLY 備份已在隔離 named volume 還原、驗 checksum／physical CHECKDB／資料／DB 權限，重建同 SID 的三個必要登入後真登入通過；不宣稱 master／jobs／原密碼完整還原。見 `recovery-drill-20260914T040138Z-15381e52-verified.json`。
- [x] source reader／loader／Grafana reader 權限與負例已核；native canary 證明現有 Source/Sink Secret refs 可用，未另讀值或改密碼。可信 operator／原生 Actions 持有寫入能力，不交給 Agent runtime。
- [x] SQL image digest、Core／CLI、Grafana／driver 版本及既有原生擴充點已記錄；平台實際相容性另由 DM02 驗，Grafana 部署由 DM05 驗，不以版本字串替代。
- [x] 已界定本案 Host root／九檔 source allowlist 及模型 privacy 核准：ETL／SQL／無秘密 BI 設定與 metadata，不送資料列／秘密／其他 source，不新增 provider。真 Agent 接線留 discovery-skill／DM07，不再拖住環境里程碑。

完成證據：非秘密環境、scope／權限／備份與操作批次見環境文件及隔離回復報告。DataHub Source `a513e611-5631-4cf2-8b96-3fa9fd1fee51` 核准前為 version 3／開 profiling；目前已為 version 4／七表 metadata-only。七表、30 秒 query timeout、停用 profiling／stateful deletion 的 canary 提案 hash `37002133b89a16959e7360e7caeb5041f73077b5ef61010d598d915e8b58be86` 已離線驗 SDK config／allowlist，**已依限定核准完成 Source conditional 更新、唯一 execution `597819ae…` SUCCESS、7 Dataset／88 欄位讀回**。DM01 已結案；其餘相容性／整合依下列 task 驗收。

### DM02 — 星型模型、指標與官方擴充點相容性

最新：[DM02 模型／Grafana 模板修正與離線相容性](verification/dataflow-discovery-dm02-compatibility.md)。19 tests PASS 是原生 connector 的 fixture/file-sink 與分析器測試，**不是 live SQL／column lineage／發布驗收**。原 panel 無 datasource 會產生無 inputs 的 Charts 已重現；缺 Catalog graph 的 datasource fallback 明確不算成功。專用 Grafana 已完成建立與 v1→v2 條件更新／讀回；真 browser matrix 8場景全部通過。精確數值為75284 facts／17489 orders／178425 quantity／72418506.319091 amount／4140.803152 AOV。仍缺的是 DataHub 主線相容性，不是 Grafana 登入或外觀。

- [x] 完成四個 dims＋`fact_sales_order_line` DDL 設計：粒度、surrogate/business keys、唯一鍵、外鍵、decimal、索引、Type 1 與合法 unknown member；已依實際 DDL 核對，建置／ETL 負例另屬 DM03／DM04。
- [x] 已在`metadata/metrics.md`／實際ETL與Grafana定義sales amount／quantity／distinct orders／AOV、日期／狀態／local-currency／rounding／容差，不重複Header稅運費或誤加distinct指標。
- [x] reporting view、四類七panels、filters與期望值已定義並真SQL／browser對帳；必要空日期／篩選負例已驗，完整來源品質負例另列data-safety。
- [ ] 最小真canary **部分已驗**：1 DataFlow／3 DataJobs／13 direct SQL input-output／Flow包含及原生UI/reload已過。Job依賴與Chart／Dashboard原生metadata部分尚缺，不勾整項。
- [ ] 驗固定版 Grafana connector 的 MSSQL datasource mapping、per-panel Dataset、macro SQL、欄位解析與 URN 對齊，不以 basic fallback 當成功。2026-09-15原生schema多產12欄；使用者另准既有插件內最小修正後，adapter以官方SQL投影將7個schema由26欄、Chart由27引用均修正為14。recorded Catalog離線核對通過（12 PASS＋1原生已知expected failure）；未做live ingestion／部署／發布，未改Core或SDK。見DM02 verification。
- [ ] 驗 run 紀錄／ACL／版本／Task-Decision 關聯，以及所需 Aspect patch／conditional writes 與人工 metadata 保護；缺口明列，不新增狀態庫。

完成證據：核准模型／指標契約、真公開 API 讀回與原生 UI 導覽。非全量業務載入；不將 canary 當最終 E2E。

### DM03 — Datamart 建置程式與目標建立

- [x] 交付版本化 SQL DDL、views、必要索引及最小權限配置範本；DDL 與日常 ETL 分開。
- [ ] 隔離測試建置、重複執行拒絕／安全處理、既有同名物件保護與非法 schema 情境。
- [x] `SalesDatamart`、`dm`、`reporting` 及必要物件已依核准建立、真讀回並完成後續備份／隔離回復。
- [x] source／Grafana／loader 權限負例已核，來源 before/after 一致；見隔離回復的 ACL 證據。

完成證據：真 schema／keys／privileges、來源保持證據及建置 receipt；不刪庫驗回滾。

### DM04 — Python ETL coding 與真資料驗證

- [ ] 實作有界 extract、dimensions Type 1／穩定 keys、fact 範圍載入、commit 前 validate 三個 logical jobs。
- [ ] 交付已固定依賴、無秘密設定範本、版本／digest、執行與停止行為說明。
- [ ] 加入可重跑測試：decimal／rounding、合法 NULL／unknown、orphan、duplicate、粒度／fan-out、空來源、範圍縮小不誤刪。
- [ ] 實作目標 transaction，重跑不重複、失敗 rollback／保留舊資料，禁止平行重複寫入；不新增 worker 或 watermark state store。
- [x] 經核准執行真擷取／載入，以相同 scope 對帳：75,284 facts／17,489 orders／quantity 178,425／金額 72,418,506.319091／AOV 4140.803152。
- [x] 正常、rerun、before_commit rollback 三份真 receipts 已有；同輸入不重複、rollback 保留舊 rows／金額，不盲目重播。

完成證據：真 SQL／Python 結果、來源／目標對帳及失敗恢復；只產生 SQL／metadata 不算完成。

### DM05 — Grafana 真 dashboard／charts

- [x] 交付無秘密版本化 dashboard JSON、七 panel SQL、datasource／folder 設定；現已部署。
- [x] 經核准建立本案三資產，UID固定、datasource非預設；dashboard現v2，v1備份保留，未改其他專案資產。
- [x] KPI／每月趨勢／商品分類／區域銷售四類七panels真查詢與數值已驗；首月座標落在範圍外的問題已修。
- [x] 原生All／單選／多選／組合／歷史日期／空日期共8場景PASS，空聚合NULL與0分開；非USD宣告。這不是來源中所有NULL／unknown資料變體的驗收。
- [ ] 真browser／SQL對帳與匿名401已過，既有SQL reader最小權限證據沿用；authenticated non-owner／完整folder-datasource權限邊界尚缺。使用者要求停止額外UI精修。

完成證據：實際 dashboard／panel identifiers、查詢數值及瀏覽器操作；不只靜態 JSON。

### discovery-skill — 唯讀 snapshot 與 DataFlow Discovery 分析

已交付[snapshot library](verification/dataflow-discovery-snapshot.md)、SKILL.md、Host／validator、Git commit/dirty及[真Agent唯讀入口](verification/dataflow-discovery-agent-readonly.md)。九檔485候選／46unresolved與工具／模型／reload結果一致；完整欄位語義及後加Python分析仍由discovery-validator整合，不再說Skill只有snapshot文件。

- [x] 有界唯讀 snapshot、allowlist、敏感檔／symlink防護、file／snapshot digest、可用commit及dirty標記已實作並驗證。
- [ ] 實作 Skill 指引與必要的真工具接線；從實際 Python ETL／SQL／schema／Grafana 設定探索 I/O、process、必要呼叫鏈、型別、欄位轉換與消費關係，不只有提示文件。
- [x] 已定義中立assets／processes／types／relationships／field mappings／governance proposals／evidence／unresolved，並綁candidate digest、scope、定位及analysis version；不等同完整語義正確。
- [ ] 通用 Skill／工具不 hardcode AdventureWorks／SalesDatamart table名、公式或關係清單；案例名稱只在ETL／案例設定，不把golden mapping餵給Skill冒充分析。
- [ ] 明列本版Python／SQL／MSSQL／Grafana支援語法／API與限制；generated欄位不虛構來源、call graph不等同lineage、動態未知不猜測。
- [ ] 驗真資料流分析輸入／工具／候選與安全負例，源碼／metadata註解不成指令，不執行待分析repository程式。

完成證據：真Skill分析receipt與候選、證據定位、source-bound digest及安全正負例。不是任意Python全框架通用宣稱。

### discovery-validator — Host 驗證與非 hardcode 證據

- [ ] 驗候選格式、snapshot／file／candidate版本、證據位置／有效性、URN／schema／scope、方向／欄位映射及既有Catalog衝突。
- [ ] 用獨立可重跑檢查驗語義，不將同LLM自我確認、schema-valid／digest相符或parser confidence當整體正確率；靜態支持與真run成功分開。
- [ ] 技術lineage與治理候選分開preview／核准；未解析／缺證據項不得自動發布正式可信lineage。
- [ ] Golden預期與分析輸入分離；有界改名／轉換修改應改變結果，舊證據／偽造位置／動態未知必須拒絕或unresolved。
- [ ] 驗合法候選能進發布preview、非法候選被拒，必要欄位缺口不以手寫mapping或table-only fallback補成完成。

完成證據：真候選驗證與preview、獨立預期及變更／負例結果，證明不是靜態答案表。通用Host不耦合案例名稱。

### DM06 — DataHub metadata／lineage／語義發布

- [x] 官方MSSQL native來源／target canaries已完成：13datasets／149欄與view 24欄位lineage讀回；重整後列catalog-native，不再重做。
- [ ] 以公開 SDK/API 建 DataFlow、三 DataJobs、所屬／相依／input-output；run 綁定真版本、scope、擷取時間及資料提交結果。
- [ ] 使用 DataFlow Discovery 已驗候選，核對Python欄位mapping、generated來源說明、SQL parser結果與證據digest，經人工核准發布；手寫mapping只在測試作獨立預期。
- [ ] 先 preview，再分別核准技術 lineage 與 domain／terms／tags／必要 properties；描述粒度、公式、Join、可加總性與 Type 1 限制。
- [ ] 指定 Aspect writer ownership，驗 metadata merge／conditional 更新，不覆寫人工內容／其他 edges。
- [ ] 用官方 Grafana connector ingest 真 dashboard，核對 `MSSQL view → panel query Dataset → Chart` 與 Dashboard 包含關係。
- [ ] 從 Grafana 指標追至 source columns，逐段核對 URN／欄位／方向／證據；列所有 unresolved，所需欄位鏈未全通不結案。
- [ ] 驗 metadata 發布部分失敗、schema／版本衝突、重跑去重、scope 縮小與人工內容保護；只補失敗階段，不重載已成功資料。

完成證據：真 API readback＋UI 關係、治理內容與權限；emit ack 不算完成。Join 不偽裝成 lineage。

### DM07 — Agent Discovery／固定 ETL 與可信人工核准

- [ ] 真Agent發起核准scope的DataFlow Discovery，查候選／evidence／unresolved／Host驗證結果／preview，提案metadata發布而非直接寫入。
- [ ] 檢查既有 Registry／Task／Decision／Host 能力；僅補Discovery與固定 ETL 單次入口的必要接線，非通用 shell runner。
- [ ] Agent 只提已登錄分析／ETL ID、版本與有界scope；可信Host綁actor／source／target／snapshot／candidate／ETL digest／期限並於提交前重驗。
- [ ] 實作查狀態／品質結果與 metadata refresh；不把 metadata ingestion 當業務 ETL 執行。
- [ ] 真正驗證非 owner／匿名／過期核准／版本漂移／任意 endpoint 或 SQL／重複提交拒絕，合法核准能成功。
- [ ] 驗停止與程序失聯：不把關閉 Task 當停止、不以 UNKNOWN 當失敗可重跑；對帳後再決定恢復。
- [ ] 經授權重新配置可用的唯讀 DataHub MCP；只有必要 entity／relationship 缺口才補公開 API adapter，秘密不進 runtime。

完成證據：真 Agent 操作→可信核准→固定 ETL→讀回結果，包含拒絕與成功路徑。

### DM08 — Agent／WebUI 查詢全鏈路與語義

- [ ] 真 Agent 列 DataFlow／Jobs／輸入／輸出及最新 run／資料時間，附可驗 URN。
- [ ] 真 Agent 從 Chart 銷售額追到 MSSQL 來源欄位，回答 UnitPrice 影響範圍與客單價／聚合限制。
- [ ] 真 DataHub WebUI 查上述五類 entities、schema／lineage／terms，並開啟 Grafana 真 dashboard。
- [ ] 原生 UI 無法單頁呈現時先驗導覽完整性，僅必要時補既有 MFE 關係摘要，不新增圖譜平台。
- [ ] 驗未授權／不存在／metadata 過舊／缺欄位證據時的明確限制，回答不洩漏資料、不猜關係。

完成證據：實際入口、工具呼叫、API 對帳與瀏覽器結果；不能拿 developer CLI／fixture 替代。

### DM09 — 整合验收與交付

- [ ] 重跑整條真閉環：核准 ETL → Datamart 資料對帳 → Grafana 數值；真 DataFlow Discovery → 候選／證據 → Host驗證 → 人工核准 → metadata／語義發布讀回 → Agent／WebUI 關係查詢。
- [ ] 最終來源上核對Skill真工具結果、snapshot安全負例、獨立golden及同資料流變更測試，不hardcode，不把首例通過延伸為全語言能力。
- [ ] 在最終 source 狀態核對所有上述正負例；重用有效證據，僅受影響檢查重跑。
- [ ] 完成 Datamart 隔離備份／回復驗證、ETL／dashboard 版本回復及 metadata 部分失敗操作說明；不破壞來源／歷史。
- [ ] scoped LSP／必要 tests／build、最終 lens all、固定版本與 Core clean；空 diagnostic cache 不當全專案通過。
- [ ] 更新交付 README、非秘密設定範本、實際 scope／已知限制／權限／runbook，敏感 raw evidence 只留 gitignored `.local/`。
- [ ] 建立最終驗收紀錄，逐項附來源版本與證據；自查明示非獨立審查。原 `TODO-dc390fa8` 因轉接已關閉；所有必要項通過才可將承接任務 `TODO-09b76307` 標為完成。

## 2026-09-15 本地審核接點進展（歷史）

此段是最初33tests時的歷史，不代表目前仍無admission／conditional writer。最新模型0.1.3、一次admission／native CAS／source callback已本地實作，見[盤點](verification/datahub-progress-inventory-20260919.md)及[publication證據](verification/dataflow-discovery-publication-review.md)；production接線／部署仍未完成。

已另准的既有 models／Host 最小演進：LINEAGE／SEMANTIC 分開 review、來源／候選／實際 Aspect 值與版本／expiry digest、拒一般 RESPOND 升格、既有人工對話框與 CAS/history 相容。33 Host/runtime＋22 publisher tests、生成模型／Chromium fixture 通過；`0.1.2` 未部署，draft publisher 未啟用。真來源編譯 caller、一次 admission／目標 ACL／owned-aspect CAS／讀回仍缺，見 [證據](verification/dataflow-discovery-publication-review.md)。沒有重播已成功的外部操作。

## 未解事項與停止條件

- DM01 的來源恢復／scope／權限／備份／Secret refs 已驗，不再列舊阻擋。Grafana目標／測試登入及模型source隱私方向已答，不重問；本批 Grafana 三資產與 dashboard v2 已部署／實測，登入交付已解；後續新增 DataHub Source／metadata、權限或 token 操作另需具體批准。
- 不以hardcode mapping、純文件Skill、刪除Discovery範圍或新增datastore掩蓋阻擋；必要證據不足維持未完成。
- 沒有安全的一致擷取、所需官方 ACL／版本／恢復契約或正確 lineage 支援時，列具體缺口讓使用者決定，不自動建 datastore、降權限或改 Core。
- 明確區分資料成功、metadata 成功、Grafana 成功、Agent／UI 成功；部分結果不能叫完整交付。
- 本版不加入 scheduler；舊 T06／T07 排程及其他未完成驗收仍保留在原清單，不搬入本版假裝必建前置。

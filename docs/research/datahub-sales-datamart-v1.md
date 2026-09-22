# DataFlow Discovery／銷售 Datamart／Grafana／DataHub 設計 v1

設計日期：2026-09-13；狀態更新：2026-09-19。**Datamart／ETL／Grafana、原生Catalog／Flow／Jobs canary及真Agent唯讀Discovery已有實際成果；完整欄位／治理發布與可信操作閉環未完成。** Goal已依使用者要求完成盤點及原生任務重整，讀回running／10 of18 complete／current discovery-validator；現況與原要求移轉見[整案盤點](../verification/datahub-progress-inventory-20260919.md)。下文的設計要求不因盤點而減少。

使用者先核准四項業務方案，後明確修正：必須包含 IPO Skill，銷售 Datamart 只是第一條驗證資料流，不是 hardcode 產品。Skill 正式命名 **DataFlow Discovery（資料流探索）**，ID `dataflow-discovery`。原生 pi-goal-x Goal：`mtzxzwn6-1zw7vn`，主 agent 獨自開發與驗證，不使用 team-flow／subagent。

- 執行清單：[Datamart TODO](../datahub-sales-datamart-todo.md)。
- 既有平台：[Agent TODO](../datahub-agent-todo.md)，母任務 `TODO-a2daa81d`；T06／T07 未完成事項保留，不以新方案追認結案。

## 1. 已核准的結果與邊界

| 決策 | 核准內容 |
| --- | --- |
| 題材 | AdventureWorks 銷售訂單明細；四個 dimensions、一個 fact |
| 儲存 | 在既有測試 MSSQL instance 建立獨立 `SalesDatamart` database，來源唯讀，只對新 Datamart 寫入 |
| BI | 使用既有 Grafana，新增本案專用 folder、MSSQL datasource、dashboard，不影響其他專案 |
| 操作 | 單次執行；每次寫入操作／明確操作批次經人工核准，首版不加入排程 |

完成線：實際撰寫並執行 Python ETL、建立並載入星型 Datamart、Grafana 真查詢及圖表；由 DataFlow Discovery 分析實際程式碼、SQL 與 BI 設定，產生可追溯候選，經 Host 驗證、人工核准後將 metadata、lineage 與語義匯入 DataHub。真 Agent 及 WebUI 可查 DataFlow、DataJob、Dataset、Chart、Dashboard 關係；Agent 可發起有界分析、查候選與 preview，並提案固定 ETL 執行及 metadata 發布。所有寫入仍經可信人工核准。

### 與既有約束的關係

- `SalesDatamart` 是本次明確核准的業務分析 database，是「不新增 datastore」原則的**限定業務資料例外**；不是新增 Extension 狀態庫，也不授權建立第二套任務／Source／Secret 狀態權威。
- 不新增 MSSQL server、PostgreSQL、Redis、worker、scheduler、outbox 或其他 datastore；DataHub 與 Pi 既有儲存保持。
- Core 固定 `v1.7.0.1`、CLI／SDK 基準 `1.7.0.9`。僅用官方 Entity／Aspect／公開 API 與插件／Host adapter，不修改 Core。
- Goal 已授權主 agent 開發及驗證；外部操作仍須核對具體 server/database、寫入批次、身分、備份與影響。auto-continue 不代表已取得任何秘密或能任意重啟／部署；按具體目標取得必要核准。
- main-agent-only，僅原生 pi-goal-x；不派子代理、不使用 team-flow／mission／watchdog／auditor child／其他控制器，不 commit／push。自查不稱獨立審查。

### 非目標

第一版不承諾任意語言／Python 框架的完整分析；**DataFlow Discovery 本身屬於交付範圍**，先支援本次 Python／SQL／MSSQL／Grafana 已用模式，未知模式明列 unresolved／不支援。不預建尚未使用的 API／queue／file 分析器。其他非目標：跨來源 federation、CDC／增量 watermark 框架、SCD Type 2、通用 Semantic Server、全新任務平台、排程、Agent 自主修改 ETL／DDL／指標、任意 SQL 寫入。不接入其他專案資料庫。

## 2. 資料與控制架構

```text
AdventureWorks2019〔核准來源 tables，唯讀〕
  → Python sales_datamart〔DataFlow〕
      load_dimensions → load_sales_fact → validate_datamart〔DataJobs〕
  → SalesDatamart.dm〔dimensions + fact〕
  → SalesDatamart.reporting〔views + 固定指標查詢〕
  → Grafana MSSQL datasource → panels → dashboard

DataFlow Discovery：唯讀 snapshot → 程式碼／SQL／BI 分析 → 候選＋證據
可信 Host：候選驗證／Catalog 對照 → preview → 人工核准 → 發布 → 讀回
可信 Host 執行：身分／scope → preview → 人工核准 → 固定 ETL → 結果對帳
DataHub：metadata、lineage、語義、執行／審核紀錄
Agent：有界探索、查詢及操作提案；不持有來源／write credential
```

Grafana 直接查 MSSQL，DataHub 不搬運或提供銷售資料列。DataFlow 是 pipeline 定義，不是 scheduler；DataJob 是 logical step，不必拆成獨立程序。

### 2.1 DataFlow Discovery 與案例的分界

| 層次 | 責任 | 不得混用 |
| --- | --- | --- |
| 本案 ETL／案例設定 | 銷售公式、source／target tables、欄位、範圍、Grafana UID／SQL | 這是實際業務程式，不是分析答案表 |
| Discovery Skill／工具 | 從已核准輸入分析 I/O、process、型別、欄位轉換與 consumer | 不以 AdventureWorks 名称分支，不內建固定 lineage |
| Host validator／publisher | 核證據、URN／schema、方向、衝突、政策與核准，再轉官方模型 | 不信任 LLM 任意 Aspect、endpoint 或自報成功 |
| 驗收 golden／負例 | 獨立預期結果與有界程式變更，衡量分析輸出 | 不把 golden mapping 當 Skill 輸入後冒充探索 |

### 2.2 唯讀 snapshot、候選與證據

- Host 只開放核准 source root／檔案 allowlist；排除秘密、敏感資料、依賴／生成雜訊與越界 symlink。取得 file／snapshot digest、可用 commit、scope及檔案位置；dirty source 標明，不捏造 commit。
- Snapshot 是不可變分析輸入／證據，不是新增業務狀態資料庫。模型可分析的 source 範圍與隱私政策需先確認；不得把私人程式碼發往新 provider。只分析，不執行 repository 程式／安裝腳本。
- 中立候選區分 assets、processes、types、I/O、data relationships、field mappings、governance proposals、evidence及unresolved。每筆關係引用真檔案／位置／digest與scope，候選集綁 candidate digest／分析版本。
- 結果區分已解析、推論與不可判定，保留方法及限制，不把 LLM 自報 confidence 或 SQL parser confidence 當整體正確率。
- Generated date／surrogate key 不虛構上游欄位；呼叫圖不自動等於資料 lineage；Join／包含／執行相依／資料流各有不同語義。

### 2.3 首版支援模式與驗證責任

| 輸入 | 首版應完成的實際能力 | 限制與驗證 |
| --- | --- | --- |
| Python ETL | 分析實際 extract／transform／load、必要呼叫鏈及型別／欄位傳遞，重用現有解析能力 | 先列支援語法／資料API；動態反射／無法定位名稱不可猜測，不宣稱任意Python皆支援 |
| SQL／MSSQL schema | 用官方 SQL parser 取得 tables／columns／轉換，與實際 schema、scope及URN核對 | parser限制／filter依賴／Join條件另外保留，fallback不當欄位成功 |
| Grafana 設定 | 分析 datasource identity、panel SQL、query output、Chart／Dashboard消費與包含 | macro／template／panel-side transformation 需驗，不直接把UID當資料表 |
| 業務語義 | 由公式、型別、版本化指標說明提出 glossary／domain／tag／property 候選 | 技術通過不等於業務核准；人工確認語意與可加總性 |

Skill 必須有實際工具與 Host 接線，不能只寫一份提示文件。Host 以獨立可重跑檢查驗證證據有效性、候選格式、URN／schema、欄位方向／映射、Catalog 衝突與發布政策。Schema-valid／digest相同只證明格式／版本，不證明語義正確；同一模型自我確認不作確定性驗證。

先以本次真 ETL／SQL／Grafana 正向分析，再以有界改名／轉換修改、偽造或過舊證據、動態未知等負例證明非 hardcode。所需欄位關係缺證據時不發布成正式可信 lineage；保留 unresolved 並回報缺口，不回退成手寫答案取代 Skill。靜態支持與實際 run 結果分開保存。

## 3. 來源範圍與環境待查事項

候選來源（2026-09-14 恢復後已核對存在、可讀及聚合範圍；完整 schema／權限證據見環境文件）：

- `Sales.SalesOrderHeader`、`Sales.SalesOrderDetail`、`Sales.Customer`、`Sales.SalesTerritory`。
- `Production.Product`、`Production.ProductSubcategory`、`Production.ProductCategory`。
- 日期維度由核准日期區間生成，不新增外部來源。

先確認 MSSQL 版本、database／schema、上述 allowlist、資料量、日期範圍、訂單狀態、幣別及可接受查詢負載／時段。不沿用 metadata-only 授權推定可讀所有業務欄位；新 ETL 只讀核准必要欄位，客戶不取姓名／地址等 PII。

既有驗證只涵蓋部分 Person／HumanResources metadata。2026-09-14 已用既有 Microsoft AdventureWorks2019 backup，透過固定 SQL Server 2019 image 還原至 `wferp-mssql-test` 的 named volume；`host.docker.internal:14334` 可由 DataHub Actions 容器連線。七個 candidate tables 的筆數、日期、key／orphan、讀取帳號權限已核對；未建立已移除的 `wferp_test`／WFERP tables。Grafana已定位localhost:3000／13.1.2／org1，另准批次已建立三個專用資產、更新dashboard v2並完成真查詢。DataHub Source/Secret bindings與兩個MSSQL native canaries、SalesDatamart建置、ETL初載／重跑／rollback已有證據；不是整體Discovery發布驗收。使用者已允許既有模型分析本案新寫ETL／SQL／無秘密Grafana設定／核准metadata，排除資料列／秘密／其他source。詳見 [環境盤點](../verification/dataflow-discovery-environment.md)，不重問已答決策。

## 4. 星型模型

| 物件 | 粒度／鍵值 | 來源與內容 |
| --- | --- | --- |
| `dm.dim_date` | 每日期一列；穩定 date key | 年／季／月／日等，日期口徑固定 |
| `dm.dim_product` | 每商品一列；surrogate key，來源 ProductID 唯一 | 商品、分類／子分類；不依執行順序重編既有 key |
| `dm.dim_customer` | 每客戶一列；surrogate key，來源 CustomerID 唯一 | 最小必要非 PII 屬性 |
| `dm.dim_territory` | 每區域一列；surrogate key，來源 TerritoryID 唯一 | 區域名稱、國家／群組等核准屬性 |
| `dm.fact_sales_order_line` | 每訂單明細一列；來源 SalesOrderID + SalesOrderDetailID 唯一 | OrderDateKey、ProductKey、CustomerKey、TerritoryKey、OrderQty、UnitPrice、UnitPriceDiscount、LineNetAmount |

維度首版為 Type 1，不聲稱歷史屬性追溯。保存來源 business keys；外鍵、唯一鍵與必要索引落在 Datamart，不直接修改來源。來源合法 NULL（例如缺分類／區域）與不合法 orphan 分開：前者依明訂 unknown-member 語義處理，後者阻擋載入，不悄悄補配對。

各 Join 明定 keys、方向、基數、NULL 與有效範圍；驗證 dimension 唯一性，避免 fan-out。Header 屬性透過 SalesOrderID 取得，不將 Header 金額重複加總。

### 指標與查詢契約

| 指標 | 定義與限制 |
| --- | --- |
| 明細淨額 | OrderQty × UnitPrice × (1 − UnitPriceDiscount)，與來源 LineTotal 依確認精度對帳 |
| 訂單銷售額 | 明細淨額加總，不含稅／運費；不是已收款或會計收入 |
| 銷售數量 | OrderQty 加總；說明不同產品單位的比較限制 |
| 訂單數 | 查詢範圍內 distinct SalesOrderID；不可相加跨商品分類的小計 |
| 客單價 | 銷售額 ÷ 範圍內 distinct 訂單數；分母零為 NULL，不平均各群組客單價 |

使用 decimal，不以 float 計算金額；precision、rounding、對帳容差在來源盤點後明定，不以任意寬容差吞錯。訂單狀態、日期、幣別在載入範圍及所有 panel 一致；幣別未證明一致前不得混加。

`reporting.v_sales_order_line`（預定名稱）提供一致 Join、欄位與明細公式；固定版本的 panel SQL 在使用者篩選範圍計算聚合。其他必要 views 依真查詢需求增加，不預建大量彙總表。

## 5. Python ETL 與執行安全

### 載入流程

1. 固定 ETL 版本／digest、來源範圍與 target；唯讀擷取核准資料。
2. 記錄擷取起訖及一致性條件；是否可使用 snapshot isolation 先查現況，不自行開啟資料庫設定。若無一致快照，採經核准靜止資料／時段或回報限制，不能宣稱跨表一致。
3. 檢查來源鍵、必填、數值、合法 NULL 及 dimension 唯一性。
4. 在目標單一 transaction 更新 Type 1 dimensions、載入該範圍 fact，穩定保留 dimension keys。
5. 在 commit 前檢查唯一鍵／外鍵、筆數、範圍、金額及來源對帳；`validate_datamart` 是此提交前 logical job。
6. 全部通過才 commit；失敗 rollback，上次可用資料仍保留。空樣本不得冒充驗證成功。
7. 記錄 commit 結果與 DataHub run，讀回／對帳；程序結束回收連線與秘密。

首版有界全量快照，不維護增量 watermark。相同輸入重跑不重複累加；範圍縮小或掃描失敗不得自動刪除舊範圍。DDL 首次建置與日常 ETL 分開；不在每次執行時 drop/recreate database。

### 固定執行入口

- 可信 Host 單次執行本案已登錄 Python package；沿用既有 Host／Task／Decision 接線，先證明所需能力再補缺口。
- 既有 `datahub_ingestion` 僅管理 metadata ingestion，不改成任意 Python／shell runner，不假稱原生 Certified Executor 已能執行此 ETL。
- Agent 只能提交固定 ETL ID、版本與有界 scope；不能提供任意 endpoint、檔案路徑、SQL、shell、環境變數或 credential。
- 人工核准綁定 actor、source／target、ETL digest、參數範圍、有效期限；提交前重新授權與驗版本。重複提交不產生平行副本；目標單次寫入限制與舊執行提交防護須實測，不另建工作資料库。
- 程序失聯／提交結果不明時標示 UNKNOWN／待對帳，不自動重播 DML。停止請求不等於 rollback 或已停止。
- 初始 timeout／並行上限僅為待確認預算，依來源負責人核准負載實施。

### 身分與秘密

來源 ETL 帳號僅 SELECT 核准欄位／表；target loader 僅本 Datamart 必要 DML，DDL 用獨立受控建置身分；Grafana 帳號僅 SELECT reporting views。Grafana 共用 datasource 身分不等於每位 viewer 的個別 MSSQL 授權，首版限定核准且無 PII 的共同資料範圍，並驗 org／folder／datasource 權限。

來源密碼、Grafana service credential、DataHub write token 只在可信控制面，不能進 Agent runtime、chat、普通 Aspect、repository 或日誌。唯讀 metadata ACL 不等於 SQL 權限。原 MCP Reader 短效 token 已到期，真 Agent 驗收前需經授權重新配置，不自動续期。

## 6. DataHub metadata、lineage 與語義

### 資產與關係

| 實體 | 官方模型／關係 |
| --- | --- |
| Python pipeline | DataFlow，真實 Python／custom 平台標識，不假裝 Airflow |
| 三個 logical jobs | DataJob、所屬 DataFlow、job 相依 |
| Source／dm tables／reporting views | Dataset + schemaMetadata |
| Job 讀取／產出 | dataJobInputOutput；驗證 job 只讀，不捏造輸出 table |
| 資料與欄位流 | upstreamLineage、fineGrainedLineages；單獨保留 transformation 與證據 |
| Grafana panel query | 官方 connector 建立的每 panel 邏輯 Dataset，不是另一張實體 SQL table |
| Panel／dashboard | Chart inputs；DashboardInfo.charts 包含關係 |
| 執行事實 | 優先官方 DataProcessInstance／run 相關公開契約，與既有 Task／Decision 關聯；實際 ACL／版本／查詢先驗 |

```text
來源欄位 → ETL 轉換 → dm 欄位 → reporting 欄位
  → Grafana panel query Dataset → Chart
Dashboard 包含 Chart；DataFlow 包含 DataJob
DataJob input/output 指向 source／dm Dataset
```

包含、Job 執行相依、資料流、Join 是不同關係，不為了畫成單一路徑而混用。型別來自真 schema，不將型別建成 table。

### 來源與證據

- MSSQL connector：實際 source／target schema 與 view SQL lineage。
- Python：DataFlow Discovery 分析真 ETL，輸出有來源定位的欄位 mapping 候選，經 Host 驗證並綁定實際版本；手寫 mapping 僅作獨立 golden 預期，不取代分析。產生 date／surrogate key 的欄位標示 generated，不虛構上游欄位。
- SQL：官方 `DataHubGraph.parse_sql_lineage()`，核對實際 URNs、欄位與方向；parser confidence 不等於整體正確率。
- Grafana：使用實際 panel SQL／UID；時間 macro／template variables 與 MSSQL dialect 必須真驗，解析失敗的 fallback 不算完整欄位證據。避免未分析的 panel-side transformations；確有需要時納入 mapping 與數值測試。
- 保存程式 commit（若已有）及 source digest、SQL／dashboard digest、scope、觀測時間與工具版本；未 commit 不捏造 commit。記錄 source schema 及 ETL 版本與 run 的關聯，不把靜態 mapping 當執行成功。

URN 沿用本次核對後選定的現有 source instance，不複製過去 canary instance。固定 source／target platform instance、database、env、Grafana org／datasource UID／dashboard UID／panel ID，核對大小寫與完整欄位路徑。

### 語義層

- Domain：Sales Analytics。
- Glossary Terms：訂單、明細、客戶、商品、區域、銷售額、訂單數、客單價。
- Dataset／欄位：粒度、來源、公式、單位、可加總性、日期／狀態／幣別、Type 1 限制、Join keys 與基數。
- Tags／必要 Structured Properties：資產角色、資料分類、更新模式；先重用現有定義，沒有實際用途不新增 property。
- Governance preview 與技術 lineage preview 分開確認，不能因 lineage 通過自動核准 business term。

DataHub 是語義目錄，reporting views／固定 SQL 是可執行語義；不宣稱 glossary 自動約束 Grafana SQL。完整複合 Join 條件優先用公開支持欄位／描述契約，不假裝 lineage 是可信 Join；若需機器可查詢而原生模型不足，先提出具體缺口，不自創 state store。

### 發布與跨系統對帳

先 ingest source／target schema，取得實際 ETL／SQL／Grafana snapshot；DataFlow Discovery 產生候選，Host 完成證據／Catalog 驗證與 preview，技術及治理分別核准後發布 DataFlow／Jobs／ETL lineage／語義，並以官方 connector ingest 已建立的 Grafana。官方既有 metadata 與候選發布責任分開，不重複造資產。先做最小真 compatibility canary，確認公開 API、欄位讀回及原生 UI。

指定每種 Aspect 的 writer ownership；ingestion 與 ETL publisher 不各自覆寫同一 upstreamLineage。優先官方 patch／conditional API，先讀現有內容、preview 差異，保留人工描述／terms／非本案 edges。若指定 Aspect 缺安全的並發更新方式，停止該發布並回報，不能假設通用 CAS／多 Aspect 原子性。

MSSQL commit、DataHub 發布與 Grafana 更新不是跨系統原子交易。分別記錄資料結果、metadata 結果、Grafana 結果；資料成功但發布失敗顯示「metadata 待對帳」，核對後只補該階段。不得為修 metadata 盲目重跑 ETL，也不新增 outbox。官方現有紀錄不足以安全恢復時是具體阻擋，不用本地 JSON 狀態庫補洞。

## 7. Grafana 與使用者入口

一個專用 dashboard，固定四類 panels：

1. KPI：訂單銷售額、訂單數、客單價。
2. 每月銷售趨勢。
3. 商品分類銷售。
4. 區域銷售。

固定共用日期範圍與必要區域／分類 filters，預設選有歷史資料的已載入區間，不使用「最近 6 小時」造成空圖。每個 panel 保存 SQL、指標 term、來源 view、datasource UID 與版本。對 filters、空資料、NULL、幣別／單位及金額顯示做真查詢與瀏覽器核對。

DataHub 原生頁面查 DataFlow／Job／Dataset／Chart／Dashboard、schema、lineage、glossary，連結 Grafana 真 dashboard。先驗原生導覽／完整關係查詢；必要時僅補既有 MFE 關係摘要，不另建圖譜 UI。

Agent 至少支援以下真問題並附可核對 URN／證據：

- 此 DataFlow 的 Jobs、輸入、輸出及最近執行结果為何？
- 此 Chart 的銷售額來自哪些 MSSQL 欄位？
- UnitPrice 改變影響哪些 views、Charts、Dashboard？
- 客單價公式、粒度、聚合限制及資料截至何時？
- 在核准 scope 發起 DataFlow Discovery，查候選、證據、unresolved、驗證結果與發布 preview，再請可信人工核准。
- 經可信人工核准執行固定 ETL，查狀態，再核准 metadata refresh。

現有 MCP 缺少必要 entity／relation 查詢時只補公開 API adapter；Catalog／metadata 外部文字不構成指令。不存在／未授權／過舊／未解析時如實回答，不補猜測。

## 8. 交付結構與驗收

建議新增 `extensions/sales-datamart/`：Python ETL package、`sql/`（DDL／views／查詢）、`metadata/`（案例語義說明）、`grafana/`（無秘密 dashboard／provisioning 範本）與 tests。通用 Skill 與解析／候選驗證能力放 `extensions/dataflow-discovery/`，不與案例名稱耦合；Skill ID 為 `dataflow-discovery`。Host 接線留既有 `extensions/datahub-agent/integration/`。這些是版本化程式／定義，不是 runtime datastore；golden 僅在測試域，不作分析器輸入。實際模組名沿現有慣例決定，不預建空框架。

驗收必須同時有：

- 真 DB 唯一鍵／外鍵／精度／筆數／來源金額对帳，重跑無重複，失敗 rollback／旧資料可用。
- Grafana 真 datasource／SQL／filters／圖表與對帳數值一致。
- DataHub 所有本次範圍 assets／Jobs／table lineage、指標欄位映射／語義讀回與可見性，列明任何 unresolved；不能拿 table-only PASS 代替所需 column lineage。
- 真 DataFlow Discovery → 候選＋證據 → Host 驗證 → 可信人工核准 → 發布讀回，以及真 Agent → 可信核准 → 固定 ETL → 結果 → metadata 讀回 → WebUI 導覽閉環。
- Snapshot 安全負例、獨立 golden 預期、同資料流改名／轉換變更及動態未知負例，證明非 hardcode；分析結果不能只由同一模型自我背書。
- 權限拒絕、過期核准／版本漂移、重複提交、部分發布失敗／恢復、人工 metadata 保護、scope 縮小不誤刪。
- 新 Datamart 建置前的持久化／備份方案，交付前隔離回復檢查；不得在來源進行破壞性 restore。
- 固定 Core／CLI／Python依賴／ODBC driver／Grafana及相關 datasource 版本；Core clean。新模型需求若成立先確認，不預設必須擴充。

測試、HTTP 200、fixture 或 metadata emit 不等於以上 E2E。開發者自查標示非獨審。尚缺必要證據時保持未完成。

## 9. 依據與已知限制

固定 Core 原始碼：`upstream/datahub`，commit `e99431ec510d7a2001f815c6bf70913c493af76e`。

- [DataFlow／DataJob 官方指南](../../upstream/datahub/docs/api/tutorials/dataflow-datajob.md)。
- [Lineage 官方指南](../../upstream/datahub/docs/api/tutorials/lineage.md)。
- [SQL parser 邊界](../../upstream/datahub/docs/lineage/sql_parsing.md)。
- [Grafana connector 文件](../../upstream/datahub/metadata-ingestion/docs/sources/grafana/grafana_post.md)。
- [Grafana entity builder](../../upstream/datahub/metadata-ingestion/src/datahub/ingestion/source/grafana/entity_mcp_builder.py)：實際建立 Dashboard 與 Chart，Chart inputs 指向 per-panel Dataset。
- [Grafana lineage](../../upstream/datahub/metadata-ingestion/src/datahub/ingestion/source/grafana/lineage.py)：依 datasource UID mapping 解析 SQL；失敗有 basic fallback，不能當欄位 lineage 成功。
- [Grafana MSSQL 官方文件](https://grafana.com/docs/grafana/latest/datasources/mssql/)：支援直接查詢 SQL Server；最新網站內容不代表本機版本，部署前另核。
- [原生 ingestion 現場範圍](../verification/datahub-agent-native-ingestion.md)。

Grafana README 的概念表與 entity builder 有表述差異，本案以固定版程式為設計依據，仍須真 API／UI 驗證。此前 Kafka Connect 研究不是本版前置；DataFlow Discovery 則是本次已核准核心交付，先驗此條 Python／MSSQL／Grafana 流，不延伸宣稱任意專案相容。

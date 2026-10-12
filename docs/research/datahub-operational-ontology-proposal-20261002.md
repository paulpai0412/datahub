# DataHub × Pi Agent：Operational Ontology 產品與整合提案

日期：2026-10-02。狀態：**研究與設計建議，未實作、未安裝、未部署、未驗證新套件相容性**。

> **開發請改以 [Operational Ontology v1 實作設計](../design/datahub-operational-ontology-v1.md) 為準。** 使用者已確認 Temporal 為唯一主流程引擎、v1 不加 Tork、來源讀取沿用 metadata ACL，以及「證據 → 調查案件 → 指派／審核 → 外部 Action → 讀回」完成線。本文保留研究脈絡；與該規格不同的模型權威、runtime、政策選項不再是現行開發方向。
>
> 後續澄清：使用者指定以 DataHub metadata 為主體、借鏡 UML，並選擇「統一關係圖、保留不同語義」。[後續可行性評估](datahub-uml-ontology-runtime-evaluation-20261002.md)因此建議將模型定義／release 權威放在 DataHub 官方 metadata 擴充，新 store 承接物件／流程／行動狀態與唯讀衍生 cache。本文第 6 節原先「模型 registry 以新 store 為權威」的建議由該評估細化取代；兩份文件仍是研究提案，不是實作或部署批准。

## 0. 本次已確認的目標與邊界

使用者本次明確決定：

1. 以把「**業務物件、邏輯、行動、權限**」接在一起為產品目標，不只增加詞彙、知識圖譜或分析用 semantic layer。
2. **可增加 Ontology 所需的 datastore**。這是本次設計相對既有「不新增 datastore」規則的明確變更；不是安裝資料庫、搬移資料或寫入來源系統的操作批准。

其餘邊界維持：不修改 DataHub Core；以第一方插件、官方 Model／Aspect、MFE、Actions、Ingestion 與公開 API 整合；來源秘密由可信 Host 管理。新 store 不得成為來源業務欄位的第二個可任意覆寫權威，也不搬遷現有 Semantic 的原生 Task／Run／Decision。

本次檢查 current checkout、固定上游文件及既有驗證報告，沒有連入現場 DataHub／來源 DB／Grafana，沒有執行第三方 repo 程式。部署能力的敘述是有日期、有限範圍的歷史證據，不代表今日現場健康。

## 1. 結論

建議定位為：

> **以 DataHub 為治理底座、Ontology 為業務執行模型、Pi Agent 為協作入口的 AI 營運決策平台。**
>
> 從「資料在哪裡、代表什麼、如何流動」，走到「現在有哪些業務物件、可以做什麼、誰能做，以及做完結果如何」。

五項核心分工：

- **Semantic 管意義**：共用詞彙、定義、口徑、資產與欄位語義，以及有證據的維護。
- **DataFlow Discovery 管證據與依賴**：來源程式／SQL／ETL／API／BI 的資料依賴、轉換與可追溯證據。
- **Ontology 管業務模型與操作**：物件、關係、映射、可執行邏輯、具名行動、物件狀態與行動紀錄。
- **Query & Grafana 管計算與觀察**：受控資料查詢、聚合、視覺化與行動後成效觀察。
- **Pi Agent 管理解、提案與協作**：依意圖選擇上述能力；不是資料真相、批准者或業務交易引擎。

橫跨所有模組的 **Host／治理層**統一處理可信身分、授權、審核、執行邊界與稽核。這些是可共享的產品能力，不是五個各自制定權限的孤島。

**建議新增一個獨立 Ontology PostgreSQL 作起點，而不是先購建大型 graph stack。** 物件／關係可先以關聯表、JSONB 與索引承載；是否引入圖引擎由真實遍歷工作量決定。Operational Ontology 的難點是身分、語義、權限、狀態與外部效果一致性，不是畫出節點和連線。

## 2. Palantir 白皮書真正值得借鑑的內容

本次沒有假定存在某一份唯一名為「Ontology 白皮書」的文件，而是直接閱讀以下官方文件：

| 官方來源 | 查閱重點 | 本案應借鑑的設計 |
| --- | --- | --- |
| [Foundry Technical Overview][P1]，PDF 7 頁，尤其 pp.5–7 | Objects／Relations、Functions／Actions、決策捕捉、外部 writeback、scenario-aware workflows | Ontology 要有業務名詞與動詞；圖表不能替代操作閉環 |
| [Connecting AI and Machine Learning with Operations][P2]，2022，尤其 pp.3、10–15 | 模型綁定物件、受治理的應用、scenario、決策回寫與回饋 | 模型應透過固定型別與操作契約進入業務流程，不由提示詞直接控制來源 |
| [Privacy and Governance Whitepaper][P3]，2024，尤其 pp.8–16、23–24 | Ontology 的共同營運視圖、lineage、使用目的、細粒度權限、稽核敏感性 | 權限與稽核是整個資料／行動路徑的能力，不是只藏按鈕 |
| [The Ontology system][P4]，現行官方架構文件 | **Data／Logic／Action／Security**；Language／Engine／Toolchain | 區分宣告模型、真正的執行引擎、以及人和 Agent 使用的工具鏈 |
| [Core concepts][P5] | Object type 與 object、link type 與 link、action、function、interface | 定義與實例分開；不能把每筆訂單變成 DataHub Dataset |
| [Action webhooks][P6] | writeback 在物件修改之前；side effect 在之後；外部成功但 Ontology 修改失敗仍可能發生 | 即使 Palantir 也不提供任意跨系統原子交易保證；本案必須處理 UNKNOWN 與對帳 |

日期注意：[P1] URL 檔名含 `2022`，但 PDF 內版權為 2021；不據檔名捏造發布日期。

### 不照搬的部分

- 不把 Palantir 的整體架構簡化成「裝一個 RDF／Neo4j 就完成」。RDF／OWL 可用於交換、形式化建模與推論，並不是業務行動引擎的替代品。
- 不把 vendor 文件的效能、導入時間、完整安全或案例效益當成本案已證實成果。
- 「語義／動態／行動」是概念分解，不代表必須部署三個微服務。
- 不宣稱本案第一版是完整 Foundry／AIP 替代品；先建立可持續擴充的營運閉環。

## 3. 與本專案現況的對照

### 3.1 可重用基礎，不從零重造

| 現有模組 | 本次確認的基礎 | 必須保留的限制 |
| --- | --- | --- |
| DataHub Core | 固定 `v1.7.0.1`；官方 schema-first metadata、公開 API、模型插件、metadata events | metadata 平台不是業務列資料庫，也不是跨系統 transaction coordinator |
| Pi Agent／MFE／Host | `server.mjs` 統一接身分、Catalog、Semantic、Discovery、Query／Grafana；actor runtime 隔離 | skill 與模型文字不構成權限；產品 Pi SDK 固定版本不能和開發用 Pi 版本混同 |
| Semantic | Catalog 共用定義／資產關聯、精確差異、原生紀錄與 per-Aspect CAS；有真 Catalog 主線歷史證據 | 全範圍持續代管的真首輪及真正後續變更輪次仍未完成；不能當成熟全自動治理 |
| DataFlow Discovery | source-bound snapshot、靜態解析、Catalog binding、IR／證據、插件能力；2026-09-28 有真入口 ETL／Summary 分析證據 | 分析預覽不代表已發布、已執行 ETL、已證明業務關係；一般發布仍有缺口 |
| Query & Grafana | 現有 `createMetadataQueryHost` 真正核 metadata、編譯並執行來源查詢、重核可見性、回傳 resultRef；有兩個三表 Join／原生圖表真 E2E 歷史證據 | 同來源、受限結構化 SQL；不是任意 SQL／跨來源 federation；結果是短期顯示資料，不是持久物件庫 |
| Ontology | 本次新提案 | 尚無可宣稱已完成的物件引擎、業務 Action、物件層權限或情境模擬 |

原始碼與驗證依據見第 13 節。README 有部分較早的階段敘述；本表優先採現行程式及較新的專項驗證，不把所有歷史「未部署」或「已完成」混成同一時點。

### 3.2 三項最重要的責任區分

1. **DataHub ingestion ≠ 物件資料同步**：前者收 schema／metadata，後者才讀取授權業務列或事件，建立業務物件的投影。
2. **DataHub Actions ≠ Ontology Action Types**：前者可回應 metadata 事件；後者是「建立案件／指派人員／取消訂單」等正式業務操作。metadata event 不是業務操作批准。
3. **Semantic 的語義治理 ≠ 可執行 metric engine**：詞彙口徑提供定義，實際公式、粒度、輸入輸出與執行版本仍需機器可檢查的契約。現有 Semantic 不因名称而自動具備 Cube／MetricFlow 的能力。

## 4. 各模組的產品角色與禁止越界事項

| 模組 | 對使用者回答的問題 | 主責產物 | 不應負責 |
| --- | --- | --- | --- |
| **DataHub Catalog** | 有哪些資料、誰負責、schema 是什麼？ | Dataset／Field／Flow／Job／API／Chart／Dashboard 的 metadata、URN、provenance | 訂單、客戶等高基數業務實例與交易 |
| **DataHub Semantic** | 這些資料代表什麼？什麼口徑可信？ | Domain、Glossary、Tag、Structured Property、說明、證據與語義維護決策 | 重建物件資料庫、執行取消訂單、單憑名稱猜映射 |
| **DataFlow Discovery** | 資料如何取得、轉換與流動？證據在哪？ | 技術依賴、完整轉換／條件證據、覆蓋與未知、版本影響 | 把 lineage 當 Join、把技術相關當業務真相、執行被分析程式 |
| **Ontology** | 目前有哪些業務物件、如何關聯、允許哪些操作？ | 可執行型別／映射／函式／行動、物件投影、ontology-owned 狀態、決策與結果 | 取代 Catalog／Glossary、無條件把 source-backed 欄位當自己所有 |
| **Query** | 如何安全取得／計算答案？ | 授權後的 query plan、SQL／object-set 計算、結果與觀測時間 | 將任意 DML 開放給模型，或自動發明可信 Join |
| **Grafana** | 發生什麼、趨勢如何、操作後是否改善？ | 原生互動圖表、dashboard、量測結果 | 擔任業務寫入入口、保存授權真相、繞過 Host 查任意資料 |
| **Pi Agent** | 幫我查明、解釋、提案並完成被允許的工作 | 有引用的理解、候選計畫、工具調用、結果說明 | 自己批准、持來源秘密、以聊天歷史維持正式交易狀態 |
| **可信 Host／治理** | 誰可以在何時、對哪些版本、做哪些事？ | 身分、policy decision、approval、執行 admission、稽核與對帳 | 把這些責任交給 prompt、一般插件或 UI |

人員分工：Data engineer 維護連線／同步／技術 mapping；Data steward 與業務 owner 核定共用定義、物件粒度及關係；業務 operator 使用物件與行動；平台管理者維護權限、部署與故障恢復。Agent 輔助各角色，不代替其授權責任。

## 5. Ontology 新增什麼：最小但完整的模型

不是只新增一個 `Ontology` 名稱或畫面，至少要能表達下列契約。

| 元件 | 必須表達的內容 |
| --- | --- |
| **ObjectType／Object** | 例如 Order 型別與某一筆 Order；型別版本、identity、typed properties、生命週期、目前狀態 |
| **Property／Shared Property** | 型別、單位、精度、時區、敏感性、可空值、語義 Term URN、資料主責與來源證據 |
| **LinkType／Link** | 兩端型別、方向、基數、完整 keys／predicate、tenant／公司條件、有效期間、證據與適用範圍 |
| **Binding** | 精確 Dataset URN／fieldPath、來源 instance／database／schema、物件鍵、轉換、filter、schema／證據版本 |
| **Function／Model Binding** | typed inputs／outputs、核准邏輯或模型 artifact 版本、依賴、執行預算、結果新鮮度；函式預設無副作用 |
| **ActionType／Action Execution** | 具名業務操作、參數、對象、preconditions、權限／人審規則、版本前提、effects、system-of-record adapter、冪等與對帳 |
| **Policy** | 可信 actor／tenant、物件／屬性／行動範圍、使用目的、條件；由 Host 判斷，不是模型傳來的 allowed=true |
| **Decision／Evidence** | 當時物件、來源／模型／定義／政策版本、理由與核准、執行結果、原始 outcome 與後續觀察 |
| **Scenario** | 基準 snapshot＋明確變動＋函式／模型版本；隔離於真實狀態，不直接觸發來源 Action |

### 身分與真相歸屬

- Object ID 至少納入 tenant、來源命名空間、型別及完整業務鍵。複合鍵、大小寫、跨來源同號、rename／drop-recreate 需保留語意。
- 跨 ERP 的「相同客戶」需要可追溯的 identity resolution 規則或人工確認；不是同名就合併。
- 每一項屬性必須屬於以下三類之一：
  - **source-backed**：ERP 等來源是唯一權威；Ontology 只保有投影及 pending intent。
  - **ontology-owned**：如本平台建立的調查案件、指派、註記；Ontology store 是唯一權威，不依賴來源欄位。
  - **derived**：依固定版本邏輯計算；不可直接編輯成新的事實。
- 同一欄位不能同時允許來源同步與任意 Ontology CRUD 互相覆寫。對 source-backed 的編輯必須回寫 owner，確認後更新投影。

### 四種「關係」不可混用

| 關係種類 | 含意 | 是否能直接成為可信物件關係？ |
| --- | --- | --- |
| 技術 Lineage | B 的資料值或條件依賴 A | 不能 |
| SQL Join predicate | 這段程式如何配對資料 | 只是 mapping 證據，還要驗粒度／scope／有效性 |
| Semantic association | 欄位代表某概念、資產屬於某 Domain | 不代表某個客戶真的擁有某筆訂單 |
| Ontology Link | 某兩個物件在特定範圍與時間成立的業務關係 | 需已核定型別語義＋合法 binding＋目前證據／授權 |

定義發布狀態和資料可信狀態分開：已發布的 LinkType 仍可能因來源過舊、schema 漂移或撤權而不可用；不靠 definition 的 Published 標籤永久放行。

## 6. 建議整體架構

```text
使用者／業務應用
    │
    ├─ Pi Agent：理解、查詢、提案、調用具名能力
    ├─ Ontology Workbench：物件、關係、證據、行動／審核
    └─ Query & Grafana：分析與結果觀察
                 │
       可信 Host／共用身分、政策、審核與稽核
                 │
    ┌────────────┴───────────────────┐
    │                                │
DataHub 治理／證據平面             Ontology 營運平面
Catalog + Semantic               型別／Binding／Function／Action registry
Discovery → 原生 metadata         Object / Link query + Action runtime
官方 API／MFE／metadata events     物件投影／決策／案件／執行紀錄
    │                                │
DataHub 既有原生儲存                新增獨立 Ontology PostgreSQL
                                     │
                   ┌─────────────────┴─────────────────┐
                   │                                   │
           Query adapter／受控同步               受控 Action adapters
           初期明確批次；必要時 CDC                正式業務 API／command
                   │                                   │
                   └──────── ERP／MES／CRM／來源 DB ────┘
```

這是責任圖，不是要求每個框都拆微服務。第一版沿用既有 Agent／Host／MFE，新增有界的第一方 Ontology backend 與獨立 DB；只有長時執行、隔離或負載成立時拆 worker。不可讓 Pi runtime 直接連 Ontology DB 或來源 writer。

### 6.1 儲存建議與選型理由

**PostgreSQL 為第一候選：**同時需要 schema release、物件版本、關係、action intent、approval、結果與冪等鍵的交易一致性，且現有 Node／Python／SQL 技術可延用。可以先用型別目錄、object／link 表與必要 JSONB，重要的 tenant、identity、revision、索引及關聯不得藏進任意 JSON blob。

- 不是使用 DataHub 內部 MySQL／OpenSearch 加表或索引。
- 不是預先複製所有企業資料；僅物化已授權業務用例需要的物件／欄位。大表分析沿用來源 Query；敏感或未授權物化資料保持 virtual binding。
- instance、link、action execution 與敏感決策明細留在 Ontology store，不灌進 Catalog。
- PostgreSQL 的 RLS 可作縱深防護；仍需核驗 service role、bypass、連線池與 tenant context，不能以「啟用 RLS」替代端到端授權。
- 需要備份、PITR、retention、加密與還原演練；新增持久庫不是免費的部署細節。

**暫不必選圖庫作主庫：**有圖形 UI 不等於必須有 graph database。只有深度／高扇出的圖遍歷、路徑演算法或實測 latency 無法滿足時，才評估 Apache AGE 或獨立 graph read model；先說明誰是權威、如何重建與撤權。若使用 Open Foundry，其 PostgreSQL＋AGE 是該引擎的具體依賴，不能把本案可選 AGE 的結論套給它。

### 6.2 各資料的唯一主責

| 資料 | 權威位置 | 其他系統如何使用 |
| --- | --- | --- |
| 原始業務狀態，如訂單出貨狀態 | 原 ERP／MES／DB | Ontology 讀投影；修改經來源 command |
| Catalog schema／ownership／lineage／Term 定義 | DataHub 原生 Entity／Aspect | Ontology 以 URN＋版本引用，不雙向維護另一份詞彙 |
| 可執行 Object／Link／Binding／Action 的已發布 release | Ontology registry（新 store） | Git 可作開發輸入；runtime 只用已發布不可變 release |
| source-backed Object projection | Ontology read model；來源仍為事實權威 | 明示 observedAt／source version／watermark，不冒充即時原值 |
| ontology-owned 案件、註記與決策 | Ontology store | 授權後供工作台／Agent／分析讀取 |
| 既有 Semantic／Discovery metadata 審核 | 既有 DataHub Task／Run／Decision | 保持原路徑與歷史，不為 Ontology 搬家 |
| 新業務 Action intent／execution／結果 | Ontology store | Agent session／DataHub 可保不敏感 locator，不作可變第二份 ledger |
| Chat history | 既有 Pi session | 使用者上下文；不是業務事實或批准來源 |

DataHub 與 Ontology 的模型分界不是「兩套相同 schema」：Glossary Term 的人類定義由 Semantic 管；ObjectType 結構、Binding 與 Action 的執行契約由 Ontology 管，以 Term URN 引用同一概念。Ontology 的 release 摘要可以單向投影進 DataHub，不允許兩邊各自改同一份執行契約。

### 6.3 DataHub 端如何擴充而不 fork

1. **先引用原生 Entity／URN**：Dataset／schemaField、Term、Domain、Flow／Job、API、Dashboard／Chart。
2. 必要時增加第一方 custom Aspect 或型別層 metadata Entity，表示 Ontology model reference、release、binding dependency 與 governed runtime reference；這些名字是待設計，不是假裝已有的官方型別。
3. 精確型別可搜尋性、relationship 索引、OpenAPI ACL／CAS、歷史及 MFE 呈現須逐項驗證；有 model loader 不代表自動得到 GraphQL 與原生 UI。既有 API Entity 的實測已顯示此落差。
4. 以官方 metadata events／Actions 作變更通知，重新讀當前 schema／Term／權限才使 binding 失效或產生維護提案。事件本身不提供授權，也不是業務資料 CDC。
5. 新 store 的交易 outbox 可供必要的 metadata 投影／狀態通知；採可重建、可去重的單向投影。不得宣稱與 DataHub 寫入是同一交易，亦不據此重做現有 Semantic publisher。

## 7. 一個產品內的完整閉環

### 7.1 建模與維護閉環

1. 原生 ingestion 得到合法 scope 內的 schema／metadata。
2. Discovery 提供程式、SQL、ETL、API 及 BI 的技術證據與未知範圍。
3. Semantic 搜尋／維護共用定義，保護人工作品並顯示精確 before／after。
4. Pi 提出 ObjectType／Binding／Link／Function 的候選，不直接升格成已發布事實。
5. Host 核定 scope、來源、型別、粒度、完整 predicate、證據、權限及影響；業務 owner 確認不可由技術證據取代的語義。
6. Ontology 發布不可變 release；精確 pin DataHub definitions、schema、函式與政策版本。
7. 經另行授權的 row sync 建立物件投影；readback、唯一性／基數／新鮮度與結果對帳成立後才提供業務能力。
8. 後續來源 schema、定義、程式或政策改變：定位受影響 Binding／Function／Action，停止已失效部分、產生新差異；保留不受影響能力與歷史。

這延續現有「盤點 → 有依據提案 → 政策內執行／送審 → 驗證與持續更新」，不是用 Ontology 重開一套語義維護流程。

### 7.2 查詢閉環：兩條入口，一個執行與權限邊界

- **資產導向**：沿用 `datahub_catalog → datahub_sql → datahub_grafana`，適合資料探索與分析。
- **物件導向**：`Ontology type／object set → 已發布 binding／function → Query adapter → 同樣受控的結果／Grafana`，適合「哪些訂單需要處理」。

不能把現有 Query 的短期 Map cache 改名為 Object Store。物件查詢須知道 object ID、release、data version、tenant、freshness；結果卡才可合法導向物件詳情與行動。

跨來源物件模型不代表允許任意跨來源 SQL federation：可先用分別核准的同步在 Ontology read model 組合，或回報 virtual 跨來源查詢未支援。不同來源 watermark 也不是全域同一瞬間。

Grafana 繼續透過受控 backend 提供資料，不讓 dashboard URL／變數變成 bearer 或查詢授權。歷史圖表標示 as-of／到期，不因開啟歷史而自動重新查詢或重做行動。

### 7.3 行動閉環

建議的外部可見流程：

```text
發現物件／問題 → 解釋證據 → 提出具名 Action
→ 核身分與當前 policy → 重讀物件／來源版本與 preconditions
→ 按政策自動放行或可信 UI 人審 → 持久化執行 intent
→ 受控 adapter 送往權威系統 → 原生讀回／對帳
→ 更新投影、保留結果 → Grafana／物件頁觀察後續成效
```

- Action 的核准綁定 Action／參數、object version、policy、影響範圍與期限；執行時仍重核當前授權。模型不能回傳自己已批准。
- 具名 Action 如 `CreateInvestigationCase`、`AssignCase`、`CreateSupportTicket`；不開通用 `execute_sql_write`、任意 URL webhook 或任意 Python。
- ontology-owned 更新可以在新 PostgreSQL 交易內提交物件、audit 與必要 outbox。
- source-backed Action 優先正式業務 API／command。只有來源負責人確認沒有 API 且明確核准，才考慮專屬交易 adapter；絕不借用 Query 或 ingestion 帳號作 writer。
- action 狀態至少區分 proposed／awaiting approval／dispatched／confirmed／rejected／unknown。HTTP ACK、workflow completed、local commit 都不能單獨代表來源業務操作成功。
- 跨系統不保證全域原子性；外部成功／本地失敗或失 ACK 要對帳。來源不具備可核驗冪等／operation lookup 時，UNKNOWN 不自動重送。補償也是另一個可能失敗、需要授權的業務動作，不是魔法 rollback。
- 如需等待人審、多步操作與長時間故障恢復，採成熟 durable execution 元件；不讓 Pi 對話迴圈或整個巨型 DataHub Aspect 擔任 workflow engine。

### 7.4 具體產品情境（設計示例，非既有來源能力宣告）

「找出符合已核准異常規則的銷售訂單，解釋原因，建立調查案件並指派負責人；需要時在外部客服系統建立工單。」

1. Semantic 提供「金額、異常、訂單粒度」的核准定義；沒有定義就列缺口，不靠名稱猜門檻。
2. Discovery 解釋訂單金額、明細與 BI 指標的實際轉換及限制。
3. Ontology 以 Order／OrderLine／Product 與有來源依據的 links 建模。
4. 固定版本 Function 產生需處理的 ObjectSet 與理由；Query 計算、Grafana 呈現。
5. Pi 說明結果並提議 `CreateInvestigationCase`；Host 依政策及物件權限判定。
6. Ontology 新增自己主責的 Case／assignee，記錄 actor、證據與操作結果。
7. 在具體外部 API 操作另獲授權後，執行 `CreateSupportTicket`，保存外部 ticket ID 並原生讀回。
8. 來源資料或異常規則改變後，再計算、提示受影響案件與新舊差異；不覆蓋歷史理由，不重複建立工單。

本例能分期使用既有銷售資料脈絡，但不是承諾目前來源已有營運 API、完整物件鍵或異常規則。第一步的本平台 Case 成功，也不能冒充第七步外部 writeback 已完成。

## 8. 權限設計：必須面對的既有政策邊界

### 8.1 目前的規則不能偷換

既有使用者決策是 **DataHub metadata 可見即為產品查詢授權**，DB 用實際連線帳號決定來源 SELECT；不另設逐人來源 grant、不逐題審批。這不是 per-person DB／RLS 權限。

本次「業務物件、邏輯、行動、權限」目標需要的新增能力包括物件、敏感屬性與行動限制；但不能在報告裡默認現有 Query 已具備它們，或默默改寫既有產品決策。

### 8.2 建議的目標政策（需正式納入實作契約）

- **metadata 可見性**：沿用 DataHub，作來源／欄位背景與資料入口的基本邊界。
- **Ontology 讀取**：再核 tenant、物件／屬性／link／function 的業務 policy；列表、搜尋、聚合與圖遍歷一致執行，避免 count 或 link existence 洩漏。
- **業務行動**：另核 Action 權限、角色／目的／條件、來源端權限及必要 approval；「看得到」永不自動等於「可改」。
- **模型揭露**：人能看不代表能把物件值送入模型。現行 Query 不將業務數值放入模型／Pi history，預設維持；需要模型分析具體數值時，另定核准的最小輸出 projection 與留存政策。
- **權限撤回**：既有 resultRef、Grafana 讀回、ObjectSet、訂閱及 action 執行都要重核，不只新聊天有效。

**關鍵防繞過問題：**如果 Ontology 隱藏某些訂單列，但相同使用者仍能透過既有 generic Query 直接查同一來源，便不能宣稱平台已具備物件層隔離。建議對啟用 Ontology 細粒度治理的資料，讓 Query／Grafana 也套用同一政策與可驗證的 mapping；無法安全編譯的查詢明確拒絕。未綁定 Ontology 的資產維持原政策。

這是**針對受 Ontology 治理資料的查詢授權契約擴充**，不是偷偷新增逐人 SELECT 名單。若使用者不接受此擴充，就只能提供 Action 權限及原有 metadata 級的讀取治理，不能對同一份資料承諾完整細粒度保護。正式實作前需要明確確認此取捨。

### 8.3 政策元件的分工

先以 Host 做唯一 enforcement point，OPA 作可替換的 policy decision 元件；來源授權仍由來源系統決定。OPA 回覆不是授權資料來源，身份／物件屬性／版本必須由可信端取得。

當出現跨團隊分享、委派、組織階層與大量關係式權限時，評估 OpenFGA；它不是資料目錄或任意 SQL row filter，也不必與 OPA 一開始同時引入。

現有 DataHub Task／Run ACL 曾有非私密讀者邊界，因此新的敏感物件值、完整業務 Action diff 不直接寫入那些紀錄。只放通過 metadata ACL 的型別／依賴與不敏感 locator；業務 ledger 在新 store 用自身權限保護。

## 9. GitHub 套件調查與採用建議

2026-10-02 直接查閱官方 repo／README／部分 SECURITY、LICENSE 與 GitHub API。下列授權是本次查得的 repo 層級資訊，正式採用仍需固定版本、依賴 SBOM、逐包授權及相容性驗證。GitHub release／pushed_at 只證明發布／活動，不是成熟度或安全認證。

### 9.1 優先重用的元件

| 專案 | 能加速的部分 | 授權／查得版本 | 建議與代價 |
| --- | --- | --- | --- |
| [PostgreSQL][G1] | registry、object／link、版本與 action ledger 的交易儲存 | PostgreSQL License；本次直接核 COPYRIGHT，不將 GitHub `NOASSERTION` 誤判無授權 | **第一候選**。新獨立資料庫；新增備份、還原、升級與資料治理責任 |
| [OPA][G2] | 共用 ABAC／context-aware policy，Action／object 規則測試 | Apache-2.0；`v1.21.1`，2026-09-29 | **優先評估**。Host 執行決策，需自行正確編譯查詢限制與處理撤權；不是加上 library 就自動安全 |
| [SQLAlchemy][G3]／[SQLGlot][G4] | SQL 編譯、解析、方言、技術依賴 | MIT；本案已鎖 `1.4.54`／`30.12.0` | **直接延用既有 adapter**。不因此自動升級，也不以解析成功當安全或業務正確證明 |
| [Cytoscape.js][G5] | Object／Link explorer、來源證據與影響圖 | MIT；`v3.34.3`，2026-09-07 | **UI 候選**。純圖形／分析 library，不提供資料主責、權限、ontology runtime；顯示資料先經 Host 授權 |
| [Temporal][G6] | 等待人審、長時、多步 Action 的 durable execution | MIT；`v1.32.0`，2026-09-11 | **行動需求成立時採用**，不是先重建通用流程平台。新增 server／worker／persistence；外部 activity 的預設 retry 必須符合來源冪等與 UNKNOWN 規則 |
| [Debezium][G7] | 來源業務列的 CDC／物件投影持續同步 | Apache-2.0；GitHub `releases/latest` 回 404，不能據此說沒有版本或停止維護 | **新鮮度 SLA 要求時採用**。Oracle／SQL Server 需逐 connector 核版本、DB 設定、最小權限與成本；不是 DataHub ingestion 的替代品 |

Debezium 的「業務資料 CDC」與 DataHub 的「metadata MCL」分流。即使未來共用 Kafka 基礎設施，也必須有受支持的部署契約、topic／ACL／保留隔離；本提案不授權接管 DataHub 內部 topic 或更改其部署。

### 9.2 特定需求才用

| 專案 | 適合的需求 | 授權／本次查得版本 | 本案判斷 |
| --- | --- | --- | --- |
| [OpenFGA][G8] | 複雜的 relationship-based authorization | Apache-2.0；`v1.21.0`，2026-09-20 | 先不和 OPA 疊兩套 policy plane；有真實 sharing／delegation 問題再加入，權限關係不等於業務關係 |
| [Apache AGE][G9] | PostgreSQL 內的 openCypher／圖遍歷 | Apache-2.0 | 可後評估；API 的 latest 指向 `PG18/v1.8.0-rc0`，雖標 non-prerelease 仍含 rc，不能直接當成熟穩定推薦。須精確匹配 PG major／release |
| [LinkML][G10] | schema-as-code、JSON／RDF 等格式轉換、交換模型 | **Apache-2.0**；`v1.11.1`，2026-05-20 | 可作建模工具，不另成一套詞彙權威；不提供行動執行引擎。不要採用搜尋摘要中錯誤的 BSD 授權描述 |
| [pySHACL][G11] | RDF graph／SHACL constraints | Apache-2.0；`v0.40.1`，2026-07-28 | 有 RDF／SHACL 互通需求時才用；不替代來源鍵、SQL 安全與業務審核 |
| [Ontop][G12] | R2RML／SPARQL → SQL 的 virtual knowledge graph | Apache-2.0；`ontop-5.5.0`，2026-02-14 | 適合強 W3C／virtual RDF 需求；本案已有 SQL Query，暫不再引入 Java／SPARQL 執行面。它不是 Action runtime |

### 9.3 最接近「現成 Operational Ontology」的專案

#### A. [syzygyhack/open-foundry][G13]：值得有界 PoC，不宜直接宣告正式核心

直接閱讀 default branch、`v0.3.0` README、SECURITY 與 repository map：

- Apache-2.0；查得最新 release `v0.3.0`（2026-09-07），repo 建於 2026-02。
- 有 GraphQL SDL 形式的 ODL、Object／Link／Action、generated REST／GraphQL、history、sync、OpenFGA、CEL、PostgreSQL＋AGE，與本次目標相當接近。
- **不只是單一小 library**：包含 API、engine、actions、security、sync、storage provider，CEL 為 Go gRPC sidecar；採用會帶入另一套 runtime 與部署責任。
- README 明示 **pre-1.0**；SECURITY 明示沒有獨立第三方 security audit，也沒有已記錄處理真實個資的 production deployment。
- 預設 Docker Compose 是 development：OpenFGA／CEL 可用 allow-all stub、未登入者可取得 synthetic admin。此模式測通不能當權限證據。
- 文件宣稱 governed action pipeline、compensation 等能力；本次沒有執行或檢查全部實作，不能由宣稱推得跨系統原子性、故障恢復或合規已足夠。
- README 的 backup capability／效能 baseline 等仍有 roadmap 項；不等於 PostgreSQL 完全不能自行備份，但說明平台層運維仍要補證據。

**建議**：如以最快取得廣泛原型為優先，可用非敏感合成資料跑一次隔離 PoC，經 DataHub adapter 驗 ontology release／URN binding、真身分、兩個 tenant、source writeback unknown、版本衝突與升級。若通過再決定採用其 engine；不要 fork DataHub 去迎合它，也不要把現有 Host ACL 換成它的開發預設。

#### B. [gura105/operational-ontology][G14]：非常適合參考，不是可直接安裝的正式套件

- MIT；`v0.6.0`（2026-09-23），repo 建於 2026-07。
- README 明說 **learning resource, not a framework or npm dependency**。
- TypeScript／SQLite 範例具體展示 source-backed／ontology-owned／derived ownership、action gate、source writeback、re-index 保留本地狀態、MCP 工具生成。
- 同時明說 actor 是 self-declared、沒有 authentication、未設 policy 的物件對所有人可見，audit read 為未限範圍 admin view。
- 複合鍵、刪除、link properties 等有缺口；與本案 tenant／來源精確身分需求不能直接等同。

**建議**：借鑑 ownership、Action／Function 契約及具體案例；不拿 demo MCP／SQLite／自稱 actor 直接接真實資料。

#### C. [Palantir OSDK TypeScript][G15]：API 設計參考，不是開源 Palantir server

官方 README 要求 Foundry stack、Developer Console、ontology identifier 與 OAuth client。它是呼叫 Palantir Ontology 的 client/toolchain，不會替 DataHub 提供獨立 Object／Action backend。本次 GitHub repo 層級 license 欄位未辨識，若重用程式需逐 package 核授權；不引用不明授權，不捏造商業方案價格。

### 9.4 推薦的開發策略

**主方案：成熟元件＋薄的第一方領域服務；完整 early-stage engine 作替代候選。**

- 第一條垂直閉環：既有 DataHub／Pi／Query／Grafana＋新 PostgreSQL＋有界 Ontology model／object／action API；policy 優先評估 OPA。
- 需要可恢復的人審／多步外部 Action 時，再接 Temporal，不自行發明另一套 durable workflow engine。
- 需要低延遲同步時再接 Debezium；沒有 SLA 證據前，明確批次刷新比先建 streaming stack 更可控。
- Graph UI 可用 Cytoscape.js；AGE／OpenFGA／LinkML／SHACL 不作第一版全數必裝清單。
- Open Foundry 若能通過上述接縫與風險檢查，可替換部分自有 runtime 實作；其 adoption 不應改變對 DataHub、Host 與來源的既定主責。

不能交給套件自動解決的部分：業務物件粒度、來源鍵與 identity mapping、完整關係語義、DataHub URN／schema version 綁定、現有政策的相容與防繞過、外部系統實際 writeback 契約、語義變更影響與使用者旅程。

## 10. 實作接點建議（尚未建立這些檔案）

| 接點 | 延用內容 | 新增責任 |
| --- | --- | --- |
| `extensions/datahub-agent/integration/server.mjs`／gateway | 現有可信 DataHub 身分與 typed request context | 接第一方 Ontology API；不讓 model 提供 actor／tenant／DB URL |
| `native-semantic*.mjs`／`semantic-managed-*.mjs` | 原生語義定義、精確證據、既有維護輪次 | Ontology 讀取已核版本；不加第二套 vocabulary publisher |
| `native-discovery.mjs`／`extensions/dataflow-discovery/contracts/v1/` | source-bound evidence、IR、Catalog identity、完整性限制 | 為 binding 提供候選與依賴；不讓 IR 邊自動成為可信 Link |
| `metadata-query.mjs`／`query-*.mjs` | 身分、source binding、結構化 SQL、取消／限制／結果讀回 | ObjectSet／Function query 與共同 policy enforcement；保留原唯讀邊界 |
| `query-grafana.mjs`／MFE portal | 受控結果端點、Viewer／org 綁定、原生圖表 | 顯示 ontology release／as-of；導向物件詳情，不直接提供寫入 SQL |
| 建議 `extensions/ontology/` | 第一方插件模式、固定版本與 API 契約 | model registry、read model、Function／Action、sync／writeback adapters、Ontology DB migration |
| Pi tool／MFE／React | 既有工具註冊、卡片、history、trusted review | `ontology_search/get/traverse/evaluate/prepare_action/read_execution` 等具名能力；批准依可信 policy／UI，不設模型 self-approve |

業務 Action runtime 屬可信 Host 支援層，不是能任意替換 Auth／Policy 的插件。模型生成的 Function 或 adapter 仍是未審候選，需要固定來源、隔離測試與版本批准；不能把「Agent 可以寫程式」直接變成 production 安裝能力。

## 11. 分期：按使用者能力，而不是按元件數量

### 第一期：一個領域的「看懂並能採取受控行動」

選已有授權資料與可確認業務定義的案例，完成少量 Object／Link、來源 binding、固定 Function、物件工作台／Query／Grafana，以及至少一個 ontology-owned Action（如建立／指派調查案件）。

完成條件：同一使用者在 Agent 與物件 UI 看到一致的物件及證據；無權者不能從搜尋／連線／聚合／Grafana 繞過；Action 真正持久化，重載可追溯；來源下一輪刷新不吞掉 ontology-owned 狀態。不能只交圖譜或 type editor。

### 第二期：真正外部業務 writeback 與後續變更

接一個明確授權、可查 operation status／具冪等契約的來源業務 API。具備等待批准、版本衝突、拒絕、取消與部分失敗處理；必要時使用 Temporal。

完成條件：來源原生結果、Ontology 執行紀錄與 UI 一致；失 ACK 不重做未知效果；過期物件或撤權禁止執行；其後來源／規則真實變更能重新評估且不重複操作。**沒有這一期，不能宣稱已達成本次完整營運閉環目標。**

### 第三期：擴充與動態決策

按實際需求加入更多 domain、CDC、新 Function／模型、受控自動化與 scenario 比較。情境必須 pin 基準與假設，與真實狀態分離；選定方案要重新經當前權限／preconditions 執行。Pi session 分支不是業務 Scenario。

完整 Palantir 式 simulation、全球高吞吐 object serving、全面 multi-system orchestration 是後續能力，不用「未來可擴充」當成已交付。

### 持續觀察的產品成效

- 從資料問題到有證據決策／成功行動的時間。
- 物件／關係與來源對帳正確性、新鮮度及明示缺口。
- 有可靠 evidence／approval／native outcome 的行動比例與 UNKNOWN 處理狀態。
- 來源／語義改變後能否準確定位影響並完成下一輪維護。
- 使用者是否能在單一上下文完成工作，而不在 Catalog、SQL、圖表與外部系統手工搬資料。

套件數、模型數、測試數、節點數與「政策拒絕很多」都不是產品完成度。

## 12. 尚需決定的事項與建議下一步

本次已解決「是否只做分析」與「是否允許新 store」。以下是正式實作前的產品決策，未據此更改任何設定：

1. **細粒度讀取權限與原 Query 政策如何相容**：建議採第 8 節的共同 enforcement，否則必須明示物件隱藏可被原資料查詢取得的界線。
2. **第一個真正業務流程與權威 API**：選已有業務 owner 的流程；本報告 Case／Ticket 是示例，不替使用者指定或授權外部系統。
3. **物化範圍與 SLA**：允許複製哪些列／欄位、保留多久、刷新時限、可接受的失聯讀取／行動行為。這會影響是否需要 CDC／graph backend。
4. **開發策略**：推薦成熟元件＋有界第一方服務；如更重視快速取得廣泛原型，可先做 Open Foundry 隔離 PoC，再以接縫證據決定採用，不用一次把整個新平台替換進現有架構。

下一個有用交付是：**用一個實際領域畫出完整 Object／Link／Binding／Function／Action／Policy 與資料主責，並定義第一條成功與失敗的端到端旅程**；不是先搭一組 PostgreSQL／Neo4j／Temporal／Kafka／向量庫。

### 研究回顧與信心

高信心：Palantir 官方四要素；本案五模組的責任切分；DataHub metadata 與業務物件分層；現有 Query 的來源執行及不送數值給模型的邊界；外部 writeback 不能保證跨系統原子。

設計建議、尚待驗證：PostgreSQL 工作量適配、OPA／Temporal 的具體整合、任何第三方 Ontology engine 的可用性與新 UI。沒有跑 benchmarks、部署新套件或驗證新資料來源。若實際首個用例需要高深度圖運算、嚴格 W3C 互通或既有成熟 workflow 基礎設施，元件選擇應相應調整。

本次最重要的發現：**不應再建立與 Semantic 重複的「定義庫」；真正欠缺的是把已治理的概念綁成具有身分、狀態、邏輯、操作與權限的業務模型。**

## 13. 本地證據與外部來源

### 本地閱讀依據

- [`AGENTS.md`](../../AGENTS.md)：目前主線、Core／來源／SQL／權限原則；本次 datastore 設計例外見第 0 節，未改寫該檔。
- [`metadata-query.mjs`](../../extensions/datahub-agent/integration/metadata-query.mjs)：`createMetadataQueryHost` 約 L89–385，真 source execution、短期 results、metadata 再核與 Grafana readback。
- [`server.mjs`](../../extensions/datahub-agent/integration/server.mjs)：約 L230–400，共用身分與各產品路徑的接線。
- [`native-discovery.mjs`](../../extensions/datahub-agent/integration/native-discovery.mjs)：`analyzeWorkspace` 約 L512–544，固定 source／Catalog preview，不允許發布／ETL execution。
- [`semantic-managed-maintenance.mjs`](../../extensions/datahub-agent/integration/semantic-managed-maintenance.mjs)：`managedDescriptionPlan` 約 L114–171，不以名稱／型別當意義證據，保護 prior-Agent／current 差異。
- [Query 設計](../design/datahub-agent-metadata-query.md)、[Query 真入口驗證](../verification/datahub-agent-metadata-query-native-20260926.md)。
- [Semantic Catalog 主線](../design/datahub-semantic-catalog-mainline.md)、[持續代管提案與限制](../design/datahub-semantic-agent-automanagement-proposal.md)、[2026-10-02 本地證據與未完成線](../verification/datahub-semantic-scoped-evidence-local-20261002.md)。
- [Discovery contract-first 設計](../design/dataflow-discovery-plugin-development.md)、[Discovery readiness／真入口證據](../verification/dataflow-discovery-readiness.md)。
- [固定 Core 架構文件](../../upstream/datahub/docs/architecture/architecture.md)、[官方 custom metadata model](../../upstream/datahub/metadata-models-custom/README.md)。
- [Pi Web package](../../extensions/datahub-agent/pi-web/package.json)：產品 SDK `0.85.1`；[現有 Query 依賴鎖](../../extensions/datahub-agent/integration/requirements-query.txt)。

### Palantir 官方來源

[P1]: https://www.palantir.com/assets/xrfr7uokpv1b/mhoyY4c8vdVlJhulDStk2/a7340768109c8e8d79d00b4cb99d8e70/Whitepaper_-_Foundry_2022.pdf
[P2]: https://www.palantir.com/assets/xrfr7uokpv1b/4mSNoWcwpgo5G8lRmBSnbk/2d33af8f6c717377197aae56d683f82d/Connecting_AI___Machine_Learning_with_Operations.pdf
[P3]: https://www.palantir.com/assets/xrfr7uokpv1b/6pey1VnYHULqeggNbPKqP0/9f577de3e3dfb9fc031bd75dc7526517/Palantir_Privacy_and_Governance_Whitepaper__1_.pdf
[P4]: https://www.palantir.com/docs/foundry/architecture-center/ontology-system
[P5]: https://www.palantir.com/docs/foundry/ontology/core-concepts
[P6]: https://www.palantir.com/docs/foundry/action-types/webhooks/

### GitHub 原始來源

[G1]: https://github.com/postgres/postgres
[G2]: https://github.com/open-policy-agent/opa
[G3]: https://github.com/sqlalchemy/sqlalchemy
[G4]: https://github.com/tobymao/sqlglot
[G5]: https://github.com/cytoscape/cytoscape.js
[G6]: https://github.com/temporalio/temporal
[G7]: https://github.com/debezium/debezium
[G8]: https://github.com/openfga/openfga
[G9]: https://github.com/apache/age
[G10]: https://github.com/linkml/linkml
[G11]: https://github.com/RDFLib/pySHACL
[G12]: https://github.com/ontop/ontop
[G13]: https://github.com/syzygyhack/open-foundry
[G14]: https://github.com/gura105/operational-ontology
[G15]: https://github.com/palantir/osdk-ts

額外核對：[Open Foundry SECURITY](https://github.com/syzygyhack/open-foundry/blob/v0.3.0/SECURITY.md)、[repository map](https://github.com/syzygyhack/open-foundry/blob/main/docs/repository-map.md)、[Operational Ontology 的明示限制](https://github.com/gura105/operational-ontology#scope-and-declared-behavior)、[PostgreSQL COPYRIGHT](https://github.com/postgres/postgres/blob/master/COPYRIGHT)。

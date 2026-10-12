# DataHub metadata × UML × Agent：Operational Ontology 可行性評估

日期：2026-10-02。狀態：**研究建議，未實作、未安裝、未部署，未執行業務資料查詢或 Action。**

> **開發請改以 [Operational Ontology v1 實作設計](../design/datahub-operational-ontology-v1.md) 為準。** DataHub 定義／release 權威與 typed unified graph 保留；已收斂為 Temporal 唯一流程引擎、v1 不加 Tork、來源讀取沿用 metadata ACL，案件／批准／Action 另核營運權限。本文保留研究選項，不是尚待開發者自行選擇的架構分支。

這是[前一份 Operational Ontology 提案](datahub-operational-ontology-proposal-20261002.md)的方向細化：以 DataHub metadata 為模型主體，借鏡 UML，整合 Agent、ML 與 OpenSandbox。前案第 6 節「可執行模型 registry 以新 store 為權威」的建議，改為本文的 **DataHub 定義平面＋獨立營運 runtime**；不是兩個可獨立編輯的模型庫。

## 1. 結論與已確認邊界

**可行，但它是「metadata 驅動的業務物件與流程平台」，不是把 ER 圖改畫成 UML，就得到可執行 Ontology。**

建議分成三部分：

1. **DataHub 定義／治理平面**：schema、語義、技術 lineage，以及新增的 Object／Binding／Action／Process／State 定義及版本。
2. **Ontology 營運平面**：依發布模型取得或物化物件、維持流程實例與狀態、執行受控 Action、記錄事件與結果。
3. **Agent／分析／工作台**：Agent 使用模型協作與提案；OpenSandbox 執行隔離分析；工作台把同一份模型呈現為 class、sequence、state 與分類關係圖。

使用者已明確選擇：**統一關係圖、保留不同語義**，不要求把所有關係塞進 DataHub 原生 Lineage 頁。允許設計 Ontology 所需的新 datastore；不等於批准建庫、部署、複製業務資料或來源寫入。不修改 DataHub Core。

本次直接查閱 `/home/timmypai/apps/grafana` 的相關原始碼與設計文件，並查閱 OMG、Palantir、OpenSandbox 及候選套件官方資料。未接觸兩個專案的現場服務；現有測試／部署紀錄僅作具名、限定範圍的歷史證據。

## 2. UML 對應：保留直覺，補齊執行語義

| 使用者構想 | 評估與建議 |
| --- | --- |
| Table ER model → class diagram | 適合產生**候選結構模型**。但 Table 不一定等於業務 Class；一個 Order 可能來自 header／detail，多個來源也可能描述同一實體 |
| 業務流程 → sequence diagram | 適合表示某個場景中的參與者、訊息與順序；完整流程的條件、並行、等待、人工作業與例外，宜另有 Process／Activity 模型 |
| Action 關係 → interaction diagram | **Sequence 本身就是 Interaction diagram 的一種**。重點是訊息順序用 sequence；重點是誰與誰互動，可用 communication／interaction graph |
| State diagram 表示執行狀態 | 適合，但須分開「業務物件狀態」與「流程／Action 執行狀態」；外部回覆不明不代表訂單已取消 |
| Agent 依模型把資料實例化成 objects | 可行；Agent 選範圍與呼叫能力，**可信 runtime 依已發布 Binding 決定物件身分與欄位值**，不是模型在聊天中逐列編造實例 |
| ML 推導物件關係 | 可行，輸出為有 scope／版本／證據的候選。身份匹配、業務 Link、統計關聯與流程先後不能自動互換 |
| Sequence／interaction 用 lineage 呈現 | 可以共用圖形工作台；資料 lineage、業務 Link、呼叫／事件、狀態轉移必須分型，不能統一寫成 `DownstreamOf` |

OMG 的 UML、fUML、Alf 與 PSSM 分別提供建模與執行語義相關規範。[U1–U4] **這不表示任何 UML 圖都是可直接執行的程式，也不表示本案必須實作完整 UML 2.5.1。**

### 建議採「UML-inspired 的有界執行模型」

- Class：typed properties、identity、association、operation signature。
- State：event、guard、transition、effect，以及明確的初始／終止狀態。
- Process：具名步驟、條件、等待與逾時、human task、允許的 Action；並行／補償依實際流程需要加入。
- Interaction：由 process 定義或實際事件產生的設計／執行視圖，不另維護一份互相矛盾的 executable sequence。
- 不支援的 UML 構造明示不支援；不以任意 Python／JavaScript `eval` 補齊。

若未來真的需要 UML 工具 XMI 互通或完整 fUML/PSSM 合規，那是另一個專門工程範圍。目前只借鏡 UML，不宣稱符合整套規範。

## 3. ER 能告訴我們什麼，不能告訴我們什麼

### 可以直接取得或驗證的候選

- Table／column、physical type、nullable、PK／FK、description、technical lineage。
- FK 對應 association 的候選端點與完整複合鍵。
- 欄位到物件 property 的 source binding，以及來源／schema 版本。
- SQL／ETL／API 分析得到的讀寫與轉換依賴。

### 還需要業務定義或另外證據

- 物件粒度、生命週期及 aggregate 邊界。
- 「客戶」「訂單」「交易」的真正業務身分，以及跨來源 identity resolution。
- FK 是否啟用／可信、nullable 與 unique 約束如何影響基數；不能只看到欄名就猜 `1..*`。
- 租戶／公司條件、有效期間、時區、幣別、NULL／字串比較與必要 filter。
- 哪個 Action 被允許、需要誰批准、哪些前置條件成立、失敗後怎麼處理。

**只有 metadata、沒有 row/API/event 讀取能力，就只能建立 class 定義，不能聲稱已得到當前 object instances。** 資料庫 snapshot 也不自動提供完整流程歷史。

## 4. DataHub 為模型主體，但不是業務列資料庫

### 4.1 唯一主責

| 資料 | 建議權威位置 | 限制 |
| --- | --- | --- |
| Dataset／Field／Glossary／Domain／ownership／technical lineage | DataHub 原生 metadata | 沿用 Semantic／Discovery，不重建另一份詞彙 |
| ObjectType／LinkType／Binding／Function contract／ActionType／Process／State 定義 | DataHub 官方 Model／Aspect 擴充 | 業務型別是 metadata 記錄，不是每新增一種業務 Class 就改 Core 或編譯一套引擎 |
| 已發布模型 release 的版本、引用、核准與內容身分 | DataHub 定義平面 | 必須能取得不可變且完整一致的版本；一般 latest 查詢不夠 |
| 編譯後 runtime snapshot | 可重建的 runtime cache／部署產物 | 唯讀衍生物；不能脫離 DataHub 獨立修改，亦不是第二份 registry 權威 |
| source-backed object properties | 原始業務系統；runtime 保投影或即時查詢 | 明示 as-of／來源版本；修改經來源 command |
| ontology-owned 案件／指派／註記、流程實例、執行紀錄 | 新 Ontology PostgreSQL | 不寫 DataHub 內部表，不把每筆業務 object 做成 Dataset |
| ML evidence／action result／敏感 trace | 受控營運／artifact 儲存 | DataHub 只保適當摘要與受權限保護的 locator，不把完整業務列灌入 Catalog |
| 既有 Semantic／Discovery Task／Run／Decision | 現有 DataHub 原生紀錄 | 不為新 Ontology 搬家 |

Function 定義包含參數／輸出型別、版本、artifact hash 與執行限制；不必把大型模型、全部程式原始碼或執行輸出塞進 Aspect。圖的座標／排版不是執行權威。

### 4.2 官方插件可行性與真正待驗處

固定 Core `v1.7.0.1` 的 custom-model 文件提供 PDL Aspect／Entity registry 與版本化模型產物機制。本案在自身 plugin 目錄建置，不修改 `upstream/datahub`。[L1]

但必須驗證：

- custom entity/aspect 的公開讀寫、可信 actor ACL、版本／CAS、relationship 搜尋及歷史保留。
- 新 Entity **不自動**具有原生 GraphQL、UI 與完整權限管理；工作台可走已核實的公開 API／Host adapter。
- 多個 Aspect 的發布不視為一個跨記錄原子交易。runtime 使用完整 release manifest 與固定內容版本，不拼接不同時間的 latest。
- 長時流程保留它啟動時的模型版本；變更模型不偷偷改寫進行中 instance。政策與撤權仍於執行時重核。
- 固定版本資料必須真的可讀且保留足夠歷史；不能只保存 hash，日後卻找不到內容。

若官方擴充點無法支撐必要的版本與信任契約，應回報明確缺口再決定；不能默默把模型權威搬回新 DB、修改 Core 或降低安全條件。

## 5. 建議整合架構

```text
                       使用者／Pi Agent／Ontology Workbench
                         │           │            │
                    提案與工具    UML／物件視圖    Query／Grafana
                         └───────────┼────────────┘
                           可信 Host：身分、政策、審核、稽核
                                     │
              ┌──────────────────────┼─────────────────────┐
              │                      │                     │
    DataHub 定義／治理平面      Ontology Runtime       Analysis Adapter
    Catalog／Semantic          Object resolver         授權 inputRef
    Discovery／technical       Process／state          OpenSandbox Python
    Model／Aspect／release     Action executor         evidence／candidate
              │                      │                     │
              └──固定版本模型──→ PostgreSQL ←──Host 驗證後的候選／結果
                                     │
                       ┌─────────────┴──────────────┐
                  受控 Query／同步             具名 Action Adapter
                  來源讀取與投影               正式 API／command
                       └──────────業務來源系統───────┘
```

這是責任切分，不要求每個框都是一個微服務。Agent、OpenSandbox、MFE 均不直接連來源 writer 或掌握其秘密。OpenSandbox 不因承載 Python 而成為 Action executor。

### Agent 的工作方式

1. 讀當前允許的模型、物件描述、來源 metadata 與可用能力。
2. 依使用者意圖選 object set、提出 analysis／next action，必要時生成 Python。
3. Host 取得授權資料，runtime 決定 object identity／版本；分析資料以 opaque ref 在可信端傳遞。
4. Python 在 sandbox 計算，產生候選或觀察，不直接發布關係或執行業務寫入。
5. Host 按政策決定可直接執行或送審；不要求每次分析／查詢都人工批准。
6. 已批准／政策允許的具名 Action 由 runtime 執行、讀回、記錄狀態；Agent 再解釋結果或協助下一步。

**流程可以包含 Agent 的動態決策，不必把所有分析方法寫死為中央 DAG；但 Agent 不能任意突破已發布模型、操作契約或權限。**

### 物件不必一開始全量物化

- Source-backed 物件可按需解析；需要搜尋、subscription、離線比較或 SLA 時再物化必要範圍。
- 案件、人工指派、流程狀態及操作紀錄需要持久化。
- 現有 DataHub Query 是同來源受控查詢；多來源模型可被表達，不代表跨來源 federation 已可執行。
- 若需跨來源 entity resolution，必須另有授權的輸入準備及一致的 actor／scope；不能讓 sandbox 自行連不同 DB 拼資料。

## 6. `~/apps/grafana` MCP：哪些能借，哪些不能直接搬

| 元件／接點 | 本次直接確認的行為 | 對本案的用途與差距 |
| --- | --- | --- |
| `ontology-mcp/server.py`、`ontology_contract.py`、`ontology_graph.py` | 唯讀 semantic snapshot、hash 驗證、bounded 關係探索；proposed relation 不授權 join | 可借 immutable model projection／candidate 分流；**不含 object instances、action/writeback 或細粒度政策** |
| `grafana-query-mcp/server.py::tool_query_dataset` | 可信 context、執行當下授權查詢、Grafana `/api/ds/query`、frame_ref；無 mandatory analysis-plan ticket | 可借資料引用契約；DataHub 應沿用自己的 metadata Query，不另繞 Grafana 取得另一套來源憑證 |
| `sandbox-analysis-mcp/server.py::_execute_python_analysis` | 授權 frame＋生成 Python；新 sandbox；code/input hash、seed、image、resource、provenance；標示 `trusted_ml_contract: false` | 可借分析執行與證據保存；成功執行不等於分析方法正確／關係已核准 |
| `execute_python_preprocessing`、`revise_python_analysis`、`reconcile_operation` | 文件預處理、保留父 provenance 的修訂、唯讀對帳 | 可借 attempt／revision／未知結果處理；不是 durable business workflow |
| `mcp_security.py::authenticate_headers` | 服務 token＋固定 org/service identity＋可信上游帶入 actor/session | 可借信任邊界設計，不能直接相信模型送來的 actor，也不能把 Grafana 身分當 DataHub 原生 ACL |
| sandbox image／runtime settings | 固定映像；分析套件；deny egress、空 env、無 volumes；runtime-class 檢查 | 移植需重驗 SDK／控制面／隔離實際有效；只設 `network: deny` 字串或使用 `runc` 不等於正式安全驗收 |

### 6.1 兩個實質轉接工作

**A. 資料形狀與 actor adapter。** 現有 sandbox 主要接受一份 Grafana columnar frame。DataHub `resultRef` 不是同一種 ref，也不是可互用的 bearer token。需要可信 adapter 將當前允許的結果轉為 bounded 分析輸入，綁定 actor、tenant、source、model version、資料範圍及觀測時間；執行／讀回重核。不能直接指向另一專案的 artifact 目錄。

**B. 模型資料揭露邊界。** Grafana Query 原始碼會回傳部分 MSSQL `result_preview`；sandbox README／實作也允許 bounded text／JSON 輸出。DataHub 當前明定業務數值留在 Host／受控 UI，不進模型／Pi history。[L2]

因此移植不能照單全收：在保留現行政策時，模型只取得 schema、opaque refs、非敏感執行狀態及經准許的描述；原始數值、物件 ID、候選配對、stdout/stderr、圖表 payload 及可能洩漏值的 exception 走受控結果通道。**「輸出摘要」不是天然脫敏，Python 可以把整份資料編碼進摘要。** 若希望 Agent 直接根據業務數值反覆分析，必須另外確認可揭露給哪個模型、哪些欄位／聚合與保存方式。

### 6.2 不能把歷史驗證冒充目前完成度

Grafana 的 `docs/verification/opensandbox-request-completion.md` 記錄過 execd 提早完成的實際故障、特定版本修補及無業務資料的 live 回歸。這支持「生命週期語義要驗證」；不是目前所有 cancellation、ML、Dashboard 或 DataHub 整合都已驗收。現行 README 亦明示 cancellation 的真 UI／OpenSandbox 驗收仍有限制。

本次沒有啟動 MCP、OpenSandbox 或重新執行那筆未知結果的歷史分析，也沒有移植其 upstream patch。

## 7. ML 推導關係：至少分成四類

| 目標 | 優先證據／方法 | 輸出與不能推論的事 |
| --- | --- | --- |
| 已知實體間的業務 Link，如 Order → Customer | 正式 FK／業務定義／完整 SQL predicate，再查 null、coverage、duplicate、fan-out | 候選 Binding／Link；技術匹配率高不代表業務語義正確 |
| 不同記錄是否為同一實體 | blocking、exact/fuzzy matching、probabilistic record linkage；有標籤時 supervised model | `same-entity candidate`；不能直接合併正式 object identity |
| 物件之間的統計關聯、風險或預測 | correlation、classification/regression、時間模型、異常偵測 | 附條件／時間／模型版本的 derived finding；SHAP／feature importance 不是因果證明 |
| 實際流程如何發生／是否符合設計 | 有 case/object ID、activity、event ID、時間與關聯資訊的 event log；process mining／conformance | observed process／差異；觀察到的順序不是批准流程，沒有事件不可從靜態 ER 還原歷史 |

同一事件可能涉及 Order／Shipment／Case 多種物件；不宜強行假設所有流程只有一個 case ID。需要時評估 object-centric event log，而不是把同一活動複製成互相矛盾的多條 trace。

### 最小候選／證據契約

- 關係種類、兩端精確型別／URN／fieldPath 或受控 object ref。
- 完整 predicate、方向、基數、tenant／公司／時間 scope。
- 輸入授權範圍、observedAt、樣本／母體、分子分母、排除原因與未知。
- 程式 hash、方法／模型／套件／映像版本、seed、來源／schema／模型 release。
- 評估結果及適用限制；有監督模型保留獨立 holdout，按 entity／時間切分，避免同物件或未來資訊洩漏。
- 提案、核定、發布／失效狀態分離；schema、來源、人工定義或證據變動時重新比較。

Agent 可以自由選適合的方法，不先建全套 ML 平台。**方法探索不需要固定模板；把結果提升為正式 Link／Action 則需要固定信任契約。** 固定 seed 也不保證所有環境下 bit-for-bit 重現。

## 8. 統一關係圖與 UML 視圖

建議至少區分：

| 邊的語義 | 例子 | 呈現／用途 |
| --- | --- | --- |
| Data lineage | Dataset → Transform → Dataset／Field | 仍使用真正的 DataHub lineage；追資料怎麼來 |
| Binding／語義映射 | Field → Property；Property → Term | 追模型依據，不代表實例關係 |
| Business Link | Order → Customer | 分清 LinkType 與當前 instance Link，保留有效範圍 |
| Invocation／event | Step `invokes` Action；Action `emits` Event；Step `consumesEvent` Event | 設計 interaction，或基於 correlation／causation 的執行 sequence |
| State transition | Case.Open → Case.Assigned | event／guard／effect 與物件版本 |
| Evidence／decision provenance | Candidate → Evidence → Review → Release → Execution | 解釋依據、核准與當次結果 |

工作台共用一份模型與識別碼，切換：**Class、Process、Sequence、State、Data lineage、Evidence**。預設提供焦點物件／流程與 bounded 展開，不畫全公司 hairball。

- 設計視圖標示「預期可發生」；執行視圖從真 trace 產生「實際已發生」。
- 平行分支是部分順序；不能只按不可靠的跨系統時間戳排成一條確定序列。
- 靜態 code call graph 只是可能呼叫；只有 runtime／來源事件才證明這次真的呼叫。
- 區分業務 `Case.status`、流程 `ProcessInstance.status` 與 `ActionExecution.status`。`UNKNOWN` 是操作結果待對帳，不是任意回滾業務狀態。
- 統一視圖仍須逐節點／邊授權；不能靠隱藏點擊詳情，卻洩漏受限關係或存在性。

DataHub `DataJobInputOutput` 的 `Consumes`／`Produces` 及 `UpstreamLineage` 的 `DownstreamOf` 表示資料血緣，並未提供任意業務 message／transition 的等價語義。[L3]

## 9. 與 Palantir 的相同與不同

Palantir 官方把 Ontology 定義為 **Data／Logic／Action／Security** 的結合，另分 Language／Engine／Toolchain。[P1] 本案方向與之相近；UML 是表達選擇，不是核心差異。

| 面向 | Palantir 官方描述 | 本案建議與現況 |
| --- | --- | --- |
| 結構模型 | Object／Property／Link／Interface，連接資料與現實實體 | 以 DataHub metadata 起步；class 視圖＋第一方 executable model；尚未有 object runtime |
| 邏輯 | Functions 可作用於 objects／object sets；包含規則、ML、LLM 與 orchestration | Agent 可生成 sandbox Python；要升為受治理 Function 還需版本、I/O、品質／執行契約 |
| 行動 | Action Types 統一 edits、parameters、validation 與 side effects | 需要新 Action runtime／adapter；既有 SQL Query 和 sandbox 不是寫入引擎 |
| 自動化 | Automate 提供時間／物件條件、Actions、Functions、AIP Logic 等 effects | 可用 Process／State 模型表達，再由 durable runtime 執行；不是畫 sequence 就完成 |
| 資料引擎 | 官方描述讀寫、materialization、subscription、CDC 等整合能力 | 初期只做必要物件投影與查詢；同步、規模、freshness 由本案負責驗證 |
| 工具鏈 | OSDK、Object Views、Workshop、分析與營運工具 | DataHub MFE／Pi／Grafana 能組成入口，但尚缺整合的 object／process 操作體驗 |
| 權限 | 跨資料、物件、邏輯、操作的細粒度治理 | 目前 metadata-based Query 契約不是物件級政策；新治理必須檢查所有旁路 |
| UML／可視化 | 官方核心契約以 Object／Link／Action／Function 為中心；不要求使用 UML | 本案可用多視圖讓模型、流程與證據更易理解；不是已證明比 Palantir 更自動或更完整 |
| 交付責任 | vendor 整合平台及其部署／許可模型 | 採開源元件＋第一方整合，控制力較高；一致性、安全、升級與維運成本也由本案承擔 |

這是公開文件能力對照，不是兩平台實測 benchmark，也不是聲稱 Palantir 具有完整 UML 執行相容性。[P1–P4]

### 三個不可省略的現實差距

1. **Object engine**：身分、資料映射、投影／即時讀取、新鮮度與撤權。
2. **Durable process／action engine**：human wait、timer、重啟恢復、併發版本、冪等、外部失 ACK、對帳與必要補償。
3. **共同政策與稽核**：同一物件不能在 Object API 被拒絕，卻從 generic Query／Grafana／Python 結果繞過。

本案現行「metadata 可見即可查詢」不在本次研究中被改掉；若要增加物件／屬性限制，須明確確認其對既有 Query 的影響。已授權分析也不代表已授權外部 Action。

Palantir 文件同樣明示：writeback webhook 可能外部成功，但後續 Ontology 修改失敗。[P5] 因此不要把任何流程引擎或 `transaction` 字樣解讀為任意跨系統原子提交；`UNKNOWN` 時不能無條件自動重送。

## 10. 建議元件：重用，不先堆滿整套基礎設施

| 元件 | 建議角色 | 注意事項 |
| --- | --- | --- |
| 現有 DataHub Model／Aspect、Host、Semantic／Discovery／Query | 模型治理與執行前的 metadata／證據基礎 | 不再造一套獨立 Glossary 或改 Core |
| **Mermaid** | class／sequence／state 的衍生唯讀視圖 | MIT；本專案 Pi Web 已宣告依賴。它是 renderer，不是執行引擎或完整視覺化 model editor [G1] |
| **Cytoscape.js** | typed graph 探索、選點展開與證據導航 | 延續前案候選；不因要畫圖就必須裝圖資料庫 |
| **PostgreSQL** | object-owned 狀態、流程實例、事件、action ledger | 與 DataHub 內部庫分離；備份／retention／ACL 與操作批准仍必要 |
| **XState** | 有界 statechart 邏輯、UI 預覽與純狀態轉移 | MIT；**不等於完整 durable workflow service**。持久化與 restore 可用，但官方明示 invocation 可能重新啟動，外部 Action 不可直接隨 restore 重送 [G2] |
| **Temporal** | 確定需要跨程序長時等待、timer、human task、多步外部操作時的 durable orchestration | 流程進入此類需求時就評估，不以長駐 chat 取代；仍需 application-level policy／idempotency／reconciliation，非跨系統 exactly-once 保證 |
| **既有 Sandbox Analysis MCP＋OpenSandbox** | 受控生成 Python／ML 實驗及證據 | 優先抽取／轉接已有能力；鎖版本與映像，重驗生產隔離與生命週期 [G3] |
| **scikit-learn／statsmodels／SHAP 等既有 image 套件** | 分類、回歸、統計、解釋 | 來源 image recipe 已包含，不表示當前部署或任何模型品質已驗證 |
| **Splink 或 Python Record Linkage Toolkit** | 缺少一致鍵時的實體匹配 | Splink MIT、recordlinkage BSD-3-Clause；擇一按資料特性評估，不兩個都裝。結果仍是候選，不能以演算法機率當批准 [G4–G5] |
| **PM4Py** | 有真 event log 後的 process discovery／conformance／object-centric 分析 | 官方為 **AGPL-3.0／另有商業授權**；封閉產品需先作授權評估，不默認安裝。它是 process mining library，不是業務流程 executor [G6] |

新套件本次只讀官方來源與授權，沒有安裝、執行或宣稱與目前 Python／Node 版本相容。OpenSandbox 最新 README 的功能也不能套用成 Grafana 已鎖定版本的能力。

## 11. 最短完整落地路徑

以下「異常訂單 → 調查案件 → 指派 → 外部支援工單 → 成效觀察」只作設計示例；沒有聲稱現場存在這些表、資料或 API。

### A. 一個模型，同時看得懂與拿得到物件

- 選少量已有授權資料的業務型別，確認 identity、property、完整 Link predicate 與 Term／Dataset／Field binding。
- 用官方 metadata extension 保存有界模型 release，工作台產生 class／state 視圖。
- 由真受控 Query 解析一組 object instances，保留 scope／as-of；不是只畫假物件。
- 驗 schema 漂移、舊版本可讀、撤權及多個視圖的一致性。

### B. Agent＋ML 提候選，進入可追溯維護

- 真 Agent 入口產生 Python，Host 傳授權資料到真 OpenSandbox。
- 回傳候選 Link／風險證據，在工作台檢視，按政策核定或拒絕；原始值不因此進入模型 history。
- 在後續來源／證據變更輪次重跑必要比較，使舊候選失效或更新，而不是一次成功就完成。

### C. 真正受控的營運閉環

- 以 ontology-owned 案件／指派起步，實際保存狀態；不是僅有 preview。
- 接一個已批准的外部業務 Action，驗證原生結果讀回、重啟續行、人工等待、衝突／撤權及 UNKNOWN 對帳。
- 由真事件生成執行 sequence/state 視圖，與設計流程比較，最後以 Query／Grafana 觀察結果。

若首例需要跨日人審／外部等待，durable orchestration 在此階段就是必要能力，不應拖到「未來擴充」。**A／B 成功只能宣稱模型與分析閉環；C 的持久化行動與後續變更成立，才接近使用者要求的業務流程管理。**

正式設計前尚需確認的三項產品決策：第一個業務流程與權威 API；Object 細粒度政策如何與既有 Query 相容；資料可向模型揭露的範圍。物化量／freshness／retention 再由選定流程導出，不預設搬移全庫。

## 12. 研究回顧與證據限制

本次最重要的修正是：**以 UML 為同一個 metadata 模型的不同視圖；以 deterministic runtime 承接物件與流程；以 sandbox 承接可變的分析程式。** 三者分工後，Agent 可以自主協作，而不需要成為資料真相、流程記憶或權限引擎。

本次新增評估文件並在前案加入後續澄清連結；未修改產品程式、Grafana 專案、Core 或服務設定。程式碼檢閱能支持整合接點與差距判斷，不能證明新 Object／Action runtime 已可運作。

## 13. 來源

### 本地來源

- [前一版產品／套件提案](datahub-operational-ontology-proposal-20261002.md)。
- [L1] [固定 Core custom metadata model](../../upstream/datahub/metadata-models-custom/README.md)、[官方 model 擴充文件](../../upstream/datahub/docs/modeling/extending-the-metadata-model.md)。
- [L2] [DataHub Query 設計與模型資料邊界](../design/datahub-agent-metadata-query.md)、[Query 歷史真入口驗證](../verification/datahub-agent-metadata-query-native-20260926.md)。
- [L3] [DataJobInputOutput](../../upstream/datahub/metadata-models/src/main/pegasus/com/linkedin/datajob/DataJobInputOutput.pdl)、[UpstreamLineage](../../upstream/datahub/metadata-models/src/main/pegasus/com/linkedin/dataset/UpstreamLineage.pdl)。
- [Pi Web 現有 Mermaid 依賴](../../extensions/datahub-agent/pi-web/package.json)。
- Grafana 以下為**本機另一個 repo 的查閱位置**，不是本案已安裝能力：`/home/timmypai/apps/grafana/CONTEXT.md`、`docs/design/ask-o11y-minimal-source.md`、`docs/design/generic-ontology-core.md`、`ontology-mcp/server.py`、`grafana-query-mcp/server.py`、`mcp_security.py`、`sandbox-analysis-mcp/{README.md,server.py,Dockerfile}`、`docs/verification/opensandbox-request-completion.md`。`context-runtime-before-y5.md` 為 historical，不用作當前架構權威。
- 本次所讀 Grafana Git HEAD：`da4bd54e5d5ae7a0c32b79a709e00d4de0d8ff1d`；實際判斷仍依 working-tree bytes，不假設整個 repo clean。DataHub upstream HEAD：`e99431ec510d7a2001f815c6bf70913c493af76e`。

### OMG 官方規範

- [U1] [UML 2.5.1](https://www.omg.org/spec/UML/2.5.1/About)、[規範 PDF](https://www.omg.org/spec/UML/2.5.1/PDF)。
- [U2] [fUML 1.5](https://www.omg.org/spec/FUML/1.5/About)：Semantics of a Foundational Subset for Executable UML Models。
- [U3] [Alf 1.1](https://www.omg.org/spec/ALF/1.1/About)：Action Language for Foundational UML。
- [U4] [PSSM 1.0](https://www.omg.org/spec/PSSM/1.0/About)：Precise Semantics of UML State Machines。

### Palantir 官方文件

- [P1] [The Ontology system](https://www.palantir.com/docs/foundry/architecture-center/ontology-system)。
- [P2] [Core concepts](https://www.palantir.com/docs/foundry/ontology/core-concepts)。
- [P3] [Action types](https://www.palantir.com/docs/foundry/action-types/overview/)。
- [P4] [Automate](https://www.palantir.com/docs/foundry/automate/overview/)。
- [P5] [Action webhooks](https://www.palantir.com/docs/foundry/action-types/webhooks/)。
- 三份官方白皮書的閱讀與定位，見前案第 2／13 節；本文新增對照上述現行官方產品文件。

### GitHub／套件官方文件

- [G1] [Mermaid](https://github.com/mermaid-js/mermaid)：class／sequence／state 支援與 MIT。
- [G2] [XState](https://github.com/statelyai/xstate)、[Persistence／restore caveats](https://stately.ai/docs/persistence)、[MIT](https://github.com/statelyai/xstate/blob/main/LICENSE)。
- [G3] [OpenSandbox](https://github.com/opensandbox-group/OpenSandbox)：本次原 GitHub 入口導向此 repository；功能／版本須按實際部署核定。
- [G4] [Splink](https://github.com/moj-analytical-services/splink)、[MIT](https://github.com/moj-analytical-services/splink/blob/master/LICENSE)。
- [G5] [Python Record Linkage Toolkit](https://github.com/J535D165/recordlinkage)。
- [G6] [PM4Py](https://github.com/process-intelligence-solutions/pm4py)：README 授權段落及 process mining 說明。

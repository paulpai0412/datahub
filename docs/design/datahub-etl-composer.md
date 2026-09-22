# datahub_etl：Composer 驅動的 DataFlow／欄位 lineage 匯入

- 決策日期：2026-09-21；使用者已確認設計方向並要求依本文開始實作。
- 工作追蹤：`TODO-2db01b81`。本文是交付契約，不是已完成／已部署宣告。
- 實作方式：主 agent；沿用現有 DataHub 擴充架構，不派子代理、不修改 Core。
- 最新執行授權：使用者允許直接在本案 DataHub 進行開發驗證，自行啟停本案服務；保留資料／HOME／歷史，不動其他專案。
- 最新驗證限制：不可 hardcode 案例答案、fixture、fallback、smoke test、mock 或造假。使用實際 ETL 原始碼、真 DataHub 與真 UI；解析失敗不得降級成成功。此前新寫的合成workspace檢查已撤下，結果不計驗收；既有歷史測試不刪除。

## 目前交付狀態（2026-09-22，續作）

- summary 的單表 metadata 可見權限及原生 ingestion 已完成，真 DataHub schema 為 8 欄；不需再 ingestion／執行 ETL。
- 共用解析器現可綁定 `INSERT … SELECT` 的位置、實體欄位、條件與列集合計數；保留 `DELETE` 為獨立 row effect。原 ETL 37/37 欄位分區未變，summary 為 7 個來源欄位分類＋1 個列集合生成分類。
- CLI 包裝不再把 summary 所有步驟壓成一個 Job：目前原入口 4 Jobs、summary 3 Jobs。既有 publisher 已新增來源綁定的 Flow／Job／I/O／欄位 lineage Aspect 編譯；生成與條件證據存於官方 customProperties，不捏造欄位 edge。
- `nativeDiscovery` 的 workspace 分析會讀取原生目標版本、準備保留式差異。真登入後實測原入口 13、新入口 8 項新增候選，沒有 metadata 寫入。這是目前原碼的 Host 函式整合驗證，不是已部署／模型／瀏覽器驗收。
- Composer renderer 已接步驟與 native diff 表格；`datahub-etl.preview/3` 共用條件集合，保留全部證據及既有 56KB bridge／60KB tool 上限。真 Host 結果為 57,973／24,670 bytes；舊版本訊息仍可顯示。
- **尚未完成**：47 個原始掃描缺口的範圍／既有 binder 對帳、view／BI 納入完整發布範圍、自動 Task／Run／Decision 與可信確認、部署、真 Composer 模型／瀏覽器發布／原生讀回／reload。欄位分區及 native diff 均不得當作整體匯入完成。
- 驗證採真來源、真 DataHub、既有原入口回歸；無新 fixture／mock／fallback／測試框架。10 檔 primary LSP、前端 typecheck 與來源／條件 round-trip 通過；render 檢查為 server render，未聲稱 browser E2E。

## 1. 目標與取消項目

使用者在既有 Chat Composer 選 `datahub_etl`，於 prompt 指定 **WSL 上的 repo 目錄或程式**，即可走完：

```text
指定 WSL 路徑／入口
  → 自動界定相關檔案與來源
  → 分析 DataFlow／DataJobs／source-target tables & fields
  → 同一聊天內的 lineage 圖卡、差異與完整性預覽
  → 一次可信人工確認
  → 官方 DataHub API 匯入
  → 原生資料讀回、圖卡更新、重開會話／reload
```

取消使用者手動建立 Task、填 URN、計算 digest、列逐檔 allowlist、撰寫 SQL context mapping、執行準備／發布腳本或切換多個頁面的做法。**不是把舊人工步驟列成一份 skill 就算完成。** 已有 Task／Decision／Run、身分／授權／CAS／讀回仍可作背景實作。既有資產、審核及執行歷史不刪除。

本需求是 **ETL metadata import**，不是跑 ETL。解析不能 import／execute repo 程式，不能執行其 SQL，不能 DDL、DML、安裝 repo dependencies、執行 hooks 或讀取業務資料列。

## 2. 範圍與非目標

### 必交付

- WSL 授權工作區內的目錄／入口選擇；自動建立有界且可重驗的檔案清單。
- 沿用既有 Python／T-SQL／repo 內 BI 定義解析能力；支援範圍與缺口必須逐項可見。
- Pipeline 與邏輯處理步驟，正確的 source／target Dataset 身分、欄位 schema 與表／欄位 lineage。
- Host 自動準備匯入差異，聊天內一次確認，發布後逐 Aspect／關係讀回。
- React 互動關係圖，參考固定版 DataHub Lineage Explorer；完整、部分、未核准及失敗不得混淆。
- 第二個不同命名、真正可執行的 ETL，不改後端、不手寫答案或 mapping 也能完成相同流程。2026-09-22 使用者將原「另提供 repo」改為「生成另一支 Python ETL，在既有 SalesDatamart 新增 summary table 測試」；不得以合成 fixture 代替真來源／實際結果。

### 不新增

不新增 service、datastore、worker、scheduler、outbox、通用 SQL／shell executor、通用 generative-UI 平台或新的 ETL 編排系統。不建立 Grafana dashboard，不把 repo 匯入與固定 ETL 執行混為同一核准。若 repo 內已有 Grafana 定義，分析其可證明的消費關係；不自動索取線上 Grafana 憑證或擴張來源。

任意 Python 動態執行／任意框架的全程式語義分析不作無條件承諾。**不支援時維持未完成並指出具體缺口，不能縮成表級成功來結案。** 實際驗收入口必須有完整欄位 lineage，否則本工作不得完成。

## 3. 使用者旅程

1. Composer 選擇 `datahub_etl`，輸入例如 `將 /workspace/order-etl 納入 DataHub，入口 pipelines/daily_orders.py`。
2. Host 確認目前身分與工作區授權。路徑不是授權；只讀既有授權的 WSL roots，不跨到其他專案／秘密目錄。第一次工作區／來源設定只處理授權與連線識別，不要求每個新程式提供逐語句設定。
3. Agent 協調既有分析工具，自動掃描、追蹤相關依賴並核對 Catalog。只有無法確定的來源識別或入口歧義才在聊天中要求選擇，例如程式的連線 alias 對應哪個已核准 Source。
4. 顯示圖卡、完整性分母與缺項、預計新增／更新／不變／衝突的內容。此時不更改 Catalog 資產關係。
5. 完整性條件成立才提供一次匯入確認。可信 Host／MFE 產生核准內容；Pi runtime、模型文字、skill 或圖卡本身不能偽造授權。
6. Host 重驗身分、workspace、來源快照、Catalog schema／版本、scope 及批准差異，再沿現有 conditional publisher 寫入。
7. 由 DataHub 原生 API 讀回每項實際結果，更新原訊息卡。未知／部分寫入只對帳，不自動重送批次。

使用者不輸入 Task／Run／Agent URN。控制紀錄的建立／綁定由 Host 根據實際 native session 負責，不能以瀏覽器自稱 actor/session 代替。

## 4. 完整 lineage 的可驗收定義

「完整」必須附 **指定入口、選定範圍、快照、分析版本、schema 版本與排除項目**，不是對任何 repo 的無界宣稱。不能只計算已解析節點而隱藏未解析分母。

| 層級 | 必須證明的內容 |
| --- | --- |
| Source capture | 相關來源檔案皆已納入；清單不能静默截斷；缺失 import／動態載入／漏掃均列 blocker |
| DataFlow | 穩定 pipeline 身分、實際入口、程式來源與版本；不是把每個檔案都當一個 Flow |
| DataJob | 真實邏輯處理步驟、Flow 包含關係、必要 step dependencies；helper call 不直接等於 Job |
| 表級 | 所有讀入、寫出、中介資料與最終目標均有正確方向與可追溯依據；不得所有 source 連所有 Job |
| Schema | source／target 表與欄位身分、大小寫、quoted identifiers、型別來源；Catalog 觀測與程式／DDL 宣告明確區分 |
| 欄位值 | 每個預期輸出欄位皆有可定位實體 origins、完整多輸入集合，或證據充分的 constant/generated 分類；不能給生成欄位編造來源 |
| 條件 | Join、filter、group／window 等影響選取或計算的條件另列證據；不能混成純值傳遞，更不宣稱為可信業務 Join |
| 可追溯 | 每個節點／edge 有實際相對檔名、位置、內容digest及分析方式；沒有手寫案例答案 |
| 原生儲存 | 預期的 Flow／Jobs／schemas／I/O／table／fine-grained lineage 皆與 DataHub 讀回相符 |

預覽呈現 expected／resolved／generated／unresolved 等集合及分母，集合須互斥且覆蓋預期範圍。缺口、schema 衝突、來源識別歧義、被截斷清單、缺少回讀任一項，均不得顯示 `COMPLETE`。完整 metadata lineage 不等於已執行 ETL、transaction snapshot 或業務正確性認證。

## 5. DataHub 儲存與穩定身分

- DataFlow：pipeline；DataJob：步驟，沿用原生 Flow／Job key 與 I/O／依賴契約。
- Dataset：實際 platform instance／database／schema／table／env；同名不同來源不得合併。
- Fields：`schemaMetadata` 及其原生 field paths／schema-field 身分。
- Dataset／column lineage：沿官方支援的 upstream／fine-grained lineage 結構；必要 Job 關係沿原生 I/O 契約。
- 已有 schema 優先對照／重用。新 schema 只能來自有權限的 metadata 觀測或可解析宣告；不得推測缺少型別、欄位或物件存在性。
- 人工描述、ownership、tags、terms、既有無關 edges 不覆寫。不支援的合併／所有權衝突必須在相同預覽中阻擋／說明，不能偷偷接管。
- 同一輸入再次預覽應得到穩定身分與可辨識的不變項，不產生另一套重複資產。失敗／未觀測到不能自動刪資產。
- 不新增 datastore。DataHub 保存資產與既有控制紀錄；Pi 原 session 保存展示／引用。圖卡不是第二份 metadata 權威。

## 6. 圖卡與 Composer

新增一個第一方 ETL import 訊息 renderer，不新增通用 UI block 框架。

- 視圖：流程、表級 lineage、欄位 lineage、差異／證據。
- Flow 用包含容器；Job 相依、表／欄位資料流使用不同的邊型別與圖例。
- 欄位展開、搜尋、上游／下游高亮、縮放／全螢幕、點節點／連線看證據、原生 DataHub 連結。
- 表格等價資訊／鍵盤操作；不要只有顏色代表狀態。
- 預覽與原生回讀是不同狀態。卡片標示 as-of，重新開啟須按目前權限取得狀態；新舊結果不可互相冒充。
- React renderer 只接受有版本的 Host 結構化結果，不執行模型生成 JSX、HTML 或程式碼。
- 使用 React Flow 類型的關係圖，參考 `upstream/datahub/datahub-web-react/src/app/lineageV3/`，不直接依赖 Core 私有 context／React 元件。不修改 Core。
- 對外入口為使用者指定的 `datahub_etl`。Pi skill 標準名稱僅允許小寫／數字／hyphen；實作採標準相容的 `datahub-etl` skill 識別，Composer 顯示 `datahub_etl`，避免改動 SDK 的命名驗證。必須驗證真正載入與選用，不以標籤出現代替 skill 生效。

## 7. 沿用的實作位置與已知缺口

| 現有接點 | 本次責任 |
| --- | --- |
| `extensions/dataflow-discovery/src/dataflow_discovery/snapshot.py`／`host.py` | 既有安全快照；補 WSL 目錄的自動有界清單，取消逐檔人工選單，不放寬 symlink／secret／漂移防護 |
| `analyzer.py`、`python_*`、`catalog.py`、`publisher.py` | 重用解析／身分／來源證據；補 schema-resolved 欄位映射及完整性評估，不建立另一套通用parser |
| `extensions/datahub-agent/integration/` | 既有身份／來源／Task／Decision／conditional publisher；接完整 import lifecycle，不讓 caller 提供 Aspects、endpoint、憑證或任意命令 |
| `extensions/datahub-agent/pi-web/` | 第一方 skill、工具呈現、Composer import 圖卡與既有 session 持續化 |
| `extensions/datahub-agent/mfe/` | 可信確認與既有 Host bridge；舊 Tasks／手動 import 面板已移除，不再要求操作 Tasks 面板才能匯入 |

原始基線的 `nativeDiscovery` 只接受預先登記 source／snapshot／SQL contexts；SQL 欄位候選多為 query-local inferred，publisher 不會把它們當完整實體欄位。以下候選實作不改變完整性與原生驗收要求。

### 2026-09-21 候選進度：尚未部署／未完成

- 既有 Host／Python bridge 新增 workspace 分析入口，沿用授權 roots、快照、解析器及真 Catalog reader；連線選擇是 Host scope ID，不是逐 SQL mapping。來源、入口或 scope 不明時明示阻擋。
- 新增標準相容 `datahub-etl` skill、`datahub_etl` 工具與 Composer 顯示名稱；接既有 Discovery 通道。SDK skill 解析與 TypeScript 檢查通過，**尚未驗證運行中 Composer 真正選用及模型呼叫**。
- `DataHubEtlPreview.tsx` 接版本化 Host 結果，提供初步 React SQL I/O 鄰接圖、搜尋／縮放、schema／證據與等價表格。明示未匯入、INCONCLUSIVE、分母未成立；不是完整 Flow／Job／欄位圖，也尚無差異、可信匯入確認、原生連結／讀回或重新授權刷新。未新增圖形依賴或通用 UI 框架。
- 實際 ETL 經固定 Node → Python Host 路徑：4 個來源檔、2 個連線、25 SQL contexts、38 節點／37 個 SQL I/O edges。使用的是 2026-09-21 11:20 UTC 的真 Catalog 觀測，不是新的 live read；程式／SQL均未執行、metadata 寫入為零。
- 真實 Host 結果通過 renderer 格式核對與 server render。最初 React SVG title children 警告已修正並重驗；原產物保留。此證據不等於瀏覽器互動、會話 reload 或 Agent E2E。
- 使用者已移除 cc-safety-net；無害的原生工具檢查已通過，不再要求重新載入，也不重新安裝。使用者另明確授權讀取現有 `.local/user.props` 供本機登入；未輸出密碼、變更憑證或權限。
- 認證重驗於 **2026-09-21 14:36:12 UTC** 成功：13 個 Dataset、16 個 Catalog 請求、1 次登入，25 SQL contexts／2 組連線／56 個欄位宣告。證據 `source-connection-live-{catalog,result}-validated-contract.json`。前兩次在登入前停止的紀錄保留；原因分別為驗證指令不符本案既有的 0644 檔案契約，以及錯用 `=` 而非 `:` 憑證格式；登入路徑也已依既有契約更正為 `/logIn`。沒有 SQL 或 metadata 寫入。
- 既有 `python_sql.py` 已補上 generator 的延遲作用域與已識別 `list`／`tuple` 消費追蹤；真 ETL 的 4 處 generator 均在 `list(rows)` 處追蹤成功，25 個 SQL 使用位置／連線綁定不變。未知消費、重複消費、async 與未消費情形仍不認證。證據 `generator-consumption-real-source.json`、`field-analysis-after-generator-consumption.json`。
- 固定 Node → Python bridge 重驗通過，表／schema／37 條 I/O 拓樸不變。context ID 綁定 trace digest，因此新的追蹤證據使 25 個 ID／candidate digest 正當更新，不能沿用舊批准或把 ID 宣稱未變。證據 `workspace-preview-after-generator.json`、`workspace-bridge-after-generator.json`；不是瀏覽器或 authenticated Host endpoint 驗收。
- 仍有 `sql_process_unmatched` ×1、完整 output-origin partition 與 DataFlow／Job 發布計畫缺口。137 個未解析值宣告未因 SQL generator 修補而消失；37 個 schema fields／56 個 slots 仍不是完整性分母。控制 SQL 的 `EXEC @result = …` 已確認不受目前 SQLGlot 30.12.0 解析支援，不能忽略後判完整。背景 Task／Decision／Run、匯入確認及 native readback 也仍未完成。
- **歷史停止點，已由下列續跑取代**：直接分析真實 `_execute_many` helper（沒有呼叫端連線）時，`describe_python_connections` 曾對 `connection: null` 呼叫 `.get()` 而失敗。原始 `generator-real-helper-unbound-failure.json` 保留，不以正向結果覆蓋它。

### 授權續修後的目前進度：靜態欄位分區成立，全流程仍未完成

使用者要求持續修正、不再詢問例行開發決策；不取消可信匯入核准、來源授權或禁止執行來源的限制。

- null 連線已在 owning function 修復，真 helper 回傳 0 connections／1 unresolved，`run_etl` 保留 2 connections／25 contexts。`null-connection-recovery.json`。
- `sql_dialect.py` 是固定 SQLGlot 的窄相容 Adapter：使用公開 tokenizer／parser／AST 描述 application-lock 控制批次；未知程序或混合資料改寫仍拒絕。普通 SQL 使用原解析器。compiled Parser 不能繼承的失敗候選已封存，未修改套件或 Core。
- 重用既有 Python expression／decoder／consumer／lookup 模組，區分 returned-value、條件與 evaluated arguments；只對有來源證據的純量運算、helper 回傳及 lookup 值建立靜態 origins。未把「呼叫過參數」改名為返回值來源。
- `field-analysis-typed-partition.json`：真實 4 檔來源 + 既有 native Catalog receipt，56 個寫入 slots；以所有目標原生 schema 建立 **37 欄位**分母，27 source-linked、7 宣告型日曆生成、3 未證實的省略欄位，完整性仍 false。沒有把 56 slots 當成 56 個獨立欄位。
- `field-analysis-application-partition.json`：自動捕捉同一授權專案的 13 檔目錄，快照 `111a4f551124c8aac8b39891126d7f10ce1d59e86c7d89be26e4c5a0ec86e11f`；原 4 檔位元不變，依同一 factory 宣告重綁既有 scope，沒有手寫欄位答案。3 個省略欄位在捕獲的 CREATE TABLE 有 IDENTITY 宣告，且欄位集合／SQL 型別與 native schema 一致。**指定 Python 入口的欄位宣告分區為 27 source-linked + 10 declared-generated = 37，無缺欄位。**
- 生成資訊保留來源／位置／hash：日曆的起訖是捕獲 frozen dataclass 所宣告的參數邊界，未驗證執行期值；月份文字標示 locale-dependent。IDENTITY 是 DDL 宣告，不冒充已套用 DDL／實際資料庫生成行為。SQLGlot 不支援的 provisioning／seed 語句仍有原始警告，沒有當成已理解或執行的步驟。
- 上述均是 **實際 source + 2026-09-21 14:36 UTC native Catalog 觀測的離線重現**。不是新的 live read，不是完整 repo／Flow／Job／BI 消費關係、Composer、發布或 browser 驗收。輸出分区有界的 `complete` 不等於整體匯入 `COMPLETE`；`publication_authorized` 仍 false。
- 17:07 UTC 唯讀核對 active policy：root／4 檔路徑／model-context scope 未變，尚未啟用 workspace policy；沒有原生請求、設定變更或 metadata 寫入。`active-policy-read-only-reconciliation.json`。
- 待完成：步驟／全部 I/O 與條件證據、穩定 Flow／Job／native preserving diff、背景 Task／Run／Decision、圖卡與可信匯入、原生讀回及 reload；第二個已授權真 repo 仍未取得。七個 Host／前端檔案仍需以現行 bytes 核對；舊 typecheck 不是當前驗收。

### 2026-09-21 23:13 UTC：目前傳輸／條件證據，仍未完成

- 候選預覽升為 `datahub-etl.preview/2`：graph edge／欄位來源以同一不可變預覽中的 node index 引用，原生 URN／schema 留在 Dataset 節點；生成宣告共用、snapshot/file hashes 沿根 manifest 綁定。renderer 仍接受既有基本 `/1` 訊息，不修改歷史。
- 49 個 source gaps 分為 11 組；每個 candidate、原因與位置仍保留。真資料 round-trip 與原 49 項相等，37 條 SQL I/O edges 展開後也相等。沒有截斷缺口或提高 56,000-byte Python／60,000-byte tool cap。
- 原 74,663-byte 預覽不可通過傳輸。之後 55,401-byte compact 預覽仍曾被 bridge 拒絕，因 bridge 實際計算並輸出含空格的 58,480 bytes；`workspace-transport-spaced-overflow.json` 保留此失敗。bridge 現在對同一份 compact 序列化 bytes 檢查及輸出，沒有 fallback。
- SQL projection 原先只追 SELECT 值來源，漏了 JOIN／WHERE／ORDER 等選取欄位。現在使用 SQLGlot 已 qualified scopes 另行描述條件欄位、AST digest 與參數名稱，經 decoder／lookup 傳到 target field 的 **condition origins**；不混進 value origins。未拆解的 CASE／window 值／條件角色保持拒絕，不把完整 predicate 語义或業務 Join 宣稱已驗證。
- 真 `_FACT_SQL` 對應 `linenetamount` 的值來源仍是 OrderQty／UnitPrice／UnitPriceDiscount；SalesOrderID、OrderDate、Status、CurrencyRateID 與排序欄位另列條件。`field-analysis-sql-conditions.json` 保留 37/37 靜態欄位分區及原 75 宣告 finding，不是完整來源或 runtime 驗收。
- 最新 `workspace-application-condition-compact-v2.json` 為 **55,689 bytes**；`workspace-transport-condition-v2.json` 證明實際 source → Python stages／固定 Node bridge 結果一致、renderer guard 與 server render 通過、缺口／I/O 無損。當前 TypeScript 檢查、Node syntax check 及 7 個 scoped primary-LSP 檔案通過。卡片顯示有界分母、生成宣告、值來源、條件欄位及全部 source gaps。
- 此輪仍使用 14:36 UTC recorded native Catalog，沒有登入、來源／SQL 執行、metadata 寫入或 active policy 變更。**沒有 browser／真模型／native publication／reload acceptance**。Flow／Job preserving compiler、完整條件語義與 BI coverage、可信 import lifecycle、其餘 Host drift／真入口及第二 repo 仍待完成。

證據位於 gitignored `.local/evidence/datahub-etl-composer/`，不作第二份業務狀態權威。

### 2026-09-22：工作步驟／view／BI 宣告與第二個實例

- `python_jobs.py` 依選定入口的實際呼叫／record transport 辨識 4 個資料處理階段，而非每個 helper 一個 Job；24 個 SQL context 有 Job 主責，1 個 lock control 另列。穩定識別不包含行號／snapshot；執行順序、可成功路徑與 observed execution 不混淆。
- `sql_views.py` 重用 SQLGlot／原生 schema binder：捕獲的報表 view 5 個來源、24 個輸出欄位成功綁定，不宣稱 DDL 已套用。Grafana 的 7 個面板／2 個變數查詢共 18 個輸出已作靜態來源描述；原生 query metadata 的 datasource_uid／upstream 與既有 scope 連結，不以相同 database 名稱猜身分。
- MSSQL `$__timeFilter` 與 `:sqlstring` 使用符號參數表示，不以 TRUE、假日期或假值取代。CASE 的測試與返回值、window keys 與值分開；未支持的衍生條件仍拒絕。`field-analysis-workflow-bi-declarations.json` 重用既有原生 receipts，沒有 fresh native／Grafana 讀取。原 37 欄位 partition 與前次完全相同；75 findings 未刪除。這些描述尚未接進 preserving compiler／Composer，不是全來源完整宣告。
- 使用者改以新 `summary.py::run_summary` 和 `sql/004_create_monthly_category_summary.sql` 作第二個實例：月初日期＋產品類別為粒度，讀現有 fact／date／product，僅新 summary table 允許 refresh。原 ETL 與原表不能重跑／覆寫；metadata import 不取得 SQL 執行權。
- 使用者隨後明確核准既有容器受保護 SA 的限定建表與原 loader 的一次新 ETL。新表已建立一次；原生讀回確認 8 欄位、複合主鍵、無 trigger。產生的前置／讀回指令曾誤用 DATABASEPROPERTYEX 屬性、保留字 alias 及 sqlcmd 輸出寬度；失敗均保留，只修正唯讀核對，沒有重送 CREATE。
- **歷史 runtime STOP（已由下列新授權修復，原失敗保留）**：首次新 ETL attempt 回傳 `TypeError / FAILED_PRECOMMIT`，程序 exit 1。唯讀對帳確認 summary 0 rows、loader 0 sessions、application lock 可取得。原碼顯示固定 sqlalchemy-pytds 0.3.5 的 isolation 設定呼叫 `autocommit(False)`，但 python-tds 1.17.1 是 bool property；與症狀相符，但原始安全 receipt 沒有 traceback，不能宣稱已觀測確切失敗 frame。當時停止且未修復／重跑；後續只有在下述新授權下才恢復，不能降低隔離、改套件或重播舊 ETL。
- 可信 operator 的新表準備／執行與 Composer 單次 metadata 匯入核准分開；沒有權限／密碼變更、DataHub metadata 寫入或 Composer 驗收。證據 `summary-ddl-reconciliation-complete-20260922.json`、`summary-etl-attempt-20260922.json`、`summary-etl-stopped-reconciliation-20260922.json`。
- 新檔案改變 workspace capture；先前 13 檔／55,689-byte preview 是歷史已驗證快照，不能冒稱含新程式的當前預覽。仍需全範圍缺口核對、preserving native plan、Task/Run/Decision、部署、真 UI 確認／發布／回讀／reload。

### 2026-09-22 02:00 UTC：summary 真實執行恢復；六項匯入仍未完成

- 使用者明確同意修復並額外執行新 summary ETL 一次；重申六項要求後，又確認第 6 項沿用新 summary ETL，不宣稱跨 repository 已驗收。
- 真實唯讀連線 probe 重現 dialect 的 `TypeError` 及實際 stack frame；公開 `pytds.connect(isolation_level=ISOLATION_LEVEL_SERIALIZABLE)` 經兩條獨立連線核對 SQL Server level4／SERIALIZABLE。未修改套件、Core、憑證或權限，也不是失敗後降級／fallback。
- 修復僅在 summary 的既有 engine 建立處改用該公開參數，並核對工作／fresh readback 連線的實際隔離。新核准 attempt exit0、`COMMITTED_READBACK_VERIFIED`，140 筆 summary；75,284 lines、quantity178,425、net/source total72,418,506.319091，transaction內精確 group 差異及 fresh readback 通過。CREATE 未重送，舊 ETL 未重跑。
- `summary-isolation-recovery-probe-20260922.json`、`summary-etl-authorized-retry1-20260922.json` 保留新證據；舊 TypeError 與產生的驗證指令失敗不覆寫。這只是實際測試來源資料就緒，不是六項 metadata import 驗收，仍無新 DataHub metadata 發布。

### 2026-09-22 03:53 UTC：最新原碼重驗與原生 Source 範圍缺口

- 最新 15 檔快照仍為 `a4ebf27fb50d70735d902ea2dd211c907c71d9b305c888448787ddddcb818609`。共用 closed module SQL 宣告解析、AST identity 防止片段誤綁，以及窄範圍 XACT_ABORT／LOCK_TIMEOUT 控制分類已重新跑真來源：47 個 source-gap candidates；原入口 2 connections／0 trace-unresolved，新 summary `main` 入口 1 connection／0 trace-unresolved。這些數目不代表完整欄位或 whole-program 語義。
- 原入口仍有 25 SQL contexts、56 slots、4 Jobs；37/37 靜態欄位分區的 value origins、condition origins、generation 宣告與前次相同。75 個宣告 findings 與不支援的 seed／provisioning 警告保留；view 24 fields、7 panels＋2 variables 共18個 query outputs 保持。真 `_execute_many` 無 caller 檢查仍回傳0 connections／1 unresolved，不再拋 null 例外。8 個相關 Python 檔案 primary LSP 無診斷。
- 上述欄位重驗重用已保存的原生 Catalog，不是 fresh schema／Grafana／UI 驗收；證據 `workspace-control-classified-scan-20260922.json`、`field-analysis-control-classified-20260922.json`、`current-static-regression-20260922.json`、`current-unbound-helper-recheck-20260922.json`。
- 新的真 DataHub 唯讀核對：summary Dataset 尚無可用原生 schema。既有 SalesDatamart ingestion Source（版本1、CLI1.7.0.9）僅允許原5張 dm表與既有 reporting view，**table allowlist 未包含 `monthly_category_summary`**；profiling／stateful ingestion 均關閉。原 Source 不改範圍而重跑，也不會涵蓋新表。證據 `summary-native-catalog-read-20260922.json`、`summary-source-scope-read-20260922.json`；未讀 Secret API、未改 policy／recipe、未提交 ingestion 或 metadata 寫入。
- 建議限定新增該表到既有 Source allowlist，再執行一次官方 metadata-only ingestion；此操作尚未執行／核准，與最終 Composer lineage 匯入確認分開。不得由 SQL 表建立／ETL 成功推定 DataHub schema 已存在，也不得重播已消耗的 CREATE／ETL。
- preserving 原生完整計畫、summary INSERT SELECT 欄位綁定、Task／Run／Decision、當前有界傳輸及真 Composer／發布／讀回／reload 仍未完成。此次重驗不是六項工作交付。

### 2026-09-22：選定入口範圍對帳、view／BI 與完整差異重編譯

- 前述 summary schema 缺口已解除：單表 VIEW DEFINITION 與一次另行核准的 metadata-only ingestion 完成，原生八欄已讀回；不是待重播的操作。
- 原始 47 個 scanner 項目全數保留。以實際 SQL-use／寫入欄位綁定證據逐項對帳：原入口 9 項綁定、38 項在該 Python 入口外；summary 為 2／45。這不代表 provisioning 或其他入口已解析／執行，完整性仍限定 selected Python SQL I/O。
- 既有 view／Grafana binders 已接入 workspace 與 compiler：view 24 欄、9 個 BI 查詢／18 輸出；7 個 panel 的原生 datasource/panel 身分、格式化查詢、schema、表與欄位 lineage 均由公開 API 新讀取後核對。兩個變數查詢只作宣告，不捏造 Dataset。不是 live Grafana 執行或 DDL 驗證。
- view lineage 納入 desired Aspects；真 native preserving diff 證明它無需改寫。原入口仍為 13 項新增、summary 8 項新增；既有 view 的 metadata 保留。來源／條件／生成／原始 scanner 資料與上一版逐項相同。
- 為符合既有容量，wire 省略 SQL 節點本來就是空的 schema 陣列；Python 內部仍保留正規形狀，避免在引用處理前移除造成 KeyError。bridge 分別 55,859／23,478 bytes，仍低於 56,000；來源證據未截斷。相關宣告共用重複條件後完整 round-trip 相同，真原入口 publication review 129,198 bytes，未提高 131,072 上限；先前超限拒絕紀錄保留。
- `workspacePublicationCompiler` 接續既有 Task publisher 的 callback 契約，保留 Host 選定來源並重新讀取／編譯完整差異，不接受 review 子集。真來源重編譯相等；用真 summary 入口套用原入口 review 被拒絕。這不是已接好自動 Task／Run／Decision，也沒有任何 lineage 發布。
- 證據：`composer-related-live-verified.json`（114 次 native reads）、`composer-workspace-recompiler-live.json`（109 次 reads）、`composer-related-compact-review.json`、`composer-related-final-render-check.json`。兩次有登入的 read-only 操作以真 cookie／identity verifier／原生 API 進行；不是模擬 Gateway grant、瀏覽器或模型驗收。前端型別檢查、六檔 primary LSP、Node syntax 與真報告 server-render 通過；lens-all 只覆蓋一個快取檔，非全案安全檢查。
- 唯讀 active policy 對帳：原入口已有一個能涵蓋 13 Dataset 的 Task Source；summary 所需 7 Dataset 無合格 Source。SalesDatamart Source 現有 Task 範圍是 7 個 Grafana query Dataset＋view，缺少 6 個 dm Dataset；不可把「DataHub 中存在」當作 Task 寫入授權。尚未修改此政策。
- 剩餘：自動 Task／Run／Decision、同一聊天可信確認、發布／原生讀回／reload 與部署後真 Composer 旅程。開發部署沿用已核准授權；新 Task 範圍需明確處理。原 CREATE／ETL／ingestion 不重播，metadata writes=0（本輪），Core 未改，TODO 保持 open。

### 2026-09-22：同聊天 Task 接線與開發部署（仍未完成匯入驗收）

- 沿既有 `native-tasks`／`task-records` 接入 `prepare_workspace_import`、`respond_workspace_import` 與唯讀 `read_workspace_import`。Host 以真 native pending UI/session 綁定自動 Task／Run／Decision；只接受分析意圖，Aspects 仍由來源 compiler 產生。Registry Agent／Task Source 必須唯一且符合可見／核准範圍，不硬編碼案例 URN。
- 可信父頁的「Approve and import lineage metadata」明確包含發布行為；一般舊 Decision 仍只記錄答覆。發布沿用現有 ACL、來源重編譯、所有權／adoption、CAS、一次性 attempt 及 native readback。原 attempt 或準備中斷不可自動重送；`read_import` 只讀回，不恢復寫入權。
- Owner 分別核准的六個 dm Task Dataset 及新 workspace 已套用。新 workspace 僅 `/home/timmypai/apps/datahub/extensions/sales-datamart`，保留舊9檔固定 snapshot；不是開放整 repo、`.local` 或來源憑證。真預檢首次因部署根本沒有 workspace 授權而拒絕，原紀錄保留；新增範圍後 140 次 native reads、原入口13／summary8項差異與重新編譯相等，0 Task／lineage／SQL 寫入。
- 限定 root 改變來源相對路徑及識別，新 snapshot 為 `0ec5bbec57731c69c9061bbf73575255b333124c1364b5d0788908b2d98ab76e`；逐檔內容 hash 與已驗來源相同。舊 scope 的 review／IDs 不當作新 scope 核准。
- 7檔 primary LSP、前端 `tsc --noEmit`、MFE build、受限 runtime build 與 exact-image browser artifact gate 通過。runtime image 為 `sha256:51e03fa8906dd11606809ee77e6997e3ca95dbba48cf15a697df6063e04515aa`，專用 builder 已停；新 Agent gateway 已啟動。僅移除已 exited／PID0／原映像及 owner 確認相符的舊容器，具名 HOME volume／session 保留，Core 未改。
- 首次真 Composer/model 已成功 `list_workspaces`；模型將 `pythonPath` 傳為絕對路徑而非 Host 的 workspace 相對路徑，得到 `409 discovery_workspace_rejected`。原 session `01a0c81e-4fb6-77c3-84eb-7cceb65a1302` 的參數、錯誤及 idle/empty-queue 讀回保留。依 owner 的 LLM 參數錯誤規則只在同一 session 更正輸入，不重播未知寫入；尚不可宣稱完整 browser／發布／reload 或第二例驗收。
- 證據位於 `.local/evidence/datahub-etl-composer/`：`composer-import-host-verification-r2.json`、`composer-workspace-policy-applied.json`、`composer-artifact-check.json`、`composer-runtime-recovery-{before,after}.json`、`composer-live-browser.json`、`composer-failed-session-readback.json`。最後狀態以 canonical checkpoint 為準；本段不代表已取得最終 lineage 同意。

### 2026-09-22：兩個真入口完成可信發布與讀回

- 同一 Composer session `01a0c81e-4fb6-77c3-84eb-7cceb65a1302`：原 `run_etl` 及第二例 `summary.main` 均經真模型分析、React 圖卡、自動 Task／Run／Decision 和**各自的人工確認**。兩次發布分別13／8個 Aspects，皆 `VERIFIED_CURRENT_VALUES`；後續 `read_import` 分別13／13、8／8 `MATCHED_CLAIMED_ATTEMPT`。沒有重送發布或執行 SQL／ETL／ingestion。
- 原入口37／37、summary8／8靜態輸出欄位宣告，以及2個 DataFlow／7個 DataJob 的原生值與來源證據讀回一致。所有47個 scanner findings 留存並對帳選定入口，不代表全 repo、執行期或業務語義均已證實。
- 重新開啟同一 session 可展開兩組 Flow／Jobs 圖卡；整個 DataHub 父頁 reload 後亦恢復相同 session。初次腳本誤等收合的 Process details 內部圖卡而 timeout，當次0 prompts／0 Task／lineage writes；讀回確認資料完整後修正操作定位，不改產品或重播發布。首輪 browser driver 過早 Stop 造成的一次唯讀 `read_import` 取消亦保留；原發布結果完整，後續真正唯讀對帳已成功。
- 發布後另外以原生 API 比對7個 SalesDatamart Datasets：除5個已核准的 `upstreamLineage` 外，65個 Aspect slots 與先前觀測相同（29個有值、36個仍不存在），包含 schema／properties／人工 metadata 位置及既有 view lineage；不把原本不存在的人工內容說成已測過內容合併。
- 真實證據：`composer-live-browser-r2.json`、`composer-live-browser-summary-r2.json`、`composer-original-live-read-import.json`、`composer-summary-live-read-import.json`、`composer-final-reload-readback.json`、`composer-post-publication-preservation.json`。兩次 attempt 都已消耗，後續只能讀回／對帳，不能自動重送。
- 當前37檔來源與已驗 build 一致（本文件更新前逐檔核對無 drift），Core 乾淨。最後 lens-all 無 blocking errors；`task-records.mjs` 的 EOF 之外 TS1128 與既有 client callback TS71007 仍是已記錄診斷限制，当前 Node syntax 通過，未為消除舊警告修改正確程式。
- 完成範圍為這兩個已授權入口的 **Composer metadata 匯入閉環**；不是任意 Python／全 repo／跨 repository 支援或執行期、可信 Join 的通用驗收。既有 summary 真 SQL 執行證據仍獨立保留，不能拿 metadata 發布代替 SQL 執行證據。

### 2026-09-22：發布後重複分析的 preservation 比較修復

使用者重新分析同一已發布入口時，`mergeWorkspaceAspect` 把 SDK／API 的 `dataJobInfo.type` union 值（`{"string":"COMMAND"}`）以 JavaScript `!==` 比較，錯把相同 JSON 內容的不同物件參照當成衝突。這不是 snapshot、權限或來源變更。先前首次發布／read_import／reload 驗收沒有覆蓋「已發布後重新分析」；不能把舊驗收擴大為此情境也已通過。

- 修復只在 Host 對既有 name／type／flowUrn／env 的比較改用既有 canonical JSON，沒有刪除 preservation 檢查、接管 metadata 或轉寫原生值。
- 真 native 資料重現：原入口4個、summary3個 Job 均觸發舊錯誤。修後兩入口分析分別14／9個 Aspect 全不變、0項更新；拿兩個真正不同 Job 的名稱比較仍拒絕，原物件也未被修改。
- Host gateway 已在 idle 確認後重啟，runtime image／HOME／舊session保持。相同真 Composer session 再經模型及部署 API 分析，HTTP200／FIELD_ANALYSIS、14項不變、圖卡可見，沒有新 Task、發布或 SQL／ETL／ingestion。這是分析回歸，不是重送原核准。
- `.local/evidence/datahub-etl-composer/preservation-repair-{before,after}.json` 保留前後實驗；`preservation-browser-deployed.json` 為部署旅程。可用 `node .local/evidence/datahub-etl-composer/check-preservation-repair.mjs after <新的紀錄標籤>` 重跑唯讀實際來源檢查，產物採 exclusive-create，不覆蓋舊證據。
- 沒有待更新差異時不需再次核准；若另呼叫 `import_workspace`，既有 Host 仍以 `workspace_no_changes` 拒絕建立空發布。本次未改這個保護或擴大到新的發布。

## 8. 實作與驗證順序

1. 完整性與有界來源輸入：自動捕捉 WSL 選定範圍；直接以已實際執行的ETL原始碼與真DataHub核對，不建合成repo或mock；保留既有呼叫契約。
2. 實際欄位／步驟證據與原生匯入計畫：自動 scope／Catalog resolution，完整性預覽；不得只接漂亮空圖。
3. 同一 native chat session 的 skill／Host 核准／import／readback 接線，以及結構化圖卡。
4. 真瀏覽器旅程與原生 DataHub readback。依使用者最新授權操作本案開發服務與限定測試資產，記錄確切切換及寫入目標；不使用已消耗的一次性ETL批次授權，不執行業務SQL，不擴張到其他專案／私有來源。新增來源／敏感資料存取若超出已授權範圍仍需確認。

驗證覆蓋：不同命名的真 ETL 入口（第二例依最新決定為 SalesDatamart summary）、跨檔依賴、CTE／alias／多輸入表達式、常數／生成欄位、未知動態來源、schema歧義、workspace逃逸與symlink、含密檔案、加入／刪除／修改來源、重複輸入、過期／跨actor核准、部分寫入／未知結果、reload與訊息回放。

## 9. 完成線

- 使用者只在 Composer 提供 WSL 路徑及必要的一次歧義選擇／匯入確認，不執行私有腳本。
- 真入口完整 source／target fields、Jobs、Flow 及 lineage 均存入 DataHub；逐項回讀一致，沒有被掩蓋的 unresolved。
- 圖卡呈現已匯入的實際關係，reload／會話恢復一致且不重播寫入。
- 第二個真實 summary ETL 不需修改後端／加入案例答案或手寫 mapping 即可完成同一旅程，並以真新表與原生 schema 觀測驗證；不冒稱已完成跨 repository 驗收。
- Core 乾淨、既有 metadata／歷史保留；未增加本案禁止的服務、儲存或任意執行能力。

禁止以fixture／mock／smoke test作本輪實作或驗收替代，也不得hardcode案例結果或使用fallback掩蓋缺口。schema-valid JSON、build成功、局部欄位分析或漂亮圖卡都不能單獨滿足完成線。未取得必要live授權或仍有欄位缺口時，明確記為未完成，保留下一步而非宣布交付。

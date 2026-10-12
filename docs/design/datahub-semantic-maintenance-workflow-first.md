# DataHub Agent 語義維護：流程優先設計

日期：2026-10-03  
狀態：**主流程已有實作與部署；完整真入口驗收仍未完成。2026-10-05 受控未核草稿修訂及整體自查已取得方向確認，目前僅本地實作／合成驗證，未部署。**  
方向：先交付完整建立與維護流程，不先建置完整 policy 系統。

## 1. 決策與完成目標

使用者最新要求：

- 不只是盤點或補描述；Agent 要新增並維護 Domain、Glossary Group／Term、Tag、Structured Property 等原生資料。
- 不要求使用者先手工寫好全部名稱、描述與分類，再由 Agent 搬運。
- 不先增加大量 managed／AUTO policy、逐目標授權名單與反覆批准程序；先讓流程真正完成，後續有具體需求再補治理。
- **整批計畫一次確認，再由可信 Host 依序建立與套用。** 此方式已由使用者選定；不是預覽限定，也不是模型自行批准。

第一版完成線：

> 使用者指定範圍與維護目的 → Agent 讀取現況／證據 → 提出完整定義、階層及套用差異 → 真人一次確認整批計畫 → Host 實際建立／更新／套用 → 原生與 UI 讀回 → 後續變更再比較、維護。

不以盤點數、報告、PENDING、單個 Term 或只有 description 的成功代替整個流程。需要首輪及真正後續變更輪次的驗收。

本設計取代[原代管提案](datahub-semantic-agent-automanagement-proposal.md)中「先設定獨立 managed／AUTO policy，才能啟動完整維護」的第一版順序。原提案保留為歷史與未來治理參考；不表示現行程式已變更。

## 2. 功能範圍

### 2.1 真正建立的原生資料

| 類型 | 第一版須完成 | 原生承載 |
| --- | --- | --- |
| Domain | 新增領域、名稱、說明及需要的父子階層；維護本輪明確選定的既有定義 | `domain`／`domainProperties` |
| Glossary Group | 新增群組、定義及父群組 | `glossaryNode`／`glossaryNodeInfo` |
| Glossary Term | 新增詞彙、定義及所屬群組；重用或更新明確選定的既有詞彙 | `glossaryTerm`／`glossaryTermInfo` |
| Tag | 新增、重用及維護標籤的名稱與說明 | `tag`／`tagProperties` |
| Structured Property | 新增屬性定義：顯示名、說明、原生 qualified name、型別、單／多值、適用實體及需要的允許值 | `structuredProperty`／`propertyDefinition` |
| Description | 依證據新增或更新適當的 Dataset／欄位說明；正確保留既有來源說明與人工內容 | 官方 editable properties／schema metadata |

實際欄位與資料型別依固定 DataHub 版本、官方 datamodel 及既有相容性 Adapter 核對，不由模型任意指定 Aspect。

第一版沿用目前已支援的 Property string／number 與原生適用類型；不以擴大型別或既有 assignments 的 schema migration 作前置。刪除共用定義、破壞性型別／cardinality／qualifiedName 遷移不在第一版。

### 2.2 定義建立後必須套用

- Domain 套用至適當 Dataset；不把 Domain 掛到官方不支援的欄位位置。
- Term／Tag 套用至適當 Dataset 或欄位，保留其他既有關聯。
- Property 定義建立後，寫入適用資產／欄位的屬性值；不能只建立空定義便宣告完成。
- 先重用既有相同定義，避免重複；既有定義的更新沿用原 URN，不建立同名替身。
- 新增 Group → Term、Domain 父 → 子，以及 Property 定義 → 值，按依賴順序完成。
- 同一輪建立定義與套用，屬於同一份整批計畫，不要求使用者為每個階段另送一則 Prompt 或重複按 Approve。

## 3. 第一版保留什麼，不先做什麼

### 保留的基本保障

這些直接保護權限或資料完整性，不另建新的政策管理層：

1. 沿用目前 DataHub 登入者、原生讀／寫權限與已啟用的來源 metadata 使用範圍；不擴大到別的來源或使用者。
2. 模型只提出計畫，不能自行核准；執行確認在可信 DataHub 父頁面完成。
3. 完整計畫列出精確目標、before／after、理由、證據與限制；只執行被確認的版本。
4. 寫入前重讀必要原值／版本，沿用官方 per-Aspect CAS；原值改變時不偷偷覆寫或套用新版本計畫。
5. 不把資料庫憑證、cookie 或敏感原始 SQL 放進模型、普通 Aspect、計畫或日誌。計畫沿用現有 Task／Run ACL 的可見性，不宣稱私人審核；只保存可在該範圍揭露的 metadata，不以新增私密政策作本版前置。
6. 不重送已消耗的 attempt；部分成功／UNKNOWN 保留原始結果，不用後來看見相同值就追認成功。
7. 不把來源描述當授權指令，不把無證據的業務猜測當確定事實。

### 延後的治理機制

- 新增獨立 managed／AUTO policy 啟用與到期設定頁。
- 每欄／每目標另外配置 `allowedTargets` 或分類操作白名單。
- 預先設計通用 policy engine、規則 DSL、風險分數、多人審批鏈。
- 背景排程、事件自動發布、長期無人確認的維護。
- 多人私密審核、跨來源治理、全域分類清理。

**第一版的授權來自「目前原生權限＋可信父頁面對整批計畫的真人確認」；不是先建立另一份 AUTO grant。** 既有來源關閉／撤權仍須生效，不能以簡化 policy 為由繞過。現行不支援的操作必須透過正式實作接通，不直接移除 guard 取得假成功。

## 4. 最短完整使用流程

### 4.1 指定目的與範圍

例：

> 請維護 AdventureWorks2019 已選資料集及欄位的語義，整理必要的 Domain、Glossary Groups／Terms、Tags 和 Structured Properties，先給我完整變更計畫，一次確認後建立並套用。

使用者不必逐欄輸入定義，也不必為本輪先配置成功 Run 綁定的 AUTO policy。Host 從既有來源設定與原生 ACL 得到精確資產清單；模型不能自行擴大清單。

第一個驗收範圍沿用已選的 AdventureWorks Catalog 資產，不為流程準備擅自重跑整庫 ingestion。產品不得硬編碼 AdventureWorks、數量或業務答案。

### 4.2 讀取現況與直接證據

Agent 經現有工具完整翻頁，讀取：

- Dataset／欄位 schema、來源說明與人工 editable 內容。
- 當前 Domain、Term、Tag、Property 定義與關聯／值。
- 可讀的既有詞彙、父子結構及已知引用。
- 前次 Agent 發布的精確值、原生版本、初始結果與目前差異。
- 每個資產的成功 ingestion provenance、觀測時間及不足之處。

來源描述已存在且適用時，預設保留／重用；不把 556 處已有來源說明全部複製到 editable metadata 當作成果。沒有可靠來源業務說明的欄位也不能靠名稱填造「可信定義」。

**範圍規則：**語義維護針對現在有權讀寫的 Catalog metadata，不以「所有資產必須同屬最新一次 ingestion」為共同前置。不同成功 Run 的資產分別附 provenance／as_of；歷史 ingestion 不冒充當前整庫完整掃描。沒有看見某資產或目前 recipe 不再包含它，不自動刪除其語義。

### 4.3 Agent 提出完整計畫

Agent 主動提出：

- 哪些定義重用，哪些需要新增或更新。
- 建議的名稱、描述、階層、Term 所屬群組。
- 哪些 Dataset／欄位應關聯哪些定義。
- Property 的用途、型別／適用範圍與有證據的值。
- 既有內容保留、人工修改衝突、待補證據及暫不處理項。

可提出供人判斷的分類方案，但須明示哪些是直接證據、哪些是組織方式建議；不能把模型分類建議說成已驗證業務事實。缺口只影響相應項目，不把其他已有依據的定義建立與套用全部卡住。

### 4.3.1 未核草稿修訂與 Agent 整體自查（2026-10-05）

Agent 必須在封存前讀齊原生 active plan、必要的精確 review details 及來源證據，檢查共用概念／階層、逐欄適用套用、Property 有據值及 GAP 理由。來源已有明確主題／欄位說明，不因缺少現成 Term 就整表判缺證據；組織建議明示待真人確認，仍不推論單位、時區、唯一性或未驗證業務規則。這是 Agent 的規劃責任，不另造自動品質分數／核准器，也不把封存與帳平當品質證明。

- `revise_maintenance` 沿用同一 root，帶 `itemId`、目前 root `version`、原 child `childVersion/planDigest`，及與 prepare 相同的完整最終意圖／當前 inspection。
- 僅 DRAFT、未封存／批准／attempt，保留同資產、根 fieldPath 與定義 identity。compiler 重新核來源、ACL、政策、證據、原值及 CAS；同 Aspect 仍禁止重疊，不能以追加覆蓋取代修訂。
- 建立 immutable replacement child；root 追加包含原精確 id/digest/childVersion 的 supersession reference。舊 proposal／GAP／KEEP 與歷史不刪不改，不複製 consent。active plan 與待確認 digest 只包含最終項目。
- 定義修訂後，舊 consumers 的精確 dependencies 不自動改綁：讀回 `requiresRevision/staleDependencies`，Agent 重看並修訂完整 consumer；未修訂時禁止 seal。
- `totalItems` 是 active plan 項數；`totalRecordedItems` 包含被替代版本，只供有界前景進展／容量判斷，不是完成度。
- Lost ACK 仍停止，不重建／重播 child。只有精確已保存的 replacement 與原 supersession 證明，可用既有 recovery 補回原 root link；新 observation recovery 亦限此 revision 路徑，不恢復歷史缺 ID 的 UNKNOWN GAP。
- 被替代項不得發布。真人仍只確認最後完整計畫一次，Host／原生 publisher／per-Aspect CAS 仍為唯一執行入口。

### 4.4 一次確認整批

在同一個可信 Host 計畫面板展示：

| 清單 | 顯示內容 |
| --- | --- |
| 定義 | 新增／更新／重用、完整內容、原生定位與父子關係 |
| 套用 | 精確 Dataset／fieldPath、關聯及 Property 值的 before／after |
| 保留與缺口 | KEEP、人工作品、歧義、證據不足及受影響項目 |
| 摘要 | 將建立、更新、套用、保留及未決的內容；不是只有數量 |

使用者可排除整筆變更；排除父定義時同步排除依賴它的項目，不能留下懸空計畫。修改選取或內容會產生新的計畫版本，確認只綁定最終版本。大型計畫在面板分頁讀齊同版本原生資料；確認請求引用計畫與選取版本，不一次把全部 metadata 重送到 Host，也不相信 iframe 自帶的批准或 payload。

按一次「確認並執行所選計畫」，覆蓋已展示的定義建立及後續套用。不要求逐個 Term、欄位或原生 Decision 重複批准。

不把目前單筆 review 的短時效變成整份長流程的倒數障礙，也不要求使用者另配置時窗。整批確認綁定原值／計畫版本；執行項目在輪到時核對並封存原生版本與 attempt。沿用已過期單筆 review、延長舊 consent 或忽略資料漂移都不允許；新整批路徑須正式實作，不能重播舊提案。

### 4.5 Host 依序執行及讀回

```text
重用既有定義／保留原值
  → 建立 Domain 與 Glossary Group 階層
  → 建立 Term、Tag、Property 定義
  → 逐定義核對原生持久結果
  → 套用 Domain／Term／Tag 關聯與 Property 值、描述
  → 核對完整 Aspect、版本與當次 attempt
  → 顯示整批完成項、衝突及未決項
```

同一 Aspect 的變更合併為精確一次寫入，不按 20 欄讀取頁切成相互覆蓋的批次。不同資產可按既有資源限額處理，但第一版優先簡單循序執行，不引入新 worker／調度器。

使用者可停止後續項目；已派送項目須等待／對帳，不能宣稱已回滾。父定義未確認成功時不派送依賴的套用；互不相依且已確認的工作不因一個缺證據項目全部不能開始。新的整批流程不依賴舊 managed cycle「前輪每個目標帳平才能配下一輪」的共同門檻；未決效果鎖住相應目標與依賴，不把整個來源永久卡死。

### 4.6 下一輪維護

後續再次要求維護時，重新讀目前 schema、定義、關聯、證據及前次結果，比較 **prior-Agent／current／new**：

- 內容相同：KEEP，不重複建立同名詞彙或製造 target write。
- 有新證據：提出同一原生 URN 的精確更新與新的整批差異。
- 人或其他 writer 已改值：保留原值，明示衝突；只有明確展示且被本輪選取確認的替換才能執行。
- 原初始結果 UNKNOWN：保留未決，不能把重跑當恢復。

仍採本輪一次確認，不升級為背景無人 AUTO。

## 5. Host 與原生持久化設計

### 5.1 重用現有接點

```text
DataHub Agent／既有 skill + datahub_semantic
  → 現有 Pi bridge／可信 MFE 計畫面板
  → typed semantic compiler
  → 既有原生 Task／Run／Decision 與真人整批確認
  → 既有 publisher／官方 OpenAPI CAS
  → 原生讀回、結果卡與歷史
```

不改 Core、不另建 PostgreSQL／SQLite／Redis、業務狀態檔案庫、通用 workflow engine 或第二 publisher。相容性集中在現有 Adapter；原生 Model／MFE／公開 API 仍為擴充點。

### 5.2 計畫與依賴

一份計畫至少表示：

- 原生 Task／Run 定位、目前 actor、Source 與精確資產範圍。
- 計畫版本及 digest；每項穩定識別、類型、操作、before／after、原值版本、證據、依賴。
- 新定義的 Host 決定識別，及重用既有定義的精確 URN／版本。
- 真人確認的計畫 digest／所選項目、各項執行 attempt 與初始結果。

重用 `ekopAgentTask`、`ekopAgentRun`、`EkopAgentDecision` 及 typed publication records。**不把 Task.instructions 的自由文字當授權，不讓模型傳 approval=true。** 原生承載欄位與容量由實作核對；必要的最小 optional 模型演進只走官方 Model expand-contract，不預建新 Entity 或 datastore。

依賴尚未建立時，預覽以計畫中的 Host 目標識別及確認內容表示。執行時只填入這些已確認依賴的實際版本／持久收據，不能偷偷更換名稱、內容、父節點、資產或套用值。外部內容改變需要重排時，另產生差異並重新確認。

### 5.3 整批確認與逐項執行的責任

- 真人確認是整份精確計畫的 consent；Host 將相同確認定位連到各項原生執行紀錄。
- 不偽造模型批准，不因每項分別有 Decision 就要求多次 UI 確認。
- 沿用版本 CAS 與單次 attempt。DataHub 沒有跨 Entity／Aspect 的整批交易，不承諾原子完成或自動回滾。
- 對確定尚未派送的項目可在仍有效的相同確認下繼續；衝突或已派送不明項目不可盲目重送。
- 大範圍資料使用有界 API 分頁與原生紀錄分段；分段不是新增產品範圍限制，也不是多次真人批准。單項確實超過原生／傳輸容量時，回報精確阻礙，不截斷後宣稱全部完成。

## 6. 更新共用定義的第一版取捨

不為所有「新建並套用」工作先建置全域影響 policy 系統：

- 新定義：查重、精確 create-only、確認後建立並讀回，接續套用。
- 既有定義內容已適用：直接重用，不為統一命名強制修改。
- 本輪建立、且引用範圍可核對的定義：下一輪可展示並確認更新。
- 其他全域共享定義：其修改不作為整批新建／套用的前置。影響無法確認時先重用或列為獨立未決項，不阻擋不相依的工作。

不拿固定 `impact.complete:false` 擋住所有建立及關聯，也不假造 `complete:true` 放行未知的跨範圍覆寫。真的需要修改外部共享定義時，再處理當次具體影響與授權；Property 破壞性 schema migration 仍延後。

## 7. 現況差距與實作順序

2026-10-03 原生唯讀核對：AdventureWorks 當前已選 91 Dataset／744 欄，schema 來自兩次成功 ingestion（84＋7）；三項人工語義權限有效，但整體代管未交付。[現有 Catalog 單筆主線](datahub-semantic-catalog-mainline.md)及[送審介接恢復](../verification/datahub-agent-semantic-review-contract-20261003.md)可重用，不能冒稱本方案已完成。

| 現有阻擋 | 本設計的處理方向 |
| --- | --- |
| `inspect_managed_scope` 只認舊式 recipe、最新單一 Run | 分離 Catalog 語義維護清單與「完整最新 ingestion inventory」宣稱；用精確已授權資產及逐資產 provenance，不為開始維護重灌整庫 |
| Source可選91，但 Task上限16、inventory64、AUTO targets128 | 接齊整份明確範圍與原生容量處理；第一版不依賴 AUTO allowedTargets 清單，不假造多個 Source 繞限額 |
| 要先配置 `semanticAutoManagement` | 改以本輪一次真人計畫確認作執行入口；既有單筆／歷史 AUTO 路徑保留，不偷偷更改舊授權 |
| 維護計畫主要只有 description | 一份計畫包含五類定義、階層、資產／欄位關聯及 Property 值，不只 description |
| 定義建立及套用必須多次 Prompt／逐筆批准 | Host 預覽依賴圖，整批一次確認，依賴建立核對後執行所選套用 |
| 所有已消耗 attempt 顯示同樣警告 | 分開「當次成功且現在仍相符」「已成功但目前改變」「部分／UNKNOWN」；成功不當成可再批准，UNKNOWN不追認 |

實作以同一使用者流程推進：

1. 接通整份清單與 Agent 完整計畫，包含五類定義及套用。
2. 接通可信父頁面一次確認與既有原生持久化。
3. 以相同確認完成依賴建立、實際套用、結果與部分失敗呈現。
4. 接通後續比較、重用／KEEP／更新，完成真入口首輪及變更輪次驗收。

不先單獨完成大型 policy 框架，也不把只修 scope 錯誤、提高數字上限或再建一個 Term 當成交付。

## 8. 驗收與非目標

### 必須驗收

- 真 `/mfe/agent` 模型讀取精確範圍，提出完整計畫；不依靠開發者直接 API 寫入冒充 Agent 流程。
- 真人一次確認後，Domain、Group／Term、Tag、Property 原生定義確實建立；父子關係及型別正確。
- 定義隨後套用至相應 Dataset／欄位，Property 值真的持久；完整 Aspect、未選內容與原生 UI 相符。
- 第二輪有真實證據／需求變更，更新同一原生 URN／值；未變者 KEEP，人工內容保留，不建立同名副本。
- 多頁／多資產沒有漏項或隱藏截斷；首個驗收覆蓋已選來源範圍，不以16資產或單欄 canary 替代。
- 版本衝突、取消及部分／UNKNOWN有清楚結果，不自動重送或刪除歷史。
- 成功項顯示成功；「attempt 已消耗」不是失敗，也不是新批准按鈕的理由。

### 第一版不做

來源 SQL／ETL／ingestion 執行、來源業務資料搬移、刪除共用定義、破壞性 Property 遷移、背景 AUTO、跨來源治理、新 datastore、Core patch。

本次只產生設計文件。實作、切換使用中部署、真模型新訊息與 metadata 寫入仍需各自適用的操作授權；文件中的未來行為不是現場成功證據，也不直接修改目前 Source grants／歷史政策。

## 9. 原生計畫定義項目參照（2026-10-06 已部署，完整維護未驗收）

r13證實模型漏抄待建立Domain URN的`af`，既有Host正確拒絕；不以自動補URI、名稱猜測或放行`semantic_catalog_invalid`解決。沿原Task／Run／Decision及既有編譯／publisher，讓模型**明確選項目、Host解析精確定位**：

- `read_maintenance`的定義項目提供`definition.reference={definitionItemId:<原生項目UUID>}`；這是選擇子項目的資料，不是授權token。
- 僅`prepare_maintenance`／`revise_maintenance`可使用：Domain／Tag／Term／Property候選`value`，Domain／Tag／Term的整組`values`成員，以及Domain／node階層的`definition.parentUrn`。集合可混合既有URI與明確項目參照，不能丟失人工作品或自動合併。
- 參照時必須傳目前Root `version`；Host讀取同Root**有效未被取代的定義child**，核種類、Source／actor／session、ACL／scope、原生digest／版本；編譯後再核Root及被選child未變。外Root／未知／KEEP／GAP／錯類／已消耗／版本漂移拒絕，不跟隨替代ID。
- Property `values`仍是業務字面值；既有definition內容更新的`definition.urn`維持URI模式。普通URI模式保留，錯URI不被改成「最接近」定義。
- 正常化後保存的是精確原生URI與原有依賴／完整差異，真人確認及發布沿既有整批契約。SDK只搬運明確選擇，不解析URI、代填版本、刷新／重試或擴權；沒有新store、controller、approver或Core修改。

這項接線已另獲部署及一則原會話／Root／high提示授權；r14實際明確參照及提案保存成功，但仍DRAFT285／16資產未準備，完整語義維護未驗收。該提示授權已消耗；後續新部署／提示與語義發布仍需相應操作授權。

## 10. 原生範圍與封存條件的結構化讀取（2026-10-06 已部署，r15未達完整送審）

Agent 負責判斷有據、完整、一致的方案；Host 提供精確事實及執行邊界，不替 Agent 選下一資產、action 或業務答案。使用既有 `read_maintenance`，不新增 controller、store、排程或自動封存／批准／重試。

### 讀取契約

- 無 `view`：原有 active items 分頁；帶 `assetUrn＋version`：原有單資產完整輸入視圖。兩者維持 `datahub-semantic.maintenance/1`。
- `view:"scope"`：列出**原生 Task 本計畫選定**的資產，不從目前 Source 清單重新擴大或縮小。
- `view:"unprepared"`：只列選定資產中，尚無 active 套用／KEEP／GAP 紀錄者。不是 UNKNOWN 執行清單，也不是只有沒有 GAP 的資產；沒有 active 紀錄不證明歷史零效果、不解除 UNKNOWN 或授權重播。
- 兩個新視圖回傳 `datahub-semantic.maintenance-scope/1`；每頁最多20個 `assets[{assetUrn,accounted,activeItemCount}]`。`totalAssets` 為當前 view 的分母；`assetCount/accountedAssetCount/unpreparedAssetCount` 為整份計畫分母及帳平數。數字均從原生 Task 與 active links 推導，不寫死來源、數量、名稱或答案。
- 首頁 `offset:0` 可省略 `version`；後頁必帶首頁回傳 `runVersion` 與 `nextOffset`，保持同 `view`。`scopeDigest` 綁定選定 URN 清單；Root 改變便拒絕舊版本，讀取期間變更亦不回傳混合版本的收據。不可同時帶單資產 `assetUrn`。
- 核目前登入者、Source 政策／範圍及每頁資產的 metadata ACL；撤權／漂移不轉成 GAP，不把不可見者當缺失。讀取本身無原生寫入，不啟動或恢復前景續作。

定義只是用資產作證據 anchor，不算該資產的套用；superseded children 不算 active 工作。同一資產多筆套用／KEEP／GAP 仍只帳平一個資產。完整 child 的定義種類與資產須符合 root link，不能只改 link 標籤製造帳平。

### 與實際封存共用的條件

`sealing.checks` 每筆提供 `condition/met/error`；和 `seal_maintenance` 使用同一函式：

| condition | 結構條件 |
| --- | --- |
| `PLAN_UNSEALED` | 計畫尚未封存 |
| `PLAN_OPEN` | 原生 Run 尚未關閉 |
| `PLAN_HAS_ITEMS` | 有 active 計畫項目 |
| `ACTIVE_DEPENDENCIES` | active consumers 的依賴仍是 active 項目 |
| `SELECTED_ASSETS_ACCOUNTED` | 全部選定資產均有套用／KEEP／GAP 紀錄 |

`staleDependencyItemCount` 是需重看依賴的項數；精確項目仍在既有 item 分頁的 `requiresRevision/staleDependencies`。新範圍讀取及封存才讀齊 children 評估這個條件，不在每次 prepare 收據做全計畫重讀。

`structurallyReady` 只是上述結構條件全成立。`semanticCompletenessVerified:false`、`accountingBasis` 明示它不是語義品質、逐欄完整性或成功發布的證明。Agent 仍須讀齊來源、定義、逐欄候選及精確 GAP，自主自查／修訂後才選擇封存。

`completeSourceInventoryRequired:false` 是這份已選 Catalog 計畫的封存契約，不放寬舊 managed／AUTO 或完整來源盤點宣稱。`authorizationRecheckedOnWrite:true/originalSessionRequired:true` 表示實際寫入仍核原 session、当前 Source／原生權限及 CAS；`humanConsentRequiredForPublication:true`，所有讀取保持 `publicationAuthorized:false`。結構條件不是授權。

新 SDK schema 接受明確 `view`，原樣傳給 Host；核回應格式、view、offset、明示版本。未知回應沿既有停止／唯讀對帳，不修參數、不代選動作或重送。此契約已部署，r15真Agent自主补了12個漏項但仍DRAFT；詳見[範圍契約live驗證](../verification/datahub-semantic-maintenance-scope-live-20261006.md)。首輪完整方案／真人確認／發布及真正變更輪次仍未驗收。

## 11. 歷史 UNKNOWN 暫緩，不阻擋獨立工作（2026-10-07 已部署，r16未達送審）

使用者決定：UNKNOWN先skip，其餘工作繼續。跳過的是原未決操作，不是刪除历史、追認零效果、清除原attempt或永久排除整個資產。

沿現有 `prepare_maintenance` 的GAP觀測，新增 `gap.code:"UNRESOLVED_OPERATION"`：

```json
{
  "code": "UNRESOLVED_OPERATION",
  "reason": "原操作效果未決，本輪暫緩，保留原定位供後續對帳",
  "operation": {
    "action": "prepare_maintenance",
    "maintenanceRunUrn": "<原已知Root定位>"
  }
}
```

- `operation.action`限prepare／revise／publish維護意圖，Root保留原已知字串；可提供已知requestId／itemId，未知者省略，不製造定位。這是陳述未決歷史，不是Host已證實的恢復或授權。
- 此新觀測使用本輪DRAFT、原session、目前完整inspection、ACL／Source／CAS，不能混candidates／definition。它只寫原生Task／Run觀測，不執行Dataset或定義變更，也不呼叫原操作。原未知歷史／attempt完全不改。
- 回傳狀態 `DEFERRED`，父頁顯示原因與原定位；讀scope的`sealing.deferredItemCount/deferredAssetCount`明示暫緩數。保留原選定範圍，不透過範圍縮小隱藏四筆或其他未決項。
- 可做的有據方案與有效依賴成立、剩餘未決部分明列後，整批可READY供一次真人確認；`semanticCompletenessVerified:false`保持不變。送審可行不等於全範圍維護完成。
- 父頁跳過DEFERRED，其他獨立所選變更沿原publisher／CAS執行。原未知目標／相依保護不解除；當前在途／失去ACK仍停止並只讀對帳，不能用暫緩作為重試或掩蓋在途效果的出口。
- 後續有新證據可重新評估獨立提案；暫緩不是資產黑名單。仍不覆寫人工作品，不自動核准、重試或啟新Root清洗歷史。

只擴充既有GAP觀測／介面，不新增controller、store、Asset名字特判、Core patch或自動選擇。此新增暫緩路徑已部署，真Agent保存3筆DEFERRED且父頁可見，但第4次模型混用一般GAP／operation而被Host正確拒絕；已保存3筆的Root定位也不符原歷史输入。未放寬guard或追認定位，尚未送審；詳見[live驗證](../verification/datahub-semantic-unknown-deferred-live-20261007.md)。

## 12. 輸入互斥、歷史定位與同輪更正（2026-10-07 本地完成，未部署）

使用者要求依修正方案實作。SDK GAP schema 分成 ordinary `{code,reason}` 與 unresolved `{code:"UNRESOLVED_OPERATION",reason,operation}` 兩分支；派送前精確拒絕混用，模型自行產生新更正輸入，不自動改答案。固定 SDK 的 schema 拒絕可能不進 execute，因此亦在公開 tool_execution_start 用同一 validator 確认未派送之精確 call；不修改 SDK/Core。

Host 只在純輸入驗證邊界發 typed inputRejection，綁 action/requestId/Root/完整語義請求 digest，明示 INPUT_VALIDATION、nativeWriteStarted=false、NEW_INTENT_ONLY。SDK／新 driver 共用判斷；這不是 retryAllowed，也不是原歷史效果判決。裸400／error name／缺 reconciliation 不構成證據，失 ACK、未知效果、ACL／CAS仍停止。

`read_operation_history` 經目前 Host Source／asset／field ACL 後，提供本session active branch的已記 intent 定位、reference與20筆/digest-bound分頁；保留原Root／已知ID，缺欄位定位明示未記，effect=NOT_PROVEN。不查其他session／分支、不讀任意路徑、不恢復權限；空結果明列覆蓋缺口，不能聲稱已找回全部歷史UNKNOWN。已知claim不符SDK派送前拒絕。已存DEFERRED可沿原revise/CAS/完整inspection追加更正觀測，原記錄與未知效果保留。

本地 actual SDK 同提示自行更正至READY、actual Host/HTTP/MFE收據傳遞、失ACK仍停、錯定位追加修訂均已驗證，非真模型或native修訂。現有r16三筆錯定位不變；真完整方案／發布及變更輪仍待授權驗收。詳見[本地驗證及限制](../verification/datahub-semantic-input-correction-local-20261007.md)。

## 13. 審核沿用 Pi Web 工作區（2026-10-07 已部署）

使用者要求使用 Pi Web 原有右側面板，並以使用者角度呈現，不用 JSON。沿既有 AppShell slot／尺寸／放大及 Grafana 父頁掛載模式整合，不重用 DataHub Core 私有 Sidecard。

iframe 只傳原生 Root 定位及有界位置；完整審核 DOM、選取、確認與 publisher 仍由可信 MFE 父頁持有。Host 讀齊同版本全部項目與完整差異，原 ACL／CAS／依賴／不可重送條件不變。會話／頁籤切換、面板關閉及 iframe 導航移除顯示，不恢復真人確認。

介面以來源、資產／欄位、目前內容、建議內容、理由、證據、影響與缺口呈現。結構值使用清單與名稱／值；原生定位與歷史可展開，不刪減核對依據。搜尋及篩選不改選取；改選取取消勾選，重新開啟須重新核對。標題與搜尋固定上方，確認及操作固定下方；只有建議清單捲動。

使用者另准UI-only部署，已受控更新本案Agent映像／MFE並替換唯一owned真人審核視窗；原session、已封存方案、完整Aspect、HOME／journals、grants及模型high不變，未送新提示或代批／發布。真入口1440／390完成完整內容及固定控制核對；窄螢幕須沿原生操作收合DataHub／Pi Web導覽，不修改Core。真人確認、原生發布及真變更輪仍未完成；詳見[真入口部署驗證](../verification/datahub-semantic-pi-web-review-panel-live-20261007.md)及[本地面板驗證](../verification/datahub-semantic-pi-web-review-panel-local-20261007.md)。

## 14. 業務提案與原生操作編譯分工（2026-10-09 已部署，真實方案續作未驗收）

使用者要求移除不必要 guard，以 Agent 語義代管為目的實作。Agent 決定有據的業務語義；Host／Adapter 沿官方 API 取得技術上下文並編譯原生操作。不是要求模型搬運每個欄位的技術快照，或把格式缺口當成授權危機。

- 共用定義可保留 schema 中的精確欄位證據 anchor，綁原資產 inspection；不把不相干的欄位 Property 版本當定義證據，也不刪 fieldPath。
- 一份 Catalog 資產提案可混合 Dataset 與多欄位 Property。Host 核每個精確欄位的 ACL／身分，讀完整原值／版本，按原生目標 Aspect 分組編譯；保留全部候選，無 SDK 拆項／業務修補。
- 額外欄位原值及版本固定在原生 Review；發布前重新編譯核 digest，讀回核未選 Aspect。原資產證據 digest 不被新技術上下文替換；既有合法單欄提案／Review 維持原完整內容與 digest。
- 同一 subject 可有不同關聯成員的多筆 add／remove，以及多個不同 Property；set 是完整集合。只有同成員重複、競爭 set 或同 scalar 的兩個答案屬於輸入衝突。
- 已觀測證據支持的定義／提案可先保存，不把全部欄位分頁讀完當每次準備前置；封存前完整適用範圍與方案品質仍由 Agent 自查。
- 純 Catalog parser 拒絕回傳綁原完整請求的 typed inputRejection 及 issue，允許模型同輪生成新意圖。此 catch 只包純 parser，不包 ACL／CAS／I/O／compiler／寫入；失 ACK 或 UNKNOWN 無更正豁免。
- 不限制每项選用的回傳證據筆數，保留全部證據，仍核 identifiers／存在性／原快照與 request byte／Review 容量。引用 shape、missing input version、kind 或不在本 Root active 定義集合，可在新 child 寫入前回精確 proof；不讀另一個 Root、跟隨替代項或猜 URI。已消耗／效果不確定 child 仍硬拒絕。
- 經目前 ACL／快照核對後的 evidenceId／fieldPath／Property 型別、基數、允許值等明確提案錯誤，透過 Host `rejectInput` 的顯式比較回寫入前 proof，模型可同輪提出新的合法輸入或精確 GAP；不是包住 I/O／compiler 的 broad catch。不可改 immutable 值或套用不支援 constraint，但不必因此取消全部準備。資料損壞／權限／CAS／失 ACK 不進此豁免。
- Domain 的 parent 是 Domain；Glossary Group／Term 的 parent 是 Group (`node`)，不能把 Domain 冒充 Group。Host 不捨棄 parent、不換業務階層或修補意圖；一般輸入問題應可更正，不轉成整輪通用 aborted。

保留既有原生身分、Source scope、證據、人工內容／並發保護、UNKNOWN 不重播及可信父頁一次整批確認。沒有新 datastore、Core patch、Source grant、背景 AUTO 或模型／預算變更。原傳輸／Review 容量及非原子交易限制仍須如實處理。

本地驗證已涵蓋保留同 Root 五項定義後完成七 Dataset 方案，以及合成證據改變的後續輪次；不是實際 Sales 或正式第二輪驗收。使用者後續批准部署，exact image 合成檢查與 Windows Edge 真入口只讀核對通過；原 Root／五項 Review／42 journals 保留，尚未送新模型準備提示。新的真模型準備意圖仍需明確有界操作批准，既有成功項與被拒原操作不重送。詳見[本地 compiler 驗證](../verification/datahub-semantic-proposal-compiler-local-20261009.md)及[部署驗證](../verification/datahub-semantic-proposal-compiler-deploy-20261009.md)。後續使用者手動測試新建另一個 Root，保留一項 Domain 後因父引用類型／隱藏證據上限中止；再次要求放開非必要卡控。本地399／exact-image109檢查通過，修正已獲准部署，Windows 真入口核一項 Domain、舊五項及全部43 journals原值不變；沒有自動重送或完成實際新準備。詳見[手動中止原因、卡控鬆綁及部署驗證](../verification/datahub-semantic-manual-abort-20261009.md)。

## 15. Source 為治理邊界，Prompt 只縮小（2026-10-11 已部署，真模型新計畫未驗收）

使用者確認：以 DataSource 為代管目標；可只選 Source 內單一資產或單一類別，始終以該 Source 為邊界。不是以資產名稱關鍵字圈選，也不讓上游 lineage 自動決定詞彙歸屬。

- `start_maintenance` 預設選目前可信 Source Catalog 範圍；`assetUrns` 只能取其中子集。`focus` 預設 `all`，可縮小為 `glossary`、`tag`、`table`、`field`。Source 範圍與成功 ingestion 證明是不同事實：未驗完整 ingestion 時仍顯示 `completeSourceInventory:false`，不擴大 Source 政策或假稱最新完整盤點。
- Glossary 限 node／term 定義及詞彙關聯；Tag 限標籤定義及關聯。Table 限 Dataset 層級候選，Field 限精確欄位層級候選；兩者可提出所需的共用定義。Table／Field 預設只選該 Source 的 Dataset；明確選入其他種類則拒絕，沒有默默篩掉明確要求的資產。
- 新 Root 的原生 Task instructions 保存 `focus`，Task／Run 的原版本及 Source 綁定沿用既有契約；Receipt／Review 提供 `governance={sourceUrn,focus,assetScopeBasis}`。準備及修訂都核保存的類別，不從後續 Prompt 放大。類別不符在 child 寫入前回原完整請求綁定的 `semantic_maintenance_focus_mismatch` proof；模型只能生成新輸入，沒有自動改寫或重播。
- 已知共用定義引用也核新 Task 的資產子集：引用了未選資產，即使仍在同 Source，也不因 Source 全範圍資格而放行本輪更新。影響索引仍非全域完整分母，未知影響照實交真人核對。
- `search_vocabulary`／`inspect_definition` 提供由根到目前定義的 `hierarchy`，含每層精確 URN／名稱／描述／版本。每層重核原生內容及 ACL；缺祖先、損壞、循環或 transport 失敗保持硬停止，不成為可更正直接引用。
- 新 Root 的 Glossary 提案與套用凍結完整階層及其引用版本。相同短名、不同直接 parent 的 node／term 列為 `sameNameOtherHierarchy`，不強迫重用；同 parent 的同名衝突仍須明確解決。這不是語義等價／唯一性證明，也不允許用新名稱或 URN 清洗舊效果。
- **Source 定資產範圍；證據定含義；治理目標與完整路徑定詞彙歸屬。** Agent 須解釋 parent 為何適用本 Source；來源專屬階層不能因同名或上游 lineage 而繼承。真正中立共用定義可在含義與適用範圍證據一致時重用。Host 核技術合法性，不依名稱猜業務範圍，也沒有自動 reparent。
- 可信父頁顯示 Source、保存的類別及完整階層／祖先描述。完整讀取與 final-version 核對之前仍不開放 consent；Source／focus／Review 綁定漂移拒絕，不以畫面 filter 改選取或授權。
- 舊 Task 沒有 focus marker 時保留原行為及原 Review 編譯，不追寫 governance、不改 Root／URN／關聯／歷史。本地階段未部署；後續獲准部署 Host／SDK／MFE 並完成真入口只讀核對。沒有送真模型準備提示，也沒有搬移已發布詞彙。

本地驗證與限制見 [Source 治理本地驗證](../verification/datahub-semantic-source-governance-local-20261011.md)；同日部署及 Windows Edge SDK／原生完整階層／Source 負例／13項刷新／保存結果見 [部署驗證](../verification/datahub-semantic-source-governance-deploy-20261011.md)。真模型的分組判斷與部署後新 Root 的完整語義品質，仍需另行驗收。

## 16. 成功回覆增量化與版本感知（2026-10-11 已部署，真模型效率／新準備未驗收）

`prepare_maintenance`／`revise_maintenance` 的 SDK 傳輸採 `responseMode:"incremental"`。Host 只回本次項目的精確引用、原生 Root 新版本及範圍計數，不每次重列所有舊項。`delivery:"incremental"`／`delta.completePlan:false` 明示它不是完整清單或 consent；沒有削減原生候選、完整 Aspect、證據及歷史。

Agent 逐筆等成功 ACK，再自行把該版本／已確認引用放進下一個新意圖；新啟空 Root 加版本連續 ACK 不必每次重讀整份 Root。知識不完整、版本不連續、重新接續或 `delta.resyncRequired:true` 時先完整同步；定義修訂也要求同步其他 consumer 的失效依賴。修訂既存項仍先核完整舊輸入及目前來源證據，SDK不自動填版本、修補、重播或快取授權。

最終自查及可信父頁仍讀齊全方案、digest-bound 完整差異和最後版本。父頁明確拒絕把增量回覆當完整 manifest；卡片也明示摘要範圍。ACL／Source／CAS、UNKNOWN／失 ACK 停止、一次整批真人確認及 append-only 歷史不變。既有未指定增量模式的完整回覆與完整分頁讀取相容。

詳見[增量回覆本地驗證](../verification/datahub-semantic-maintenance-incremental-20261011.md)及[增量／容量／閒置重連部署驗證](../verification/datahub-semantic-incremental-capacity-idle-deploy-20261011.md)。使用者明確批准三項合併範圍，已隔離建置新版 SDK／MFE，fresh guards 後正常切換並完成真入口只讀核對，不是沿用舊 SDK image。沒有續跑真模型、新原生準備或 publication；部署授權已消耗，不重播原失敗請求。

# DataHub Agent Catalog Explorer：B 方案與 Detail Sidecard

> 此公開分支為部分來源的 WIP 快照，與本機曾上線測試的混合工作樹／映像不是同一來源；請先讀[WIP 驗證範圍與阻擋](../verification/datahub-agent-catalog-explorer-wip.md)。真資料讀回的私有證據不隨分支發布。

- 決策日期：2026-09-22。
- 使用者要求：採 **Agent 對話＋結構化結果卡片＋輕量血緣檢視**；列出能力與卡片；點選卡片後，於右側彈出 **Detail Sidecard** 互動及呈現細部資料；**不可直接呈現 JSON**。
- 最新 UI 決定：**移植 DataHub 原生 layout 與樣式，右側 Sidecard 亦採 DataHub 原生呈現格式，只提供查詢**。不是自行設計通用 drawer 後套用 DataHub 顏色；原生資訊層級、卡片、頁籤／區塊、間距及互動形式均為對照基準。本決定取代本文件先前自訂五個橫向 tabs、固定 560px 等未經原生對照的視覺建議。
- 原生移植進度：預設 entity／sidebar glyph 已核對固定版 Phosphor 2.1.7 原始圖形及授權；欄位 metadata 增加來源區分、原生 flags 與治理來源，但未以原始碼一致替代真 UI 驗收。Sidecard欄位表已參照原生compact結構；治理section只呈現該entity實際查詢的種類，不將未讀欄位視為空。DataHub管理的同源`/assets/` platform／profile圖與已確認Columns／Lineage深連結已接；外部metadata圖片不載入。MSSQL平台圖片已有真HTTP／browser證據；其他entity圖片、完整原生同寬版面校準仍待完成。
- 狀態：設計契約；依 `TODO-cdd3f40a` 繼續原先 Host／公開 API 架構，不遷移成全部 MCP。本機 Agent-only 候選經授權已切換並恢復真模型→Host搜尋→卡片／詳情，首輪失敗因 Browse V2 原生 DataPlatformInstance 祖先未被 Adapter 接受；現有33項真adapter回歸及部分Browser成功證據；390px經使用者同意以原生Navbar按鈕手動收合後（Agent容器318px）驗證，展開時只有66px的限制與其餘缺口見[公開 WIP 狀態](../verification/datahub-agent-catalog-explorer-wip.md)。B1／B2 及§9仍未全部完成；僅同 Actor 本機唯讀範圍經測，不授權 metadata／來源寫入、改 Core 或擴大 actor policy。
- 關係：補充 [Agent v2 整合方案](../research/datahub-agent-pi-web-plan-v2.md) §4–6；本文件優先定義 Catalog 查詢的卡片與右側詳情，不取代既有 Files／Terminal、[ETL Composer](datahub-etl-composer.md) 或 [Semantic Steward](../research/datahub-semantic-steward.md) 的操作／授權契約。

## 1. 目標與邊界

使用者不需要知道 MCP、GraphQL、URN 或工具參數，即可回答：**這是什麼資料、有哪些欄位與屬性、從哪裡來、被哪些資產使用**。

唯一入口維持 `/mfe/agent` 的 Chat；直接以自然語言提問即可，不要求先選 Skill。Skill 可在背景提供查詢指引，不能決定 UI 或授權。常用起手操作為「找資料」「看上游」「看下游影響」「查欄位／屬性」。每次回答由簡短摘要、可點選卡片、來源與限制組成；深入閱讀留在同頁右側 Sidecard，不要求使用者操作 Tasks 面板。

### 本案提供

- 已記錄 Catalog metadata 的搜尋、資產定位、欄位、治理／自訂屬性及表／欄位 lineage 查詢。
- 卡片摘要、右側詳情、清單與圖形等價檢視、可核對的 DataHub 原生連結。
- 同名資產消歧義、分頁與範圍提示、可追問的選定資產 context、錯誤與權限狀態。

### 非本案範圍

- 不執行來源 SQL、profiling、ETL、ingestion 或 metadata 編輯／發布；沒有任何卡片點擊隱含寫入。
- 不建立完整獨立 Catalog／通用圖形工作台、不新增 datastore／服務／排程器、不修改 Core。
- 不從名稱、相似欄位、FK、Join 或模型推論補造 lineage；程式分析候選不混入已記錄血緣。
- 不承諾 DataHub 尚未收錄的完整 source → ETL → Datamart → BI 鏈；缺失明示，不以空圖宣稱沒有依賴。

## 2. 現有基礎與待確認能力

[T02](../verification/datahub-agent-datahub-mcp.md) 已有真 Agent 經官方 MCP 查 schema／一層 lineage、與 API 核對及 reload 的歷史證據；不代表本文件的新 UI 已存在，也不代表短效 MCP 憑證目前有效。

| 能力 | 交付要求 | 接線／驗證注意 |
| --- | --- | --- |
| C01 資產搜尋與消歧義 | 按名稱／關鍵字找資產；可篩平台、來源／instance、database/schema、環境、資產類型 | 搜尋與各 filter 核對固定版公開 API 及 ACL；不從名稱猜來源定位 |
| C02 資產總覽 | 顯示名稱、類型、平台、完整定位、描述、原生連結與時間 | Dataset 優先；View／Flow／Job／Chart／Dashboard 按實際 entity 類型呈現，不偽裝成表 |
| C03 欄位與 schema | 欄位名稱、原生型別、描述、可取得的 nullable／key 等；搜尋及分頁 | 缺值顯示未提供；API 列序不冒充來源欄位 ordinal；不由型別推測 nullable |
| C04 治理屬性 | Owner、Domain、Tags、Glossary Terms；點選查看定義及可見關聯資產 | 逐項確認讀取、權限與分頁支援；不假設已全部 live 驗過 |
| C05 自訂屬性 | 分組名稱／值清單、搜尋、長文展開、巢狀內容可讀化 | 敏感欄位在可信邊界裁剪；不是任意 Aspect／Secret viewer |
| C06 表級血緣 | 上游／下游、一層預設、清單與小圖切換、點擊展開 | 保留方向、關係種類、分頁、範圍；預設只讀已記錄關係 |
| C07 欄位血緣 | 選定精確 field path 後追蹤來源／去向、突出相關邊及多輸入 | 必須有原生欄位映射；表級有關係不代表欄位級已知 |
| C08 有界影響探索 | 逐層查下游、依資產類型分組、顯示已找到路徑 | 是已記錄依賴，不等於業務影響／故障預測；缺一段就停止該段推論 |
| C09 證據與新鮮度 | 查詢時間、可取得的 metadata 觀測／更新時間、來源連結、覆蓋限制 | 各時間分開，不以現在查詢時間替代資料更新時間 |
| C10 對話追問 | 選定資產／欄位可引用到 Composer，再由使用者送出 | 不因點卡自動送模型、產生另一輪回答或改變授權 |
| C11 原生頁面銜接 | 一鍵開 DataHub 資產；可確認的 tab／欄位定位才加深連結 | 無該深連結契約時只開資產頁；不能以跳頁取代必交付 Sidecard |
| C12 狀態與恢復 | loading、部分、未知、空結果、權限不足、過期、斷線、取消 | 卡片可重開；重新查詢重新授權；歷史不是目前狀態 |

C01–C12 是需求，不是已完成清單。公開能力不足時須明列缺口；不得以 Core patch、共用高權限帳號或 JSON fallback 達成表面交付。

## 3. 卡片清單與點選落點

卡片是對話中的摘要；不將所有資料一次塞進訊息。共用外觀：**類型圖示＋名稱＋完整定位摘要＋重點內容＋狀態／時間＋明確「查看詳情」操作**。主標題／摘要區可點擊，次要按鈕各自執行，不使用巢狀 button；鍵盤可達相同行為。

| 卡片 | 對話內呈現 | 點選後 Sidecard 預設內容 | 可用互動 |
| --- | --- | --- | --- |
| K01 搜尋／資產選擇卡 | 候選資產、平台、來源、環境、類型；可見結果數與分頁 | 搜尋結果清單與 filter；點候選可先看總覽 | 搜尋、篩選、載入更多、明確「以此資產查詢」；有歧義不自動選第一筆 |
| K02 資產總覽卡 | 描述摘要、平台、Owner 等已取得重點；其他資訊按需讀取 | 「總覽」tab | 展開描述、開欄位／血緣／屬性、引用資產、開原生頁 |
| K03 欄位清單卡 | 欄位數（已載入／可見總數或未知）、數列預覽 | 「欄位」tab 的表格 | 名稱／型別篩選、排序、分頁、點欄位進詳情；本頁篩選與全量搜尋明確區分 |
| K04 欄位詳情卡 | 欄位名稱、型別、描述、所屬資產 | 欄位子頁：定義、屬性、來源／去向、證據 | 切上游／下游、選相關欄位、返回所屬表、引用精確欄位 |
| K05 血緣摘要卡 | 中心資產、小型一層圖或方向清單、已載入數、部分結果提示 | 「血緣」tab，沿用卡片方向／層級 | 圖／表切換、方向／表欄位切換、逐層展開、點節點／邊 |
| K06 下游影響卡 | 已找到的 Dataset／Job／Chart／Dashboard 等分類與限制 | 下游清單與路徑檢視 | 類型篩選、查看已記錄路徑、展開下一層、選資產詳情 |
| K07 屬性摘要卡 | Owner／Domain／Tags／Terms／自訂屬性摘要，未填狀態 | 「屬性」tab 的分類區塊 | 搜尋屬性、展開長值、點人員／標籤／詞彙查看可取得定義及關聯 |
| K08 來源與覆蓋卡 | 查詢時間、觀測時間（若有）、方向／層數、分頁／缺口摘要 | 「來源與限制」tab | 查看每段依據、重新唯讀查詢、開對應原生資產；不提供 raw payload |

錯誤／空結果／載入中是以上卡片的狀態，不另建第九種業務卡片。一次回答可有多張不同卡片，但相同結果不重複鋪成大量卡片；大量資產用 K01 清單承載。

## 4. Detail Sidecard：版型與開關規則

### 4.1 主畫面與右側彈出

以下只示意版型，不是 live 結果：

```text
Agent / Chat                           查詢狀態
┌──────────────────────────────────────────────────────────┐
│ 問：這張表的上游與欄位是什麼？                            │
│ 答：簡短摘要……            ┌─ Detail Sidecard ────────────┐│
│                           │ ← 返回   資產名称        × ││
│ [資產卡] [欄位卡]          │ 平台／來源／環境           ││
│ [血緣卡：部分結果]  ─點選→ │ 原生 compact profile  │頁││
│                           │ 分區標題／分隔線      │籤││
│ 原對話留在原位置          │ 表格／小圖／屬性區塊  │列││
│                           │ 點欄位或關係深入      │  ││
│                           │                            ││
│ Composer                  │ 原生區塊／唯讀操作        ││
│                           └────────────────────────────┘│
└──────────────────────────────────────────────────────────┘
```

- 本案 Catalog Sidecard 為 **Agent 工作區內、由右側滑出的 overlay**，不是插入 ChatWindow horizontal flex 的新 normal-flow child；不推移 message block、不重排對話寬度。這取代 v2 中將此類 Catalog 詳情預設為 split pane 的建議。
- 使用既有右側 panel 容器／開關狀態，新增 Catalog content，不創建第二組常駐側欄；Files／Terminal 保留原功能及狀態。不同內容互斥展示，離開 Catalog 可返回原 panel。
- 以 Agent 容器寬度判斷，不以外層 viewport 猜測。固定版原生 `useSidebarWidth` 預設為視窗寬度的 30%；移植時改以 Agent 可用容器對照原生比例與可讀寬度，不能盲抄 `window.innerWidth`。取消先前 560px／480–720px 自訂定案，實際尺寸以同寬原生畫面校準並記錄；中容器（640–1023px）為右側 modal drawer，小容器（<640px）為工作區全寬 detail sheet，這些為嵌入／可及性適配而非原生已驗宣告。
- 寬容器為非 modal，可操作未被遮住的對話；中／小容器加遮罩並限制焦點在 drawer 內，背景不可互動。只限制 Agent 工作區，不蓋住 DataHub 全域導覽。
- 單次只開一張 Sidecard。點另一張卡更新內容；點已選卡只聚焦，不反覆開關。Header 提供關閉與必要的返回按鈕。
- Header、頁籤列及內容捲動分區採原生 Sidecard layout；「引用到對話」等 Agent 特有操作以同款次要控制整合，不新增搶眼的固定操作底欄。開關不改變原對話捲動與 Composer 草稿，狀態提示不改變聊天布局。

### 4.2 資訊層級與導覽

資產詳情需涵蓋 **總覽／欄位／血緣／屬性／來源與限制** 五類資訊，**不是強制另造五個橫向 tabs**。§3 卡片表中的 tab 指邏輯落點：實作時對映到固定版 DataHub 對應 entity 的原生頁籤、區塊或子頁，沿用其名稱、順序與 compact profile 格式。已讀的 `EntityProfileSidebar` 使用內容區右側垂直頁籤列，不能改成通用橫向 drawer 冒充移植。不適用的資訊入口不顯示；能力未支援或未取得權限則顯示原因，不當作沒有資料。原生沒有的查詢時間／覆蓋限制以同款唯讀區塊補充。

- 點欄位列 → 同一 Sidecard 的欄位子頁，breadcrumb 顯示「資產 → 欄位」。
- 點 lineage 節點 → 同一 Sidecard 的該資產總覽；點關係邊 → 關係子頁，顯示起點／終點、方向、關係種類、實體欄位映射及可取得的依據。
- 以「設為血緣中心」明確重置圖中心；單純看節點詳情不默默換掉原圖。
- 點 Tag／Term／Owner／Domain → 同一 Sidecard 子頁，以名稱、定義、連結與已授權關聯清單呈現；端點不支援則明示並提供可用原生連結。
- 返回保留原 tab、filter、分頁、圖展開狀態及捲動位置。局部導覽沿用既有 panel/session state，不新增永久導覽資料庫。
- 「引用到對話」只在 Composer 加入可移除的資產／欄位 chip 與建議問題，不自動送出；送出時重新核對實際身分與資產權限。目前Actor真session已以一筆引用完成一次真模型送出→`datahub_catalog`再讀→新卡，並核選中metadata未變；這個正例不替代跨身分／送出中授權失效與拒絕負例；同Actor獨立離線96秒使真Grant到期，Gateway對原Cookie從200轉401僅證明該斷線情境的拒絕。
- 卡片點擊、tab 切換、分頁、展開皆走已授權的唯讀查詢，不為每個 click 再叫 LLM；模型負責自然語言意圖與摘要，不控制 UI 結構或授權。

### 4.3 Lineage 的互動與可讀性

- 初次顯示一層；每次「展開下一層」有界載入，不自動走完整個 graph。由 Adapter 提供可用上限／截斷原因；到上限仍可看既有結果，不能聲稱全量。
- 箭頭表示資料流向，上游／下游是相對中心資產；表級、欄位級、Job 相依使用文字圖例及不同線型，不只依色彩。
- 欄位模式使用精確 field identity；多輸入集合保留，不縮成單一來源。transform／條件僅於有依據且允許顯示時呈現，不由 LLM 補寫公式。
- 固定版實作使用 Dataset 的公開 `fineGrainedLineages`，精確 schema 取得欄位 URN 並核對所有端點權限；不由欄位名稱合成 URN。上游按匹配群組分頁，下游按一層 Dataset 候選分頁。任何成員不能核對就不輸出整組；原生 API 可能省略非欄位端點，不宣稱原始 Aspect 全量或窮舉。真3輸入→1輸出與反向讀回已有adapter證據，另有真Agent Sidecard在1440／390px的四欄端點清單與縱向圖讀回；這不代替其他多跳／循環正例。
- Database／Schema 使用原生 Browse V2 的已返回 prefix，不拆 dotted name；治理關聯使用固定的 `relatedTo` 索引，逐頁核對 anchor 與資產 ACL，不擴展子詞彙／子領域／群組繼承。
- Graph 合併相同實體避免重複節點；循環明示、不無限展開。邊數、資產數、路徑數分開，不混為同一分母。
- 每個節點／邊均有可操作的等價表格列；縮放／適合畫面不觸發新查詢，篩選若僅作用於已載入集合須明示。
- 「未記錄欄位映射」不退化為虛構映射；未找到路徑顯示「在本次可見範圍未找到」，不宣稱無業務影響。

## 5. 不直接呈現 JSON 的強制規則

此規則涵蓋本案聊天卡片、Sidecard、工具結果展開、錯誤、來源／技術詳情及重新開啟的本案結果；**不能把 JSON 改藏在「進階」「檢視原始資料」摺疊區便視為符合**。

| 原始資料形態 | 使用者看到的內容 |
| --- | --- |
| Entity／schema 物件 | 有中文標籤的總覽區塊／欄位表格 |
| key/value properties | 可搜尋屬性表：名稱、值、來源（若有） |
| list／巢狀物件／JSON 字串值 | 已知契約轉為分類清單、子表或樹狀屬性列；保留型別、層次、null 與空集合的差異，不輸出大括號 payload |
| Lineage nodes／edges | 關係圖、路徑列、起訖欄位映射表 |
| Tool／HTTP errors | 可理解的原因、影響範圍、下一步與非敏感追蹤碼；無 stack trace、token 或 response dump |
| 證據定位／URN／版本 | 「來源資產」「完整識別碼」「版本」「觀測時間」等具名欄位；URN 可複製，但不要求使用者理解或輸入 |
| 未知結果版本／未知複雜結構 | 顯示「此內容尚無可讀檢視」與具體限制、可用原生連結；保留可正常呈現區塊，不 fallback 成 JSON、不冒稱完整 |

內部工具可繼續使用結構化傳輸；這不是禁止 JSON 協定，而是禁止以 raw JSON 代替使用者介面。已支援內容必須由第一方 renderer 完整呈現，不靠 LLM 把 payload 改寫成可能遺漏的長文；模型摘要只作補充。原有程式碼／檔案編輯功能不因本案禁止使用者閱讀自己的 JSON 檔案。

長文字保留換行，預設適度截斷並可展開；超量資料分頁且標示截斷。可顯示的 metadata 一律視為不可信資料：文字轉義、Markdown 安全子集、連結限制，不執行 embedded HTML／JS。SQL／DDL 若非本案必要資訊不主動顯示，尤其不得把敏感 literal 或秘密送進模型／卡片。

## 6. 時間、完整性與錯誤

每張結果卡／Sidecard 需能取得：選定資產、查詢範圍、資料来源、查詢時間、可取得的觀測／更新時間、已載入數、可見總數（或未知）、下一頁／截斷狀態。內部表示不在本文件固定為新的通用 schema 框架。

- 完整性只相對於 **本次權限、filter、方向、層數及分頁範圍**；不顯示無限制的「完整 lineage」。
- `total`、頁數與 `hasMore` 不一致時，顯示部分／完整性無法確認；例如已載入 3、回報總數 10，即使 `hasMore=false` 也不能宣稱完整。
- 未填寫、未收錄、欄位不支援、無法取得、查詢失敗、未找到可見結果是不同狀態。若權限機制不能安全區分「不存在／無權限」，統一呈現「無法取得此資產」，不得洩漏存在性。
- Loading 使用對應區塊 skeleton；局部失敗不抹去其他成功區塊，每區保留自身時間與狀態。切換到另一資產不能閃現前一資產的欄位。
- 快速 A→B 點選時，取消／忽略 A 的過期回應；以請求與選定資產對應判斷，不允許舊結果覆蓋 B。
- 取消讀取只表示停止等待／取消可取消的请求，不宣稱底層工作已停止。重新查詢由使用者明確發起，不背景無限重試。
- Token 到期顯示連線需重新授權，不向使用者索取聊天內的密碼／token，不把登入頁成功視為 metadata 查詢成功。
- Reload 後保留既有 session 內可用的卡片歷史及查詢定位，標示歷史時間；開詳情時重新驗證權限與讀取目前狀態。過去快照與最新結果分開，不靜默改寫舊回答。
- 不新建 localStorage／IndexedDB metadata cache。切換身分／session 清除當前 Sidecard 內容及請求；既有歷史是否可讀遵守原 session ACL／保留契約，不能宣稱已撤回曾合法讀取的資料。

## 7. 視覺、鍵盤與可及性

### 7.1 DataHub 原生移植基準（必交付，不只是主題換色）

沿用 [現有品牌規格](../../extensions/datahub-agent/design/brand-spec.md)：Mulish、14px 基準、DataHub 紫色選取、白色 surface、細框、低動效；不新增 logo、全域 sidebar 或 UI framework。以本案固定 Core `v1.7.0.1`／commit `e99431ec510d7a2001f815c6bf70913c493af76e` 且實際啟用的 UI 版本為基準，不混用 Cloud 或其他版本的設計。

| 區域 | 需移植的原生呈現 |
| --- | --- |
| 搜尋／資產卡片 | entity／platform 圖示、名稱、來源路徑、次要資訊、描述、badge／chip、hover／selected 狀態與資訊密度；對話只承載卡片，不另創 AI 卡片風格 |
| 右側 Sidecard 外殼 | 原生 compact entity profile 的 header、內容區、右側頁籤列、分隔線、圓角、陰影、收合／關閉控制與捲動層次 |
| 資產總覽／屬性 | 原生 entity header、About／ownership／domain／tags／terms 等適用 section 的順序、標籤、avatar／chip 與長文展開樣式 |
| 欄位／schema | 原生欄位列、型別標示、描述、標籤／詞彙、搜尋與選取格式；不移植 inline editor |
| 血緣 | 原生節點／連線／選取、高亮及工具列的呈現語言；點節點開同款 compact profile，點欄位呈現對應唯讀細節 |
| Loading／空值／錯誤 | 使用原生相同密度與樣式的 skeleton、empty state、提示與狀態標籤，不以 JSON 或大段診斷文字取代 |

本輪已讀的來源（均位於 `upstream/datahub/datahub-web-react/src/app/`）包括：

- `searchV2/SearchEntitySidebarContainer.tsx`：選定結果以 compact context 呈現 entity profile。
- `lineageV3/LineageSidebar.tsx`：選節點開右側 absolute sidebar，包含欄位細粒度資訊；本案只移植呈現行為，掛載仍限制於 Agent 工作區，不照搬 `document.body`／`100vh`。
- `entityV2/shared/containers/profile/sidebar/EntityProfileSidebar.tsx`：原生外殼、header、獨立內容區與右側垂直頁籤列。
- 同目錄 `SidebarCollapsibleHeader.tsx`、`EntitySidebar.tsx`：header 控制與分區間距／框線。
- `sharedV2/sidebar/useSidebarWidth.ts`：原生 30% 預設比例。

這些是視覺／layout 參照，不是公開可直接載入的 MFE API。實作在插件內移植呈現層，解除 Core 私有 registry／context／hooks／內部 GraphQL client 依賴，資料只由已核准的公開 API Adapter 提供。若複用授權允許的純展示 source／assets，保留來源 commit、LICENSE／NOTICE 及必要差異；不得複製整個私有 runtime 或直接 import 上游內部元件。公開擴充契約不足時回報，不以深度 fork 達成。

移植須記錄同版本、同 entity 類型的原生唯讀參考畫面與 layout／token／section 對照；已取得真 Person 原生頁參照，但尚未取得候選 UI 同寬視覺比對證據。升級時集中調整插件的呈現／相容性層，不動 Core。

### 7.2 只可查詢的操作裁切

- 保留：搜尋、篩選、排序、分頁、頁籤／區塊切換、展開、血緣縮放／定位、查看關聯、複製非敏感識別碼／連結、引用到對話、重新唯讀查詢。
- 移除：鉛筆、Edit／Save／Add／Delete、Owner／Tag／Term／Domain 指派、描述或欄位 inline editing、lineage 增刪、建立／發布／批准、ingestion／SQL 執行、表單提交及任何會保存 metadata 的操作；不是留成可點或僅 disabled 的原生編輯介面。
- 原生「更多」選單只列已知唯讀動作；不得直接繼承完整 entity action menu。收藏／追蹤／訂閱／留言等即使看似輕量也屬寫入，不在本案移植範圍。
- 查詢入口後端僅接受已列出的讀取操作，不因使用者是管理員就顯示編輯或容許 mutation；測試需包含偽造 UI 動作的拒絕，不能只靠 CSS 隱藏。
- 「開 DataHub」明確標示離開本案唯讀檢視；原生頁面仍依其自身權限運作。本案不承諾或擅自變更整個 DataHub 的編輯權限。

### 7.3 鍵盤與可及性

- 卡片摘要保持簡潔；完整定位可換行，長 URN／欄位 path 不撐破容器。表格保留標題及必要水平捲動，不造成整頁 overflow。
- 點卡後焦點移至 Sidecard 標題／首要控制；Escape 關閉並返回原觸發卡片，卡片不存在時回到該訊息的安全焦點。
- 寬版非 modal 標明有名稱的 complementary region、不 trap focus；中／小版使用有名稱的 modal dialog、focus trap 與背景 inert。只讓最上層 dialog 處理 Escape，不同時關閉可信審核與其他 panels。
- Tabs 支援方向鍵；關閉／返回／引用均有可讀名稱與可見 focus ring。調整寬度提供鍵盤操作或等價尺寸按鈕。
- Loading／完成／錯誤採節制的 live region，不逐個節點反覆朗讀；狀態同時使用文字、圖示與顏色。
- 手機操作目標至少 44px；200% zoom、長中文／英文名、空資料均可讀；尊重 reduced-motion。

## 8. 接線與安全責任

```text
Chat 提問 → Agent 使用既有唯讀工具 → 已授權結果 → 第一方結果卡
                                                   ↓ 點擊
                                      右側 Detail Sidecard
                                                   ↓ 按需唯讀
                           既有 Gateway／Host／公開 API Adapter
                                                   ↓
                                         DataHub 原生 metadata
```

- 沿用 `extensions/datahub-agent/pi-web/` 的 Chat／工具結果／panel state、`mfe/` 的既有 bridge，以及 `integration/` 身分與公開能力接線。後續按需要補查詢 renderer／薄 Adapter，不先建通用 generative UI 平台。
- 使用者已確認繼續目前 Host／公開 API 路徑，不要求全部改為 MCP。Catalog 使用目前使用者身分呼叫固定 GraphQL 契約；能力不足明列缺口，不另建服務、不偷偷轉用 MCP service Reader。既有其他 MCP 接線保持不變。不得直接讀 DataHub 內部資料表或 import Core 私有 UI。
- Card action 只含已知操作與資產定位，不接受模型傳入任意 URL、GraphQL、SQL、JavaScript 或待渲染 HTML。原生連結由可信固定 DataHub origin 與支援的 route 組成；目前只深連結固定版已確認的 Dataset Columns／highlightedPath 與支援類型 Lineage。
- 圖片 metadata 只當資料。Catalog僅呈現可信DataHub origin下由固定版管理的`/assets/`圖片路徑；不讓任意外部URL、query、credentials或其他endpoint觸發瀏覽器請求，不新增圖片proxy／CDN。
- Runtime／瀏覽器自稱 actor／scope 不是授權。搜尋、明細、分頁、鄰居展開、工具回覆進模型前均須符合實際授權邊界；隱藏卡片不能替代後端 ACL。
- 既有 MCP service Reader 不自動等於當前使用者的原生權限。實作前驗證授權映射／批准的可見範圍；不明確時不得把 reader 可見全集當作所有使用者可見。限制資產的名稱、統計、路徑、tooltip 同樣不能洩漏。
- 審核／發布 Sidepanel 仍由可信 MFE／Host 負責。Catalog Sidecard 沒有 approve/write 能力，不能復用其 UI 狀態作為人工核准；與可信 dialog 衝突時暫停／收起查詢 drawer，不疊成多個可互動面板。
- DataHub 是 metadata 權威；Pi 現有 session 只是對話／展示歷史。圖與卡片不是第二份 Catalog，不需要新增 datastore 或 Aspect。

## 9. 交付順序與完成線

初始交付為本文件及設計入口；後續使用者已限定授權本機Agent-only候選與單Actor唯讀測試，不代表正式部署／來源寫入授權。此分支的進度與未完成項目見[公開 WIP 狀態](../verification/datahub-agent-catalog-explorer-wip.md)。**B 方案完成須包含兩階段，不以第一階段替代整體。**

### B1：先可查、可點、可讀

- C01–C06、C09–C12 基礎能力與 K01–K05、K07–K08；K05 先提供完整等價方向清單。
- 移植 DataHub 原生卡片與 compact profile Sidecard，將五類資訊對映到原生頁籤／區塊；提供欄位／屬性子頁、返回／引用／原生連結，裁掉全部寫入動作。
- 分頁／部分結果、同名消歧義、連線／權限錯誤與 JSON 零直接呈現。

### B2：輕量視覺探索

- K05 一層小圖及可互動圖／表切換、C07 欄位追蹤、C08／K06 有界下游與路徑。
- 節點／邊的同一 Sidecard 深入、欄位高亮、循環／超量／不完整路徑處理。
- 不以新做完整圖形工作台擴大範圍，仍以現有 metadata 能力為界。

### 必要驗收

| 情境 | 通過條件 |
| --- | --- |
| 真 Agent 查詢 | 從 `/mfe/agent` 模型提問得到實際卡片；結果與官方 API／原生頁面核對，不以 preview 或 mock 代替 |
| 卡片→詳情 | K01–K08 各自開正確頁；點欄位／節點／邊／詞彙可深入並返回，原 context 不遺失 |
| 身分消歧義 | 同名不同來源／環境不混淆；無法唯一定位先選擇，不猜 URN |
| 無 JSON | 正常、空值、巢狀屬性、未知版本、錯誤、展開工具結果、歷史重開皆無 raw JSON 或 stack dump；受支援內容不遺漏 |
| 血緣正確性 | 表／欄位／Job 關係分清；方向、多輸入、循環、未記錄欄位映射正確；不混 Join／候選 |
| 完整性與時間 | 真分頁／截斷與範圍一致；total／hasMore 矛盾不報完整；查詢時間與觀測時間分開 |
| 快速互動 | A→B 切換、關閉、重新整理與斷線不把舊回應放入新卡；不重複自動送模型 |
| 真權限負例 | 用實際授權身分確認搜尋、直接定位、分頁、鄰居、重新開歷史的邊界；reader token 不擴大 actor scope |
| Responsive／a11y | 390、768、1280、1440 視窗並記錄實際 Agent 容器寬；鍵盤／焦點／Escape／200% zoom 通過；開關 Sidecard 不推移 message block |
| 原生呈現一致性 | 同版本、同 entity、同容器寬對照原生卡片與 Sidecard；核對 header、右側頁籤列、區塊順序、型別／chip、間距、字體、圖示、框線、陰影、選取與捲動；列明唯讀裁切及嵌入／a11y 必要差異，不能只以配色相同通過 |
| 唯讀／回歸 | 一般使用者與管理員均無編輯／新增／刪除／發布及隱含寫入入口；後端拒絕偽造 mutation；真查詢流程沒有來源 SQL、ingestion、metadata 寫入；Chat／Composer 草稿／Files／Terminal／可信審核行為不退化 |

390px依使用者2026-09-24決定，以**先手動操作DataHub原生Navbar toggler**的實際容器驗收；初始展開仍僅66px，不暗中觸發Core DOM，也不聲稱一進入即適用。真正Browser 200% zoom已用隔離Chromium持久profile的原生HostZoomMap讀回：1440px實體視窗對應720px CSS，真Agent Sidecard可讀、焦點留在modal且Escape關閉；它與先前720 CSS px／DPR2的CDP**等效版面**不同，不以後者冒充前者。這只驗單一Actor與該視窗，尚非390px疊加200%或全部鍵盤情境。能力未獲公開 API 支援、權限契約未成立或必要真環境證據缺失，須標示未完成，不能用JSON、模型猜測或原生連結代替所承諾的互動。

# Catalog Explorer：本地實作與限定真實讀取紀錄

更新：2026-09-24。歷史追蹤：`TODO-cdd3f40a`（已以 superseded 關閉）；剩餘 B1／B2 驗收由 `TODO-dd8633ca`、正式整合由 `TODO-db4b9c85` 承接。下方歷史段落的「舊 TODO in_progress」描述其當時狀態，並非目前任務狀態。

**狀態：LOCAL_IMPLEMENTATION_IN_PROGRESS；Agent-only 候選已在本機啟用，真搜尋已恢復，B1／B2 整體仍未驗收。**
依 [設計](../design/datahub-agent-catalog-explorer.md) 與使用者最新決定，繼續原本 Host／公開 API 路徑，**不改為全部 MCP、不擴充架構**。已獲准在本機以目前 Actor 只讀測試及重試登入；憑證未輸出或保存到產物。已切換 Agent-only 候選、啟用單 Actor Catalog read policy 並執行限定模型測試；未修改 Core、執行來源 SQL／ingestion 或寫入 metadata。實際驗證範圍與未通過項見下方最新紀錄，不將部分真入口成功當完整 ACL／視覺／B1+B2 驗收。

## 已接線

```text
自然語言 → datahub_catalog → 原生 RPC input
  → DataHubHostBridge → MFE Catalog MessageChannel
  → /agent/catalog → 當前 DataHub cookie／me／公開 GraphQL
  → 固定唯讀投影 → 專用卡片 → 同一右側 panel 的 Catalog overlay
```

- `integration/native-catalog.mjs`：固定 `search`、`entity`、一層 `lineage` 與 `fieldLineage` queries，禁止任意 query／URL／actor／mutation；request、分頁及 response 大小有界。每次重新檢查 `me` 及各資產 `GET_ENTITY`／`VIEW_ENTITY_PAGE`，不以 `EDIT_ENTITY` 代替 read 權限；欄位資產另外驗證 parent。
- 不使用 MCP service Reader 代替目前使用者。既有 MCP 的歷史成功不足以證明跨 actor 授權，因此此路徑使用目前 cookie 的公開 GraphQL；未重新驗證舊 MCP 連線，也未修改其設定或全域工具。
- Gateway 保留既有 parent origin、fresh identity、grant／parent proof 邊界；runtime origin 不能直接存取此控制面路徑。
- `catalogReadByActor` 是 operator-only、**預設停用**的 activation policy。每個 48-hex actor key 需明列 `{modelContextApproved:true, propertyNames:[]}`；自訂屬性僅列入核准的名稱。此配置不授予 DataHub 讀權限，不能略過上述 ACL，也不應未經資料審查就啟用真模型傳輸。
- 專用 `MessageView` renderer 提早截取 Catalog 的 pending／成功／錯誤／未知版本，沒有 generic JSON fallback。巢狀屬性以具名清單呈現，HTML 作文字處理。
- Sidecard 已有總覽、schema 表、精確欄位子頁、治理 references、自訂屬性、圖／表血緣、返回、分頁、重新讀取與引用。欄位搜尋／path 或型別排序作用於本次取得的整份 schema，不只目前頁；原生型別與 DataHub 型別分開，不以一者代替另一者。Dataset／Container 的 subTypes 取原生返回值（真 Table 已核對），不從名稱猜 Table／View。
- 搜尋支援平台、instance、環境及原生 Browse V2 prefix。Database／Schema 的選項來自返回路徑與 subTypes，每個可連結 ancestor 另查權限；有隱藏／未解析祖先就省略整條路徑，不拼出假 scope、不拆 dotted name。CONTAINER 可讀詳情，不代表能取得其全部資產；原生 prefix 用 U+241F `␟` 分隔，不是 U+001F。
- 治理關聯搜尋 `relatedTo` 使用固定版公開索引：TAG→tags/fieldTags、GLOSSARY_TERM→glossaryTerms/fieldGlossaryTerms、DOMAIN→domains、CORP_USER/GROUP→owners。每頁重讀並授權 anchor，再搜尋及逐項授權；其他 filters 保留於每個 OR branch。不推定匹配欄位或擴展子詞彙／子領域／群組繼承。K01–K08 尚未逐類完成真 UI 驗收。
- `DataHubCatalogLineage.tsx` 只用返回節點／邊，逐資產查一層／下一頁；圖／等價清單、循環提示、已找到一條路徑、類型篩選、縮放、關係詳情、設為中心；圖狀態與已讀頁隨既有 Sidecard history 返回保存。重新讀取清掉目前展開頁。欄位線採虛線；不推論轉換公式或多輸入群組，不宣稱跨頁一致性快照。
- `fieldLineage(dataset, fieldPath, direction)` 使用公開 `fineGrainedLineages`，不是把 `schemaField` 關係圖空值當作沒有映射。精確核對原生 schema／field identity、所有 Dataset 與欄位 ACL；任一端點不可讀或無法核對，整組不輸出，不壓成單一來源。`DataHubCatalogFieldLineage.tsx` 提供完整集合圖／等價表、端點深入與引用，沒有合成持久化群組 ID。上游按匹配群組分頁；下游按一層 Dataset 候選分頁，並非窮舉所有映射。每頁最多20組、每組100端點及既有回應上限；超限拒絕，不靜默截掉組員。
- 只讀原生公開 API 返回的欄位端點；`FineGrainedLineagesMapper.java` 會省略非 schemaField 端點，不能稱為原始 Aspect 全量。原生 `SchemaFieldRef.urn` 實際是 parent Dataset URN，`path` 另列；不自行組裝欄位 URN。不查 `query`／`transformOperation`，不曝光 SQL 或補造公式／群組時間。
- Composer 可移除引用 chip 沿既有 draft store 保存／rekey／失敗還原，點選不送出。一般送出、steer、follow-up 皆先重新讀取並授權；核對期間草稿變更、取消或切 session 不送出旧快照。此段記錄初期本地程式接線；後文已有一次真瀏覽器引用送出正例，負例仍缺。
- 重用 `#file-panel`；Catalog slot 覆蓋而非新增 chat flex item，原 Files／Terminal 留在原容器。Container query 與 ResizeObserver 使用工作區寬度；小／中容器 modal、背景 inert、Escape／focus trap，寬容器 non-modal。
- request identity 在 **render** 階段綁定 payload／error，避免 A→B 選取後 effect 尚未執行時閃現 A 的內容；AppShell 同樣在 render 階段按 session／Files／Settings scope 隱藏不符的詳情，再清理狀態與還原原 panel。完整真 session／reload 回歸仍待做。
- 共用既有 React context 搬到 `lib/catalog-context.ts`，不新增 store。custom UI、一般 extension dialog、Task decision／workspace import、Semantic review 開啟時先收起 Catalog，保留可信審核原本的提交／發布邏輯。dialog 在 inert 清理後取得容器焦點，不自動聚焦批准按鈕；再點已選卡片聚焦既有 Sidecard。此為本地接線，尚未真 UI 驗證。
- `schemaCreatedAt` 僅表示 schema 建立時間，非來源資料觀測時間；關係 `createdAt`／`updatedAt` 與 `queriedAt` 分列，不互相代替。取消與 timeout 的安全文案分開。

## 固定版原生來源與已知差異

Core：`v1.7.0.1`，`e99431ec510d7a2001f815c6bf70913c493af76e`。上游保持乾淨。
所有來源皆為 `upstream/datahub/datahub-web-react/src/app/` 下的只讀參照，不 import Core runtime：

| 來源 | 本地移植落點／裁切 |
| --- | --- |
| `searchV2/SearchEntitySidebarContainer.tsx` | 點卡進 compact entity context；資料改由 Host adapter 提供 |
| `lineageV3/LineageSidebar.tsx` | overlay 與欄位深入；不複用 registry/context、不掛 `document.body` |
| `entityV2/shared/containers/profile/sidebar/EntityProfileSidebar.tsx` | header／獨立捲動內容／右側垂直頁籤骨架 |
| 同目錄 `EntitySidebarTabs.tsx` | 64px 軌道、52px tab、48px label、20px icon、10px label、4px gap；無原生寫入／選單 runtime |
| 同目錄 `SidebarCollapsibleHeader.tsx`、`EntitySidebar.tsx` | 分區、分隔線與 header 控制的呈現參照 |
| `sharedV2/sidebar/useSidebarWidth.ts` | 30% 起點，改以工作區容器計算；可讀最小值及 responsive 差異仍待原生同寬校準 |

現有 DataHub LICENSE／NOTICE、Mulish OFL 保留。預設 entity／sidebar 圖示已改為固定版實際使用的 Phosphor 2.1.7 regular glyph，不再把未知類型畫成表格。17個 path 定義核對上游 yarn.lock 的 sha512 與原 archive；只解析靜態 path、不執行套件程式、不新增 runtime dependency／CDN。原 MIT 授權與 provenance 在 `design/assets/`，license 同時置於 pi-web public，既有 browser-assets Docker export 增加 license COPY（此階段未 build／部署；後文另有本機切換證據）。**DataHub 管理的 `/assets/` platform logo／profile image 已接到卡片、詳情與圖節點；完整 entity sections、chips／skeleton、密度與同寬視覺仍未校準，原碼參照一致不等於新 UI 視覺驗收。** 平台 `properties.logoUrl` 與使用者／群組 `editableProperties.pictureLink` 可指向外部 URL；Catalog 僅允許同一 DataHub origin 下、固定圖片副檔名的 `/assets/` 靜態路徑。任意外部網址、query、credentials 或其他 endpoint 均省略，不新增圖片 proxy／CDN，也沒有以 ingest selector 圖檔或生成 avatar 代替。

## 2026-09-23／24 真 Agent 入口首輪：歷史失敗（原因與後續修復見下一節）

- 使用者核准本機 Agent-only 候選建置／切換、目前 Actor 的唯讀 Catalog policy、一次 `.local/user.props` 登入及一個自然語言模型請求；第一次驗收腳本在模型前因 `/api/models` 未帶 UI 使用的 allowlisted cwd 得到403。該次登入200、模型0次；經使用者另准**一次**矯正登入，腳本以 `/api/home` 傳入cwd並阻擋tracking POST。兩次登入權限已耗盡。
- 隔離候選來源為 HEAD 加32檔Catalog patch，建置映像 `sha256:2824eb0d55c6d56f6600bc7a963925273e3972af39b193f403cebe66a7604a30`；MFE／browser assets按同來源建置，image 541個 pi-web 檔byte相同、223個browser assets含license一致。舊exact-image checker未納入刻意新增的授權檔，已修正成與映像內public LICENSE核對後通過；首次失敗保留。Agent-only切換三個設定欄位（映像、assets、單Actor Catalog policy），Core／GMS／DB容器不變，HOME保留，正式downstream patch／lock仍未更新。
- 矯正登入200、Agent iframe及預設模型可讀，session開始前無running session；**一個真模型請求已送出**。原生 session `01a0d092-b51f-77d0-9c5b-4b95bdda56fc`讀回模型呼叫`datahub_catalog`三次（皆合法search、DATASET、limit20／20／預設），三個toolResult均為`catalog_invalid_response`，最後assistant stop，沒有SQL／ingestion／Task／semantic tool。外部搜尋服務MCP token失效日誌是獨立訊號：此工具接Host／公開GraphQL，不能據此宣稱它是Catalog錯誤根因。
- 該次shell回報`Command aborted`、沒有exit receipt；腳本在模型提交後的heading等待階段被中止，只保留提交前的Playwright receipt快照，**沒有保留三次`/agent/catalog`的HTTP status/body**，因此目前無法判定是Host原生`catalog_invalid_response`還是成功Host結果遭Pi contract拒絕；先前已授權真search/entity錄製結果在目前contract可通過，但不代表本次三筆查詢也通過。不能稱根因已證明、不能重送模型或再次登入。
- 當時中止後對帳Gateway及Runtime仍活、Runtime只4個基礎程序無模型進行中，Core ID／image／StartedAt逐項不變；測前選中Dataset aspects的唯讀hash為`2227d07c5326f56ac605c29de2da82fdda744fee26969210a73a25378a99773e`，**該次測後未讀回**，不宣稱全域無寫入。初次根因未知、候選仍在線且policy啟用是當時狀態，後續已取得追加本機測試授權並定位修復。私有證據：`.local/evidence/catalog-explorer/live-e2e-20260923/`中`attempt-1-script-cwd-failure/`、`attempt-2-interrupted-after-model/`、候選產物、pre-switch及rollback snapshot；不可上傳。

## 2026-09-24 真因、修復與本機真入口讀回（仍非 B1／B2 完整驗收）

- 使用者取消本輪登入次數限制並要求繼續本機查因／解決；範圍仍是同 Actor、`localhost:9002`、唯讀 Catalog／metadata，不授權 SQL、ingestion、metadata 寫入或 Core 改動。以原失敗 session 的三筆原始 search 參數直接呼叫 Adapter，三次穩定重現 HTTP 502 `catalog_invalid_response`；身分、搜尋、摘要及權限 GraphQL 原先均 HTTP 200。錯誤發生於 Browse V2 linked ancestor：真 Dataset 的祖先為公開 `DataPlatformInstance`，原 `entityType()` 只接受任意 entity 的既有類型，未在**祖先脈絡**容許 `dataPlatformInstance`，整頁因而拒絕。公開 GraphQL 與目前 Actor 的 `VIEW_ENTITY_PAGE` 查詢核對該祖先型別／`instanceId`／授權，非 MCP token、模型或 renderer 故障。原三次失敗的直接診斷與 ACL 證據：`live-e2e-20260923/native-diagnosis-before-fix.json`及`browse-instance-acl.json`。
- `integration/native-catalog.mjs` 僅在 Browse 祖先脈絡接受此型別，仍逐祖先 `VIEW_ENTITY_PAGE`；不允許任意 `dataPlatformInstance` entity/search。首次加上原生 `properties.name` 時，真 GraphQL 精確回報 Container／DataPlatformInstance `properties/name` nullability 衝突；改用 `instanceProperties` alias 後三筆原查詢分別返回20／20／10個可見資產、GraphQL errors為0、產品契約均通過。第一次額外失敗與原始 schema 錯誤分別存於 `native-diagnosis-after-query-conflict.json`及`native-summary-graphql-error.json`，成功於`native-diagnosis.json`；原始失敗未刪除。可重跑 `scripts/check-agent-catalog-native.mjs` 用真可見 Dataset 動態抽驗該祖先：`native-browse-instance-regression/receipt.json`共33項真讀取PASS，其中1筆可見 Dataset 含原生 instance；沒有 hardcode 業務 URN 或把 fixture 當驗收。
- 同時修正 MFE Catalog MessageChannel allowlist 漏掉既有後端 `fieldLineage` action；其他請求仍拒絕。只重啟本案 Gateway 並換本案 MFE bundle（新 `24.js` SHA256 `428b2b6d86436abd2a1c733b4ea21c7c6f85b27319eb70ac1f076c4a4e758a54`）；原 Runtime image `sha256:2824eb0d55c6d56f6600bc7a963925273e3972af39b193f403cebe66a7604a30`、設定／單 Actor policy、Core／GMS／DB 容器保持不變。新版來源隔離候選 `.local/evidence/catalog-explorer/catalog-only-integration-browse-instance-fix/`：HEAD＋32選定檔 patch SHA256 `8789603eeb362a3afacbbcbf4cad8f238e60eb90773b2008720460ecb4368e7b`，833檔正反byte/mode與候選tsc PASS；正式 downstream patch／lock未動，此隔離不等於獨立 review／正式 gate。
- 真 `/mfe/agent` 單次新模型提交，原生 session `01a0d102-f775-710b-b433-40aa666b553a`最後 stop：**2次 `datahub_catalog` 工具呼叫／toolResult 都成功、無其他工具呼叫**。瀏覽器保存5筆Host `/agent/catalog` 200且產品契約通過，包含search／entity／fieldLineage；顯示原生卡片、Person 詳情、欄位、受控MSSQL logo (`/assets/platforms/mssqllogo.png` HTTP 200)、schema／lineage深連結及可移除 Composer 引用chip，未提交 chip。測前後選中 Dataset aspects canonical SHA同為`2227d07c5326f56ac605c29de2da82fdda744fee26969210a73a25378a99773e`；僅證明**這組所選metadata**未變，非全域無寫。完整安全形狀與失敗截圖於`live-e2e-20260923/attempt-3-host-recovery-ui-test-mismatch/`。該輪腳本在引用後誤以為 Sidecard 應持續存在而失敗；原產品 `AppShell` 的 `onQuote` 本就呼叫 `closeCatalog()`，故屬腳本預期錯誤，不把它算成產品失敗或完整PASS。
- 另以新登入開啟**同一個已完成session，模型提交0次**，展開原生「Process details」（歷史預設收合）後可讀回兩筆持久化搜尋卡，再次點詳情得到Host entity 200並開真DataHub dataset URL回200；Escape關閉、重新載入後同session仍可展開卡。`existing-session-browser.json`及4張`existing-sidecard-*.png`有逐寬實測：1440（工作區1116px，非modal）、1280（956px，modal）、768（444px，modal）；**390真viewport工作區僅66px，側卡65px且文字逐字換行，實際不可用，不能因DOM未overflow就算PASS**；另有獨立 `responsive-readability-assessment.json` 將腳本的DOM-only結果正確評為必要390可讀性 FAIL。官方DataHub左側導覽佔寬造成 iframe容器不足；不可為此直接改Core或跨iframe私自覆蓋Host。當時設計§9的390與200% zoom尚未通過／未驗；下文紀錄使用者接受原生按鈕手動收合及後續真Zoom新證據，保留這張原始失敗圖，不把它改成PASS。此輪只阻斷DataHub tracking POST，未發模型／來源寫入；測前後同一選中metadata hash一致。當前Actor的真權限正例不代替跨Actor／expired grant負例、非空治理、multi-hop/cycle、同寬原生視覺與完整panel協調。
- 現在 Agent-only 修復候選與單Actor policy仍在線；沒有執行未授權回滾。B1+B2／CE01–CE09仍屬部分進度，正式downstream及必要負例／設計§9缺口未結案。所有 `.local/` 私有證據不得上傳；不得沿用首輪「根因未知／尚未真E2E」句子描述現在的狀態。

## 2026-09-24 B1＋B2 整合續測：真3→1欄位圖、390px及本機映像（仍未完成 TODO）

- 使用者核准本機繼續實作／整合，並明確接受**按官方 `Navbar toggler` 手動收合左欄後**作為390px測試條件，不授權直接改 Core DOM。真390px初始Agent iframe為66px、側卡65px不可讀；按官方控制後iframe318px／側卡317px，重新載入仍維持收合。此為有條件可用，不宣稱初始展開即符合。`live-e2e-20260923/mobile-nav-probe.json`及`mobile-sidebar-{open,collapsed}.png`保留前後實測。
- 同一完成的真Agent session、**模型提交0次**，Sidecard 搜尋來源從真原生資料動態選到有 `fineGrainedLineages` 的 Dataset，點欄位 `fullname` 上游：Host search/search/entity/entity/fieldLineage五筆均200且產品契約通過，最後一組原生 **3輸入／1輸出**，清單及圖均有完整四端點。真1440與收合左欄後真390均通過；`mapping-browser-receipt.json`、`mapping-mobile-browser-receipt.json`及`mapping-group-graph-{1440,390}.png`。所選 Dataset 的既有 aspects 前後 canonical hash同為`8596ae7ce6277ba6145b52dd3cfb4a35112844fa65fa7fc636baf3118ad653a3`；僅此範圍不變。兩次測試腳本誤用 entity詳情中的搜尋欄與不存在的「完整群組」文案，原失敗證據留在`mapping-attempt-{1,2}-*/`，改讀實際來源與輸入／輸出集合，不重送模型。
- 真圖原兩欄在333px側卡把英文欄名逐字斷行；`DataHubCatalog.module.css`現在以**側卡自身**作為 container，窄內容改單欄＋向下箭頭，不縮資料集合；真圖截圖可讀。真390使用官方收合後的第一輪發現本案「關閉詳情」僅32×44px，按設計至少44px修成44×44，其他可見Catalog控制亦達至少44px高。焦點在Sidecard內的Escape、非modal1440及modal1280／768／390、讀回歷史卡／reload、同資產原生URL 200均通過。最終browser receipt `live-e2e-20260923/existing-session-browser.json`，四寬工作區1116／956／444／318px；父頁導覽按鈕焦點仍在iframe外時Escape不會送進側卡，測試必須先把焦點置於Sidecard，舊失敗均保留於`css-build-20260924/responsive-attempt-*/`。不把跨iframe焦點問題隱藏為同一焦點上下文。
- 最初真瀏覽器 `Control+Equal`（含headed）未改變Chrome zoom；當時CDP以720 CSS px、DPR2做的等效版面**不能當Browser Zoom**。後續依Chromium原生`partition.default_zoom_level` profile字典的預設partition key `x`設為`log(2)/log(1.2)`，用獨立持久profile啟動**真正200%頁面縮放**，而非CDP更改viewport：真`/mfe/agent` 1440px實體視窗，父頁`outerWidth=1448`／CSS `innerWidth=720`／DPR2／`visualViewport.scale=1`，iframe388 CSS px，modal Sidecard387 CSS px，無iframe水平溢出，關閉目標44×44；焦點Shift+Tab仍在Sidecard、Escape關閉。原生CDP**僅用於不裁切的1440×900截圖**（`native-200pct-cdp-page.png`），不設定縮放；Playwright `page.screenshot`在Chrome真zoom下只截到左半，不能當視覺證據。`native-200pct-receipt.json`及原生截圖、原失敗記錄保留。此為真單actor／已完成session的200%正例，**並非**390px與200%疊加或全鍵盤測試。
- 本機最初用固定Dockerfile、受限BuildKit做兩次建置均在`npm ci`遭`ECONNRESET`；另一次**不同條件的有界診斷**以私有Dockerfile降低`npm ci --maxsockets=4`，約5秒仍遇`ECONNRESET`（exit 152），排除僅因預設並發過高即可修好的假設，未修改正式Dockerfile，BuildKit事後停止且未清cache。此臨時檔缺正式同名`.dockerignore`，導致僅本機BuildKit context約1.96GB（含本機`node_modules`／`.next`，無`.env*`檔）；正式Dockerfile仍有專屬ignore，不以本次診斷取代正式建置。原始stdout/stderr/exit見`css-build-20260924/npmci-maxsockets4.*`。**乾淨可重現建置關卡仍FAIL**；不繼續盲重試。使用者授權主代理自行決定本機驗證路徑後，核對已驗舊 Runtime image與候選 `package-lock.json` SHA256皆為`9b3ba273d59a7b947b66af18710e78fec1e14ed988ef284008ce2ba8aa3a8ca8`，以私有`Dockerfile.pinned-deps-rebuild`重編全Pi Web作**本機增量驗證，不能冒充標準 Dockerfile 乾淨建置**。最終image `sha256:34b3978d916da3518fe5e1f20ac0567715d50e800ed4418109263f3c8aa6edff`：541來源檔與映像exact、223 browser assets exact、image內LICENSE與Operator契約核對PASS；隔離Catalog-only HEAD+32選定檔 patch SHA256 `1382070ad2deb01589c1948d3fbf33befed980f2c9aff79c458f5167e82fc506`，833檔正反byte/mode及候選tsc PASS。只換本案image及browser asset路徑，Gateway原生MFE、單Actor policy、HOME和Core/GMS/DB ID／image／StartedAt不變。完整原始建置失敗、校正、source/image gate及兩次有界Agent-only切換證據在`live-e2e-20260923/css-build-20260924/`；正式 `pi-web-downstream.patch`／lock未更新。
- 建置原因再收窄但未修復：同一受限BuildKit的隔離`GET`可下載並驗證`@earendil-works/pi-coding-agent@0.85.1`約6.99MB tarball與鎖檔SHA-512相符；`npm ci --loglevel verbose`完整紀錄顯示它在`reify`該tarball時`read ECONNRESET`（非lock integrity錯誤），pkg.pr.new及registry的其他有界GET亦200。原診斷Dockerfile首輪缺`/app` chown先得EACCES，補相同user權限後才取得上述npm錯誤，兩次原始stderr分別保留`npmci-verbose-eacces.stderr.log`及`npmci-verbose-2.stderr.log`；並未證明所有依賴可由官方Dockerfile乾淨取得，不加重試、代理或停用檢查來洗白。BuildKit已停止。
- **2026-09-24鏡像受限診斷，仍未過乾淨建置**：使用者允許自行處理npm鏡像。主機對`registry.npmmirror.com`固定`pi-coding-agent@0.85.1` tarball HEAD200，下載檔與`package-lock.json` SHA-512相同（此單包證據不能代表1139筆依賴）。用**私有**正式Dockerfile拷貝＋完全相同的專屬`.dockerignore`／3GB受限BuildKit跑`baseline`乾淨npm安裝：`replace-registry-host=always`誤把兩個具integrity的`pkg.pr.new`固定commit改成鏡像404，已在後續實驗改為`npmjs`只替換1137個registry.npmjs.org來源；完整標準並發約415秒`read ETIMEDOUT`，verbose且不重試診斷約128秒觀察多個`cdn.npmmirror.com`下載同時FETCH_ERROR，mirror `--maxsockets=4`約273秒仍有多個registry/CDN端點`ECONNRESET`／`ETIMEDOUT`（有913個HTTP200，不足以完結）。原始各失敗及私有實驗Dockerfile在`.local/evidence/catalog-explorer/live-e2e-20260923/npm-mirror/`；BuildKit已停止，**正式Dockerfile／lock未改，沒有鏡像建置PASS**。繼續盲重試、把增量映像冒充乾淨鏡像，或把lock內`pkg.pr.new`換到不存在的mirror路徑皆不可接受。
- Files／Terminal協調續測：真session的既有右側Files空面板可在Catalog開／關後恢復原開／關狀態；另只建立**一個**原生Terminal，禁止shell輸入、不讀其輸出，Catalog覆蓋與關閉後仍是同一個ready Terminal、無重新建立，最後DELETE一次；Host Catalog讀取3筆。`panel-readonly-receipt.json`、`panel-terminal-receipt.json`各PASS；第一次腳本曾試圖點被Sidecard正常遮住的Files按鈕及另兩次猜錯「Open workspace terminal」文案，原失敗receipt保留。這**不驗證**終端命令或FileViewer檔案內容與可信review dialog，也不擴充任何執行權限。
- 舊有界真資料圖檢查只涵蓋一個鄰居。先以相同Actor／來源AdventureWorks2019及固定原生ACL有界讀25筆（10個同browse root Dataset、7個同來源邊），再獨立擴至另外三頁＋原首頁、80個同root候選，48筆預算實際47次native read、觀測17條同來源邊，兩輪都**沒有真兩跳或循環路徑**。`recorded-paths-receipt.json`、`recorded-paths-expanded-receipt.json`均只證各自受限採樣未發現，不代表全來源無循環、不可把一跳展開當多跳正例；該AdventureWorks範圍需要已有且可見的實際樣本或明確批准擴至其他來源，不建立假metadata；使用者後來提供Salesdatamart，已另取得真兩跳正例（見下文）。
- **Salesdatamart真兩跳補證**：依使用者提議，只用目前Actor在DataHub Catalog查現有Salesdatamart metadata、不連來源DB。第一頁10、第二頁4個可見Dataset；第二頁真原生lineage有三個互異URN、兩段逐層同root／同platform授權可見的資料流向。沿**既有**真Agent session的「搜尋與完整清單」表單搜尋Salesdatamart（模型0新提交）、選精確資產，Host search×2／entity×1／lineage upstream×1＋downstream×2共6筆200／契約通過；逐層展開後「已找到路徑」按資料流向為**完全相同三個URN**，16筆已載入關係的圖與等價表數量一致，所選Dataset八類aspects前後canonical hash相同。`.local/evidence/catalog-explorer/live-e2e-20260923/{salesdatamart-next-page-receipt.json,salesdatamart-two-hop-browser/receipt.json}`；初次Browser腳本未等新搜尋完成而誤判的原始失敗保存，無重送模型。這是目前Actor＋該實際來源的**兩跳正例**，不能推論所有路徑可信或循環已驗。
- 同源Salesdatamart 14筆可見Dataset的有界entity讀取（第一頁先4再6、第二頁4）未找到非空治理reference或欄位Tag／Term；不把0當非空正例，也不寫入假metadata。真循環仍缺。`salesdatamart-{feasibility,next-page,remaining-governance}-receipt.json`私有保存精確授權範圍。
- **真下游影響／路徑操作**：沿已完成session的現有可見Dataset卡片（模型0新提交）按「下游影響」，Host 3筆`lineage` DOWNSTREAM均200/契約通過。初始顯示5條原生關係；同一批已載入資料的圖／等價表關係數相同；點首個可見鄰接資產「已找到路徑」只回2節點／1跳；再「展開一層」重新讀真Host，設該鄰接資產為中心、返回能恢復原清單。所選Dataset八類aspects前後canonical SHA相同。私有`lineage-navigation-live/receipt.json`；前兩次腳本過早檢查 hydration、誤用詳情原生URL文案而失敗的原證據保留（不是產品錯誤）。**沒有**真兩跳或循環，不能從一跳及展開請求外推。
- **真Composer引用送出**：從已完成的真session動態選現有Dataset卡片→Sidecard「引用到對話」產生一個可移除chip且不自動送模型→於目前Actor／原生入口只送出**一次**附引用的自然語言prompt。模型本輪只呼叫一次`datahub_catalog`（從真session GET結構核對最新user／assistant／toolResult／assistant與toolName；沒有其他工具），Host `/agent/catalog` 共3筆 `entity`讀取均200且契約通過，新訊息多出可點擊原生卡、Composer引用已消耗。所選Dataset 8類aspects前後canonical hash相等。Browser阻擋tracking POST並監控禁止的Host ingress；沒有觸發ingestion／Task／semantic endpoint。`composer-reference-live/receipt.json`及`tool-names-receipt.json`，初次toolName parser誤讀`name`而非`toolName`的原證據另存；此結果**不代表**全域metadata沒有他處變化或跨Actor權限已驗。
- **CE09隔離候選正式checker rehearsal**：從來源`agegr/pi-web`固定commit tar下載，逐一核對原始506檔SHA-256並按Git lock復原mode（GitHub tar的group mode不同，不能直接當mode依據）。只在隔離樹用HEAD 529檔＋已選Catalog 21個pi-web路徑重建541檔候選，保留HEAD本有5檔manifest byte差異＋7未列路徑、排除選定檔以外的獨立test/E2E差異與process-details單獨hunk；**選定的共用檔仍包含現工作樹既有ETL/Semantic hunk**，不稱整體功能已審。完整 upstream→候選patch SHA256`0d982fc5ce3b51d177b5bf7ed3d70b3817b18092de5d63acf7e6212174873731`、候選lock SHA256`795eaba95284c6d6387a33d30f43a1948677cfdfae5d57035c4e02613a786c62`；`git apply --reverse`將541檔精確還原506原始byte／mode，原`check-agent-downstream.py`在只讀重演倉執行PASS（含原Foundation測試，該測試的合成config不是本案live驗收）。`.local/evidence/catalog-explorer/formal-catalog-candidate/`保存patch／lock／receipt／checker輸出。**這不是現工作樹的正式downstream通過**：live另有獨立dirty工作，正式`pi-web-downstream.patch`及lock仍舊；不可把此候選checker或前述live瀏覽器（不同image檔案集合）交叉宣稱同一source-bound發行通過。
- **目前Actor真離線失聯後Grant到期負例**：在獨立瀏覽器正常由MFE登入、Runtime `/api/agent/running`與經相同partitioned cookie回送本機Gateway都200；僅對該測試瀏覽器封鎖`/agent/heartbeat`與`/agent/revoke`傳輸（**不回傳假200、不改Gateway時鐘／ACL或正式設定**），封鎖當下原Cookie仍200，封鎖過1筆heartbeat、真實鐘面96,008ms後同Host與Cookie讀Runtime得到401 `authentication_required`。這證明此情境下Gateway已過期且不能代理，非模型／Catalog UI的過期chip或切Actor回應情境。原先試用隔離tab凍結而timer照樣heartbeat的失敗、以及另一頁無partitioned cookie的失敗均保留於`expired-grant-live/`；正式成功`receipt.json`只留狀態、未記cookie或actor key。
- **跨工作來源封存只到隔離候選**：使用者授權跨工作整合後，另以現工作樹完整541個pi-web檔重建固定上游→候選，patch SHA256`9188816e71a0bbc4afa23477786c1ae0587978dd523c0370f5b75aede5cb1857`，lock SHA256`6d7b4f2dba8cefce790250ce74f03a2930a2af408e008492286d5466defa5fe3`，全量來源穩定、反向506檔byte/mode、原checker、tsc，及Catalog11／Gateway11／shared renderer27／ETL/Semantic/Composer接縫69項共118項Node測試PASS。`.local/evidence/catalog-explorer/formal-all-current/`含分類5個選定外獨立檔和共用檔process-details hunk。**使用者後來決定先待獨立審查**，故正式patch／lock不更新；checker PASS只認這份私有來源快照，不等於所有獨立ETL／Semantic功能通過或上線鏡像source-bound。目前選用team.reviewer設定檢查通過，但實際profile是`openai-codex/gpt-5.6-luna`、當前registry沒有本專案約定的`openrouter/stealth/union-alpha`，故未以不符約定的模型啟動子代理；獨立審查**仍未執行**，不以主代理自看取代。
- **第二Actor已依明確授權用官方UI建立**：只一筆無Role邀請及一筆signup，憑證只存gitignored 0600 `.local/evidence/catalog-explorer/live-e2e-20260923/actor2-provision/credentials.json`；兩身份真登入200且URN不同，B的managePolicies/Identities/Ingestion/Secrets均false。真同browser A→B切換舊卡Host Catalog 401、舊Runtime 401，新Actor隔離Runtime 200，模型0提交；私有`actor-switch-receipt.json`。但兩筆已核Dataset兩人**皆可見**；官方`listPolicies`16筆中啟用的All Users／`VIEW_ENTITY_PAGE` METADATA政策其資產filter無條件，不能靠加專用允許政策做出A可見/B不可見。使用者明確決定**不改全域政策**，資產差異ACL、送出中失效仍未驗，不假報完整CE08。原生無Role邀請token看來沒有TTL／單一撤銷UI，依使用者選擇暫留本機受保護狀態，不用內部表或未知刪除API。非空治理、真循環、完整原生同寬視覺、真FileViewer／可信審核亦未完成。`TODO-cdd3f40a`維持in_progress；不因部分CE05／CE07／CE08真通過而提前結案。

## 後續真實讀取與目前靜態檢查

使用者禁止新增 fixture／mock 後，沒有再靠合成來源補足驗收。以下是既有 checker 的命令格式及當時授權限制；2026-09-24 使用者已追加本機限定重測授權，最新執行與結果以上節為準，未擴大到其他身分或來源：

```bash
node --experimental-strip-types scripts/check-agent-catalog-native.mjs \
  --origin http://localhost:9002 --credentials .local/user.props \
  --query AdventureWorks2019 \
  --output .local/evidence/catalog-explorer/native-readonly/next-native-check
```

### 最新續作：DataHub 管理圖像、instance 與原生深連結

- `overview` 固定 query 現讀公開 `platform.properties.logoUrl`、DataPlatformInstance `instanceId／properties.name`，以及User／Group `editableProperties.pictureLink`。Adapter只把同一 DataHub origin 下 `/assets/`、無query/hash/credentials且為固定圖片副檔名的路徑投影成 `imageUrl`；外部及任意 endpoint 均為null。沒有伺服器抓圖、proxy、DNS判斷、額外service或store。
- `CatalogEntityVisual` 在卡片、Sidecard與表級血緣節點呈現上述DataHub管理圖片；沒有圖片時沿用已核對的entity glyph。圖片是裝飾，名稱仍為可存取文字；lazy／async decode且不傳referrer。Search filter與總覽另顯示原生instance name／instanceId，不以URN或資產名稱猜顯示名。新欄位optional，舊歷史仍可讀。
- 依固定版 `schemaField/utils.ts`、`Preview.tsx`、`LineageBadge.tsx`與Sidebar lineage source，只接已確認的Dataset `/Columns?highlightedPath=…`及支援類型 `/Lineage`。基礎entity URL在contract中需吻合type、URN、http(s)、無credentials/query/hash；未知／不符URL不產生連結。卡片可開根頁，Sidecard依目前schema／lineage狀態開原生定位，不猜其他tab契約。
- 無網路source checker `managed-media-source-20260923/receipt.json`：固定版bootstrap共112筆logo contract全部落在受控assets邊界；從前次真adapter結果動態取得平台URN，核對SQL Server顯示名及固定版 `mssqllogo.png`（SHA256 `191516ecc5eecf79ec96118f5b622f6a7d5d327ecdb512052ce8b4c024a9d1e0`），並以同一真Dataset／第一個真field核對Columns/highlightedPath與Lineage URL。**先前真結果未讀logoUrl，本輪也未發網路請求，因此live logo值、圖片HTTP與browser render仍未驗。**
- 7個更新程式／checker primary LSP clean；scoped ESLint、tsc、Node syntax、PostCSS syntax通過。讀取Core參照時其未安裝前端依賴曾產生鄰檔診斷；Core保持乾淨，最終本案scoped LSP與lens只剩既有Files／Terminal `!important`警告，不安裝依賴或修改Core掩蓋。
- 32檔隔離候選：`catalog-only-integration-native-media-navigation/catalog-on-head.patch` SHA256 `ef8baa614d772769b431e890aeb5aae0e16e63284d10b477c2b64c4e414df4d2`；正向833檔byte/mode、反向HEAD、候選tsc均通過。新media checker納入；獨立process-details／Semantic等工作仍排除且保留。正式downstream lock／patch未更新，非部署或UI驗收。

### 前次：原生身分／平台文字與治理 pills

- 核對固定版 `entityV2/user/User.tsx` 與公開 `entity.graphql`，發現原摘要漏讀 `editableProperties.displayName`／`properties.fullName`。Adapter 現依原生 current-properties 名稱順序呈現，保留 username 作獨立定位；不由 username 拼人名、不讀 deprecated info。新增職稱／個人簡介、群組 editable description 與 Dataset 平台 displayName，保留明確空描述，不擴展成 email／電話／成員清單。
- Cards／Sidecard 以真平台 displayName 和職稱呈現，Dataset 詳情分列顯示名稱、平台 URN、instance URN；User／Group 的描述分別標為個人簡介／群組說明。Optional DTO 欄位讓舊歷史保持可读，不把缺值補成猜測 metadata。
- 治理 chips 參照固定版 `sharedV2/tags/TagPill.tsx` 的26px最小高度、4px gap、8px padding、圓角、200px label上限與中性色。只保留既有已核對 entity glyph，**不模擬原生 hashed color、不猜 logo／照片、不載入外部圖片**。完整文字保留於可存取名稱／title；窄容器44px按鈕規則保留。另補 select、summary、可聚焦區域的 focus-visible outline。這些仍是候選樣式，不是同寬視覺驗收。
- 使用者另外核准一次相同 origin／credential 檔的有界唯讀 checker；`native-readonly/identity-metadata-chips-20260923/receipt.json`：loginStatus200、32項 adapter reads PASS；平台 displayName、目前使用者職稱有非空真值且與直接 GraphQL 讀回一致。真3→1及反向、graph consumer、6項draft helper保持通過。**本次 editable displayName／fullName／aboutMe皆無非空案例，也未找到 CorpGroup anchor，不能稱相關分支／群組已驗。**一次登入授權已耗用，不自動重跑。
- 5個更新程式檔 primary LSP clean；scoped ESLint、tsc、Node語法及 PostCSS syntax通過。沒有執行fixture/mock、build或部署；新資料投影由此次真讀取驗證，不套用舊32項PASS。Glyph／pills、完整原生照片／logo與真UI／Agent／Host／ACL仍分開驗收。
- 更新後的31檔候選保存在 `catalog-only-integration-identity-presentation/`，不覆蓋前次證據。`catalog-on-head.patch` SHA256 `83209736622bbb9e1c7cc3470df5da370f42f3bcaa3ec54f8402603230223f46`；832檔正向／反向 byte/mode讀回及候選tsc通過。排除獨立process-details變更的規則不變；正式downstream lock／patch仍未更新，這不是功能或部署驗收。

### 前次：CE09 Catalog 差異隔離與離線套用核對

- 以 `641eb966bb9e3f52cad76ed22893e49c8cfb3f36` 為基底，在私有暫存目錄組成31個 Catalog production source／checker 檔案的候選差異。`ChatWindow.tsx` 僅排除獨立的 process-details 預設展開修改；實際工作樹完整保留該修改。未納入未提交的 Semantic 後端、AGENTS、E2E／測試及其他文件差異；基底已提交的 ETL／Semantic 程式仍保留，不宣稱本輪重新審查它們。
- `catalog-only-integration/catalog-on-head.patch` SHA256：`d8bdf08cde852807e8bb942bf8bfad59f4c84eceffb818e3d46690626936cd0a`。套用後832個檔案的 bytes／mode 與候選樹一致；反向套用完整還原 HEAD。31檔選定原碼封存亦逐檔讀回。這是**差異隔離／可套用性證據，不是程式正確性審查、正式 downstream patch 或部署驗收**。
- 候選樹使用既有依賴執行 `tsc --noEmit --incremental false` 通過；未安裝套件、啟動服務、執行 build／fixture／mock／live login。實際工作樹 `ChatWindow.tsx`／`useAgentSession.ts` primary LSP 無診斷；套用核對前後31個來源 hash 不變。
- 基底盤點揭露：**HEAD 本身**相對正式 downstream manifest 已有5個 byte 差異及7個未列檔案；最後修改 lock 的 `166fd0f…` 也有5個差異及3個未列檔案。不能將整個正式 gate 缺口歸因於 Catalog，也不能只改新檔 hash 宣稱完成。正式 lock／patch 均未修改。
- 私有證據：`.local/evidence/catalog-explorer/catalog-only-integration/{receipt,baseline-audit}.json`、`catalog-on-head.patch`、`catalog-on-head-selected.tar.gz`。未提交／上傳；不覆蓋現有 checkout。CE09、B1／B2仍未完成，真 UI／Host／模型／ACL 與完整下游整合要求不變。

### 前次：血緣 consumer 真讀取恢復；Sidecard 導覽仍待 browser

- 使用者明確核准同一檔案／同一origin一次限定登入重試，未換身分或重啟服務；`native-readonly/lineage-consumer-authorized-retry/receipt.json` 記錄 loginStatus=200、**32項真adapter reads PASS**。原 `Native login failed` 保留，原因未證明；不得把成功重試說成根因修復。其前僅做無登入 GET `/login`：200／DataHub title，不是認證成功證據。
- 新 `lineage-consumer.json` 證明同資料庫一個真鄰居的有界展開、產品圖函式的方向／逐段真邊／去重。4個中心與方向組合共有23次路徑核對（包含中心自身）；可達節點數為1／11／10／1。**沒有多跳或循環正例**，不補造；不是browser、模型或整條路徑信任驗收。原真3→1欄位群組、反向讀回與6項draft helper仍通過。
- Sidecard補上tab／tabpanel ARIA關聯與精確欄位breadcrumb；尚未得到entity類型時不展示額外schema／lineage入口，只保留目前已選落點，避免尚未知支援性便切入錯誤section。CSS以scope specificity取代三項字體／顏色!important；保留Files/Terminal inline display所需覆寫。以上均為候選UI，尚未真browser驗。
- 欄位群組中目前欄位增加文字標記與aria-current，不只靠顏色；可存取名稱含完整資產定位，記錄來源可在同一Sidecard深入、重新經Host讀取，不自動送模型。未藉此宣稱browser驗收。
- 最後5檔primary LSP、scoped ESLint、tsc、PostCSS syntax、diff check通過；lens all為38個本次檔案快取、無issues，不是全專案／CSS primary／browser通過。未新增登入重試，Core clean。
- CE09唯讀盤點 `downstream-audit.json`：原upstream lock與patch digest仍相符；現有13個檔案byte/mode差異、19個未列檔案，含其他ETL／Semantic／process-details工作；無missing/symlink。**未更新正式lock／patch、未把共用檔案全歸Catalog，這不是downstream gate通過。**

### 前段實作與保留的登入失敗

- 將既有圖形去重、可達性、方向路徑與循環判斷抽成 `lib/catalog-lineage.ts`，UI直接使用同一份純函式；沒有新增圖服務／狀態庫／推論邊。讀取資料未改。viewport捲動位置沿既有 `lineageView` 保存，返回／圖表切換可恢復；「設為中心」保留圖表模式。加入既有原生type glyph、邊選取aria狀態。
- 針對原有 callback 可向任意最新 View append 的程式路徑，補上 request identity 比對；refresh 改用新 request 物件，移除獨立 refresh counter，render即隔離舊結果／舊展開回呼。保留主內容捲動位置；**競態與返回仍待真browser重現／驗證，不宣稱已證明恢復**。
- Loading 參照固定版 `EntityHeaderLoadingSection.tsx` 的avatar＋兩列標題骨架；裝飾區aria-hidden，只有一個文字status，使用靜態樣式尊重reduced-motion，沒有假名稱或計數。
- 原真讀取checker新增同資料庫一個真鄰居的雙向有界展開，以及真結果→產品圖函式的方向／逐段真邊／重複頁驗證；尚未執行到此段。**`native-readonly/lineage-consumer-and-navigation/receipt.json` 回報 `Native login failed`、completed=false、checks=[]；Node exit 1，context在finally dispose。0次Catalog讀取，沒有重試、換憑證或改走其他讀取路徑。原失敗receipt未保存HTTP status，無法判定原因；僅為未來診斷增加非敏感loginStatus，未重跑。**
- 當時最後成功的30項adapter與6個draft helper是上一輪scope，不能用來取代新增圖consumer／UI行為（後續限定重試的32項見上節）。後端與contract自上一checkpoint的差異已逐項核對，僅格式化；未以舊資料重播冒充新驗證。
- 本輪4檔primary LSP clean，scoped ESLint（含修正view.scroll依賴）、tsc、Node語法／圖模組載入、PostCSS syntax、diff check通過；模組載入不是圖行為驗證，CSS primary仍不宣稱通過。Core clean。無部署／policy activation／模型／SQL／ingestion／metadata寫入。需先確認本機登入狀態，再依原限定流程續驗；不自動重啟服務、重設密碼或擴大身分。

### 前一輪：compact schema／entity 治理讀取範圍

- 最新 `native-readonly/compact-schema-governance-scope/receipt.json`：**30項真 adapter reads PASS**，另6項 draft helper；13欄、真3→1群組及反向讀回保持通過。新增 Dataset 與目前登入 actor 定義的 `referenceKinds`，逐項對照真 GraphQL 回傳欄位；不是額外身份／ACL負例。10個欄位 metadata 投影有核對，非空欄位治理仍0，不能宣稱治理 chips 正例通過。
- 修正原因：舊 entity query 只在 Dataset 讀治理，UI卻對其他類型畫出全套空 sections。現在以固定版公開 `entity.graphql` 的各類型實際欄位產生固定 selection；沿用既有逐 reference 查權與有界讀取，回傳本次 `referenceKinds`，About只呈現已查詢的治理 section。舊歷史沒有範圍資訊時明示需重查，不推定沒資料。這是既有 Adapter／DTO 的補齊，不是新增服務或業務 registry。
- Sidecard 改成 `CompactSchemaTable.tsx` 的「欄位＋截短描述」結構、透明表頭與100px欄位／描述樣式；完整文字及治理留在精確欄位詳情，橫向捲動區可用鍵盤聚焦。聊天欄位卡則分列標籤與詞彙並顯示來源。此為原生源碼參照，**仍不是同寬視覺或互動驗收**。
- 最新7檔 primary LSP：6檔clean、1檔逾時未確認；CSS primary未視為通過。tsc、PostCSS parse、diff check通過。未啟服務、未部署／policy activation／模型呼叫／metadata或來源寫入。

### 前一輪：原生 glyph／欄位 metadata

- 該輪真讀取：`native-readonly/field-metadata-native-icons/receipt.json`，29個 adapter reads、6個 draft helper checks 繼續通過；真3→1欄位群組及下游讀回仍通過。新增10個真欄位的 label／JSON Path／partition key／recursive／描述來源投影比對，並直接核對原生 field entity／parent；不是來源 SQL 查驗。
- 欄位治理讀取 SchemaMetadata、精確 path 的 EditableSchemaMetadata，以及授權後查詢的 SchemaFieldEntity。Tag／Term 逐一查權，同 URN 合併来源、不丟來源標示；超過本次20項上限明示部分。所選真欄位返回治理項目0，**不能當三類來源非空 chips 或 ACL 拒絕已驗**。不猜 v1/v2 path 等價、不添加 Business Attribute 繼承。
- 描述保留來源 schema 與 editable 值，空字串不冒充缺值；不以未讀的 Documentation aspect／推斷描述補資料。欄位詳情加入上述原生 flags、治理分區、來源展開；長文字保留換行，卡片摘要明示截短，欄位列表可調小頁面。不直接呈現 jsonProps／原始 Aspect。
- Modal Tab 控制排除隱藏與 tabindex=-1 控制，納入原生 summary；避免把焦點送到收合內容或非作用中的頁籤。**此為源碼修正，尚未真瀏覽器驗證。**
- 可重跑靜態資產核對：`node --experimental-strip-types scripts/check-agent-catalog-icons.mjs --archive .local/evidence/catalog-explorer/native-icons/phosphor-react-2.1.7.tgz`。原套件只下載作版本比對、未安裝。`native-icons/receipt.json` 證明17個 glyph 與原 license 一致，不是 fixture／browser／版面驗收。
- 該輪8個更新程式檔 primary LSP 無診斷（7檔＋最後3檔，其中2檔重複）；tsc、Node真 API checker、icon source checker、PostCSS syntax parse、diff check 通過。CSS primary LSP 不宣稱已恢復；lens all 34檔無error、仍有保留 Files/Terminal inline display 的既有!important警告。Core未改，未啟 dev、未 next build、未部署、未模型／來源寫入。

### 先前：Browse／治理／真多輸入群組

- 該輪 receipt：`native-readonly/final-locators-and-groups/receipt.json`，**29 項真 adapter 讀取 PASS**；同目錄另有6項 draft helper checks，不是瀏覽器或 RPC recovery 驗收。
- 真 Database prefix 搜尋返回91、Schema prefix返回15個索引匹配項；逐筆核對本頁可見資產的返回路徑，並讀取 Container 詳情。索引總數不等於已授權可見總數，product pagination 不揭露未過 ACL 的總數。
- 舊 `container` filter 只含直接容器（Database查到0），不能拿來當階層範圍。U+001F probe 空結果及修正為原生 U+241F 後結果均保留於 `governance-associations/`，未以 fallback 搜尋掩蓋。
- 在相同真 Browse／query 範圍的5頁中，觀察到91個不同 Dataset、20筆返回細粒度映射；找到真實3輸入→1輸出群組。可重跑腳本從真搜尋結果找案例，不 hardcode 資產或建立資料；`mapping-upstream.json` 與 `mapping-downstream-0.json` 核對同一完整群組的上游及下游讀回。這證明本案例的 adapter／contract，**不是新群組 UI、全部來源覆蓋率或 SQL 語意驗證**。
- 治理關聯的成功傳輸與原生搜尋一致性目前只覆蓋空結果。再以5頁核對相同91個可見 Dataset 的 Owner／Domain／Tag／Term、來源欄位與 editable 欄位 tags/terms，未找到 anchor；證據 `final-browse-governance-field-groups/governance-scope-scan.json`。不是一致性快照，也不是全站無治理資料；沒有捏造資料來補 C04 正例。
- 10個更新程式檔的 primary LSP 已確認無診斷；CSS primary LSP 逾時，**不算 clean**。相同 CSS 的 PostCSS syntax parse 通過，但不是視覺／瀏覽器驗證。移除 `DataHubCatalog.tsx` 的冗餘 client entry 宣告，其唯一產品 consumers `AppShell`／`MessageView` 仍為 client boundaries，不將 callback 偽裝為 Server Action。
- 最後 `tsc --noEmit --incremental false`、真 Node 腳本、`git diff --check` 通過；Core clean。最後4個變更程式檔再查 primary LSP 無診斷。`lens_diagnostics(mode="all")` 覆蓋26個本次 dispatched 檔、無 error，保留一項既有 `!important` 警告：只用於覆蓋 Files／Terminal 控制的 inline display、保留其掛載狀態，不能單靠 selector specificity 取代。這不消除上述 CSS primary LSP 逾時，也不是完整安全掃描。未 `next build`、啟動服務或部署，未模型／來源 SQL／ingestion／metadata 寫入。

### 先前：13項 adapter 與引用還原

- 先前 receipt：`native-readonly/draft-recovery/receipt.json`。該輪 adapter／renderer contract bytes：**13 項真實讀取 PASS**；涵蓋 search、平台／環境 filters、entity、精確欄位、整份 schema 搜尋／型別排序、schema 下一頁、表／欄位雙方向 lineage 及下游下一頁。實際 Person 資產有 13 個欄位。
- instance filter 沒有實際值可測；真欄位上下游與表級上游均返回 0 條可見邊，**不能當多輸入／非空欄位映射成功證據**。真表級下游有兩頁可見結果。
- 首次真 entity 查詢揭露 `OwnerType` 是 union，不能直接選 `urn/type`。已修為 `CorpUser`／`CorpGroup` inline fragments，保留初次失敗與修正後結果；沒有放寬 ACL 或改走 fallback。
- 真原生 Person UI 可開啟，1440×1000 截圖與只讀瀏覽器 receipt 保存在 `adapter-after-owner-fix/`。瀏覽器阻擋 4 次 tracking POST。這是原生頁參照，**不是新 Catalog UI 截圖或同寬一致性驗收**。
- 先前以新鮮 native entity 的真實引用完成 5 項 draft helper 檢查（`filters-and-fields/draft-reference-live-input.json`）。追查送出拒絕路徑後，補上 `ChatInput → useAgentSession → restoreSubmission` 的本地草稿 context：送出清空後仍能還原原文與 chips，而不是不可移除的舊 metadata 文字；未知傳輸結果維持原本不重播規則。新的同一真讀取腳本可重跑 **6 項** helper 檢查，增加 post-clear chip-only 還原與引用合併去重，見 `draft-recovery/draft-reference-consumer.json`。這些不是 Composer browser／RPC failure／model 測試。
- 不帶 cookie 的真 native entity 查詢得到 HTTP 401；receipt：`filters-and-fields/anonymous-native-read.json`。不把匿名拒絕解釋成跨 actor／expired grant 已驗。
- 9 檔 scoped primary LSP 0 errors，最後引用還原與 graph／腳本再查 5 檔亦 0 errors；`tsc --noEmit --incremental false`、`git diff --check` PASS，Core clean。CLI 執行仍有 Node module-type warning；不為消除 warning 改整個專案 module 模式。
- 最後 `lens_diagnostics(mode="all")` 無 blocking error；CLI 的 inferred LSP 曾在 212 行檔案回報第 213 行語法 warning；當時實際 Node `--check` 與真執行均通過，記為 stale 診斷。加入可重跑引用還原檢查後，scoped primary LSP 與真執行再通過，不改正確程式迎合舊快取。Opengrep silent 仍不代表完整安全掃描。
- 私有產物位於 `.local/evidence/catalog-explorer/native-readonly/`，不提交／上傳。原 57/57 與合成瀏覽器結果僅為下節歷史，不代表新增契約／UI 通過。

## 歷史：第一段合成檢查（不是目前驗收或本次執行建議）

以下記錄先前執行的命令與範圍。使用者後續已禁止 fixture／mock；**本次未重跑或新增這類測試，不將舊 PASS 套用新程式**：

```bash
node --experimental-strip-types --test tests/test_agent_catalog.mjs tests/test_agent_gateway.mjs tests/test_agent_server.mjs
node --experimental-strip-types --test extensions/datahub-agent/mfe/mount.test.mjs
cd extensions/datahub-agent/pi-web
node --experimental-strip-types --test components/DataHubHostBridge.test.mjs components/MessageView.test.mjs
node_modules/.bin/tsc --noEmit --incremental false
cd ../../..
node --experimental-strip-types tests/check_agent_catalog_browser.mjs
```

- Adapter fixture：actor 不匹配、拒絕直接定位、鄰居 ACL、欄位 parent 拒絕、分頁、治理 references、properties allowlist、mutation／任意 query 拒絕、非完整回應與安全錯誤。
- Gateway 真 HTTP／合成身分：parent origin／proof、不同 actor、runtime-origin bypass、revoked grant。
- 原 `MessageView` SSR 接縫：Catalog pending／error／未知歷史 payload 不暴露 raw input／result；SSR 只替換 stylesheet loader，瀏覽器檢查載入真正 module CSS 及既有 globals／theme CSS。
- 合成瀏覽器：390／768／1280／1440，另加 1440 viewport 內 390px iframe；真 component → MessageChannel → MFE bridge → fixture adapter。覆蓋開卡、schema 子頁、屬性、lineage、返回、Escape、modal 背景 inert、無 message 位移／頁面 overflow、HTML 轉義、歷史卡重新開啟拒絕。
- 私有合成產物：`.local/evidence/catalog-explorer/local/`。不提交／上傳；不是 DataHub 原生或真模型 E2E。
- 不執行 `next build`，符合 pi-web 開發規範。未生成部署映像／切換資產。

### 第一段歷史結果與自查

- 上述 Node checks 合計 **57/57 PASS**（41 adapter／Gateway／Host／MFE／server checks＋16 MessageView checks）；TypeScript `--noEmit --incremental false` PASS。
- 五種 viewport／container 組合的 browser check PASS；截圖人工檢視曾發現 named container 被 CSS modules 改名而未套用，已改用工作區 unnamed container query，追加小容器 full-width 斷言後重跑 PASS。
- Scoped primary LSP 12 檔 0 errors；最後修改的 AppShell／Catalog／browser check 另查 3 檔 0 errors。`git diff --check` PASS，Core clean。
- `lens_diagnostics(mode="all")` 無阻擋錯誤；`no-important` 保留一處（覆蓋既有 Files inline display 以保留掛載狀態），Host bridge 的既有 Next 71007 callback 警告保留。測試曾出現超過 EOF 的 stale 診斷，已用目前 bytes 的 scoped LSP 與 Node 實跑確認無語法錯誤。Opengrep silent coverage 不視為安全全掃通過。
- 本輪是主代理自查，不宣稱獨立審查或真入口驗收。測試首先揭露 fixture 少了 GraphQL `data` envelope、SSR loader 不支援新 CSS module，皆在原本測試流程修正；沒有用放寬 adapter／ACL 消除錯誤。

## 尚未完成：不能勾選 B1／B2

1. 本機目前Actor及新建NoRole測試Actor均有真登入；**同瀏覽器切換A→B**已觀察舊Host Catalog401／舊Runtime401、新Runtime200，另有同Actor斷線後真Grant過期401。但兩Actor所核Dataset皆可見，因既有All Users無資產篩選的可見政策；不等於資產差異授權或送出中失效負例，亦非正式環境Gateway／policy驗收。
2. C01 DB／schema prefix及instance有真adapter／目前ActorUI正例，但完整原生同寬／各entity樣本仍未驗；C03欄位來源／治理非空與長文呈現尚待真UI，Documentation／繼承語意未涵蓋；C04非空治理定義／關聯資產與權限負例仍缺真例。
3. K01–K08 有候選呈現區塊，尚未逐類完成真入口／瀏覽器驗收；不把區塊、按鈕或 tab 當完整交付。
4. B2圖、真3→1原生欄位群組已有目前Actor的1440／390圖／表正例；AdventureWorks下游影響5條真邊等價圖／表、一跳／設中心返回，以及Salesdatamart三資產精確兩跳（逐層讀回＋16筆圖表等量）均真驗。真循環、反向多跳及多輸入互動完整案例仍缺，不由部分正例外推。transform SQL未讀，不聲稱已呈現或驗證公式。
5. 原生同寬樣式比對、全部 entity 原生 sections、avatar及非空治理的真HTTP／browser正例、Composer「送出後拒絕／取消／身分切換」負例、最上層可信 review dialog／FileViewer完整協調、完整鍵盤仍未驗。真引用chip新增／移除及**一次授權送出**已有不同輪次證據，不把正例擴成錯誤負例。真Browser 200%已有目前Actor單獨正例，Files空面板／Terminal無輸入切換亦有上述限定證據；不擴大成全部操作或組合情境。MSSQL平台logo的真HTTP／browser、未提交引用chip、完成session歷史／reload有上述有界證據；不可擴大成全部案例。外部metadata圖片依安全契約不載入。
6. 已隔離Catalog-on-HEAD，且以私有候選patch／lock在隔離來源上通過原downstream checker與正反byte/mode，但正式 `pi-web-downstream.patch`／lock **未更新**、現工作樹checker仍13檔byte偏離／19路徑未列。HEAD本有5差異／7未列路徑及其他未提交獨立工作仍需分別整合／審查，不以私有候選或整包改hash洗白。
7. 真`/mfe/agent`目前Actor的模型→Host→卡片→詳情、Composer一次真引用送出、同Actor離線Grant到期401及**兩Actor切換隔離401**已有有界證據。跨Actor**不同資產可見性**、送出中身分切換與拒絕仍缺可安全取得的差異ACL，使用者不授權動既有全域政策；當前Agent-only候選也不是正式切換或完整CE08。

下一步須處理標準Dockerfile乾淨建置／正式downstream獨立審查與差異整合，取得不影響全域使用者的資產差異ACL場景、非空治理及真循環案例，完成同寬視覺、原生sections、FileViewer／可信review及其他panel協調；不得自行啟用更多policy、擴大來源或補造metadata。第一頁沒有資料不能推論整個來源沒有；`schemaField`圖與Dataset已記錄的欄位群組不是同一讀取語意。公開schema、真resolver／adapter、UI／Host／模型證據必須分開。

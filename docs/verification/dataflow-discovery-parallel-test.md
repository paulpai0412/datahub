# Discovery 獨立 Agent 測試環境

狀態：**精確版本已獲批准並僅在 9141 啟用；OpenAPI 真模型使用／隔離執行／冷重啟及 legacy 等值回歸已通過。2026-09-27 再完成 ETL／Summary 真模型＋fresh Catalog 分析、45 欄 UI 核對與對話重載；七個 BI panel 因當次 Catalog 投影差異尚未完成原生綁定。沒有原生發布。** 詳見 [ETL 真實分析驗收](dataflow-discovery-etl-live.md)。
現場證據時間：2026-09-26～27 UTC；主代理實作，依使用者要求不使用子代理／獨立審查。

## 授權與隔離

使用者確認另一個 session 正在測試 DataHub，改採：Agent 完整隔離、DataHub Core 唯讀共用。這取代本輪原先更新共用 9041 Agent 的安排；不代表核准候選插件啟用或 metadata 發布。

| 項目 | 本輪設定 |
| --- | --- |
| Gateway | `http://localhost:9141`，僅 loopback |
| scope | `ekop-discovery-test` |
| tenant namespace | `ekop-datahub-discovery-test`，身分仍由真 DataHub `me` 驗證 |
| runtime image | `sha256:d6511a576cf622ea173f134a2ac6821ae9417bb918a1ee5007f52a46ab227bec` |
| Actor 子域 | `f0b0ef7836af29dd2dc645457d3cbd3e4c6c1f289d90b113.localhost:9141` |
| HOME | 新建 `dha-ekop-discovery-test-f0b0ef7836af29dd2dc645457d3cbd3e4c6c1f289d90b113` volume |
| Core | 共用 `http://localhost:9002`，本輪唯讀 |
| 模型 | 使用者已於獨立 HOME 登入；實際使用 `openai-codex/gpt-5.6-sol`，medium，無 provider fallback |

不同 port 本身不隔離 Cookie；本輪另外使用不同 tenant 導出的 Actor 子域、scope、HOME、session、operator config 和驗證目錄。未複製舊 HOME、模型憑證或設定，也未停止／修改另一輪的 Gateway、runtime 或 DataHub Core。

原共用環境曾在準備期間從 `46423d4c…` 更新為 `f1e06bfa…`，舊部署前置檢查因此停止。其 private release／部分 rollback copy 不是可直接套用的現場回復版。本輪映像現在僅用於獨立測試，不覆蓋該環境。

## 入口及唯讀範圍

專用瀏覽器沿正常 DataHub 登入，在取得 **真實且已認證的** `/mfe/config` YAML 後，只於該瀏覽器把既有 Agent remote entry 改指向 9141，並標示 `Discovery test — 9141`。沒有修改伺服器設定、重啟 frontend、替換身分回應或繞過登入。

這是測試用 MFE 導向，**不是正式 DataHub 選單／MFE 設定部署驗收**。一般瀏覽器的 `/mfe/agent` 仍指向另一輪環境。專用瀏覽器重用本輪先前手動登入的 Chromium profile，由 Chromium 正常使用登入狀態；未讀取／匯出 cookies、auth storage、密碼或登入畫面。

新增 operator `readOnlyCore: true`：

- 關閉 ingestion、semantic/task 寫入入口；未配置 SQL、SQL result、Grafana。
- 同時拒絕寫入／SQL／Grafana 憑證與政策設定，防止誤配置。
- 保留真身分驗證、唯讀 Catalog、唯讀 Discovery 及無憑證隔離插件驗證。
- 此選項預設不啟用；未改一般部署的既有行為。
- Runtime egress 僅核准既有 OpenAI 認證／模型站點，未開啟 DataHub MCP 或來源 DB 通道。
- 瀏覽器另保守阻擋 Core mutation／tracking 寫入；原生 GraphQL read query 的 URL `operationName` 必須與 body 一致。此測試助手不是 Host 授權邊界。

## 已驗證

- 映像／exported browser assets／operator scripts／package lock：現有 artifact checker **223 個資產逐一一致**。
- feature server tests：**6 PASS**；整合 release server／Gateway／transport／query regression：**22 PASS**。
- 真 9141 HTTP：六個未配置的寫入相關入口各回 403；另三個 query/Grafana 設定衝突在 Docker 前被拒絕。
- 真 DataHub → 專用 MFE → 9141 bootstrap → Actor exchange → Pi 首頁均回 200。
- 新 runtime 使用上述 image、UID1000、network-none、read-only root/IPC、cap-drop ALL、no-new-privileges、1CPU、1GiB RAM/no extra swap、PID128，HOME volume scope/owner 核對通過。
- 初次登入前模型列表 200／模型數 0 的證據保留。使用者回覆「已登入」後，模型 API 確认原模型可用、無 runtime error；沒有複製其他 HOME 或代登入。
- 新／修改檔案 primary LSP clean。最後 lens 仍列 19 個既有 `rpc-manager.ts` structural assertion findings；當前 feature 檔案 SHA 與先前 AST 對帳收據一致，fresh primary TypeScript clean。未抑制規則，亦未宣稱整個 repository 無診斷。

## 保留的準備失敗與限制

- image build r1：Webpack 將 skill 目錄 `new URL()` 當模組解析；改用 Node filesystem path 後 r2 build 通過，原失敗保留。
- 共用 feature test 曾把僅整合版支援的 Grafana service-key 欄位當成既有欄位；修正測試範圍後 6 PASS，整合版另測三個獨有欄位。
- browser r1 誤將真 YAML config 按 JSON 解析，助手退出；已確認沒有啟動 runtime/model。
- r2 過嚴的 URL 檢查擋住原生唯讀 GraphQL `operationName`；修改後 query 200，仍阻擋 mutation／tracking。
- r3 啟動前錯誤假設沒有 runtime；shell 後續命令仍啟動助手，Chromium 因 profile 已被 r2 持有而拒絕。已確認 r3 退出、r2 runtime 已知且保留，正常關閉本輪 r2 助手後以相同 protocol 啟動 r4；未停止 Gateway／runtime 或刪 HOME。
- CDP reconnect 的既有跨站 iframe `Frame.url()` 可能為空；已用原生 target 與 frame execution context 核對真正 origin，不把它誤報成 iframe 消失。新 HOME 尚未選 workspace 時的模型列表 403、隱藏 Models 按鈕點擊 timeout 也保留，不宣稱模型服務失效。

Private checkpoint：worktree `.local/discovery-plugin-contract/parallel-test-r1/checkpoint.json`，含來源／證據 hash、PID、runtime、HOME、現況與下一步。先前 `release-r1/` 收據保留歷史範圍。

## 真模型撰寫與 Host 收據（2026-09-27 UTC）

先修復一個實際接線缺口：skill 要求閱讀 `asset-plugin`／`language-plugin`，但 Host 只列官方 YAML。新增固定、啟動時雜湊綁定的文件 references，仍不接受任意路徑；文件不能充當 `verify` 的執行來源。舊 Host 在新回歸斷言失敗，修正後六組實際 Host 檢查通過。只重新啟動獨立 9141 Gateway，保留同一 HOME／登入與 runtime image；未更新 9041 或 Core。這是 Host 文件接線，不是由操作者預寫候選答案。

實際入口為 DataHub 專用 MFE 內的正常新對話（`/?cwd=/home/node`），選擇 `plugin-dev`。送出前核對真 SDK：只有 `discovery_plugin_dev` 一個 active tool、只有專用 skill，模型／provider 正確；沒有 shell／project resources。操作者只給需求，不提供插件實作。

- Native session：`01a0e03d-9b9c-7103-9c23-cf36fb8a92bc`。
- 一次使用者提示，模型自行讀取契約、官方原始 YAML、兩份文件並建立兩個不可覆寫候選。
- 兩次參數錯誤 `reference_id_required`、`development_parameters_invalid` 由模型修正；不是 runtime failure，原事件保留。
- `0.1.0`：candidate `b93a69be-2b53-40a1-b489-387d78d5d6e7`，Host `FAIL`／`plugin_config_schema_reference_rejected`；僅到 trusted prepare，沒有匯入候選。
- `0.1.1`：candidate `9bfe9dc8-5694-4c0f-bb9c-f1c5bbe77273`，digest `6bf8ab29051fbd4cb8e2bf0b311aefdc63fc20bcf33038aec495e0fc665b14b9`。
- 最終 verification：`97464d96-9d66-49c8-b06b-7f3cdb1f6c67`，Host **PASS**；suite `openapi-scalar-yaml/1`，suite digest `6a163be03dff235d124b3cc53cefc83684489f71de1eafd327b88501900018c9`。
- 三案例分別為官方 POST／string、隨機路徑 PUT／integer→boolean、無法解析的外部 ref。後者須有 finding／不完整 coverage，不能猜欄位。
- 三個成功案例皆經 prepare → candidate → external validate；加上首版拒絕，共 **10 個隔離容器**。已核對 raw inspection、stage／stdout／stderr hashes、候選來源與模型 save 參數一致、exit／PID0／移除；沒有殘留本輪容器。
- Native history 已落盤、21 messages／11 tool calls；一般瀏覽器 conversation reload 顯示最終回覆，保留專用 tools。這**不是 activated-plugin reload 驗收**。Native `get_state.messageCount` 是既有固定 0，不以它判定是否曾執行模型；使用真 history 與 streaming／prompt flags。
- 無 runtime retry／Host BLOCKED；最終模型停止、未 streaming／prompt-running。SDK 報告累计 tokens 125,877（含 cacheRead），不是新增或重設的預算。

另保留測試助手的前置失敗：重新綁 port 的 Python probe 遇到 TIME_WAIT（沒有新 Gateway 啟動，依真 listener／process 核對後修正）；空 `ensure_session` 被放置逾 15 分鐘後閒置回收；未保存草稿的 `?session=` 深連結沒有 textarea。前兩次 model-authoring preparation 都沒有送出提示，改用原生 workspace 新對話流程後才送出唯一一次提示；沒有調整產品 idle policy 或偽造回覆。

Private 證據：`parallel-test-r1/model-authoring-r3/` 的 `native-admission.json`、`observed-events.json`、`native-history.json`、`history-readback.json`、`host-readback.json`；可信 Host 收據及每案例原始執行資料位於 `parallel-test-r1/verifications/`。目前 Gateway PID／runtime 由最新 checkpoint 讀回，不沿用初始 PID。

## 精確批准、啟用與冷重啟（2026-09-27 UTC）

使用者已選擇「批准此精確版本（建議）」，只准上述 candidate／digest 在獨立 9141 啟用與驗證，不准 metadata 發布、9041／Core 修改或額外來源。批准時的 `activation-r1/authority.json` 保留原樣；其中 `candidateActivated:false` 是批准當時的狀態，不是現在的啟用狀態。

新增 `integration/plugin-activation.mjs`，由 server 的可選 `pluginActivationsByActor` 接到既有 `nativeDiscovery`：

- 使用既有 operator config 作啟用權威，沒有模型／瀏覽器 activate action、第二個 approval datastore 或新 controller。
- 每項綁定 `pluginId`、`candidateId`、`candidateDigest`、authoring `sessionId`、`verificationId`／檔案 SHA、`sourceId`、selection、config。該 actor 必須已有核准的 development 與來源政策；不能取代 builtin plugins。
- 載入前核對可信 PASS receipt、actor、三項語意案例、image、目前 suite/framework、原 stage／candidate bytes 及先前容器清理證據。
- 分析前後重新擷取核准 snapshot；有 caller snapshot 也須相符。每次新結果必須等於核准官方案例的 result digest。漂移拒絕，不回退 legacy。
- 一般 `list_plugins` 列出版本／啟用綁定，`analyze_workspace` 仍用三階段無憑證隔離 runner；候選從未 import 到 Host／Pi。停用時不再可用，但歷史證據不刪除。

檢查範圍：

| 證據 | 結果與限制 |
| --- | --- |
| 最終 private release 回歸 | 30/30 PASS；含 admission、actor/source/config/receipt 漂移等。合成 unit receipts 不是 live 證據 |
| `host-r2/report.json` | 真批准候選／官方來源經 normal nativeDiscovery 和 sandbox；含 reload／disable／no-fallback。Host context 為測試 context，不代替 browser E2E |
| `model-discovery-r1/` | 真 MFE 正常 read-only 對話、同一 `gpt-5.6-sol`，session `01a0e1a7-5f85-715b-8a99-7ca4d172cc28`，一個 prompt，三次 `datahub_etl`：list_plugins、list_workspaces、analyze_workspace |
| 真 MessageView | 真 Host result 渲染 1 API asset／2 scalar string ports／0 edges，證據展開及正常 conversation reload 通過；不是注入 fixture |
| `cold-reload/` | 成功使用後停止且讀回本 scope Gateway/runtime，保留 HOME／config，再冷啟動；操作者經真 iframe MessageChannel／MFE／Host 取得新隔離 execution，同版本／digest。不是第二次模型提示 |
| `legacy-r1/` | 固定無憑證 image 中，當前 Node Host→Python 與原 ETL／Summary **整份 preview deep-equal**，預設與明選 legacy 皆同，10 組 PASS；Catalog 是歷史觀測，不是 fresh legacy E2E |

正常模型 execution `59f02de3-8764-4f34-8ce5-87ac333a3342`；冷重啟後 execution `8bf5732c-9a3d-4bf9-bdd0-31ece67b1494`。兩次共 6 個候選流程容器，raw profile、stage、model-authored source、stdout/stderr、exit／PID0／移除均重新核對，無本 scope 候選容器殘留。結果 digest 皆為 `5e930083a1cf536339246546a25705d505016fd91274f9b4eafd31150a9eaa10`。官方規格捕捉範圍內 coverageComplete=true，但整體 preview complete=false、runtimeVerified=false、publicationAuthorized=false。

真模型 native history 有 10 messages／4 tool calls，SDK 報告 46,010 tokens（含 cacheRead）。測試提示雖寫「只用 datahub_etl、不讀本機檔」，模型先依既有 skill 流程讀一次 `/app/skills/datahub-etl/SKILL.md`；普通 read-only preset 本來允許此工具。其餘三次皆為 datahub_etl，沒有 source／auth file、shell 或寫入呼叫；不宣稱 exclusive tool enforcement。

保留失敗：caller snapshot 的 RED regression；冷重啟助手誤把 `/api/models` 的 names dictionary 當 array，於任何 Discovery intent 前失敗，僅依真 API 的 `modelList` 修正助手，沒有重啟或重播分析；產品 API 不改。Host／runtime 未發生未知效果重試。

## Fresh Catalog 與原生相容性缺口

在同一已認證瀏覽器，以目前 Core 公開 GraphQL 唯讀查詢核對：

- 真 `me` 仍為 DataHub actor；`EntityType` enum **沒有 API**，`__type(name:"Api")` 為 null，Dataset 型別存在。官方 clean submodule `e99431ec510d7a2001f815c6bf70913c493af76e` 的 entity-registry 則已有 `apiProperties`／`apiSignature`／`restApiProperties`。**datamodel 存在不等於此版本 GraphQL／原生 UI 可用**；當時 REST 尚未驗。後續已實測官方 REST 契約／registry／唯讀路徑，仍未驗 stored entity 或發布，見 [REST 相容性實測](dataflow-discovery-api-rest.md)。
- 經真 MFE／Host `nativeCatalog` 查詢 `"datahub_usage_events"` 成功，fresh `queriedAt` 為 `2026-09-27T07:25:22.375Z`，visible page 為空。這不是全域不存在證明，更不是已發布 API 的 readback。
- 最初未加引號的 full-text query 命中不同 MSSQL dataset，不能當 API 命中。首次四個 `__type` 同查被 `BadFaithIntrospection` request validation 拒絕（data=null）；保留原件後改成每次一個 bounded type query，沒有停用限制。
- 官方 `openapi.py` connector 使用 Dataset + `API_ENDPOINT`，但 `init_dataset` 以 path 而非 method 定義 identity，`extract_schema_from_all_methods` 取第一個 response 或 request schema，不能直接宣稱保留本插件兩個方向 ports。未執行 connector 或業務 API，也未自行以此映射发布。

## 下一步與未完成範圍

本次精確版本／獨立啟用範圍已驗；完整 TODO 仍 open。後續唯讀實測已確認官方 `api` REST 契約、live registry 與 GET／HEAD 路徑，建議優先沿官方 api／Aspect 而非轉為 Dataset；詳見 [REST 相容性實測](dataflow-discovery-api-rest.md)。後續[離線映射與差異草稿](dataflow-discovery-api-mapping.md)已完成34項隔離回歸、真既有結果資料重播及精確URN唯讀不存在觀測，四項aspect仍是未批准的CONDITIONAL_NEW。**依使用者最新優先序，OpenAPI 並發／ACL／write 與發布支線延後，不是 ETL 分析驗收前置。** 不因 GraphQL 缺口改 Core 或把 ports 偽裝成 lineage。

使用者之後另行批准既有 ETL workspace 與對應 Catalog 的 9141 唯讀 allowlist，現已套用；不是由官方 YAML 授權推定擴張。真 ETL／Summary 分析、完整欄位／Jobs／語意／UI 與重載均已完成；七個 BI panel 的當次原生 schema 投影不一致仍未解。下一步如需完整原生 BI 綁定，应核對這七項差異，不重播已成功的分析或改寫 metadata 來製造 PASS。

`openapi-scalar-yaml 0.1.1` 僅支援宣告的 OpenAPI 3.0.x YAML scalar 範圍。自帶 `tests.py` 未執行；獨立審查 waived，非 PASS。未寫入 metadata；deployed API、原生 mapping／lineage／ACL/readback 與正式共享 MFE 入口仍未驗收。任何發布仍需另行批准精確差異。

ETL 最新 private checkpoint 與 raw evidence 位於 `parallel-test-r1/etl-live-r1/`；OpenAPI 啟用證據仍在 `parallel-test-r1/activation-r1/`。現況由 `parallel-test-r1/checkpoint.json` 指向，舊階段 checkpoint 留存。

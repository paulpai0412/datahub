# T06 Registry／Task／Decision／排程（進行中）

主代理獨作／安全自查，非獨審。T05 已依使用者選擇，以既有真取消＋真 Agent 競態作限定範圍組合驗收；不擴來源。

## Registry 現場結果

使用既有已登入 DataHub 瀏覽器、官方 OpenAPI 與真實身分，create-only 建立以下可辨識測試 metadata：

- `urn:li:api:ekop-datahub-t06.datahub_ingestion`／`apiProperties`。
- `urn:li:aiAgent:ekop-datahub-t06-canary-20260912`／`aiAgentInfo`、`aiAgentDependencies`，依賴上述 tool。

三個 Aspect 均 HTTP 200 建立、200 讀回，欄位值逐項核對相同。`source.type=EXTERNAL`；未註冊假 Skill、未把 metadata 查詢偽装為來源資料消費 lineage。這是 operator 註冊／相容性驗證，不是 Agent 自行管理 Registry，也不授予執行權限。

本機相容性限制與處理：

- GraphQL `__type(AIAgent)` 為 null；`entity(urn)` 對這兩個新 URN 回 null。不能宣稱 Core 已具備 Cloud Registry UI／GraphQL 支援。
- 公開 v2 aiagent list（完整參數、最小參數、status-only）均回 500。只擷取無敏感值的 GMS exception classes／stack frames，定位 `MappingUtil.mapAspectValue` 使用 typed Aspect map 時的 NullPointerException；未修改 Core mapper。
- 官方 Python SDK `scroll_entities()` 使用公開 **v3 `/openapi/v3/entity/scroll`**。同一路徑真回 200／totalCount=1，返回完整 canary info／dependency／原生版本。Adapter 採此既有公開能力，不重建搜尋或儲存。

## 最小 Registry UI（已核准套用）

- 同一 `/mfe/agent` 內新增 Chat／Agents 切換；Pi iframe 不被 Registry 切換卸載，原 heartbeat／失效／cleanup 保留。
- Registry 直接使用 DataHub parent 的同源認證與 v3 API；沒有新 gateway 權限、新 token、MCP write 權或 datamodel。只顯示 metadata，不執行 catalog instructions。
- 原生 button、44px、textContent、取消舊請求／卸載 cleanup、10 秒讀取上限、明示首 20 筆／非全量；不做空的 Tasks／Decisions 假頁。
- 1440／390 Chromium fixture：切換、XSS 字串只當文字、頁數限制告知、403 不回顯服務端內容、卸載後不回填通過。fixture 不替代真 DataHub UI。
- 33 個既有 Host／MFE／ingestion focused checks 通過；3 primary LSP 無 error。只讀凍結輸入、network-none／1CPU／512MiB 建出 Webpack 5.110.3 MFE；未重建 Pi image。
- 使用者分別核准首次套用與窄版修正的維護重啟；目前 gateway PID `791716`，Pi image 仍為 `9dc449…`，HOME／登入／sessions 保留，未動 Core／GMS／DB。
- 真 `/mfe/agent` 讀回 canary 與其 tool dependency，匿名同 API 回 401，切回 Chat 的原生輸入框可用。Reader 已到期，沒有藉此宣稱 Reader／跨 Actor 權限通過。
- 現場 390px 下 Core 側欄展開只留 66px 給 MFE，第一版按鈕溢出；保留紅證據後用 scoped flex／換行修正，66px fixture 與真頁控制區通過。使用既有 `Navbar toggler` 收合側欄後 Registry 內容可讀，已視覺檢查；不宣稱整個 Core 已完成手機版驗收。
- 最終 `remoteEntry.js` SHA256 `ff8ef4dbc84909e232e2dc5c65d194aebe40b11e77f08b194a03fad2495b4835`；`23.js` SHA256 `01664bf24fcb3d2a3e38f5738f5bfb2e4a4a175b6c843e6c40ce9b354dce943e`。兩個 served 檔案均與凍結 build bytes 相同，不能只比未變的 remoteEntry。
- HTTP Host probe 初次以 IP URL 搭自訂 Host 被拒，改正測試 URL 後通過；另一次先在 66px 空間等可見標題失敗，幾何讀回證明不是高度塌陷。僅修正驗收起始 viewport，沒有為這兩個 harness 問題再改產品。

## 未完成

Registry Reader／跨 Actor 權限負例，以及 Task／Decision／排程與 T07。Cloud 的 Task／Decision 是一般 Agent 指令與人工等待／回應，不可直接把 ingestion execution 或暫時 dialog 改名當完成。

已核官方 `metadata-models-custom` 支援獨立 PDL／registry plugin、版本相容性與原生載入狀態；尚未建立／建置／部署 Task／Decision 模型或變更 GMS。不得新建 datastore、改 Core 或為此加入通用 worker／workflow 平台。

## 證據

`.local/evidence/agent-registry/`：`create-attempt.json`、三個 `*-receipt.json`、`native-capabilities.json`、`public-api-paths.json`、`public-list-operation.json`、`native-list*.json`、`gms-error-frames.json`、`mount-tests.log`、`browser-tests.log`、`regression.log`、`mfe-input/`、`mfe-dist/`、`mfe-build.log`，最終 `mfe-final-input/`、`mfe-final-dist/`、`mfe-final-build.log`、`deployed-final.json`、`live-final.json`、`registry-final-*.png`、窄版 red／green 與 Host probe red。首次較大的 introspection query 失敗，不以該失敗推定模型不存在；上文採後續精確 query 的實際結果。

官方來源：固定 checkout 的 `docs/api/tutorials/agent-registry.md`、`docs/features/feature-guides/{agent-registry,agents}.md`、`metadata-ingestion/src/datahub/ingestion/graph/openapi.py`、`metadata-models-custom/README.md`。

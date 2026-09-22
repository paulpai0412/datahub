# T04 ingestion 接線與 T05 現場驗證（進行中）

主代理獨作／安全自查，非獨立審查。**已依使用者授權部署；T04 與本次限定範圍 T05 已驗收，T06/T07 尚未完成。**

## 必要接線

- 第一方 `datahub_ingestion` 只傳操作意圖，不接受 recipe、SQL、憑證或自稱 actor。固定入口組合未修改的 MCP adapter 2.33.0；RPC 載入器不變。
- Pi UI 經 MessageChannel 送交外層 MFE。MFE 驗實際 iframe／origin，寫入先在 DataHub 外層原生 dialog 確認；取消／卸載終止未完成的 UI 請求。使用原生 `dialog.close()` 恢復鍵盤焦點，按鈕至少 44px。
- `/agent/ingestion` 沿用 parent origin、即時簽入身分與 parent proof。Host 只呼叫固定官方 frontend GraphQL／OpenAPI；同一請求只轉送擷取的 DataHub session cookie pair。
- `ingestionSourcesByActor` 預設拒絕。使用者核准後，僅配置目前 actor 與既有 T03 canary Source、精確 recipe SHA256、CLI 1.7.0.9；實測配置前 recipe 與 T03 revision B 相同，Source version 3。
- Source／Secret／ExecutionRequest／Actions 仍以 DataHub 為權威；沒有新 datastore／worker。檢查 manageIngestion、source policy、預覽版本，以 create-only 公開 Aspect 提交固定快照。
- 不宣稱 worker exactly-once。未知結果保留 execution URN、不重送；取消不等於停工或回滾。建立／編輯 Source 與 Secret 仍走原生 UI。

## 建置與檢查

- 真 Pi SDK 0.85.1 resource loader＋未改 adapter 2.33.0：載入新工具、stdio discovery/call、reload 後只保留一份、disable 通過；已在候選映像內重驗。
- 第一輪靜態 import 導致 Next 型別檢查納入 adapter 原始 TS，出現 TS5097。改固定 package name 的動態 import，檢查 default factory 形狀；沒有改 adapter 或放寬 tsconfig。
- 第一候選完整 suite 973/979：五個排版敏感 assertion，及 standalone theme 測試未隔離 embedded 環境。只調整兩個 test 檔的 whitespace／trailing-comma 比對並加負例；standalone suite 設 `NEXT_PUBLIC_DATAHUB_EMBED=false`。**後續映像 979/979 通過**，production build 仍是 embedded=true。
- 反向 downstream patch／原 506 檔 baseline 保留；519 檔 source bytes/mode 與映像吻合；222 個 browser assets 與映像吻合。
- MFE 真 Chromium fixture：錯 frame/origin、拒絕、採 host version 的確認、caller cancel、preview 中卸載、焦點恢復與 390px 按鈕可見性通過。這些 fixture 不代替下節 live 證據。
- Host／MFE／身分／transport focused 回歸 33/33；scope、版本／recipe 衝突、重複建立、未知結果、跨 actor 與安全結果投影均涵蓋。
- Builder 維持既有單 CPU／3GiB／serial／flock，完成已停止；未移除 cache／volume。MFE 在獨立快照、network-none 的限額容器建置，未在開發 checkout build。

## 實際部署與 Agent 路徑

- 首次部署映像 `sha256:01f43aaf770da4657e0ff6b85a8ca61997cbf7f3467c28429658dac637d7c24d`；gateway 2281517 → 3641247，保留原 HOME volume。
- 真 `/mfe/agent`，Sol／read-only preset 實際呼叫 `list_sources`、`inspect_source`，回 Source version 3、CLI 1.7.0.9、Person.Person＋vEmployee 的 metadata-only 範圍。
- 真 DataHub 外層確認顯示相同 Source／version／recipe hash。拒絕測試回 `declined`／`submitted:false`，模型沒有重試。
- 核准的 `TEST_CONNECTION`：`ffa8ba85-28af-4738-b62c-fd7c464681fc`，原生結果 **SUCCESS／4815ms／basicConnectivityCapable=true**。Agent 起初两次漏傳 status 查詢所需 sourceUrn，未取得狀態；補齊兩個 URN 後由同一 Agent 正確讀回，**未重送工作**。
- 已修工具描述與提前參數檢查：除 list_sources 外須 sourceUrn；get_execution／cancel 還須 executionUrn。錯參數在 UI／提交前回明確錯誤，Host 安全邊界不變。原先兩次失敗及後來錯 sourceUrn 的拒絕保留，不能當成功。
- 參數修正映像 **`sha256:af868d776fa2b0de5e332e7c467b5f61971b2723e4187472abd83ebc466d503f`** 已部署，gateway **4065127**。519 檔中僅新工具檔相較前一映像改變、518 檔相同；重用前一映像 979/979，另在新映像跑 native 5 tests（含缺參數負例）與真 SDK adapter 檢查，不冒稱重跑全部 979。
- `RUN_INGEST`：`c2d63ccc-5acd-4569-b128-9ef214d18a2d`，**SUCCESS／7213ms**。Agent 先因錯 sourceUrn 被拒絕讀狀態，修正後讀回 SUCCESS，未再提交。
- Operator GMS 讀回 Person.Person 13 欄、vEmployee 18 欄；vEmployee 9 個直接上游包含同 instance 的 Person.Person。Schema／lineage 的原生 systemMetadata.runId 是本次 **bare execution UUID**，與保存 input 中完整 execution URN 的 run_id 表示法不同。Person 沒有 upstreamLineage Aspect，404 不當錯誤或偽造空成功。
- 以上 GMS 讀回不是 Agent MCP 讀回；job SUCCESS 也不等於來源 SQL 關係驗證、業務正確或全量 lineage 完整性。

## 後續 live 負例與最小修補

- 真 Agent MCP `get_entities` 讀回 13／18 欄；`get_lineage` 實際參數 upstream=true、max_hops=1、max_results=20、query=*、無 filter／column，回 total=1／returned=1／hasMore=false，唯一可見上游為 Person.Person。原 GMS Aspect 有 9 個 reference，不能把 MCP 的搜尋結果當成全部 references 已物化或全量來源 lineage 完整性。
- 真 Agent 新 run `3b844b85-d72c-47a1-b829-d5782f7bf673` 的 cancel 預覽為 RUNNING，但提交取消後回 `cancel_not_accepted`，最終 SUCCESS。這是取消／完成競態，不是成功停工，也沒有回滾承諾。
- 操作人員以官方 CAS 將同一 canary 的 include_view_column_lineage 改 false，version 3→4；資料範圍、metadata-only 及 CLI 不變，Host policy hash 不放寬。真 Agent run 意圖被拒／unconfirmed，沒有繞路。其後 CAS 4→5 恢復**原 recipe bytes／hash**；此段不是 Agent 自行編輯來源。
- 實測發現 UI 的 unconfirmed 回覆未附工作識別碼：舊版只在 onUpdate 發出 ID，最終結果會遺失。只修同一工具的 result helper：所有最終回覆保留 requestId，提交意圖帶 proposedExecutionUrn，查詢／取消帶既有 executionUrn。沒有新儲存或重試機制。
- 最新部署映像 **`sha256:9dc4493de5dc11fa6aa74d2fa8143f2b96e806b07ef2e54032de433d95119f67`**，gateway **64103**。舊映像對新增回歸為 4/5、新映像 5/5；新映像 SDK load/discovery/call/reload/disable、production build、519 source／browser assets、Host 等 33/33 通過。完整 979 僅重用先前未變更部分的證據，非聲稱本映像重跑 979。
- 新映像真 Agent 對未核准合成 Source 的單次負例：最終 unconfirmed 正確保留 requestId／proposedExecutionUrn `26f43b8e-75a7-47ad-a7a3-03c768a28479`；官方 input GET 404 確認未建立。模型停止而未盲重送。
- version 5 的首次重跑確認未完成／拒絕，點擊時已無按鈕；最終 declined／submitted=false，提議 `f362aac1-75cb-4aba-89dd-a44c182769f0` 亦經 input GET 404 核對。另行明確操作的新 run 才重新確認，不重播未知 mutation。
- 恢復後新 run **`f08136a7-94d2-43d3-8568-7567bda42336` SUCCESS**：真 Agent 五次工具呼叫含 run／狀態／兩資產／lineage，回 13／18 欄與一個 MCP 可見上游。Operator 再核两 schema 與 vEmployee lineage 的 systemMetadata.runId 均為本次 UUID；整頁 reload 保留結果。見 `rerun-version5-{actual-tools.txt,gms-readback.json}`、`rerun-session-reloaded.json`。
- 最後一次取消測試改為同一個有界 browser script 即時核對／確認，排除跨工具操作延遲；新工作 **`1b4d36ed-6022-497d-be1e-dab1cb742688`** 在取消預覽時已 SUCCESS／6411ms，故明確點「Do not execute」，未發取消。不重試、不擴來源範圍，保留 `fast-cancel-*` 證據；仍不宣稱 Agent 成功停止 RUNNING 工作。

## 瀏覽器與短效 Reader

- 原所屬 CDP 33771 後來連 `/json/version` 都逾時；同期 Agent HTTP 正常、未 OOM。只確認瀏覽器／控制通道失去回應，未推定根因。
- 使用者核准後，經原 runner 正常 close/reopen 同一所屬 session；未匯出 auth、未動其他瀏覽器。使用者親自重新登入 DataHub，現 CDP 38755。Pi HOME／模型登入仍保留。
- 首次新簽的一小時 Reader token 通過 read 200／13 fields、write 403，但未配置便在恢復／等候登入期間過期；沒有重播其建立請求。
- 使用者另行明確核准再簽一個一小時 token：沿用原 service Reader，不改角色；再次 read 200／write 403 後，以 native MCP config API save/readback，再由 native MCP 頁 reload current session。Token 僅留私有檔／目前 actor 原生設定，不輸出、不自動續期。
- Reload 成功後 Close settings 的測試 locator 錯誤逾時；只用 Escape 關閉，不重做 token 或 reload，不擷取含 token 的設定內容。

## 證據與未完成

私有證據根目錄：`.local/evidence/agent-ingestion-wiring/`（不得上傳 token／登入資料）。

- 建置：`build-first.log`、`build-tested.log`、`build-args.log`；image ID 誤用 config digest 的失敗另保留。
- Checks：`image-tests.log`、`image-tests-final.log`、`args-exact-image.log`、`args-image-delta.json`、`args-image-source-check.json`、`artifact-args.json`、`regression-final.log`、`browser-focus-red.log`、`browser-final.log`。
- 新映像 fixture 第一次因 Docker 自動建立的 root-owned mount parent 無法放 symlink 而失敗；改 fixture mount 位置後同 protocol 通過，未提升權限／改產品。
- Live：`deploy-before.json`、`deploy-args-started.json`、`native-inspect-result.txt`、`native-confirmation.png`、`native-declined.txt`、`native-status-errors.txt`、`execution-wrapper-probe.json`、`execution-query-probe.json`、`native-test-reconciled.txt`、`native-run-result.txt`、`native-jobs-and-gms-readback.json`、`reader-confirmed/`。
- **使用者驗收決定**：明確選擇「維持範圍，採組合證據後進 T06」：採 T03 真 CANCELLED＋T05 真 Agent 取消競態與回歸作此兩資產範圍驗收。據此 T05 收斂，不擴大來源；仍不宣稱已證明 Agent 停止 RUNNING 工作。T06/T07、SQL 驗證／人工審核／可信關係失效仍未完成。
- 新證據：`mcp-entities.json`、`mcp-lineage.json`、`mcp-readback-check.json`、`cancel-native-preview.txt`、`native-cancel-result.txt`、`config-change-result.json`、`config-restore-result.json`、`config-rejected-agent.txt`、`correlation-{red,green,exact-image}.log`、`correlation-live-rejected.txt`、`correlation-proposed-not-created.json`、`regression-correlation-final.log`。

## 既有 drift／診斷

- RPC SHA256 仍是 `69ac6662cf9845d19ca0e500e07689598b618db8a8ad7adb4c265055ddb60882`；subagent runtime 仍是 `a5c918e530afe96d9249c42637002355182c229ba03f3c11a17d224859f27602`，未為診斷修改。
- 舊 cast self-scan 持續引用過時行位；本輪再核 bytes 不變、指定兩檔 cached lens 無 error，另有 source-bound production typecheck／suite 證據。既有告警仍保留／defer，不聲稱修復或全 repo clean。
- 新工具檔 LSP 仍報舊行 73–75 的結尾語法錯誤，但當前檔只有 73 行；當前 bytes 的 TypeScript parseDiagnostics=0、Node parse／執行回歸與新映像 production typecheck 均通過。見 `correlation-parser-check.json`／build log；保留 stale 診斷差異，不修改正確原始碼迎合快取。
- McpConfig 原先 drift 已完成 diff 與有限括號 normalization 的 emitted AST 核對；不等於完整 TS AST 相同。最新 downstream lock／映像 byte 檢查才是當前產物依據。

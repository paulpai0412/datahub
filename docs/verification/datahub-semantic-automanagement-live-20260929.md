# SalesDatamart 語義代管：單欄 AUTO 成功、整輪尚未完成

**2026-10-01 最新狀態：r2 的限定單欄 AUTO 真實發布成功，初始持久 outcome 為 VERIFIED_CURRENT_VALUES，完整 Aspect 與預期一致，version 3→4。但只有24筆政策例外，accounted25／76、missing51、pending0，Run未關閉，整轮 E2E 仍未完成。** 原30分鐘政策未延長；第二則訊息未送，02:47Z已恢復原readonly9041。78則歷史重載一致、真UI顯示未完成；原35個session檔無新增／刪除，僅獲准session追加，其他34檔SHA不變。下方階段紀錄保留，不把單欄成功、來源審查或200tests當作76項完整驗收。

## 精確範圍與現場變更

- 使用者選擇復原既有 `localhost:9041` 路由，而不是重啟 DataHub frontend 建立第二入口。本輪未重跑 ingestion、未連來源 SQL，未改 DataHub Core／GMS／其他專案，也未 commit／push。
- 既有停止的 Agent 容器 exit 255、唯讀 rootfs、`network=none`；復原前以唯讀掛載核對兩個 HOME volume／32 個 session JSONL：較早的 31 檔基準中 30 檔 SHA 不變，另 1 檔最後改於 `2026-09-29T00:14:21Z`，早於容器退出時間。**只移除該停止容器，沒有使用 `docker rm -v` 或刪除 volume／session**。收據 `.local/evidence/semantic-automanagement-20260929/stopped-runtime-{readonly,remove-intent,remove-receipt}.json`。
- 啟動前 staged image `sha256:2f26a7de14e6d277f8ada0860aa2abf32c6c7253aabf8b5e63cfb40c870c9cd4` 對齊 579 個來源檔與 223 個瀏覽器資產。只切換原 Agent MFE 的 `835.js`，保存原 bytes 以供回復；實際 9041 供應的 `remoteEntry.js` SHA `49eb2ba4…`、chunk SHA `e2d04cb5…`。沒有改原 `.local/agent-server.json`；改用獨立限定配置 `.local/agent-server-semantic-readonly-20260929.json` SHA `84bc4bc6…` 啟動舊路由。配置只有一個 actor、一個 Source、七個 Dataset；`semanticPublicationApproved:false`，沒有 AUTO policy 或 SQL connection／grant。這**不是隔離環境**，仍共用本機 DataHub Catalog。
- 本機 DataHub 登入檔曾因測試程式錯用 SQL Secret 的 `0600` 讀取條件而改權限，造成登入回歸；後來證實容器 UID 100 無法讀取主機 UID 1000 的 `0600` 檔案。20:01Z 經使用者明確核准恢復原 `0644`，外層 `.local` 仍 `0700`、容器唯讀掛載不變、內容 SHA 不變，未重設帳密或重啟服務。修復與登入證據見下節。

## 真入口唯讀收據

真瀏覽器自 `http://localhost:9002/mfe/agent` 經實際 MFE／9041 Host、原生 ACL 與 DataHub API 呼叫 `catalog/1 inspect_managed_scope` 和 `inspect_asset`，沒有 fixture：

| 讀回 | 觀察 |
| --- | --- |
| 成功 Run | `urn:li:dataHubExecutionRequest:f9a55669-6c27-49f5-9ff0-d8f04e1f48f5`，封閉 recipe 六張 `dm` 表、一個 reporting view |
| 範圍 | 7 Dataset／69 欄；scope fingerprint `fdb7b16a75479727135291047e61b3e0de02788a02f4bd1747e5dd588884d3cc`；`checkpointVerified:false` |
| 寫入授權 | `publicationAuthorized:false`、沒有 managed cycle |
| 欄位 | `fact_sales_order_line` 13 欄；`linenetamount` 有固定 `metrics.md` 第 17 行的精確公式證據，當前 editable description 為空 |
| 瀏覽器 | Chromium `153.0.8010.12`、1440×900；兩次唯讀讀回的 page／console errors 都為 0 |

先讀回 `.local/evidence/semantic-automanagement-20260929/live-browser-readonly-entry.json`，首次訊息測試中斷後再讀回 `live-browser-readonly-post-model.json`；兩者範圍 fingerprint 與空值相同。這證明指定入口與指定項目在觀測時可讀，**不**證明其餘 75 項已處理，也不是新 Task／Run／Decision 的完整不存在證明。

## 模型與認證對帳

- 唯讀模型就緒讀回：既有預設 `openai-codex/gpt-5.6-sol` 出現在可用清單，Agent 無進行中 session（`live-model-readiness.json`）。僅在瀏覽器選擇 `semantic-governance` 工具 preset，沒有給模型 Bash／SQL／ingestion 工具。
- `2026-09-29T12:48Z` 從真 Agent 頁送出**一則**要求 `inspect_managed_scope` 的唯讀訊息。瀏覽器檢查器在等待 session 時錯誤地把非同步 `waitForFunction` 回值判成 false；**沒有因此重送**。其後唯讀對帳：原 actor session 數仍 26，無新近持久 session、無進行中 session。**更正先前錯誤歸因**：原 runtime 日誌是 `MCP: Failed to connect to datahub … invalid_token … (401)`，不是 Codex／模型提供者的登入錯誤；去識別原始段落保存於 `auth-boundary-log-redacted.json`。這份收據不能證明當次模型有回應，也不能證明 Codex 權杖失效。初始 intent、送出及失敗／對帳收據分別在 `.local/evidence/semantic-automanagement-20260929/model-readonly-{prompt-intent,submitted,failure,reconciled}.json`；raw runtime 憑證及模型內容不進公開文件。
- 因上述錯誤歸因而請使用者核准標準 OpenAI Codex 重新登入，是本輪判讀失誤。第一次 device challenge 經 8 分鐘結束，第二次依使用者要求產生新代碼；使用者表示在提供者網站完成，但測試腳本約 35 秒後記錄 `device_wait_interrupted`，**沒有足夠證據把腳本中斷當成產品 SSE 根因或既有登入失效**。原有 `loggedIn:true` 及 auth 檔 mtime 未改亦不代表原憑證無效。舊嘗試收據不改；後續依使用者要求開啟的可見登入流程逾時，再只開啟設定頁交使用者操作（`visible-login-r1/`、`manual-login-page-r1/`）。使用者指出原本已登入，故停止要求重新認證，不讀取權杖或變更模型登入。
- `2026-09-29T14:01Z` 沿用既有登入，從真 `/mfe/agent` 送出一則新的限定唯讀查詢，完整捕捉 HTTP 200 prompt acceptance 與持久 session `01a0ed78-5403-709f-bc9e-2163f011ba68`。**`openai-codex/gpt-5.6-sol` 正常產生 tool call 與最終回應，證明現有模型登入可用，無需重登。** 唯一工具為 `datahub_semantic` 的 `list_sources`，返回 `authentication_required`；因此仍未由模型取得 7／69 scope。證據 `existing-login-model-r1/verified-model-boundary.json`、`session-private.json`、`network.json`、`browser.png`，未變更 auth／MCP 配置，未請求 metadata 寫入。這個 Host 工具錯誤與 MCP 的 401 是不同邊界，是否同因尚未證明；後續無模型的差異探測在 Agent Workspace 顯示前逾時，未取得新的比較结果。

## 登入回歸修復與真模型完整盤點（20:01–20:24Z）

私有證據集中於 `.local/evidence/semantic-automanagement-auth-20260930/`，沒有輸出帳密、cookies 或模型權杖。

- 舊 browser storage 的 `PLAY_SESSION`／`actor` 於 14:01:20Z 到期，先前模型的 `list_sources` 呼叫發生於 14:01:26Z；不能繼續將該 storage 當有效登入。新 DataHub 登入最初回傳 `400 Invalid Credentials`；檔案內容確與使用者提供的測試帳密相符，但容器實測 `test -r` 失敗。
- 官方 `PropertyFileLoginModule` 讀不到檔案即認證失敗。只恢復檔案原權限後，相同帳密 `/logIn` 回傳 **200**，`createIdentityVerifier` 原生核身通過且符合既有 Source policy actor；新 cookies 到期為 2026-09-30 20:02:25Z。這直接驗證檔案可讀性的根因修復。**沒有改 Core、Codex 登入、ACL 或服務程序。** 收據：`login-mode-recovery.json`、`login-recovery-receipt.json`；先前拒絕收據不覆寫。
- 真 `/mfe/agent`、既有 `openai-codex/gpt-5.6-sol`、Semantic governance preset 建立 session `01a0eec5-028e-709f-bc9e-2165f7d0f39b`。模型成功呼叫 `list_sources`、`inspect_managed_scope`，取得同一 Run 與 fingerprint。
- 第一次 `inspect_asset` 漏 `sourceUrn` 被拒絕。核對 Host `parseCatalogRequest` 後，在**同一 session** 發送明確的唯讀參數修正；後續頁亦帶第一頁 `snapshotDigest`。原失敗及原收據保留，不是重播未知寫入。
- 後續模型完成 **8 個成功 `inspect_asset` 頁面、7/7 Dataset、69/69 個 `(Dataset, fieldPath)`**。七個欄位數依序為 7、8、4、5、13、8、24；最後一個 view 為 20＋4 分頁。同 session 合計 10 個成功工具結果、1 個已知拒絕結果、26 則歷史訊息。
- 原始工具收據逐項核對 scope 成員、欄位集合、頁 offset／digest、來源與人工說明、契約 SHA：來源 Dataset 說明 **0/7**、欄位 **0/69**；既有 editable Dataset／欄位說明各 **1**。只有 fact `linenetamount`、summary `quantity`、view `linenetamount` 三個欄位有固定契約公式。**有公式不等於已核准可發布。** 詳見 `verified-model-inventory.json`、`verify-inventory-receipts.py`。
- 從真入口重載該 session，26 則訊息與原收据雜湊一致，模型盤點結果可見，page／console errors 均 0：`history-readback-r1/receipt.json`、`history.png`。這是盤點歷史，不是尚未建立的 managed-cycle 卡片驗收。
- 本輪沒有 Task／Run／Decision 建立、metadata 發布、來源 SQL 或 ingestion 呼叫；限定配置 SHA 不變，AUTO 未啟用。DataHub MCP startup 的舊 401 **未在本輪修復或重驗**，不能以 Host 工具恢復宣稱 MCP 已正常。

## 獨立審查與本地修補（21:04–23:28Z）

- 使用者明確核准一次普通原生 `team.reviewer`、GPT-5.6 Luna／high、fresh、20 分鐘上限、無 shell／修改／憑證權。實際 reviewer `8f20f7c6-8896-4c65-a562-75ffe1ca1e41` 已結束且 process terminal observed；不是 Task Pi 派工。外層 workflow 的完成只是 detached child 的啟動 ACK，未當成審查完成。結構化回報有效，**結論 BLOCKED**，三項 criterion 均 `not_met`；空 Markdown 不代表沒有發現。原回報與來源核對在 `review-result.json`、`review-collected.json`，原件 SHA `5eda0947dc176cf446b686b7e749167929b9a3001ad864131e6090245dd06143`。
- 主層重現：新 requestId 能再次派送同目標 UNKNOWN；claim 後到期／撤權仍可能送出目標寫入；例外可以與已發布／UNKNOWN／不同 code 的同目標收據重疊。原始 RED `review-regressions-red.log` 保留，沒有覆寫為成功。
- 本地修補三個 owning modules：`semantic-managed-cycle.mjs` 共用持久 Decision 的目標解析並拒絕讀回衝突；`native-semantic-tasks.mjs` 在同一 Run CAS 前核對目標占用，已嘗試、pending review 與例外不能靠新 requestId 再占用；`task-records.mjs` claim 後重驗原生範圍，所有非同步讀取後再同步核目前 Host 政策／時間，才送目標寫入。未嘗試的真人 REJECT／selection supersession 可另立提案，但不沿用舊 consent；UNKNOWN、NOT_DISPATCHED 的 attempt 仍消耗且不可重播。
- 回歸包含不可觀測 UNKNOWN、新 requestId、pending reservation、claim 後到期／撤權、其他 Dataset schema 漂移、雙向 publication／exception 衝突、歷史矛盾收據，以及正常人審／不同目標／拒絕後新提案。最終十四個相關測試檔 **196／196 PASS**：`review-related-regression-final.log`。較早擴大檢查沒有完成收據且 log 為空、無存活程序，原件保留；此次是已對帳後的新一輪純 synthetic 檢查，不重播任何 live 效果。未安裝缺少的 formatter；目前原生 Node 語法及四檔 primary LSP 已驗，這不等於全專案掃描。
- **修補版尚未部署、尚未獨立複審通過，AUTO／本輪 metadata 發布仍為 0。** 先前成功的真唯讀盤點與歷史是實測事實，不是修補版的部署驗收。
- 23:27Z 唯讀核對現場：9041 無 listener、舊 gateway PID 不在；精確容器 `598f123266d7ff0d43ddd786de1dc87e6e66159176974638f75ee0394373d38c` 已於 23:06:54Z exit 255、PID0、非 running、Docker OOMKilled=false，原因未證實。image 不變、read-only rootfs、network=none；**未重啟、移除或修改 HOME**。`stopped-runtime-final-readonly.json` 保存現況，恢復需另確認操作範圍。

## 修補後複審與第二輪修補（2026-09-30 13:14–13:35Z）

- 使用者核准第二次同規格複審，並核准**複審通過後**才恢復唯讀 9041；另說明停機是重開機所致。沒有把這項說明當作 AUTO 寫入或解除審查門檻的授權。
- child `50e397b7-356e-41af-9533-4d7c3970b766` 已正常終止（runner exit0／terminal observed），native structured report 有效、來源 83 檔核對一致。回報仍 **BLOCKED**：前輪重播／重複收據修補有覆蓋，但 scope 核對後的 `activeRun` 非同步讀取可讓 schema／recipe 漂移漏過目標 CAS。來源報告 `review-r2-result.json` SHA `6dd5eb1cab873686a00a36dcb229207747bfb6897f198c82c207e416868a6f67`，收集證據 `review-r2-collected.json`；未執行測試的 reviewer 不被說成已測通過。原 native usage 125,646 tokens 保留於收據，不因修補重置。
- 主層補判別性回歸：在最後 Task 讀取時改非目標 Dataset schema 版本或成功 Run 的 recipe；兩者在舊候選都實際呼叫了 mock 目標写入。另證明長輪次接近兩小時 lease 時，即使 operator policy／review 仍有效，scope 讀取期间 lease 過期也會送出。`review-r2-regression-red.log` 保留（20 PASS／4 FAIL，含父測試）。這些是 synthetic，不是真 Catalog 寫入。
- 最小修補將 managed scope 核對移到**最後一次非同步 admission 讀取**，保留 Run revision／attempt／consent 檢查，送出前再同步核 consent、policy／時間與既有 `parseManagedCycle` lease／binding。授權 callback 的三個 caller 均傳可信 Run／Task snapshot；未加 datastore、scheduler、跨系統交易或 retry。一次漏更新 caller 的中間失敗留於 `review-r2-regression-green.log`；其後已修正，不把該檔名當 PASS。
- 最終專項 **24／24**、十四組相關回歸 **200／200 PASS**：`review-r2-regression-green-r2.log`、`review-r2-related-regression-final.log`。三檔 primary LSP confirmed clean，Node syntax／scoped diff check PASS；保持正常 AUTO fixture、人審、REJECT 新提案及不同目標成功。**仍未有最終獨立 PASS，也未部署。**
- 這是最後觀測 scope＋各目標原生 Aspect CAS，不宣稱 DataHub 提供 Source／Task／Run／所有 Dataset 的跨 Entity 原子交易，也不宣稱能阻止外部系統在最後觀測之後變更。當前 readonly config SHA `84bc4bc6…`、MFE bytes 與登入檔0644不變，AUTO 未啟用；9041 復原尚未操作。

## 唯讀復原與最終來源審查（2026-09-30 14:15–15:01Z）

- 使用者另行批准**立即恢復唯讀 9041，不再等待 AUTO 審查**，並批准最多兩次額外順序 `team.reviewer`／Luna-high／fresh 審查，各最多20分鐘。沒有增加 shell、修改、憑證或 live API 權限。
- 核對固定 image、579 個 pi-web 來源、原 MFE／readonly config 與雙 HOME 後，只移除精確停止容器 `598f123266d7…`，未使用 `-v`。新 gateway PID `311205`、runtime `3eea0a9d51e9…`，同一 image、read-only rootfs、network none。沒有重建前端、重啟 frontend／GMS、變更 `.local/user.props` 原0644或 Codex 登入。
- 真 `/mfe/agent` 重載原26則訊息，message SHA `6374ef87…` 相同；Semantic governance preset、盤點總結可見，page／console errors0。另經真瀏覽器 Host 工具讀回同一成功 Run、7／69與同一 scope fingerprint；fact 欄位仍空、固定公式可見，`publicationAuthorized:false`、`managedCycle:null`。這次沒有送新模型 prompt。
- 復原前後兩個 HOME 的 **34 個 session JSONL（28＋6）SHA 全部相同**，無缺失、變更或新增。收據 `restore-complete.json`、`restored-history-r1/receipt.json`、`restored-readonly-scope.json`；私有快照不公開。此次 metadata／原生 audit 寫入均0。
- 第三次實際 child `cb2bc065-c377-45a8-a59f-48ddf79e4de2` 正常終止，報告三項均 met／PASS；但14:29:43Z自動格式化在審查期間改了兩個 Host module與回歸檔。主層查出3個 SHA 不符，保留 `review-r3-{result,native-status,collected}.json`，**沒有把內容 PASS 追認成最終來源通過**。
- 格式化完成後，主層重跑十四組相關回歸 **200／200**，三檔 primary LSP、Node syntax與 scoped diff PASS；四檔 Lens session cache無 error（不是全專案掃描）。最後一次額度審查綁新的83檔 manifest `review-r4-source.sha256`，SHA `63cb2b487e078909d9b3c5c155b46b85a632d88105008b3d1041d0e86c458c1d`。
- 最終 child `e04c3c31-e38f-474a-9041-423c2ae3507d` 於14:54:43Z正常終止、exit0／terminal observed，三項 criterion均 met，**獨立來源審查 PASS**。主層15:01Z核對83檔全部一致、原生 schema有效、index／Core乾淨及原始回歸證據後，採納這個限定單欄 canary 的來源審查。原件 `review-r4-result.json` SHA `38b71af39d8dd21244dcf989470e229d67e62c526099e5dbe807ad3d723f5e77`；收集與主層判定在 `review-r4-collected.json`。
- 原生 wrapper 的**推定寫入驗收**仍記 `rejected`：唯讀 reviewer沒有子程序命令紀錄，也沒有宣稱自行核對 staging。prepared request沒有指定這個 writer gate，原生文件明定 inferred gate不使run失敗。主層補記實際200tests與index核對；不改寫原生狀態、不宣稱 native checked／Task Pi AcceptanceReceipt、不加派代理或調整工具設定。實際來源審查與這個 wrapper欄位分開保留。
- 非阻擋限制：沒有專門在最後同步核對後注入 mutation的回歸；目前該段到 `call()` 沒有 await，既有測試已覆蓋最後非同步讀取期間的漂移。這不提供外部跨 Entity原子性。仍須真實一次性發布及完整讀回驗收，不能拿來源 PASS當寫入許可。

## 限定 AUTO 真模型嘗試與撤回（2026-09-30 15:19–16:14Z）

私有證據位於上述 evidence 目錄的 `auto-canary-r1/`；整體結論為 `outcome.json` 的 **INCOMPLETE_NOT_PUBLISHED_READONLY_RESTORED**，不是 AUTO E2E PASS。

- 使用者批准最多30分鐘政策，只能填入 `dm.fact_sales_order_line.linenetamount` 的空 editable description，精確公式 `LineNetAmount = OrderQty * UnitPrice * (1 - UnitPriceDiscount)`。上限為1個原生Task、1個Run、76個Decision、1個新Agent session及2則Sol／medium模型訊息；其他目標只能誠實記錄例外。本次仍共用本機Catalog，不是隔離staging。
- 真API預檢核對原生身分／ACL、成功Run、recipe、7／69範圍及空before，完整 `editableSchemaMetadata` 為version3。既有Agent註冊可讀，指定新輪次不存在；沒有新建Agent註冊。15:33:45.562Z啟用限定政策，原到期時間16:03:45.562Z；只重載本案9041，固定image／MFE／HOME保留。
- 兩次瀏覽器驅動在送訊息前逾時，沒有新session或semantic請求。完整錯誤證明第二次選到了隱藏的「New session」按鈕，後改用既有公開 `?cwd=` 新對話導航；另修正reasoning選項的可存取名稱。第一次未保留完整selector錯誤，先前將它歸因於medium選項的說法不算根因證明。這些是測試驅動失誤，不是產品Core修補。
- 真入口最後送出**1則**模型訊息；持久session確認模型為 `openai-codex/gpt-5.6-sol`、thinking `medium`。模型成功盤點並建立Task／Run各1筆；`prepare_managed` 回傳 `semantic_snapshot_conflict`。`inspect_asset` 帶了頂層 `fieldPath`，準備發布卻沒有帶，導致摘要綁定的 `fieldRow` 上下文不同；不是目標欄位已被寫入。仍返回13欄，不能把它描述為只傳回單欄。主層真API確認Decision／attempt為0、完整Aspect未變；只換成完整資產快照的唯讀編譯通過，但**編譯不等於發布**。
- 模型兩次 `read_managed_cycle` 也被拒絕，因附帶Host不允許的 `contract`，第二次另錯用 `runUrn`。**更正早期對帳收據的錯誤推論：不是缺少sourceUrn。** 此讀取只接受action、requestId、cycleRunUrn、offset；Run本身提供Source綁定。主層復原後第一次收集器同樣附了多餘參數，保留409；依實際契約修正後，真Host唯讀讀回成功，詳見 `restored-managed-cycle-read.json`。
- 準備第二則訊息時，原政策時窗已不足驅動要求的5分鐘餘裕，因此**第二則未送出**；沒有延長政策、換輪次或重播attempt。未送出的修正草稿也有生命週期action參數錯誤，已在 `outcome.json` 標示不可當可重跑程序。保留所有失敗，不把這輪耗用的時間或audit重置為零。
- 16:01:03Z已恢復原readonly config（SHA `84bc4bc6…`），gateway PID `742584`，早於政策到期；實際runtime為 `31ad573f4f8f…`、同image、read-only rootfs、network none。新Host已載入受審的目前來源；部署前後83檔來源核對一致，後續只更新本紀錄。
- 最終官方Aspect讀回：Task／Run各1、Decision／attempt／publication／exception皆0，目標完整Aspect與before完全相同、仍version3。真Host讀回 `INCOMPLETE_OR_UNVERIFIED`、accounted0、missing76、pending0，Run未關閉；沒有假造75筆例外或完成輪次。16則歷史SHA一致，真入口的未完成卡片顯示0／76；`managed-cycle-card.png`已視覺核對。
- 兩個HOME共35個session JSONL：**原34檔SHA全部不變、無缺失，新增的唯一檔屬本次獲准session**。没有讀出provider憑證、刪session、修改登入檔、重啟其他服務、執行SQL／ingestion或metadata發布。瀏覽器page errors0，但收集器記錄console errors，包含上述已知409；未宣稱瀏覽器全無錯誤，也未把Host成功當MCP修復。

**回顧：**安全邊界拒絕了不一致請求；未完成的原因包含主層驅動／提示參數準備不足，消耗了短效時窗。下一次應先驗好可見控制項與每個Host action的精確參數，再啟用政策，而非在啟用後調整或延長到期時間。`record_managed_exception`不接受contract／sourceUrn／scopeFingerprint／reason，`finish_managed_cycle`也不接受這些欄位；不得照未送出的草稿重跑。

## r2 單欄成功、稽核輪次未完成（2026-10-01）

私有證據：`.local/evidence/semantic-automanagement-auth-20260930/auto-canary-r2/`。

- 使用者另准最多30分鐘、新Task／Run各1（含r1累計各2）、最多76 Decisions／1 attempt；沿用r1 session，Sol／medium最多再2則訊息。標準本機DataHub登入刷新一次成功，登入檔0644／外層0700及內容不變，未讀改Codex憑證。唯讀預檢核7／69、舊Run零Decision、新Run不存在、目標空且version3；合法action模板由實際Host allowlist核對，真UI的既有session／Send控制項演練未送訊息。
- 最後入場檢查發現9041消失：原PID不存在，精確舊容器於01:06Z exit255、非OOM，當前boot／uptime亦落於該時段。保存 `gateway-loss.json` 後只移除這個停止容器（無-v）並復原相同readonly配置、image及HOME，再重新核身／scope／完整before。這次中斷在AUTO啟用前，沒有因此重播模型訊息或metadata寫入。
- r2政策於 **02:04:49.252Z** 啟用，到期固定 **02:34:49.252Z**。真入口、原session `01a0f2f9-61bb-7311-a8c5-88761e7350b6` 送出一則Sol／medium訊息，完整資產快照與prepare上下文相同；新Task／Run各1，僅指定欄位description一次發布。
- 原生Publication Decision `5db3c080-463f-46f0-b30c-faf9a4679310`，attempt `6218c49f-55b7-41e0-bdbf-db076fa54c42`。初始持久 `outcomeJson.status=VERIFIED_CURRENT_VALUES`、context `SOURCE_SCHEMA_REFERENCES_RECHECKED`、observation `MATCHED`；當前完整 `editableSchemaMetadata` 等於已存review的 `valueJson`，before等於 `beforeValueJson`，version **3→4**。這不是用後來MATCHED追認UNKNOWN。
- 模型又成功記錄24筆 `POLICY_DENIED`，於02:08Z自行回覆未完成；捕捉的32筆Host請求無工具錯誤／攔截，最終provider `stopReason:stop`，沒有證據指向硬性工具額度或runtime失敗。原生對帳是25 Decisions、1 attempt、1 VERIFIED、24例外、51 missing、0 pending。沒有呼叫finish或假裝76項完成。
- 使用者另准把第二則訊息用於**同Run剩餘51例外與finish**，但仍限原時窗、不得再發布。該訊息的送出前檢查已在政策到期後，因此沒有 `prompt-2-intent.json`、沒有第二則模型請求。主層未在期限內收完，未更改舊policy、Run binding或lease，未重開新輪次。不能把此結果歸因於Task Pi readiness。
- 原readonly配置SHA `84bc4bc6…` 於 **02:47:37Z** 恢復，gateway PID `320455`；撤回操作晚於policy expiry，如實保留。已捕捉的模型寫入全在02:08Z以前，第二則未送；02:50Z真入口及原生讀回再次核對1 VERIFIED＋24例外、missing51、pending0、未關閉，`publicationAuthorized:false`、`managedCycle:null`。沒有延長有效授權期。
- 78則歷史重載SHA相同；`final-partial-cycle.png` 已視覺核對25／76、24／1／0及 `INCOMPLETE_OR_UNVERIFIED`。兩個HOME仍35個session檔，只有同一獲准session變更，其他34檔逐byte不變，無新增／缺失。r1 Run仍version1、decisions空；不改寫舊失敗或永久UNKNOWN。
- 收據：`final-partial-readonly.json`、`final-partial-native-private.json`、`partial-reconciled.json`、`model-capture.json`、`session-preservation.json`、`restore-launch.json`。一個收集器誤取不存在的 `afterValueJson`，修正為真實契約 `valueJson` 後完成唯讀核驗；不重做發布。新增程式只有私有驗證／操作腳本，受審產品來源、固定image／MFE未變；本輪沒有新增review／Task Pi／SQL／ingestion。

**回顧：**發布本身已經成功，但主層未備妥及時續作與完整收尾，第二個短效窗口仍未交付整輪成果。不能靠新requestId再做已消耗發布。現有 `record_managed_exception` 需要有效且digest相符的政策；`finish_managed_cycle` 本身可讀到期輪次，但缺51筆時不會關閉。若要續完r2，須另確認「只補稽核、不再發布」的授權／契約；不能把延長舊政策或修改舊Task binding當修復。

## 同Run僅稽核續作：本地修補與離線驗證（2026-10-01）

使用者另行批准 `approve_main_only_audit_recovery_local`，**只限主層本地實作／離線驗證**；不是新live窗口、部署、grant啟用、模型訊息或子代理／reviewer授權。私有收據：`.local/evidence/semantic-audit-recovery-20261001/`。

- 新增部署端 `semanticAuditRecovery` 嚴格配置，綁定精確actor／既有Run／session／scope／原policy digest及原政策不允許的目標。只准 `POLICY_DENIED`；發布必須關閉、AUTO必須不存在。新grant最多30分鐘有效，沒有改舊policy、lease或歷史；沿用原生Aspect，未新增datastore或Task／Run。
- 保留原target slot／CAS／一次性attempt邊界；要求全部publication為初始持久成功且目前VERIFIED、pending為0，不能以新例外覆蓋UNKNOWN或NOT_DISPATCHED。每次append／response CAS的最後身分await後同步複核grant／期限，撤回或變更會拒絕；部分intent保留，不自動重試。
- 每筆新稽核Decision保存Host生成的grant／policy／scope摘要及期限，讀回核時間與舊policy綁定；撤回grant後仍能讀新舊歷史。完成條件及owner closure維持既有門檻，不用新grant延長lease。
- **最後相關離線回歸254／254 PASS**（semantic、Task records、publication、ingestion policy、gateway及server）；六個修改JS檔的fresh primary LSP無診斷。測試涵蓋76目標fixture從25筆既有Decision追加51筆並逐頁核對收尾、舊policy及lease都過期、禁止新發布／新cycle、錯誤actor／Run／session／scope、grant撤回／改變／到期、原值漂移、pending／UNKNOWN／NOT_DISPATCHED、重複target、讀回proof綁定／時間。這是fixture下的Host整合驗證，**不是新live成果或獨立review**。
- 保留 `regression-red.log`（測試取用Map錯當Array）及修正後的 `regression-red-corrected.log`（39 PASS／4 FAIL，證明既有過期API阻擋續作）；`regression-green-r1.log`仍失敗（測試誤用未接線的afterWrite hook），改成既有afterRecord後的正向／撤回測試通過。以補足76目標／51續作fixture後的 `related-regression-final-r2.log` 為最後結果，不把中間失敗稱PASS。
- 新reader可讀舊／新收據；已有新proof後，若恢復唯讀須保留這個reader，不能直接退回拒絕新增proof欄位的舊Host。詳見[設計契約](../design/datahub-semantic-agent-automanagement-proposal.md)。真入口／固定舊MFE對新proof的相容性尚未實測。

**限制：**本輪未碰實際r2 records、未重送發布、未開新模型訊息、未換image／MFE或重啟gateway。現場最後驗證仍為 **1 VERIFIED＋24例外、missing51、closed=false**；舊R4窄source gate不涵蓋此次新修補。DataHub只有per-Aspect CAS及各API觀測快照，沒有新增跨實體原子性承諾。

## 門檻與下一安全步驟

1. **維持唯讀；單欄發布已驗證，整輪 E2E 未完成。** 保留r2成功及24例外、r1空Run與舊永久UNKNOWN；不能把後兩者重置或抹去。
2. Task Pi仍未另准修復／派發；沒有新review或resume額度。本地修補已完成，但尚未部署；image／MFE未變。
3. 稽核續作方向及本地修補已獲批准；下一步仍需對新來源取得必要驗收與精確live授權，再於原session補51筆真實政策例外及finish。不能復用expired config／舊草稿；發布attempt永久消耗、目標已非空，不再發布、不另建Task／Run。
4. 全目標收據、closed輪次與相应UI／歷史仍待完成；廣義共用定義安全更新、三方更新與批次真人審核仍不在這次有限成功之內。不得因此執行SQL／ingestion、改ACL／Core、刪HOME或重啟其他專案。

舊輪次的本地前置測試原收據（當時來源）：後端 123／123、pi-web 43／43、MFE 5／5、tsc／ESLint／primary LSP 通過；21 檔新 source SHA 清單當時逐檔通過，本輪本地腳本 syntax 與 Core/index 清潔。全量 `git diff --check` 命中既有 `pi-web-downstream.patch` 的五處 WIP 尾端空白；排除此未在本輪改動的檔案後，scoped check 通過。這些只證明各自範圍，不代替上述真模型／發布 E2E。

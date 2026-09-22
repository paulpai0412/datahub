# DM02：分開的 publication review

## 最新結果：2026-09-21 真UI批准、條件發布與完整Agent讀回

**表級完整flow優先完成線已通過；Goal running、3/8，下一項為固定ETL人工核准執行。** 不是所有欄位、業務語義、安全邊界或全Goal完成。

- Task／review引用未發布Datasets造成原生URN存在性驗證拒絕。經明確批准，模型現為 **0.1.6**：Task與PublicationReview的datasets使用原生平面`UrnValidation = {"entityTypes":["dataset"],"exist":false}`。0.1.4巢狀寫法無效的失敗保留；0.1.5真Task建立、0.1.6真review／consent／publication存入成功。Host actor／source／scope／ACL／CAS仍檢查，Core未修改；官方loader熱載入，無服務重啟。
- 真pending Decision附上121-Aspect review後，使用者批准精確digest `99a2397702b6f3a32158fb669919edfa917acf89b0cead0079313aedfb95bfdc`。真MFE typed APPROVE成功，Run v4；同一native問題收到已存答案並terminal。首次操作攔截器錯把`requestId`當`decisionId`，在dispatch前403／零attempt；修正caller後僅一次真正consent，不重送已寫入答案。
- 既有Host重驗source／Catalog／privileges／target versions後，**一次Run admission、一次create-only條件批次**成功發布121 Aspects／17資產。全部值、native版本及版本化runId provenance讀回一致，`VERIFIED_CURRENT_VALUES`。25次Grafana／92次DataHub requests包含核對與這兩次寫入；沒有舊Job重寫、SQL或connector重播。
- 獨立native讀回：Flow、3 Jobs（9→4／6→1／3→0）、13既有Datasets、view五上游及17新Grafana資產。真同模型Agent共3回合20次MCP讀取、零工具錯誤；七組Chart直接上游與原生`chartInfo.inputs`逐值一致，完整回答列出URN／DataHub／Grafana連結及語義缺口。最終terminal，reload全訊息完全相同。
- 真UI驗Flow→3 Jobs、Job Lineage、Dashboard／Chart及Grafana Dashboard／panel落地。Grafana導覽批次擋下datasource執行，**未重跑SQL或聲稱panel數值驗證**。官方path查詢只回兩條，改用既有逐Chart一跳查詢補足七條，不改Core／MCP工具。舊WebSocket錯誤根因仍未證實，不把當前查詢成功冒稱舊根因已修復。

私有證據：`flow-model-016-deployment-run-retry2-20260921.json`、`flow-grafana-ui-consent-fixed-20260921.json`、`flow-grafana-publication-run-20260921.json`、`flow-complete-native-readback-20260921.json`、`flow-web-agent-acceptance-20260921.json`、`flow-web-agent-seven-edges-20260921.json`、`flow-grafana-links-live-20260921.json`。Reader續用同一帳號，最近token有效至2026-09-21 03:57:04 UTC，非永久續期。主agent自查，不稱獨立審查。

回顧：以現場契約解決annotation缺口；遇操作驗證器欄位／時序錯誤先保存及對帳，而不是重新播放成功操作。必要欄位lineage、公式／grain／as_of、UnitPrice影響與真固定ETL核准執行仍在後續完成條件。

## 前置結果：2026-09-21 Grafana可信準備與MCP更新

- 新增既有Host私有 `native-grafana-publication.mjs`：封存真產物bytes／binding，重新讀source與Catalog後編譯create-only review；不暴露model發布操作。官方FileSink原始格式是`aspect.json`；SDK `from_obj`會原地轉成`contentType/value`，已離線實測並修正fixture，不做猜測式解碼、不改PDL union／namespace。
- 67項Host／runtime／Grafana tests與3檔primary LSP通過。真source／Catalog／target預檢成功：20次Grafana、30次DataHub requests，121 Aspects／17資產、8 Dataset scope；僅有未批准draft，沒有新Task／Run／發布或connector重播。
- 原始format失敗、caller誤呼叫私有`publicationVersions`及token HTTP400收據保留。caller改讀既有public batchGet，不擴大Host API；400後只讀確認相同name僅token13，未見第二筆，duplicate-name原因仍是推論。獨立批次以不存在的新name建立600秒token14並完成預檢。
- 使用者另指示「自行更新mcp 憑證」：同一reader的一小時token通過公開SDK key／status／schema讀取，僅原子更新受保護Pi HOME的Authorization。有效至 **2026-09-21 02:53:46 UTC**；兩份history hash不變，無角色／工具／URL／映像改動、重啟或新prompt。初次caller在bootstrap交換完成前取native狀態而停止，零token／設定變更；依既有gateway契約等待root document後成功。原始通用錯誤不足以細分是未認證回應或navigation race。

私有證據：`flow-grafana-compiler-ready-20260921.json`、`flow-grafana-filesink-shape-diagnostic-20260921.json`、`flow-grafana-publication-preflight-run-retry3-20260921.json`、`flow-grafana-agent-reader-refresh-run-retry1-20260921.json`。本輪再次確認Core乾淨；lens all為21個已診斷檔，不是全專案security pass或獨立審查。

**Goal仍running、1/8。** 真typed consent／條件發布、完整WebUI／Agent graph仍待完成；SDK驗證不冒稱新Agent MCP E2E，短期token也不是永久續期修復。回顧：先以真wire格式與實際caller契約定位差異，再做有界對帳；不把成功擷取、失敗token request或不確定寫入重新播放。

## 前段結果：2026-09-20 真Task／限定發布與MFE載入

**兩個Job的核准值已寫入，但發布來源標記驗收未過；Grafana與全鏈驗收仍未完成。** 以下取代後方歷史段落中的「尚無可信caller／真Task／寫入／部署」狀態。

1. 真MFE建立Task／Run；模型成功呼叫`datahub_get_me`、`datahub_get_entities`讀Flow／Jobs，再於同一Run提出真`datahub_decision`。MCP未回傳Job I/O，不能解讀成原生I/O不存在。此為有限查詢成功，不是完整Discovery回答，也不證明舊WebSocket error的根因已修復。
2. `appendPublicationReview`沿用原Host私有接點，容許首次typed review附到同一個未回答的一般Decision；必須question／choices完全相同，且沒有既有response／review／attempt。fresh source／Catalog重編、scope、版本及CAS限制保留；沒有新browser/model action。56 Host、9相鄰tests、Chromium typed-review fixture通過。
3. 真Host準備了兩個Job各新增5 inputs的保留式review，Run v3；digest `efc78ac4d87f28a6d6cee906616b3db7ad399223a500ba99dfd98ce604b04c10`。使用者明確批准精確提案，並在發現已served MFE過舊後，另准改用既有authenticated typed API完成本批。真APPROVE寫入v4；同一native問題讀到已存答案後正常停止，無偽造pending／第二次answer／prompt replay。**不是UI點選核准E2E。**
4. 唯一Run CAS admission為v5，attempt `8632d9ec-d538-4e56-bb1b-67f20205ca39`；唯一target batch只寫兩個`dataJobInputOutput`，皆以`If-Version-Match:1`提交，HTTP200。後續独立唯讀對帳：dimensions v2／9→4、fact v2／6→1，兩份值與review完全一致；validate仍v1／3→0。已讀取的非I/O Aspects／第三個Job未改。
5. 原生`systemMetadata.runId`符合attempt，但`properties.dataflowDiscoveryRunUrn`與`dataflowDiscoveryDecisionId`未讀回。因此Host保留`publication_write_unconfirmed / publication_readback_mismatch`，不可把兩份值匹配改稱完整成功。尚未定位標記遺失於serialization、原生寫入或讀回的哪一層；閱讀固定版controller不足以證明現場支援／不支援。沒有重送、metadata補寫、回滾、刪掉ownership條件或新增替代儲存。新增相同值／runId但缺marker的回歸，驗對帳仍未完成且已消耗admission不能重播；**57 Host tests通過**。
6. 精確MFE檔案切換後，gateway仍供應啟動時的舊快取；沒有加hot-reload機制。使用者另外核准Run結束後的單次gateway／runtime重啟，已完成：HTTP `70.js`為核准SHA `09dc42d2c93da6b67c2160c5da5286eada310819bddfbd66897a6edf30140c11`，`remoteEntry.js`不變；原image、HOME、舊session及本次10-message session的hash全部相同。現行gateway PID2124417、runtime `80f469dbfe5dba0c45cbb2840e07d805fe645725427517fad018e35a00f7eefa`。真MFE重新讀到Run v5並開啟原Pi session；沒有新prompt／MCP查詢／token刷新。最初重啟驗證器誤把`running:false`視為未完成，已在SIGTERM前停止；唯讀診斷與實際GET route證明其代表RPC程序不存在或已退出，且history terminal、runningSessionIds空。修正前置檢查後才執行唯一重啟。

現行MCP測試token已於15:27:45 UTC到期；不能宣稱reader永久可用。上述交接時Goal為paused／1/8；其後使用者已恢復，仍執行task2。Grafana保留121-Aspect／17資產產物，不重新擷取或無條件emit。

### 續行診斷：已確認 properties 的建立／更新差異

沿既有測試授權，只建立一個`allowDecisions:false`的診斷Task，不建立Run或呼叫模型／SQL。一次建立（v1）與一次不同內容的條件更新（v2）均保存request／ACK／native readback：建立時三個自訂properties全部保留；更新ACK顯示`probePhase:update`，真正讀回仍是`probePhase:create`，而runId及Task內容已更新。原helper混用Playwright與native Fetch，呼叫`Response.ok()`而非讀取`.ok`，在成功建立後停止；離線確認此TypeError後，續行只讀同一v1 Task並執行原已規劃的更新，沒有重建或重送。

固定Core `v1.7.0.1`／commit `e99431ec…` 的`EntityServiceImpl.applyUpsert`（386–477）吻合：更新分支取既有systemMetadata，只複製runId／lastObserved／schema／audit／version，未複製incoming properties；ACK使用的change MCP仍持有新properties。**根因是Host把自訂properties當成可隨更新改寫的provenance；不是CAS沒執行，也不是所有自訂properties都不支援。** Core保持不動。

**2026-09-21：使用者已核准並完成最小Adapter修正與有界驗證。** 原生runId保存版本化canonical JSON `[Run URN, Decision ID, attempt ID]`，只作定位；仍讀權威record驗actor／scope／purpose／consent／精確值與admission。完整舊locator可讀，新寫入不再新增易失效的properties定位；不略過no-op、expiry或CAS。65項Host／runtime／Grafana fixture測試通過，fixture已模擬Core更新保留舊properties，並驗新locator更新、舊完整locator轉換、偽造／漂移／重播拒絕。

- 原診斷Task只新增一次有版本條件的v2→v3更新；含JSON定位的新runId完整讀回，舊properties仍保留。這是原生字串更新相容性證据，合成定位不是Run／人審，不算業務發布。
- 兩個既有Job已透過既有Host只讀對帳，得到`MATCHED_KNOWN_LEGACY_ATTEMPT`：精確值、已批准Decision／admission、下一個native版本及modification actor／time均吻合，Run仍v5、Jobs仍v2。`retryAllowed:false`、`legacyTargetsRequireOwnershipReview:true`；不授予未來寫入ownership、不改原始unconfirmed收據。
- 沒有重寫Job／Run、重播擷取、刷新token或重啟服務。任何新發布仍須fresh typed review；Grafana仍未發布，完整WebUI／Agent閉環未驗收。

證據：`flow-native-runid-adapter-ready-20260921.json`、`flow-native-runid-adapter-verified-20260921.log`、`flow-native-runid-storage-probe-run-20260920.json`、`flow-canary-runid-adapter-reconciliation-run-20260920.json`。主agent自查，不是獨立審查；Core未修改。

證據：`flow-systemmetadata-causal-finding-20260920.json`、`flow-systemmetadata-probe-run-20260920.json`、`flow-systemmetadata-probe-update-run-20260920.json`。診斷Task及其版本保留。續行時Host／test兩檔與舊pin不同，未推測作者或重設；核對現行關鍵路徑、保存snapshot且57 tests通過（`flow-provenance-current-source-20260920.log`）。

本段私有證據（`.local/evidence/dataflow-discovery/`）：

- `flow-canary-prepare-review-run-20260920.json`、`flow-canary-prepared-review-20260920.json`。
- `flow-canary-api-consent-run-20260920.json`、`flow-canary-consent-replay-readback-20260920.json`（後者才是native terminal證據）。
- `flow-canary-publication-run-20260920.json`（保留原未確認結果）、`flow-canary-publication-reconciliation-run-20260920.json`、`flow-canary-publication-{before,reconciled-values}-20260920.json`。
- `flow-mfe-post-terminal-restart-run-20260920.json`（零stop的前置失敗）、`flow-mfe-restart-precondition-readback-20260920.json`、`flow-mfe-post-terminal-restart-run-retry1-20260920.json`（成功）。
- `flow-publication-missing-marker-regression-20260920.log`、`flow-integration-checkpoint-20260920.json`。

回顧：真接點驗證揭露mock未證實的provenance相容性，而條件寫入與一次admission已發揮作用；應保留部分成功並查清契約，不把ACK／精確值／更多fixture当全鏈成功。primary LSP無錯，lens all限本session已診斷檔；不是獨立審查或全專案security掃描。Core保持乾淨。

## 歷史：2026-09-15 本地實作

**結果：核准範圍內的模型／Host／人工對話框演進已完成離線驗證；不是安全發布或 DM02 完成。**
使用者已批准在既有模型及 Host 內分開技術 lineage／semantic 核准，綁定來源、候選、實際 Aspects／版本與期限；保留一般問答。沒有新 Entity、服務、datastore、解析框架或 Core patch。部署、憑證及真 metadata 寫入仍需另批。

## 已實作的契約

- 模型 `0.1.2` 在既有 Decision 增加可選 `publicationReview`，在既有 response 增加可選 `publicationVerdict`；仍與 Run closure／歷史共用 `ekopAgentRun` CAS。舊 question／RESPOND／DISMISS 沒有這些欄位，不會變成批准。
- Proposal 包含 LINEAGE 或 SEMANTIC、native Source、Discovery source ID、snapshot／candidate hashes、analysis version、精確候選 IDs／Dataset scope、expiry，以及每項 `urn/aspect/expectedVersion/valueJson`。`valueJson` 是可供人類檢視的 canonical JSON，不只是不可解讀的 hash。
- Host `publication-review.mjs` 對完整 proposal 計算摘要；來源、順序、實際值、版本、目的及期限都受綁定。另拒重複 Aspect、非 canonical JSON、越 Dataset scope 的目標／Dataset 或 schemaField URN 引用，以及把 tags／terms 等語义欄位藏在 LINEAGE payload。這不代替官方 Model、SQL／Catalog binder 或完整來源解析。
- `appendPublicationReview()` **僅供可信 Host 編譯器內部呼叫**。沒有接受 model/browser 自填 proposal 的 JSON action；現有 `appendDecision` 仍拒額外欄位。編譯器須先驗來源、完整候選與實際 mutation；本輪尚未接入該真來源 caller。
- `respond_publication_review` 經既有 authenticated Host 和 exact pending native UI request，綁 Run／Task 最新版本、owner、session、source scope。目的取自儲存中的 proposal，客戶端只回 verdict／plan digest。一般 `RESPOND` 不能回答 publication review；`DISMISS` 仍可結束 Task，不能成為批准。
- 人類對話框顯示目的、來源摘要、期限與實際 Aspect 值／版本；分開 Approve／Reject，初始焦點在 Reject；所有外部文字使用 textContent，不執行內容。回傳給 Pi 的只是已記錄結果，不是寫入能力。
- `requirePublicationConsent()` 重新讀取權威 Run／Task，拒一般回覆、其他目的、修改後提案、錯 actor、過期、未來時間、已關閉／舊版本與不符 scope。回傳 reference 不是可攜式授權 token，亦未消耗核准或執行發布。
- 找到並修正一個實際時間窗口：最終 `/me` 認證等待期間可能超過 proposal expiry。提交 owning boundary 現在於認證返回後、寫入前重驗；回歸先出現 `Missing expected rejection`，修正後確認 0 response writes。網路中的跨系統時間仍非原子交易，發布時必須再次檢查有效性。

## 與 draft publisher 的關係

Python logical preparation format 改為 `dataflow-discovery.publication-plan/3`；可先用 `approval=None` 準備／往返／預覽，不必編造人類 actor 或核准時間。摘要不包含尚未發生的回覆 actor／timestamps，稍後附上回覆不會使摘要自行變動；無批准的計畫在 draft emit 前即拒，source revision／內容變動仍拒，舊 `/1`、`/2` 不默默升格。

**此摘要不是 Host 實際 MCP／Aspect proposal 的摘要。** `PublicationApproval` 仍是 caller claim，`publisher.py` 仍是 **UNACCEPTED DRAFT**，未接 Host 或 live Agent。不能把新的 consent helper 加到舊 SDK emit 路徑旁就宣稱安全發布。

## 驗證與範圍

| 檢查 | 結果／限制 |
| --- | --- |
| Host／Task runtime | 33 tests PASS；含一般問答相容、typed consent、來源／field URN scope、actor/time、過期、關閉／版本、相同 pending request、CAS/history／unknown 不重送 |
| Python draft publisher | 22 tests PASS；新增稍後回覆不改 preparation digest、source revision 改動拒絕；mock emit 不是發布證據 |
| 真 Chromium、本地 synthetic Host/Pi fixture | lineage approve／semantic reject，精確值與摘要、HTML 字串不執行、Reject focus、390px controls；舊問答／重播／dismiss／歷史通過。不是 live DataHub、模型或行動裝置驗收 |
| 官方模型生成／roundtrip | 固定 Core jars、Pegasus 29.74.2、Gradle 8.14.3／Java 21；network none、1 CPU／3 GiB、無 credentials／Docker socket mount；舊資料、typed review/verdict、非法 purpose／缺欄位通過 |
| 產物 | `ekop-agent-tasks-0.1.2.zip`，SHA `fee95d8e43c3c321e82e543cc3c2e4bee5b459c25e10ee5df727bdda20a773a5`；registry＋兩個本插件 jars、44 class entries，無 Core classes |
| 診斷 | scoped primary LSP 其餘已查檔無錯；native-tasks 的 inferred-parser `1128` 含 past-EOF 舊訊息，現行 bytes 通過 Node syntax check 與上述 33 tests，當次 defer。不冒稱全專案 lint/security clean |

首次 isolated workspace 未複製 Maven checksum metadata，只核了固定 Core jars；發現後補入既有 `gradle/verification-metadata.xml`，用 `--offline --dependency-verification strict --rerun-tasks` 重建及重跑 modelCheck。最終 ZIP hash 相同。保留兩份 logs，不以首次建置冒稱完整依賴驗證。Java 8 bytecode obsolete／原生 ANTLR／Gradle deprecation 警告未靠換版消除。

可重跑：

```sh
node --test tests/test_agent_task_records.mjs tests/test_agent_task_runtime.mjs
PYTHONPATH=extensions/dataflow-discovery/src DATAHUB_TELEMETRY_ENABLED=false \
  .venv/bin/python -m unittest -v tests/test_dataflow_discovery_publisher.py
DATAHUB_TEST_CHROMIUM=/path/to/existing/chrome node tests/check_agent_task_browser.mjs
```

私人證據 `.local/evidence/dataflow-discovery/`：
`publication-review-host-tests-20260915.log`、`publication-review-expiry-red-20260915.log`、
`publication-plan-v3-final-tests-20260915.log`（另保留初版 log）、`publication-review-browser-20260915.log`、`publication-review-ui-20260915.png`、
`publication-model-012-build-20260915.log`、`publication-model-012-build-verified-deps-20260915.log`、
`publication-model-012-artifact-20260915.json`、`model-012-workspace/`。

## 後續收斂：初始 MCP 準備與原生目標版本（本地）

- 既有 `publisher.py` 增加 `compile_publication_mcps()`，重捕 Host 指定的 source、重驗候選／snapshot／revision，透過固定 SDK 1.7.0.9 的公開 setter／`as_mcps()` 產生完整**初始 desired Aspects**，無 client／emit。包含 SDK 產生的 editable properties、Job I/O、Chart inputs 與 Dashboard chartEdges；reference-only Entity 不產生 Aspects，不支援的關係／欄位編譯拒絕整批。這不是既有 metadata 的安全替換／合併，亦非完整 purpose-separated 最終 mutation compiler。
- 官方 SDK 的 DataJob `set_inlets/set_outlets` 實際追加 legacy Dataset arrays，不能反覆傳入累積清單；現在每個方向彙整、去重後只呼叫一次。Dashboard 公開 `add_chart` 使用 `chartEdges`，不是 legacy `charts`。保留最初測試錯把這些欄位當另一形式的 failure logs，沒有修改 SDK。
- 真 snapshot/analyzer＋官方 SDK MCP serialization 已在測試接到現有 Node Host `makePublicationReview()`，由 Host canonical JSON 計算實際 Aspect proposal digest；不是使用 Python logical digest 代替。此為合成 SQL/BI source、無批准的本地接縫測試，**不是九檔真案例或已部署 compiler caller**。
- `task-records.mjs` 在保存 review、接受 APPROVE、讀取有效 consent 時，使用相同 authenticated public `batchGet?systemMetadata=true` 重新核對目標原生 Aspect 版本，按 Entity 類型合併請求。缺失才對應 `-1`，拒錯 URN／重複 row／畸形 envelope／版本衝突；REJECT 不要求目標仍維持舊版本。consent 在讀取後再驗 expiry。
- 回歸先重現目標版本已變仍接受 APPROVE（`Missing expected rejection`），修正後 0 response writes；另驗批准後漂移、假稱不存在、讀取中過期、拒絕讀取／畸形回覆不重試，以及漂移後仍能記錄 REJECT。原生 controller 原始碼與既有 recorded receipt 的 78 個 string versions 支持讀取格式；本輪沒有 live GMS 查詢。
- 最終 **36 Host/runtime tests、25 publisher tests PASS**；四個受影響檔案 primary LSP 無診斷，Node syntax checks 通過。模型/UI 行為未改，沿用前段 build／Chromium receipts，不重建或重跑未受影響驗證。`lens_diagnostics(all)` 仍列出先前已對帳之其他檔案 import／stale parser 等90項 cached blocking，不能宣稱全案 clean；本次四檔 primary LSP 為0，限定 changed paths 的 cache 無 findings（只涵蓋其中已 dispatch 的3檔）。

證據：`publication-target-drift-red-20260915.log`、`publication-target-version-verified-20260915.log`、`publication-native-compile-verified-20260915.log`；初版／失敗 logs 保留於同一 private evidence 目錄。

**限制不變**：重新讀取不是跨 Aspect 交易；目標仍可能在讀取後改變，實際提交必須有逐 Aspect CAS。此處不授予寫入 ACL、不消耗批准、不保護既有人工 metadata 的合併，也未開放模型傳入 MCP。SDK 初始全值不能直接送到既有 canary entities。0 對外 metadata writes／SQL／credential reads／模型推論／部署；不重播任何既有批准操作。

## 後續收斂：Run CAS 一次 admission（本地／未部署）

模型 `0.1.3` 僅在既有 Decision 加入可選 `publicationAttempt`：兩個欄位為 Host 生成的 UUID 與 `claimedAt`。來源、目的、提案摘要、核准人仍取同一 Decision 的既有 review／response，不建立第二份權威、服務或 datastore。舊 `0.1.1`／`0.1.2` records 沒有 marker 仍可讀，但缺少 typed APPROVE 不能取得 admission。

Host 私有 `claimPublicationConsent()` 沿用同一組 current Run／Task、owner／session／scope、typed consent、expiry 與目標版本檢查，再以 Run CAS 保存 marker。只有成功 ACK＋該 ACK 版本精確讀回才返回 admission reference；同一 Decision 有 marker 後，連持有最新 Run version 或重建 Host 的 caller 也不能重新取得 consent／claim。一般問答與其他 Decision 的獨立 LINEAGE／SEMANTIC 審核不受阻，關閉 Run 保留 marker 與原人類回覆。沒有新增 browser/model JSON action。

不確定寫入保留 `urn/expectedVersion/decisionId/attemptId/planDigest` 對帳 reference，無自動重試。測試分別驗 **已提交但 ACK 遺失** 與 **沒有提交的傳輸失敗**；不能把 UNKNOWN 假稱一定已提交。若 marker 未見，也不能由單次讀取自動推定可重送；caller 必須先對帳原 attempt。marker 是 admission，不是 target request／成功收據、lease 或可攜式執行能力；將來 target writer 仍須驗 fresh ACL、Run closure、expiry、source 與逐 Aspect CAS。這也不是能防止任意特權 DataHub 客戶端改寫 Aspect 的不可篡改鎖。

- **41 Host/runtime tests PASS**：含競爭、最新版本再請求、Host 重建、失 ACK 的兩種狀態、過期／scope／identity／target drift、分開目的與後續問答。
- 三個受影響程式檔 primary LSP 無診斷、Node syntax 通過。Python/compiler/UI 本輪未改，不重跑舊檢查。
- 固定工具鏈／Core jars，network none、1 CPU／3 GiB、無 credentials／Docker socket 的新 isolated workspace，Gradle `--offline --dependency-verification strict` build／modelCheck 通過。新 record roundtrip、legacy 無 marker、closing 保留 response、缺少 attempt ID／虛構 targetPublished 欄位拒絕；不代替 Host ACL/CAS 語義檢查。
- `ekop-agent-tasks-0.1.3.zip` SHA `5fc8d52c95d61b700ef5169dc6941c629370ac89c21caf41bfd24f484def2275`，兩個 plugin jars／49 class entries，沒有 Core classes／test jar。舊產物保留，原生 ANTLR／Java bytecode／Gradle deprecation 警告未靠換版消除。

證據：private `publication-admission-verified-20260915.log`、`publication-admission-model-013-build-20260915.log`、`publication-admission-model-013-artifact-20260915.json`、`model-013-workspace/`。0 對外 metadata writes／SQL／credential reads／模型推論／部署；没有重播 canary。此段只完成 admission 的本地契約，沒有啟用 draft publisher。

## 後續收斂：Host 條件發布與對帳（本地，未接真來源 caller）

既有 `task-records.mjs` 加入私有 `publishPublication()`／`reconcilePublication()`，不新增模型、Entity、服務或 datastore，也沒有新增 browser/model action。Python 的舊 SDK writer 仍是未啟用的 draft，不能繞過此 Host 邊界。

- Host 必須配置**真正重新捕獲來源、驗候選及重編最終 MCP proposal** 的 `recompilePublication` 函式；缺少即拒絕。在 admission 前及 target write 前再次重編並驗完整摘要／expiry。函式只能由 Host 程式提供，不能從 JSON 或模型輸入取得；**echo 輸入的測試 callback 不是可信來源驗證，也尚未接到九檔實際案例**。
- 使用原生 `getGrantedPrivileges` 重驗精確 Dataset／target URN 的讀寫權限，保留 Task／Run owner、session、scope／closure、typed consent 及 expiry 檢查。取得同一 Run CAS 的唯一 admission 後，只發出一個 bounded native batch，每個 Aspect 帶原生 `If-Version-Match`。
- 以公開 `SystemMetadata.runId` 保存 Host attempt ID，properties 僅加入 Run／Decision 定位並保留原 properties。固定 Core 的公開 v3 controller 確實解析 request 的 `systemMetadata` 與 headers；這是 source/API 契約檢視，**不是本轮 live compatibility 測試**。
- 更新既有 Aspect 前，必須從 native provenance 讀回先前 Run，核 actor／source／sourceId／purpose、typed review／admission、被核准的精確 Aspect 值及版本前進；只信任標籤或 runId 不足。既有值與前次核准值不同即 `publication_manual_metadata_conflict`；未納管者拒絕，不自動收編。完全相同值要求 compiler 移除 no-op，不重送來改寫 provenance。此處是保守的**整個 Aspect 保護**，不是通用 field merge；同 Aspect 的人工編輯會停止整筆更新。
- 成功必須 ACK 版本前進、重新讀回的版本等於 ACK，且實際值及 native provenance 全部一致；回傳的是 `VERIFIED_CURRENT_VALUES`，不是跨 Aspect 交易或 runtime lineage 證明。部分提交、412、錯誤 ACK／讀回不符均保持 unconfirmed，不自動 rollback 或 retry。
- `reconcilePublication()` 只回 `MATCHED/ABSENT/DIFFERENT`、版本及值摘要，不回敏感原文；可檢視已關閉／過期 Run 的既有 attempt。缺失不代表未送出，回覆固定 `retryAllowed:false`，不恢復 admission。

**49 Host/runtime tests PASS**：新增初次寫入、同來源已納管更新、未納管／人工修改拒绝、provenance 不符／no-op、不完整批次對帳、CAS race 保留競爭值、source／ACL 在 admission 後失效、ACK 後有人修改時不報成功，以及沒有 JSON publisher action。GMS 與來源 compiler 都是 fixture；不得當作真 metadata 寫入或實際來源驗收。模型／Python／UI 本輪未改，不重建已驗產物。

Node syntax 與目前 bytes 的 TypeScript parser 均通過；fallback LSP 仍回報包含 beyond-EOF 的解析訊息，以現行 parser／執行檢查對帳，不改程式迎合旧快取，也不宣稱全案 diagnostics clean。private `publication-conditional-*-20260915.*` 保存各階段 logs 與 parser hashes。

**既有 canary 沒有此 Run provenance，不能自行採納或覆寫。** 若實際閉環需要改動它們，須先提出精確範圍與處理方式。尚未配置真 compiler／Agent caller、未部署，0 對外 metadata writes／SQL／credential reads／模型推論／canary replay。

## 後續收斂：實際來源 → SDK → Host 重編接縫（未部署）

`native-discovery.mjs` 的 `compileDiscoveryPublication()` 經既有固定 `python -I -B bridge.py`，呼叫既有 `compile_publication_mcps()`，重新 capture／analysis／candidate binding，再由固定官方 SDK 產生初始 Aspects。沿用單次 stdin/stdout、CPU／memory／timeout／輸出限制，新增固定 `HOME=/dev/null`，不傳 cookie／token，不匯入或執行捕獲來源。Python logical approval 必須為 null；不是模型可用的新 action。

`discoveryPublicationCompiler(policy, plan, source)` 可作為既有 Host `recompilePublication` callback：按值保留 **Host 已解析身分的 logical plan**，不能從待審 JSON 倒推它。每次重編後核 source／candidate／Dataset scope，以及每一個選定 Aspect 的實際值，再重建 review 摘要；重新算過 digest 的偽造值仍被拒絕。只支援 LINEAGE；未選取的初始 SDK Aspects 不寫入，也不宣稱整份 plan 完成。這不是 fresh Catalog 身分核驗或 metadata DLP 的替代品，仍需真正 Host preparation／入口負責。

- **57 Node tests PASS（50 Host/runtime＋7 Discovery）**：實際隔離 Python／SDK 編譯接上 Host publisher，GMS 是 fixture；取得 admission 後改來源，下一次真 capture 阻止 target request、保留 marker。另驗有效摘要的偽造值、plan caller mutation、false／1／字串 true、模型 compile action 拒絕。既有 readonly Discovery 入口仍通過。
- **25 Python publisher tests PASS**；Python publisher 模組本輪未改，新 bridge 使用其既有 compiler，不使用 SDK draft writer。
- 九檔真案例以原 snapshot／candidateDigest 重編 **5 個候選、15 個初始 Aspects**；選取 1 Flow＋3 Job 的 **4 個 Info Aspects**，透過真 callback 重現 review digest。沒有 I/O／欄位或 SEMANTIC 的新成功證明；reference Dataset 不產生 Aspect。
- 首次案例輸入沿用了 canary 的 `discovery.*`，被既有 `dataflow.discovery.*` namespace 規則拒絕；沒有放寬規則。使用現有合法 namespace 後，與歷史 native canary 比較，四個 Info 的其他內容相同，但 customProperties 有明確 namespace 差異。**不是相同值或自動遷移／採納授權**，沒有向 target 送出任何請求。

證據：private `publication-source-compiler-{verified,python}-20260915.log`、`publication-source-compiler-case-20260915.json` 及案例準備／比較程式（輸出採 exclusive create，不覆寫歷史）。案例使用歷史 Catalog 身分／native 版本，不是 fresh readback；這一段的歷史版本不得直接作發布 baseline；後續經另外核准的唯讀檢視見下一節，仍不能逕行部署或寫入。既有模型0.1.3與UI未改，Core未改；0 live metadata writes／SQL／模型推論／canary replay。

## 使用者另准的一次 fresh native 唯讀檢視（已耗用）

使用者明確核准提案 SHA `3e16dcb039ed2d49a870699c072357447de08c11390b3214c9a6ea4ada924ffa`：只讀既存 operator 憑證／登入 localhost:9002、13 個 Dataset 與 canary 19 個 Aspects／精確資產權限。執行前固定程式與輸入 SHA、期限並 exclusive 建立 receipt；沒有重播舊 canary 或 probe，沒有 metadata mutation endpoint。

- **1 次 credential read／1 次登入**，原生 actor 為 `urn:li:corpuser:datahub`；18 個精確資產的 read grants 及前後 `/me` 核對通過。未輸出或保存 cookie／password，未改 `user.props` permissions。
- 讀回 **18 個資產／13 個 Dataset**。既有 `CatalogReader`／`resolve_dataset()` 對同份新 receipt 再做 key／status／schema 綁定，得到來源 **88 fields**、target **61 fields**；非第二次網路讀取，亦不等於重新驗過來源 DB runtime connection 或即時 DB schema。
- 19 個 canary Aspect 值與之前的 native receipt 全部相同。新 source compiler 的15個初始Aspects對現況：**11 NOOP、4 EXISTING_DIFFERENT_NOT_ADOPTED、0 ABSENT**。四個差異仍是 Info 的 property namespace；沒有應為了讓測試通過而提交的缺失 Info。canary 保持原樣，不把 namespace 差異當成採納或遷移授權。
- 對帳為各次讀取的觀測，不是原子 snapshot；**metadata writes／SQL／ingestion／deployment／模型推論皆0**。這次批准已耗用，不重播登入／讀取，不將其延伸成寫入批准。

證據：private `publication-fresh-read-{proposal,approval,run,validated}-20260915.json` 及 `publication-fresh-read-20260915.mjs`。目前已取得可檢視的新 baseline，但生產 Host preparation 的 fresh ACL／身分接線、最終可發布業務差異、人工審核與部署驗收仍未完成。

## Grafana 原生技術批次 → 現有 review 接縫（本地）

對目前官方 connector／`GrafanaSchemaTransformer` 的完整 file-sink 產物核對後，預設共有137個Aspects：120個結構Aspects，另15個globalTags與2個tagKey。不能將整批塞進LINEAGE review，也不提高既有128項限制。

固定SDK的 `GrafanaSourceConfig` 已提供 `ingest_tags:false`；本次直接驗這個原生選項，並維持 `ingest_owners:false`。**不新增通用分批器或第二個compiler**。一度加入的Host分批helper已撤回；`publication-grafana-partition-first-20260915.log`只保留探索歷史，不是最終source的驗證證據。

新增 `tests/test_agent_publication_grafana.mjs`，只為測試 fixture 增加 `ingest_tags`參數：

- 真官方Pipeline／SQL parser／既有Transformer／file sink → 現有 `makePublicationReview`，完整120 Aspects可進LINEAGE preparation，沒有應用端刪欄位或事後丟棄Aspects。
- 17個結構entities＝7 query Datasets＋7 Charts＋1 Dashboard＋2 Containers；scope為7 query Datasets＋1既有reporting view。7份schema／7份Chart inputFields各共14欄，7份upstreamLineage及Dashboard七Charts保留。
- 預設含tags的137項因count被拒；單獨17個tag Aspects仍因purpose被LINEAGE拒絕，證明不是只靠size gate。SEMANTIC僅可另行準備，未批准／發布；過期與越Dataset scope負例通過。
- **52 Node tests PASS**（新增2項＋既有50 Host/runtime）；**17 Python tests＝16 PASS＋1已知原生connector expected failure**。logs為private `publication-grafana-native-final-20260915.log`／`publication-grafana-native-python-20260915.log`。
- Node primary LSP clean；Python五個SDK missing-import auxiliary診斷由同一`.venv`全部真import及17項tests反證並標false-positive，未安裝能力或更改正確imports。empty/scoped cache不代表全案clean。

這仍是**HTTP fixture＋synthetic Host source/candidate/expectedVersion**的接縫驗證。`grafana.invalid`生成的Container IDs／URLs不是live identities，`-1`不是已證實目標不存在；120項也不是已解析完畢的安全mutation diff。沒有使用這些值寫metadata，沒有讀取任何憑證或連live Grafana/DataHub。真正caller仍須fresh來源、Catalog／ACL、版本、分類、owned-aspect及獨立目的核准。

下一個具体阻擋是**真Grafana metadata reader**：固定connector要求service_account_token；目前未授權建立專用帳號／token，不能把admin cookie改包裝成connector token，也不能以dashboard_pattern當ACL。已準備一次限org1／本folder/dashboard的operator唯讀preflight：`grafana-reader-preflight-proposal-20260915.json`。只查身分、版本、權限能力、精確ACL與擬用帳號名碰撞；不改ACL／建立token、不查SQL、不呼叫DataHub。待明確批准才讀`.local/grafana-operator.json`並登入。先核對實際權限能力，再提出最小reader provisioning，不自行升全域Viewer。

## 2026-09-19 隔離候選：Python Job 的 direct SQL I/O 編譯接縫

**本地候選，尚未套用或部署；沒有新增對外關係。** 為避免改動 C 批保留的 Host 所讀取的 repo 模組，修改位於 `.local/work/dataflow-job-io-20260919/`；原 repo 的25個基線檔逐一hash核對未變。只改既有 `publisher.py` 與既有 publisher test，沒有新增 production module、parser、服務或 writer。

已重現：合法的 SQL execution → Python function Job 仍被 `lineage_candidate_binding_mismatch` 拒絕，因原 binder 只接受 SQL process 的原端點。候選修正在既有 binder 重用 `python_sql.analyze_sql_execution`，要求 Flow 是來源中的明確入口、Job 屬於此 Flow、SQL literal 與 connection acquisition 已綁定，且 invocation path 實際進入所選 Job。保留原SQL候選ID，不篡改 analysis；不是把一般 calls 邊當lineage。巢狀已選 Job 的 SQL 只歸最內層所選 Job，同一行多literal不混用，未知連線／shadowing／未呼叫Job／錯Flow仍拒絕。

- **36 tests PASS**：既有25＋11項Job歸屬／變動／負例；兩個修改檔primary LSP為0。Scoped Lens cache無資料，不算額外掃描通過。
- 正確支援語法下的原版本先有3個正向案例失敗；候選恢復成功。最初fixture錯用既有tracer未支援的string-URL factory，改用現有測試與真ETL所用的 `URL.create` factory，保留原形式拒絕負例，沒有擴parser來迎合fixture。另修正測試對空Job會產生空I/O Aspect、PROD URN可省略env的錯誤假設；各失敗log保留。
- 真 `etl.py` bytes（SHA `ecb353edc18241e7c8ae19e9b7bea2d42168842e7e8f1f35cfcd1f7445e8b70e`）只作AST輸入，**未import或執行ETL**。單檔放入temporary snapshot，不冒稱原九檔live snapshot；引用URN在測試指定，不是fresh Catalog驗證。
- 從實際trace分組後，官方SDK編譯出的3 Job／6 reference Datasets／13 direct I/O與獨立預期吻合：dimensions讀4寫4、fact讀1寫1、validate讀3寫0。沒有把entrypoint早先extract讀的全部來源表自動掛到所有Job，也沒有產生Dataset寫入Aspects。

**這13條是既有 canary direct I/O 的可重現編譯接線，不是使用者缺少的跨來源關係已補齊。** 下一段仍要在既有模組以record／lookup的實際producer-consumer證據連入AdventureWorks inputs與dimension key maps，並處理Host的fresh Catalog／entrypoint／scope／最終mutation diff及正式caller。不能因這個候選通過就重播canary、啟用draft writer或宣告整張lineage圖完成。

證據：private `job-io-local-candidate-20260919.json`、同名 `.patch`、`job-io-publisher-corrected-red-20260919.log`、`job-io-publisher-final-20260919.log`。重跑命令（使用既有venv，不安裝套件）：

```sh
PYTHONPATH=.local/work/dataflow-job-io-20260919/extensions/dataflow-discovery/src \
DATAHUB_TELEMETRY_ENABLED=false .venv/bin/python -B -m unittest discover \
  -s .local/work/dataflow-job-io-20260919/tests -p test_dataflow_discovery_publisher.py -v
```

本輪credential／HTTP／模型／SQL／metadata／service操作皆0；自查不是獨審。Goal仍10/18，`discovery-validator`未完成，C之後沒有新的live健康觀測。

## 2026-09-19 通用資料傳遞候選（接續，未套用）

依使用者再次確認，交付物是**通用 DataFlow Discovery**，不是 AdventureWorks 特製分析器。來源連線／授權範圍可設定，關係答案不可預填；人工預期只作測試 golden，不進入 production 推導。

本輪用獨立的雙來源 telemetry router 驗證，不沿用本案的 dimensions／fact／Bundle 寫法。先重現單純 `return values`、keyword-only forwarding、直接 `return Envelope(values)` 漏失資料傳遞，再於既有 expression graph／consumer 修正：

- 單一明確 return 交給既有 expression resolver；保留原 invocation，避免展開 decoder 後丟掉 producer 身分。改傳第二個來源只改變對應 origin，不把兩個來源全部掛入；丟棄集合不繼承輸入來源。
- 參數／callee 求值與 return declaration 分開。`constant(row["x"])` 讀了 x，不表示回傳值來自 x；lookup 也保留 consumer role，不把只被求值的 lookup 當成 slot value lineage。key/value expression 的讀取仍可描述，但每筆保留 read_role，並非值影響證明。
- 多個 return 不猜分支；generator 的 return 不當作呼叫回傳的集合；條件 return 保留 guard。副作用、成功路徑、runtime 值及 publication flags 未提升。
- 擴充通用 return 後，實際案例曾膨脹到6413個 transport nodes。原因是同一 source invocation 因每個 SQL-use index 重建 frame，既有 memo 無法重用。改以 invocation path＋bound parameter refs 識別 frame，**重用原有 memo，沒有新增快取層／服務**。20次同一傳遞的 SQL 使用不再重複展開，變更參數、不同來源及中途 mutation 仍區分。

最後 **164項本地測試通過**。既有ETL bytes＋歷史Catalog回放仍為19 contexts／56 slots／49 linked slots／8 lookup declarations；transport降為874 nodes（原production為1423），共享前後每slot的origin／role投影逐一相同。這些仍是 `INCONCLUSIVE` 宣告，**不是已發布的跨來源關係**，也不是新鮮Catalog或任意Python皆支援的證據。

修改仍全在 `.local/work/dataflow-job-io-20260919/`，main的37個source/test基線檔未變。改動production檔的primary LSP無錯；test LSP仍有import-path問題，實際8項隔離module import與測試成功。全域Lens仍7項cached missing-import errors，不能宣稱全綠。未重驗此候選的Host pager／resource-limit相容性，未做獨審或任何live操作。

此階段候選：private `generic-transfer-shared-invocation-20260919.json`／`.patch`；raw test log：`generic-transfer-reuse-final-20260919.log`；回放：`generic-record-transfer-reuse-case-20260919.json`。已由下段178-test工作候選接續；先前候選／回放均保留為歷史，不代表目前stage或已驗收。

### 開發環境診斷對帳

同輪另新增 root `pyrightconfig.json`，明確使用既有 `.venv` 及兩個 first-party Python source paths；沒有安裝套件、關閉診斷或修改測試匯入。SDK `1.7.0.9` 的五個被報錯模組皆從 `.venv` 實際成功匯入。用 pi-lens 已安裝的 Pyright `1.1.414` 執行 `--project pyrightconfig.json --outputjson tests/test_sales_datamart_grafana.py tests/test_dataflow_discovery_python_decoders.py`，兩檔0 errors／0 warnings；原始結果為 private `pyright-project-imports-20260919.json`。原生 `lsp_diagnostics` 仍返回七項missing-import，和CLI不一致。七項已依實際訊息／rule／tool標記false-positive，工具回覆已記錄，但隨後 `lens_diagnostics(all)` 仍顯示7項。保留此工具對帳缺口，不重複標記、不重寫正確程式或修改工具來清空訊息，不宣稱Lens全綠。

下一段仍優先接**通用、source-bound的表級resource傳遞 → candidate／validator／publisher**。不得要求所有純量轉換都驗證後才處理能獨立證明的table I/O，也不得把本輪未驗副作用的宣告直接升格為可發布證據。Goal維持10/18，線上圖未因此改變。

## 2026-09-19 表級 resource binding 工作候選（未套用／未驗收）

在同一隔離stage，既有 publisher 新增可選的可信 Python context／Catalog reader，從當前 source bytes 重算 record／lookup resource bindings；不接收外部宣稱的 graph，也不新增 parser、服務或 writer。獨立 fixture 已經官方 SDK 編譯出來源 Dataset → 消費 records／lookup 的 Job → 目標 Dataset。SQL literal projection、JOIN/filter依賴及被求值但不影響回傳值的欄位，不必冒充 column origins 或純量正確性才能成為表級輸入。

負例揭露並修正兩個工作版缺口：

- 物件傳給未知 helper、別名被修改或被 closure 捕獲後，原 transport 仍可被當作未變。既有 expression graph 現在保留相應不確定性；只豁免已辨識且未被 local binding 遮蔽的普通 dataclass constructor。這是保守的區域分析，不是完整 purity／points-to 證明。
- 同一 SQL AST 被不同連線／Job 使用時，process-level owner union 會造成跨 namespace 全配對。現在比對完整 SQL-use invocation；僅共享 source statement 不足以認領對方的資源。

另外，證據範圍與發布選擇分開：只核准 input edge 時，可檢查未選擇發布的 consuming SQL 作為證據，但不因此核准或產生它的 output edge。偽造 Catalog identity、已移除資產、缺失 input column、丟棄／修改集合及錯誤 record field 均被拒絕。

本輪 **178項隔離Python測試通過**；兩個本輪修改production檔primary LSP為0 errors。main的37個source/test基線hash未變，仍只有10個stage檔有改動、沒有新production module。原生Lens仍保留先前7項import診斷差異，不能宣稱專案全綠或已獨審。

**原案例覆蓋下降，不能當作完成：**既有ETL bytes＋歷史Catalog回放仍19 contexts／56 slots，但linked slots由49降至33、lookup declarations由8降至4，nodes由874至914；status仍 `INCONCLUSIVE`、publication false。新增判定揭露helper effects尚未釐清；不得為恢復數字而豁免本案函式名稱，也不得把此候選套用為完整跨來源lineage修復。

此階段private checkpoint為 `resource-publication-candidate-20260919.json`／`.patch`，patch SHA256 `624d0c62be0a9bad8d0e9f231aaaca3a76248f2375fa1ead3993da088a656d0d`；raw tests `resource-publication-final-20260919.log`，回放 `resource-publication-case-20260919.json`。保留未知escape、錯誤invocation及input-only選擇的red logs。

剩餘限制：可信Host／bridge尚未傳入這個resource context；未重驗pager／digest／resource limits；同一raw dataset subject在一個plan對應多個physical URN仍會拒絕為ambiguous，不能猜測；`dbo.[Output]` reserved quoted identifier仍在Catalog binding被拒（早期fixture失敗log保留，未放寬parser）。下一步是釐清通用helper effects並恢復可描述的證據，接妥source-bound候選及Host驗證，而非直接發布此工作版。無live／憑證／模型／SQL／metadata／服務操作；Goal仍10/18、`discovery-validator`進行中。

## 2026-09-19 保留失效前宣告／隔離Host分頁回復（未套用）

上一輪49→33 linked slots的直接原因已重現：整包payload一旦被標為未知，collection traversal便丟掉仍可閱讀的mapping／append宣告。修正既有遍歷與消費者，讓這些宣告帶著collection findings往下傳；record／lookup都標為 `prior_declaration`，只有先前宣告的slot標為 `PRIOR_DECLARATIONS_ONLY`。不是豁免helper，也不是把歷史宣告當成目前值。另以負例重現並修正 `opaque(p); p=p` 繞過原parameter檢查的問題，統一參數來源的逸出判定。

- **195項Python測試通過**：183項原隔離suite，加上本輪複製的12項既有Catalog測試；不是宣稱新增195個測試。
- **12項隔離Host測試通過**：未修改的 `native-discovery.mjs` 複本透過原有固定、限時／限量bridge子程序執行stage parser。新增負例確認prior標記能穿過真分頁介面，仍不授權publication；HTTP完全使用fail-closed記憶體fixture。
- 原案例使用既有bytes＋歷史Catalog回放，恢復19 contexts／56 slots／49 linked slots／8 lookups；其中**16個slots只有先前宣告、4個lookups為prior角色**。transport916 nodes、decoder4份／416 nodes，均不表示helper或runtime已驗證。
- 經隔離Host逐頁讀回56 fields、19 contexts、4份decoder summaries及全部416 decoder nodes，與直接parser結果逐項相符；9個field pages／46個decoder pages均在44KB界線內（最大約41KB），舊digest被拒。未逐頁讀完916個transport nodes，不擴大成全圖／真Agent驗收。

此階段private候選為 `prior-payload-candidate-20260919.json`／`.patch`，SHA256 `4aaaac387a22d21cdb4917b326be8f4546ba63eb42801f99164374c2f22f5b93`。logs：`prior-payload-all-python-20260919.log`、`prior-payload-host-pager-final-20260919.log`；真bridge離線讀回：`prior-payload-host-case-20260919.json`。main41個基線檔hash不變；stage11檔修改（5 production、6 tests），沒有新production module。沿用既有venv，未安裝或改變執行中服務。

四個修改Python模組及新增Host測試primary LSP為0 errors；原生Lens仍有已對帳的7項root import差異，未反覆標記或修改正確imports。此次回復的是**可描述證據的完整性**，不是publication eligibility；原案例仍 `INCONCLUSIVE`／publication false。通用helper effects、同raw subject多namespace的身分契約、可信publication caller／版本核准／安全diff及實際發布讀回仍待完成。Goal仍10/18，A/A1/A2/B/C全部關閉，沒有新的live權限。

## 2026-09-19 同名表多namespace／直接參數轉送（隔離候選）

同一SQL source symbol不再被當成全域唯一Catalog身分。只有提供可信Python context／Catalog reader的SQL resource分支，才允許一個raw dataset subject在同一plan對應多個physical URN；每條edge仍必須匹配完整invocation及重新取得的Catalog binding。其他關係／欄位路徑不取得任意第一個或最後一個URN；未提供scope仍拒絕ambiguous，缺少其中一個Catalog資產亦在SDK建構前拒絕。

獨立fixture涵蓋：共用SQL AST的兩個Job各自讀取同名但不同namespace的表；兩個query invocation產生record streams、僅被選中的stream進入消費Job。兩個namespace能放進同一plan並經JSON roundtrip與官方SDK編譯；交換Job／來源／stream皆拒絕，沒有input×output全配對。

另重現普通 `return <參數>` 被一律標為未知helper effects的假陰性。既有graph僅對**未被遮蔽、無decorator、除可選docstring外只有單一直接參數return**的函式記錄body-only轉送事實，並在return展開／物件逸出判定共用此條件。keyword-only、二選一參數及原物件後續使用皆有正例；其他呼叫、修改、分支、decorator、slice、local shadowing與丟棄輸入仍不豁免。沒有推論任意helper純度或將runtime／scalar flags改為true。

**197項Python／12項隔離Host測試通過**；三個修改production檔primary LSP為0 errors。原案例重新經隔離真bridge讀回全部56 fields／19 contexts／4 decoder summaries／416 decoder nodes，分頁／digest限制維持。49 linked slots／8 lookups中仍有16 slots／4 lookups僅prior；transport916 nodes，`INCONCLUSIVE`、publication false。本次不宣稱原案例helper effects或完整跨來源lineage已解決。

最新private候選 `scoped-forwarding-candidate-20260919.json`／`.patch`，SHA256 `d3376c2e1364ade093013d66047cec8f5b23626775133f60ef258f108a9a251e`；tests `scoped-forwarding-python-final-20260919.log`、`scoped-forwarding-host-20260919.log`；讀回 `scoped-forwarding-host-case-20260919.json`。main41檔hash不變、stage仍11檔修改，未新增production module或執行任何live操作，未套用／獨審／驗收。原生Lens既有7項import差異保留。Goal仍10/18。

### 原生Goal焦點讀回異常

本輪開始時 `get_goal` 為既有 `mtzxzwn6-1zw7vn`／running／10 of 18；候選封存後，最後原生讀回卻為 **No goal is set in this session**。10/18因此是最後有效的任務讀回，不是目前仍running的保證，也不是已完成。原因未定；沒有建立替代Goal、切換焦點或標記task完成。已更新兩份private checkpoint，下一步須由owner／原生controller對帳或恢復同一Goal焦點；隔離候選保持未套用、live批次仍全部關閉。

## 2026-09-20：整合既有候選與 Host Catalog → compiler 接線（本地，未 live 發布）

使用者已確認新 Goal `mu997j34-x0bo0m`：先完成真 WebUI／Agent → DataHub 全 flow（含 Grafana ingestion），再補其他安全／權限／邊界；主 agent 獨作，不擴架構。舊 Goal 已 paused／archived；本機僅觀測到一個本案 Pi 程序，沒有另一個本案 writer。歷史10/18不追認為新Goal完成。

- 核對既有 `scoped-forwarding-candidate-20260919` patch 與11檔 main／stage SHA 完全吻合後，已將原候選整合到主工作區；沒有新增 production module／parser。先前封存stage與證據原樣保留，不再宣稱main未套用。
- 已補實際接縫：`bridge.py` 的 compile operation 原本完全未傳 Python context／Catalog reader，現在重用欄位分析的相同 native Catalog envelope轉換；`native-discovery.mjs` 的可信 compiler callback 每次先以既有 actor／逐URN權限／公開API重新讀Catalog，再交隔離Python重編。模型仍沒有 compile／publish action，cookie不進Python，既有大小／timeout限制不變。
- 新同流程回歸實際跨 Node → 隔離Python → 官方SDK，核對 source Dataset → Job → target Dataset；缺Catalog拒絕，兩次重編皆重新讀Catalog，移除資產／撤銷grant拒絕，非僅mock編譯器。HTTP仍是fail-closed fixture，**不是live GMS或首例全鏈發布**。
- 候選的測試類別原先跨無繼承關係借用instance methods，現行Pyright實報self型別不相容；整理為共用既有fixture基底，未改production語義。
- 最終 **197 Python／70 Node PASS**；九個相關source/test檔primary LSP 0 errors；`lens all severity=error`在本session已診斷13檔無error，不代表全repo掃描。保留最初測試module拼字錯誤及review fixture source非URN的失敗logs，修正測試輸入後通過，沒有放寬契約。

原案例的13個direct SQL I/O已有真source回歸，但抽取資料跨helper傳入三Job、完整欄位／依賴、真正Host preparation／safe diff／部署／Grafana ingestion仍未驗完；不把197／70或合成雙庫案例當成任務完成，不新增解析框架填補。

**本輪開始時：**唯讀Docker狀態顯示DataHub前端／GMS／MCP均healthy；9041沒有listener，上一批Agent runtime `9039afd2…`已exited（143、OOM=false），原image `78ac783d…`及HOME volume仍在。不推測退出原因。

**同日經使用者明確核准後，Agent已恢復：**只移除已核對的停止容器、保留原image／HOME／設定並啟動本案Host；真 `/mfe/agent` 開啟成功，新runtime隔離／HOME核對通過。設定SHA仍`dadb6d57…`。只讀本案登入檔一次、登入一次，零新prompt／SQL／metadata寫入。13 Dataset／149欄fresh Catalog及1 Flow／3 Jobs均讀回；Job原生Edge欄位確認仍為4入4出、1入1出、3入0出，共13 direct I/O。最初收據只數legacy arrays而顯示0，已由保存的原始回應離線修正投影，未重查或改寫原收據。

原失敗session最後assistant的實際`errorMessage`是 **`WebSocket error`**；這證明模型傳輸曾失敗，不足以確認網路／供應商／timeout根因，也不宣稱模型已修復。沒有重送原prompt。

恢復首試在副作用前因volume JSON格式少一個括號停止；原輸出與當時容器／listener已對帳，確認零移除／啟動／登入後，僅修腳本格式按同一批准續行。兩份收據保留，成功批次已關閉，不重播。成功收據`flow-live-readonly-run-retry1-20260920.json`、投影更正`flow-live-native-projection-correction-20260920.json`。

**真source準備結果與剩餘阻礙：**用同一九檔snapshot及本次fresh讀回Catalog，現行compiler實際產生14個初始Aspects／13條direct I/O；三Job的來源record傳遞仍被`object_escape_effects_unverified`、`helper_return_effects_unverified`、`assignment_not_dominating`擋住，尚無完整來源→Job關係。結果保存於`flow-source-preparation-20260920.json`與`flow-source-transport-observed-20260920.json`；不是只凭合成fixture推測，也沒有把所有來源表全接到每個Job。下一步只修既有接點中阻止首例表級flow的實際原因，不擴解析架構。完整Grafana ingestion／發布／真Agent查詢尚待完成。

私人logs：`flow-integration-python-final-20260920.log`、`flow-integration-host-final-20260920.log`；原始失敗logs同前綴、不含final。自查非獨審。`flow-discovery`仍進行中，Goal 0/8，尚無live完成宣稱。

## 2026-09-20：真來源 record → Job 表級傳遞候選（未套用）

本輪只修改隔離stage內既有 `python_bind_values.py`、`python_record_consumers.py` 與兩個既有tests；main的42個基線檔hash未變，Core乾淨。未新增production module、parser層、服務或資料庫。

具體假陰性來自：將所有非直接return helper視為未知、把top-level `with`內唯一local定義與後續成功讀取割裂，以及把不同comprehension的同名變數當成同一物件。修正在原graph重用已綁SQL invocation、檢查本地helper的參數effects、保留lexical scope／guard，並區分新容器／宣告的Decimal運算結果與原record receiver。沒有按本案函式或表名豁免；opaque escape、mutation、shadowing、遞迴helper、未知property effects及finally仍有拒絕回歸。不宣稱通用Python purity、runtime identity、算式或欄位語義已驗證。

同一九檔source、同日已核准保存的13 Dataset／149欄Catalog，實際經 **Node Host → 固定隔離Python → 官方SDK** 編譯，得到：

| Job | Inputs | Outputs |
| --- | ---: | ---: |
| load_dimensions | 9（五來源表＋四dimension） | 4 |
| load_sales_fact | 6（兩來源表＋三dimension lookup＋fact） | 1 |
| validate_datamart | 3 | 0 |

共 **23條表級I/O／14個初始Aspects**；比現存13條多10個inputs，沒有刪除關係或新增output。七個來源表沒有全配對到所有Job。這是使用真source的離線編譯，不是新Catalog網路觀測、SQL執行、完整欄位或live發布。

- **201 Python／22受影響Host tests PASS**；四檔primary LSP 0 errors。最後只澄清一段docstring，隨後再以當前bytes跑上述真案例Host接縫。自查不是獨審；主agent獨作。
- 早期候選／失敗logs保留；隔離Host初試缺少原測試依賴，補入原樣複本後按相同協定重驗，沒有換執行工具／安裝套件。中間的13／16／18／21條結果不是最終候選成果。
- 最終候選：private `flow-source-link-ready-20260920.json`／`.patch`，patch SHA `c3cb7ed69bf541c4a2b606319054a0e7d83921fadf528154563a7b4033e8e8d2`；`git apply --check`通過但未apply。logs為 `flow-source-link-{python,host}-ready-20260920.log`，真接縫為 `flow-source-link-host-real-compile-20260920.json`。

**下一個真阻擋已具體化：**保存的原生Job I/O沒有Host Run provenance，既有Edge仍帶 `discovery.evidenceKind`。邏輯上只有兩個Job需要增加inputs，但初始SDK全值不保留這些Edge properties，不能直接拿來覆寫或自動採納canary。需先核准套用候選／新的唯讀準備批次，再決定精確的既有Aspect納管與preserving diff；不得以測試通過繞過既有owned-aspect保護。Grafana reader預檢／provisioning、真ingestion、發布及真Agent完整回答仍未完成。本輪憑證／HTTP／模型／SQL／metadata／服務操作均0。

本輪回顧：直接用真案例與原生回應判別問題，比只看fixture綠燈有效；因此保留「23條可編譯」與「尚不可直接發布」兩個不同結論，不以表級成果替代最終交付。

### 同日另准套用／唯讀預檢：已套用，Grafana及DataHub補核均完成

使用者明確核准提案 `b7c5bc9d…` 的套用＋唯讀預檢。核對42個main基線及四檔候選SHA後，精確套用patch `c3cb7ed6…`，沒有換image／HOME／設定或重啟。主工作區四檔primary LSP為0；兩個generic int轉換警告經來源核對為內部 `_Graph.add()` 的 `value:<index>` invariant，已標false-positive，未加吞錯包裝。最新Lens all已診斷11檔無error，不代表全repo掃描。

- **DataHub未完成**：一讀憑證／一次`POST /logIn`成功200後，操作腳本只保留`PLAY_SESSION`、漏了既有Host要求的`actor` cookie，在第一個metadata request前即停止。不是DataHub登入失敗或產品auth檢查有錯。固定Core的`AuthenticationController.createSession`／`AuthUtils.createActorCookie`確認登入會發兩者；真Playwright APIRequestContext＋synthetic cookie producer離線重現舊filter失敗、新filter符合契約。沒有修改production認證規則。
- 原DataHubrequest context已dispose，未保存cookies，故該一次登入額度已耗用；**沒有自行重讀憑證／重登**。已準備DataHub-only修正腳本及補充一次登入提案，未執行；不重套patch、不重播Grafana。
- **Grafana原未執行部分已完成**：沿用尚未使用的批准，一讀憑證／一登入／九GET；現場為Open Source 13.1.2、org1，folder `dataflow-discovery`、dashboard `dataflow-sales-v1` v2與核准template語義完全相同（僅排除server id、核對server version=2）；reader名稱`dataflow-discovery-metadata`無碰撞。沒有建立帳號／token、改ACL、SQL、ingestion或metadata發布。
- 此次只觀測operator權限，不是future reader驗收。官方[service account文件](https://grafana.com/docs/grafana/latest/administration/service-accounts/)說明10.2起有`None`角色；[固定v13.1.2原生folder權限](https://github.com/grafana/grafana/blob/v13.1.2/pkg/services/accesscontrol/ossaccesscontrol/folder.go)與[單principal權限API](https://github.com/grafana/grafana/blob/v13.1.2/pkg/services/accesscontrol/resourcepermissions/api.go)提供folder-only View。已檢視固定SDK 1.7.0.9的GrafanaAPIClient／enhanced source：Grafana端使用folders／search／dashboard API，不必給datasource query權限。下一個可實測方向是**None＋本folder View**，不是全域Viewer；尚未provision或證明該reader可用。Datasource細分權限／custom RBAC的Enterprise限制不應被誤推為connector必須取得SQL查詢能力。

私人收據：`flow-source-link-apply-20260920.json`、`flow-source-link-readonly-run-20260920.json`（失敗原樣保留）、`flow-source-link-grafana-readonly-run-20260920.json`；cookie回歸為`flow-source-link-cookie-contract-20260920.log`。補充提案為`flow-source-link-datahub-resume-proposal-20260920.json`。本輪不是全flow完成；教訓是操作腳本應沿用完整既有cookie契約，不能把較少header欄位當成較安全而破壞合法呼叫。

### DataHub補核結果（另次明確批准，批次已關閉）

使用者另准提案SHA `e2a3c0c8…` 後，修正腳本一次讀憑證／登入、24個requests全部完成；未重播Grafana。真實讀回13 Datasets／149欄位及1 Flow／3 Jobs，再經**main Host → 固定Python → SDK**重新編譯：`load_dimensions` 9→4、`load_sales_fact` 6→1、`validate_datamart` 3→0，合計23 I/O／14個初始化Aspects。fresh Catalog與先前觀測深度相等；不同序列化SHA不是schema drift。兩個原生cookies均在記憶體使用，context已dispose。

現場三個Job I/O仍各為v1、沒有Host Run provenance，仍為4→4、1→1、3→0（13條）。离線保留式preview僅兩個Job各新增5 inputs，零刪除／output變更，保留所有既有欄位與edge properties；第三Job不變。**這不是已接管、提交用Host review或發布授權**；不能直接送出初始化14 Aspects，仍需既有Host的可信接管準備與明確人審／條件寫入。

證據：`flow-source-link-datahub-readonly-retry1-20260920.json`、`flow-source-link-fresh-{catalog,native,compiled}-20260920.json`、`flow-source-link-io-preserving-preview-20260920.json`。本批沒有metadata／Task寫入、token操作、SQL、ingestion、重啟或模型prompt。第一項的真source／fresh Catalog／編譯接點已有實證；續行後Goal已將此限定成果登記完成（1/8），未宣告全flow或全部欄位完成。

## 仍未完成

1. 在生產 Host preparation／Agent 入口配置已驗的真 source compiler，完成 fresh Catalog 身分、來源 scope／隱私與最終 owned-Aspect diff；不是以 raw review 重建 logical plan，也不是把初始 SDK 全值當安全替換。SEMANTIC compiler 尚未接入；目前不能從 Agent 問題文字製造批准。
2. 將真來源／Catalog／隱私分類檢查接到上述 Host compiler 與 publisher，完成既有 canary／人工 metadata 的明確處理及真 API 權限、CAS、partial/unknown 與讀回驗證。這些本地控制已實作，但不等於已部署閉環；Run CAS 不提供跨 Aspect／來源交易。
3. 核准模型／Host 部署後，真 DataHub API／人類操作／Agent 讀回驗收。`0.1.2`／`0.1.3` 均未安裝；已部署版本及既有 canary 均未改／重播。

Proposal 與回覆沿用已核准的 Catalog metadata 可見性，**不是 actor 私有檔案**。實際值入庫前必須符合既有資料分類／來源授權；禁止 credentials、敏感 raw SQL／literal 等進入普通 Aspect。摘要與型別驗證不是 DLP、ACL 或 runtime 正確性證明。

本輪收斂了「一般問答被誤用為核准」與「預覽依賴未來批准時間」的責任邊界，但沒有以新增 records 或通過測試冒稱整條安全發布閉環。上述為早期發布邊界收斂；10/18屬已封存舊Goal。現行Goal為`mu997j34-x0bo0m`、1/8、`flow-publish-grafana`，完整閉環尚未完成驗收。

## 2026-09-20 最新：Host Task scope部署與真入口對帳

- 先唯讀核對既有AdventureWorks Source v4及SalesDatamart Source v1，再經使用者明確批准套用精確Task scope。真DataHub `/mfe/agent`的Tasks面板讀回原T03／AdventureWorks／SalesDatamart三個scope，Dataset數為2／13／8；16上限不變，不把MSSQL Source當Grafana connector執行。
- 僅受控重啟既有Agent gateway／單一runtime。原image、HOME、歷史session SHA不變；新gateway PID1770369、runtime `04adf0e90624…`已保留服務。沒有重做Grafana擷取、model plugin安裝或canary。
- 原runtime MCP token已過期；同一reader的一小時測試token通過公開SDK key／status／schema讀取，再只更新既有受保護Pi HOME的MCP Authorization。URL、工具、角色不變；秘密未進證據。到期時間為2026-09-20 15:27:45 UTC，這是測試憑證更新，非永久生命周期修復。
- 原部署runner在後檢逾時：驗證器誤查外層`body.action`，實際MFE以grant envelope包住`request` JSON字串，因此驗證器自行擋住合法scope讀取。保留原`INCOMPLETE_NO_REPLAY`收據；修正只讀驗證器後真MFE核對成功，**没有第二次部署或更新token**。
- 舊模型失敗前四次工具回合均成功，第五回合為`WebSocket error`、零usage；相應Docker log window沒有紀錄。不能用MCP token到期解釋供應商WebSocket錯誤，也不宣稱已修復。此批零新prompt、SQL、Task／Run／Catalog寫入；原生token建立另計。
- 證據：private `flow-task-source-preflight-run-20260920.json`、`flow-host-scope-deployment-{approval,run}-20260920.json`、`flow-host-scope-readback-run-20260920.json`。離線MCP原子更新／stdin傳遞fixture及Node syntax check通過；Lens當次19檔無問題，非全專案掃描。

最新原生Goal讀回為**paused、1/8**，未自動恢復。剩餘仍是真Host preparation caller、實際Task／typed人審／CAS發布與完整Agent回答／reload；部署scope不等於完成發布。

## 2026-09-20 前一批：發布基線與模型0.1.3熱載入

- 使用最新測試授權做26次有界唯讀請求：精確17個Grafana資產的native batchGet皆為空；兩個既有canary的`dataJobInputOutput`仍存在。無新token、Task／Run或Catalog寫入。這只證明當時baseline，不代替發布當下fresh版本檢查。
- 真Host設定的Task scope仍是先前T03兩個Dataset，並非本案Discovery／SalesDatamart。沒有改其範圍、借用不相關Source或放寬16-Dataset上限；正確scope及可信準備caller仍待接通。
- GMS `/config`證實原載入0.1.0／0.1.1。使用者另外明確核准0.1.3官方熱載入：ZIP SHA `5fc8d52c95d61b700ef5169dc6941c629370ac89c21caf41bfd24f484def2275`；2 plugin jars／49 classes，無Core classes。以完整版本目錄原子加入，保留舊版本，先驗GMS UID100可讀。
- 官方loader回報0.1.3 `SUCCESS`、`failureCount=0`。一筆舊Task、兩筆舊Run的值及版本逐值相同；舊插件檔案hash、本案所有容器ID／image／PID／startedAt都未變。**沒有重啟、image切換、metadata發布或新模型prompt**。第一次前檢錯把版本號當registry欄位、第二次因獨立收據檔名重複而停止；兩次皆未stage／部署，原紀錄保留，修正已知操作參數後才完成唯一部署。
- 修正公共`ingest_fixture()`：Dashboard meta與folder清單使用相同numeric folderId；既有Node publication測試不只更新121／138筆數，還檢查dashboard-container→folder-container及每個query／Chart／Dashboard父鏈。2 Node tests PASS；17 Python tests OK（含1個既有原生欄位expected failure）。初次Python命令漏既有PYTHONPATH而失敗，補正執行參數後通過，未安裝依賴。兩檔primary LSP clean。

私有證據：`flow-publication-baseline-run-20260920.json`、`flow-publication-fresh-targets-20260920.json`、`flow-model-013-deployment-{proposal,approval,run-retry2}-20260920.json`、`flow-model-013-legacy-{before,after}-retry2-20260920.json`、`flow-grafana-publication-fixture-complete-20260920.log`、`flow-grafana-python-fixture-complete-retry1-20260920.log`。此處只更新插件部署／前置驗證狀態，不把它算成真typed consent／條件發布或整條flow完成，Goal仍1/8。

## 2026-09-20 最新：真 SDK file-sink 已恢復並驗證，尚未發布

使用者先核准一次診斷批次，再明確授權「目前實作中所有需要的測試權限」。此授權適用本Goal／本案既有測試環境，不代替metadata人審／CAS，不擴及其他專案、破壞性正式操作或新架構。舊批次仍保持關閉，以下都是有獨立收據的診斷／恢復，不覆蓋失敗紀錄。

- 診斷runner回報`catalog_read_failed`。同一reporting view的公開SDK `datasetKey`讀取回401；原PAT的expiry為9/10，既有reader-token也已到期。這是憑證生命週期問題，不是需要修改connector／Core或放寬ACL的證據。
- 沿用既有DataHub reader service account；native privilege讀回含view讀權、沒有加入寫權。用官方API建立一小時、僅記憶體的測試token後，同一SDK的key／status／schema三讀成功。舊PAT、reader-token、user.props內容／mode、service account及ACL均未改。
- 操作helper曾因過嚴檔案mode斷言（user.props0644但父目錄0700）、錯把原生login成功當JSON、錯猜token URN namespace而停止。前两次無token建立；第三次已建立token但錯誤ID撤銷未確認。已依原生`dataHubAccessToken`／hash契約改正，正確撤銷上一枚token，再建立／使用／撤銷本次token；兩枚均取得原生撤銷確認。未觸碰其他token，所有失敗收據保留。
- 恢復批次再次以Grafana帳號9／None讀回dashboard v2／7 panels，token12為600秒；固定SDK＋既有Transformer實際產出**121 Aspects／17資產**：7 panel query Datasets、7 Charts、1 Dashboard、2 containers。沒有DataHub Catalog／Task／Run寫入、SQL、重啟或模型prompt。
- 原操作runner的後置檢查把fixture的120筆當固定總數，因此原收據保留`STOPPED_NO_RETRY`。差異已查明：fixture只有`meta.folderUid`，漏掉實際存在的`folderId`，少產一條dashboard-container→folder-container邊；補上fixture欄位即重現121筆。**沒有重跑成功的SDK擷取**，另以保存的live產物驗證資產UID、結構Aspect白名單／唯一性、view→query→Chart→Dashboard及完整container父鏈，七份schema／inputFields各合計14欄。
- 回歸：完整meta fixture PASS、缺meta拒絕；真產物正例與缺父邊／錯Chart input／重複Aspect／外部上游共5項PASS。原批次後段ACL／snapshot檢查未執行，不能補稱已驗。Core仍乾淨。

證據均在private evidence：`flow-testing-authority-20260920.json`、`flow-grafana-diagnostic-run-20260920.json`、`flow-catalog-{sdk-read,pat-expiry}-diagnostic-20260920.json`、`flow-grafana-recovered{,2,3,4}-run-20260920.json`、`flow-grafana-artifact-validated-20260920.json`、`flow-grafana-{complete-meta-fixture,incomplete-meta-fixture,artifact-regression}-20260920.log`。真產物SHA `188b92002ef977d41bbafdff8efe08350b55c61106727cf2e809685da10db1a8`。

**完成範圍僅真讀取／擷取及產物驗證，不是DataHub ingestion寫入或完整flow驗收。** 接下來仍是既有Host可信準備／typed consent／條件發布及讀回，Goal保持1/8。

## 2026-09-20 续行：真 connector 擷取嘗試（停止，未發布）

使用者另准提案SHA `ed4954d8…`：沿用帳號9／None及既有folder View，允許官方connector讀本folder可見dashboard metadata，再以pattern及產物UID限定目標；pattern不是ACL。另准一次DataHub PAT讀取，只讀reporting view的key/status/schema及SDK config；官方source＋既有`GrafanaSchemaTransformer`只接file sink，無stateful deletion／owners／tags／telemetry／DataHub reporter。沒有改Core、SDK、權限或新增架構。

- 執行前以**相同runner**攔截全部HTTP，含virtual folder與另一preview，驗得120結構Aspects／17 entities；schema及Chart inputFields均是七份**合計14欄**，更正提案的「每份14」筆誤，沒有更改授權範圍。預檢清單亦驗missing target／跨folder／同名碰撞拒絕。
- 真批次 `11:54:11Z–11:54:14Z`：一次Grafana credential read／login、一次DataHub PAT read、13個operator/reader預檢requests（**不含未instrument的SDK讀取**）；建立token10、expiry讀回為`12:04:11Z`，沒有保存key。reader成功核對權限與目標dashboard v2／7 panels，完整JSON符合模板。
- 固定SDK程序PID1289587已退出，回報`PipelineExecutionError`；file sink為`[]`（2 bytes、0 records）。**真擷取失敗，不能稱ingestion完成。** 未執行後段成功檢查，不補稱後驗ACL／snapshot已通過。沒有DataHub metadata／Task／Run寫入、來源SQL、重啟或新模型prompt；context已dispose，未自動重登、重建或重試。
- 現場原因仍未知：runner只保留例外類型、沒有保存SDK結構化failure/warning，是本次診斷資訊缺口。相同環境／CPU／3GiB限制下fixture成功，改用當日已保存的真Catalog仍成功；這排除不了當時真API／schema／權限差異。限定失敗四秒窗的本案GMS／既有Grafana服務日誌只得到0條GMS、3條Grafana索引info，沒有相關HTTP/錯誤證據。未讀秘密、未查其他專案日誌、未重試API；沒有宣稱已證明根因。
- 已另存診斷用runner後繼版本，保留原已執行腳本不變；只輸出bounded SDK title、固定error code／exception類型／HTTP錯誤狀態，不輸出context／SQL／token。合成Catalog拒絕能保留`catalog_read_failed`，正向recorded-Catalog fixture仍產出120 Aspects；此拒絕**不是現場根因證明**。尚未執行live後繼版本，取得新的精確批次授權後才沿同一SDK／file-sink流程診斷；不更換模型、SDK或權限來繞過問題，不把空輸出當成功。token／憑證額度已用完。

證據：private `flow-grafana-live-extraction-{proposal,approval,ready,run}-20260920.json`、`flow-grafana-live-extraction-mcps-20260920.json`、`flow-grafana-extraction-{offline-check,bounded-offline,recorded-catalog}-20260920.log`、`flow-grafana-extraction-service-log-summary-20260920.json`。主Host兩檔autoformat後再次syntax check與49 affected tests PASS，見`flow-canary-adoption-postformat-20260920.log`；不重設來源或重做成功live批次。

## 2026-09-20 續行：保留式差異、限定 canary 接管及 reader 實測

- 既有Host重編收到權威native target observations。`preserveDiscoveryJobIO()`保留所有原欄位／edge properties及表示法，只追加缺少的表關係；刪除、畸形值及未支援的更豐富compiler輸出拒絕。實際九檔source在目前code重新編譯，使用已保存的Catalog/native觀測，仍為23 I/O、兩個Job各加5 inputs。不是新的live讀取。
- 使用者另准兩個canary的一次接管**意圖與必要本機接線**。`taskRecords()`新增僅可信Host可提供的`publicationAdoption`：綁完整review digest、actor、精確target、原值digest及creation stamp；只接受同actor建立、無既有Run provenance的LINEAGE Job I/O。一般人審不能自行產生此授權；HTTP／model參數仍拒絕。保留fresh source／ACL、typed consent、expiry、Run admission、逐Aspect CAS及no-op檢查。沒有新增模型、服務、資料庫或Core patch；尚未部署或寫DataHub。
- 最終75項Node tests通過（68＋7）；包含合法接管後條件寫入／provenance讀回，以及錯actor／digest／baseline／creation stamp、其他publisher、原建立者不同、client注入、版本漂移與重複提交拒絕。這些writer檢查是fixture，不是真發布。先前保存的兩個Host檔hash與目前不符；對照保留source只有預期的preservation接線，未重設檔案，並以目前code重跑真source與tests；不推斷未觀測的改動原因。
- Grafana兩個明確批准批次共2次登入、28 requests。已建立service account 9／None，僅對`dataflow-discovery`授予View；原ACL逐項不變。token8／9都只在記憶體，600秒expiry由server讀回，沒有保存key。reader有效權限為本folder的read actions及內建`sharedwithme` folder讀權，無datasource query／mutation grants。
- 兩次停止都來自操作腳本不恰當的清單數量假設：第一次未考慮Grafana 13.1.2會加入`sharedwithme`；補充批次已實際讀回此虛擬folder＋目標folder。第二次search讀到目標dashboard及同folder的一個preview，違反腳本「只能一筆」的斷言；不是登入失敗，也不是已證明越出folder。未讀preview內容，目標dashboard的**reader完整內容讀取尚未執行**。每次均停止並dispose，沒有自動重登／重建／重試；帳號與授權保留，不能假稱reader或ingestion已完整驗收。
- 接續需以目標UID存在及授權folder邊界核對清單，不把清單總數1當ACL契約；官方connector的target選擇與真正ACL仍分開。新token／登入、真connector執行、DataHub發布及部署須具體另准，不重播已關閉批次。

私人證據：`flow-canary-adoption-ready-20260920.json`、`flow-canary-current-source-proof-20260920.json`、`flow-canary-adoption-{final,adjacent}-20260920.log`、`flow-grafana-reader-provision-run-20260920.json`、`flow-grafana-reader-readback-retry1-20260920.json`。兩份失敗receipt保留；主source的primary LSP已無錯，Lens的舊解析／graph ID訊息以現行syntax／LSP／測試對帳，不加吞錯或重寫正確碼。`.local`既有secret掃描提示的四個檔案均未追蹤、被忽略且0600；只查metadata，未讀值／輪替，不據此宣稱無秘密風險。

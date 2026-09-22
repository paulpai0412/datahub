# DataFlow Discovery／SalesDatamart v1 實作 TODO

建立：2026-09-13；執行順序更新：2026-09-20。任務：`TODO-dc390fa8`（in_progress；表級發布／Agent查詢及固定ETL人工核准閉環已實證，剩餘安全邊界與業務語義未完成）；關聯母任務：`TODO-a2daa81d`。

目前原生 pi-goal-x：`mu997j34-x0bo0m`（2026-09-20 確認，八項剩餘成果）；`fixed-etl` 真實功能閉環已完成，見下方驗收節。原生task標記最後讀回仍為3/8／fixed-etl pending，目前可用Goal工具沒有單task完成操作，尚未將此功能成果冒稱為原生狀態更新。依使用者要求，本輪止於fixed-etl。舊 Goal `mtzxzwn6-1zw7vn` 已 paused／archived，10/18 為歷史限定成果，不是目前 Goal 的進度。Skill：**DataFlow Discovery（資料流探索）**，ID `dataflow-discovery`。

設計：[DataFlow Discovery／銷售 Datamart／Grafana／DataHub v1](research/datahub-sales-datamart-v1.md)。

## 已核准範圍與狀態

- [x] 確認 AdventureWorks 銷售訂單明細，四個 dimensions＋一個 fact。
- [x] 確認既有測試 MSSQL instance 新建獨立 `SalesDatamart`；來源唯讀、僅新 Datamart 寫入。這是限定業務 database 例外，不是 Extension 狀態庫。
- [x] 既有 Grafana 已定位 org1／13.1.2，本案專用 folder／datasource／dashboard 已部署實測，不影響其他專案。
- [x] 確認單次執行、每次寫入／明確批次人工核准，首版無排程。
- [x] 生成設計文件與本清單，連回既有 Agent TODO。

- [x] 使用者更正：DataFlow Discovery 必須實作，SalesDatamart 僅為第一個驗證案例，不 hardcode 分析答案。
- [x] 原生 pi-goal-x原12項任務已依2026-09-19盤點確認重整為18項；已同步Goal／設計／本清單，保留原DM01–DM09全部驗收。

**以上只代表決策／範圍文件完成；產品實作及現場驗收仍未完成。** 主 agent 獨自開發與驗證，不使用 team-flow、subagent、reviewer／auditor child、mission／watchdog／其他控制器；不 commit／push。外部副作用須定位精確目標、核對既有授權或批准新操作批次；auto-continue 不授權任意 DB／憑證／部署操作。

### 2026-09-20 測試授權更新

使用者已明確授權「目前實作中所有需要的測試權限」。本Goal／本案既有測試環境所需的有界診斷、憑證使用與短期測試token不再逐次請准；不是其他專案／破壞性正式操作／架構擴充授權，不取代既有metadata發布的人審與CAS。私有授權及執行收據仍逐批保留，失敗先對帳，不盲重播。

## 2026-09-20 最新核准順序：先打通完整 flow，再補其餘邊界

主 agent 獨自開發／測試／自查，不使用 Agent Teams 或子代理，不自行擴充架構。重用既有庫、ETL、Grafana 與有效證據；不重做成功批次。

1. [x] `flow-discovery`：真來源候選、DataFlow／DataJob、來源／目標表及 I/O 整合。**限定編譯接線完成，當時Goal登記1/8；發布與目前3/8狀態見下節**。先前11檔候選與Host Catalog接線已進main（197 Python／70 Node PASS）。最新4檔隔離候選修正record/helper傳遞，真source＋同日recorded Catalog經Node→隔離Python→SDK編譯出23條I/O（原13條）；201 Python／22受影響Host tests PASS。此4檔經明確批准已套用（未重啟）；Grafana唯讀預檢完成。DataHub第一次漏actor cookie的操作腳本已修正；另經批准的一次唯讀登入／24 requests成功，fresh 13 Datasets／149欄位經main Host重編譯仍為23 I/O。兩個Job的離線保留式diff各加5 inputs、無刪除／output變動；該編譯批次沒有發布。其後限定真寫入結果見下方最新交接。詳[9/20接線證據](verification/dataflow-discovery-publication-review.md)。
2. [x] `flow-publish-grafana`：**已完成；以下保留前段歷史，9/21真發布結果見最新節。**必要可信核准／條件發布，加上真 Grafana ingestion，讀回完整 flow。已核准的兩個canary接管意圖接入Host私有選項，精確digest／原值／creation stamp與同actor綁定，75項本機tests通過；不開放model／HTTP接管參數，尚未發布。Grafana帳號9已為None＋本folder View，既有ACL不變、無datasource query grant。兩個批准批次共28 requests：folder讀回通過；search讀到本folder內目標與另一preview，腳本錯誤的單筆斷言停止。其後另准真擷取批次：reader已完整讀回目標v2／7 panels；官方connector＋既有Transformer已實際執行，但回報`PipelineExecutionError`、file sink為空（0 records），不是成功ingestion。token8／9／10皆僅在記憶體、600秒expiry已讀回；批次全部關閉，沒有DataHub metadata寫入或自動重試。**後續已恢復真SDK擷取**：追加診斷定位`catalog_read_failed`，同一view公開SDK讀取401，原PAT已於9/10到期。沿用既有DataHub reader service account，短期測試token使key／status／schema讀取成功，原connector＋Transformer產出121 Aspects／17資產（7 query datasets、7 Charts、1 Dashboard、2 containers）。原操作驗證把不完整fixture的120筆當固定總数而停止；已不重跑擷取，直接驗證既有產物與完整container父鏈。fixture補上原先遺漏的`meta.folderId`即重現121筆；缺父鏈、錯Chart input、重複Aspect、外部上游負例均拒絕。兩枚本輪DataHub測試token已確認撤銷，舊憑證／帳號／ACL不變。**真file sink成功，不等於已寫入DataHub或整條flow驗收**。後續26次唯讀預檢確認17個Grafana資產尚不存在、兩個canary IO仍存在；另經明確部署核准，官方loader已熱載入模型0.1.3，舊Task／Run值與版本、舊插件及容器身份均不變，零重啟／發布。公共fixture已補folderId並檢查完整container父鏈：2 Node tests、17 Python tests（含1個既有expected failure）通過。其後另經明確部署核准，Host已加入既有AdventureWorks／SalesDatamart Source的13／8 Dataset Task範圍；真MFE讀回含原T03的2／13／8範圍，16上限不變。只重啟本案Agent gateway／runtime，原image／HOME／session保留；同reader短期token更新至既有受保護Pi HOME，角色／工具不变。初次後檢誤讀MFE grant envelope，自己擋下唯讀request而逾時；修正驗證器後只讀對帳成功，未再次部署。其後可信準備caller、真Task／Decision及另准typed API人審已接通；兩個Job的條件寫入已發生，但完整provenance讀回未過，禁止重送。Grafana仍只有驗證完成的file sink。詳下方最新交接及publication證據。
3. [x] `flow-web-agent`：真 WebUI／Agent 查詢／導覽全鏈，API 對帳、完整回答及 reload。3回合20次MCP讀取零工具錯誤，七組query→Chart逐項對帳原生值，reload訊息完全相同。**前三項優先完成線已通過，不代表全Goal完成。**
4. [x] `fixed-etl`：**功能閉環已驗證**。真Agent／typed UI APPROVE → 一次ETL 1.0.1 → 新連線品質檢查 → 原生Run v7／COMMITTED、真UI及同模型結果讀回／reload。185,013ms；source／fact／view各75,284筆，金額對帳一致。詳[fixed-etl驗收](verification/fixed-etl-20260921.md)。原生task標記登記與功能證據分開，不宣稱整體Goal完成。
5. [ ] `data-safety`：補齊 DDL／ETL 有界執行、品質、並行／取消與恢復負例。
6. [ ] `access-boundaries`：真跨 Actor、Grafana reader、秘密及 SQL 權限分離。
7. [ ] `publication-boundaries`：發布／執行版本、過期、重複、部分失敗／UNKNOWN 對帳。
8. [ ] `final-delivery`：必要欄位／語義、真 run／as_of、全鏈回歸與回復 runbook／文件／驗收。

不要求所有純量／helper 語義完成才接通可獨立證明的表級 flow；必要欄位與業務語義仍保留於最終交付，不以表級結果假稱全部完成。現有認證、scope、秘密隔離、人工核准、版本條件及人工 metadata 保護不降低；目前實作所需測試操作沿用本日最新測試授權，仍須限定目標並保留操作／對帳收據；metadata發布走既有人審／條件寫入，不以測試授權替代。非前置的全面安全優化留在第一完成線之後。

原平台可信 Join 完整生命週期、一般受控 SQL、Oracle、Agent 排程與其餘 T06／T07 留在原 TODO，不屬本次完成條件。以下歷史18項／DM01–DM09證據保留；後續以本節八項與新 Goal 為執行順序。

### 2026-09-20 Host部署交接（14:48歷史，下節取代目前runtime狀態）

`flow-host-scope-deployment-run-20260920.json`保留原後檢逾時；`flow-host-scope-readback-run-20260920.json`證實實際MFE scope、原image／HOME及歷史session hash一致。新gateway PID1770369、runtime `04adf0e90624…`持續服務；本批零Task／Run／Catalog寫入、SQL及模型prompt（另有一枚原生reader測試token建立）。該token於2026-09-20 15:27:45 UTC到期；不是永久憑證生命周期修復。舊WebSocket error前四次模型工具回合成功，原因仍未證實，不混同MCP token到期問題。最新Goal讀回為**paused、1/8**，未自動續建Run或發布。

### 2026-09-20 發布與MFE結果（原始狀態；下方9/21進度接續）

- 真MFE Task／Run已取得模型的`datahub_get_me`、`datahub_get_entities`回應，讀到既有Flow／Jobs；工具省略Job I/O不代表原生I/O不存在。同一Run後續真`datahub_decision`已完成，沒有假造pending state。
- 可信Host重編真source／fresh Catalog，將精確保留式review附至同一未回答Decision（Run v3）；使用者另准既有authenticated typed API核准（v4），不是UI點選驗收。原native問題收到儲存中的APPROVE後正常停止，未自行發布。
- 唯一Host admission使Run變成v5；只送出一次、兩個`dataJobInputOutput`皆帶v1條件。讀回兩個Job已為v2，值與核准提案完全一致：`load_dimensions` **9→4**、`load_sales_fact` **6→1**；`validate_datamart`仍v1／**3→0**。已讀的非I/O Aspects及第三個Job未變。
- **未通過完整發布驗收**：原生`systemMetadata.runId`符合attempt，但`dataflowDiscoveryRunUrn`／`dataflowDiscoveryDecisionId`未讀回。Host正確回報`publication_write_unconfirmed`；尚未證實標記遺失的具體環節，不能宣稱API必然不支援。未重送、回滾、補寫或放寬ownership檢查。新增此實際回覆形狀的回歸；57 Host tests通過。
- 原MFE檔案切換未更新gateway啟動時快取；經另外明確批准，在native Run結束後只重啟9041 gateway／單一runtime。HTTP現在供應核准`70.js`（`09dc42d2…`）；原image、HOME、兩份session歷史及MCP設定hash完全保留。新gateway PID **2124417**、runtime **`80f469dbfe5d…`**。前置腳本誤要求已結束的Pi程序仍running，第一次在SIGTERM前停止；只讀查明`running:false`代表程序已退出，修正驗證器後才執行唯一重啟。
- **Grafana尚未發布，完整Agent／WebUI flow未驗收**。MCP測試token已於15:27:45 UTC到期，本批沒有刷新。Goal最後原生讀回仍**paused、1/8**（15:18使用者暫停），限定後續批准不等於自動恢復Goal。下一步先診斷／處理發布標記缺口；任何補寫都需新的精確方案，不重用已消耗的review。

### 2026-09-21 前段：Adapter已核准驗證，既有admission只讀對帳成功

恢復後，原生診斷Task重現固定Core更新保留舊properties、ACK帶新properties、runId成功更新；`EntityServiceImpl.applyUpsert`吻合該結果。使用者核准最小相容性修正：新runId保存版本化Run／Decision／attempt定位，但權限仍須查權威紀錄；不改Core、不加服務／資料庫，不豁免ownership、no-op、fresh consent或CAS。

65項Host／runtime／Grafana fixture測試通過；既有不執行診斷Task的一次v2→v3更新，證實新格式可完整原生讀回。兩個Job經既有Host對真正Run v5／Decision／admission只讀對帳，得到`MATCHED_KNOWN_LEGACY_ATTEMPT`，精確值與修改audit／版本吻合；維持9→4、6→1，第三Job仍3→0。**沒有Job／Run重寫；`retryAllowed:false`，舊UUID-only目標仍需明確ownership review才可再寫。** 原unconfirmed收據保留，不改稱當次全量成功。

Goal原生讀回為**running、1/8**。Grafana121-Aspect真產物仍未發布，下一步接妥保留產物的fresh source／Catalog／target-bound準備與真typed核准；不重播成功擷取。完整WebUI／Agent回答、固定ETL及其餘驗收仍未完成，過期MCP測試token未刷新。證據：`flow-native-runid-adapter-ready-20260921.json`及其所列65-test、native storage、只讀對帳收據；沒有本輪部署或獨立審查。

證據：私有`flow-canary-publication-run-20260920.json`、`flow-canary-publication-reconciliation-run-20260920.json`、`flow-mfe-post-terminal-restart-run-retry1-20260920.json`、`flow-systemmetadata-causal-finding-20260920.json`及`flow-integration-checkpoint-20260920.json`。詳細過程見[publication最新結果](verification/dataflow-discovery-publication-review.md)。

### 2026-09-21 前置：Grafana可信準備通過、MCP憑證已更新

既有Host新增私有Grafana產物compiler，固定原始file sink SHA，重新核對source／Catalog，再產生create-only提案；沒有公開model發布端點或重跑擷取。真產物是官方簡化MCP `aspect.json`（先前觀察的`aspect.value`是SDK轉換後物件），保留原生PDL namespace／union。67項相關Node tests及3檔primary LSP通過。

獨立收據的預檢以20次Grafana／30次DataHub requests驗證目前dashboard／權限／view schema／目標不存在及發布privileges：**121 Aspects／17資產、8 Dataset scope**。僅有未核准草稿，未建立新Task／Decision或發布；原失敗與token400只讀對帳保留。來源與版本仍須在真正發布時重查。

使用者明確指示「自行更新mcp 憑證」後，已為**同一只讀service account**建立一小時token，公開SDK成功讀取既有view的key／status／schema，只原子更新受保護Pi HOME的MCP Authorization。有效至 **2026-09-21 02:53:46 UTC**；工具／URL／角色／image不變、兩份history hash保留，無重啟或新prompt。這不是永久自動續期，也尚未證明新Agent回合的MCP E2E。

證據：私有 `flow-grafana-compiler-ready-20260921.json`、`flow-grafana-publication-preflight-run-retry3-20260921.json`、`flow-grafana-agent-reader-refresh-run-retry1-20260921.json`。Goal維持**running、1/8**；下一步是真Task／Decision、fresh typed人審與條件發布，再完成WebUI／Agent flow讀回。

### 2026-09-21 最新：真UI核准、Grafana發布與完整Agent查詢通過

當時Goal為 **running、3/8，current fixed-etl**；最新暫停狀態見下節。Task建立502與review存入失敗定位至原生URN存在性驗證：提案包含尚未發布的Grafana Datasets。經逐次批准熱載入，現行模型 **0.1.6** 僅將Task及PublicationReview的datasets改用原生支援的平面`UrnValidation`／`exist:false`；actor／agent／Source、Host scope、privileges、fresh consent與CAS不放寬，Core未改、服務未重啟。0.1.4巢狀設定無效的失敗收據保留。

- 真Agent建立pending Decision；使用者批准精確digest `99a2397702b6f3a32158fb669919edfa917acf89b0cead0079313aedfb95bfdc` 後，在真MFE點選typed APPROVE，Run v4；native問題收到已存答案並結束。不是以API代替UI點擊。
- 既有Host重查來源／Catalog／權限／版本，一次Run admission及一次create-only批次發布 **121 Aspects／17資產**。所有值、版本及版本化runId provenance完整讀回；舊Job沒有重寫。獨立native讀回包含Flow、三Job（9→4／6→1／3→0）、13既有Datasets、view五上游與17 Grafana資產。
- 真WebUI同一既有模型、3回合 **20次MCP讀取／零工具錯誤**，回答完整來源→Jobs→目標→view→七組query→Charts→Dashboard，列可核對URN／連結及未證實語義。官方path工具只回兩條，因此改查七個Chart的直接上游；逐項對帳原生`chartInfo.inputs`，不以同名猜測。terminal與reload前後全訊息相等。
- 真DataHub導覽Flow→三Jobs及Job Lineage、Dashboard與Chart；點擊原生Grafana連結落到正確Dashboard／panel。這次刻意擋下datasource執行，只驗導覽，不宣稱重跑SQL或驗證panel數值。
- 原WebSocket錯誤根因仍未證實；本輪同模型的完整查詢已成功，不把MCP token到期混稱其原因。新reader token有效至 **2026-09-21 03:57:04 UTC**，仍不是永久續期方案。

私有證據：`flow-model-016-deployment-run-retry2-20260921.json`、`flow-grafana-ui-consent-fixed-20260921.json`、`flow-grafana-publication-run-20260921.json`、`flow-complete-native-readback-20260921.json`、`flow-web-agent-acceptance-20260921.json`、`flow-web-agent-seven-edges-20260921.json`、`flow-grafana-links-live-20260921.json`。

必要欄位lineage、公式／grain／as_of、UnitPrice影響、真正固定ETL人工核准執行及其餘邊界仍保留。回顧：真接點直接揭露模型annotation與官方MCP回傳範圍的差異；沿既有能力修正／補查，不新增框架、不重播已成功發布。操作驗證器的誤欄位與過早terminal判定收據保留，以後續原生結果對帳，未重送同一模型prompt。

### 固定ETL接線準備（歷史；後續已完成真執行）

已查明既有`native-ingestion.mjs`僅接受固定MSSQL metadata recipe，不改成ETL／shell runner。ETL已有單一target transaction與application lock，但目前先擷取再取鎖，且`.all()`沒有列數上限。隔離候選 `.local/work/fixed-etl-20260921/` 補DBAPI timeout、100,000筆fetch上限與結果關閉，並將既有target鎖提前至source extraction之前；23項既有／聚焦檢查及兩檔primary LSP通過。這是本地候選，不是完整wall-clock／取消保護或live SQL證據。

真源碼／recorded Catalog接縫檢查確認SQL context ID綁定完整snapshot；不能用舊policy套新ETL。修改已隔離，active source恢復原snapshot `ed276f258c…`，原Host／SDK重新編譯仍為23 I/O（9→4、6→1、3→0），未發布或執行SQL。下一步補既有Task／Decision內的ETL專用核准、一次admission／結果及固定CLI監督，對候選重新綁source policy；部署與寫入批次仍需精確批准。證據：`fixed-etl-candidate-checkpoint-20260921.json`、`fixed-etl-bounds-local-20260921.log`。

### 2026-09-21 固定ETL候選與使用者暫停交接（歷史）

所有新功能仍在 `.local/work/fixed-etl-20260921/`，**未部署、未執行SQL、未新增DataHub紀錄**。現行ETL及已驗收flow保持不動；Goal未新增完成項目。

- 候選沿用Task／Decision／Run，加入獨立ETL review／typed verdict、一次CAS admission、提交前授權及聚合結果；operator grant限一個actor／Run／code digest／期限，預設不授權，沒有model／HTTP任意SQL入口。
- 固定CLI使用凍結程式、受保護credential env、提交許可pipe、有界輸出／deadline／資源；父程序EOF不放行提交，UNKNOWN不重跑。新增提交後target讀回及明列非跨表snapshot的source觀測時間。這些尚無真SQL驗收。
- 真Python CLI／stdin＋Host CAS的合成ETL檢查通過允許／拒絕路徑；Chromium fixture驗證獨立ETL核准、digest、focus及390px controls。64項Host中間版回歸通過；**最後的runtime pin／operator policy／API接線尚待最終source檢查**，不以中間版測試當全量通過。
- 新安全取數寫法曾使現有辨識漏掉10條來源邊。只在既有mapping-result辨識補精確的bounded fetch／拒絕overflow／finally close型態，並分開dry-run local；9項query-decoder檢查通過。保留原13-edge失敗，重新綁25個context後，候選snapshot `e6f71e55cd…`經既有SDK恢復 **23 I/O（9→4／6→1／3→0）**；沒有手寫來源→Job mapping或發布。
- 模型 **0.1.7** 已在原隔離／離線工具鏈建置，legacy與ETL codec roundtrip、annotation check通過。首輪shared inline enum無法解析的失敗保留；改獨立purpose schema後成功。MFE已建置，均未切換使用中版本；Core保持乾淨。

私有完整hash／證據／缺口：`fixed-etl-execution-control-checkpoint-20260921.json`。原生Goal最新事件為使用者暫停，已停止後續工作。恢復後先核對checkpoint並補最終限定檢查，再準備精確部署／fresh preflight與人工核准的單次ETL批次；不得重播舊ETL、發布或模型prompt。

### 2026-09-21 最新：fixed-etl真實闭環通過，本輪停止於此task

使用者核准限定部署／靜止來源窗口，再核准精確review `24600f42dc…` 的真UI點擊。模型0.1.7已熱載入；本案gateway只重啟一次，原image／HOME／session保留。固定ETL唯一attempt `1cc50ec6-610b-453e-9cb7-afe9c30d581b` 已提交，Run v7／COMMITTED；source／fact／view各75,284筆，17,489訂單，金額72,418,506.319091對帳一致，耗時185,013ms。提交後以新target連線驗證，再以原生get_run、Tasks UI及同一gpt-5.6-sol會話讀回；terminal及reload一致。

沒有SQL重跑、DDL／DELETE、權限縮減、Core／DB設定變更；沒有展開其餘tasks。來源不是跨語句一致snapshot，本次依核准靜止窗口執行。模型收到的是實際Host get_run讀回結果，不冒稱MCP直接支援custom Run Aspect。現行68 Host／10 ETL unit tests通過；原始操作腳本的路徑錯誤、啟動回覆不完整與過早terminal判定均保留，採讀回對帳而非重播。詳細證據及限制見[固定ETL驗收](verification/fixed-etl-20260921.md)。

## 歷史實際進度（2026-09-19，依使用者要求重新盤點）

**2/12是舊任務切法，不是產品只完成兩項功能。** DM02混入後續發布／權限／Agent全閉環，且跨任務成果未同步；本次已確認18項成果任務並登記10項限定里程碑complete，8項仍需完成。完整盤點、原要求移轉及證據見 [專案盤點](verification/datahub-progress-inventory-20260919.md)。不以任務比例宣稱產品完成百分比。

原生Goal盤點時paused；`set_goal_tasks`已確認18項。續行時讀回running，已用`update_goal_task`補登八項完成並start `discovery-validator`；再次`get_goal`確認**10/18 complete、current discovery-validator、next pending data-safety**。下表證據齊的十項已登記，限定本地交付不冒稱live發布完成。

| 新成果 | 判定 | 仍保留的後續工作 |
| --- | --- | --- |
| scope-discovery／dm01 | 已complete | 原記錄保留；備份回復不重做 |
| model-canary（取代過大的DM02） | 證據齊：星型／指標、Flow＋三Job、19 Aspects／13 direct I/O／真UI | 完整來源／Job相依／run／欄位與語義歸dm06 |
| dm03 | 證據齊：4dims＋fact＋view／keys／權限已建置 | 同名／重複建置防護歸data-safety |
| dm04 | 證據齊：真ETL初載／重跑對帳／失敗rollback | timeout／有界擷取／穩定keys與完整品質負例歸data-safety |
| dm05 | 證據齊：專用Grafana v2、7 panels、8真場景 | 非owner／folder-datasource ACL歸access-boundaries |
| catalog-native | 證據齊：13 Dataset／149欄、view五上游／24欄位lineage／UI | 不是Python ETL lineage或Grafana metadata發布 |
| discovery-skill | 證據齊：snapshot／基礎候選／真Agent唯讀入口 | 完整Python欄位鏈、fresh Catalog與變更驗收歸discovery-validator |
| grafana-adapter | 本地交付證據齊：schema／Chart各14欄、官方file-sink與120技術Aspects準備 | live reader／發布另驗 |
| publication-host | 本地交付證據齊：模型0.1.3、typed review／CAS admission／conditional writer／source重編 | 未部署；真正Host caller、人工操作及live API歸publication-live |
| discovery-validator／data-safety | 待整合／修補 | 收斂既有解析與ETL，不再擴架構 |
| access-boundaries／publication-live | 部分已有，待精確授權／接線／部署／真驗 | 不用fixture當live或舊批准重播 |
| dm07／dm06／dm08／dm09 | 固定ETL可信操作／完整發布／查詢／最終交付仍未完成 | 原完成線全部保留 |

**使用者最新取捨：Grafana 只需可用，不再精修 UI；主線是 DataFlow Discovery 在 DataHub WebUI 與真 Agent 的正確呈現。** 目前轉向 target metadata／身份／lineage／語義／可信發布與讀回，不以 Grafana 外觀工作延後主線。

**2026-09-15 使用者要求收斂：不可自行擴架構，停止新增解析層／日期解析。** 原生API canary已經使用者核准，另准補一筆Python平台metadata後，完成1 Flow／3 Jobs及共19個明確新Aspect、13條direct SQL Dataset I/O的API/UI/reload驗證。六個既有Dataset的key/status/schema及版本前後未變；不是完整Skill發布，這批不可重播。詳 [精確範圍及既有接點缺口](verification/dataflow-discovery-dm02-compatibility.md)。不把一般Decision回覆當publication授權，不新增替代核准權威或狀態庫。

最新 DM01 證據：[native canary 與範圍結論](verification/dataflow-discovery-dm01-canary.md)、[隔離回復](verification/sales-datamart-recovery-20260914.md)。後續完成線未縮減，不因已建庫／跑 ETL 就自動把未驗的相容性與負例勾掉。

### 2026-09-19 現場唯讀預檢（A／A1／A2 歷史，B 前觀測）

經使用者限定批准，以真`readDiscoveryCatalog`讀回13 Dataset／149欄／39 Aspects，version皆1、值與歷史一致，17 HTTP全成功。**Agent尚未恢復**：9041無listener，原owned runtime已於9/15退出（255、OOM=false；原因未證實），設定仍未啟用field mode。HOME mount吻合，但volume owner讀回因一次性verifier格式錯誤未完成；修正只經離線fixture驗證，未再查live。沒有服務／權限／metadata變更、SQL或模型呼叫。下一步先收斂既有Host恢復與field-preview的相容性／精確授權，不再增parser；Goal仍10/18。詳[現況與原始證據](verification/dataflow-discovery-field-host-integration.md)。

### 2026-09-19 最新：C 已恢復並保留 Host，既有模型回合仍有錯誤

C 經另行核准完成：原 image／HOME、同一 field policy 保留；真 session 證明 B 的驗收器綁錯 ID，四份工具結果與 B 收據逐值一致。舊 digest／注入 catalog 分別得到409／400，零新模型生成。既有 assistant 只有部分摘要，`stopReason:error`，缺 decoder 鏈說明與完成標記；未做回答 reload，E2E 仍未通過。錯誤原因尚未讀回，不重新啟動或重送 prompt。詳[C結果／現況](verification/dataflow-discovery-host-reconciliation-result.md)，Goal仍10/18。

### 2026-09-19 歷史：B 真欄位工具回應已取得，驗收未完成後回復

經另行明確批准，B 完成真 HOME owner 驗證，原 image／HOME 啟動成功，真 Agent 取得四個 Discovery HTTP 200（list＋三頁欄位／decoder），仍是56 slots／19 contexts／311 decoder nodes、INCONCLUSIVE／不可發布。但驗收器誤以 UI 外預建的 idle session 綁 Send，等待 ACK timeout；最後模型回答、實際 session、reload及兩個負例尚未讀回。已按核准 graceful close 新服務、保留 HOME、還原 config，原／新 container 均移除，不重送 prompt或重播B。離線用真SDK及registry函式已重現空session不列history的前提缺陷；下一步只讀對帳已送出的回合，需新批准恢復同一Host。詳[B結果／診斷](verification/dataflow-discovery-host-recovery-result.md)及[C限定提案](verification/dataflow-discovery-host-reconciliation-proposal.md)。Goal仍10/18，不以四個工具成功當完整E2E或語義驗收。

### 2026-09-19 續行：欄位分析已接既有Host協定（以下為本地實作證據）

原`analyze`只呼叫基礎analyzer；現以Host可選`pythonAnalysis`接入既有query→record→SQL slot／lookup分析。Host核actor／逐URN授權、讀native key/status/schema與版本，隔離Python無cookie；模型不能注入entrypoint／scope／Catalog。每頁摘要綁source／全部分析／Catalog版本，schema或scope漂移拒舊頁，所有未驗語義維持INCONCLUSIVE，不新增parser或寫入入口。

現行81 Node／141 Python PASS；九檔真source以歷史Catalog＋HTTP fixture經同一Host與隔離bridge核得56slots、49record-linked、8lookup、19contexts、1423 transport nodes／331unresolved，6頁欄位與所有contexts可讀。同日修補bridge遺失decoder證據及同名ref歧義：v2以graphId分開transport／decoder，四個既有decoder summaries及311 nodes完整讀回，舊v1游標拒絕；沒有再增解析層。續修既有Graph的try正常延續判斷，實際`_as_decimal`僅一個helper節點由錯誤prior恢復assignment；吞錯及例外路徑保持未解，漏掉的except* guard已補上，不宣告轉換或runtime成功。真改名／算式變更負例及合法重分析已有合成同流程回歸；不是首例全語義或live驗收。接下來收斂既有轉換／成功條件与真正entrypoint policy，部署／fresh Catalog／真人入口另批；`discovery-validator`不提前complete。詳[接縫與證據](verification/dataflow-discovery-field-host-integration.md)。

## 重整後的依賴與執行順序

已登記10個限定里程碑，不重建／重載／重發成功成果。剩餘主線為：

`discovery-validator（接通既有欄位／Catalog能力）→ publication-live（真Host準備／核准／writer）→ dm06（完整技術／語義metadata）→ dm08（真查詢）→ dm09（最終交付）`

`data-safety → dm07（固定ETL可信操作）`提供安全的真run；`access-boundaries`提供Grafana reader及真跨Actor驗證。這兩支按實際依賴與批准插入主線，不再等待一個涵蓋整案的DM02。缺外部授權不妨礙其他已授權本地整合。

以下保留原DM01–DM09詳細要求以追溯；各未完成項依[移轉表](verification/datahub-progress-inventory-20260919.md#原要求不遺失的移轉表)承接，不是刪除要求。母T06/T07、排程不自動結案或全數列為本Goal前置。

### DM01 — 來源、環境與安全操作範圍

**已完成**（見 [native canary](verification/dataflow-discovery-dm01-canary.md)）：[DM01環境與恢復證據](verification/dataflow-discovery-environment.md)。已用現有 Microsoft AdventureWorks2019 backup 恢復固定 SQL Server 2019 image：`wferp-mssql-test`／`14334:1433`／named volume；WSL與DataHub Actions的 `host.docker.internal:14334` 均可連。七個候選表、日期、key／orphan及唯讀帳號已核對；`datahub_ingest` 密碼依使用者指定設定但不記錄，SA仍為受保護隨機值。Grafana已定位13.1.2／:3000／org1，未改設定；舊 `wferp-test` datasource仍指向未建立的`wferp_test`，不是本案AdventureWorks datasource。SalesDatamart／ETL 已有真資料、重跑及 rollback 證據。新增 [隔離回復演練](verification/sales-datamart-recovery-20260914.md) 已驗兩庫還原、226 項對帳及三個最小權限登入。DataHub 官方管理登入與 Source/Secret 名稱讀取已成功；七表 metadata-only canary 已依核准完成，Source version 4，單次 SUCCESS、7 Dataset／88 欄位含本次 runId 已讀回；不冒充 Discovery／Grafana／Agent E2E。

- [x] 定位恢復後 MSSQL 版本／instance／AdventureWorks2019／SalesDatamart；原部署不接管或覆寫其他物件。證據見環境文件、ETL receipts 與隔離回復報告。
- [x] 盤點七個 Sales／Production 候選 tables 的聚合範圍／筆數／日期／狀態／CurrencyRateID及key／orphan checks；必要欄位與PII排除仍由ETL schema契約另定。
- [x] 已界定本次靜態還原樣本／單次人工執行與 native SQL timeout 30 秒、login 5 秒；未啟 snapshot isolation／Query Store／profiling。分次讀取不宣稱跨表 snapshot 一致性；ETL 有界執行缺口留 DM04 補，不冒稱已具備。
- [x] 已定位 Grafana :3000／org1／13.1.2；本案 folder `dataflow-discovery`、datasource `dataflow-salesdatamart`、dashboard `dataflow-sales-v1` 已定，舊資產不接管；實際部署／碰撞檢查與查詢屬 DM05。
- [x] 核對本機 backup 並完成 restore；恢復後資料放入 named volume。兩庫新 COPY_ONLY 備份已在隔離 named volume 還原、驗 checksum／physical CHECKDB／資料／DB 權限，重建同 SID 的三個必要登入後真登入通過；不宣稱 master／jobs／原密碼完整還原。見 `recovery-drill-20260914T040138Z-15381e52-verified.json`。
- [x] source reader／loader／Grafana reader 權限與負例已核；native canary 證明現有 Source/Sink Secret refs 可用，未另讀值或改密碼。可信 operator／原生 Actions 持有寫入能力，不交給 Agent runtime。
- [x] SQL image digest、Core／CLI、Grafana／driver 版本及既有原生擴充點已記錄；平台實際相容性另由 DM02 驗，Grafana 部署由 DM05 驗，不以版本字串替代。
- [x] 已界定本案 Host root／九檔 source allowlist 及模型 privacy 核准：ETL／SQL／無秘密 BI 設定與 metadata，不送資料列／秘密／其他 source，不新增 provider。真 Agent 接線留 discovery-skill／DM07，不再拖住環境里程碑。

完成證據：非秘密環境、scope／權限／備份與操作批次見環境文件及隔離回復報告。DataHub Source `a513e611-5631-4cf2-8b96-3fa9fd1fee51` 核准前為 version 3／開 profiling；目前已為 version 4／七表 metadata-only。七表、30 秒 query timeout、停用 profiling／stateful deletion 的 canary 提案 hash `37002133b89a16959e7360e7caeb5041f73077b5ef61010d598d915e8b58be86` 已離線驗 SDK config／allowlist，**已依限定核准完成 Source conditional 更新、唯一 execution `597819ae…` SUCCESS、7 Dataset／88 欄位讀回**。DM01 已結案；其餘相容性／整合依下列 task 驗收。

### DM02 — 星型模型、指標與官方擴充點相容性

最新：[DM02 模型／Grafana 模板修正與離線相容性](verification/dataflow-discovery-dm02-compatibility.md)。19 tests PASS 是原生 connector 的 fixture/file-sink 與分析器測試，**不是 live SQL／column lineage／發布驗收**。原 panel 無 datasource 會產生無 inputs 的 Charts 已重現；缺 Catalog graph 的 datasource fallback 明確不算成功。專用 Grafana 已完成建立與 v1→v2 條件更新／讀回；真 browser matrix 8場景全部通過。精確數值為75284 facts／17489 orders／178425 quantity／72418506.319091 amount／4140.803152 AOV。仍缺的是 DataHub 主線相容性，不是 Grafana 登入或外觀。

- [x] 完成四個 dims＋`fact_sales_order_line` DDL 設計：粒度、surrogate/business keys、唯一鍵、外鍵、decimal、索引、Type 1 與合法 unknown member；已依實際 DDL 核對，建置／ETL 負例另屬 DM03／DM04。
- [x] 已在`metadata/metrics.md`／實際ETL與Grafana定義sales amount／quantity／distinct orders／AOV、日期／狀態／local-currency／rounding／容差，不重複Header稅運費或誤加distinct指標。
- [x] reporting view、四類七panels、filters與期望值已定義並真SQL／browser對帳；必要空日期／篩選負例已驗，完整來源品質負例另列data-safety。
- [ ] 最小真canary **部分已驗**：1 DataFlow／3 DataJobs／13 direct SQL input-output／Flow包含及原生UI/reload已過。Job依賴與Chart／Dashboard原生metadata部分尚缺，不勾整項。
- [ ] 驗固定版 Grafana connector 的 MSSQL datasource mapping、per-panel Dataset、macro SQL、欄位解析與 URN 對齊，不以 basic fallback 當成功。2026-09-15原生schema多產12欄；使用者另准既有插件內最小修正後，adapter以官方SQL投影將7個schema由26欄、Chart由27引用均修正為14。recorded Catalog離線核對通過（12 PASS＋1原生已知expected failure）；未做live ingestion／部署／發布，未改Core或SDK。見DM02 verification。
- [ ] 驗 run 紀錄／ACL／版本／Task-Decision 關聯，以及所需 Aspect patch／conditional writes 與人工 metadata 保護；缺口明列，不新增狀態庫。

完成證據：核准模型／指標契約、真公開 API 讀回與原生 UI 導覽。非全量業務載入；不將 canary 當最終 E2E。

### DM03 — Datamart 建置程式與目標建立

- [x] 交付版本化 SQL DDL、views、必要索引及最小權限配置範本；DDL 與日常 ETL 分開。
- [ ] 隔離測試建置、重複執行拒絕／安全處理、既有同名物件保護與非法 schema 情境。
- [x] `SalesDatamart`、`dm`、`reporting` 及必要物件已依核准建立、真讀回並完成後續備份／隔離回復。
- [x] source／Grafana／loader 權限負例已核，來源 before/after 一致；見隔離回復的 ACL 證據。

完成證據：真 schema／keys／privileges、來源保持證據及建置 receipt；不刪庫驗回滾。

### DM04 — Python ETL coding 與真資料驗證

- [ ] 實作有界 extract、dimensions Type 1／穩定 keys、fact 範圍載入、commit 前 validate 三個 logical jobs。
- [ ] 交付已固定依賴、無秘密設定範本、版本／digest、執行與停止行為說明。
- [ ] 加入可重跑測試：decimal／rounding、合法 NULL／unknown、orphan、duplicate、粒度／fan-out、空來源、範圍縮小不誤刪。
- [ ] 實作目標 transaction，重跑不重複、失敗 rollback／保留舊資料，禁止平行重複寫入；不新增 worker 或 watermark state store。
- [x] 經核准執行真擷取／載入，以相同 scope 對帳：75,284 facts／17,489 orders／quantity 178,425／金額 72,418,506.319091／AOV 4140.803152。
- [x] 正常、rerun、before_commit rollback 三份真 receipts 已有；同輸入不重複、rollback 保留舊 rows／金額，不盲目重播。

完成證據：真 SQL／Python 結果、來源／目標對帳及失敗恢復；只產生 SQL／metadata 不算完成。

### DM05 — Grafana 真 dashboard／charts

- [x] 交付無秘密版本化 dashboard JSON、七 panel SQL、datasource／folder 設定；現已部署。
- [x] 經核准建立本案三資產，UID固定、datasource非預設；dashboard現v2，v1備份保留，未改其他專案資產。
- [x] KPI／每月趨勢／商品分類／區域銷售四類七panels真查詢與數值已驗；首月座標落在範圍外的問題已修。
- [x] 原生All／單選／多選／組合／歷史日期／空日期共8場景PASS，空聚合NULL與0分開；非USD宣告。這不是來源中所有NULL／unknown資料變體的驗收。
- [ ] 真browser／SQL對帳與匿名401已過，既有SQL reader最小權限證據沿用；authenticated non-owner／完整folder-datasource權限邊界尚缺。使用者要求停止額外UI精修。

完成證據：實際 dashboard／panel identifiers、查詢數值及瀏覽器操作；不只靜態 JSON。

### discovery-skill — 唯讀 snapshot 與 DataFlow Discovery 分析

已交付[snapshot library](verification/dataflow-discovery-snapshot.md)、SKILL.md、Host／validator、Git commit/dirty及[真Agent唯讀入口](verification/dataflow-discovery-agent-readonly.md)。九檔485候選／46unresolved與工具／模型／reload結果一致；完整欄位語義及後加Python分析仍由discovery-validator整合，不再說Skill只有snapshot文件。

- [x] 有界唯讀 snapshot、allowlist、敏感檔／symlink防護、file／snapshot digest、可用commit及dirty標記已實作並驗證。
- [ ] 實作 Skill 指引與必要的真工具接線；從實際 Python ETL／SQL／schema／Grafana 設定探索 I/O、process、必要呼叫鏈、型別、欄位轉換與消費關係，不只有提示文件。
- [x] 已定義中立assets／processes／types／relationships／field mappings／governance proposals／evidence／unresolved，並綁candidate digest、scope、定位及analysis version；不等同完整語義正確。
- [ ] 通用 Skill／工具不 hardcode AdventureWorks／SalesDatamart table名、公式或關係清單；案例名稱只在ETL／案例設定，不把golden mapping餵給Skill冒充分析。
- [ ] 明列本版Python／SQL／MSSQL／Grafana支援語法／API與限制；generated欄位不虛構來源、call graph不等同lineage、動態未知不猜測。
- [ ] 驗真資料流分析輸入／工具／候選與安全負例，源碼／metadata註解不成指令，不執行待分析repository程式。

完成證據：真Skill分析receipt與候選、證據定位、source-bound digest及安全正負例。不是任意Python全框架通用宣稱。

### discovery-validator — Host 驗證與非 hardcode 證據

- [ ] 驗候選格式、snapshot／file／candidate版本、證據位置／有效性、URN／schema／scope、方向／欄位映射及既有Catalog衝突。
- [ ] 用獨立可重跑檢查驗語義，不將同LLM自我確認、schema-valid／digest相符或parser confidence當整體正確率；靜態支持與真run成功分開。
- [ ] 技術lineage與治理候選分開preview／核准；未解析／缺證據項不得自動發布正式可信lineage。
- [ ] Golden預期與分析輸入分離；有界改名／轉換修改應改變結果，舊證據／偽造位置／動態未知必須拒絕或unresolved。
- [ ] 驗合法候選能進發布preview、非法候選被拒，必要欄位缺口不以手寫mapping或table-only fallback補成完成。

完成證據：真候選驗證與preview、獨立預期及變更／負例結果，證明不是靜態答案表。通用Host不耦合案例名稱。

### DM06 — DataHub metadata／lineage／語義發布

- [x] 官方MSSQL native來源／target canaries已完成：13datasets／149欄與view 24欄位lineage讀回；重整後列catalog-native，不再重做。
- [ ] 以公開 SDK/API 建 DataFlow、三 DataJobs、所屬／相依／input-output；run 綁定真版本、scope、擷取時間及資料提交結果。
- [ ] 使用 DataFlow Discovery 已驗候選，核對Python欄位mapping、generated來源說明、SQL parser結果與證據digest，經人工核准發布；手寫mapping只在測試作獨立預期。
- [ ] 先 preview，再分別核准技術 lineage 與 domain／terms／tags／必要 properties；描述粒度、公式、Join、可加總性與 Type 1 限制。
- [ ] 指定 Aspect writer ownership，驗 metadata merge／conditional 更新，不覆寫人工內容／其他 edges。
- [ ] 用官方 Grafana connector ingest 真 dashboard，核對 `MSSQL view → panel query Dataset → Chart` 與 Dashboard 包含關係。
- [ ] 從 Grafana 指標追至 source columns，逐段核對 URN／欄位／方向／證據；列所有 unresolved，所需欄位鏈未全通不結案。
- [ ] 驗 metadata 發布部分失敗、schema／版本衝突、重跑去重、scope 縮小與人工內容保護；只補失敗階段，不重載已成功資料。

完成證據：真 API readback＋UI 關係、治理內容與權限；emit ack 不算完成。Join 不偽裝成 lineage。

### DM07 — Agent Discovery／固定 ETL 與可信人工核准

- [ ] 真Agent發起核准scope的DataFlow Discovery，查候選／evidence／unresolved／Host驗證結果／preview，提案metadata發布而非直接寫入。
- [ ] 檢查既有 Registry／Task／Decision／Host 能力；僅補Discovery與固定 ETL 單次入口的必要接線，非通用 shell runner。
- [ ] Agent 只提已登錄分析／ETL ID、版本與有界scope；可信Host綁actor／source／target／snapshot／candidate／ETL digest／期限並於提交前重驗。
- [ ] 實作查狀態／品質結果與 metadata refresh；不把 metadata ingestion 當業務 ETL 執行。
- [ ] 真正驗證非 owner／匿名／過期核准／版本漂移／任意 endpoint 或 SQL／重複提交拒絕，合法核准能成功。
- [ ] 驗停止與程序失聯：不把關閉 Task 當停止、不以 UNKNOWN 當失敗可重跑；對帳後再決定恢復。
- [ ] 經授權重新配置可用的唯讀 DataHub MCP；只有必要 entity／relationship 缺口才補公開 API adapter，秘密不進 runtime。

完成證據：真 Agent 操作→可信核准→固定 ETL→讀回結果，包含拒絕與成功路徑。

### DM08 — Agent／WebUI 查詢全鏈路與語義

- [ ] 真 Agent 列 DataFlow／Jobs／輸入／輸出及最新 run／資料時間，附可驗 URN。
- [ ] 真 Agent 從 Chart 銷售額追到 MSSQL 來源欄位，回答 UnitPrice 影響範圍與客單價／聚合限制。
- [ ] 真 DataHub WebUI 查上述五類 entities、schema／lineage／terms，並開啟 Grafana 真 dashboard。
- [ ] 原生 UI 無法單頁呈現時先驗導覽完整性，僅必要時補既有 MFE 關係摘要，不新增圖譜平台。
- [ ] 驗未授權／不存在／metadata 過舊／缺欄位證據時的明確限制，回答不洩漏資料、不猜關係。

完成證據：實際入口、工具呼叫、API 對帳與瀏覽器結果；不能拿 developer CLI／fixture 替代。

### DM09 — 整合验收與交付

- [ ] 重跑整條真閉環：核准 ETL → Datamart 資料對帳 → Grafana 數值；真 DataFlow Discovery → 候選／證據 → Host驗證 → 人工核准 → metadata／語義發布讀回 → Agent／WebUI 關係查詢。
- [ ] 最終來源上核對Skill真工具結果、snapshot安全負例、獨立golden及同資料流變更測試，不hardcode，不把首例通過延伸為全語言能力。
- [ ] 在最終 source 狀態核對所有上述正負例；重用有效證據，僅受影響檢查重跑。
- [ ] 完成 Datamart 隔離備份／回復驗證、ETL／dashboard 版本回復及 metadata 部分失敗操作說明；不破壞來源／歷史。
- [ ] scoped LSP／必要 tests／build、最終 lens all、固定版本與 Core clean；空 diagnostic cache 不當全專案通過。
- [ ] 更新交付 README、非秘密設定範本、實際 scope／已知限制／權限／runbook，敏感 raw evidence 只留 gitignored `.local/`。
- [ ] 建立最終驗收紀錄，逐項附來源版本與證據；自查明示非獨立審查。所有必要項通過才關 `TODO-dc390fa8`。

## 2026-09-15 本地審核接點進展（歷史）

此段是最初33tests時的歷史，不代表目前仍無admission／conditional writer。最新模型0.1.3、一次admission／native CAS／source callback已本地實作，見[盤點](verification/datahub-progress-inventory-20260919.md)及[publication證據](verification/dataflow-discovery-publication-review.md)；production接線／部署仍未完成。

已另准的既有 models／Host 最小演進：LINEAGE／SEMANTIC 分開 review、來源／候選／實際 Aspect 值與版本／expiry digest、拒一般 RESPOND 升格、既有人工對話框與 CAS/history 相容。33 Host/runtime＋22 publisher tests、生成模型／Chromium fixture 通過；`0.1.2` 未部署，draft publisher 未啟用。真來源編譯 caller、一次 admission／目標 ACL／owned-aspect CAS／讀回仍缺，見 [證據](verification/dataflow-discovery-publication-review.md)。沒有重播已成功的外部操作。

## 未解事項與停止條件

- DM01 的來源恢復／scope／權限／備份／Secret refs 已驗，不再列舊阻擋。Grafana目標／測試登入及模型source隱私方向已答，不重問；本批 Grafana 三資產與 dashboard v2 已部署／實測，登入交付已解；後續新增 DataHub Source／metadata、權限或 token 操作另需具體批准。
- 不以hardcode mapping、純文件Skill、刪除Discovery範圍或新增datastore掩蓋阻擋；必要證據不足維持未完成。
- 沒有安全的一致擷取、所需官方 ACL／版本／恢復契約或正確 lineage 支援時，列具體缺口讓使用者決定，不自動建 datastore、降權限或改 Core。
- 明確區分資料成功、metadata 成功、Grafana 成功、Agent／UI 成功；部分結果不能叫完整交付。
- 本版不加入 scheduler；舊 T06／T07 排程及其他未完成驗收仍保留在原清單，不搬入本版假裝必建前置。

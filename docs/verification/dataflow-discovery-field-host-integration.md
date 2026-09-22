# Python 欄位宣告 → 既有 Host／Agent analyze 接縫

日期：2026-09-19。Goal `mtzxzwn6-1zw7vn`／current `discovery-validator`，仍 **10/18 complete**。

## 本輪結果

原來的缺口不是再缺一個parser：`python_lookup_values.bind_python_lookup_values()`已整合query→decoder→record→SQL slot，但`bridge.analyze_page()`只呼叫基礎analyzer，Agent看不到欄位宣告。現在沿同一`dataflow_discovery analyze`／gateway／隔離Python接通既有分析。沒有新解析模組、服務、datastore、工具action或Core patch。

- `native-discovery.mjs`：operator source policy可選`pythonAnalysis`，只有明列entrypoint、source-bound context scopes及metadata model-context approval才啟用。模型不能指定這些值、Catalog、URI、SQL或scope；原基礎模式不變。
- 同一Host使用既有人的session cookie，先核`me`、逐Dataset native grants、固定公開`dataset/batchGet`的key/status/schema與versions，最後再核`me`；每頁重新讀、不跨頁快取、不重試。Catalog讀取共用10s deadline、每response最多1MiB；source/parser沿原30s／512MiB限制，stdin上限128KiB不提高。
- `server.mjs`只把Host origin/cookie交給native邊界。cookie不進Python或Agent；Python只接已授權範圍的native Aspect values/versions，Reader僅記憶體轉官方SDK型別。
- `bridge.py`捕獲／驗snapshot，再執行既有整合分析並分頁。先列56個write-slot宣告，再列19個SQL contexts（含未解、write缺口），最後列可追ref的value nodes；沿原最多10項／44KB頁面機制。
- 欄位頁格式`dataflow-discovery.agent-python-fields/2`（補齊decoder graph見下節），明示`INCONCLUSIVE`、runtime identity/value未驗、`publicationAuthorized:false`。`candidateDigest`是投影格式版本＋整份欄位報告＋Host scope＋Catalog值/版本的分頁摘要，**不是可發布AnalysisResult**；另附`baseCandidateDigest`。原分析1.0.2與publication compiler未放寬。
- 檔案／snapshot／SQL literal位置摘要均保留；Catalog版本改變，即使值不变亦拒舊頁。source改變拒舊隱私批准；重批新source也不能重用舊context scopes。

這是已實作的Host接線，**尚未部署或修改使用中config**。API授權在本輪是fixture，不是已完成真跨Actor或新fresh Catalog檢視。歷史source身份probe只供conditional namespace，不證當前run或override。

## 驗證

可重跑（無憑證、無live呼叫）：

```bash
node --test tests/test_agent_discovery.mjs tests/test_agent_discovery_fields.mjs \
  tests/test_agent_task_records.mjs tests/test_agent_publication_grafana.mjs \
  tests/test_agent_gateway.mjs tests/test_agent_server.mjs

PYTHONPATH=extensions/dataflow-discovery/src DATAHUB_TELEMETRY_ENABLED=false \
  .venv/bin/python -m unittest -v tests/test_dataflow_discovery_host.py \
  tests/test_dataflow_discovery_publisher.py \
  tests/test_dataflow_discovery_python_record_consumers.py \
  tests/test_dataflow_discovery_python_lookup_values.py
```

- **現行81 Node／141 Python PASS**（同日後續控制流程修正，見下節；Python包含全部既有`test_dataflow_discovery_python*.py`及Host／publisher）。最初8項覆蓋完整Host→真Python→欄位回傳、每頁重讀、版本漂移、身份／權限／缺失與重複envelopes拒絕、Host policy與model參數拒絕、source／context漂移、改名＋乘法變更、removed→恢復後合法結果、撤銷不交付。
- source中的top-level `raise RuntimeError`未執行，真隔離parser仍成功；舊基礎模式的檔案sentinel負例亦通過。不拿call graph當欄位成功。
- 八項tests的改名／算式變更為獨立合成同流程回歸，**不是首例九檔所有變更情境已驗收**。
- 九檔實際ETL／SQL／BI snapshot仍`ed276f…`；經`nativeDiscovery`的同一Host呼叫與真隔離bridge，使用歷史Catalog＋HTTP fixture，得到56slots、49有record依賴、8lookup key/value宣告、1423nodes／331unresolved。每個slot及context與已有原始report逐項相同；6頁完整欄位及19contexts均可讀，沒有丟掉LOCK未解。
- 四個變更code檔primary LSP 0 errors。舊Grafana測試的五項SDK imports是已核`.venv`／實際執行反證的auxiliary快取誤報，不為其修改imports，不宣稱全案diagnostics clean。

Private證據在`.local/evidence/dataflow-discovery/`：`field-integration-host-final-20260919.log`、`field-integration-python-final-20260919.log`、`field-integration-case-final-20260919.json`及相應helper/log；早期`field-integration-case-20260919.json`保留但非最終source。case receipt有producer hashes及所有欄位頁／contexts。首次fixture漏`actor`cookie被既有session guard正確拒絕；補合法fixture，不放寬產品身份檢查。其次fixture module-level method call使既有decoder拒絕record解讀，改用top-level raise檢查「只解析、不執行」，不放寬分析器。

## 同日續修：保留 decoder 證據與 graph-local refs

第一版Host分頁只列transport nodes，把原本已存在的`query_decoders.decoder_reports`留在內部。其結果是模型看不到conversion／return／raise／condition宣告，而且`query_decoder.links.read_ref`與transport的`value:N`可能同名卻指向不同節點。實際案例`value:0`在decoder是`decoder_input`、transport是`unresolved`，不能共用一個全域索引。

修正只在既有bridge投影：field／transport rows明示`graphId:transport`；SQL context附`decoderGraphId`；額外分頁回傳每個decoder summary（records／exits／helpers／findings）及原本的nodes，`decoderSections`提供各圖的summary／nodes起始offset。以`(graphId, node.id)`定位，不改寫底層refs或再解析source。格式升`/2`，digest亦綁格式，source/Catalog皆未變的v1游標仍會被拒絕；不讓舊游標靜默查到另一筆資料。第一版未部署，不影響使用中的基本模式。

- 新增紅→綠回歸，證明helper的return／raise／condition、query read_ref及同名不同圖節點都可正確讀取，runtime／conversion flags仍false。
- 真九檔source＋歷史Catalog經同一Host／隔離Python，56slots／49record-linked／8lookup及19contexts保持原值；四個decoder summaries與全部311個decoder nodes逐項吻合舊raw report，沒有增加解析能力或抹掉未解。transport仍1423nodes／331unresolved，不把不同graph分母相加當正確率。
- 最新80tests含v1游標拒絕與合法v2恢復；三個變更code檔primary LSP 0 errors。三項閱讀未改Python模組時冒出的SQLGlot auxiliary import提示也已用專案`.venv`直接匯入核對；最後lens all仍是原五項SDK快取提示，不宣稱全案clean。
- Private：`decoder-evidence-loss-red-20260919.log`、`decoder-graph-host-final-20260919.log`、`decoder-graph-case-20260919.json`／log及`verify-decoder-graph-case-20260919.mjs`。case含最終producer hashes、所有decoder頁與graph定位。先前v1 receipts保留為歷史，JS自動排版造成的舊hash差異以現行完整Host回歸重新驗證，不冒稱舊bytes吻合。

這次修的是**既有證據在接口遺失／ref歧義**；只是讓目前已有的轉換證據可查，仍非數值語義或發布通過。沒有新增parser、資料庫、服務、live讀取、登入檔存取、SQL、模型呼叫或部署。Goal仍10/18／discovery-validator。

## 同日續修：try 的正常延續與例外分支

實際`etl.py:378–383::_as_decimal()`在try body直接賦值；每個handler都raise，最後才return result。既有`_Graph.name()`只比對lexical guards，因return已在try外而錯列`assignment_not_dominating`。現在只承認：**function頂層try、直接body賦值、所有handler皆單一raise、無else/finally、使用點在完整try之後**。保留原有重綁／mutation檢查，不把此判斷當作執行成功或轉換正確。

反例也重現`ast.TryStar`未列guard、吞掉exception group後誤認assignment的缺口；在既有guards tuple加入TryStar，未新增except*分析或放寬支持範圍。

- 三項Python回歸含三種合法raise handler、吞錯／條件raise／mixed handlers／nested if／with／match／except*／else／finally、handler內使用與後續mutation。合法正常延續恢復；不支持的路徑仍unresolved，mutation仍單独拒絕。另加一项Host→隔離Python→decoder節點讀回，核對raise與pass的不同結果及digest，不把兩者混為合法值。
- **141 Python／81 Node PASS**；完整九檔source＋歷史Catalog fixture回放只允許一個精確預期修正：`decoder:_parse_facts`的`value:119`由prior/unresolved改為指向`value:118` quantize call的assignment。其餘310個decoder nodes、四份summary、56slots／19contexts均保持既有結果。quantize result與runtime／publication仍未驗；transport的331 unresolved也沒有減少。
- source及Catalog均未變時，前版v2的舊分頁digest亦被拒絕，因摘要綁完整報告。沒有額外版本架構；field format仍v2。
- Scoped LSP兩個code檔乾淨，Python test檔仍有兩項輔助import提示；正確runner使用`PYTHONPATH=extensions/dataflow-discovery/src`及專案`.venv`已實際跑完141 tests，已登記環境誤報，沒有改imports或停用規則。最後lens all仍有上述兩項及原SDK五項cache提示；不是全案clean。
- Private：`try-assignment-red-20260919.log`、`try-star-negative-red-20260919.log`、`try-assignment-python-20260919.log`、`try-assignment-host-20260919.log`、`try-assignment-case-20260919.json`／log及對應verifier。最新case producer hashes包含變更的analysis library，不只bridge／Host。

回顧：修的是既有控制流程中的資料傳遞判斷，不新增parser／日期層，也未修改ETL本身。所有外部操作仍為零、未部署，Goal保持10/18／discovery-validator；helper實際回傳依賴與僅被求值的arguments如何區分仍需處理，不將其冒充已完成語義。

## 2026-09-19 授權現場預檢：Catalog 成功，Agent 尚未恢復

使用者依序核准獨立 A／A1／A2 的限定唯讀批次；不是部署或模型輸入批准，沒有把 continuation checkpoint 當新授權。每批獨立no-clobber receipt，結束後不重播。

- A驗出九檔snapshot及五個Host/parser producer hashes吻合，讀一次operator config：image仍`78ac783d…`、field mode未配置。在gateway條件不符時停止；未讀憑證內容、未發HTTP。A未保留socket細節，不能回填原因。
- A1獨立觀測`127.0.0.1:9002`有listener、9041無listener，本案scope＋actor容器數為1。Docker projection失敗；新加的leaf-mode-only限制又在fstat後、readFile前停止，沒有讀憑證內容。`protectedReads.credentials=1`是attempt，並非內容讀取。其provisional `AMBIGUOUS_NOT_ADOPTED`也不是實際重複容器證據。
- 已用既有Docker CLI對**臨時mock Unix socket**重現合法bind mount沒有Name時的Go-template失敗，改用optional map index；合成0700目錄內0644檔重現leaf-mode誤擋。移除這個未經現況支持的額外限制，保留exact path／owner／size／no-symlink、秘密不輸出及單次批准；不chmod真實檔案。這些是修一次性verifier，非擴大產品parser或服務。
- A2經新批准，只讀一次憑證內容並登入一次；**17 HTTP全200**：2次me、13次Dataset native grants、1次batchGet，以及登入。相同`readDiscoveryCatalog()`真讀回**13 Dataset／149欄／39 Aspects**，全部未removed、version都是1、value與歷史基線逐值相同。無原始Aspect、密碼或cookie持久化／送入模型；只存counts／versions／hashes。這證明當時datahub actor的Catalog讀取接縫，不證跨Actor ACL、gateway／真Agent或SQL來源身分。
- A2真inspect确认唯一runtime `8094c258dc3abba2b28f4d92ef49e01557e8e2fb40b2e880f0e51f578b7a6a28`：owner／image吻合、HOME mount名稱吻合；exited，exit255、OOM=false，finished `2026-09-15T05:36:16.535412573Z`。1GiB memory=swap、1CPU、UID1000、read-only、network none。**不能據exit255推斷WSL重啟或其他確切原因**。
- A2 volume inspect命令本身成功，但verifier的JSON projection少結尾括號，parse失敗且未保留原字串。因此volume owner仍未完成readback；不重查或用container mount冒充volume labels。已在mock socket重現並修正候選格式，僅離線驗證，沒有再次使用live批准。A2整批仍是PARTIAL，不把Catalog成功擴大成完整預檢PASS。

Private依據：`field-preview-{preflight,reconciliation,final-read}-run-20260919.json`、各批proposal／approval；最新A2為`field-preview-final-read-run-20260919.json`。離線修正：`field-preview-verifier-offline-final-20260919.json`與對應tester；candidate有明確頂層阻擋，不可拿舊approval直接執行。先前A/A1限制摘要由最新checkpoint區分，原receipt不覆寫。

本輪production source未改、未部署、未啟停任何服務、未改權限、未開Agent頁面、模型／SQL／metadata寫入均0。現況優先順序是核對Host reload會帶入的Task/publication相容性，準備**最小的既有Host恢復＋field-preview**操作，再請求精確批准；不得直接啟動整個未驗Host tree、刪HOME或重新建MFE/image。metadata進模型也需另准。只讀Catalog成功不是`discovery-validator`完成，Goal仍10/18。

回顧：一次性verifier的過度權限限制與輸出格式錯誤延遲了現場驗證；已保留失敗並以無憑證fixture修正，而非改服務去遷就checker。後續重用這些證據與既有reader，不再重做已成功的Catalog檢查作進度替代。

## 同日 Host 恢復準備：相容性已檢查，尚待操作批准

已檢查 `server → nativeTasks → taskRecords`，一般 Task 仍寫舊模型欄位；production context 未提供 publication compiler，沒有 preparation／claim／publish JSON action。本輪不部署模型、不呼叫 publication，也不新增 Task／Run。18 個 Host import 檔及 23 個 Python 模組已記錄雜湊；歷史 T07 比較不是 live runtime 盤點。

新跑 **14/14** 欄位／Task runtime 接線測試通過，四個 Host 檔 primary LSP 無 error。欄位 test 的舊 hash 不符，已讀現檔並重跑，不將其假稱格式相等；TypeScript emitter 仍保留部分格式／尾逗號，也不作通用語義等價工具。最後 lens all 的七個 import cache 提示仍在，專案 venv＋明確 source path 已逐一成功 import；未改 imports／規則，非全案 clean。

[待核准恢復方案](dataflow-discovery-host-recovery-proposal.md) 固定原 image／HOME，先驗 volume owner，再限縮清理指定已退出 container、啟動一次既有 Host、只加 field policy，經真 Agent 做一次模型回合／reload／兩個負例；另明確要求 metadata 進既有模型的授權。成功才保留該 actor 的欄位預覽，失敗按指定新 PID／runtime 回復，不重播 A／A1／A2。本輪沒有新憑證讀取、live HTTP／Docker、部署、模型或 SQL 操作。

回顧：這次收斂到既有 Host 的恢復與資料揭露邊界，沒有增加 parser／平台；來源凍結與本地通過僅支援操作提案，不能代替尚未取得的真入口證據。

## 同日已核准批次 B：四個真欄位工具回應，驗收器 timeout 後回復

使用者明確核准後，B 真驗 HOME owner、清理指定已退出 container、用原 image／HOME 啟動 Host，透過 DataHub Agent 入口取得 **四個 Discovery HTTP 200**（list＋三頁欄位／decoder 宣告）。56 slots／19 contexts／311 decoder nodes 與 graph namespace 可見；Catalog digest 仍為既有基線，技術狀態仍 `INCONCLUSIVE`／不可發布。

但驗收器等待預建 session 的 prompt ACK 時未取得完整證據，記錄 `TimeoutError`，沒有讀回實際 UI session／模型最後回答、reload 或兩個負例。B 已依核准 graceful close 新服務、保留 HOME、還原 config；原舊 container 和本輪新 container 均已刪除。**不得重送 prompt 或重播 B。**

離線以真 SDK／原 registry 函式重現：尚未 prompt 的 idle `ensure_session` 不列入 session index；URL 導覽不保證 UI 選到它，而 B observer 卻把它當成 Send 的必然 ID。這是驗收器的責任邊界缺陷，不修改正常的 Pi／DataHub 行為；實際 Send ID 仍須從既有回合確認。詳 [B 收據、回復與診斷](dataflow-discovery-host-recovery-result.md)。

[批次 C 待核准提案](dataflow-discovery-host-reconciliation-proposal.md) 僅恢復同一 Host 並對帳既有回合：不新建 session、不發新 prompt、不重跑四個成功工具呼叫。恢復健康服務與舊回合 E2E 是否完整分開，不將收據缺項冒稱產品失敗或驗收通過。

## 批次 C 最新狀態：服務保留，模型部分回答仍未完成

C 經另批核准，14:47 UTC 已恢復並保留原 image／HOME 的健康 Host 與同一 field policy。真 session 讀回證明 B 的實際 ID 不同於驗收器預建 ID；四份 saved tool results（含 requestId）與 B 真 Host 回應完全相同。舊 digest／注入 catalog 兩負例分別正確拒絕409／400。C 零新 session、prompt、模型生成或成功分析頁重跑。

但既有最後 assistant 為 `stopReason:error`：只保留到三個 digest、56／19／311、INCONCLUSIVE／false與namespace說明，後半decoder鏈與完成標記缺失。不是完整回答漏存，亦不能推定是rollback造成；C projection未保存errorMessage，原因待精確讀回。未做回答reload，不宣稱完整E2E。見[C結果與目前保留狀態](dataflow-discovery-host-reconciliation-result.md)。下一步只需限定查此錯誤，不再次恢復服務或重送模型。

## 使用者詢問擴架構後的本地核對：表級交付缺口

本段只核對現行 source／原 Goal，不是新的架構批准或 live 操作。Goal 原要求已包含 snapshot、Python／SQL／BI 分析、Host validator、技術／語義分開審核及官方發布。因此這些能力本身不能一概列為擅自新增；模組拆分、分析深度與交付順序則是實作選擇，需要對結果負責。現有 approval receipts 可核對已執行批次，不能追認每個模組設計。root 多數檔案仍 untracked，無完整 Git 逐次差異足以證明每次新增都經批准。上游 Core 本次本地 status 為乾淨。

**現行 source 已確認的斷點，不是泛稱「尚未驗收」：**

1. `python_record_consumers.py::bind_python_record_consumers`／`python_lookup_values.py::bind_python_lookup_values` 產出帶 producer invocation／record／lookup 證據的宣告。`bridge.py::analyze_python_page` 將它們投影為欄位／context／graph 分頁，明示不是可發布的 `AnalysisResult`。
2. `publisher.py::validate_publication_binding` 只接受可由原 analyzer 重現、端點精確符合的 relationship candidates；目前不能把上述分頁直接交給 publisher，也不能將 SQL process 的證據任意改掛到 Python Job。
3. `compile_publication_mcps` **已支援表級 Dataset → Job reads／Job → Dataset writes**。`native_column_compilation_unverified` 只在提交 column_mapping 時拒絕，並非所有表級發布都必須等完整欄位分析。先前的耦合主要是交付順序與候選接線缺失，不應透過移除這個檢查解決。
4. `server.mjs` 的真 Task callback 沒提供 `recompilePublication`；本地 publisher／review 能力未形成正式完整 caller。既有 canary 的13條 direct SQL I/O不能冒充補齊後的關係。

**從 ETL 原始碼人工核對的獨立預期（不是 Skill 產出，不得餵回 compiler 當答案）：**

| Job／資料用途 | 應追蹤的跨函式資料 | 重要限制 |
| --- | --- | --- |
| load_dimensions | `extract` 的 Product／ProductSubcategory／ProductCategory → products；Customer → customers；SalesTerritory → territories，再被 `_load_dimensions` 消費 | 四個 dim 的直接SQL讀寫保留；不能將 Job 的所有 inputs 與 outputs 展開成所有表對所有表的 lineage |
| dim_date 的生成 | `_date_rows(scope)` 從 scope.start_date 到 end_date 產生日期 | **不是從 SalesOrderHeader 的訂單日期生成**，不能為補齊圖而造這條來源邊 |
| load_sales_fact | SalesOrderHeader／SalesOrderDetail → extracted.facts；`_load_dimensions` 回傳的 product/customer/territory key maps → `_load_facts` 的 lookup inputs | 三個 maps 源自相應 dim 的查詢；fact 的直接 upsert I/O保留；lookup依賴不等於任意欄位直接來源 |
| validate_datamart | fact／dim_date／reporting view 的直接讀取，加上 extracted.facts 的對帳摘要 | 是驗證／比較依賴，沒有 Dataset 寫出；不能畫成此 Job 產生 reporting view |

依據：`etl.py` SQL constants L127–342、`extract` L550–570、`_date_rows` L573–589、`_load_dimensions` L598–690、`_load_facts` L693–720、`_validate_target` L736–760、`run_etl` L794–850。`run_etl` 在 transaction 前 extract，再把同一 extracted 與 key maps 明確交接；dry_run、engine override、guard 與 runtime identity 仍須保留界線。這份人工預期不證明現有 Skill 已可靠推導所有交接。

**收斂方向：** 在既有候選／validator／publisher 的接點補上有來源證據的 Job 表級 I/O，先用上述獨立預期與改名／交接變動／假來源負例驗證；不新增解析層、Job、服務、datastore或另一個 writer。未證明部分留 unresolved，不強制解完所有欄位才交付已驗證表級關係。最終接既有可信核准／conditional write，另取得精確 mutation 與部署批准，再讀回真圖。完整欄位／語義／Agent 要求不刪除，也不改 Goal task tree。模型摘要錯誤另外保留，不再作表級候選接線的前置。

本次未改 production/test source、未重啟／讀憑證／呼叫模型／寫 metadata；未把此核對視為獨立 review 或任務完成。

## 剩餘完成條件與下一步

1. 優先補齊上述表級 Job I/O 的 source-bound 候選／validator／publisher 接縫，配獨立預期與變動負例；不能用人工預期替代 Skill 推導、改掛 SQL process 端點或刪除安全檢查。
2. 必須按真正入口／branch／override限定建立Host scopes，非由model或Catalog唯一命中猜出；當前案例scope仍沿既有條件式診斷。
3. 331個unresolved、日期生成、helper成功guards／conversion／rounding、lookup唯一／成功匹配仍不是已驗欄位語義。留在原完整完成條件內，在既有模組收斂，不再新增逐層parser；不將這些未完項全部當成已證明表級關係的前置。
4. C 批於9/19 14:47 UTC已恢復並保留 Host／field policy；這取代早期 gateway 無listener的現況描述，不代表未來持續健康。四份模型工具結果已讀回，但最後摘要error與回答reload未完成。A/A1/A2/B/C均已關閉；新登入、模型／服務或metadata操作仍须精確批准，不能重播。
5. 宣告報告不可直接當writer的正式mapping。完整技術／治理preview、独立預期驗證、人類核准、conditional publisher與真UI圖讀回仍由原任務驗收；不以本地接線或HTTP200關閉任務。

自查而非獨立審查；Core保持clean，無commit/push。回顧：這次把既有分析結果真正接到使用中的協定，而不是再累積孤立library；輸出「可檢視」與「可發布」仍嚴格分開。

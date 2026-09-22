# DM02 — 模型與固定版相容性（進行中）

2026-09-14。Goal `mtzxzwn6-1zw7vn`：current `dm02`，2/12 complete。
本輪是主會話驗證，不是獨立審查；**Grafana 已可用，完整 DM02／DataHub 主線仍未驗收**。
未重做建庫、ETL、DM01 ingestion，未修改 Core；Grafana 三資產／v2 及 DataHub target metadata canary 均按各自具體核准完成。

## 2026-09-15 分開的 publication review（本地／未部署）

經另准，在既有 Task／Run models `0.1.2`、Host 與人工對話框加入 LINEAGE／SEMANTIC 分開審核，綁來源／候選／實際 Aspect 值與版本／期限，一般 RESPOND 不能升格。33 Host/runtime tests、22 Python draft publisher tests、生成模型／舊記錄 roundtrip、本地 Chromium approve/reject 與歷史流程通過；source format `/3` 修正未來批准時間改變預覽摘要的問題。

僅可信 Host 的內部編譯 caller 能追加提案；該真來源 caller、一次發布 admission、fresh ACL／owned-aspect CAS／完整讀回仍未接。没有 metadata writes／部署／憑證存取，不重播 canary。**不是安全發布或 DM02 完成**；完整界線與證據見 [publication review](dataflow-discovery-publication-review.md)。以下保留各階段歷史。

## 最新狀態：停止 Grafana UI 精修，轉回 DataHub／Agent

使用者最新指示：Grafana 只要可用；目的是測試 DataFlow Discovery 能在 **DataHub WebUI 與真 Agent 正確呈現**。不再新增外觀工作。以下初期「未部署／待登入」記錄僅為歷史，不是目前 blocker。

- org1 的 folder `dataflow-discovery`、datasource `dataflow-salesdatamart`（id3、非預設）、dashboard `dataflow-sales-v1` 已建立／讀回，health OK；登入交付已解。未動其他資產。
- 使用者另准 v1 條件更新：年月分組不變，月座標用首個已選日期，修復首月點落在選定起日前；必要可讀性調整一併完成。原生 version1／overwrite=false 僅送一次，現 v2，原 v1 JSON 保留。
- 首次更新 checker 以 JSON 字串比較，誤把 key 排序當內容差異；只 GET 對帳，以 deep semantic comparison 驗七 panels 的 targets／gridPos／fieldConfig／options／datasource 完全相同，未重送更新。最終：`dm02-grafana-dashboard-v2-verified-20260914.json`。
- `grafana-browser-matrix-2026-09-14T07-25-52-455Z.json`：8場景各9個真 query responses全部通過（All、分類單／多選、區域單／多選、組合、六月、空日期）。All：75284 facts、17489 orders、178425 quantity、72418506.319091 amount、4140.803152 AOV、38月。各場景月點均在範圍内；空日期amount/AOV為NULL、orders0。
- 原生 frame 的時間欄位是 `Time`；zero-row grouped SQL 回空 fields/values，不能拿來覆寫 Catalog schema。這兩項初期 checker 假設已依實測修正；失敗 receipts 保留。
- 原生 `Product category` combobox 真選 Bikes，再加 Accessories，關閉下拉後 URL／KPI更新：`grafana-v2-selection-commit-20260914.json`。初用 Escape 期待提交未成功，沒有把它當 apply 或改原生元件。
- 真 scroll 顯示品質表：`grafana-v2-ui-probe-20260914.json`／`grafana-v2-quality-visible-20260914.png`。數值精度以原始 frames／對帳為證，不以顯示捨入取代。三資產匿名API皆401；authenticated non-owner及所有來源NULL變體尚未驗。
- 可重跑 `node scripts/verify-grafana-sales-datamart.mjs --verify-approved-dashboard`；固定本案9查詢、每case bounded等待所有 responses、清理自有browser/temp HOME。`--empty-dates-only`可只重驗空資料case。它不是Agent任意SQL能力。
- 19個原生connector fixture／analyzer tests仍PASS：`dm02-grafana-render-fix-tests.log`。JSON LSP曾報第158行EOF錯誤；當前檔僅157行，Node JSON.parse及tests均成功，記stale差異，不修改正確JSON。
- DataHub唯讀前置：Actions實測可達 `host.docker.internal:3000/api/health`／13.1.2，不需另起代理或改網路；host listener實為 `*:3000`，不是loopback-only部署保證。
- 初次6個target schemaMetadata為404；後續限定批次已核准並完成：原生Source `c382a4fe-48a9-4a0b-893a-95029a74b25f` version1、CLI1.7.0.9、無schedule；沿用兩個既有Secret參照。唯一execution `f2ce4ab4-1892-4936-9ac5-f2bd0370f3cb` SUCCESS。
- 最終 `dm02-target-datahub-verified-final-20260914.json`：6 datasets／61 fields／5 view上游／24 column edges PASS，schema的runId、頂層pipelineName、lastObserved亦一致。`tests/verify_sales_datamart_native_metadata.py`對照SQL metadata與001 DDL獨立golden，可重跑file-sink及API readback；這不是Skill／Agent驗收。
- Native最小權限已实测：既有datahub_ingest只新增SalesDatamart DB user、六物件VIEW DEFINITION；SELECT/DML/ALTER被拒，原密碼／AdventureWorks權限不變。真reader取得metadata／view definition，TOP(0)讀表與view皆229，沒有業務資料列讀取。grant成功後未重跑。
- 實測辨別了三項checker／adapter差異：sqlcmd severity0資訊行用原生-m1處理；SQLServerSource先lowercase再filter，兩個pattern prefix改canonical小寫但仍只六物件，最終recipe hash `57d0a19e3e8b92b0bbe7c4497c043ae0abb11d7bc3226650ccd55eb1e935e674`；GraphQL entity(urn)會回不存在實體的typed reference，改依官方SDK exists的key-aspect契約並用已知dataset作正控制。各失敗均在mutation前停下對帳，未重送成功操作。
- 原生file sink混用MCE與MCP，包含6 datasets／3 containers／1 view query；不能全按MCP解碼，也不能把初期只產containers的流程成功當通過。`dm02-target-native-reconciled-run-20260914.json`保留唯一原生run及完整讀回。
- 真DataHub WebUI已開該view：Schema入口導向Columns，顯示24欄位、Number/Date/String、nullable、view definition及Depends on 5 tables；無pageerror。`dm02-datahub-schema-ui-20260914.json`／`dm02-datahub-view-schema-20260914.png`。不以這個原生view展示宣稱Discovery DataFlow／DataJob／Agent已完成。
- 未建立service account／token。上述DataHub Source／DB權限／metadata寫入使用另外明確批准的target canary，不是沿用Grafana批准。其他發布／credential操作仍需對應授權。
- 固定九檔重新執行Skill Host分析：485候選（46 unresolved），snapshot `ed276f258ceed74e491d85b16d8e54da9408cc9484b44a3bbccf8e4aec1af77f`，`discovery-after-native-target-20260914.json`。這仍是Host呼叫，不是Agent入口；舊snapshot／approval不可沿用。下一段為Discovery的Catalog身份、typed核准／publisher、DataFlow／DataJob與Agent接線。

所有上述 receipts 位於 gitignored `.local/evidence/dataflow-discovery/`。Goal仍current `dm02`／2of12。另以既有readback的記憶體副本驗4個負例：錯field owner／缺column／錯nullable／stale run皆拒絕，無網路／寫入（`dm02-target-verifier-negatives-20260914.json`）。

## 2026-09-15 最小 schema 相容修正已完成（本地／離線）

使用者核准「依你建議做」，範圍仍只有既有插件內的最小修正與離線驗證。新增 `extensions/dataflow-discovery/src/dataflow_discovery/grafana_schema.py`，沒有改Core、SDK安裝碼、部署或Agent入口，也未新增解析框架／服務／datastore。

修正重用官方 `DataHubGraph.parse_sql_lineage()` 與既有SQLGlot，從真正SQL投影取得欄位集合；先透過既有 `resolve_dataset()` 核physical table的Host scope／key／status／schema，再核每個來源欄位。原生ViewProperties經官方formatter排版，故比較保留literal／identifier的SQL AST序列化，不要求原始字串空白相同。原生query／Chart inputs／lineage不符即拒絕，不自行補造關係。

- 七個query Dataset的schema由 **26欄修正為14欄**。Chart inputFields也由 **27引用修正為14引用**：原生monthly panel另有一個重複time，不能只修schema留下無效引用。
- 依投影選取欄位並重建同一schema的Chart引用，**真實SQL欄位若名為time或value_none會保留**，不是名稱黑名單。
- 只改待審批次的7個schemaMetadata與7個inputFields，其餘Aspects與原輸入不變；重套結果一致。中途任一panel失敗，不回傳部分批次。這不是DataHub多Aspect寫入交易，也不提供發布授權。
- 支援SDK1.7.0.9／SQLGlot30.12.0、MSSQL、單SQL target、explicit single SELECT、無panel transformations／platform instance。SELECT INTO、跨scope、空schema位置、missing/removed/key/schema/column與來源漂移等拒絕；沒有擴充macro語法或Python解析。
- SDK推斷的資料型別／nullable原樣保留，**本輪不宣稱runtime型別、精度、NULL、macro執行或業務filter語義已驗**。Host freshness／ACL／分開核准／owned-aspect CAS與讀回仍須接線。

實際保存的六Dataset Aspects透過HTTP fixture提供，非mock parser答案：`grafana-schema-adapter-verified-20260915.json` 為 `OFFLINE_RECORDED_CATALOG_SEVEN_PANEL_SCHEMA_AND_CHART_FIELDS_PASS`；逐panel核14輸出宣告、上游存在於recorded view的24欄、Chart欄位內容／URN一致、其餘Aspects未變。來源hash與可重跑helper `verify-grafana-schema-adapter-20260915.py` 同存private evidence。**recorded不等fresh，0 live HTTP／credential／SQL／metadata writes。**

最終回歸：`grafana-schema-adapter-final-20260915.log`，**12 PASS＋1原生connector已知expected failure**。新增6個adapter測試涵蓋恢復、合法同名欄位、不支援輸入／跨scope在adapter讀取前拒絕、Catalog失效、最後panel漂移不修改輸入、SDK／parser未驗版本拒絕。

Scoped LSP的auxiliary環境仍報missing imports及其衍生None型別訊息；使用同一已安裝Pyright、明確project `.venv`與PYTHONPATH核對，**三個本輪Python檔0 errors／0 warnings**，證據 `grafana-schema-pyright-final-20260915.log`。確實存在的測試MCP泛型縮窄問題已改用官方Aspect型別檢查；沒有為環境誤報修改產品isinstance條件、既有strict False或歷史canary。

### 未來 connector 再出問題／升級方式

1. 原生connector是輸入，不是正確性保證；每個升級候選先跑相同原生與adapter契約，不只看pipeline SUCCESS／版本字串。
2. 未驗SDK／SQLGlot版本會拒絕。必要差異只集中於現有adapter；未知shape／lineage／scope不符停止準備，不猜欄位、不擴充框架。
3. 上游修好時，原生expected-failure測試會出現unexpected success，提示重新驗證；原生schema及Chart契約全部通過、確認不再需要補正後移除adapter，不永久堆疊補丁。切換使用中版本／部署另須批准。

**這一項本地修正已完成；DM02／2of12仍未整體完成。** 尚無live Grafana ingestion、通用Host typed核准／安全發布與完整Agent讀回；既有canary批准仍已耗用，不重播。

## 2026-09-15 Grafana 離線原生產物檢查（相容修正前）

沒有新增解析器、產品接線、服務或datastore；只擴充既有 `tests/test_sales_datamart_grafana.py` 的HTTP fixture，使用公開 `Pipeline.create()`、官方Grafana source／SQL parser及file sink。外部HTTP全部被fixture替換，沒有credential讀取、真SQL、ingestion、metadata寫入、模型或部署；原canary批准仍已用完。

- 將已保存的canary六Dataset schema作為HTTP唯讀回應。實際SDK走 `POST /openapi/v3/entity/dataset/batchGet`（讀取，不是mutation），exact scope只有reporting view的schemaMetadata；不是mock SQL解析答案。該view有24個原生fields；**recorded讀回不是fresh Catalog**。
- 七panel均指向正確的 `salesdatamart.reporting.v_sales_order_line`，14個輸出欄位宣告逐一對照七個SELECT的獨立期望，所有非空上游field URNs亦存在於recorded schema。COUNT_BIG(*)的line_count宣告上游為空，不造實體`*`。這是靜態資料值來源，不是macro執行、filter／業務語義或live發布驗收。
- **原生schema卻產生26個fields，而非14個，合計12個額外欄位；七panel的shape都不符合查詢輸出。** Panel1–3、5–6多`time`與`value_none`；panel4多`value_none`；panel7多`time`。SQL alias `time`與Grafana frame顯示`Time`屬不同表示，沒有將後者誤列成缺欄位。
- 因果來源已定位在固定SDK的 `grafana/field_utils.py`：`extract_time_format_fields()`對`table`及`time_series`一律加入time；`get_fields_from_field_config()`將顯示unit="none"變成value_none。`extract_fields_from_panel()`把這些展示設定產物合併進SQL schema。**不刪除正確dashboard格式／unit來遷就connector，也未改安裝碼或Core。**
- 空Catalog負例仍會產生推導出的column edges：pipeline SUCCESS／confidence本身不能證明欄位存在，更不能取代Host的Catalog／ACL驗證。

可重跑：`DATAHUB_TELEMETRY_ENABLED=false .venv/bin/python -m unittest -v tests/test_sales_datamart_grafana.py`。
結果 **6 PASS＋1 expected failure（正確panel schema契約仍未滿足）**；沒有把expected failure算成通過驗收。

Private證據在 `.local/evidence/dataflow-discovery/`：

- `grafana-schema-fixture-tests-20260915.log`。
- `verify-grafana-recorded-schema-20260915.py`：傳入新的output path可離線重跑，不覆寫舊證據。
- `grafana-recorded-schema-verified-20260915.json`：`OFFLINE_RECORDED_SCHEMA_ORIGINS_PASS_PANEL_SHAPE_BLOCKED`，含輸入hash、逐panel的expected／actual／extra欄位與exact上游。
- 初版fixture先漏掉GMS config的字串noCode契約，之後誤假定schema使用GET，均只修HTTP fixture；`grafana-recorded-catalog-first-20260915.json`不是Catalog解析驗收證據。

Scoped primary LSP乾淨；三項auxiliary missing-import與同一`.venv`的實際SDK載入／上述測試不一致，按環境誤報記錄，不改正確imports。上游仍為原固定commit且clean。

**DM02仍未完成。** 後續需在既有插件／官方公開擴充點範圍決定最小schema相容性修正；不得靠名稱刪欄位、放寬shape驗收或再建立解析框架。修正與新的精確發布範圍尚未核准，這批沒有安排live Grafana ingestion。

## 2026-09-15 原生 Flow／Job canary 已完成（限定範圍）

使用者先核准提案 `b351967f…`。唯讀preflight發現Python平台key/info皆404，MSSQL正控制皆200，因此先停止；使用者另核准補充 `69494081…`，才新增一筆官方Python平台標識。這不是新增Python服務、插件、datastore或架構。

實際完成兩次同步conditional API請求：先1個`dataPlatformInfo`，再原18個Flow／Job Aspects；**5個實體共19個明確新Aspect，逐一精確值／版本讀回**。所有新Aspect使用`If-Version-Match=-1`，登入身分、逐URN有效grants、source/candidate digest、absent keys/info及六個target Dataset的key/status/schema先重驗。六Dataset的上述完整envelopes（含systemMetadata/version）前後一致。沒有重送metadata或修改既有Dataset Aspects。

| 原生 Job | direct SQL inputs | outputs | UI可見Dataset節點 |
| --- | ---: | ---: | --- |
| load_dimensions | 4 | 4 | dim_customer、dim_date、dim_product、dim_territory |
| load_sales_fact | 1 | 1 | fact_sales_order_line |
| validate_datamart | 3 | 0 | dim_date、fact_sales_order_line、v_sales_order_line |

真GraphQL核對全部13條I/O及3個Job各自的Flow；原生UI `pipelines/.../Tasks` 顯示Contains 3 Tasks，逐一點入Jobs並驗Lineage節點可見，reload仍保留。3個Job／13個edges一致、pageError0、HTTPerror0。圖中的read/write self-cycle來自upsert直接SQL讀取，不是補造跨庫source lineage。

權限檢查初次誤要求user.props本身0600；查明`init-local.py`刻意給container bind mount用0644，Host父目錄0700。修正的是operator檢查：pin owner-only directory，拒symlink、非owner、群組/其他人寫入、非regular或hardlink；**沒有chmod或更換憑證**。首次UI selector未限主tablist，實際有主頁與側欄兩個Lineage tabs；只修驗證helper。首批截图在canvas載入中，後續以web-first等待實際Dataset文字並讀圖確認節點，沒有重寫metadata。

證據均在 `.local/evidence/dataflow-discovery/`：

- `dm02-native-flow-job-canary-run-20260915.json`：兩次write、19個exact readback及六Dataset before/after；其UI_PENDING為當時歷史，後續UI證據如下，不修改舊receipt。
- `dm02-flow-job-ui-visual-verified-20260915.json`：`NATIVE_FLOW_THREE_JOBS_VISIBLE_LINEAGE_AND_THIRTEEN_IO_EDGES_PASS`。
- `dm02-flow-tasks-visual-20260915.png`、`dm02-job-{load_dimensions,load_sales_fact,validate_datamart}-lineage-visual-20260915.png`。
- `dm02-python-platform-reconciliation-20260915.json`、兩份approval及原proposal/supplement；preflight失敗紀錄、首輪UI與navigation-only證據均保留。
- `dm02-flow-job-canary-guards-20260915.log`：5項operator防護測試通過。既有124項analysis測試的產品來源未變，不為本批重跑。

**本批已用完，不可重播operator、probe、SQL／ETL／ingestion／模型或部署。** 沒有產品解析層、Host runtime、Core、服務或datastore變更；唯一新增是經另准的Catalog metadata。瀏覽器只用已裝Playwright/Chrome、sandbox、新context/tempHOME，已關閉自己的browser。

這只是原生相容性canary：未發布record-derived來源輸入、Job dependency、column lineage、terms/tags或歷史run，未接generic Decision作發布授權。完整Skill發布、Grafana native ingestion、Job dependency／run／ACL負例與分開核准閉環仍缺；Goal DM02／2 of12保持未完成。

## 2026-09-15 收斂提案（歷史：當時待核准）

依使用者最新要求，停止新增解析層／日期解析，不自行擴架構。本輪沒有產品程式、服務、datastore或Core變更；只用既有候選／context證據及固定SDK準備一次原生相容性提案。

- 目標 `http://localhost:9002`，必須重新驗操作員為 `urn:li:corpuser:datahub`。
- 新 Flow：`urn:li:dataFlow:(python,sales_datamart,PROD)`。
- 三個 Job：同Flow下 `load_dimensions`、`load_sales_fact`、`validate_datamart`；對應現有 `_load_dimensions`、`_load_facts`、`_validate_target` function candidates，不新增extract Job。
- 18個明確Aspect creates：Flow的platform/info/editable properties；各Job的platform/browse path/info/editable properties/I/O。SDK description setter會額外產生editable properties，不能以未帶description的14個Aspect估算。
- 3個官方Flow membership、8個direct SQL input及5個output Dataset edges；引用現有六個target datasets，不修改其Aspects。日期／四dims／fact的回讀是upsert讀取，不冒充新的source→target欄位lineage。
- **不發布**record-derived source inputs、Job-dependency guesses、column lineage、治理terms/tags或歷史run。Job包含靠官方 `dataJobInfo.flowUrn`，不把call graph當lineage。

既有九檔snapshot與485候選digest核對不變；準備只讀現有recorded Catalog，正式操作前仍須fresh key/status/schema、平台python存在、四entities不存在及ACL檢查。所有新增Aspect以 `If-Version-Match=-1`／同步模式防覆寫；任何不支援的契約／碰撞／錯誤即停，UNKNOWN只對帳不重送。公開API精確值／版本與原生UI逐項讀回，不以SDK validate或HTTP200當驗收。

**具體阻擋在既有接點，不在解析器：** `task-records.mjs`目前只持一般question/choices與RESPOND/DISMISS，並非typed publication authority；`publisher.py`仍未接可信ACL／核准與安全conditional writer。其candidate binding也不會把SQL process relation自動重掛成Python logical Job。故本批明示是operator原生相容性canary，不繞過草稿發布器冒稱完整Skill發布。

提案／僅prepare的helper位於gitignored `.local/evidence/dataflow-discovery/`：
`dm02-native-flow-job-canary-proposal-20260915.json`、`prepare-dm02-flow-job-canary-20260915.py`。
提案SHA256 `b351967ffa7f17eedd1450cef39a7943802fb47584b9c8c526207da7d4eaf35a`。
狀態 `PROPOSAL_ONLY_NOT_AUTHORIZED`；0 metadata writes、0 credential/network/source execution。

首個診斷顯示器用錯binding欄位`role`（實際為`relation_type`），以及初估漏算SDK editable properties，均只發生在離線prepare，沒有外部重播。主程式／已部署Agent／原124tests來源未改。

本批即使通過也只增加原生相容性證據；DM02的完整I/O、Job dependency、欄位／Grafana、run／ACL／版本與Skill核准閉環仍須完成，不能提前關task。

## 歷史 Discovery Catalog binding（該階段尚未發布 ETL DataJob）

新增 `extensions/dataflow-discovery/src/dataflow_discovery/catalog.py`，透過官方 SDK 型別及
唯讀 `get_aspect` seam，核對 MSSQL 的實際 DatasetKey／active Status／非空 SchemaMetadata。
Host必須獨立提供每個SQL process的connection namespace及exact Dataset allowlist；不以
同檔案、同名或唯一Catalog命中猜來源，不把query alias／Python call graph升格為lineage。

本輪正式登入後只讀兩個既有Source及13 datasets的三個aspects，兩Source version/hash仍為
已驗的v4/v1。`catalog-binding-live-aspects-20260914.json`保留raw readback，無metadata寫入、
無SQL或ETL執行、無ingestion重跑／新token／服務切換。

固定九檔snapshot仍 `ed276f258ceed74e491d85b16d8e54da9408cc9484b44a3bbccf8e4aec1af77f`。
Host根據已讀extract/load/run_etl/metrics指定15個SQL constant的namespace；
**24個讀寫依賴綁13 datasets成功（source88＋target61＝149欄）**；其他9個dependency仍因
未提供connection scope而unresolved。最終 `catalog-binding-case-final-20260914.json`，
`publication_authorized:false`／`isAgentAcceptance:false`。這不代表Skill已自動推導連線、
逐欄ETL轉換、DataFlow/DataJob、column lineage或取得發布授權。

負例另重現並修正真身分缺陷：SQLGlot的`Table.parts`會省略`Database..Table`的空schema，
原flatten可能產生錯誤的`Database.Table`。analyzer現在在丟失位置之前保留unresolved，
Catalog adapter亦拒絕此語法；不猜dbo。analysis升為 **1.0.2**，舊1.0.1候選須重分析。
`catalog-omitted-schema-red.log`保留失敗；最終6suites **72 PASS**，包含新Catalog12項
與analyzer regression。`discovery-catalog-analysis-1.0.2-20260914.json`為新版fresh分析；
舊source snapshot digest雖相同，不代表舊analysis/approval可沿用。

安全負例包含cross-db／URN allowlist／schema缺失／removed／key mismatch／欄位歧義／
read exception不洩漏／假候選digest／來源drift；沒有擴大到完整ACL或production security驗收。
Scoped LSP回報輔助Pyright環境missingImports，但实际`.venv` SDK／parser imports、72 tests及
真readback解碼成功；不修改正確import以討好環境。boolean `is not False`是刻意拒絕非bool
值，AST規則誤報已mark；既有operator／dashboard stale cache保留，不重開修補迴圈。

**下一個實作接縫**：Python執行/connection evidence與statement的可驗綁定、完整欄位owner／
轉換 → intent-only Agent／可信Host → typed publication授權／CAS／owned aspects讀回。
本輪未修改Agent production integration；DataHub仍不會顯示尚未發布的ETL DataJob lineage。

## 模型契約核對（初期）

- 四個 dimensions：date／product／customer／territory；fact PK 為
  `SalesOrderID + SalesOrderDetailID`。三個 identity dimensions 各保留唯一來源 key；
  date 使用生成 key。四個 FK 指向 dimension PK，reporting view 用相同 keys 做多對一 join。
- `UnitPrice`／`UnitPriceDiscount` 為 decimal(19,4)，兩個 line amounts 為
  decimal(19,6)；unknown members 已定義。Type 1 不宣稱歷史屬性重建，生成 key 不虛構 lineage。
- 固定日期、Status=5、CurrencyRateID IS NULL；稅／運費不加進 line net amount。
  distinct orders 不可跨分類直接相加；AOV 分子／分母使用同一 filtered detail scope。
- 依據：`extensions/sales-datamart/sql/001_create_sales_datamart.sql`、
  `extensions/sales-datamart/metadata/metrics.md`；既有真對帳／還原證據沿用 DM01／DM04 receipts。
  本輪沒有重執行 SQL，也未把尚缺的 DDL 衝突保護、ETL timeout／完整負例視為通過。

## 已修的 Grafana 模板問題

| 問題 | 固定版本證據與修正 |
| --- | --- |
| `encrypt: true` 型別不合 | Grafana 13.1.2 的 `sqleng.JsonData.Encrypt` 是 Go string，直接 json.Unmarshal；改成 `"true"`，不是停用 encryption |
| All 自訂 `__all` | 13.1.2 TemplateSrv 對 custom allValue 跳過 formatter，因此會在 IN 子句插入裸識別字；改空 custom allValue，沿用原生展開＋`:sqlstring` |
| Panel 未綁 datasource | 原生 DataHub connector 只從 panel datasource 建 per-panel inputs；已給七 panel 固定 UID，不依賴其他預設 datasource |
| `currencyUSD` 未有證據 | CurrencyRateID NULL 本身不是 ISO 幣別證明；改無美元符號的數值格式，保留 local currency 說明 |
| browser timezone | 改 UTC dashboard calendar coordinates，避免歷史 date labels 隨瀏覽器時區偏移；不是改 source date 語義 |

Datasource database 改用現行 `jsonData.database`；13.1.2 仍有 top-level database fallback，
所以舊欄位位置不是本輪聲稱的 fatal defect。連線 timeout 5 秒／pool 2；初修保留
`tlsSkipVerify:false`，後續使用者明確批准本機例外才改為 true（見下節）。connection timeout 不等 statement timeout。

### 一手來源

- [Grafana 13.1.2 MSSQL initialization](https://github.com/grafana/grafana/blob/v13.1.2/pkg/tsdb/mssql/mssql.go)：JSON 解碼及 database fallback。
- [13.1.2 SQL engine](https://github.com/grafana/grafana/blob/v13.1.2/pkg/tsdb/mssql/sqleng/sql_engine.go)：`Encrypt string`／`TlsSkipVerify bool`／`ConnectionTimeout int`。
- [13.1.2 connection](https://github.com/grafana/grafana/blob/v13.1.2/pkg/tsdb/mssql/sqleng/connection.go)：encrypt=true 時以 TlsSkipVerify 決定 TrustServerCertificate。
- [13.1.2 TemplateSrv](https://github.com/grafana/grafana/blob/v13.1.2/public/app/features/templating/template_srv.ts)：getAllValue 與 custom All 跳過 formatting。
- [官方 All option 說明](https://grafana.com/docs/grafana/latest/dashboards/variables/add-template-variables/#custom-all-value)：custom All 不 escape；已以上述固定版程式交叉核對，不把 latest 當版本證據。
- 本機 `.venv` 已核 `acryl-datahub==1.7.0.9`。唯讀檢查官方 Grafana connector 的
  `grafana_api.py`、`grafana_source.py`、`models.py`、`lineage.py`；沒有修改或覆寫安裝碼。

## 可重跑離線證據

```bash
PYTHONPATH=extensions/dataflow-discovery/src:extensions/sales-datamart/src \
  DATAHUB_TELEMETRY_ENABLED=false .venv/bin/python -m unittest -v \
  tests/test_sales_datamart_grafana.py tests/test_dataflow_discovery_analysis.py
```

**19 PASS**，log：`.local/evidence/dataflow-discovery/dm02-grafana-offline-final.log`。
其中新增四個 Grafana tests；使用公開 `Pipeline.create()`＋原生 Grafana source＋file sink，
僅替換 HTTP transport，拒絕非 fixture 目標與 mutation，不用 private connector 類別重建行為。

- 固定 datasource／TLS 型別、原生 All／calendar／currency 約束。
- fixture dashboard 經原生 connector，七個獨立 query Datasets → 各自 Chart inputs，
  Dashboard charts membership 完整。
- 刪除 panel datasource 重現舊模板：七 Charts 仍產生，但 inputs／lineage 缺失。
- **無 Catalog graph 時，connector 產生的是 datasource fallback**：
  `urn:li:dataset:(urn:li:dataPlatform:mssql,SalesDatamart.dataflow-salesdatamart,PROD)`，
  並無 fine-grained lineage。這不是 reporting view URN，測試明確保留此限制，不能當欄位鏈通過。

首次測試 fixture 未處理 requests 的 `params=None`，造成兩個測試 error；已只修測試
transport，第二次四項 PASS，再與分析器一起 19 PASS。first／second logs 保留。

`tests/pyrightconfig.json` 宣告實際 `.venv`／Python 3.11，沒有用動態 import 或
停用 missing-import 規則掩蓋環境不一致。Primary Python LSP 已確認 clean；輔助 Pyright
仍回傳不同環境的 missing-import 訊息，但同一 .venv 的直接 import 與19 tests已通過，
已記錄環境誤報。一輪 full sweep Python timeout，後續單檔 primary 查詢成功；不把 timeout 當 clean。

最終 cached lens 仍列既有 canary operator 的4項 blocking：三處 JSON.parse 忽略外層
`main().catch` 的誤報，以及已核准 loopback HTTP 管理登入的真 transport 限制。
已登記 disposition，但 cache 仍顯示原項；**不宣稱 lens 全綠，也不改正確控制流程消除提示**。
新增 Grafana 模板／tests 沒有 cached blocking。HTTP 基準不等正式環境 TLS 驗收。

額外安全掃描列出四個 `.local/` 私有檔：已只驗 metadata，全部 gitignored／未追蹤，
三層父目錄700；三檔原為600，`official-code-match.json` 由644收緊成600。
沒有讀取／輸出內容，也沒有輪替 token；掃描命中不是公開洩漏的證據。

## 歷史：限定批次已核准、當時等待登入（現已解除）

使用者已明確批准以下三項 Grafana 資產建立／固定查詢／瀏覽器驗證，並選擇本機 TLS 例外：
只對 `127.0.0.1:14334`／SalesDatamart／reporting-only reader 保留加密而略過伺服器憑證驗證。
模板已改 `tlsSkipVerify:true`，不是未經核准降級；不適用正式環境或其他 datasource。
不包含重跑 ETL、DataHub publication、service-account/token 建立或原 MSSQL 重啟。

舊 CDP `127.0.0.1:33771` connection refused（附帶 JSON reader 收到空輸入的 error，不是 Grafana
錯誤）。既有 Playwright 1.63.0／Chrome 153.0.8010.12 可用；沿用本案已安裝的 sandboxed
headless harness，新隔離 context 真開 `/login` 並核 Log in button，已關閉自有 browser／清理暫存 HOME。
Receipt：`.local/evidence/dataflow-discovery/dm02-grafana-browser-preflight-20260914.json`。
**只證 login form 可達，未登入、未做 mutation。**

已只檢查常見 Grafana 管理登入 env keys 的存在與 `.local/grafana-operator.json` 是否存在，皆無。
不猜密碼、不讀其他專案 env／harness session logs；需要把先前已提供登入交付到可用受保護檔案，
或恢復已登入的指定本機 browser 入口。不要求重新批准同一操作批次或重貼秘密到 chat。

## 核准 canary 執行範圍與停止點（Grafana部分已完成）

1. 本案 Grafana 13.1.2／`http://127.0.0.1:3000`／org 1：只建立 folder
   `dataflow-discovery`、datasource `dataflow-salesdatamart`、dashboard `dataflow-sales-v1`。
   遇既有同 UID 不覆寫；不改 `wferp-test` 或其他資產／預設 datasource。
2. 密碼只能由可信 operator 將既有 Grafana reader secret 注入 secureJsonData；不交 Agent，
   不輸出或存入版本化模板。本批已另獲具體授權，不是沿用 DM01 Source mutation 核准。
3. 檢查 TLS、九個固定 SQL（兩個 variable queries＋七 panels），再驗原生瀏覽器
   All／單選／多選／歷史日期／空日期範圍／NULL／金額／單位。HTTP／health success 不算數值通過。
4. 2026-09-14T06:11:02Z 唯讀檢查原 SQL container logs，觀測到
   `2026-09-14 00:40:54.24 ... A self-generated certificate was successfully loaded for encryption.`
   原本尚未驗 Grafana 是否信任該 certificate；使用者現已選本案 local-only skip-verification
   例外。若後續改部署可信 certificate，仍需另批原服務設定／重啟授權。
5. DataHub 原生 Grafana source 的 dashboard_pattern 是內容篩選，**不是存取控制**；
   API client 在篩選前已 fetch search 得到的 dashboards。後續 metadata reader 應先驗
   service account 無全域 basic role、只有本 folder read，並測無 datasource query／write
   權限；如固定版不支援，回報而非自動升 Viewer 擴大其他專案存取。
6. 真 MSSQL mapping／macro／column lineage 還需 target Catalog schema 和有權限的原生 graph；
   Flow／Jobs／run ACL／版本／typed publication 核准及完整 readback 仍未驗，不能因本輪19 tests 勾掉。

本輪修改了 Discovery 的實際九檔 allowlist 中三檔：dashboard、datasource、metrics。
舊 snapshot `d942b3d8…`／analysis `e0aaa385…` 是歷史版本；後續必須 fresh capture／分析與核准，
不可沿用舊 candidate receipt 發布。此輪沒有重跑 Discovery 或發出 metadata mutation。

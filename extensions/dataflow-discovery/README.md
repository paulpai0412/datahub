# DataFlow Discovery（資料流探索）

Skill ID：`dataflow-discovery`。設計與完整完成線見 [設計](../../docs/research/datahub-sales-datamart-v1.md)／[TODO](../../docs/datahub-sales-datamart-todo.md)。

**目前有可信 Host 唯讀快照、靜態分析、中立候選、validator 與 preview；完整 Skill 尚未驗收。** Astra 主會話審查已修正完整性繞過、SQL 假關係／GO、Grafana panel scope 與 Git fsmonitor 執行風險，analysis version 現為 `1.0.2`（另拒絕會丟失 schema 位置的 `Database..Table`）。`catalog.py` 已提供 MSSQL 唯讀 key／schema 身分核對，但連線範圍仍須 Host 獨立建立，尚未接 Agent／publisher。`publisher.py` 仍是**未接線、不可部署的草稿**：已驗候選到 Host 宣告 URN 的 edge 翻譯，並在發布入口強制重捕 source；但缺 authoritative Catalog/field 解析、可信 Task/Decision 授權與完整讀回。詳細缺陷與證據見 [審查 checkpoint](../../docs/verification/dataflow-discovery-astra-review.md)。真 Agent／WebUI 的唯讀候選入口已通過；完整 Discovery／發布 E2E 尚未完成，preview 不等於發布或語義核准。

## 分開的 publication review（本地／未部署）

既有 Task／Run 模型 `0.1.2` 加入分開審核，`0.1.3` 另加入 Decision 的一次 admission marker；兩者均未部署。Host 綁 source／candidate、實際 Aspect JSON／原生版本與 expiry，一般 RESPOND 不能批准。同一 Decision 只有一個 Run CAS 能取得 attempt，未知結果不自動重送；marker 不等於發布成功。最新57項 Node tests（50 Host/runtime＋7 Discovery）通過；沿用0.1.3 模型生成／roundtrip證據；保留既有25項 publisher tests及未改 UI 的 Chromium fixture 證據。

Python preparation format `/3` 可先以 `approval=None` 預覽，不必虛構核准人或時間；後續回覆不改摘要，無批准不能進 draft emit。`compile_publication_mcps()` 已可由重驗的 source-bound plan 透過官方 SDK 準備初始完整 Aspects，無 client／emit；不是既有 metadata 的安全合併，不能直接覆寫 canary。Python logical digest 仍不是 Host 實際 MCP proposal 的摘要。Host 已本地接上 admission → 原生條件 batch／provenance → 精確讀回與唯讀對帳，拒絕未納管或已有人為修改的既有 Aspect，不做自動合併／收編。`discoveryPublicationCompiler()` 已經既有隔離 bridge 實際重驗 Source、編譯 SDK MCP 並核對每個選定 Aspect；九檔案例重編4個Info；另准一次唯讀取得fresh baseline，15個初始Aspects中11個NOOP、4個Info的customProperties namespace不同、0個缺失。沒有採納／覆寫，這次唯讀批准已耗用。仍缺生產 Host 的 fresh Catalog／隱私／最終 diff 與 Agent caller、live 驗收；未配置真 compiler 即拒絕執行，Python draft writer **仍未啟用**。詳 [審核契約、證據與限制](../../docs/verification/dataflow-discovery-publication-review.md)。

## Grafana schema 相容性 Adapter（本地／離線已驗，未發布）

`grafana_schema.adapt_grafana_schema(records, dashboard, scopes_by_datasource=..., graph=...)`
處理官方connector的待審MCP批次，不是新的parser或publisher。Host提供捕獲的dashboard、已授權datasource scopes及只讀Graph；不得把這些參數開放給模型。使用既有SQLGlot與官方 `DataHubGraph.parse_sql_lineage()`、`catalog.resolve_dataset()`／`BoundDataset.field()`，以真正SQL投影修正query Dataset schema及Chart inputFields，而不是按time/value_none名稱刪除。

固定SDK **1.7.0.9**／SQLGlot **30.12.0**；限定MSSQL、單target、明列欄位的單SELECT、無panel transformations／platform instance。跨scope、缺key/status/schema/column、原生產物與來源不符、未驗版本一律不回傳批次。原輸入及其他Aspects不變；這是記憶體準備的all-or-nothing，不是跨Aspect發布交易。SDK推斷的型別／nullable仍非runtime保證。

七panel的recorded-schema案例已由26個schema fields／27個Chart引用修正為各14個；合法time/value_none保留。原生Pipeline可經既有`GrafanaSchemaTransformer`在file sink前整批驗證，不使用REST streaming sink。技術準備採官方`ingest_tags:false`／`ingest_owners:false`：完整120個結構Aspects可通過現有LINEAGE review；預設另有17個tag Aspects，需分開SEMANTIC提案，不提高review限制或新增分批框架。新增接縫與既有Host共52 Node tests PASS；Grafana suites現17項＝16 PASS＋1原生connector已知expected failure。這是HTTP fixture＋合成Host身分／版本，不能將其URN/absent-version假設拿去live發布。真Grafana reader及source-bound production caller仍待接線。詳 [DM02證據與升級處理](../../docs/verification/dataflow-discovery-dm02-compatibility.md)。未接live入口、未部署／寫metadata；既有Host核准、freshness、CAS及讀回要求不變。

```bash
PYTHONPATH=extensions/dataflow-discovery/src DATAHUB_TELEMETRY_ENABLED=false \
  .venv/bin/python -m unittest -v tests/test_dataflow_discovery_grafana_schema.py tests/test_sales_datamart_grafana.py
```

## 原生 Flow／Job canary（已完成，非完整 Skill 發布）

2026-09-15 經兩次明確核准，登錄Python平台metadata及1 Flow／3 Jobs；19個新Aspects精確讀回、13條direct SQL I/O經原生GraphQL與真UI驗證，reload保留。六既有Dataset的key/status/schema及版本前後未變。
這是operator相容性canary，沒有開放草稿publisher／generic Decision，也未發布完整來源輸入、Job相依、欄位lineage或語義。詳 [範圍與證據](../../docs/verification/dataflow-discovery-dm02-compatibility.md)。本批已完成，不可重播。

## Agent 入口（已部署，唯讀 E2E 通過）

`dataflow_discovery` intent-only tool已接到DataHub父頁／gateway `/agent/discovery`與固定
`bridge.py` parser subprocess。Host透過 `discoverySourcesByActor`明示使用者／九檔scope／
approved snapshot digest及model-context approval；runtime不能提供Host路徑或寫入請求。
結果分頁、每頁重驗source與analysis digest，仍 `publicationAuthorized:false`。
已部署版本只提供候選與靜態validation，尚未接Catalog binding或publisher。已用真 DataHub Agent 完成
list_sources→analyze→模型回答／Host讀回一致，parent reload保留答案；485是候選數，不是可信lineage數。
詳見 [接線／測試與部署核准邊界](../../docs/verification/dataflow-discovery-agent-readonly.md)。

### Python欄位模式已接Host（2026-09-19，本地／未部署）

同一`analyze`入口現可由operator明確配置`pythonAnalysis`（path／entrypoint／source-bound scopes／metadata隱私批准）。Host核native actor／grants、讀key/status/schema及版本，無憑證Python重用現有query→record→SQL slot／lookup分析。模型不提供Catalog或scope，不新增action／parser／服務。未配置的來源仍維持原模式。

欄位格式現為`dataflow-discovery.agent-python-fields/2`，每頁最多10項／44KB，`sections`／`decoderSections`可定位fields／contexts／各圖value nodes與decoder summaries。refs必須以`(graphId,node.id)`定位，不能把decoder的`value:N`當成transport節點。`candidateDigest`綁投影格式、整份宣告report、scope與Catalog版本，`baseCandidateDigest`另指基礎分析；**不能把欄位頁摘要拿去發布**。來源、schema版本或context漂移拒絕，未解／prior／lookup-key與runtime未驗旗標保留。

現行81 Node／141 Python PASS；真九檔source經同一Host和隔離bridge，以歷史Catalog＋HTTP fixture核得56slots／49record-linked／8lookup、19contexts／1423 transport nodes／331unresolved，另四個既有decoder summaries及311 nodes完整讀回。同日只在既有Graph修正頂層try全部handler拋錯後的正常延續：`_as_decimal`不再錯列assignment不支配return；吞錯／巢狀／finally等仍未解，漏列的except* guard亦已補上，未推論Decimal數值正確。上述回放不是live驗收。9/19另經限定批准，以真Host reader成功讀回13 Dataset／149欄／39 Aspects（值與歷史相同、版本皆1）；不是Agent或lineage完成。當時9041無listener、原runtime已退出；尚未恢復或啟用field mode，需先核對Host相容性並另准操作。詳[接縫、負例與剩餘工作](../../docs/verification/dataflow-discovery-field-host-integration.md)。

## 唯讀快照

`src/dataflow_discovery/snapshot.py` 的 `capture_snapshot(root, paths, source_id=..., limits=...)`：

- Python 3.11+／Linux，僅 stdlib；不安裝依賴、不執行 repository code、不連網／DB、不修改原始碼、不建立業務狀態庫。
- `root` 是 Host 選定的 absolute path；`paths` 是 Host 核准的相對 POSIX 路徑清單，**不是模型任意給定的 host 路徑**。`source_id` 是非秘密標識，不構成 tenant／actor授權。
- 每層 directory 用 `dir_fd`＋`O_NOFOLLOW` 開啟，再在 pinned directory 中開 file；拒絕 symlinks，包括root ancestors，避免 `realpath()` 後普通 `open()` 的競態越界。拒絕 hardlinks、非regular files；FIFO以nonblocking open避免卡死。
- 只接受明列的UTF-8 `.py/.sql/.json/.yaml/.yml/.md`，拒絕隱藏路徑、常見秘密檔名、tests／fixtures／golden／vendor等輸入；任何拒絕都不返回部分snapshot。保留原始bytes/newline/case，不靜默redact以免破壞證據。
- 預設128files、每file512KiB、總8MiB，限制由可信Host決定。限定讀取量並檢查捕獲期間file狀態變動；之前讀過的file在後續捕獲期間變動也會拒絕。
- 回傳 frozen `Snapshot`／tuple `SourceFile`，只在memory保留捕獲text。`manifest()`僅包含source_id、path、size、SHA256及`revision_kind: content`，不含host絕對路徑或原始碼，不猜commit。
- snapshot digest對穩定排序的manifest計算；改內容、改檔名、改scope或source_id均改digest。後續Host接線須將actor／scope／approved revision綁定候選／發布並再驗current source，不能用content identity代替授權。

### 安全與版本保證的界線

這不是sandbox、完整DLP、transactional Git snapshot或持久化不可變artifact store：

1. 常見明文secret literal、YAML scalar、ODBC密碼、URL credentials與private-key marker會拒絕；pattern screening不是「一定沒有秘密」的證明。只可捕獲operator已核准／審閱的程式及去秘密設定，不可掃全repo後因正則無命中就送模型。未知encoding／custom secret名稱／obfuscation等無全覆蓋保證。
2. Symlink換掉已開啟的directory不會導向外部檔，捕獲bytes屬原pinned file；但capture後目前路徑可能已不同。靜態evidence必須指向**捕獲內容**及digest；發布前重新解析root／驗scope／source版本，過舊候選不能直接發布。
3. 多檔stat比較只能檢查觀察到的修改，不聲稱全repository跨檔原子版本。可信Git commit取得與現有HOME/session的artifact交付尚未接線；目前不接受caller自報commit假裝已驗證。
4. 此capture API本身不是授權入口，也未直接暴露給Agent。已部署的intent-only bridge另驗Host身份、明列檔案授權及模型隱私；不能將capture函式直接註冊為可讀任意host root的tool。

## Catalog 身分核對（Host-only，非發布）

`catalog.bind_sql_dependencies(analysis, snapshot, scopes_by_process=..., reader=...)`
先重驗快照／候選及重跑分析，再核對 SQL read/write 候選的實際 Catalog key、active status、非空 schema／欄位。`reader` 僅需要官方 SDK `get_aspect` 讀取介面；沒有 write 方法或新 datastore。

- `MssqlScope` 由可信 Host 根據實際連線及原生 ingestion 設定建立：database、明示 default schema（可不給）、environment、名稱 normalization、exact Dataset URN allowlist。**每個 SQL statement 分開綁定**，同檔案或同表名不代表同資料庫；找不到範圍就 unresolved，不能以唯一搜尋結果猜測。
- `resolve_dataset()` 核原生 DatasetKey／Status／SchemaMetadata，而不是相信 GraphQL typed reference。跨庫、非 allowlist、缺 schema、removed、key不符、讀取失敗一律不綁定；不回顯底層錯誤。
- `BoundDataset.field()` 只核已知實體擁有的 physical column，保留 Catalog 實際 fieldPath；無 alias stripping／suffix search。它不負責從 query alias 或 Python 變數推定欄位所有權。
- 初版 adapter 只驗 MSSQL、無 platform instance 的原生三段 URN。四段／remote、點號內嵌 physical identifier、`Database..Table` 均不猜。SQL 的欄位映射、ETL connection/data-flow inference、Grafana macro/identity 仍待完成。
- 回傳獨立 diagnostic report，不改寫候選 status、不生成已核准候選，`publication_authorized:false`。Host仍須驗 actor／tenant／source ACL及連線 provenance；非原子 Catalog 讀取須在發布前重驗。不能把此函式直接暴露為任意 URN／Host 路徑工具。

2026-09-14 真13 datasets readback＋固定九檔分析：15個Host明示範圍的ETL statement／24依賴可綁定；另9依賴因未明示連線仍 unresolved。這是Host診斷，不是自動連線推導／Agent／DataJob發布驗收。證據見 [DM02](../../docs/verification/dataflow-discovery-dm02-compatibility.md)。

### Python 每次 SQL 呼叫的獨立 scope（離線）

`python_catalog.bind_python_sql_dependencies(..., path=..., entrypoint=..., scopes_by_context=..., reader=...)`
每次重現trace並以source ID／整份snapshot／analysis／trace／use綁context ID。
同一SQL process經不同connection使用時必須分開配置，不能丟掉context套用單一per-process map。
空map只描述contexts、不讀Catalog；scope／ACL仍須Host獨立建立，不授權發布或證明分支已跑。

相關66tests通過；原九檔的條件式configured-factory診斷核對18個contexts／27依賴／13 datasets，
使用已完成identity probe與舊Catalog readback（非fresh），LOCK及generator gaps保留、整體INCONCLUSIVE。
沒有接live parser／Agent或publisher。詳 [context binding與限制](../../docs/verification/dataflow-discovery-python-catalog.md)。

### 查詢輸出值的實體欄位來源（離線）

`python_projection.bind_python_sql_projections()` 重現前述context/Catalog核對，再用固定SQLGlot公開API、
strict qualification／禁止schema inference解析query-output value origins。新8tests加入後相關74tests通過；
案例9個SELECT的37輸出中35個實體來源與手工SQL期望吻合，2個COUNT rowset不虛構欄位。
這不是Python轉換、write-target欄位或可信lineage；寫入contexts／LOCK／generator gaps仍未完成，未接live。
詳 [欄位來源證據與限制](../../docs/verification/dataflow-discovery-python-projections.md)。

### 寫入SQL的bind slots（離線）

`python_write_parameters.bind_python_sql_write_parameters()` 核explicit INSERT／UPDATE欄位與bind參數，
position／多row／predicate分開，不把未列欄位補成generated-key來源。新8tests加入後相關82tests通過；
案例9個write statements的56 slots與另列原SQL期望吻合，但尚未追Python提供的值與轉換，未授權SQL或lineage發布。
詳 [write參數證據與限制](../../docs/verification/dataflow-discovery-write-parameters.md)。

### Python mapping宣告傳遞（離線）

`python_bind_values.bind_python_parameter_declarations()` 沿SQL call paths追helper參數、list/generator/append與mapping宣告。
相關93tests通過；案例56 slots可找到同路徑的mapping references，但631-node圖仍133 unresolved，未證明runtime值或可變集合的最終內容。
條件、lookup、算式與opaque decoder不直接升格成欄位lineage。詳 [傳遞證據與限制](../../docs/verification/dataflow-discovery-python-bind-values.md)。

### Row decoder／dataclass（離線）

`python_decoders.analyze_python_decoder()` 追returned plain dataclass construction及helper exits，分開value／condition／prior-declaration inputs。
相關103tests通過；真四個decoder的26欄位符合另列期望，56個既有SQL slots仍吻合。decoder子圖304 nodes／28 unresolved；
尚未把query Result、decoder inputs、Extracted集合與下游值串成可信lineage，不能將不同子圖的unresolved數當下降趨勢。
詳 [decoder證據與限制](../../docs/verification/dataflow-discovery-python-decoders.md)。

### SQL result → decoder input（離線）

`python_query_decoders.bind_python_query_decoders()` 核exact result helper協定、caller argument與Python大小寫敏感result label，再接同context的query projection。
相關111tests通過；四來源query→decoder的26 record fields有33 declaration read links（value27／condition5／prior1）。
這不是runtime或完整lineage驗收；record→consumer的後續進展見下節。
詳 [query-result接點證據](../../docs/verification/dataflow-discovery-query-decoders.md)。

### Record collections → SQL consumers（離線）

`python_record_consumers.bind_python_record_consumers()` 依完整producer invocation及record field接到SQL parameter宣告。
相關118tests通過；56 slots中49有宣告依賴，共77 references；7個日期維度slots未硬接，8個surrogate-key slots仍只有lookup-key/condition依賴。
全部保留guard／helper effect未知，並非當前值或可發布lineage。詳 [consumer接點證據](../../docs/verification/dataflow-discovery-record-consumers.md)。

### Lookup key／value（離線）

`python_lookup_values.bind_python_lookup_values()` 核tuple位置、dictionary key/value與exact query result context。
相關124tests通過；8個lookup slots的value宣告各自來自dimension的surrogate-key欄位，與查找用的Source ID分開。
仍未證明duplicate-key、conversion或lookup match；詳 [lookup證據與限制](../../docs/verification/dataflow-discovery-lookup-values.md)。

## 可重跑檢查

從本專案根目錄執行（既有Python即可，無network／secret／DB）：

```bash
PYTHONPATH=extensions/dataflow-discovery/src:extensions/sales-datamart/src \
  .venv/bin/python -m unittest -v \
  tests/test_dataflow_discovery_snapshot.py tests/test_dataflow_discovery_analysis.py \
  tests/test_dataflow_discovery_host.py tests/test_dataflow_discovery_publisher.py \
  tests/test_dataflow_discovery_catalog.py tests/test_sales_datamart_etl.py
```

測試只在TemporaryDirectory建合成source：digest／scope／unicode／newline、只讀與不執行、path排除、secret拒絕／無回顯、大小邊界、symlink／hardlink／FIFO、source修改及directory-symlink swap。手寫的snapshot測試不代表後續lineage探索已驗。

下一步：以可信 Host capture 本 Skill 與 SalesDatamart 案例的 source-bound receipt，分離技術／治理核准，再接 DataHub 公開 API publisher 與既有 Agent／WebUI；以獨立 golden、改名／轉換／動態未知及過舊證據負例驗證。不用 fixture 冒充 live。

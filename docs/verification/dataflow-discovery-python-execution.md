# Python 執行證據：離線建置中（尚未接線）

2026-09-14；Goal仍DM02／2 of12。這不是SQL→連線／欄位lineage完成證據。

## 已完成：來源綁定的import語法與alias

新增 `extensions/dataflow-discovery/src/dataflow_discovery/python_imports.py`，僅使用stdlib AST：

- 以既有 `SourceFile` 核對UTF-8 bytes、size、SHA256；回傳相對path、qualified name及原始行號鏈。
- 支援一般import/from-import、改名、attribute alias，以及**字面值** `importlib.import_module`（含import_module的改名）。
- 不import或執行捕獲程式，不讀environment／秘密、不連網／DB，不新增datastore。
- 計算module name、relative import、未知call result、conditional/global/attribute rebinding等維持unknown／unresolved；
  不因變數叫Engine就假定其實體型別，不將factory回傳值冒充imported callable。
- 結果永遠 `runtime_identity_verified:false`／`publication_authorized:false`。
  這是支援語法的alias inventory，不是任意Python程式的runtime symbol table；不解析function-local imports或保證外部module初始化沒有副作用。

本案實際source使用literal `importlib.import_module("sqlalchemy")`／`("sqlalchemy.engine")`／
`("sales_datamart.config")`，再經attribute aliases使用create_engine、text、URL及兩個connection factories。
`Engine`／`SqlConnection`在此source是`typing.Any`別名，不能僅靠annotation推定SQLAlchemy連線。
没有為方便分析而重寫這份已核准／已執行的ETL source。

## 原始證據

位於gitignored `.local/evidence/dataflow-discovery/`：

- `python-imports-red-20260914.log`：新模組初版的named-relative import誤清除不相關alias、conditional attribute mutation及later global rebinding負例失敗；未部署該初版。
- `python-imports-final12-20260914.log`：12 tests PASS，含statement shadowing、不可執行sentinel、內容完整性、錯誤不回顯、factory result、annotation／walrus、except／except*／match capture與真case source。
- `python-imports-real-source-20260914.json`：重新capture既有九檔，snapshot仍ed276…；29項import語法binding中5項指定鏈核對成功，21項unresolved記錄保留。
  沒有推定資料庫namespace、SQL執行成功或Catalog field owner。
- 新模組primary LSP無error；test兩個auxiliary Pyright missingImports是既有source-root環境差異，實際.venv／PYTHONPATH的12 tests通過，已記false-positive；沒有安裝套件或動態改寫import。

重跑：

```bash
PYTHONPATH=extensions/dataflow-discovery/src .venv/bin/python -m unittest -v \
  tests/test_dataflow_discovery_python_imports.py
```

## 第二層：參數化 engine factory 語法（仍未接線）

新增 `python_factories.py`，使用同一份已核對import inventory，辨識module-level、線性helper內的
`create_engine(URL.create(...))`及其局部alias／return。追溯driver/database/host/port的literal或參數attribute來源，
不回傳username/password/query的expression或value，也不回傳engine option的值。

- 真九檔snapshot仍ed276…；本案只產生**一個共用、參數化 `_engine(config)` template**：
  database/host/port分別來自config的對應attribute，而非自行指定AdventureWorks或SalesDatamart。
- factory參數改名／reassignment會追溯新來源；shadowing（包括return後的assignment/import/definition）、
  decorator、generator、分支與attribute mutation不升格為可用factory。
- dynamic URL／完整connection URL字串／重複driver arguments維持unresolved；engine options仍標為opaque，
  不能由URL的宣告座標推斷creator、connect_args、event hooks或runtime override的實際目的地。
- 不解析任意Python控制流程、nested/async factory或runtime module身分；不以factory template名稱直接綁定caller。
  同名definition需要後續call-site／scope解析，這裡保留definition line，不選一個當runtime實體。
- `python-factories-final-20260914.log`：8項新factory tests＋12項import tests，**20 PASS**。
  `python-factories-real-source-20260914.json`綁snapshot、producer hashes與真case結果；沒有ETL執行、metadata寫入或部署。
- 三個auxiliary Pyright missingImports由相同的實際.venv／PYTHONPATH測試及真snapshot分析反證，已記false-positive；不改source或安裝能力討好診斷。

重跑兩層：

```bash
PYTHONPATH=extensions/dataflow-discovery/src .venv/bin/python -m unittest -v \
  tests/test_dataflow_discovery_python_imports.py \
  tests/test_dataflow_discovery_python_factories.py
```

## 第三層：factory call-site參數與未選定分支

新增 `python_calls.py`，只追module-level函式的straight-line prefix；遇到try/with/if等statement控制流程或未支援mutation即停並記unresolved，不假裝已追過後面的SQL執行。

- factory definition按名稱／原始行號對應，module重複definition、重綁／global寫入及caller-local shadowing不直接挑舊definition；局部factory/config-callable alias可追溯。
- positional／keyword／positional-only參數對應；missing/duplicate/unknown/starred參數不綁。省略default只列omitted，不求值或代入。
- `or`／`and`保留truthiness選擇，不偷換成`is None`；conditional expression保留condition及兩個分支，`selection_verified:false`。
- literal argument值不輸出；assignment使用flat reference，不展開多重alias成指數大小的JSON。config factory的imported call僅記名稱／位置／argument shape，沒有呼叫或認定其回傳身分。
- 真九檔source（snapshot仍ed276…）得到6項prefix assignments／2個factory call-sites：
  config分別來自宣告的 `sales_datamart.config.source_connection()` 與 `target_connection()`。
  source仍保留傳入source_engine的可能；target仍保留dry-run→None、傳入target_engine及新factory三種可能。
- 這是**呼叫與參數的語法證據，不是選定哪個分支、真資料庫身分或SQL execution的證據**。
  callback、namespace/runtime effects與engine options未驗證；不因唯一Catalog命中就補上database。
- `python-calls-final-20260914.log`：8項新call-site tests＋既有20項，共**28 PASS**。
  `python-calls-real-source-20260914.json`保存真source結果與producer hashes。
  新程式初次LSP的AST/expr型別錯誤已修；fresh scoped LSP只剩4項auxiliary source-root missingImports，實際.venv/PYTHONPATH的28tests及fresh capture成功，非全專案LSP/security clean。

重跑三層：

```bash
PYTHONPATH=extensions/dataflow-discovery/src .venv/bin/python -m unittest -v \
  tests/test_dataflow_discovery_python_imports.py \
  tests/test_dataflow_discovery_python_factories.py \
  tests/test_dataflow_discovery_python_calls.py
```

## 第四層：connection取得／SQL跨helper參數傳遞（離線）

新增 `python_sql.py`，不只掃call graph：在唯一可辨識的SQL相關local helper之間，
將呼叫位置的connection／SQL參數帶入callee；保存每個call context、分支位置及SQL literal的hash／定位，不輸出SQL全文或bind values。

- 可連結with engine.connect()/begin()的宣告取得位置、connection alias與conn.execute(statement)，包含多層wrapper與keyword參數。
  這是lexical acquisition證據，不是實際SQLAlchemy物件、連線有效性或driver hooks驗證。
- if/conditional/boolean/loop/try/except/finally均只列可能語法路徑，不求值、選路徑或推定次數。
  merge遇不同connection不挑一個；with外的connection aliases不續當有效取得；已知Connection.begin()的transaction不當新Connection。
- comprehensions的iterator可包含真正的呼叫語法，target shadowing不污染外層；generator body是deferred，不冒充已消費。
  未解析的動態SQL、helper shadowing/decorator/recursion、回傳connection、未知runtime effects不升格。
- 固定20,000步／512 uses／12層helper上限，達限明列gap／保留partial evidence；非完整Python interpreter或sandbox。
- **同一SQL literal經兩個connection使用，保留兩個call contexts**，不能用`process → scope`字典最後一筆覆蓋。
  既有Catalog per-process介面若遇這種情況必須拒絕歧義或另設context-aware契約，不假稱已可直接接入。

真九檔fresh capture（snapshot仍ed276…）結果：

- **19個宣告中的SQL uses：source選擇式4、target選擇式15**；涵蓋先前人工指定的15個SQL constants、3個key lookup與1個application-lock SQL。
- 15個constants的來源／目標分類現在由call-site→acquisition→wrapper參數推導，case預期只放tests，不硬編入分析器。
- **18個SQL process可連回既有analysis1.0.2的candidate IDs／相同file SHA**。
  LOCK SQL沒有既有Dataset SQL-process candidate，明列unmatched；沒有為湊齊而造process／Dataset／lineage。
- 保留4個deferred-generator-body gaps。19個`SYNTAX_BOUND`不表示19條SQL已執行、不表示field transformation、選定database或核准發布。
- `python-sql-real-source-20260914.json`保存producer hashes、完整trace、18個既有candidate連結與lock差異。
  `python-sql-final44-20260914.log`：16項新SQL trace tests＋既有28項，**44 PASS**。
- 新程式Constant.value型別問題已修；fresh scoped LSP只剩5項auxiliary source-root missingImports，實際.venv/PYTHONPATH與44tests／真snapshot分析成功；不宣稱全專案diagnostics clean。

重跑四層：

```bash
PYTHONPATH=extensions/dataflow-discovery/src .venv/bin/python -m unittest -v \
  tests/test_dataflow_discovery_python_imports.py \
  tests/test_dataflow_discovery_python_factories.py \
  tests/test_dataflow_discovery_python_calls.py \
  tests/test_dataflow_discovery_python_sql.py
```

## 已取得：本次明確配置的唯讀身分證據

使用者另行核准operator-only probe，實際載入原hash核對後的configuration／engine factory，
兩個連線分別回報AdventureWorks2019/datahub_ingest與SalesDatamart/sales_datamart_loader，
與同一核准MSSQL instance及module paths／前後snapshot相符。詳
[dataflow-discovery-runtime-identity.md](dataflow-discovery-runtime-identity.md)。

這是本次明確配置的實測，不追認舊ETL run；舊 `_receipt()` 的database名稱是固定標籤。
沒有ETL或business rows查詢、Source/Secret/metadata mutation或部署，也不證明任意override、完整CLI與TLS server identity。
通用parser仍不執行source，新的operator授權不轉給Agent／一般分析輸入。

## 新增：context-aware Catalog 離線接點

`python_catalog.py`已能為每個SQL use分別套用Host scope；context ID綁整份snapshot／source ID／analysis／trace，
不讓同一process的不同connection覆寫彼此。相關66tests通過，真九檔在明示configured-factory條件下，
與既有Catalog紀錄核對18個contexts／27依賴／13 datasets，仍INCONCLUSIVE且未接live。
詳 [Python Catalog證據與限制](dataflow-discovery-python-catalog.md)。

## 下一個尚未完成的證據鏈

把已驗配置證據與call-context／entrypoint／override限制接入真正Host入口，
並補fresh Catalog／ACL及physical field／Python transformation證據。
需要區分同一SQL在不同呼叫／連線中的用途，未知分支或runtime override不能自行選定namespace。
之後才以Host獨立的connection provenance／ACL接Catalog key/schema/field核對。
import alias或call graph均不等於lineage。

新模組沒有加入 `bridge.py`、`analyzer.py`或Agent入口的import路徑，沒有改analysis1.0.2或live行為。
這避免把未驗執行追蹤直接熱載入目前運行的Host parser。

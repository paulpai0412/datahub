# DataHub ETL／Summary Table／Lineage 的既有方案研究

日期：2026-09-10  
研究範圍：DataHub OSS `v1.7.0.1`（upstream commit `e99431ec510d7a2001f815c6bf70913c493af76e`）、不 fork、不修改 DataHub Core；本報告是來源研究，不代表本機已完成新的 runtime／瀏覽器驗收。

## 結論先行

有現成方案，而且不必先做 MFE：

1. **如果 ETL 是 SQL Server stored procedure／SQL Agent**：先用現成的 **MSSQL ingestion source**。這是目前對 AdventureWorks／SQL Server 最接近需求的方案；它可以產生 stored procedure、SQL Agent job／step 的 `DataFlow`／`DataJob`，並解析表級／欄位級 lineage。需要補足 `msdb`、`VIEW DEFINITION`、`sys.sql_expression_dependencies`；若要從 Query Store／DMV 取得執行期 query lineage，還要 SQL Server 2016+ 與 `VIEW SERVER STATE`。
2. **如果 ETL 可採用 dbt**：使用原生 **dbt／dbt Cloud ingestion source**。它會從 dbt artifacts 取得 model/source、SQL code、表／欄位 lineage、model run；這是通用 SQL transformation 的最佳既有路徑，但 DataHub 中的 program 主要表現為 dbt Dataset／model 與 `DataProcessInstance`，不是傳統 `DataFlow`／`DataJob`。
3. **如果已有 Airflow／Dagster／Spark 等 orchestrator**：使用其官方 DataHub plugin／OpenLineage runtime instrumentation。這能把實際執行的 job、run、input/output 與 SQL lineage 傳入 DataHub，但「建立與編輯程式」仍在 orchestrator UI，不是 DataHub Create Source 表單。
4. **如果已有 Matillion、SnapLogic、Informatica、Airbyte 或 Fivetran**：DataHub 已有對應 source，部分是目前最完整的 DataFlow／DataJob／run／table+column lineage 對映；應直接採用對應 connector，而不是重做 generic connector。
5. **如果是任意 Python／自製 ETL，沒有可觀測 runtime 或標準 artifacts**：目前沒有一個 DataHub 內建 datasource 能可靠地從任意程式碼自動推導完整 lineage。可用 OpenLineage／SDK／GraphQL 建立 metadata，但仍需在 ETL 執行點產生事件，或另做 ingestion／UI adapter。這時才值得評估 MFE；MFE 是 UI 擴充，不是 lineage 解析器。

因此，「通用需求」的通用部分是 **DataHub metadata model + OpenLineage／SDK 契約**，不是一個能讀所有 ETL 程式的萬用 Create Source。

## DataHub UI 能做什麼

DataHub UI 的 ingestion flow 可以選 connector、填 connection／filter／ingestion settings、保存、Save and Run、排程、查看 run history 與 log；官方文件也說明可透過 `createIngestionSource` GraphQL 建立 ingestion source。

- 官方文件：`docs/ui-ingestion.md:63-120,132-188,190-224,297-338`
- 公開來源（固定到本次 checkout）：
  - <https://github.com/datahub-project/datahub/blob/e99431ec510d7a2001f815c6bf70913c493af76e/docs/ui-ingestion.md>

但 UI 的 connector catalog 在本版本仍是前端靜態 `sources.json`：

- `datahub-web-react/src/app/ingestV2/source/builder/useIngestionSources.ts:27-36` 有明確 TODO：要等 server 支援 dynamic list。
- `sources.json:122-139` 有 dbt／dbt Cloud；`:182-209` 有 Airbyte／Matillion；`:530-538` 有 Other／Custom。
- `sources.json:654-684` 的 Airflow、Dagster、Spark 標成 `isExternal: true`、recipe 為空。
- `SelectSourceStep.tsx:105-110` 對 `isExternal` 直接 `window.open(docsUrl)`，不進 DataHub 的 connection form。

因此：

- **有 recipe 的內建 connector**：可以由 DataHub UI 管 ingestion source 的設定、權限、secret、排程、執行與 log。
- **外部 runtime integration**（Airflow／Dagster／Spark）：Create Source 卡片只是文件入口；實際設定在外部平台或程式 runtime。
- **Custom source**：官方文件明確寫 UI-based ingestion 目前不支援 custom ingestion source，需自行 package、安裝到 CLI 執行環境，再以 fully-qualified class path 的 YAML recipe 執行。

來源：

- `docs/how/add-custom-ingestion-source.md:15-38`
- `docs/ui-ingestion.md:297-306,365-373`
- `datahub-web-react/src/app/ingestV2/source/multiStepBuilder/steps/step1SelectSource/SelectSourceStep.tsx:105-110`
- <https://github.com/datahub-project/datahub/blob/e99431ec510d7a2001f815c6bf70913c493af76e/docs/how/add-custom-ingestion-source.md>
- <https://github.com/datahub-project/datahub/blob/e99431ec510d7a2001f815c6bf70913c493af76e/datahub-web-react/src/app/ingestV2/source/multiStepBuilder/steps/step1SelectSource/SelectSourceStep.tsx>

## 方案比較

| 方案 | DataHub 內建 UI | Program／Job | Summary／Dataset | 表級 lineage | 欄位級 lineage | 真正限制 |
| --- | ---: | --- | --- | ---: | ---: | --- |
| MSSQL stored procedure／SQL Agent | 是；進階欄位可能需 YAML／GraphQL | Stored procedure = DataJob；SQL Agent job = DataFlow，step = DataJob | 由 MSSQL connector ingest 實際表／view | 是 | Stored procedure／query SQL 可解析，依 schema／SQL | 需 MSSQL 權限；不會替任意 Python 建模 |
| dbt Core | 是，dbt card 有 recipe | dbt model 是 Dataset；run 是 DataProcessInstance | dbt model 與 target MSSQL Dataset 可建立 sibling | 是 | 是，manifest／compiled SQL + schema | 必須產生並讓 worker 讀到 artifacts；不等於 DataFlow/DataJob |
| dbt Cloud | 是，dbt Cloud card 有 recipe | model／run；Cloud job 由 dbt Cloud 管 | 同上 | 是 | 是 | 需 dbt Cloud API／project／job；執行在 dbt Cloud |
| Airflow DataHub plugin | 否；卡片為 external docs link | DAG／task 以 pipeline/job metadata、run 發送 | 由 task 實際 input/output 指向 Dataset | 是 | SQL operator 可自動解析；custom operator 需 extractor 或 inlets/outlets | 要改／安裝 Airflow plugin；不是 DataHub UI 建 DAG |
| Dagster DataHub sensor | 否；卡片為 external docs link | Pipeline／task／asset materialization | Asset key 轉 DataHub Dataset | 是 | SQL metadata 可解析；自訂 converter／extractor 可補 | 要修改 Dagster Definitions／啟 sensor |
| OpenLineage endpoint | 否；不是 ingestion form | Job／Run 由事件描述 | Input／Output Dataset | 是 | 取決於事件 facet／producer | runtime 必須發事件；DataHub 不會主動讀任意程式 |
| Matillion DPC | 是，有 recipe | Pipeline = DataFlow；component = DataJob；run = DataProcessInstance | OpenLineage dataset references | 是 | SQL parsing／OpenLineage | 僅適用 Matillion DPC，需 API 權限 |
| SnapLogic | 是，有 recipe | Pipeline = DataFlow；Snap = DataJob | SQL table／Kafka topic 等 Dataset | 是 | 官方 source README 宣稱支援 | 僅適用 SnapLogic，需 Lineage API |
| Informatica IDMC | 是，有 recipe | Mapping Task／Taskflow = DataFlow + DataJob | source／target Dataset | 是 | **目前文件明確標示沒有 column-level lineage** | 需 IDMC export／connection permissions |
| Airbyte | 是，有 recipe | Connection = DataFlow；stream = DataJob；run = DataProcessInstance | source／destination Dataset | 是 | 有 field mapping 時支援 | 比較像 replication／sync，不是任意 SQL ETL |
| Fivetran | 是，有 recipe | Connector = DataJob；run = DataProcessInstance | source／destination Dataset | 是 | 官方 integration README 宣稱支援 | 比較像 managed replication；需正確 destination URN 對齊 |
| `sql-queries` source | 不在本版 Create Source catalog | 不會建立你的 ETL DataFlow／DataJob；主要產生 Query／lineage metadata | 依 query 指向既有 Dataset | 是 | 是，NDJSON query log + schema resolver | 需 query file；目前沒有原生 UI template |
| 任意 Python custom source | 否（官方明示） | 可自行 emit DataFlow／DataJob | 可自行 emit Dataset | 可 | 可，但解析器與事件由自己負責 | 需自建 package／CLI、UI 或 MFE；不能宣稱 generic auto-discovery |

## 1. MSSQL connector：目前最適合本專案的第一條路

### 能覆蓋的需求

本 checkout 的 MSSQL source code 明確把：

- SQL Server job 建成 `MSSQLDataFlow`；
- job step 與 stored procedure 建成 `MSSQLDataJob`；
- job／step 的 input/output 以 `DataJobInputOutput` 發出；
- stored procedure code 以 `DataTransformLogic` 的 SQL query statement 發出；
- stored procedure lineage 由 `generate_procedure_lineage()` 解析；
- query-based lineage 由 Query Store／DMV 進入共享 SQL aggregator。

來源：

- `metadata-ingestion/src/datahub/ingestion/source/sql/mssql/job_models.py:182-344`
- `metadata-ingestion/src/datahub/ingestion/source/sql/mssql/source.py:1005-1038,1203-1254,1434-1469`
- `metadata-ingestion/src/datahub/ingestion/source/sql/mssql/source.py:160-359` 的 `SQLServerConfig`

官方同版本文件：

- `metadata-ingestion/docs/sources/mssql/mssql_post.md:5-115`
- `metadata-ingestion/docs/sources/mssql/mssql_pre.md:1-90`
- <https://github.com/datahub-project/datahub/blob/e99431ec510d7a2001f815c6bf70913c493af76e/metadata-ingestion/docs/sources/mssql/mssql_post.md>
- <https://github.com/datahub-project/datahub/blob/e99431ec510d7a2001f815c6bf70913c493af76e/metadata-ingestion/docs/sources/mssql/mssql_pre.md>

### 對 AdventureWorks 的實際含義

若「程式」實際上是：

- stored procedure 讀取來源表並寫入 summary table；或
- SQL Agent job 執行一組 T-SQL／stored procedure steps；

那麼先不用新增 datasource。可以：

1. MSSQL source ingest source／summary tables、views、stored procedures。
2. 開啟 `include_lineage`、`include_stored_procedures_code`、`include_jobs`。
3. 由 DataHub connector 產生 DataFlow／DataJob 與 procedure／job lineage。
4. 若要 query history lineage，再開 `include_query_lineage` 與 `include_usage_statistics`。
5. 在 DataHub UI 以 ingestion source 的 Save and Run／Play／Run History 管理這個同步工作。

目前已知的本專案限制仍成立：測試帳號尚未有 `msdb`／`VIEW SERVER STATE`，所以 SQL Agent jobs 與 Query Store／DMV query lineage 尚未驗證。這不是要 fork 的問題，而是 SQL Server 權限與 Query Store 設定問題。

注意：connector 能描述「SQL Server 裡的 stored procedure／job」，不能把外部 Python 檔案自動變成同一個 DataJob。若 ETL 是 Python 透過 pyodbc 執行 SQL，應用 Airflow／Dagster／OpenLineage 或 SDK，在真正執行時上報。

## 2. dbt：最接近通用 SQL ELT 的既有 connector

DataHub 的 dbt integration 會 ingest：

- manifest 中的 source、model、seed、snapshot、exposure、semantic model、dependency；
- catalog 中的 schema、column、table statistics；
- compiled／raw SQL；
- model lineage 與 column-level lineage；
- `run_results.json` 中的 model run performance 為 `DataProcessInstance`；
- dbt node 與 target warehouse Dataset 的 sibling relationship。

來源：

- `metadata-ingestion/docs/sources/dbt/README.md:1-27`
- `metadata-ingestion/src/datahub/ingestion/source/dbt/dbt_common.py:2022-2038,2750-2797,3130-3140`
- `metadata-ingestion/src/datahub/ingestion/source/dbt/dbt_common.py:3394-3490`（dbt node lineage）
- `metadata-ingestion/docs/sources/dbt/dbt_post.md:5-66`

官方來源：

- <https://docs.datahub.com/docs/generated/ingestion/sources/dbt>
- <https://docs.getdbt.com/reference/artifacts/manifest-json>
- <https://docs.getdbt.com/reference/artifacts/catalog-json>
- <https://docs.getdbt.com/reference/artifacts/run-results-json>

### 適合的情況

若可以把 summary table 建立邏輯放進 dbt model：

```text
dbt source／MSSQL table
        ↓ ref()
dbt model／summary table
        ↓ dbt build
run_results.json
        ↓ DataHub dbt ingestion
DataHub dbt Dataset + target MSSQL Dataset + lineage + run evidence
```

這條路不需要把 table name 寫死在 DataHub reporter；dbt manifest 的 `unique_id`／dependency graph 是來源真相，target platform／platform instance 用於把實體表 URN 對齊。要穩定連到本專案既有 MSSQL Dataset，必須先用相同 database／schema／table naming 與 environment／platform instance 做一個小型 URN matching proof。

### 不能誤解的地方

- dbt ingestion 不執行 `dbt build`，它讀 artifacts；summary table 必須由 dbt／warehouse workflow 真正建立。
- dbt Core 的 `manifest_path`／`catalog_path`／`run_results_paths` 必須位於 DataHub executor 可讀的本地或 object storage 路徑。
- dbt model 在 DataHub 是 Dataset，不是傳統 DataFlow/DataJob；若使用者硬性要求「program 必須是 DataJob」，Airflow／Matillion／MSSQL stored procedure 等對映更符合。
- dbt Cloud 由 dbt Cloud 管 job 執行；DataHub UI 只建立／排程 metadata ingestion。

## 3. Airflow／Dagster／OpenLineage：最適合「執行期證據」

### Airflow

官方 DataHub Airflow plugin 支援：

- DAG／task metadata、ownership、tags；
- task success／failure 與 runs；
- SQL operators 的自動 column-level lineage；
- `inlets`／`outlets` 手動補表級 lineage；
- DataJob input/output lineage；
- DataHub SQL parser 與 multi-statement SQL／temporary table 支援設定。

來源：`docs/lineage/airflow.md:9-16,31-87`。官方頁面：

- <https://docs.datahub.com/docs/lineage/airflow>
- <https://airflow.apache.org/docs/apache-airflow-providers-openlineage/stable/guides/structure.html>

但 Airflow connector 在本版 DataHub UI 是 external：點擊後開文件，不是 DataHub 的連線設定表單（前述 `sources.json` 與 `SelectSourceStep.tsx` 證據）。所以它是「Airflow UI／DAG + DataHub lineage management」，不是「DataHub UI 建立 Airflow program」。

### Dagster

DataHub Dagster sensor 在每次 pipeline run 後發送 pipeline、task、run results；asset key 可轉成既有 DataHub Dataset URN，並可從 asset metadata 中的 SQL 解析輸入／輸出。自訂 asset lineage extractor／URN converter 可處理非標準命名。

來源：`docs/lineage/dagster.md:7-17,19-69,86-177`；官方頁面：

- <https://docs.datahub.com/docs/lineage/dagster>

同樣地，Dagster UI 負責建立與執行 pipeline，DataHub 保存 metadata／lineage；本版 DataHub Create Source 卡片只導向外部文件。

### OpenLineage

OpenLineage 是真正適合「通用 ETL runtime contract」的方式：Job／Run／inputs／outputs／facets 可由不同執行框架上報。DataHub OSS 提供：

```text
POST /openapi/openlineage/api/v1/lineage
```

DataHub 文件並指出：Spark／Airflow 應優先用其較緊密的 plugin；generic OpenLineage endpoint 可讓其他框架直接送事件。

來源：`docs/lineage/openlineage.md:5-31`；官方規格：

- <https://github.com/datahub-project/datahub/blob/e99431ec510d7a2001f815c6bf70913c493af76e/docs/lineage/openlineage.md>
- <https://openlineage.io/docs/spec/naming/>
- <https://openlineage.io/docs/spec/run-cycle/>
- <https://openlineage.io/docs/spec/facets/>

OpenLineage 解決的是「執行時知道實際讀了什麼／寫了什麼」，不是「DataHub UI 掃描任意 Python 並猜出 lineage」。

## 4. 其他已有 ETL connector

這些不是假設，而是本 checkout 的第一方 source README／UI catalog 已列出的現成對映：

### Matillion DPC

- Project／Environment：Container
- Pipeline：DataFlow
- Pipeline component／step：DataJob
- Pipeline execution：DataProcessInstance
- OpenLineage table reference：Dataset
- table／column lineage：lineage edge，column-level 可配合 SQL parsing

來源：`metadata-ingestion/docs/sources/matillion-dpc/README.md:3-18`、`.../matillion-dpc_post.md:18-20,98-109,132-167`；UI recipe：`sources.json:202-209`。官方：

- <https://docs.datahub.com/docs/generated/ingestion/sources/matillion-dpc>
- <https://docs.matillion.com/data-productivity-cloud/>

這是現成 connector 中最完整符合「program → steps → run → tables → columns」語意的選項之一，但前提是 ETL 確實在 Matillion DPC。

### SnapLogic

官方 source README 對映 Pipeline → DataFlow、Snap → DataJob、SQL table／Kafka topic → Dataset，並宣稱支援 table／column-level lineage。

來源：`metadata-ingestion/docs/sources/snaplogic/README.md:3-14`；UI recipe：`sources.json` 的 SnapLogic entry。官方：

- <https://docs.datahub.com/docs/generated/ingestion/sources/snaplogic>
- <https://www.snaplogic.com/>

### Informatica IDMC

Mapping Task／Taskflow 對映成 DataFlow + DataJob，source／target 是 Dataset，支援表級 lineage、ownership 與 stateful deletion；同一份文件明確寫「No column-level lineage」。

來源：`metadata-ingestion/docs/sources/informatica/README.md:3-18`、`.../informatica_post.md:19-25`；官方：

- <https://docs.datahub.com/docs/generated/ingestion/sources/informatica>
- <https://docs.informatica.com/integration-cloud.html>

### Airbyte／Fivetran

兩者較偏向 replication／sync：

- Airbyte：Connection → DataFlow、Stream → DataJob、Connection Job → DataProcessInstance，source／destination → Dataset，field mapping → FineGrainedLineage。
- Fivetran：Connector → DataJob、Connector Run → DataProcessInstance，source／destination → Dataset，並有 column lineage。

來源：

- `metadata-ingestion/docs/sources/airbyte/README.md:3-20`
- `metadata-ingestion/docs/sources/fivetran/README.md:3-16`
- UI entries：`sources.json:182-189`（Airbyte）及 Fivetran entry；官方：
  - <https://docs.datahub.com/docs/generated/ingestion/sources/airbyte>
  - <https://docs.datahub.com/docs/generated/ingestion/sources/fivetran>

若需求是「來源 table 複製到 summary／destination table」，它們可直接滿足；若需求是任意 SQL aggregation／商業轉換，不能把 replication connector 當成 transformation engine。

## 5. `sql-queries`：很有用，但不是完整 program solution

`sql-queries` 是第一方 ingestion module，不在本版本 `sources.json` 的 Create Source catalog。它讀 NDJSON query file，對每筆 query：

- 若有上下游表提示，採 explicit lineage；
- 否則用 SQL parser；
- 預設可從 DataHub lazy-load schema；
- 可處理 temp table 的 `session_id`；
- 產生 query／lineage／usage metadata。

來源：

- `metadata-ingestion/src/datahub/ingestion/source/sql_queries.py:61-108,131-401`
- `metadata-ingestion/docs/sources/sql-queries/sql-queries_pre.md:1-10`
- `metadata-ingestion/docs/sources/sql-queries/sql-queries_post.md:5-42`
- `docs/lineage/sql_parsing.md:15-29`
- <https://docs.datahub.com/docs/generated/ingestion/sources/sql-queries>

它適合：

- MSSQL Query Store／外部 query log 已能匯出 NDJSON；
- 想補 query-derived table／column lineage；
- 不想改 ETL 程式。

它不適合直接滿足：

- 由 DataHub UI 建立一個有名稱、版本、run lifecycle 的 program；
- 自動知道哪個 query 屬於哪個 ETL program；
- 由 DataHub 執行 SQL 並建立 summary table。

本專案更簡單的近似路徑是先評估 MSSQL source 的 `include_query_lineage`；它直接讀 Query Store／DMV，少一個外部 NDJSON export。但兩者都需要 SQL Server Query Store／權限，且 query history 本身未必保留可靠 user attribution。

## 6. DataHub SDK／manual lineage：可做 UI backend，但不是現成 UI

DataHub Python SDK 公開支援：

- Dataset／DataJob 等 entity lineage；
- dataset → dataset 的 column lineage；
- `infer_lineage_from_sql()`；
- `transformation_text` 建立代表 transformation logic 的 Query node；
- 讀取 upstream／downstream lineage。

官方文件：`docs/api/tutorials/lineage.md:1-12,27-104,223-235`，網址：

- <https://docs.datahub.com/docs/api/tutorials/lineage>

SDK 支援的 lineage 組合包括 Dataset ↔ DataJob，但文件明確限制：column-level lineage 與 transformation query node 只支援 Dataset → Dataset。這代表我們可以寫一個通用 reporter／backend，但 UI、mapping review、run evidence、program version 等產品流程仍需自行實作。

DataHub 原生 lineage V3 UI 也能手動搜尋並新增／移除 upstream/downstream entities；但這是編輯既有 lineage edge，不是建立完整 DataFlow／DataJob program。來源：

- `datahub-web-react/src/app/lineageV3/manualLineage/ManageLineageModal.tsx:74-224`
- `datahub-web-react/src/app/lineageV3/manualLineage/utils.ts:3-34`

## 建議決策樹

```text
ETL 實際在哪裡？
├─ SQL Server stored procedure / SQL Agent
│  └─ MSSQL connector（先做權限與 DataFlow/DataJob proof）
├─ dbt Core / dbt Cloud
│  └─ dbt connector + MSSQL target ingestion（先做 URN matching proof）
├─ Matillion / SnapLogic / Informatica / Airbyte / Fivetran
│  └─ 直接使用對應第一方 connector
├─ Airflow / Dagster / Spark / 其他可改 runtime
│  └─ 官方 plugin 或 OpenLineage（執行期上報）
└─ 任意 Python、沒有標準 metadata
   ├─ 能改程式：OpenLineage 或 SDK reporter
   └─ 需要 DataHub 內嵌操作介面：再做小型 MFE／外部 UI + API；不要先做 generic static-code parser
```

## 對本專案的最小 Proof of Concept

### POC-A：不新增程式，先驗證 MSSQL native path

1. 只在既有 `wferp-mssql-test`／AdventureWorks 測試資料庫補最小權限，不使用 `sa`。
2. 啟用 MSSQL connector 的 stored procedures、jobs、lineage；另開一個受控 recipe 測試 `include_query_lineage`。
3. 驗證一個 stored procedure 或 SQL Agent step：
   - DataHub 是否看到 DataJob／DataFlow；
   - summary table 是否為既有 MSSQL Dataset；
   - upstream／downstream 及欄位 lineage 是否正確；
   - procedure code／external URL／run evidence 是否符合預期。
4. 用 DataHub UI 的 Save and Run、Run History、Dataset lineage 做真入口驗收。

### POC-B：若程式是可調整的 SQL ELT，驗證 dbt path

1. 選一個 summary model，產生 `manifest.json`、`catalog.json`、`run_results.json`。
2. 先 ingest MSSQL target，再 ingest dbt，使用與 MSSQL source 一致的 environment／platform instance。
3. 驗證 dbt model Dataset 與 MSSQL summary Dataset 的 sibling、來源表 lineage、欄位 lineage、model run。
4. 在 DataHub UI 建立 dbt ingestion source；不要把 dbt build 誤當成 DataHub ingestion。

### POC-C：只有前兩條不適用才做 runtime reporter

對任意 Python／外部 ETL，先在一支真 ETL 加 OpenLineage／SDK 事件，固定：

- `job.namespace`／`job.name`／version；
- run id、start／complete／fail；
- input／output DataHub URN；
- 可取得時的 schema／column facets；
- source code URL／commit SHA 作為 metadata，不把程式檔偽裝成 Dataset。

先用 DataHub endpoint／SDK 發布並驗證 lineage，再決定是否需要 DataHub 內嵌 UI。若 UI 只需要登錄 job、選既有 Dataset、預覽 mapping、發布／撤回，就可做很薄的 adapter；不要重做 DataHub catalog／lineage viewer。

## 最終判斷

使用者所說的「通用需求」確實有成熟的通用標準與現成 connector 組合，但沒有一個不依賴 ETL runtime／artifact 的萬用 DataHub datasource：

- **最少客製化**：依實際 ETL 平台選 native connector。
- **最通用執行期方案**：OpenLineage。
- **最通用 SQL model 方案**：dbt artifacts + target database ingestion。
- **本專案目前最合理順序**：MSSQL native POC → dbt POC（若可採用）→ OpenLineage／SDK → 最後才是 MFE。

本輪未修改 DataHub Core、未修改上游 checkout、未部署、未重跑 ingestion、未執行新的 SQL 權限或 browser E2E。

# SalesDatamart case extension

This is the first real fixture for the generic `dataflow-discovery` Skill. It is a versioned case implementation, not the Skill's discovery answer and not a new extension state store.

## Scope and boundaries

- Source: `AdventureWorks2019`, seven approved Sales/Production tables, read-only.
- Target: the separately approved `SalesDatamart` database, schemas `dm` and `reporting`.
- Scope: status `5`, dates `2011-05-31` through `2014-06-30`, and `CurrencyRateID IS NULL` only. Non-NULL currency-rate rows are intentionally excluded because v1 does not ingest a currency conversion table.
- Fact grain: `SalesOrderID + SalesOrderDetailID`; measures use decimal arithmetic and exclude tax/freight.
- No scheduler, worker, watermark store, arbitrary SQL runner, source write, or Core change.

## Build the target

The DDL and principal scripts contain no credential values:

```text
sql/001_create_sales_datamart.sql
sql/002_provision_principals.sql
```

Run them from the trusted Host with the fixed SQL Server image and a protected SA secret. Supply `LOADER_PASSWORD` and `GRAFANA_PASSWORD` to `sqlcmd -v` only from a protected environment. The loader can DML only `dm` and read `reporting`; the Grafana identity can read only `reporting`. Do not put those values in a recipe, dashboard JSON, chat, receipt or repository.

The actual recovery environment and non-secret receipts are gitignored under `.local/evidence/dataflow-discovery/`.

## Run the fixed ETL

The Agent path uses the existing trusted Host Task/Decision/Run records: one
`FIXED_ETL` typed approval, one run/code/scope/expiry-bound operator grant, one
admission, and a fresh commit authorization over the owning private pipe.
`--host-controlled` is not a browser/model command endpoint. Version 1.0.1 binds
Python 3.11.15 / SQLAlchemy 1.4.54 / python-tds 1.17.1 / sqlalchemy-pytds 0.3.5.
The Host freezes the four package files, enforces a 300-second attempt window and
bounded output, and records aggregate COMMITTED/FAILED/UNKNOWN outcomes. UNKNOWN
never authorizes replay. Closed runs cannot admit/authorize another execution;
recording an outcome does not reopen them. Cancellation is not rollback proof.
The source observations do not claim a cross-statement snapshot; an approved
quiescent source window is required for the current case.

The commands below are the separate trusted-operator path, not Agent consent or
an invitation to rerun previously successful loads. Never rerun the whole
principal-provisioning script just to change an existing account permission: it
also rotates passwords. Existing deployments need their own exact approved change.

The project environment already contains the pinned-compatible `python-tds` and `sqlalchemy-pytds` packages; no pyodbc/pymssql install is required for this case.

The trusted Host supplies `DATAHUB_MSSQL_PASSWORD` and `SALESDATAMART_LOADER_PASSWORD` through its protected secret control plane. The command exposes only the fixed scope; it accepts no endpoint, SQL, path or credential arguments:

```bash
PYTHONPATH=extensions/sales-datamart/src \
  .venv/bin/python -m sales_datamart.cli --dry-run

PYTHONPATH=extensions/sales-datamart/src \
  .venv/bin/python -m sales_datamart.cli
```

`--dry-run` is read-only. A normal run acquires a SQL Server application lock, extracts and validates the approved source scope, upserts Type 1 dimensions and fact rows in one target transaction, reconciles count/quantity/amount/distinct-order metrics, and commits only after validation. Failure rolls back; rerunning the same scope does not duplicate fact keys. Receipts contain aggregate evidence only, never rows or credentials.

## Second pipeline: monthly/category summary (data load verified; import incomplete)

The separately requested second Python ETL is `sales_datamart.summary::run_summary`.
It does **not** rerun `sales_datamart.cli` or reload AdventureWorks. It reads existing
`dm.fact_sales_order_line`, `dm.dim_date` and `dm.dim_product`, and writes only the
new `dm.monthly_category_summary` table. This is a real business aggregation, not a
fixture or a discovery answer. The discovery backend must derive its lineage.

- Grain: month-start date + product category ID. Missing category is ID 0 / Unknown.
- Measures: line count, distinct orders **within that month/category**, quantity,
  net sales and source line total. Distinct order counts cannot be summed across
  categories; an order may contain products from several categories. No currency
  conversion or additional currency claim is made.
- Build only with `sql/004_create_monthly_category_summary.sql` and the separately
  authorized protected database-build identity. Existing-object collision fails;
  do not drop/adopt/recreate it or rerun password/principal scripts. No GRANT is
  added: the existing loader's `dm` DML grant applies to the new table.
- Default execution observes source totals only. `--apply` is a trusted-operator
  operation replacing only the new summary rows inside one SERIALIZABLE
  transaction. It uses the existing source application-lock resource, bounded
  login/query/lock waits and no retry; it does not consume or reopen old ETL consent.
- Before commit: reconcile independent fact totals, exact grouped rows and the
  summary primary key. After commit: fresh-connection readback while keeping the
  session-owned coordination lock. Failed commit/readback/cleanup is UNKNOWN and
  requires reconciliation, never an automatic repeat.
- The existing protected loader secret is supplied by the trusted Host, not CLI
  arguments, models, logs or a recipe. No source rows are emitted; receipts contain
  aggregates. Composer metadata analysis never executes/imports this program.

On 2026-09-22 the owner authorized one create and one new ETL attempt. The table
was created once; native readback confirms eight columns, the two-column primary
key and no triggers. **Do not replay CREATE.** The one ETL attempt returned
`TypeError / FAILED_PRECOMMIT`; the process exited, and read-only reconciliation
found zero summary rows, no loader sessions and the coordination lock available.
Do not retry the consumed attempt. Source inspection finds an API mismatch:
SQLAlchemy-pytds 0.3.5 calls `connection.autocommit(False)` when engine isolation
is specified, while python-tds 1.17.1 exposes that member as a bool property.
The original safe receipt lacks a traceback; the failure is preserved in
`summary-etl-stopped-reconciliation-20260922.json`. The owner then authorized a
repair and one new summary-only attempt. A real connection-only probe reproduced
`'bool' object is not callable` at the dialect setter, without ETL/DDL execution.
The program now sets isolation through the public `pytds.connect` parameter;
no installed package, isolation guarantee, credential or permission was changed.

The newly authorized attempt committed on 2026-09-22 at 02:00 UTC and verified
140 summary rows on a separate connection. Totals: 75,284 lines, quantity178,425,
net sales/source line total72,418,506.319091. Both connections verified SERIALIZABLE.
Evidence under `.local/evidence/datahub-etl-composer/`:
`summary-isolation-recovery-probe-20260922.json` and
`summary-etl-authorized-retry1-20260922.json`. Both attempts are consumed; no replay.
This confirms this data load, **not metadata ingestion or Composer acceptance**.

## Grafana assets

- `grafana/datasource.template.json`: no-secret datasource shape, fixed UID `dataflow-salesdatamart`, host-network endpoint `127.0.0.1:14334`.
- `grafana/dashboard.json`: fixed UID `dataflow-sales-v1`, fixed folder UID `dataflow-discovery`, seven panels (KPI, monthly trend, category, territory and quality summary).
- `metadata/metrics.md`: semantic and aggregation contract.

These versioned definitions were deployed under separate approval to Grafana org 1 on 2026-09-14. Dashboard v2 and eight browser/SQL filter scenarios passed; the existing `wferp-test` datasource was not modified. This is historical deployment evidence, not a fresh health check. Authenticated non-owner permissions and the complete DataHub metadata chain remain open; see the [2026-09-19 inventory](../../docs/verification/datahub-progress-inventory-20260919.md).

For Grafana 13.1.2, `jsonData.encrypt` is the string `"true"`. On 2026-09-14 the user explicitly approved `tlsSkipVerify:true` only for this dedicated datasource → `127.0.0.1:14334` / `SalesDatamart` / reporting-only reader. Traffic remains encrypted, but the server certificate is not authenticated. This local public-sample test exception is not suitable for production or other endpoints; it requires no original MSSQL restart. The 5-second connection timeout is not a statement timeout. All panels bind the dedicated datasource; variable All uses native expansion with `:sqlstring`, dates use UTC dashboard coordinates, and local-currency amounts do not assert USD.

The offline public-ingestion-entrypoint tests verify connector/adapter shape separately from live Grafana SQL. Actual dashboard queries were validated by `scripts/verify-grafana-sales-datamart.mjs`; those receipts do not prove live Grafana metadata ingestion. See [compatibility evidence](../../docs/verification/dataflow-discovery-dm02-compatibility.md). ETL statement timeouts/bounded extraction, DDL collision protection, and remaining quality negatives are explicit `data-safety` work, not claims that the deployed database/ETL has never been implemented.

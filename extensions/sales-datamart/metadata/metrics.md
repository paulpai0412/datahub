# SalesDatamart v1 — fixed semantic contract

這份文件是本案例的版本化業務契約，並非 DataFlow Discovery 的分析答案。Discovery 必須從實際 ETL、SQL view 及 Grafana query 產生候選，再由 Host 驗證與人工核准。

## Scope

- source: `AdventureWorks2019` 的核准七表；source reader 只讀必要表。
- target: `SalesDatamart.dm` 與 `SalesDatamart.reporting`。
- fact grain: 一列 `SalesOrderID + SalesOrderDetailID`。
- order date: `2011-05-31` through `2014-06-30` inclusive。
- status: `SalesOrderHeader.Status = 5`。
- currency: `SalesOrderHeader.CurrencyRateID IS NULL` only. The source has non-NULL currency-rate rows, so v1 never mixes them into the local-currency measures. NULL alone does not identify an ISO currency code; charts say local currency and do not assert USD.
- refresh: one-shot full approved scope, Type 1 dimensions, no watermark or scheduler.

## Measures

- `LineNetAmount = OrderQty * UnitPrice * (1 - UnitPriceDiscount)`.
- `Sales amount = SUM(LineNetAmount)`; excludes tax and freight and is not a payment/accounting-revenue assertion.
- `Quantity = SUM(OrderQty)`; units are not assumed comparable across products.
- `Distinct orders = COUNT(DISTINCT SalesOrderID)`.
- `Average order value = Sales amount / Distinct orders`; zero denominator is `NULL`.
- Amounts use decimal arithmetic. ETL stores six fractional places; displayed AOV rounds to six places with SQL Server `ROUND`/scaled integer arithmetic (half-away-from-zero), and Grafana may format the display to two decimals.

## Join and null contract

`SalesOrderDetail.SalesOrderID` joins `SalesOrderHeader.SalesOrderID`; product, customer and territory source keys are validated before loading. Missing customer/territory association is represented by the target unknown member only for valid source `NULL`; an orphan key blocks the transaction. Product category names can be `NULL` when a product has no subcategory and are displayed as `Unknown` in reports.

The target keeps source business keys and stable surrogate dimension keys. Generated `DateKey` and target surrogate keys have no fictitious source-column lineage. Type 1 updates do not claim historical attribute reconstruction.

## Consumer contract

`reporting.v_sales_order_line` is the single reporting source for the fixed dashboard. Every panel explicitly binds datasource UID `dataflow-salesdatamart`. Panels share date, territory and product-category filters and use the loaded historical range, with UTC dashboard calendar coordinates so browser timezone does not shift date labels. This does not assert that source `date` values carry timezone information.

The All option uses Grafana's native expansion (empty custom `allValue`) with `:sqlstring`; an unquoted custom sentinel is not an SQL wildcard. A category or territory subtotal is not a distinct-order additive component; re-aggregate from the detail view for a new slice. Filtered AOV divides the selected lines' amount by orders represented in those same lines, not by all original order totals.

Monthly sales still group by calendar year/month. The time-series coordinate is the first selected order date in that month (`MIN(OrderDate)`), not an earlier month boundary outside the active date filter. This preserves partial-month amounts while keeping their points visible. Grafana numeric-frame reconciliation uses an absolute tolerance below 0.000001 for amounts/AOV; counts and quantities must match exactly. Display formatting is not the six-place reconciliation evidence.

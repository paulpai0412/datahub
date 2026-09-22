# Lookup key／value 宣告（離線，2026-09-15）

## 已完成的限定能力

`python_lookup_values.bind_python_lookup_values(...)` 重現既有record consumers及per-context query projection，
將dictionary comprehension的key／value讀取分開核對到同一SQL mapping-result context。

共享graph新增：

- fixed-arity、無starred的tuple回傳／解包，保留index與arity，不以最後一次assignment或第一個tuple值代替。
- dictionary comprehension的key/value、單一iterator、filter refs，contents／duplicate keys不升格。
- 單一return的getter wrapper宣告與 `get(key)` 語法；僅從source-bound literal/parameter/assignment解析field key，不求值捕獲source。
- `get`／key conversion／missing-key behavior仍未驗；dynamic key、default argument、不符result label大小寫不猜。
- key與value必須各有value-role read且指向同一exact invocation的SQL result；condition／prior角色不混為value來源。

tuple解包及helper effects保留unverified findings；舊 `lookup_result_value_unverified` 不因取得宣告而移除。

## 真九檔案例

原snapshot、conditional Host scopes／probe、recorded Catalog的hash核對後：

| 寫入slot | slots | dictionary key來源 | dictionary value來源 |
| --- | ---: | --- | --- |
| TerritoryKey | 4 | dim_territory.SourceTerritoryID | dim_territory.TerritoryKey |
| ProductKey | 2 | dim_product.SourceProductID | dim_product.ProductKey |
| CustomerKey | 2 | dim_customer.SourceCustomerID | dim_customer.CustomerKey |

**8個lookup key/value宣告符合另列physical-owner期望**，不是來源業務ID直接生成surrogate key。
56個write slots與49個record-linked slots均保留；transport1423 nodes／331 unresolved，不能用不同展開範圍的數字宣稱完整度。

尚未證明：dictionary key唯一／最後覆蓋是否發生、conversion無損、輸入key可匹配、NULL/Unknown分支、lookup實際成功、或任何runtime值。
全部status仍INCONCLUSIVE，publication／runtime／duplicate-key／lookup-match flags維持false。

## 驗證

新增6tests，相關13suites **124 PASS**：tuple位置調換、arity/star拒絕、helper get key/value分離、大小寫/dynamic/default拒絕、
filter／condition角色、多iterator不假設同一query mapping。

首輪fixture的SQL與dict key字串放同一行，觸發既有 `ambiguous_python_sql_line`（得到0 slots），不是lookup parser通過後遺失欄位。
已先核對reason，再把fixture參數宣告移到獨立行；未放寬legacy source-location gate。

`.local/evidence/dataflow-discovery/`：

- `python-lookup-values-first-20260915.log`：fixture被legacy gate拒絕。
- `python-lookup-values-second-20260915.log`：新6tests通過。
- `python-lookup-values-final124-20260915.log`：final source全部相關124tests。
- `python-lookup-values-case-20260915.py`／`.json`：producer hashes、golden key/value與完整report。

Scoped LSP無新真type錯誤；新6項auxiliary imports以真.venv/PYTHONPATH/tests/case反證並記false-positive，舊consumer兩項沿用既有對帳。
未改strict False、不重播canary，不宣稱全專案clean。

## 下一步／非驗收項目

日期生成、轉型／rounding／日期語義、successful-path guards、mutable effects、Host branch/override/freshness/ACL與typed分開核准／發布讀回仍未完成。
新宣告不等於完整可信lineage，也不追認舊ETL run的runtime path。

Catalog仍是原時間的readback；無captured-source execution、credential、network、SQL/ETL/ingestion、publication或deployment。
Core、analysis1.0.2與live入口不變；main-only，Goal仍DM02／2 of12。

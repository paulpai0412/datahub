# Python mapping 宣告 → SQL bind slots（離線）

## 已取得的證據

新增 `python_bind_values.py`：

- `analyze_python_bind_arguments(source, entrypoint=...)` 沿既有SQL trace的**實際語法call path**，核對helper positional／keyword argument，再回溯SQL parameters expression。
- `bind_python_parameter_declarations(...)` 重現source/context/Catalog/write-slot核對後，將同一呼叫路徑上的mapping宣告與SQL bind name對應。
- flat reference graph保留參數／assignment、attribute、mapping field、lookup、算式、比較、條件選擇、generator／list comprehension及append sites。
- 可描述 `rows → list(rows) → conn.execute`，以及單一return、由empty list／append建立的local list helper；其他call results／decoder保持opaque。
- literal僅輸出type/hash，不輸出內容；mapping keys與attribute names是程式宣告，不是實際資料列。
- 圖限制為10k nodes／32層value解析；recursive／unsupported／partial transport明示不完整。重複reference不展開成指數大小。

**這是宣告傳遞，不是已驗runtime collection contents或Python值。**
`contents_verified`、`consumed_verified`、`result_verified`、`python_values_verified`及publication不升格。
即使找到所有SQL bind名字，也不能據此批准lineage。

## 反例與修正

新增11tests，相關9suites共 **93 PASS**：

- helper參數重排與兩條call paths不混用；同一target參數可實際引用不同名稱的Python attribute。
- parameter重綁不保留舊值，直接container item mutation及parameter method effects維持unresolved。
- 第一個red反例顯示 `params['x']=...` 會被誤略過、保留初始dict；已補該mutation邊界。
- 第二個red反例顯示同一If的else不能借用then內的assignment；已改以body／orelse／handler等block路徑核對dominance，不只比較祖先If。
- date算式／lookup／conditional分開，append與generator保留guards／未驗contents或consumption。
- dynamic／duplicate mapping keys不猜，literal不回顯、捕獲程式不執行。

## 真九檔案例

沿用原fresh snapshot ed276…、已有conditional Host scope／identity probe及舊Catalog紀錄，無新增live IO。

`python-bind-values-case-20260914.json`：

- 19 SQL uses、631 expression nodes；9個write contexts的 **56個slots找到56個mapping宣告reference**。
- 與先前write-parameter golden的context／field／bind names一致。
- fact的order_date_key維持binary expression，product/customer keys為lookup，territory key為conditional；line_net_amount只是row attribute，尚未追認它的計算。
- **仍有133個unresolved nodes**：name value56、mutation30、rebound/unsupported local42、parameter method effects3、unsupported expression2。
- decoder／dataclass回傳與alias mutation/escape等仍未證明；4個原SQL generator gaps不被當作已消費執行。
- 整體INCONCLUSIVE，actual branch未驗、Catalog非fresh、沒有源資料列／secret／SQL／ETL／metadata或deployment操作。

## 證據／重跑

`.local/evidence/dataflow-discovery/`：

- `python-bind-values-first-20260914.log`：直接item mutation反例。
- `python-bind-values-branch-red-20260914.log`：opposite branch反例。
- `python-bind-values-final93-20260914.log`：93tests。
- `python-bind-values-case-20260914.py`／`.json`：reproducer、完整graph／slot references、unresolved分布與producer hash。

```bash
PYTHONPATH=extensions/dataflow-discovery/src DATAHUB_TELEMETRY_ENABLED=false \
  .venv/bin/python -m unittest -v tests/test_dataflow_discovery_python_bind_values.py
```

已修新增AST型別錯誤；fresh scoped LSP剩6項auxiliary imports，實際.venv/PYTHONPATH/93tests/case反證並記false-positive。
不為歷史診斷改正確程式、不宣稱全專案clean。

## 下一段

需繼續核對 `_parse_*`／record constructor／returned collection的欄位來源與guards，
以及 `_as_int`／`_as_decimal`／`_line_net_amount` 等轉換及驗證條件，不能將opaque call或同名alias當copy。
Host入口的branch／override限制、fresh ACL／Catalog、typed lineage/semantic approval與發布讀回仍待完成。

新模組未接live bridge／analyzer／Agent，analysis1.0.2及Core不改；Goal仍DM02／2 of12。

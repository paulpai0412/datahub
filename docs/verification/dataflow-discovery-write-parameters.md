# INSERT／UPDATE bind參數 → 實體target欄位（離線）

## 已驗範圍

新增 `python_write_parameters.bind_python_sql_write_parameters()`：
先重現source-bound Python SQL contexts及Catalog核對，再以SQLGlot AST提取明列的write target。
只處理語法／欄位定位，不執行SQL，也不把bind name當成upstream column。

- INSERT需要explicit column list；VALUES多row與SELECT各position分開保留，長度／重複欄位不符拒絕。
- UPDATE SET欄位與WHERE／NOT EXISTS參數分開。predicate parameters不當成寫入欄位。
- target URN必須在相應process的writes binding，欄位用BoundDataset核對；missing／foreign-owner／多義位置拒絕。
- DIRECT_PARAMETER、EXPRESSION、DEFAULT_VALUE、NO_BIND_PARAMETER分開，只有語法依賴，不證明值、coercion或無損轉換。
- UPDATE RHS讀取本身欄位另列target_read_fields；外部owner、value subquery、INSERT SELECT FROM、SQL變數／unnamed參數保持unresolved。
- unassigned_catalog_fields只是「這段SQL未明列寫入」，不是自動推定generated key；不補造來源／邊。
- 只輸出欄位、參數名字、position／row index與expression hash，不輸出literal／bind values或SQL本文。
- predicate、affected rows、trigger/default、Python values與語義仍未驗；publication／runtime flags不升格。

## 測試與修正

新增8tests，相關8suites共 **82 PASS**。
首輪三個INSERT VALUES案例失敗：SQLGlot `Insert.where` 是parser boolean flag，
不是UPDATE／SELECT的Where節點。已在AST owning type分流：UPDATE讀自己的Where，
INSERT只讀SELECT expression的Where；不是把bool例外吞掉後宣告成功。

涵蓋explicit/reordered columns、omitted identity欄位、多rows／DEFAULT／literal privacy、
SET與predicate分離、CAST／算式／target讀欄、implicit/duplicate/missing/count mismatch拒絕、
SQL variables／foreign columns／subqueries及SELECT不被當write。

## 案例核對

沿用原九檔fresh snapshot、已有identity probe與明示configured-factory條件、
以及先前Catalog紀錄；沒有新live讀取、secret存取或SQL／ETL操作。

9個write contexts／**56 slots**與主會話按原SQL另列的target／parameter期望完全一致：

| statement | slots |
| --- | ---: |
| INSERT date | 7 |
| UPDATE／INSERT territory | 3／4 |
| UPDATE／INSERT product | 6／7 |
| UPDATE／INSERT customer | 2／3 |
| UPDATE／INSERT fact | 11／13 |

三個dimension identity key沒有出現在其INSERT／UPDATE slots；DateKey與fact的各key雖有bind slot，
也不代表其Python生成／lookup／轉型已驗。

另外9個SELECT contexts不是本層write；LOCK context仍未解、原4個generator gaps保留。
整體INCONCLUSIVE，仍不是完整CLI／actual branch／Python值／lineage或publication驗收。
Golden是與解析輸出分開列的期望，不是獨立reviewer。

## 證據／重跑

`.local/evidence/dataflow-discovery/`：

- `python-write-parameters-first-20260914.log`：原VALUES失敗。
- `python-write-parameters-final82-20260914.log`：82 PASS。
- `python-write-parameters-case-20260914.py`／`.json`：可重現分析邏輯、九組goldenExpectations、56 slots、policy／Catalog／producer hashes及限制。

```bash
PYTHONPATH=extensions/dataflow-discovery/src DATAHUB_TELEMETRY_ENABLED=false \
  .venv/bin/python -m unittest -v tests/test_dataflow_discovery_python_write_parameters.py
```

新7項auxiliary imports已用真.venv／SQLGlot／82tests及case核對反證並記false-positive，
不修改正確imports／安裝工具迎合診斷，也不宣稱全案clean。

本模組未接live Agent／bridge／analyzer，不改analysis1.0.2、Core或部署。
Goal仍DM02／2 of12；下一段需要追Python row/dataclass／generator／dict參數真正來源與轉換，
不能只把這56個參數名與上游查詢的同名alias直接連線。

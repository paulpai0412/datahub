# SQL查詢輸出 → 實體欄位來源（離線）

## 已驗範圍

新增 `python_projection.bind_python_sql_projections()`，先重現Python SQL context／Catalog binding，
再用既有SQLGlot30.12.0公開 `lineage()`／`MappingSchema` 核對query-output的value origins。
關閉schema inference、開啟strict column qualification，schema只取自相應Host scope已綁定的Dataset。

- 新8tests，連同provenance／Catalog suites共 **74 PASS**。
- 支援已測alias、SUM、CAST、CTE、UNION、雙table算式、quoted physical column及Catalog wildcard展開。
- leaf的實體Table由AST取得，再按Host scope核對URN；column亦由AST解析並透過BoundDataset.field核對實際fieldPath，不靠strip alias猜owner。
- missing／ambiguous columns拒絕。SQLGlot的dict可能折疊重複輸出名，另核qualify後SELECT（包含wildcard展開），不接受重名結果。
- constant與COUNT(*)沒有physical column origin，不虛構 `*` 或某個欄位。
- 不支援case-sensitive Catalog policy、INSERT／UPDATE等write-target projections及SELECT INTO；不假裝目標欄位已解析。
- report只保留query-local output name、實體URN／fieldPath／schema hash、expression hash，不輸出SQL／literal／bind值。
- Catalog status與projection status分開；projection不完整時整體INCONCLUSIVE。所有publication／runtime／transformation semantics驗證標記仍false。

## 案例核對

原九檔snapshot仍ed276…，沿用上一段明示的**configured-factory條件**及已完成的identity probe，
以及先前Catalog紀錄；沒有新SQL、network、credential讀取或source execution。

19 contexts：

- 9個SELECT可描述投影來源，共 **37輸出、35個實體欄位來源參照**。
- 另外2個輸出 `fact_count`、`reporting_view_count` 是rowset COUNT，不指定虛假的physical column。
- 9個寫入contexts保留NOT_QUERY_PROJECTION／PARTIAL。
- 1個application-lock仍Catalog context unresolved；原4個generator gaps不消失。

主會話對照原SQL／key lookups另列期望owner：source四查詢25欄、三個dimension key lookups6欄、
metrics5欄與view count1欄，九組／37輸出全部吻合。這是獨立於SQLGlot輸出的golden期望，
**不是獨立reviewer審查**，也不證明CAST無損、Python清洗／轉換或商業語義。

## 證據

`.local/evidence/dataflow-discovery/`：

- `python-projection-final74-20260914.log`：最終74tests。
- `python-projection-case-20260914.json`：完整輸出、conditional policy／Catalog觀測時間與hash、producer SHA。
- `python-projection-golden-20260914.json`：九query／37輸出／35實體來源的手工期望核對結果。

新增測試：

```bash
PYTHONPATH=extensions/dataflow-discovery/src DATAHUB_TELEMETRY_ENABLED=false \
  .venv/bin/python -m unittest -v tests/test_dataflow_discovery_python_projection.py
```

Fresh scoped LSP僅10項auxiliary imports，實際.venv／PYTHONPATH／SDK／SQLGlot及case均通過，
已記false-positive；沒有修改正確imports或安裝工具迎合診斷，不宣稱全專案clean。

## 尚未完成

這些是**查詢輸出值的來源**，不是Python row/dataclass／generator／dict參數的轉換，
也不是目標INSERT／UPDATE欄位、完整WHERE/JOIN／rowset／grain語義或可信lineage。

需繼續追 `_parse_*`、row欄位轉換與bind parameters，再核write-target欄位；
generated keys／日期鍵／金額計算不得用同名直接接邊。Host入口、branch／override限制、fresh Catalog/ACL、
typed lineage／semantic approval及發布讀回仍未完成。

此模組未接live bridge／analyzer／Agent，analysis1.0.2不改；無Core／deployment或metadata mutation。
Goal仍DM02／2 of12，成功probe／ETL／ingestion不重播。

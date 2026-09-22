# SQL mapping result → decoder input（離線，2026-09-15）

## 已實作

`python_query_decoders.bind_python_query_decoders(...)` 先重現source-bound per-context Catalog及SQL projection，
再沿SQL trace的實際caller位置核對result return與decoder參數。不以 `_fetch` 名稱或同名欄位建立關係。

支援的限定協定：

1. stable local helper僅含 `result = conn.execute(...)` 與 `return list(result.mappings().all())`（可有docstring）。
2. 核result owner、無參數mappings/all、builtin list未被shadow；多stmt、rebind、mutation或其他result協定保持unresolved。
3. helper result直接作為stable local decoder的positional／keyword argument，依實際signature核對接收參數。
4. decoder已描述的mapping read必須來自該參數，再對應同一SQL context的explicit SELECT result alias。
5. 保留alias原大小寫供Python mapping key exact match；SQLGlot/Catalog normalization只用於找projection，不能將Python key改為case-insensitive。

不支援assignment中轉／其他result API／多結果集／implicit result labels；不猜補。
`runtime_result_verified`、`runtime_values_verified`與publication均false，整體INCONCLUSIVE。

## 測試與真source case

新增8tests，相關11suites共 **111 PASS**。涵rename helper、keyword decoder input、case mismatch、result owner/protocol、
mutation/rebind/materializer shadow、不同DB contexts共用同一SQL process、decoder shadow、non-direct consumer、
缺欄／implicit label／multi-result，以及COUNT/constant無虛構physical origin、不回顯SQL literal。

`python-query-decoders-case-20260915.py`／JSON以fresh批准九檔snapshot、原conditional Host scope及舊Catalog紀錄驗證：

- 19 SQL contexts中的**4個來源查詢**，各沿真 `extract → _fetch → decoder` caller位置連到 `_parse_products/customers/territories/facts` 的 `rows` 參數。
- 26個record fields、**33個declaration read links**：value27、condition5、prior_declaration1；33個physical-origin references與先前projection期望相符，不是33個不同欄位或已發布lineage edges。
- Fact `line_net_amount`讀qty/price/discount，沒有借同名來源；`source_line_total`仍只有prior-declaration link，未把未知method effect升格。
- 其餘15 contexts仍unresolved：projection不適用10、非direct decoder consumer4、result transport未支援1。
- Decoder子圖的28 unresolved、4個既有SQL generator gaps、actual branch／override限制不因此解除。

已有56個SQL write slots／mapping宣告的證據仍保留；**query→decoder與record→consumer→write slots尚未完整接通**。
helper成功路徑／數值轉換語義、mutable collections及runtime identities仍不能由這些語法連結追認。

證據位於 `.local/evidence/dataflow-discovery/`：

- `python-query-decoders-first-20260915.log`：新8tests首輪通過。
- `python-query-decoders-final111-20260915.log`：final-source相關111tests。
- `python-query-decoders-case-20260915.py`／`.json`：source/proof hash、角色與owner核對、完整報告。

Scoped LSP的真AST unbound/optional型別問題已修；剩7項auxiliary import findings已以真.venv/PYTHONPATH測試及case反證並記false-positive。
舊快取沿用既有對帳，不改strict False、不重開canary、不宣稱全專案clean。

## 仍未驗收

沒有執行source／SQL／probe／ETL、沒有憑證讀取、network、metadata寫入或deployment；Catalog為原時間的recorded readback，非fresh。
新模組未接live bridge/analyzer/Agent；Core與analysis1.0.2不變，Goal仍DM02／2 of12。
下一段核 `Extracted`／record collections→consumer fields，然後才是完整helper語義、fresh Host/ACL、typed分開核准及發布讀回。

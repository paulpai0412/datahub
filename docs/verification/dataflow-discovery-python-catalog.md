# Python SQL 呼叫情境 → Catalog：離線整合

## 已驗結果

`python_catalog.bind_python_sql_dependencies()` 保留每個 SQL use 的context，
而不是將同一SQL process的最後一個scope覆寫前面情境。這是Host-only離線API，尚未接Agent或publisher。

- 10個新增tests；連同既有4層Python provenance及Catalog，共 **66 PASS**。
- 回歸直接展示舊per-process dict只留下最後一庫；新介面保留兩個call paths／context IDs，分別讀回兩個Dataset。
- 初版context只綁單檔trace，實測換source ID或修改同snapshot的config後會誤收舊scope。
  現已改為綁source ID、完整snapshot SHA、candidate digest、完整trace SHA及use位置；兩負例均在Catalog IO前拒絕。
- analysis1.0.2的Python SQL label只有line、沒有column。同一行有多個string literals時不作模糊連接，保持unresolved。
  多statement分開保留process；部分unsupported SQL不能躲在同literal的成功statement後。
- dynamic SQL、with後失效connection、缺scope、跨庫／allowlist失配、unknown／stale context、偽造analysis保持拒絕／unresolved。
- cache只限單次呼叫並含完整MssqlScope；下一次呼叫重新讀schema，不跨scope借用結果。trace gaps及空結果不宣稱完整。

## API

```python
bind_python_sql_dependencies(
    analysis, snapshot,
    path="case.py", entrypoint="run",
    scopes_by_context={}, reader=host_reader,
)
```

空scope map回傳context IDs／來源位置／guards／connection與factory references，不做Catalog IO。
Host用獨立connection provenance／ACL為精確context配置 `MssqlScope` 後，可再次核對。
函式每次都重驗source-bound analysis並重現trace，不接受caller自造trace或僅傳process label。

格式 `dataflow-discovery.python-catalog-binding/1`：每個context保留自己的bindings與status，
同一candidate可以在不同context解析成不同URN，不能丟掉context後轉交既有publisher。
`CATALOG_BOUND`只表示在Host所給scope下的Catalog key/status/schema核對，
**不表示scope本身已授權、分支已執行、欄位轉換正確或可發布**。
Runtime identity及publication flags仍false，既有 `catalog.bind_sql_dependencies()` 不被改成替Python挑scope。

## 真九檔案例核對（沒有新增live操作）

`python-catalog-case-20260914.json`：

- fresh source snapshot仍為已核准ed276…；分析1.0.2未變。
- 使用既有 `identity-probe-run-20260914.json` 及其已核准／未改operator，核對config/etl module paths與source SHA。
- Host診斷**明示條件**：只考察configured factory alternative（不注入engine、非dry-run），不是觀測到run_etl真的選了該分支。
- scope由connection origin → assignment → factory call → 已probe的config function核對；不再手工列出15個SQL constants的database對照，也不從Catalog唯一命中推庫名。
- 19個contexts：source選擇式4、target選擇式15。18個contexts的 **27依賴／13 datasets** 與紀錄中的39個key/status/schema aspects核對。
- application-lock SQL（etl.py:193）沒有既有Dataset SQL-process，明列 `sql_process_unmatched`；4個deferred generator gaps保留。
- 整體仍 **INCONCLUSIVE**。條件式scope診斷不是完整CLI／任意override／真正run branch驗證。
- Catalog來自先前 `catalog-binding-live-aspects-20260914.json`，原觀測時間保留在report；`isFreshCatalogReadback:false`。
  沒有新network／SQL／credential讀取、ETL／ingestion、metadata mutation或部署；不重跑已成功probe。

## 證據與重跑

`.local/evidence/dataflow-discovery/`：

- `python-catalog-first-20260914.log`：初期fixture誤傳Path給Host string-root API的錯誤，已修測試呼叫，非放寬Host。
- `python-catalog-context-scope-red-20260914.log`：跨source／config修改的舊scope誤收負例。
- `python-catalog-final66-20260914.log`：最終66 PASS。
- `python-catalog-case-20260914.json`：conditional selectors、完整context bindings、producer／probe／Catalog hashes與限制。

```bash
PYTHONPATH=extensions/dataflow-discovery/src DATAHUB_TELEMETRY_ENABLED=false \
  .venv/bin/python -m unittest -v \
  tests/test_dataflow_discovery_python_imports.py \
  tests/test_dataflow_discovery_python_factories.py \
  tests/test_dataflow_discovery_python_calls.py \
  tests/test_dataflow_discovery_python_sql.py \
  tests/test_dataflow_discovery_catalog.py \
  tests/test_dataflow_discovery_python_catalog.py
```

Goal仍DM02／2 of12。接下來仍需Host真正entrypoint／branch限制、fresh Catalog與ACL、
physical field及Python transformations、typed lineage／semantic approval和安全發布讀回；
不將這份條件式診斷當作完整Skill或ETL DataJob已發布。

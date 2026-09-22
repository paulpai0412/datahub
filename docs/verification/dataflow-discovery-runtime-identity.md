# DataFlow Discovery：限定唯讀 connection identity probe

## 結果與範圍

2026-09-14 16:00:47–48 UTC，使用者明確選擇「核准限定唯讀 probe」。
**本次明確配置的兩個連線身分已讀回核對成功**，不是重跑ETL或metadata ingestion。

| 配置 | 實際DB / DB_ID | login及DB user | instance / version |
| --- | --- | --- | --- |
| source | AdventureWorks2019 / 5 | datahub_ingest | 284caebbc279 / 15.0.4480.2 |
| target | SalesDatamart / 6 | sales_datamart_loader | 284caebbc279 / 15.0.4480.2 |

instance hostname與既有已核准MSSQL container一致：`284caebbc279fbb23f532c0406baeb3e4f9ac922aec972694c4321f1c2f209b1`。
原固定image digest、14334 port mapping、running狀態與前後source snapshot皆核對，沒有改服務或port binding。

## 為何需要這個probe

既有 `sales-datamart-etl-20260914.json` 有真正ETL的aggregate／reconciliation結果；
但 `_receipt()` 的source/target database名稱是固定字串，不是從當時的connection讀回，
也沒有記錄當時import路徑或engine override。因此它不能獨自證明某個runtime connection的身分。
保留舊成功receipt，不將本次probe追認為舊run的身分證據。

## 精確操作

Operator-only `scripts/probe-sales-datamart-identity.py`，不是Agent tool／通用Skill的source執行能力。

- 核准綁原九檔snapshot `ed276f258ceed74e491d85b16d8e54da9408cc9484b44a3bbccf8e4aec1af77f`、operator及固定query SHA。
- 載入hash核對過的 `sales_datamart`、`sales_datamart.config`、`sales_datamart.etl`，實際module.__file__與預期相對路徑／內容SHA相符。
- 僅執行既有source_connection／target_connection及engine factory；不呼叫run_etl、extract、load或CLI主流程。
- clean child用project .venv、`-I -B`、temporary HOME及明列env；只在operator child讀取本次已核准的兩個必要秘密，無模型credential存取／轉交。
- 明確指定兩邊host=127.0.0.1／port=14334，核對configuration與engine URL的非秘密欄位。
- 各連線一個固定identity SELECT：DB_NAME／DB_ID、ORIGINAL_LOGIN／SUSER_SNAME／USER_NAME及ServerName／MachineName／ProductVersion。
  另有SQLAlchemy正常的唯讀連線初始化查詢；不宣稱wire上總共只有兩個SQL statement。
- 公開SQLAlchemy do_connect event僅設login timeout與statement timeout各5秒，不改routing／credentials；parent wall60秒。
- exclusive receipt、連線前durable attempted標記；結果先保存再比對，unknown／timeout不自動重送。
  本次首輪成功，無重試；dispose及child/temp HOME清理完成。

已載入版本：SQLAlchemy1.4.54、python-tds1.17.1、sqlalchemy-pytds0.3.5。
前後source snapshot相同，current Agent allowlist／analysis1.0.2未變。

## 證據與重跑限制

gitignored `.local/evidence/dataflow-discovery/`：

- `identity-probe-approval-20260914.json`：user選擇、operator/query hashes、精確scope。
- `identity-probe-run-20260914.json`：`CURRENT_CONFIGURED_CONNECTION_IDENTITIES_VERIFIED`，兩邊attempted/verified、實際身分、module paths／source hashes／versions。
- `identity-probe-offline-20260914.log`：執行前7個無DB/Docker副作用tests，涵蓋明確flag、private secret選取／symlink/duplicate拒絕、wrong identity、replay拒絕、timeout與clean child env。
- `identity-probe-offline-final8-20260914.log`：另補真CLI malformed-approval／不回顯內容負例，共8 PASS；只增加tests，已核准operator bytes不變，沒有重做probe。

成功操作**不可從頭重跑**；exclusive receipt會拒絕。後續只讀回／核對這份證據，新的scope或再次probe需另准。

## 不代表什麼

- 沒有執行ETL、讀業務資料列、DML/DDL、改Source/Secret、ingestion、Grafana或DataHub metadata發布。
- 有載入並執行本次明確批准的configuration／factory程式；不要誤寫為「完全沒有執行任何source」。
  通用Discovery analyzer仍不import或執行輸入source。
- 不證明舊run的實際override／import、不驗整個CLI、任意傳入engine或不同環境。
- 不宣稱TLS server identity：沿用既有lab factory行為，核對的是本機已核准container與本次SQL回應。
- 不證明完整ACL、schema/object incarnation、跨庫原子snapshot、資料條件、SQL內容安全或field transformation。
- 這份operator證據不授予metadata publication；需再接Host的scope／freshness／typed approval與完整讀回。

Goal仍DM02／2 of12；下個整合點是把**已驗配置**與保留call-context的SQL provenance銜接，
不將多個connection使用同一SQL的情況折疊成單一process scope。

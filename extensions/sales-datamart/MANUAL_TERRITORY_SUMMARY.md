# 手動測試：Python 每月／銷售區域 ETL

**2026-10-02 15:31 UTC：使用者另行批准後，已建表並執行一次 ETL，提交與獨立連線讀回成功。**
新表為 250 筆、8 欄，主鍵 MonthStart＋TerritoryID；LineCount 合計 75,284、Quantity 合計 178,425，
NetSales／SourceLineTotal 各為 72,418,506.319091。來源與既有 category summary 的彙總觀測前後一致，
不將彙總一致冒稱所有來源 bytes 未變。沒有觸發器，未修改其他表、帳號或服務。
本次建表／ETL 的一次批准已使用，**不要重播 CREATE 或 --apply**。

**尚未對新表執行 DataHub ingestion、核對／更新 workspace 授權或發布 lineage。**
不是 TypeScript 插件，也不修改現有 Discovery／Host／部署。
私有執行收據：`.local/evidence/territory-summary-manual/{preflight,create,run,verify}.json`。

## 輸入與輸出

- 程式：`src/sales_datamart/territory_summary.py`，入口 `run_summary`。
- 資料庫：既有 `SalesDatamart`；不重新讀取／載入 AdventureWorks。
- 輸入：`dm.fact_sales_order_line`、`dm.dim_date`、`dm.dim_territory`。
- 唯一寫入表：**`dm.monthly_territory_summary`**。
- 粒度：月初日期＋來源區域 ID；既有 Unknown 維度成員沿用 ID 0。
- 欄位：MonthStart、TerritoryID、TerritoryName、LineCount、OrderCount、Quantity、NetSales、SourceLineTotal。
- OrderCount 是每個月／區域內的 distinct SalesOrderID，不宣稱任意跨群組加總仍去重。
- 金額沿用既有 fact 的範圍、精度與幣別限制，不做匯率換算或宣稱 USD。
- SQL 中包含日期轉換、三表 JOIN、GROUP BY、COUNT DISTINCT、SUM，以及多欄位來源，可供 Discovery 從真程式分析；沒有手寫 lineage mapping／預製答案。

## 1. 單獨建立新表（人工操作）

用你已授權的資料庫建表身分，在 SQL Server 工具執行：

```text
extensions/sales-datamart/sql/005_create_monthly_territory_summary.sql
```

腳本只建立新表；同名物件存在就拒絕。不要重跑原始 schema／帳號 provisioning，
不要 drop／adopt 現有表。程式不自動建表，也不修改既有 category summary。

## 2. 執行 ETL（人工操作）

從 `/home/timmypai/apps/datahub` 執行。沿用既有 `.venv` 內固定版本的
SQLAlchemy／python-tds／sqlalchemy-pytds，不需安裝新依賴。

連線沿用 `sales_datamart.config.target_connection`：預設 `127.0.0.1:14334`、
`SalesDatamart`、`sales_datamart_loader`。密碼須由可信操作環境注入
`SALESDATAMART_LOADER_PASSWORD`；不要貼進聊天、CLI arguments、程式、README 或 git。
這份程式不讀 `.local` 憑證，不用 ingestion／查詢 UI 的帳號代替 loader。
沿用本機案例的 driver 連線設定（包含 `validate_host=False`），不宣稱適合 production TLS。

先唯讀觀測 fact 總數／數量／金額（仍會連 DB 及取得協調鎖；不建表、不載入）：

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=extensions/sales-datamart/src \
  .venv/bin/python -m sales_datamart.territory_summary
```

預期成功狀態：`READ_ONLY_SOURCE_OBSERVED`、`targetWrites: 0`。
此結果不證明新表已建立或資料已載入。

確定新表已建立、具備輸入 SELECT／新表 DML 權限，並批准本次寫入後：

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=extensions/sales-datamart/src \
  .venv/bin/python -m sales_datamart.territory_summary --apply
```

`--apply` 會在同一 SERIALIZABLE transaction 內刪除**新表**既有資料再 INSERT SELECT；
其他 fact／dimensions／category summary 不寫入。沿用原 ETL application lock，
SQL timeout 30 秒、登入 5 秒、lock wait 0，不自動 retry。
提交前比對 fact 總量及双向 EXCEPT 分組結果；提交後保留鎖並以另一連線讀回。
沒有排程、Agent executor 或 DataHub metadata 發布副作用。

成功狀態：`COMMITTED_READBACK_VERIFIED`，含實際 summaryRows 與精確 decimal 字串總額。
未執行前不提供預期固定筆數／金額。`FAILED_PRECOMMIT` 須先查明原因；
`UNKNOWN` 表示 commit／readback／cleanup 無法確定，必須先對帳，**不得直接重跑**。
本次限定資料庫執行已驗證，證據見頁首；這不代表 DataHub lineage／UI 驗收。
離線單元測試本身仍不證明 SQL Server 執行成功。

## 3. pi-web 手動測試 Discovery

若需要原生 Catalog binding／完整欄位 lineage，先透過既有官方 ingestion 設定，
將**新表**納入正確 Source 的 metadata allowlist 並成功 ingestion；不重跑 ETL 作為 ingestion。
Host 還須授權新表 metadata 與包含此程式的 workspace。新增檔案不自動更新已批准的
snapshot digest／Dataset 清單，也不自動取得發布權。

在具備 `datahub_etl` 的 pi-web 會話貼上：

```text
請用 datahub_etl 分析這支 Python ETL：
/home/timmypai/apps/datahub/extensions/sales-datamart/src/sales_datamart/territory_summary.py
入口 run_summary。ETL 已執行完成，不要再執行、建表或重跑 ingestion。

先列出已授權 workspace 與已部署插件，使用 Python legacy 分析路徑。
只分析程式與當前可見的 DataHub schema，不執行程式或 SQL。
顯示 DataFlow、邏輯 Jobs、source/target tables、完整欄位值來源、
條件來源、生成欄位及來源證據。
新目標是 SalesDatamart.dm.monthly_territory_summary。

若新表尚未 ingestion、workspace/snapshot 未授權或解析器不支援，
明確回報缺口，不以名稱猜測、不改設定、不縮成表級成功。
本次只要預覽，不建立匯入 Task、不發布 metadata，不執行 ETL。
```

既有 Python 路徑可供測試，但本新入口尚未經真 Discovery／UI 驗收，不能假定
既有案例通過就代表本例已支援。待你核對預覽後，metadata 匯入仍走原可信確認流程。

## 離線回歸

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=extensions/sales-datamart/src \
  .venv/bin/python -m unittest -v tests.test_sales_datamart_territory_summary
```

測試僅 SQL AST 與替代 DB 邊界的單元檢查；涵蓋專用目標、精確 decimal、空輸入、
分組錯誤、唯讀模式、rollback、commit/readback 不確定與無 retry。不連 DB，
不將這些測試結果當成 ETL 或 DataHub E2E 證據。

本次實際檢查：9 項單元測試、CLI `--help`、Python 語法及四個新增檔案的空白檢查通過。
LSP 並非全綠：新模組檢查逾時，tests 的 Pyright 尚報 unknown import；使用專案
`.venv`＋上述 PYTHONPATH 的實際 import／測試已通過。AST scanner 另對五個
SQLAlchemy execute 接點報 injection 提示；已逐項核對：SQL 均為本模組固定宣告，
`_totals` 的呼叫者只傳固定 SELECT，application-lock resource 使用 bind parameter，
沒有 CLI／模型／外部字串拼接。未停用規則，也未為提示改寫固定 SQL。
全 repo `git diff --check` 被他方既有 downstream patch 的空白 context 阻擋；
本次四個新增檔案另行核對通過，未改動該 patch。

# SalesDatamart／AdventureWorks 隔離回復演練

## 結果與範圍

**兩個資料庫的 COPY_ONLY 備份、隔離還原、必要登入重建及資料庫權限比對通過。** 這不是完整 SQL Server／master／jobs 災難復原，也不是 DataHub ingestion 或 Discovery E2E 驗收。

- 原實例：`wferp-mssql-test`，ID `284caebbc279…`，原 volume `wferp-mssql-data-recovered-20260914` 保持不動。
- 演練實例：`dataflow-discovery-restore-check`，ID `004e0b856280362b787e31fd3e9b2aa21a2ce238fb073e6db3f6d63c9743d050`；新 volume `dataflow-discovery-restore-check-data`。
- 使用同一 SQL Server 2019 pinned image digest `sha256:46f719fd3457d4e7e8e5845fe00c35c20e7bae7ff1e8b9fe595f2a81029f5ba8`，`--pull never`，network=`none`，無發布 port，memory=2 GiB、CPU=1.5、restart=`no`。
- 備份兩庫：`AdventureWorks2019`、`SalesDatamart`。原 DB 未執行 DDL/DML、未停止／重啟／改密碼；COPY_ONLY 備份會新增 SQL backup history 與 staging `.bak`，不能宣稱原 volume 位元完全未變。
- 本次管理登入／備份／隔離部署經使用者明確核准。憑證只在可信本機程序／容器內使用；沒有讀取原登入 password hash、沒有把秘密送入 Agent runtime。

## 真實驗證

來源備份前、還原後、原來源複核的 **226 行聚合／schema 指紋／權限結果完全一致**。其中 216 行是資料／schema／constraints 比對，其餘為權限檢查；不是逐行業務資料比對。

| 項目 | 結果 |
| --- | --- |
| 七個來源 tables | Header 31,465、Detail 121,317、Customer 19,820、Territory 10、Product 504、Subcategory 37、Category 4 |
| 四個 dims（含 unknown） | Date 1,128、Product 505、Customer 19,821、Territory 11 |
| Fact／reporting view | 均 75,284 rows、17,489 orders、quantity 178,425、LineNetAmount 72,418,506.319091 |
| 原生還原 | 兩個 `.bak` 的 `RESTORE VERIFYONLY ... WITH CHECKSUM`、`RESTORE ... WITH CHECKSUM` 成功 |
| 實體完整性 | 兩庫 `DBCC CHECKDB ... WITH PHYSICAL_ONLY, NO_INFOMSGS` 成功；不是完整 logical CHECKDB |
| Reader | 七表 SELECT／VIEW DEFINITION；無 DML／db_datareader；未核准 Sales.SalesReason 查詢回 229 |
| Loader | dm 的 SELECT／INSERT／UPDATE／DELETE；無 CREATE TABLE／ALTER；可讀 reporting |
| Grafana reader | 可 SELECT reporting；不可 SELECT／DML dm，不能寫 reporting |
| 新登入實測 | clone 的 datahub_ingest 真登入讀 31,465 headers；loader 真登入讀 75,284 facts；Grafana reader 真登入讀 75,284 view rows |

備份不包含 master，因此還原後三個 DB users 一度為 orphaned。只在隔離實例以原 DB user SID 建立同名 SQL logins，使用新隨機臨時密碼，不新增 server roles、不放寬 DB grants。之後真登入及完整權限檢查通過。**這是必要登入的重新配置，不是複製原密碼或完整還原所有 server principals。**

## 證據與保留資源

主 run ID：`20260914T040138Z-15381e52`。

- 最終證據：`.local/evidence/dataflow-discovery/recovery-drill-20260914T040138Z-15381e52-verified.json`，status=`PASS`。
- Host backups：`.local/sqlserver/backups/20260914T040138Z-15381e52/`（目錄 700、檔案 600）。
  - AdventureWorks2019.bak：208,789,504 bytes；SHA256 `42e0105483ddc282de153bde9a108da1484f08f16e32af0c26969c5eb67b737e`。
  - SalesDatamart.bak：20,049,920 bytes；SHA256 `519391cc2358a357077e5657407694d7158f669fd19636e9dd2229f37f5adb30`。
- 來源 volume 中本 run 的 staging `.bak`、隔離容器／volume、還原用秘密檔均保留，**未刪除或 prune**。秘密檔為 `.local/sqlserver/restore-check.env` 及 `restore-check-principals.env`（600）；不列值。
- 新 helper：`scripts/verify-sales-datamart-recovery.py`。只限可信 operator，需 `--execute-approved-drill`；不是 Agent tool。現有同名容器／volume／秘密檔會拒絕新一輪，不能直接重跑來覆蓋本次資源。
- 四個離線 protocol regressions：`tests/test_sales_datamart_recovery.py`；證據 `.local/evidence/dataflow-discovery/recovery-protocol-tests.log`。測試有 mocks，不代替上述真還原。

## 失敗與對帳紀錄（未隱藏）

本次是保留現場後分段完成，不是從空環境一次直跑整支腳本即通過。

1. `20260914T035932Z-72718469`：檔案配置探針把不同 collation 欄位用 `+` 串接，Msg 451；尚未 BACKUP／建立演練資源。改成分欄輸出，未改資料庫 collation。
2. 主 run 已完成兩份備份並建立容器，ODBC 對 network-none 中的 `localhost` 連線逾時（0x2AFA），但 SQL Server 日誌顯示已 ready；明確 `tcp:127.0.0.1,1433` 可登入且兩個待還原 DB 尚不存在。保留容器與備份，不重新建立或重做備份。
3. `-reconciled.json`：AdventureWorks 備份已複製，`chown mssql:mssql` 失敗；pinned image 的 user 為 uid 10001、gid 0，沒有同名群組。改為讀實際 uid/gid；已存在副本先核 SHA256，僅重用完全相同的 bytes，不覆寫。
4. `-completed.json` 的實際 status 仍為 INCOMPLETE：兩庫 checksum／restore／physical CHECKDB 已完成，權限探針因 orphaned users 回 Msg 15517。此檔名不代表通過；沒有為修驗證而重做 restore。
5. 在保留現場重建三個必要登入後，`-verified.json` 才是最終 PASS。

回顧：只有資料檔還原與 aggregate 一致仍不足以恢復可使用行為；本次實測找出登入 SID 對應缺口，並以真最小權限登入驗證回復，而非移除權限檢查。原服務與演練實例嚴格分開，沒有以更廣來源權限或原密碼旋轉掩蓋問題。

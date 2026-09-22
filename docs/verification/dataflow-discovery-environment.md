# DataFlow Discovery — 範圍同步與 DM01 唯讀盤點

最新唯讀復核：2026-09-14 11:34 +08:00；以下恢復歷史另有時間標示。Goal `mtzxzwn6-1zw7vn`；任務 `TODO-dc390fa8`。主 agent 自查，非獨立審查。

## 最新狀態：DM01 已結案，現行 task 為 DM02

原生 Goal 已更新為 **2/12 complete、current=dm02**。使用者指出 task status 落後後，已把後續既有實作分開列入 [實際進度表](../datahub-sales-datamart-todo.md)：DM03 建庫／權限、DM04 真載入／rerun／rollback 已做；尚缺的建置負例、ETL timeout／邊界測試及 DM02 相容性仍如實保留，不把部分完成說成未開始。

[七表原生 canary 已完成](dataflow-discovery-dm01-canary.md)：Source version **4**，recipe `37002133…`，唯一 execution `597819ae-27cb-4f94-b0b7-fa3fe8900346` SUCCESS；7 Dataset／88 欄位含本次 UUID runId、pipelineName、lastObserved 均讀回通過。沿用既有 Secret refs，沒有讀值或改密碼。已按核准停止臨時還原容器，保留所有 volume／備份，原 MSSQL 仍 running。

以下保留較早的盤點過程；其中「canary 待核准／尚未執行」與「clone running」已被本節及新報告取代。

## 備份驗證後、canary 執行前的進展（歷史）

- 使用者已核准限定登入／唯讀核對，以及兩庫 COPY_ONLY 備份和隔離部署的具體批次。另明確核准真正登入檔 `.local/user.props`；`.local/datahub.env` 只有部署設定，沒有登入欄位。未使用部署簽章金鑰偽造 session。
- 官方 `/logIn` 成功；`me` 為 `urn:li:corpuser:datahub` 且 `manageIngestion=true`。已讀 Source `urn:li:dataHubIngestionSource:a513e611-5631-4cf2-8b96-3fa9fd1fee51`，name=`AdventureWorks2019 - all metadata`、SourceInfo version=`3`、CLI=`1.7.0.9`、executor=`default`、schedule=null。Source／Secret 尚無 mutation，也沒有讀 Secret 值。
- 既有 Source recipe SHA256=`b5fe9c11ee6c7117abc5a0918da29a86d2edaff49ea20918b5b2277916ed2d70`，仍開 profiling；password 為 `${DATAHUB_MSSQL_PASSWORD}`，sink=`http://datahub-gms:8080`／`${DATAHUB_TOKEN}`。已確認 Secret 名稱存在，不假設值有效。
- [隔離回復演練已通過](sales-datamart-recovery-20260914.md)：新備份兩庫、checksum／physical CHECKDB、226 項資料／schema／DB 權限比對；三個 orphaned users 在隔離實例以同 SID／新臨時密碼重建 login 後真登入成功。未改原密碼或業務資料。原 staging `.bak`、新容器／volume／臨時秘密檔都保留，尚未刪除。
- 演練容器 `dataflow-discovery-restore-check` 目前仍 running、network none、無對外 port、2 GiB／1.5 CPU；若後續停止，只停止這個臨時實例並保留 volume，不停止原來源或其他專案服務。
- **DM01 尚欠七表 native ingestion canary 與 metadata 讀回。** 已準備新 recipe：七表 allowlist、停用 profiling/views/procedures/query history/jobs/stateful deletion，SQL timeout 30 秒、login timeout 5 秒，沿用原 secret refs、CLI、URN normalization。提案 hash=`37002133b89a16959e7360e7caeb5041f73077b5ef61010d598d915e8b58be86`；SDK config 和 7 個正例／4 個排除例通過，但未套用或執行。需對 Source version 3 作 conditional 更新、讀回，再單次執行；版本／hash 改變或結果不明時不得盲重送。

證據：`dm01-native-source-inspection-20260914.json`、`dm01-canary-proposal-20260914.json` 與回復報告引用的 receipts，均在 gitignored `.local/evidence/dataflow-discovery/`。不是 Agent／WebUI／Discovery 發布驗收，Goal 仍為 dm01／1 of 12。

## 11:34 唯讀盤點（歷史狀態，後續更新見上節）

**DM01 仍未完成，Goal running／1 of 12。** 歷史段落的「尚未建立 SalesDatamart／ETL」是當時狀態，已由後續真實 ETL receipts 取代：target/reporting 75,284 rows、17,489 orders、quantity 178,425、金額 72,418,506.319091；重跑／提交前 rollback 證據均已保存。本次沒有重新執行 ETL 或重新量測 DB 數值，不把歷史成功當 ingestion／備份演練通過。

- 唯讀復核 `wferp-mssql-test` 仍 running，ID `284caebbc279…`／原 pinned digest／named volume 不變；14334 **仍綁所有介面**，不是 loopback-only。本次未重建、停機或改網路；若要收斂暴露面，需另核准保留 volume 的部署批次。
- 只 stat `.local/sqlserver/recovered.env` 與 `sales-datamart.env`：均存在且 mode 600；未讀值。原公開 AdventureWorks backup 仍存在（208789504 bytes）。
- GMS health 200；未帶憑證的 DataHub `me` 與 Grafana org 查詢均 401。這不是證明所有可信 session 均不存在；本輪未獲取／嘗試任何 cookie 或管理密碼。
- 現有 `.local/recipes/adventureworks2019.yml` 啟用了 profiling、views、stored procedures，且無七表 allowlist，**不得直接用於 metadata-only canary**。本次僅讀取已知無秘密 placeholder 的 recipe，未修改、註冊或執行。應先由有效控制面讀出精確 Source URN／目前 recipe，再提出只含已核准七表、關閉 profiling／procedure／query-history 的明確變更批次；不能默默替換既有 Source。
- 隔離備份／回復方向已核准，但實際 COPY_ONLY 備份、管理憑證存取與新臨時容器／volume 尚未執行。擬定目標：來源 `AdventureWorks2019`＋`SalesDatamart`、受保護 `.local/sqlserver/backups/`、臨時 `dataflow-discovery-restore-check`／`dataflow-discovery-restore-check-data`、同 pinned image、無網路／無對外 port，不停止原服務、不覆寫原檔／volume、不刪除演練資源。需確認這個具體批次與秘密存取；不能把曾還原公開 sample backup 當這項新演練。
- 磁碟可用約 858 GB；記憶體 available 約 4.44 GB、swap 已用約 5.86 GB，屬時間點觀測。演練須再檢查並限制臨時容器資源，不能任由新 SQL instance 影響既有服務。

非秘密機器證據：`.local/evidence/dataflow-discovery/dm01-control-plane-preflight-20260914.json`（mode 600）。本輪未作 DB／DataHub／Grafana／Docker mutation；只新增本地 preflight 記錄與文件。Discovery／publisher 的離線修正見 [Astra review](dataflow-discovery-astra-review.md)，不替代此處的 live 缺口。

## 範圍同步完成（scope-discovery）

已修正設計及 TODO：正式名 DataFlow Discovery、Skill ID `dataflow-discovery`；SalesDatamart 是第一條驗證資料流，不是通用Skill／validator／publisher中的硬編碼答案。新增唯讀snapshot、中立候選／定位證據、工具接線、Host驗證、獨立golden與有界變更／unresolved負例，保留原DM01–DM09全部業務交付。

- [設計](../research/datahub-sales-datamart-v1.md)：本輪檢查時 SHA256 `1cf242ee376f895543a6a09b65d0bb5edf195799d4f15de7461b981a605d255e`。
- [實作清單](../datahub-sales-datamart-todo.md)：本輪範圍檢查時 SHA256 `5d6326359efd2af01633f64eb2fe184fdaebd63154672f3fd0e19f528c892550`（後續會追加環境進度）。
- 範圍檢查：本地文件連結／fences／Goal及Skill命名通過，9個DM＋2個Discovery實作章節均未勾完成。Core checkout `git status --short` 空白。
- Goal 的 scope-discovery 已完成，dm01 已開始；產品碼、DDL、Skill、connector或部署尚未變更。

## DM01 目前觀測（未完成）

在 Docker context `default`，只讀查容器摘要、指定物件的非秘密欄位及本機無憑證health/API；未讀Env、credentials、cookie、私人設定或其他專案原始碼。

| 項目 | 結果 | 能證明／不能證明 |
| --- | --- | --- |
| 恢復來源 `wferp-mssql-test` | 新容器 ID `284caebbc279…`，SQL Server 2019 image digest `sha256:46f719fd…`，`running`，`restart=unless-stopped`，publish `0.0.0.0:14334→1433` | 已恢復本機 AdventureWorks backup；容器名稱沿用歷史相容名稱，不代表 WFERP 功能恢復。歷史容器刪除原因與時間見 [移除診斷](../../.local/evidence/dataflow-discovery/mssql-removal-diagnosis-20260914.md)（gitignored） |
| 其他MSSQL候選 | 按name=mssql/sqlserver/sql-server列舉無結果 | 僅名稱篩選結果，不能當全網路來源盤點 |
| Grafana | `grafana-grafana-1`，ID `f7f9ead362b7`，image `sha256:d177053ab62253815f130d81504f77063baf5fd4ca93299d6048453bd31e047a`，host network | 找到既有本機實例，不代表可以直接改其org／資產 |
| Grafana health | `http://127.0.0.1:3000/api/health` → database=ok、version=13.1.2、commit=7f247b37a4e51a1ed33904ec63ac6c6087bf7f48 | 公開健康狀態；非datasource／folder／schema驗收 |
| Grafana org | 已授權唯讀查到 org ID1／Main Org.；測試登入不寫入證據 | 僅證明既有目標與讀取授權，不代表本案 dashboard／datasource 已驗收 |
| DataHub UI／GMS | localhost:9002 →200；localhost:18080/health →200 | 健康，不代表authenticated metadata／run／Skill E2E |
| 來源持久化 | 新容器使用 named volume `wferp-mssql-data-recovered-20260914:/var/opt/mssql`；backup mount 僅讀取 | 已避免再次依賴 writable layer；尚未完成隔離 volume backup／restore 演練，不宣稱完整災難復原 |
| 本機工具 | 系統Python3.14.4、Node24.18.0；專案.venv已装acryl-datahub1.7.0.9、sqlglot30.12.0、SQLAlchemy1.4.54 | 版本摘要，不更改全機Python／依賴 |
| SQL Server Python driver | 專案.venv未裝pyodbc／pymssql；既有 `python-tds` 1.17.1＋`sqlalchemy-pytds` 0.3.5 | 已用現有 pytds dialect 以 reader 連線並讀回明細聚合；DM04 仍須把此 driver 固定納入 ETL 契約／測試，不另裝浮動套件 |

本機其他 Grafana 附屬容器即使已存在，也不是本案可利用或變更的新儲存；本轮完全未操作它們。

## 恢復後的來源核對（2026-09-14）

使用本機 `.local/sqlserver/AdventureWorks2019.bak`，SHA256 `fadd0d8d0fa952dd7620c7d543c74c58fac4f338b870cd4d4f14d01fdd01f5c9`、208789504 bytes；`RESTORE VERIFYONLY` 通過。Header 是 `AdventureWorks2019-Full Database Backup`、資料庫 `AdventureWorks2019`、SQL Server 2019 database version 904，backup 時間 2023-05-08。此檔案先前已由 Microsoft `sql-server-samples` AdventureWorks release取得；本次沒有重新下載或執行外部安裝腳本。

還原結果：`AdventureWorks2019` ONLINE、compatibility 150、SIMPLE recovery；持久化至 `wferp-mssql-data-recovered-20260914`，恢復 container 以固定 image digest 啟動並設定 `14334:1433`。主機 `127.0.0.1:14334` 與 DataHub Actions 容器的 `host.docker.internal:14334` 均可建立 TCP 連線。

核准七個來源表的聚合盤點：`Sales.SalesOrderHeader` 31,465、`Sales.SalesOrderDetail` 121,317、`Sales.Customer` 19,820、`Sales.SalesTerritory` 10、`Production.Product` 504、`Production.ProductSubcategory` 37、`Production.ProductCategory` 4。訂單日期 2011-05-31～2014-06-30；`Status=5`（唯一狀態）；`CurrencyRateID` distinct count 2,514，其中 NULL 17,489、非NULL訂單13,976；故全量尚未宣稱可跨幣別混加。首版 ETL／報表將把 `CurrencyRateID IS NULL` 作為明確 local-currency scope（17,489 orders／75,284 details），不把其他幣別默默混入。目標 key duplicate 與 detail/header、detail/product、header/customer、header/territory orphan 檢查均為 0。欄位型別／完整 key／FK 證據見 gitignored `.local/evidence/dataflow-discovery/source-schema-20260914.tsv` 及 `source-keys-20260914.tsv`。

已建立／恢復 `datahub_ingest` 讀取帳號於 `AdventureWorks2019`：只對核准七表授予 `SELECT`＋`VIEW DEFINITION`，不屬於 `db_datareader`；未列入表的 SELECT denied、`INSERT`／`UPDATE`／`DELETE` 均為 0。密碼依使用者指定設定，但不在文件／證據記錄。SA 管理密碼是另行隨機值，存於 gitignored `.local/sqlserver/recovered.env`（mode 600），不記錄值。既有 DataHub Secret 尚未透過控制面改寫；若其值不一致，需由已授權 DataHub 管理者更新，不能把 SQL 密碼送入 Agent runtime。

**重要差異**：這次恢復的是 Microsoft AdventureWorks2019 source。沒有建立已移除的 `wferp_test` database／WFERP tables；Grafana 既有 `wferp-test` datasource 仍指向 `localhost:14334`／`wferp_test`，因此不能把它當作本案 AdventureWorks datasource，也沒有修改它。完整非秘密機器證據：[mssql-recovery-20260914.json](../../.local/evidence/dataflow-discovery/mssql-recovery-20260914.json)（gitignored）。

## 恢復前使用者補充後的定位結果（歷史觀測）

- 使用者指示到 `~/apps/grafana` 查 `wferp-mssql-test`，允許唯讀查找該專案部署定義；未更動該專案。現行 `compose.yaml` 只有 Grafana、CSV server、Redis，沒有 SQL Server；`scripts/start-local-services.sh` 仍有14334健康檢查，未執行此啟動腳本／未讀其.env。
- Git history `9c4dffb`（2026-09-13）為 `Remove WFERP integration and fixtures`；舊history有 `wferp/test_db/docker-compose.testdb.yml`。這只證明repository移除整合，不證明任何外部資料被刪除；未還原舊程式或服務。
- 使用者提供測試Grafana登入授權後，經固定loopback公開API唯讀查到 org ID1／Main Org.、2個datasources。其中MSSQL datasource UID `afu9h8zppg64gd`／name `wferp-test` 記錄 `localhost:14334`、database `wferp_test`；只輸出非秘密白名單欄位，未取來源密碼或任何token。此設定不是AdventureWorks現場可用證據。
- 本WSL `127.0.0.1:14334` TCP refused，無listener。使用者另明確更正現在MSSQL port為 **1433**；本WSL `127.0.0.1:1433` TCP亦refused、無listener、Docker按publish1433無結果。需要主機名稱／IP或Windows端定位，不可把Grafana舊設定覆寫成1433後宣稱修復。
- 使用者已允許既有DataHub Agent模型分析本案新寫ETL／SQL、無秘密Grafana設定及核准metadata；排除業務資料列、秘密與其他專案source，不新增provider。此方向不再待決。

## 恢復前 localhost／容器網路及歷史 port 再核對（歷史觀測）

使用者要求再從Grafana查 `localhost:1433` 後：

- 本WSL對 `localhost`、`127.0.0.1`、`::1` 的1433全部 connection refused。
- 使用Grafana既有image內的 `nc -z -w 3`，對容器視角 `localhost:1433` 與 `localhost:14334` 均 unavailable；不只是WSL與容器的localhost字串差異。
- 再讀Grafana API，MSSQL datasource仍是 `wferp-test`／`localhost:14334`／`wferp_test`，未修改其port。
- 讀Grafana history `9c4dffb^:wferp/test_db/docker-compose.testdb.yml`，只輸出非秘密container_name/image/ports/volumes白名單：`wferp-mssql-test`、`mcr.microsoft.com/mssql/server:2019-latest`、**`14334:1433`**、`./init:/init`。因此舊部署的1433是容器內部port，主機port是14334；歷史映像為浮動tag，不能直接作新部署鎖。
- `git log`確認此22行compose在 `9c4dffb`（2026-09-13 01:02:31 +08:00）移除；但容器實際於 `2026-09-13 00:58:54.553 +08:00` 被 Grafana 會話執行 `docker rm -f` 刪除，並由 dockerd／containerd 同時刻紀錄交叉確認。完整時間線見 [移除診斷](../../.local/evidence/dataflow-discovery/mssql-removal-diagnosis-20260914.md)。本次已使用既有 backup 恢復，不是恢復原 writable layer。
- 本次未執行歷史 compose／初始化腳本，也沒有建立 `wferp_test`／WFERP資料；依使用者恢復指示，以固定 image＋新持久化 volume 建立同名測試容器並還原現有 AdventureWorks backup。沒有更改 Grafana 設定或 DataHub metadata；服務恢復後的 Secret／ingestion canary 仍須按既有控制面授權。

## 前置缺口與下一安全動作

1. MSSQL 已恢復：本機 host port 是 14334，container port 是 1433；DataHub Actions 的 `host.docker.internal:14334` 已以固定 client 實際認證讀回。既有 DataHub source Secret 是否同步尚未以新 mutation／ingestion canary 驗證，不能把 TCP／SQL 成功當 ingestion 成功。
2. Grafana已定位並有使用者提供的測試登入授權，org1可唯讀取得。未發任何資產寫入；後續明確批次核准後才新增專用資產。不得把登入秘密記到證據／runtime／repository。
3. 七個 candidate tables、來源日期／狀態／CurrencyRateID、key／orphan、schema／FK 與 backup verify 已完成；pytds reader connection 已驗，但 `SalesDatamart`、Python ETL、Grafana專用 datasource／dashboard、DataHub readback 仍未驗。
4. 不依賴真環境的解析／程式與測試準備可以在既定範圍繼續，但不得將DM01或live相依階段標完成，亦不得以fixture代替缺失來源。

本次已依使用者恢復指示啟動恢復容器、建立持久化 volume、還原 backup、建立最小讀取帳號並做聚合／權限核對；未寫入 AdventureWorks 業務資料、未執行 ETL、未安裝新 Python driver（沿用既有 pytds）、未修改 Grafana／DataHub metadata、未下載外部檔案。本報告不是產品完成證據；恢復操作／非秘密結果見 `mssql-recovery-20260914.json`。

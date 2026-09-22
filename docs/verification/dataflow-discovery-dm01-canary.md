# DM01 — 原生 MSSQL metadata canary（2026-09-14）

## 結果

**PASS：單次原生 ingestion SUCCESS，七個來源 Dataset／88 欄位已讀回核對。** 這只完成 DM01 的環境／範圍／安全操作里程碑，不是 Discovery、Grafana 或 Agent/WebUI E2E 完成。

- 使用者明確核准本機 DataHub Source 的 conditional 更新與單次 ingestion，不修改來源資料或 Secret 值。
- Source：`urn:li:dataHubIngestionSource:a513e611-5631-4cf2-8b96-3fa9fd1fee51`，version **3 → 4**。
- 名稱：`AdventureWorks2019 - metadata-only (7 tables)`。
- Recipe SHA256：`37002133b89a16959e7360e7caeb5041f73077b5ef61010d598d915e8b58be86`。
- Native execution：`urn:li:dataHubExecutionRequest:597819ae-27cb-4f94-b0b7-fa3fe8900346`，`SUCCESS`，duration **7057 ms**。
- CLI 設定 `1.7.0.9`／executor `default`；既有 Actions 為 `1.7.0.1+docker`。沒有新增 worker／scheduler／服務。
- 原 source／sink Secret refs 沿用，由既有 Actions 解析；沒有讀出、修改或傳給 Agent runtime。這次成功證明現有 refs 可完成連線與 metadata 寫入，故不需為了「同步」而另改秘密。

## 限定範圍及讀回

七表為 Sales.SalesOrderHeader、Sales.SalesOrderDetail、Sales.Customer、Sales.SalesTerritory、Production.Product、Production.ProductSubcategory、Production.ProductCategory。精準 table/database/schema allowlist；停用 profiling、views、procedures、query history、jobs、stateful deletion。SQL timeout 30 秒、login timeout 5 秒、單次人工啟動、無排程。

七個 Dataset 的 schemaMetadata 均核對：

- 欄位數與來源 schema receipt 相符，共 88 欄位。
- 欄位名稱、原生基礎型別與 nullable 相符；保留原 Source 的大小寫／URN normalization 設定，以 SQL Server 此來源的大小寫不敏感名稱對應記錄原名與 Catalog 名，不稱通用 case-sensitive resolver。
- `systemMetadata.runId` 精確符合上述 execution 的 UUID，`pipelineName` 符合 Source URN，`lastObserved` 晚於本批次開始。
- 部分 schema aspect 是 no-op，aspect version／modified time 沒變；以本次 runId／lastObserved 證明新觀測，不強迫改 schema 製造「新版本」。

這不是所有型別 precision/scale、DDL 特性或業務語義的完整驗收。

## 原始失敗與修正

1. 第一次更新回 HTTP 412，Source 仍 version 3／原 hash，沒有建立 execution。固定版本的 specific-aspect POST 預設 `createIfNotExists=true`；顯式改為 `false` 選擇 UPSERT，**仍保留 If-Version-Match=3**。對帳後以同一 request ID 繼續，沒有取消版本保護或改 Core。
2. Source 更新後單次工作成功，最初讀回錯把完整 execution URN 當 metadata runId。從實際安裝的 `executor_action.py`／`sub_process_task_common.py` 確認：Actions 取 URN 的 id，並以 `execution_ctx.exec_id` 覆寫 recipe.run_id。修正為精確 UUID＋pipeline＋觀測時間，之後只重做讀回，沒有重跑 ingestion。

## 證據與程式

均在 gitignored `.local/evidence/dataflow-discovery/`，不含秘密值：

- `dm01-canary-run-20260914.json`：原 HTTP 412。
- `dm01-canary-412-readback-20260914.json`：原設定未变的讀回。
- `dm01-canary-resumed-20260914.json`：Source version 4／唯一 execution SUCCESS；初次 runId 比對未過。
- **`dm01-canary-verified-20260914.json`：最終 PASS，7 datasets／88 fields。**
- `installed-executor-action.py`／`installed-sub-process-task-common.py`：只讀拷貝的已安裝相容性證據，未修改服務。
- `dm01-canary-operator-tests.log`：5 個 operator 負例通過；mock/no-network tests 不代替 live receipt。

`scripts/run-dm01-canary.mjs` 是限定 operator 批次，不是 Agent tool。既有 receipt 拒絕覆寫／重送；不應從頭再跑已完成批次。

## DM01 範圍結論及後續界線

- MSSQL、Grafana org1／13.1.2、DataHub 精確端點與版本已定位；Grafana 本案 UID／folder 見案例 README，尚未部署（屬 DM05）。
- 資料範圍為 Status=5、2011-05-31～2014-06-30、CurrencyRateID IS NULL；來源只讀，僅 SalesDatamart 可寫。
- 模型只可分析本案核准的 ETL／SQL／無秘密 BI 設定與 metadata；Host source allowlist 為已記錄九檔，不含資料列、秘密或其他專案。真 Agent 工具接線屬 discovery-skill／DM07，不作 DM01 前置。
- 使用静態還原樣本；現有 ETL 是分次 SELECT，**沒有宣稱跨表 snapshot 一致性**。未啟用 snapshot isolation 或 Query Store。原來源 before/after 的已觀测資料／schema 對帳一致，不代表任意並發來源的保證。
- 本次 native canary 的 30 秒 timeout 已套用；ETL `_engine` 尚未配置 statement timeout，及 NULL/unknown/縮 scope 等完整負例屬 DM04 待補，不能據此宣稱生產級有界 ETL。
- 兩庫隔離備份回復／最小權限及真登入已通過，見 [回復報告](sales-datamart-recovery-20260914.md)。臨時還原容器已按核准停止，volume／備份／秘密檔保留，原 MSSQL 仍 running；證據 `recovery-clone-stopped-20260914.json`。

# Metadata 驅動的自然語言 SQL／Grafana

2026-09-26 使用者最新決策。取代固定 SalesDatamart／六月／`sales_by_category` 作為產品限制的舊設計；舊案例與一次性驗收收據保留，不擴張解讀。

## 使用者要得到的結果

登入 DataHub → 在 pi-web 自由提問 → 使用目前登入者可見的 metadata 找到來源、表、欄位及語義 → 產生並實際執行唯讀 SQL → 在右側呈現真 Grafana Dashboard／Chart。不是預設題目、固定報表、靜態圖片或只有 SQL 草稿。任何可見 metadata 都可作為問題脈絡；不能用 SQL 查詢的資產須明確解釋，而不是偽造資料。

## 授權決策（取代舊查詢批准流程）

- **DataHub metadata 可見即為產品的查詢授權**。不再建立 `sqlSourceOnlyGrantsByActor`、逐人資料源清單、`sourceSelectApproved` 或每次查詢人工批准，也不以 `maxExecutions:1` 作日常產品控制。
- Host 使用可信登入者的 DataHub 公開 API，確認每個被引用的 Dataset／欄位仍可見。模型提供的 URN、table／column 名稱、描述與 SQL comment 都不是權限證明。來源 SELECT 由實際資料庫連線身分決定，DB 拒絕就回報拒絕；不另查或建立逐人 SELECT 權限表。
- 若來源使用共用帳號，DB 只辨識該帳號；本產品的個人資料可見範圍由 DataHub metadata ACL 決定，不宣稱具備個人 DB/RLS 身分。這是使用者選定的授權模型。
- 來源連線／Secret 綁定是連線基礎設定，不是第二份使用者授權資料庫。優先官方 Source／Secret 與公開 API，缺少對應時顯示 `query_connection_unavailable`；不能把 ingestion（可能可寫／管理員）帳號直接借給查詢，也不能讓模型選任意 URL、driver、credential。
- 仍維持唯讀操作、來源隔離、timeout、取消、並行及回傳大小限制。無 DDL／DML／EXEC／外部函式／任意檔案或網路讀取。這些是 SQL 執行安全與資源控制，不是逐題審批。

## 實作責任

0. **本輪完成線**：包含同來源多表 Join 與完整 Pi 工具／MFE／Host／來源 executor／Grafana 原生 Dashboard 接線，不以單表核心或 JSON 產生器作交付替代。pi-web 呈現依當次查詢動態產生的互動 Dashboard；嵌入固定 `theme=light`，不改共用 Grafana 全域主題。
1. **Catalog**：沿用 DataHub 現有使用者 session、metadata 搜尋與 entity/schema 公開 API。無來源命名／業務指標硬編碼。Host 再取當前 schema，不信任模型附的欄位清單。
2. **SQL Adapter**：模型提出結構化查詢（精確 Dataset、欄位、聚合、條件、排序、圖表選擇），可信 Host 由 metadata 綁定來源並用既有 SQLAlchemy 編譯參數化 SQL。字串只作 bind parameter、標識符只來自剛核過的 metadata；不是接受任意 SQL 字串並靠 SELECT 前綴判安全。非支援的表達式明確拒絕，不降級成自由 SQL。
3. **來源執行**：同一 tenant／platform instance／environment／database 精確選擇部署提供的連線 adapter；相同表名不可跨來源碰撞。DB 直接回拒絕／錯誤；不上提連線權限、不繞到其他帳號、不自動重試。不新增 datastore。
4. **結果**：typed columns／rows、執行觀測時間與空資料狀態。數值僅留 Host 暫存與受控 UI，不放模型／Pi 歷史。重讀再核 metadata 可見性；過期／撤權不自動跑 SQL。一般顯示時限不應沿用 60 秒驗收窗。來源回空結果是 `EMPTY`，不能當關係驗證 PASS。
5. **Grafana**：從實際結果欄位與圖表規格產生原生 table／bar／time-series／stat panel JSON，維持 Infinity → Host 結果端點、同站 MFE sibling portal，非替代圖表。結果引用不是 bearer；必須有後端身分與當前 DataHub 使用者／Grafana Viewer 的可信綁定。部署設定指定 org／folder namespace／datasource，模型不能指定 URL／token。原生 folder 依使用者隔離，必須先讀回私有 ACL，才寫入包含欄名／標題的 Dashboard；共用 folder 不作替代。Grafana 原生寫入及讀回失敗不重新執行來源 SQL。接線、版本及部署先決條件見 [operations](datahub-agent-metadata-query-operations.md)。
6. **Pi 工具／UI**：替换目前只接受 `sales_by_category/from/through` 的工具與結果契約，移除固定六月與 Panel5 文案；顯示查詢／圖表狀態、空結果、來源拒絕、逾時與到期，歷史不偷偷再查來源。

## 實作與驗收範圍

本文件是已核准方向，不是「通用能力已部署」宣告。使用者已明確要求**本轮包含 Join 及 UI 完整接線**，撤銷先前僅做單表 Host 核心的切分。

- 非固定查詢：當前可見 metadata、來源定位、動態欄位／聚合／篩選／排序與同來源 Join（含複合條件）。參數化 SQL，不內建業務案例。每一個引用資產／欄位都必須核可見；Join 查詢不等於發布核准的可信業務關係，不能從 lineage 自行猜省略的 Join 條件。
- Adapter：MSSQL／Oracle／PostgreSQL／MySQL 方言及來源執行接點；driver 未安裝、連線未配置要直接告知，不假裝有資料。CTE／window／任意 SQL 字串與跨來源 Federation 不自動加入，不能把目前支援語法說成所有 SQL。
- 必須接線：可信來源／秘密讀取、timeout／取消 executor、Pi 工具／MFE 新契約、動態 Grafana 寫入及原生讀回、同站 iframe 淺色主題、server。完整本地流程測試後再列出未取得的部署／真來源證據；不以新增審批框架為前置。
- 最後必須以真 `/mfe/agent` 手動自由問題驗：至少兩個非固定問題改變欄位／條件／圖型，SQL 真执行、原生 Grafana frame 與來源結果相等；不可用本輪 fixture 或既有固定六月成功代替。

## 操作範圍

此次「更新文件、開始實作」授權本地修改與可信離線檢查，不自動部署、讀新秘密、查真 DB、寫入 Grafana 或恢復舊測試 grant。具體環境操作另行核對，不把此開發期操作要求搬成產品每次查詢的人工批准。

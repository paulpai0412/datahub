# Pi-web 資料庫連線設定（SQL Server 第一版）

狀態：2026-10-02 已和「使用來源」設定 UI 一起部署。真入口已核對清單、既有連線讀回、新增／編輯安全表單、metadata 搜尋、取消及 reload；未替使用者保存真連線、更新密碼或執行來源測試。保存／測試／停用的完整操作有隔離 React／MFE／Host 測試，不能把它當作 AdventureWorks 真查詢驗收。

## UI 操作

1. 開啟 <http://localhost:9002/mfe/agent> → **Settings／設定 → 資料庫連線**。
2. 按「新增SQL Server連線」，在可信 DataHub 父頁面表單填寫連線識別名稱。
3. 搜尋已匯入的資料庫名稱（例如 AdventureWorks2019），選一個參考 Dataset。Host 以當前 DataHub API／ACL 核實 SQL Server 平台、環境及資料庫定位，不採用模型猜測。
4. 輸入主機、明確 TCP 埠、實際資料庫名稱、最小唯讀權限的 SQL 帳號與密碼。這裡的帳號是來源 SQL Server 帳號，不是 DataHub 或 Grafana 登入。
5. 預設「驗證TLS」使用 Host 系統 CA，驗證主機；不支援在 UI 上傳／指定任意 CA 檔案或關閉憑證驗證。受保護本機／測試網路如未配置 TLS，須明確選「不設定TLS」並確認。既有部署的 CA 設定可保留。
6. 勾選確認，可按「測試連線」。只執行固定 `SELECT 1`，回復交易並關閉連線；不讀業務表，不代表所有表都有 SELECT 權限，不保存設定。
7. 按「確認並保存」，Host 保存後立即套用。關閉表單讀回清單，不需重啟 Agent session。
8. 點既有連線可修改／測試／停用或啟用。修改時密碼留空表示保留原密碼；不回顯原密碼。停用不是刪除憑證或歷史 Dashboard。

設定頁只顯示名稱、平台、metadata 資料庫定位、環境及啟用狀態；端點／帳號在可信父頁面編輯，密碼不傳回 pi-web iframe。無法確認保存時不自動重送，須關閉並重新讀回。

## 與語義來源及 Grafana 的區分

- **使用來源**：目前管理員的 Source 綁定 metadata／語義提案範圍，不設定來源憑證。
- **資料庫連線**：Host 共用的 SQL 查詢基礎設定。所有查詢仍核當前使用者的 DataHub Dataset／欄位 ACL，不新增逐人 SELECT 授權表。
- **Grafana**：沿用已配置的 Host 結果 datasource，不為每個 SQL Server 資料庫建立 Grafana MSSQL datasource；不把來源密碼交給 Grafana或模型。
- 新增連線不啟用 ingestion、Catalog publication、AUTO 或語義來源 grant。AdventureWorks 的其他維護範圍決策保持不變。

## 信任與資料主責

- Host 必須由部署端啟用 `connectionSettingsEnabled:true`，並已有通用 `queryGrafana` 配置；不能與 readOnlyCore 混用。
- 管理員必須同時具有原生 `managePolicies`、`manageIngestion` 權限，沿用來源設定的原生權限判斷，不另建立管理員名單。
- `/agent/connection-settings` 沿用可信 DataHub origin、當前身分及 parent-only browser proof。pi-web 只允許 `list`／`open` 意圖；test／save／啟停由父頁面真人操作產生，不註冊為 Agent 工具。
- 新密碼只走 parent → Host → 受保護檔案／固定 Python child stdin，不進對話、模型、普通 Aspect、回覆或日誌。資料庫錯誤回傳有限錯誤代碼，不回傳 driver 原文。
- 共用 `operator-config.mjs` 從原來源設定保存邏輯抽出單一 revision／exclusive lock／atomic rename／fsync／讀回主責，兩種設定不互相覆蓋。其他 actor、queryGrafana、source policy、部署欄位均保留。
- 新／更新憑證寫在配置同目錄的 `query-credentials/`：目錄 0700、檔案 0600、同 Host UID、非 symlink。每次用新檔再切換 `queryConnections[].connectionPath`；不覆寫正在被舊請求使用的憑證。
- 這是現有部署憑證檔案機制的管理入口，不是新增業務 datastore。未知保存或更新後的未引用憑證檔保留供操作者對帳，不自動清除；備份仍須保護整個配置及引用憑證，不公開提交。
- 外部操作者修改配置會使 UI 拒絕後續操作，需重載 Host；不偷偷接收外部配置或移除舊 lock。

## 查詢失效與限制

未變更的 binding 保留物件身分，修改語義來源或其他連線不會無故讓既有查詢失效。修改憑證／來源定位或停用後，後續來源執行檢查、結果讀回及 Grafana 發布核對當前 binding，拒絕使用舊結果；重新啟用不復活舊 binding 的收據。已在 DB 執行的 SQL 不因 UI 停用而保證立即終止，仍受原 timeout／取消機制限制，完成後不得回傳失效結果。

第一版新增綁定支援無 platform instance 的 SQL Server metadata、SQL authentication、明確 TCP 埠；不支援 Windows 整合登入、named-instance discovery、跨來源查詢或 Oracle。參考 Dataset 搜尋最多20筆，超過需縮小條件；新增時須選取可核對的 Dataset。來源資料庫名称與 metadata 名稱大小寫比較按 SQL Server ingestion 的既有定位處理，實際連線仍使用管理員輸入的名稱。

測試連線為手動、單次、至多一個並行 probe，沿用既有 child 時限及安全錯誤處理，無自動重試。連線成功、保存成功、metadata 可见、業務 SELECT 成功是不同證據；未知或失敗不能冒稱查詢可用。

驗證及版本見[合併部署紀錄](../verification/datahub-agent-connection-source-settings-20261002.md)。

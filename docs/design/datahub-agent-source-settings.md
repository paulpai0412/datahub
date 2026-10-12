# Pi Agent「使用來源」設定

狀態：2026-10-02 初版與資料庫連線 UI 合併部署。2026-10-03 人工審核授權擴充亦已部署，真入口91Dataset／744欄、三授權差異預覽與取消／reload通過；本次未代管理員保存新grant。詳見[人工審核授權部署](../verification/datahub-agent-source-review-settings-20261003.md)與[初版紀錄](../verification/datahub-agent-connection-source-settings-20261002.md)。

後續管理員已親自保存AdventureWorks三项grant。2026-10-03另部署送審介接修正：可信`reviewPolicy`表達目前Source政策資格，不將預覽`publicationAuthorized:false`誤當未授權，也不以完整inventory缺口阻擋精確Catalog人工送審。真Agent一筆Product Identity定義PENDING已原生讀回；驗證紀錄到期後仍只供稽核，沒有建立Term／修改Product。見[介接恢復證據](../verification/datahub-agent-semantic-review-contract-20261003.md)。

## 已確認範圍

在 DataHub Pi Agent 的「設定 → 使用來源」，目前登入的管理員可以新增／調整自己的既有 DataHub Source metadata 使用範圍。Host 部署須明確設定 `sourceSettingsEnabled: true`，且操作者同時具備原生 `managePolicies` 與 `manageIngestion` 權限；不另設 Host 管理員名單。一般使用者及模型不能透過此功能授予權限。

這不是來源連線／Secret 編輯器，也不是 AUTO 啟用器。2026-10-03 使用者另准擴充人工審核授權 UI：涵蓋整個 AdventureWorks 已選 Dataset／欄位，審核發布、共用定義新增及修改分開授權，部署後由管理員在頁面確認。AUTO 的完整方案與啟用決定仍獨立，本次不開 AUTO。

## 使用流程

1. 從 DataHub Agent 入口開啟設定，選「使用來源」。
2. 選擇現有 Source；Host 以原生身分及 Dataset ACL 盤點可讀資產。
3. 勾選精確 Dataset 範圍及 metadata 傳送同意；可全選或逐筆選取。選擇是否允許「建立審核提案與人工核准後發布」，並從 Host 已為此 actor 配置的 Agent 身分中選取；不得輸入任意 Agent URN。共用定義新增與修改各有獨立開關，依賴審核發布；預設不開。
4. 按「檢查差異並保存」。可信 DataHub 父頁面重新向 Host 取得計畫，顯示使用者、Source URN／版本／recipe hash、啟用狀態、完整新範圍、移除明細、三項語義授權及 Agent 身分的前後差異。
5. 真人勾選確認後才保存；取消不送出保存。保存即更新 Host 的來源政策，不啟動或重載 Agent session。
6. 關閉審核發布會同時撤除共用定義新增／修改；停用 metadata 則撤除所有三項授權。停用後拒絕後續 Source 語義讀取／預覽，並在進行中請求的檢查點及回傳前拒絕已失效授權。已回傳的對話內容不會被刪除。

本設定控制 **Source 綁定的語義工具**；一般 Catalog、SQL 查詢仍沿用既有 DataHub／Host 政策，並非全域資料防洩漏開關。

## 權限與持久化

- 入口：`POST /agent/source-settings`；沿用 DataHub 父頁面 origin、目前登入者、有效 browser grant 及 parent-only proof。
- iframe 只能請求 list／inspect／review。保存由父頁面真人確認產生，不作為 Pi 工具公開。
- Host 不採信 caller 自稱的 actor、ACL、recipe 或 endpoint；授權欲變更值仍須經原生管理權限、精確範圍、已配置 Agent 及父頁面真人確認。所有原生讀取使用固定 API。
- 保存至現有 operator Host JSON 的 `ingestionSourcesByActor[目前actor]`，不新增業務 datastore。其他 actor、來源及部署設定保留。
- 配置檔需為 Host UID 所有、owner-only 權限的 regular file，不接受 final-path symlink；部署目錄須由可信操作者管理。CLI 啟動時傳入配置實際絕對路徑，程式呼叫 `startAgentServer` 亦須提供 `configPath`。
- 配置 bytes revision、Source version、plan digest、exclusive lock、暫存檔 fsync、atomic rename、目錄 fsync、讀回及同步套用共同避免 UI 舊版本覆寫。
- 外部編輯配置會阻擋後續 UI 操作，需操作者重載 Host；不偷偷熱載入外部設定。外部操作者不得在 Host 保存期間競爭寫入。
- 保存途中失敗可能產生未知結果；UI 不自動重試，必須重新讀回。程序中斷留下的 lock 需操作者先確認原寫入程序與配置結果，不自動刪鎖重播。
- 既有部署端 ingestion 執行／publication／AUTO／definition 政策仍不覆寫。UI 保存的政策附 `sourceSettingsManaged:true`，在同一 operator JSON 辨識 UI 主責；這不是第二份狀態權威。只有 UI 主責、`ingestionExecutionApproved:false` 且無 AUTO／audit-recovery 的政策可在此調整審核授權。既有未標記的發布政策仍唯讀。
- 共用定義的授權不取代原有影響範圍與版本核對。現行依賴查詢是有界索引讀取，不能證明全域完整性；共用定義修改的 `impact.complete` 不成立時，實際發布仍拒絕。Structured Property schema migration 仍不啟用，開關不承諾所有定義都可安全修改。

## 第一版支援與限制

- 支援 MSSQL、固定 CLI `1.7.0.9`、無 `platform_instance` 的 JSON recipe；其他 connector 明示不支援。
- Dataset 依 database 名稱候選搜尋、精確 MSSQL URN、同 Source schema provenance、未刪除狀態及當前 ACL 核對。**不代表最新成功完整掃描，也不取代 AUTO 所需的成功 Run／證據契約。**
- 每 actor 最多 8 個 Source；`taskDatasets` 精確讀取範圍上限 1024。Catalog 讀取維持每頁 20；AUTO `allowedTargets` 的 128 上限未變。
- 新政策預設只允許 metadata/model context 與 proposal preview；`ingestionExecutionApproved:false`、`semanticPublicationApproved:false`。管理員另確認後可開審核發布，重用已配置的 Agent 身分與固定 `EXISTING_TASK_RUN_ACL` 稽核範圍，不建立新 Agent、不新增 AUTO。
- Catalog 的可發布審核編譯要求 `semanticPublicationApproved`、`semanticAgentUrn`、`semanticAuditAudience` 同時成立；僅開 metadata 預覽或 SQL 連線無法通過。授權變更使旧 snapshot／review 政策 hash 失效，必須重新 inspect／preview，不重播旧提案。
- ingestion list／inspect／run／test／cancel 對 metadata-only grant 皆拒絕；既有明確 operator grant 相容。
- 單一原生 client 有既有 20 秒期限；大型盤點或來源不可用可能 fail closed。本地 91 資產 fixture 成功不是實際 DataHub 延遲驗收。
- 目前啟用需至少一個可核對 Dataset；沒有可讀資產的授權撤除須由部署端處理。

## 程式與驗證

- Host：`extensions/datahub-agent/integration/source-settings.mjs`、`server.mjs`、`gateway.mjs`。
- 父頁面確認：`extensions/datahub-agent/mfe/source-settings.js`。
- 設定頁：`extensions/datahub-agent/pi-web/components/DataHubSourceSettings.tsx`。
- 測試：`tests/test_agent_source_settings.mjs`、`tests/test_agent_gateway.mjs`、`tests/check_agent_source_settings_browser.mjs`。
- [本地驗證紀錄](../verification/datahub-agent-source-settings-local-20261002.md)。

合併UI已部署；新增真實來源範圍須由管理員在UI明確確認。不得把本地功能完成、mock 原生回應或保存 fixture 設定，當作 AdventureWorks 存取／AUTO 已啟用。

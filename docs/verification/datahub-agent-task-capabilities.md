# T06 Task／Decision／排程：原生能力查核

2026-09-12。接續原 TODO，不新增產品架構；**本次是能力查核，不是 Task／Decision／排程完成驗收**。

## 實際結果

使用既有、使用者已登入的 DataHub Agent 瀏覽器頁面，呼叫公開 API，未讀出 cookie／token，未送 mutation。

- GraphQL：106 個 Query、169 個 Mutation、937 個 Type 的名稱盤點成功。與目標相關的操作是 Source／ingestion execution；沒有 Cloud Agent Task／Decision 的操作或型別。
- OpenAPI：`/openapi/v3/api-docs` 回 200，共 436 個 path。含 `aiagent`／`agentskill` metadata API，沒有 Cloud Task／Decision 的專用 API；`elasticSearch/getTaskStatus` 是搜尋後端操作，不是 Agent Task。
- 既有 T03/T05 canary Source `c3b4bb69-28e2-41a7-9692-ae057480aa4b` 讀回 `schedule: null`，未啟用排程。
- 無憑證直接讀 GMS OpenAPI 規格回 401；不據此宣稱 Reader 或跨 Actor 權限已驗。

上述 API 缺少 Cloud 專用操作，不代表通用 Aspect API 無法承載正式模型擴充。

## 固定官方來源核對

Core checkout：`v1.7.0.1`／`e99431ec510d7a2001f815c6bf70913c493af76e`，本輪最後查核乾淨。

| 官方來源 | 已確認的界線 |
| --- | --- |
| `upstream/datahub/docs/features/feature-guides/agents.md` | Task 是給 Agent 的可重複指令；Decision 是暫停等待人回覆、回覆後繼續或 dismiss 結束。功能明示 Cloud-only。不能把一般 chat 或 ingestion run 改名當完成。 |
| `upstream/datahub/metadata-models/src/main/resources/entity-registry.yml` | 有 `aiAgent`／`dataJob`／`dataProcessInstance`／`dataHubExecutionRequest`，沒有 Cloud Task／Decision 實體。dataProcessInstance 的語意是 datajob/jobflow run，不自帶 Agent 指令、Decision 或執行器。 |
| `upstream/datahub/ingestion-scheduler/src/main/java/com/datahub/metadata/ingestion/IngestionScheduler.java` | 原生排程讀 Source info，產生 `RUN_INGEST`。不是任意 Pi Agent 任務排程器。 |
| `upstream/datahub/metadata-models/src/main/pegasus/com/linkedin/ingestion/DataHubIngestionSourceSchedule.pdl` | 排程欄位只有 interval/timezone；不能只憑這兩欄宣稱具有本案 scope grant 到期／撤銷語意。 |
| `upstream/datahub/datahub-actions/src/datahub_actions/plugin/action/execution/executor_action.py` | 預設處理 `RUN_INGEST`／`TEST_CONNECTION`；可配置 task_configs 是潛在重用點，尚未實測自訂 Agent 任務或其身份／取消／重播邊界，不直接把既有高權 ingestion executor 用來執行模型。 |
| `upstream/datahub/metadata-models-custom/README.md` | 官方支援獨立版本 Model／Aspect plugin、GMS plugin mount 與相容性檢查。不需要改 Core；也不代表新增模型就自動有 UI、GraphQL、權限規則或 runtime。 |

## 下一步範圍

沿使用者已核准的官方 Model／Aspect 擴充方向，不恢復 PostgreSQL 方案、不新建通用 worker/workflow、不借用 ingestion 排程冒充 Agent 排程。

使用者本輪已明確選定第一個真實驗收用途：**既有 Person.Person／vEmployee 讀取 metadata → 請人決定是否繼續查 lineage → 依回覆繼續或結束**，須驗歷史讀回。這是 Task 指令與验收案例，不是把流程寫死在產品程式；不縮減其餘 TODO，也不授權新增通用平台。後續只補此用途所需的 Task／Decision 欄位與既有 Pi 執行接線，排程實際啟用仍須另有時段及有效 scope 授權。

用途已無待決問題；目前下一步受 shell EAGAIN／逾時阻擋，先確認該檢查程序狀態與工具可用性，再做必要實作及驗證。不重問本次已確認用途。

## 證據與限制

本機 `.local/evidence/agent-task-capabilities/`：

- `probe.mjs`：使用既有 Playwright／owned CDP，只做公開 API 查詢；執行後只斷開 client，保留原瀏覽器。
- `live-graphql.json`／`live-graphql-openapi.log`：最終 API 名稱、數量、Source 排程讀回。
- `live-graphql-batched-red.*`：首次合併 introspection 超過 server 的 fields 次數限制；改用各自的標準查詢，未停用或修改 server 限制。
- `openapi-attempt.json`：匿名 GMS 401。
- 最後 SHA-256 manifest／獨立 Node syntax check 尚未完成：shell 啟動回 `spawn /bin/bash EAGAIN`，同協定重試逾時；隨後確認 `source-state.json` 不存在。不宣稱已有 source-bound manifest。

本輪未修改產品程式、未建置／部署／重啟、未發模型請求、未續簽 Reader、未寫 Source／GMS／業務資料，未派子代理／建立 Goal／commit／push。T06、T07 仍未完成。

工具曾出現 `failed to spawn thread: Resource temporarily unavailable` 與 Git `unable to create threaded lstat`；改用單執行緒 rg／Git 的同類唯讀查核後成功確認 Core 乾淨、主 repo master/a25204e 與原 untracked 樹。其後 shell 又出現 EAGAIN／逾時，最後獨立語法與雜湊查核仍受阻；不宣稱資源問題已恢復。未修改全機設定或清理服務，未將此現象歸因為產品故障。

**本輪結論：先區分 metadata 記錄、ingestion 執行與 Agent Task；API 存在或 Aspect 可寫，不能代替真正的人機決策／繼續執行證據。**

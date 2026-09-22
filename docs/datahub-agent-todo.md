# DataHub Agent 實作待辦 — 2026-09-12 重新核准

母任務：`TODO-a2daa81d`。主代理獨作／安全自查，非獨立審查；不派子代理、不 commit／push。下列新業務閉環另由使用者明確核准原生 pi-goal-x；不以新 Goal 接管或結束舊母任務。

## 已核准的新業務閉環（2026-09-19盤點：多項已落地，整體未結案）

使用者逐項核准 AdventureWorks 銷售星型模型、既有測試 MSSQL instance 的獨立 `SalesDatamart`、既有 Grafana 專用資產，以及單次執行／每次寫入人工核准。新增的是限定業務 Datamart database，不是 Extension 狀態庫；不授權新增其他 datastore／worker／scheduler 或修改 Core。這項限定例外補充下方既有「不另外建立 datastore」規則；來源仍唯讀。

- [設計 v1](research/datahub-sales-datamart-v1.md)
- [專用實作 TODO](datahub-sales-datamart-todo.md)，任務 `TODO-dc390fa8`（in_progress），原生 Goal `mtzxzwn6-1zw7vn`。
- 最新核准明確包含 **DataFlow Discovery（資料流探索）** Skill，ID `dataflow-discovery`；從程式碼／SQL／BI設定分析候選，再由Host驗證、人工核准發布。SalesDatamart是首個驗證案例，不hardcode產品或用手寫mapping替代分析。
- 已建置SalesDatamart並真ETL載入／重跑／rollback；Grafana v2、兩庫隔離回復、13Dataset metadata／view lineage、Flow／三Job canary及真Agent唯讀Discovery已驗。完整欄位／治理發布及Agent固定ETL仍缺；詳[整案盤點](verification/datahub-progress-inventory-20260919.md)。T06／T07與母任務不追認完成，本版不加入排程；已確認環境／隱私不再重問。

## 最新平台範圍（取代舊 A01–A15 的實作依賴與 Extension PostgreSQL 方案）

使用者核准順序：**真模型回應 → DataHub MCP 查詢成功 → 實測原生 Source／Secret／ingestion 能力 → 補必要缺口 → 真實 ingestion／lineage 讀回 → Registry／Task／Decision／排程 → 整合驗收。**

- 第一目標：打通真 DataHub Agent 端到端測試，不以登入、設定頁或合成工具成功代替。
- **不另外建立新的 datastore。** 後續客製優先套用 DataHub 現有 Entity／Aspect／公開 API；不足才評估官方模型擴充，不改 Core／內部資料表。
- 保留 DataHub 既有 MySQL／OpenSearch／Kafka、Pi 既有 HOME／sessions。不建立第二套 Source／Secret／Jobs 資料庫。
- 工具或模型不足先列出具體缺口，不預建通用 MCP、表單、worker、審批、排程或 outbox 框架。安全要求不能因重用而取消。
- Source／GMS write secrets 留在可信控制面，不能放普通 Aspect、chat 或 terminal 可讀設定。模型只使用使用者已自行設定的登入，不讀取 OAuth/token。

## 現況

- 已有：唯一 `/mfe/agent`、完整 Pi 工作區與 DataHub skin、MCP 設定頁、固定 `pi-mcp-adapter@2.33.0`。使用者已確認真 DataHub 入口與 ChatGPT 登入成功。
- 已有歷史 AdventureWorks metadata／profiling／view lineage ingestion 證據；不等於 Agent 操作 ingestion 的 E2E。
- T01 已實測：真 DataHub Agent 原生 chat 以 GPT-5.6 Sol（chat-only）回覆測試標記，整頁 reload 後仍能讀回。GPT-5.4 mini／GPT-5.4 被目前 ChatGPT 帳號拒絕的原始結果保留，不宣稱所有列出模型均可用。
- Agent 白頁已修：閒置連線的 HTTP 408 不再留在 reverse pool 供後續請求使用；已核准重啟 Agent，真瀏覽器經原生 idle timeout 後再開頁仍 200。見 [白頁修復與 T01](verification/datahub-agent-open-and-model.md)。
- T02 已實測：真 Agent 經官方 DataHub MCP 查得 Person.Person 的 13 欄與 3 個下游 View，另與 GMS 讀回核對，整頁 reload 保留回答。第一條 Agent E2E 通過；Agent 發起的來源操作閉環仍未完成。見 [T02 驗證與 token 到期限制](verification/datahub-agent-datahub-mcp.md)。
- PostgreSQL SourceStore 原型不納入交付：六個未部署程式／migration／driver lock／tests 已移到 gitignored `.local/evidence/agent-sources/withdrawn/`，gateway/server 接線已回退。測試紀錄保留；未部署獨立 PostgreSQL、未修改 Core metadata 或正式 HOME。

## 新 TODO（依序，不平行擴建後續能力）

| ID | 待完成成果 | 最小實作方式與完成證據 | 狀態 |
| --- | --- | --- | --- |
| T01 | 真模型回應 | 使用目前 DataHub → Agent → Pi 原生 chat，建立可辨識測試 session，送無敏感資料的小問題；確認真回應與 session 讀回。不讀登入憑證、不以 CLI/fixture 冒充瀏覽器 E2E。 | 完成：GPT-5.6 Sol 真回覆＋整頁 reload 讀回；非 MCP 驗收 |
| T02 | DataHub MCP 查詢成功 | 配置實際 server，沿既有 adapter discovery/call/reload。由 Agent 查一筆已知 AdventureWorks dataset/schema/lineage，與 DataHub 讀回核對；保留工具呼叫及來源 URN。新目的地／憑證／scope 需有對應授權，不全面開網路。 | 完成：真工具呼叫、GMS 核對與 reload；本次短效 token 到期後須重新配置 |
| T03 | 實測原生 Source／Secret／ingestion 能力 | 用固定 Core／CLI 的公開 API與現有執行機制，確認來源設定、Secret binding、connector、連線測試、執行紀錄、取消／重跑與權限可覆蓋的範圍。先讀查核，再依既有授權操作可辨識測試 metadata。 | 完成：原生 binding／連線、4 資產 ingestion、RUNNING→CANCELLED、修改設定後重跑、舊快照與歷史保留、OpenAPI 版本競爭均實測；範圍與限制見 T03 報告 |
| T04 | 只補已證明必要的缺口 | 逐一依 T03 真結果補缺少的工具或薄 UI 接線。已有 MCP 工具直接使用；Skill 只寫操作指引。客製資料沿官方 datamodel／Aspect 擴充，先驗證讀寫／權限／版本契約；不足回報，不新增 datastore。 | 完成：最小工具／可信 MFE／Host 接線已部署，真 Agent 查詢／確認／拒絕／執行已驗；補齊參數說明與最終回覆識別碼，不新增工作系統 |
| T05 | 真實 ingestion／lineage 讀回 | 已授權 AdventureWorks 小範圍，Agent → 明確範圍／版本人工確認 → 官方 connector／執行機制 → GMS acknowledgment／metadata與lineage讀回。包含錯誤、取消、重跑、設定變更與部分副作用；不寫業務資料、不刪既有 metadata。 | 完成（本範圍）：正向／設定變更拒絕／恢復重跑／GMS＋Agent MCP＋reload 通過；使用者核准以 T03 真 CANCELLED＋T05 取消競態及回歸作組合驗收，不宣稱 Agent 已停止 RUNNING 工作 |
| T06 | Registry／Task／Decision／排程 | 原需求保留。先用官方模型與既有紀錄／排程；每項做實際建立、查詢、權限與結果驗證。非 ingestion 的額外排程只針對實際用途，不造通用任務平台。 | 進行中：Registry、官方模型 0.1.1／版本／CAS／ACL 保留。**真人 End 與繼續 lineage 兩分支已通過**：Windows 真 Tasks 新 Run 自動導航成功、本人 RESPOND 存 v3／v2 未回答歷史保留、模型 metadata 13／18 欄及 3 條下游邊與公開 Aspect 核對，native idle；End 另有 DISMISS／closedAt／停止證據。導航僅 gateway／Tasks 兩接點，額外 13 檔純格式漂移已核准還原，550 inputs 其餘 548 不變；49/49、browser 正負例、521 Pi bytes／原 baseline checks 通過。核准 Agent-only 部署後 Core／Pi image／HOME 保持，原 Reader 一小時 token 至 2026-09-13T11:38:47.858Z、不自動續期。MCP vEmployee 可見上游 1、原生 references 9，不冒充全量 lineage。Read-only 非 MCP-only／憑證隔離的已核取捨不變。待回答問題的整頁重整／單頁斷線恢復、同版 Agent 重啟後不重送及真人關閉，另以新 Run 真驗通過。尚缺真 Host 跨 Actor、其餘 T07、Agent 排程 scope／時段／身分；不自造通用平台、不提前結案。詳見 Task wiring 報告 |
| T07 | 整合驗收 | 補尚未驗證的原 Pi 功能、IME／鍵盤／a11y、多使用者與生命週期；驗 T01–T06 真入口、安全負例、实际擴充點相容性、固定版本、備份回復。重用有效歷史證據，不重跑未變更的全套檢查。 | 進行中：真入口已驗三尺寸 Workspace 鍵盤／焦點、DOM 組字不誤送、heartbeat 網路失敗移除 iframe／重新開啟讀回歷史。Settings 關閉焦點落 BODY 已重現並僅修該元件；隔離 React 紅轉綠、精確映像的既有 Pi browser／MCP／PTY／Files／隔離回歸通過，另獲限定維護部署後真入口 7/7 通過，Core／MFE／HOME 保持。新增真等待生命週期證據：頁面重整／單頁斷線維持同問題、同版程序重啟保留歷史但不自動續跑、真人關閉後 v3／v2 歷史保持。Windows 倉頡／速成選字與換行由真人確認；另行刻意送出且取消的測試訊息不算 IME 誤送。未新增草稿持久化、帳號或排程器。其餘 a11y／原生功能／備份回復、真 Host 跨 Actor 與排程尚未驗完；14 檔格式差異已依批准還原，最終 550 個輸入與候選相符；保留差異重現證據，不改開發工具。全部完成才結案，詳見 T07 報告 |

### 第一條 Agent E2E 完成線

1. 使用者從 DataHub 登入並開啟 Agent。
2. 真模型在原生 chat 回應測試問題。
3. 同一原生 Agent 流程透過實際 DataHub MCP 查詢已知 dataset。
4. 回答引用可核對的 URN／schema／lineage；工具輸出與 DataHub 一致，session 可讀回。

任何一步缺證據都不宣稱完成；T01 完成不等於 T02 完成。原 SQL 關係驗證／人工審核／可信關係失效目標保留，但不提前建設其儲存層，也不作為第一條 Agent E2E 的前置。

## 系統異常插單（2026-09-12）

使用者要求優先處理 OpenSearch 大量 curl zombie，並明確核准只重建本案 OpenSearch、保留 volume。已修 healthcheck 的未引用 `&`／CMD-SHELL 根因，15,258 個 curl zombie 清至 0；六次真 probe、索引識別與直接搜尋通過，其他容器未重建。見 [根因與恢復證據](verification/opensearch-healthcheck-reaping.md)。T06 尚未完成，不將系統修復當功能驗收。舊 owned browser CDP 已拒絕連線；本輪經使用者核准重新開啟隔離瀏覽器並完成手動登入，已用於模型 API canary，尚非 Task UI 驗收。

## 授權與操作限制

- 已核准：本專案限定部署、AdventureWorks metadata read、本地可辨識測試 metadata writes；不動其他專案、業務資料、既有 metadata。
- 2026-09-12 另經使用者明確核准，只啟動既有 `wferp-mssql-test`（30601aec1b4e），已 running／healthy；不延伸為其他服務的啟停／重建授權。
- 目前 actor 已核准 `https://auth.openai.com`、`https://chatgpt.com` HTTPS443，及固定 `http://datahub-mcp:8042` → 本機官方唯讀 MCP；不延伸到其他 actor／endpoint／私人網段，不直連 GMS／來源 DB。
- 本輪另核准僅套用 Task／Run 模型並重啟 GMS；因 plugins 父目錄 0700 阻擋 UID 100，修正公開插件目錄權限後，再經明確核准第二次 GMS 重啟，模型載入 SUCCESS。所有容器 IDs、GMS image／mount 保留；不延伸為其他維護授權。後續另核准 0.1.1 Run 關閉欄位及最多一次 GMS-only 重啟；新版本由原生掃描直接載入，該次實際沒有重啟。原 CDP 再次失效後，經另行核准重新開啟隔離瀏覽器並由使用者手動登入完成升級前後 API 檢查。
- 已另核准原生專用 Reader 帳號與短效 token。恢復瀏覽器後另經明確授權重新簽發／驗 read 200 與 write 403／配置及 native session reload；最新到期 2026-09-12 18:05:12 +08:00。未建立自動續期，不以短效 canary 冒充永久可用。本輪另經核准簽一個一小時 service Reader token，僅於記憶體做 Registry／Task／Run 權限測試，已立即撤銷且驗原 token 401；該次没有更新 runtime MCP。2026-09-13 另獲明確核准，原 Reader 新 ONE_HOUR token 已透過原 actor 的 MCP API 更新並讀回，其他設定 hash 相同；未輸出 token／未讀模型憑證／未自動續期，詳見 Task wiring 報告。
- 使用中的 Agent 重啟仍須核對維護授權、PID／scope／HOME 與影響。不為設定頁再重建 DataHub frontend。
- 不讀 `.local/user.props`、開發機憑證、使用者 OAuth/token。若缺少可操作的已登入瀏覽器入口，直接請使用者完成原生測試，不繞過身份驗證。
- 資源餘裕門檻已撤，但保留 CPU／memory／network 限額；必要 Pi build 使用既有隔離 bounded builder／Webpack，不 prune 或動全機設定。

## 歷史證據（保留，不代表目前所有 source 或新功能都通過）

- [固定 source／catalog](verification/datahub-agent-foundation.md)
- [baseline／embed](verification/datahub-agent-baseline-and-embed.md)
- [runtime 隔離](verification/datahub-agent-runtime-isolation.md)
- [browser lifecycle](verification/datahub-agent-browser-lifecycle.md)
- [UI v0](verification/datahub-agent-ui-v0.md)／[Pi skin](verification/datahub-agent-skin.md)
- [MFE 真入口](verification/datahub-agent-mfe-preparation.md)
- [MCP／登入](verification/datahub-agent-mcp.md)：exact image 979 tests、222 assets；stdio fixture 與真 DataHub MCP 證據分開。
- [T02 真 DataHub MCP](verification/datahub-agent-datahub-mcp.md)：真 Agent 工具呼叫、原生 Reader／403、限定 egress、GMS 核對與 session 讀回。
- [T03 原生 ingestion](verification/datahub-agent-native-ingestion.md)：Source／Secret binding、連線 red→green、實際執行／取消／重跑／GMS 讀回、歷史快照及 CAS；T04 精確快照公開入口已驗，不等於 T05 Agent E2E。
- [T04 接線與 T05 現場驗證](verification/datahub-agent-ingestion-wiring.md)：最新映像 9dc449… 已部署，真 Agent／原生 connector／GMS／MCP 正向與恢復設定後重跑通過；保留取消競態、原失敗與剩餘驗收。
- [T06 Registry 進展與限制](verification/datahub-agent-registry.md)：真建立／查詢、已部署唯讀頁、匿名拒絕、窄 Host 修正與剩餘 Task／Decision／排程。
- [T06 Task／Decision／排程原生能力](verification/datahub-agent-task-capabilities.md)：真 API 盤點、官方模型／Actions／排程邊界；尚非功能驗收。
- [T06 官方模型與 API 實測](verification/datahub-agent-task-models.md)：兩個 Aspect 載入、真原生版本／歷史／並行 CAS、plugins UID 權限修復；非 Task E2E。
- [T06 Task／Pi／Decision 接線](verification/datahub-agent-task-wiring.md)：真 End／繼續 lineage 兩分支、導航修復與歷史；T06 整體仍未完成。
- [T07 整合驗收](verification/datahub-agent-t07.md)：真入口鍵盤／組字／連線恢復、Settings 焦點缺陷／候選修復及待驗項目。
- [建置資源](verification/datahub-agent-build-resources.md)

舊 A 編號仍可用於歷史證據定位，不再要求按舊 A09 PostgreSQL／A12 outbox 等預設實作推進。後續來源建置前須重新核對 downstream/source lock；不得以歷史 image 的 PASS 掩蓋工作區 drift。

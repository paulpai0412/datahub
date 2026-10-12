# Ontology Runtime：Agent Teams、pi-subagents 與 Southstar／Tork 可行性評估

日期：2026-10-02。狀態：**研究建議；未實作、未部署、未派送 Agent，未執行業務查詢或 Action。**

> **本篇原先優先驗證 Southstar-inspired runtime＋Tork 的建議已被取代。** 後續比較及使用者確認採 **Temporal 為唯一主流程引擎，第一版不加 Tork**；Southstar 僅借用契約與對帳設計，不搬其 scheduler。PostgreSQL 保存營運資料／Action ledger／查詢 projection，等待與流程推進由 Temporal 主責。開發與驗收以 [Operational Ontology v1 實作設計](../design/datahub-operational-ontology-v1.md) 為準；下文保留當時研究與原始選項。

承接 [Operational Ontology 提案](datahub-operational-ontology-proposal-20261002.md)及 [DataHub metadata × UML 評估](datahub-uml-ontology-runtime-evaluation-20261002.md)。使用者已確認原稱「tgok」指 **Tork**。本篇只細化 runtime 選項，不改變 DataHub 定義／release 權威、typed unified graph、可信 Host 與受控資料揭露方向。

## 1. 結論

**可行，且值得優先借鑑；但應取各自適合的責任，不把三套 orchestrator 疊成三個業務流程控制者。**

| 來源 | 建議借用 | 不應直接當成 |
| --- | --- | --- |
| Agent Teams | 父層持有意圖、授權範圍與驗收；角色分工、owner fencing、request identity、資源預留及證據結算 | 業務 Object／Process runtime，或正式業務批准者 |
| pi-subagents | 有界 Agent 協作：動態分支、平行分析、逐步調整、結構化輸出、子工作觀察與續接 | 跨日業務流程的唯一狀態權威，或任意外部操作的 exactly-once 引擎 |
| Southstar | PostgreSQL 持久化、任務 claim、attempt、callback／observer、事件與修訂的整合骨架 | 可直接移植且已驗收的 Ontology backend |
| Tork | Job／Task 派工、容器工作、timeout、狀態觀察及受控重試 | Object policy、業務狀態機、人工批准與跨系統交易 |

建議方向：**DataHub 管定義；一個 Southstar-inspired Runtime 管業務實例；Pi 管推理與協作；Tork 管需要排程的工作；OpenSandbox 管生成 Python 的隔離執行。**

這能縮短 runtime 的探索，但沒有消除 Object identity、Action adapter、長時等待、端到端權限與未知結果對帳的實作。架構責任不等於每個框都要新建微服務。

## 2. 本次實際查到的能力

### 2.1 Agent Teams：可借治理與執行契約，不搬整套 coding runtime

本機 `task-runtime/ledger.mjs::RuntimeLedger` 已有：

- controller owner／epoch 與接管時的 expected-owner 檢查。
- Task execution、request digest、reservation 與累計用量。
- `transition()` 以 `WHERE execution_id/state/revision` 更新，要求只影響一列。
- 結果、acceptance 與資源結清分離；不是收到 Agent 成功文字就完成。

適合映射到 Ontology 的原則是：**誰能推進這個 instance、這次究竟是哪個操作、舊 worker 能否提交、結果是否真的成立**。

不宜把 Goal／Git／worktree／Herdr／程式碼 review 的完整契約照搬到每筆業務流程。借鑑其責任與狀態轉移規則，再放進新營運 runtime 的持久化主責；不直接共用開發用 Teams ledger 或接管現有 executions。

`RUNTIME-READINESS.md` 明確區分能力證據與操作授權。進度文件記載過 `loaded-runtime-changed`、`available:false`／`canary:false`；**本次未做 fresh preflight，不據此宣稱目前可無人值守或已通過 live 驗收**。[L1]

### 2.2 pi-subagents：dynamic workflow 有實用價值，但 recovery 有層次

本次所讀本機安裝包標示 `0.66.0`：

- `runs.run()`：具名子工作；同一 workflow 執行中，相同 key／相同參數復用既有 promise，不同參數拒絕。
- `runs.all()`：平行工作；`runs.lanes()`：平行的序列工作鏈。
- JavaScript 可依結構化結果選下一步，不必先固定所有分析方法。
- `state.get/set`：mission 的 JSON state；檔案鎖、原子寫入，完整 state 上限 256 KiB。
- public RPC／structured delegation：支援精確的 owner／node／attempt 身分與受限的 status、stop、resume 接點。

但必須分清三件事：

1. **子 Agent session 可續接**：沿 package 公開 recovery 路徑，核對 ownership、session／process 狀態與原能力上限。
2. **mission 記錄可恢復查閱**：保存目標、run IDs、狀態及 JSON checkpoint；文件明示 ledger 本身不排程或重啟 children。
3. **整段 workflow 可在任意崩潰點 durable replay**：不能由前兩者推得。本次看到的 keyed launch map 位於單次 executor 記憶體；沒有取得「任意中斷後重跑原 script，已完成外部效果必不重播」的完整保證。

因此，不應以 `state.set("done", true)` 加一個 key 就宣稱可避免重複業務操作：外部成功到 state 寫入之間仍有崩潰窗口。

其他整合限制：

- raw `workflowScript` 的 `runs.host` 不具有 named resource 的 host authority；named resource 的固定 command 許可也不是業務 Action 授權。
- workflow 的 reported-usage budget 會限制後續 child admission，不保證立刻終止已在執行的工作。
- Pi host 若在 child 執行期間 dispose session，detached child 可能繼續，但完成通知接收者已消失；整合須處理 session liveness 與重新對帳，不能只依賴 chat 通知。
- 本機 package 標示版本不等於未修改的上游 release。本案 Pi Web 宣告 SDK `0.85.1`，本機 Pi 宿主為 `0.99.2`；不能假定目前安裝包所有新 public seams 可直接嵌入舊 SDK。[L2–L3]

### 2.3 Southstar：最接近所需的 runtime 骨架

本次依 `src/v2/` 實際程式，而非僅依 README 判斷：

| 接點 | 已看見的行為 | 可借鑑之處 |
| --- | --- | --- |
| `runnable-task-scheduler.ts::claimRunnableTask` | 交易內鎖 run／task；核對 pending、平行數與 workspace 衝突；更新 claimed | 單一 claim owner、併發准入；業務 object 衝突需另作領域映射 |
| `dispatchTask` | 先保存 intent／queued hand execution，再呼叫 provider，之後綁 external job | 將 domain step、dispatch attempt、外部工作分開識別 |
| `tork-hand-provider.ts::executeTask` | 從 workflow 取出單一 task、清空該投影的 dependencies，再提交 Tork | **業務任務圖由 Southstar 排程；Tork 執行被派出的 task**，不是兩邊都排整張圖 |
| `postgres-tork-callback.ts::ingestTaskRunResultPg` | 交易、receipt 去重、attempt identity、stale／late callback；取消後仍留稽核 | callback 是待驗證結果，不直接等於業務成功 |
| `attempt-settlement.ts` | callback／observer 共用 terminal identity／settlement helper | 收斂多個回報通道，不各自定義不同 attempt |
| `postgres-reconciler.ts` | 分辨 callback-missing、orphaned、timeout、lost 等觀察 | 引擎完成、結果收到與領域驗收是不同狀態 |
| `dynamic-repair-revision.ts`、`workflow-revision.ts` | 有修訂與修復路徑；綁既有要求／結果契約；權限擴大有批准路徑 | 動態調整不是自由改寫原目標、批准與歷史 |

**這些是可借用的已存在機制，不是本次已重跑的故障恢復證據。**

兩處移植前特別需要驗證，不能過度概括：

- `settleHandExecutionPg()` 本身是先讀、檢查、再 upsert；光看這個 helper 不能宣稱所有 caller 都有原子 CAS。要核實 callback／observer 的交易鎖與競態，不能把「共用函式」當端到端 exactly-once。
- `applyWorkflowRevision()` 明確保護 `running/completed` 的刪除與依賴變更；scheduler 還有 `claimed/queued`。新 runtime 必須核實所有已派出狀態的保護，不能把 helper 的有限條件說成全生命週期保證。[L4–L7]

### 2.4 Tork：執行引擎可用，業務語義仍由上層負責

官方 README／LICENSE 確認 MIT，描述 Coordinator、Worker、Broker、Datastore，支援 PostgreSQL、條件、parallel、each、subjob、timeout、retry、scheduled jobs 及取消／restart API。[E1–E2]

需要保留三個區分：

- **任務狀態持久化不等於業務交易原子性。** Worker recovery 或 task retry 可能重新執行已產生部分效果的程式。
- **容器隔離不提供操作冪等性。** Tork 可以執行可信 runner；生成 Python 仍沿既有 OpenSandbox 的資料、網路與結果邊界，不能因 Tork 使用 Docker 就省略。
- 本次讀到的 README 與 Southstar adapter **不足以證明完整的 durable human-task／signal／timer 語義**。不能用 cancel/restart 或睡著等待的容器，冒充批准後從原業務 checkpoint 續行。

未核實 Southstar 現場 Tork binary／image 版本；官方 `main` 文件不是已鎖定部署版本的驗收。

## 3. 建議整合：一個業務控制者，數個 executor

```text
DataHub：Object / Link / Binding / Action / Process / State / Release
                            │ 固定版本模型
使用者 / Workbench ──→ 可信 Host：登入身分、政策、批准、受控結果
                            │
                  Ontology Runtime（唯一業務控制者）
                  ProcessInstance / Step / Action / Events
                  PostgreSQL：狀態、intent、attempt、等待與稽核
                            │
          ┌─────────────────┼──────────────────────┐
          │                 │                      │
    AgentStep executor  SandboxStep adapter  ActionStep adapter
    Pi + pi-subagents   既有 MCP/OpenSandbox  具名、可信業務 command
    Tork 可負責派工     生成 Python / ML     權威 API 與結果讀回
          │                 │                      │
          └──────────結果／事件／操作身分───────────┘
                            │
                 Workbench sequence/state + Query/Grafana
```

圖中的 step 名稱為**建議領域概念，不是已實作 API**。

### 責任與狀態權威

- **DataHub release**：可執行定義的權威；runtime 保存不可變版本引用與必要衍生 snapshot，不另建可獨立編輯的模型 registry。
- **Ontology PostgreSQL**：流程實例、ontology-owned objects、等待、批准引用、操作與事件的權威。
- **Tork datastore**：executor job／task 的技術狀態；不能直接等同 `Case.status` 或 `ActionExecution` 成功。可在部署設計中評估共享 PostgreSQL 基礎設施，但須隔離資料主責與權限，不往 DataHub Core 內部庫加表。
- **Pi mission／session**：推理脈絡與 Agent 工作證據，不是業務流程的第二個 scheduler。
- **來源系統**：source-backed properties 與真正外部操作結果的權威；runtime 讀回或對帳。

`HumanTask` 由 runtime 持久化等待與到期時間，不占用一個 Pi session／Tork container 跨日睡眠。使用者在可信入口批准後送入帶身分與版本的事件；此時重核政策，再推進流程。Agent 的 supervisor 回覆本身不是業務批准。

同一個 `AgentStep` 內可用 pi-subagents 做有界協作；它的 child 不另外成為可任意推進業務流程的控制者。Tork、Pi 與 OpenSandbox 的 operation IDs 綁到同一個 step／attempt，並由 runtime 收斂結果。Sandbox 已有獨立控制面時，不必為形式一致再強制套一層 Tork 容器。

## 4. Dynamic workflow 要保留，但有兩種動態

### A. 推理／分析的動態：適合 pi-subagents

例如 Agent 先看可用 schema／證據，選擇規則比對或 ML，平行分析，再依結果補充一項必要檢查。可以用 script／工具協作，不需要固定八步流程或每次分析前的人工作業票。

### B. 業務流程的動態：以受治理的 revision 推進

例如「新增跨部門簽核」「改為取消訂單」「多建立一張外部工單」，會改變參與者、效果或批准內容，應由 Agent 提出有界 revision，再由可信 runtime 決定是否允許。

建議沿前案 Process 模型與 Southstar revision 思路實作，不另開通用 workflow 語言：

1. Agent 回傳結構化 next-step／revision proposal，而非可任意執行的 SQL、URL 或 shell writer。
2. Host 檢查模型 release、step 類型、可用能力、依賴、資料 scope、資源上限與現有批准。
3. 在同一持久化主責中以 expected revision 保存新 revision，保留原始歷史。
4. 已完成工作不改寫；已 claimed／queued／running 的工作不能被 revision 悄悄替換或重送。
5. 只有需要新權限、擴大效果／成本，或原批准不再涵蓋的變更才走相應批准；不把所有自主分析變成逐步人工確認。

因此可以同時具有 **Agent 自主性**與**可恢復、可解釋的業務流程**，不必在完全固定 DAG 與任意腳本之間二選一。

## 5. 目前不能直接搬用的關鍵缺口

### 5.1 Submit 重試與外部失 ACK

Southstar `TorkClient` 預設 `retryCount = 1`；`submit()` 的 `POST /jobs` 使用同一個 retry helper，遇到 timeout／網路錯誤或特定 HTTP 狀態可能再送。所讀 payload／headers 未提供 submission idempotency key，且這次沒有取得對應 server-side 去重保證。[L5]

故障窗口為：

```text
第一次 POST → Tork 已建立 job → 回覆遺失
client 再 POST → 是否建立第二個 job，尚無已驗證的去重契約
callback 去重 → 最多避免重複結算，不會撤銷已發生的兩次外部效果
```

這是**由程式碼可見的風險窗口，不是本次已在現場重現兩張工單**。

新 Action runtime 應在其 owning boundary 保存穩定 `operationKey`、參數 hash、目標物件／版本與 dispatch intent；在 worker 或 engine 重試時保留同一業務操作身分，不能每次生成新 key。外部 API 如具備可靠冪等與 operation lookup，依其契約對帳／續行；否則失 ACK 保留 `UNKNOWN`，不能只因 client 報錯就再送。

本地唯一鍵只能擋住本地重複 admission，不能單獨關閉外部成功、本地未落盤的窗口。Tork job submission 與業務 Action 是兩個不同去重邊界，都要有清楚的語義。

### 5.2 分清重試、續接、修訂與補償

| 情境 | 應有語義 |
| --- | --- |
| 確認未送出的工作 | 原政策／上限內重新准入，不冒充已執行 |
| 無外部效果、可重算的分析 | 依既定政策建立可追溯 attempt；保留成本／原結果，不自動擴權 |
| Agent session continuation | 恢復原 ownership／session／能力與已知工作，不從頭重播完成工具 |
| 外部效果不明 | 唯讀對帳；無可靠證據前維持 UNKNOWN |
| cancellation | 先記 cancel requested，再確認 executor／操作實際停止；不把 API 收到取消當已停止 |
| 補償 | 另一個具名且受政策控制的業務 Action，不是抹掉歷史或宣稱自動回滾 |

### 5.3 長時等待與修訂版本

跨日人審、timer、外部事件、重啟恢復必須在第一個需要它的流程就成立：持久化 wait、事件去重、超時與批准競態、啟動時模型版本、執行時撤權與目前政策。

簡單流程可在 PostgreSQL runtime 內完成這些責任；不是一有人工等待就必須新增 Temporal。但若為滿足這些條件而開始自製完整 signal／timer／replay／compensation 系統，應比較採成熟 durable engine 的成本，而非無限擴張第一方 scheduler。

### 5.4 安全邊界不會隨 executor 自動帶過來

- Teams 的角色 allowlist／工作目錄與 Tork permissions 都不等於 DataHub Object／Action ACL。
- artifact ref、callback、runtime event 必須綁可信 actor、tenant、model release、scope、step／attempt，並驗證真實來源；不能信任模型自報 actor。
- DataHub 目前「metadata 可見即可查詢」與新增 object-level policy 的相容問題仍需明確決策，不因選定 scheduler 就自動解決。
- 現行業務值不進模型／Pi history 的邊界繼續保留。不能把 Southstar context packet、runner logs、Sandbox stdout 或 Tork output 直接灌回 Agent；先作適用的資料／結果 adapter。
- 大型結果與敏感 trace 不放 mission JSON／prompt；使用受控 refs 與使用者 UI。日誌的字串遮罩不是完整資料外洩防線。

## 6. Tork 與 Temporal：不是現在就兩個都裝

| 方向 | 適合條件 | 本案取捨 |
| --- | --- | --- |
| pi-subagents 單獨承擔全部 | 單次 Agent 協作、可明確人工恢復，無 durable 業務等待／效果 | **不建議作完整營運 runtime** |
| Southstar-inspired PostgreSQL runtime＋Tork executor | 已有可借的整合骨架；流程有界，願意在第一方主責處完成等待、政策與 Action 契約 | **優先驗證的候選方向**；不要整包複製 Southstar |
| Temporal 作 durable process owner，Pi／Sandbox 作 activities 或外部執行接點 | 首例即有複雜長時等待、事件與恢復需求，且不希望自行維護整套 durable 排程 | 合理替代候選；仍不解決 Object ACL 或外部 exactly-once |

若選 Temporal，應讓它承擔流程推進主責，**不是額外疊在 Southstar scheduler 之上，讓兩者同時推進同一 instance**。Tork 只有在確有必要的 worker／資源排程需求時保留，且各層重試責任要分清。

本次未對 Temporal 做新的版本／相容性或故障測試；此表是架構取捨，不是 benchmark。建議先拿同一個最小真實流程判斷，不因「已有 Tork」就認為人審／Action 已解決，也不因「durable」一詞就新增第二套引擎。

## 7. 最短驗證與落地路徑

### 第一段：把一個流程對應到現有責任

選定已授權的 Object／來源與權威 API；定義 DataHub release、身份／policy、AgentStep、必要分析、HumanTask、Action 及原生讀回。不在這一步建全套通用 registry、graph DB 或模型市場。

優先復用：

- Southstar 的 task／attempt／callback／observer 設計與既有可重跑案例，按依賴抽取，不整包搬 Git／Goal／Library／memory 子系統。
- pi-subagents 的**公開、版本化** delegation／RPC／status／resume 接口；不依賴私人 worker 檔案路徑或直接修改安裝包來接線。
- 現有 DataHub Host／Query 及 Grafana Sandbox MCP 的 adapter 思路，維持各自資料與憑證邊界。

### 第二段：針對會破壞營運語義的故障驗證

在另行批准的隔離環境先測：

1. intent 已落盤但尚未 submit，以及已 submit 但回覆遺失；重啟後不能憑猜測再派。
2. 同一／過期 attempt 的重複 callback、callback 與 observer 並發、取消後才到的結果。
3. 兩個 scheduler 爭同一步、舊 owner／worker 晚交，以及 claimed／queued 階段的 revision。
4. 人工等待跨重啟；批准、timeout 與撤權競態；舊模型 instance 不被新 release 偷換。
5. 外部 Action 已成功但 ACK／本地提交遺失；對帳取得權威結果，不能重複建立。
6. Agent／Sandbox／Tork 的輸出與錯誤都不能把業務值繞入模型 history；真使用者仍能在受控 UI 檢視結果。

合成外部 API 可作故障注入，但只證明相應契約；不當作真業務 Action 驗收。

### 第三段：從真入口完成營運閉環

另取必要操作批准後，從 DataHub／Pi 入口完成：模型／object 解析 → Agent 動態分析 → 必要人審 → 真 Action → 權威讀回 → sequence/state 顯示 → Query/Grafana 觀察。再驗一輪來源／模型／人工內容或政策改變後的更新／失效。

**只讓一個 Tork job 跑完，或讓 Agent 回「完成」，不代表 Ontology runtime 完成。** 尚需確認：第一個業務流程、共用物件政策、模型資料揭露範圍、executor 版本組合與必要部署／資料操作授權。本研究不是這些操作的批准。

## 8. 來源、版本與驗證界限

### 本機一手程式／文件

- [L1] `~/.pi/agent/teams/TASK-PI-RUNTIME-DESIGN.md`、`task-runtime/ledger.mjs`、`task-runtime/RUNTIME-READINESS.md`、`TASK-PI-USABILITY-RECOVERY-PROGRESS.md`。
- [L2] `~/.pi/agent/npm/node_modules/pi-subagents/`：`package.json`、`docs/workflows.md`、`docs/missions.md`、`docs/extension-api.md`、`src/workflows/scripted-workflow.ts`、`src/missions/workflow-state.ts`。
- [L3] [DataHub Pi Web package](../../extensions/datahub-agent/pi-web/package.json)；本機 Pi `@earendil-works/pi-coding-agent` package 及完整 SDK／session-format 文件。
- [L4] `~/apps/southstar/src/v2/scheduler/runnable-task-scheduler.ts`、`hands/tork-hand-provider.ts`。
- [L5] 同 repo `executor/tork-client.ts`、`tork-provider.ts`、`tork-projection.ts`。
- [L6] 同 repo `executor/postgres-tork-callback.ts`、`attempt-settlement.ts`、`postgres-reconciler.ts`；`tests/v2/execution-attempt-settlement.test.ts` 僅查閱，未執行。
- [L7] 同 repo `runtime-revision/dynamic-repair-revision.ts`、`manifests/workflow-revision.ts`；現行架構依 `AGENTS.md`／`CONTEXT.md`／`README.md`，不以舊目錄作主責。

本機他案路徑是查閱位置，不代表 DataHub 已依賴、已安裝或有權操作那些 runtime。Southstar 所讀 Git HEAD：`ff67c566f802f99ed65748c5615f2a321b5c98e5`，工作樹有大量既存變更；判斷依 working-tree bytes，不當成乾淨的 release。DataHub HEAD：`7f22e2729e7c02ba66e2bed7c88c4d0571dca47f`，同樣未將既有 dirty paths 視為本次產物。

關鍵來源 SHA-256（本次查閱版本）：

| 檔案 | SHA-256 |
| --- | --- |
| Southstar `executor/tork-client.ts` | `e3a8d01fdb8e3f82e785fa1af530eacc2c996c551ffc661f95597f647956ed48` |
| Southstar `scheduler/runnable-task-scheduler.ts` | `5246bd5adb024bfc460f5c681a09bcbb3fe4c3090438323198e42e1ee9e882a9` |
| Southstar `executor/attempt-settlement.ts` | `5631e80a9040a13f581be9775e4c40c60ee14fb6fab16f8ab00615908e5b3b19` |
| 本機 pi-subagents `src/workflows/scripted-workflow.ts` | `b9bd92cba0c71481aab5d611a36f91452b0a7944aeeb444b87a4896896a041c1` |
| 本機 Teams `task-runtime/ledger.mjs` | `370924bed129613f809fa5920ad40d1a08327be51a8f6196c62359116473acd1` |

### 外部一手來源

- [E1] [Tork 官方 GitHub](https://github.com/runabol/tork)、[本次讀取的 README](https://raw.githubusercontent.com/runabol/tork/main/README.md)：Architecture、Tasks、Retry、REST API、Extending Tork。
- [E2] [Tork MIT LICENSE](https://raw.githubusercontent.com/runabol/tork/main/LICENSE)。

搜尋工具的綜合摘要只作定位；能力判斷以直接讀取的官方文件與本地程式為依據。未採用「容器便保證冪等」「未見文件便代表任何版本都不支援等待」等推論。

本輪只新增本研究文件；未修改前兩份報告、產品程式、Teams／pi-subagents／Southstar、Core、服務或模型設定，未跑 runtime 測試／fresh preflight／live probe、未接觸憑證、未 commit／push。文件格式檢查不是 runtime 驗收。

**研究回顧：最有價值的重用單位是責任與生命週期接點，不是把既有 orchestrator 整包搬過來。動態協作與持久流程可以並存，前提是流程狀態只有一個主責、外部效果由具名 Action 邊界負責。**

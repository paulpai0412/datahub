# DataHub Agent／MCP／pi-web／MFE 整合研究

> **方案已更新**：依使用者最新要求，改採完整 pi-web 納入、功能保留、DataHub 風格 UI 與唯一 Agent 入口。請以 [整合方案 v2](datahub-agent-pi-web-plan-v2.md) 為準。本文件的零散抽取、刪減 filesystem／terminal、另寫 chat backend 建議已被取代。MFE host 實際入口是 `/mfe` + YAML path 且 exact；下文示意子路由不是現成 host 契約。來源研究保留，不表示部署驗收。

日期：2026-09-10  
研究範圍：DataHub OSS `v1.7.0.1`（upstream commit `e99431ec510d7a2001f815c6bf70913c493af76e`）與 `agegr/pi-web` commit `b1a72962d385db4a82b93ad5802e9024d5b44874`（package `@agegr/pi-web` `0.9.0`）。本報告是 primary-source code／文件研究，尚未代表部署或瀏覽器驗收。

## 結論

1. **本機 DataHub Core 最小可行路徑是：獨立 MFE + 受控 Agent backend + self-hosted `mcp-server-datahub`。** DataHub 官方文件明確說 self-hosted MCP 可連 DataHub Core；使用 `DATAHUB_GMS_URL` 與 `DATAHUB_GMS_TOKEN`。
2. **不要把 DataHub Cloud Agents 當成 OSS v1.7 的本機 runtime。** `docs/features/feature-guides/agents.md` 標示 SaaS-only／Private Beta；它的 task、decision、AI Plugin 與 creator permission 模型是 Cloud 能力。
3. **Agent Registry 與 Agents 是兩件事。** Registry 文件標示 DataHub Cloud v2.1 introduced／SaaS-only；但目前 checkout 已有 `aiAgent`、`agentSkill`、`api` 等 metadata model、SDK entity helper 與範例，因此可把外部 Agent／skill／tool 作為可治理 metadata 研究，但不應宣稱本機 UI 已提供完整 Registry 功能。
4. **pi-web 適合借鑑或在 MIT 下抽取 UI；不適合直接當 DataHub MFE remote。** 它是 Next.js 16／React 19 的完整 local agent app，沒有現成 Module Federation `remoteEntry.js`／`mount()` 契約。DataHub MFE host 要求 remote export `mount(element)`；因此最小風險是重用互動模型與少量元件／CSS，或做一個薄的 DataHub-specific MFE，而不是整個嵌入 pi-web。
5. **pi-web 的 MCP 設定不是獨立 MCP 設定頁。** pi-web 透過 Pi 的 plugin／extension runtime 載入 MCP；UI 有 Models、Skills、Agents、Plugins 設定，但沒有 `mcpServers` 編輯器。DataHub MCP 應由 backend／extension 受控配置，避免把 GMS token 暴露給瀏覽器。

## DataHub 端能力

### DataHub Agents（Cloud-only）

官方 `docs/features/feature-guides/agents.md`：

- Agents 是可排程、事件觸發或手動執行的自訂 AI agent。
- Agent 有 instructions、tools、AI Plugins、View scope 與 Ask DataHub Chat visibility。
- Tasks 有 schedule／event trigger，Decisions 可讓 agent 暫停等待人工輸入。
- 須有 `Manage Agents` privilege；task run 目前以建立 task 的使用者權限執行。
- 文件的 `FeatureAvailability saasOnly` 與 FAQ 均寫明目前不能在 DataHub Cloud 以外使用。

**對本專案的判斷：**不要為了 local OSS POC 直接依賴這組 UI／runtime。若未來改用 Cloud，可把本專案的 approval／task／decision 設計對映到 Cloud Agents；目前 local implementation 應由我們自己的 backend 控制。

### Agent Registry（治理 metadata，不是 agent runtime）

官方 `docs/features/feature-guides/agent-registry.md`：

- `AI Agent`、`Skill` 是主體；Tool 使用 Service Catalog 的 `API` entity；MCP Server 使用 `Service` entity。
- 文件標示 `Introduced in DataHub Cloud v2.1`，並有 SaaS-only availability。
- 關係概念為 repository → MCP service → API tool ← invokes ← aiAgent → adopts → skill，並連到 agent 讀取的 Dataset lineage。

同一 checkout 的 metadata model／Python SDK 已存在：

- `metadata-models/src/main/resources/entity-registry.yml` 註冊 `aiAgent` 與 `agentSkill`。
- `metadata-ingestion/src/datahub/api/entities/agent/agent.py`、`agent_skill.py` 提供 `Agent`、`AgentSkill`。
- `docs/api/tutorials/agent-registry.md` 描述先 emit API tool，再 emit skill，再 emit agent 的順序；agent 可帶 `tools`、`skills`、`models`、`consumes_datasets` 與 version set。

**判斷：**可以將 DataHub Agent backend、DataHub MCP server 與 DataHub skill manifest 註冊為治理 metadata；但先以 SDK／MCE／公開 API 驗證本機 v1.7 的實際 aspect／UI 支援，不把 Cloud-only Registry page 當成已可用功能。

### DataHub MCP（Core 可用）

官方 `docs/features/feature-guides/mcp.md`：

- self-hosted MCP server 明確支援 DataHub Core。
- 啟動時傳入：`DATAHUB_GMS_URL`、`DATAHUB_GMS_TOKEN`。
- Read tools 包含 search、get_entities、schema、lineage、lineage paths、dataset queries、SQL context、pending proposals。
- Mutation tools 在 `mcp-server-datahub` v0.5.0+ 可用，需 `TOOLS_IS_MUTATION_ENABLED=true`；官方標註 mutation tools `readOnlyHint: false`，讓 MCP client 可要求確認。
- 官方建議 autonomous workflow 使用 service account；可配 Default View 限制搜尋範圍。

本專案的初版部署對映：

```text
DataHub MFE chat
    → DataHub Agent backend（session／policy／preview／approval）
    → mcp-server-datahub（read first；mutation only after approval）
    → GMS 18080 / DataHub metadata graph
```

MCP 只負責 DataHub metadata tool contract；ETL 執行、OpenLineage、SQL Server ingestion 與 Evidence storage 仍由受控 backend／外部 runtime 負責。

## pi-web 原始碼盤點

來源 checkout：`/tmp/pi-github-repos/runtime-Nf2Sfv/cf029ca31fded112591fd778412e158bd2408358f1bc8dd929de532b710c2c7d`。

### Chat composer

`components/ChatInput.tsx` 匯出 `ChatInput` 與 `ChatInputHandle`。主要可重用的互動契約：

- `onSend(message, images)`：一般 prompt。
- `onAbort()`：停止目前執行。
- `onSteer`／`onFollowUp`／`onPromptWithStreamingBehavior`：streaming 中插入 steer／follow-up。
- `model`、`modelList`、`onModelChange`：模型選擇。
- `thinkingLevel`、`onThinkingLevelChange`：thinking level。
- `toolPreset`、`onToolPresetChange`：`chat-only`／`read-only`／`default`／`full`。
- slash command palette：builtin、extension、prompt、skill；`/compact`、`/reload`、`/name`、`/session` 等內建命令。
- `@` file autocomplete、image attachments、input history、draft persistence、audio completion toggle。

因此 DataHub MFE 可借用「單一 composer + streaming state + command palette」的形狀，但 DataHub 需求應增加：DataHub asset search、lineage preview、manifest／run evidence preview、approval submit；不可直接把 pi 的 filesystem／terminal tools 暴露給一般 DataHub 使用者。

### Sidepage／側邊區域

pi-web 沒有單一名為 `SidePage` 的元件，而是三層布局：

- `components/SessionSidebar.tsx`：左側 session／project／worktree／file explorer。
- `components/AppShell.tsx`：`sidebarOpen`、`rightPanelOpen`、可拖曳寬度、mobile overlay。
- 右側 panel：`TabBar` + `FileViewer`／`TerminalPanel`，可 watch file、引用行號到 composer。
- top floating panels：Agents、Branches、System Prompt、Tools、Session stats。
- `components/SettingsPanel.tsx`：General、Models、Skills、Agents、Plugins 五個設定 section。

DataHub 應使用相同「主 chat + 可關閉／可調整寬度的右側 drawer」概念，但右側內容改為：

```text
Context / Assets
Lineage preview
Execution / Evidence
Approval queue
```

不應把 pi-web 的 file browser／terminal side panel 映射成 DataHub metadata UI。

### Model／skill／plugin 設定

- `ModelsConfig.tsx`：GET／PUT `/api/models-config`，讀寫 `~/.pi/agent/models.json`；另查 `/api/auth/providers`，支援 OAuth／API-key provider、custom provider、model discovery、model test。
- `SkillsConfig.tsx`：GET／PATCH `/api/skills?cwd=...`，PATCH 只改目標 skill 的 `disable-model-invocation`；另有 skill search／install／check／update。技能按 project／global／path 分組。
- `PluginsConfig.tsx`：GET／POST `/api/plugins`，使用 Pi `SettingsManager`／`DefaultPackageManager` 管理 project／global package；可 install、remove、enable、disable、update，必要時送 agent `reload`。
- `AgentsConfig.tsx`：管理 pi 內建 subagent toggle 與 profile，不等同 DataHub Cloud Agents。
- 沒有獨立 `MCPConfig`／`mcpServers` UI；`rg` 只找到 MCP tool name normalization 與 extension MCP lifecycle，MCP server lifecycle 在 Pi extension／plugin runtime。

### Runtime 與安全邊界

pi-web `AGENTS.md` 描述的 runtime 是：

```text
Browser → Next.js API → in-process AgentSession → pi SDK／extensions
```

`POST /api/agent/new` 建立 session，`POST /api/agent/[id]` 傳命令，SSE `/api/agent/[id]/events` 回傳事件。`startRpcSession()` 在 server process 建立 AgentSession；因此把 DataHub token 放 browser 端是不必要且不安全的。

pi-web README 與 source 也明確指出它是 local high-privilege agent UI；若 bind 到非 loopback，必須設長隨機 password，且不要以 plain HTTP 暴露 Internet。這些警告不能直接套用成 DataHub multi-user deployment 的 auth model。

### License／可重用性

`pi-web` repository 的 `LICENSE` 是 MIT，copyright `agegr`；可在遵守 notice 的前提下修改、抽取與再發佈。其 `package.json` 為 Next.js app／CLI，沒有 DataHub MFE 契約；目前最小方案仍是重新建立 DataHub MFE 的 mount entry，而非把整個 package 當 remote。

## DataHub MFE 實際契約

DataHub `datahub-web-react/src/app/mfeframework/README-MFE.md` 與 source 顯示：

```yaml
microFrontends:
  - id: DataHubAgent
    label: Agent
    path: /datahub-agent
    remoteEntry: http://localhost:30150/remoteEntry.js
    module: datahubAgentMFE/mount
    flags:
      enabled: true
      showInNav: true
    navIcon: Robot
```

MFE 必須：

- 提供 `remoteEntry.js`。
- expose Module Federation module，例如 `datahubAgentMFE/mount`。
- export `mount(containerElement)`（也可直接 export function；host 會找 function／`mount`／default mount）。
- 回傳可選 cleanup function。
- DataHub host 以 dynamic remote 讀取，5 秒載入 timeout；MFE mount 失敗會進 ErrorComponent。
- host YAML 由 `MFE_CONFIG_FILE_PATH` 指定；local 使用 `datahub-frontend/conf/mfe.config.local.yaml`，Kubernetes 可由 ConfigMap mount。
- `subNavigationMode=false` 時顯示 top-level nav；`showInNav` 控制是否進 nav。MFE 本身不會自動取得 DataHub GraphQL auth 或 token；需沿用同源 cookie／公開 frontend route，或讓 backend 代理 GMS。

**重要限制：**現有 MFE contract 沒有 documented auth／permission／context injection API。需要 current user、DataHub GraphQL、CSRF／mutation approval 時，應由同源 DataHub backend endpoint 或獨立 Agent backend 做授權，不要在 MFE 寫 PAT。

## 建議的最小 POC

### POC-1：read-only agent search

1. 寫一個獨立 DataHub Agent backend，先只提供 `/api/agent/chat` 與 SSE／streaming。
2. backend 啟動 self-hosted `mcp-server-datahub`，只開 read tools。
3. MFE 用自己的 `mount()`，先實作 ChatInput-like composer、message stream 與右側 Context drawer。
4. 第一個 tool 只允許 `search`、`get_entities`、`get_lineage`、`list_schema_fields`。
5. 用 AdventureWorks dataset URN 驗證 search → schema → lineage；不寫 metadata、不執行 SQL。

### POC-2：preview／approval／publish

1. Agent 產生 lineage manifest／DataFlow/DataJob proposal，不立即 emit。
2. 右側 drawer 顯示 proposed changes、target URNs、source evidence、run id、idempotency key。
3. 使用者明確 approval 後，backend 以 service account 呼叫受控 SDK／MCP mutation。
4. 成功回讀 GMS entity/aspect，再顯示 published；失敗不得顯示成功 lineage。
5. `mcp-server-datahub` mutation mode 與 DataHub credential 只在 backend；frontend 只拿 opaque session／proposal id。

### POC-3：Agent Registry metadata

若本機 v1.7 的實際 aspect／UI 驗證通過，再用官方 Python SDK 建立：

```text
urn:li:api:datahub-agent.search
urn:li:api:datahub-agent.get_lineage
urn:li:agentSkill:datahub-metadata-discovery
urn:li:aiAgent:datahub-agent
```

以 `consumes_datasets` 連 AdventureWorks Dataset，以 `tools`／`skills` 建治理關係。這是 metadata registration，不取代 backend runtime。

## 不採用的方案

- 不把 DataHub Cloud Agents UI／AI Plugins 當 local Core extension。
- 不把整個 Next.js pi-web 直接塞進 DataHub MFE；沒有現成 `mount` remote contract，且會帶入 filesystem／terminal／session 假設。
- 不在 MFE 暴露 DataHub PAT、MSSQL password 或 MCP env。
- 不讓 generic LLM 直接執行來源 ETL 程式碼；ETL execution 與 metadata publishing 分離。
- 不把 DataHub MCP 的 mutation tool 當成無審批寫入 API。

## Primary sources

### DataHub checkout

- `upstream/datahub/docs/features/feature-guides/mcp.md`
- `upstream/datahub/docs/features/feature-guides/agents.md`
- `upstream/datahub/docs/features/feature-guides/agent-registry.md`
- `upstream/datahub/docs/api/tutorials/agent-registry.md`
- `upstream/datahub/datahub-web-react/src/app/mfeframework/README-MFE.md`
- `upstream/datahub/datahub-web-react/src/app/mfeframework/MFEConfigurableContainer.tsx`
- `upstream/datahub/metadata-models/src/main/resources/entity-registry.yml`
- `upstream/datahub/metadata-ingestion/src/datahub/api/entities/agent/agent.py`

### pi-web checkout

- `README.md`
- `LICENSE`
- `AGENTS.md`
- `package.json`
- `components/ChatInput.tsx`
- `components/AppShell.tsx`
- `components/SessionSidebar.tsx`
- `components/SettingsPanel.tsx`
- `components/ModelsConfig.tsx`
- `components/SkillsConfig.tsx`
- `components/PluginsConfig.tsx`
- `app/api/agent/[id]/route.ts`
- `app/api/agent/new/route.ts`
- `app/api/models-config/route.ts`
- `app/api/plugins/route.ts`
- `app/api/skills/route.ts`

### Public first-party links

- <https://github.com/datahub-project/datahub/blob/e99431ec510d7a2001f815c6bf70913c493af76e/docs/features/feature-guides/mcp.md>
- <https://github.com/datahub-project/datahub/blob/e99431ec510d7a2001f815c6bf70913c493af76e/datahub-web-react/src/app/mfeframework/README-MFE.md>
- <https://github.com/agegr/pi-web/blob/b1a72962d385db4a82b93ad5802e9024d5b44874/README.md>
- <https://github.com/agegr/pi-web/blob/b1a72962d385db4a82b93ad5802e9024d5b44874/LICENSE>

## 如何參考 Cloud Agents／Agent Registry，再自製整合至 DataHub Core

### 1. 參考原則：複製規格，不複製 Cloud runtime

應把 Cloud 文件拆成三層：

| Cloud 內容 | 本地 Core 的做法 | 是否直接重用 |
| --- | --- | --- |
| Agent／Task／Decision 產品語意 | 自製 Agent backend domain model 與狀態機 | 語意重用，runtime 不重用 |
| Agent／Skill／API／MCP metadata schema | 使用官方 `aiAgent`／`agentSkill`／`api`／`service` model 與 SDK | 優先直接重用 |
| Cloud Agents／Registry UI | 參考資訊架構、欄位與互動；由獨立 MFE 實作 | 不直接嵌入 Cloud UI |

禁止把 Cloud-only feature flag、內部 API、Cloud worker、Cloud task runner 或私有 GraphQL mutation 猜成 Core public contract。所有可重用項目必須以 checkout 中的公開 model、SDK、GraphQL／REST schema 或官方文件確認。

### 2. Cloud Agents 規格 → local backend 對映

Cloud Agent 的最小 domain model 可在 local backend 做成下列資料，不需要修改 DataHub Core：

```text
AgentDefinition
  id, name, description, instructions
  enabled, view_scope, model_ref
  tool_refs[], skill_refs[]
  source_type: SYSTEM | NATIVE | EXTERNAL

AgentTask
  id, agent_id, instructions
  trigger: MANUAL | SCHEDULE | EVENT
  allow_decisions, status

AgentRun
  id, task_id, status
  started_at, finished_at, trace_ref
  proposed_changes[], evidence_refs[]

AgentDecision
  id, run_id, question, choices
  status: PENDING | APPROVED | DISMISSED
  response, responder
```

建議狀態機：

```text
DRAFT → PREVIEW → WAITING_APPROVAL → EXECUTING
                              ↘ REJECTED
EXECUTING → SUCCEEDED | FAILED | INDETERMINATE
```

`PREVIEW` 與 `WAITING_APPROVAL` 是本地版必須保留的安全邊界；不要把 Cloud 的 Run Now 簡化成無條件寫入。對 lineage／metadata mutation：

- 先產生 proposal，列出 URN、aspect、before／after、來源證據與 idempotency key。
- approval 後才呼叫 MCP mutation 或官方 SDK。
- 成功後回讀 GMS 進行 verification，才將 run 標記 `SUCCEEDED`。
- timeout、部分成功、無法回讀時標記 `INDETERMINATE`，不可顯示為成功。

`AgentTask`、`AgentRun`、`AgentDecision`、Evidence 與 approval audit 建議先存在 extension PostgreSQL；DataHub 只保存可治理的 agent／skill／tool metadata，不把 workflow state 偽裝成 Dataset。

### 3. Agent Registry model → DataHub Core metadata 對映

官方 model 已提供足夠的最小註冊面：

| 需要治理的項目 | DataHub entity／aspect | 本專案實例 |
| --- | --- | --- |
| Agent | `urn:li:aiAgent:<id>` + `aiAgentInfo`／`aiAgentDependencies` | `urn:li:aiAgent:datahub-local-agent` |
| Skill | `urn:li:agentSkill:<id>` + `agentSkillInfo` | `urn:li:agentSkill:metadata-discovery` |
| MCP tool | `urn:li:api:<id>` + signature／subtype `MCP_TOOL` | `urn:li:api:datahub.search` |
| MCP server | `service` entity，subtype MCP | `urn:li:service:datahub-mcp-local` |
| Model | existing `mlModel` entity | configured LLM model URN |
| Source code | `repository` entity | Agent backend／skill repository |
| Data consumed | existing Dataset lineage | AdventureWorks Dataset URNs |

官方 `aiAgent` model 的 `source.type` 可直接表達 `SYSTEM`／`NATIVE`／`EXTERNAL`；`aiAgentDependencies` 表達 skills、tools、models；Agent Registry 文件也把 tool 定義為 API，而不是額外自創 entity。這讓 local implementation 不需要 fork Core 或建立非標準表。

建議 emitter 分成三個 idempotent command：

```text
register-agent-tools  → API + apiSignature + MCP service
register-agent-skills → agentSkillInfo + requiredTools
register-agent         → aiAgentInfo + dependencies + consumed datasets
```

順序依官方 tutorial：先 tool、再 skill、最後 agent。metadata publish 與 AgentRun publish 分離；只有已驗證的執行結果才更新 lineage／evidence。

### 4. Cloud UI → local MFE 的資訊架構

Cloud Agent Registry profile 與 Agents detail page 可參考其資訊架構，不必複製畫面實作。local MFE 建議採四個 route／drawer：

```text
/datahub-agent                  chat workspace
/datahub-agent/agents/:id       agent profile + tools + skills + data scope
/datahub-agent/tasks/:id        task config + run history
/datahub-agent/runs/:id         live trace + proposal + evidence + decision
```

#### Agent profile

參考 Cloud 的欄位，但以 Core 可取得的 metadata 顯示：

- name／tagline／description／instructions 摘要
- source type、owner、domain、tags、version
- model、skills、MCP service、API tools
- upstream datasets／lineage
- health：最近 run、failure rate、pending decisions
- `Edit` 只改本地 backend proposal，不直接寫 DataHub

#### Agent chat

沿用 pi-web `ChatInput` 的互動形狀：model selector、tool scope、slash／skill command、streaming、abort、history；但工具清單只顯示 backend policy 允許的 DataHub tools。每個 mutation tool 需顯示 `readOnly`、`destructive`、`requiresApproval`、scope 與預期影響。

#### Task／run page

參考 Cloud 的 Task detail／Run modal：

- manual Run Now、schedule、event trigger
- run status、duration、tool trace、輸入輸出摘要
- proposal diff、affected URNs、evidence links
- `Approve`／`Reject`／`Dismiss decision`
- 關閉頁面不取消執行；以 SSE／polling 重新連線

#### 右側 drawer

以 pi-web 的 right panel 概念實作，不把它當 file viewer：

```text
Context drawer
  Selected datasets / schema / lineage
Proposal drawer
  before → after aspect diff
Evidence drawer
  ETL run / OpenLineage event / SQL validation / artifact hash
Decision drawer
  question / choices / free text / approver
```

### 5. Local Core 的 plugin-first 邊界

推薦 repository 結構：

```text
extensions/datahub-agent/
  backend/                 # session、policy、approval、run state
  mcp/                     # mcp-server-datahub adapter／tool allow-list
  metadata/                # official SDK emitters／OpenLineage bridge
  persistence/             # PostgreSQL evidence／proposal／audit
  frontend/                # independent MFE mount()
  contracts/               # JSON Schema／event／proposal contract
  deploy/                  # separate service/container config
```

這個 extension 不修改 `upstream/datahub` Core，也不直接依賴 DataHub 內部資料表。與 DataHub 的整合只走：

- self-hosted `mcp-server-datahub`；
- DataHub official Python SDK／CLI；
- GMS GraphQL／OpenAPI／OpenLineage public endpoint；
- DataHub MFE YAML 與 Module Federation `mount()` contract。

若某欄位或 mutation 在 Core 沒有公開 API，先把它放在 local extension 的 proposal／evidence；不要讀 Kafka、OpenSearch、Postgres 內部表，也不要 patch Core。

### 6. 建議實作順序

#### Phase A：read-only contract

- 啟動 local `mcp-server-datahub`，只允許 search、get_entities、schema、lineage。
- 建立 MFE chat + context drawer。
- 後端建立 session、policy、SSE；瀏覽器不持有 PAT。
- 用 AdventureWorks dataset 完成 search → schema → lineage proof。

#### Phase B：registry metadata

- 用官方 SDK 註冊 `API`、`AgentSkill`、`Agent`。
- 設定 tool signature、skill source repository、agent model／dataset dependencies。
- 回讀 GMS entity/aspect，確認 URN 與關係可搜尋／可追 lineage。

#### Phase C：proposal／approval

- 建立 `AgentRun` 與 `Proposal` PostgreSQL tables。
- 讓 Agent 產生 DataFlow／DataJob／lineage proposal；UI 顯示 diff。
- approval 後才啟用 MCP mutation 或 SDK emitter；完成後 verification。

#### Phase D：task／decision

- 先只支援 manual trigger，再加 schedule。
- event trigger 只接已驗證的 ingestion／ETL run event，不直接讓任意 metadata event 觸發寫入。
- decisions、audit、retry、indeterminate recovery 都保留 server-side state。

#### Phase E：Cloud parity checklist

- Agent profile 欄位與治理關係。
- Skill／tool／model／dataset dependency graph。
- task／run／decision lifecycle。
- trace、approval、permissions、view scope。
- versioning、health、ownership、audit。

每一項都以 local public contract 實作；Cloud-only feature 若無 Core 等價能力，標示 `not_available_local`，不要用 hardcode 假裝相容。

### 7. Local 與 Cloud 的明確差異

| 能力 | DataHub Cloud | 自製 local Core 版本 |
| --- | --- | --- |
| Agent execution | DataHub managed agent runtime | extension backend／worker |
| Task scheduler | Cloud task scheduler | extension scheduler／外部 scheduler |
| Human decision | Cloud decision UI | MFE + backend approval table |
| DataHub tools | Cloud tool palette／AI Plugins | self-hosted MCP + allow-list |
| Agent Registry UI | Cloud feature page | custom MFE profile／search |
| Agent metadata | governed Cloud entity | official SDK／MCE emit to Core |
| Evidence／run state | Cloud internal services | extension PostgreSQL + DataHub links |
| Auth | DataHub Cloud user／service identity | DataHub auth + backend service account／policy |
| Scope | Cloud View／agent config | View-aware MCP／backend policy |

這個差異表要放進 implementation plan 與 README，避免未來把 local extension 誤稱為 DataHub Cloud Agents。

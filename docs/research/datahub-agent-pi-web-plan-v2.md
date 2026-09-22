# DataHub Agent 整合方案 v2：完整 pi-web，DataHub 原生風格

**2026-09-12 使用者最新決定優先於本文歷史實作建議：** 依 [T01–T07 實作待辦](../datahub-agent-todo.md) 推進真模型回應 → DataHub MCP 查詢 → 原生 Source／Secret／ingestion 實測 → 必要缺口 → ingestion／lineage 讀回 → Registry／Task／Decision／排程 → 整合驗收。**不另外建立新的 datastore，未來客製套用官方 DataHub datamodel／Aspect／公開 API。** 不把獨立 worker／審批／outbox 框架視為預設必建。真 DataHub Agent 入口、MCP 設定頁及 ChatGPT 登入已確認；[T01 真模型回覆](../verification/datahub-agent-open-and-model.md)與 [T02 真 DataHub MCP schema／lineage 查詢及 reload](../verification/datahub-agent-datahub-mcp.md)均已通過；短效 token 期限與後續 T03–T07 仍須依最新 TODO 管理。

已確認授權：DataHub 多使用者，各自隔離 workspace／session／credentials；允許本專案限定部署、AdventureWorks2019 metadata 讀取、本地 DataHub 可辨識測試 Source／Agent／Task／lineage metadata 寫入。不修改業務資料、不刪既有 metadata、不動其他服務、不 commit/push、不派子代理。模型憑證由使用者在新設定頁另行配置，不複用開發機憑證。使用者後續指定實作與安全檢查皆由主代理執行、不派 reviewer；報告標示自查非獨審。安全負例、隔離與模型 live 驗收仍不能以一般 source tests 代替。

## 1. 最新需求與取代範圍

依使用者最新決定：

- DataHub 左側導覽只新增 **Agent** 一個 MFE 入口。
- Agent 看起來是 DataHub 本身的工作頁，不是另一套網站嵌在裡面。
- **完整納入 pi-web 專案與功能，不再零散抽取 UI 或重寫 Agent runtime。**
- 保留 models、skills、plugins、sessions、files、terminal、worktrees 等既有功能；新增完整 MCP 設定能力。
- 修改重心為 UI、layout 與 DataHub 整合；DataHub Core 保持不變。

本方案取代先前報告的「只抽取部分元件」「不保留 terminal／filesystem」「另寫一套 chat backend」建議。Cloud Agents 的 Task／Decision 與 Agent Registry 仍是 DataHub 擴充需求，不是 pi-web 原有功能。

**必要澄清：不能保證只改 CSS 就完成。** pi-web 沒有獨立 MCP 設定頁，也沒有 DataHub SSO／多使用者隔離／發布審批。這些要新增 integration code，但不重寫原本的 chat／session／model／skill 邏輯。

## 2. 整合架構：薄 MFE 外殼 + 完整 pi-web

```text
DataHub Core（原封不動）
  └─ 左側唯一入口 Agent：/mfe/agent
       └─ 薄 Module Federation MFE：mount / cleanup
            └─ 無邊框 iframe：完整 pi-web，DataHub skin
                 ├─ Next.js UI + 原有 API routes
                 ├─ 原有 AgentSession / Pi SDK / SSE
                 ├─ 原有 models / skills / plugins / files / terminal
                 └─ 新增 DataHub integration
                      ├─ MCP 設定與受控 MCP client bridge
                      ├─ DataHub MCP：metadata discovery
                      └─ preview / approval → 官方 SDK／CLI → GMS
```

### 為什麼選這種方式

pi-web 是完整 Next.js application，不是可直接 import 的 UI package。用薄 MFE 承載完整 app，可保留 Next routes、server-side runtime、React 19、CSS、SSE 與升級方式，不必把整套 Next.js 改造成 Module Federation remote。

iframe 是技術容器，不是視覺設計：不顯示邊框、第二個 logo、第二套全域導覽或獨立 landing page。載入後直接進 Agent 工作區，背景、字體、間距与 DataHub 一致。

建議 pi-web 使用受控的獨立 origin，讓 `/api/*`、`/_next/*`、service worker 不與 DataHub 路徑衝突。正式環境使用同一組織的 HTTPS／SSO；本機 origin／port 在部署時確認，不使用其他專案既有 pi-web 服務。

**待驗證 gate**：frame-ancestors／X-Frame-Options、Cookie／SSO、OAuth popup、clipboard、downloads、SSE、terminal transport、PWA／push permissions。若嵌入限制使某功能不可用，先回報，不悄悄刪掉；必要時提供同一 session 的「獨立開啟」入口。

不建議第一版把整個 Next app federation 化，這會擴大 backend 與打包改動，反而違背保留功能、主要改 UI 的目標。

### 2.1 多使用者隔離的實作約束

只分開 server filesystem **不夠**：pi-web 的 localStorage 設定、IndexedDB／service-worker cache 也必須隔離，不能讓不同 DataHub 使用者共享 Agent browser origin。2026-09-13 核實原生 `draft-store.ts` 為記憶體 Map，整頁重載會清空草稿；本案不另加草稿持久化。

- 建議本機 gateway 為單一專用 loopback port，每位使用者使用 `<opaque-key>.localhost:<port>` 子 origin；正式環境需對應 wildcard DNS／TLS。Chromium 153 已驗 cookie／storage，以及兩個真 pi-web 容器；身份仍使用明示 fixture，成功 DataHub SSO、其他瀏覽器與完整功能矩陣尚未驗證。
- key 由部署 tenant＋DataHub 官方 `me.corpUser.urn` 產生 48 hex 字元（192-bit digest，符合 DNS label 長度）；**路由 key 不是認證、權限或 secret**。持久映射需唯一約束／碰撞拒絕，不依 key 反推 actor。
- MFE 只呼叫固定 gateway 的 `POST /agent/bootstrap`，credentials include，但不提交 userId。Backend 只把配置的 DataHub session cookie 轉發到固定 frontend `/api/v2/graphql`；不信任 actor cookie／postMessage／任意 Authorization，也不以服務 PAT 代替使用者。
- Gateway 必須精確檢查 Host／Origin、CSRF、CORS allow-origin，且不能把 DataHub cookie／bootstrap token 傳給 Pi runtime。無 session、重複 session cookie、redirect、GraphQL errors、超時、超量回應一律拒絕。
- Bootstrap 回傳短效、一次性、綁 actor＋target origin 的 launch URL；token 放 fragment，由 bootstrap endpoint 交換成 HttpOnly host-only session 後立即清除 fragment。不可被 service worker cache、記錄於 logs 或進入模型。
- 登出、帳戶切換、多分頁、過期、SSE／PTY 長連線授權撤銷及 OAuth popup 都是 **未完成的必要 gate**。不能只做入口驗證後永遠信任 session；不允許同 origin 的靜態 cache 洩漏前一使用者內容。
- 每使用者的 runtime container／volume／network 分離，無 host home／Docker socket／來源 DB／GMS write credential。Runtime 僅能接政策允許的 MCP／model 網路；檔案與 terminal 保留但不能抵達控制面的審批憑證。

已實作 MFE／identity／grants／gateway、`runtime-manager.mjs`、reverse transport、egress 與 `server.mjs`。容器使用 `network none`、UID 1000、唯讀 root、drop ALL caps、no-new-privileges、PID/CPU/memory limits；只掛自己的 HOME volume 和 host-owned 唯讀 IPC directory。runtime 主動連至 host Unix listener，host 不連向可被 runtime 置換的 socket pathname。Egress 僅接受 operator 核准的 HTTPS:443 destinations，IPv4 DNS 結果全檢查並以已檢查 IP 連線，拒絕 private/special/host IP；預設／restart 皆拒絕，政策移除關閉既有 tunnel。這是單一 gateway／scope 的本機部署，尚不支援多控制器共用同一 scope。

真 Federation＋gateway＋兩個 pi-web production containers＋Chromium 已驗 session、PTY、Files、4 MiB upload/download/readback、SW、跨使用者 terminal 拒絕及帳戶切換 heartbeat。正式 entrypoint 已接官方 `me` verifier，真 DataHub 無／錯 session 回 401；**成功 SSO、其他瀏覽器／離線生命週期、OAuth／clipboard／installed PWA/push、完整 parity、持久 Source/job 未完成，不能宣稱整體多使用者功能已交付。**

### 2.2 PWA 與不可變 browser assets

pi-web pages 不接受 Basic Auth；gateway 重用固定 upstream 的 `createWebSessionToken()`，只注入私有 pi-web cookie，仍剝除瀏覽器／DataHub cookie 與 Authorization。此私有 credential 不送到 browser。

Chromium 的 cross-site iframe service-worker script／worker navigation 可能不帶 partitioned cookie。因此從固定建置另匯出 **純靜態 HTML shell、`/_next/static/*`**；gateway 只公開這些 operator-owned bytes，以及固定 SW/offline/icons/manifest。不是匿名 proxy 到 runtime，不提供私人 SSR/RSC/API/檔案。`/` 只有無 agent cookie、非 RSC 的 static shell 路徑；有 cookie 的原頁面仍走上游授權。所有 `/api/*` 與使用者檔案仍需有效 grant。API 不可被 SW cache。

`next build --webpack` 使用一個 page worker；不修改 upstream baseline／lock hashes。匯出檔案須由 `scripts/check-agent-artifacts.mjs` 比對確切 runtime image 的全部 browser files、operator modules、package-lock；本輪 219 browser assets byte-hash 全符。這不等於正式 wildcard TLS／其他瀏覽器／PWA 獨立啟動驗收。詳細證據見 [runtime isolation](../verification/datahub-agent-runtime-isolation.md)。

目前 browser session／grant 是可撤銷記憶體狀態，restart 全失效。Ticket 30 秒；MFE 每 20 秒以當前 DataHub cookie 續期 90 秒 lease，失去 heartbeat 後最多 90 秒＋1 秒 sweep 撤銷；需要明示這個上限，不假稱 browser crash／無 heartbeat 時立即登出。

同 browser 的新 mount 必須同時提出既有 cookie 與新同 actor ticket 才能加入 session；Web Locks 序列化首次交換，避免競爭 Set-Cookie。每 mount 獨立 lease，最後一個才移除共用 cookie 的權限。Parent 另持有僅可撤銷的 proof，server 只保存其 hash（不是把 grantId 當權限，也不賦予讀取權限），cleanup 不需仍存在的 DataHub cookie；續期仍須 proof＋新驗證身分。驗證失敗／換帳號時撤銷該 browser session 全部 mounts；其他 browser session 不受影響。Proof 不放到 iframe／storage／runtime。依序／並行多分頁、登出與舊 cookie 401 已用真 Chromium／pi-web 容器驗證；詳見 [browser lifecycle](../verification/datahub-agent-browser-lifecycle.md)。

## 3. 專案如何納入與追蹤

```text
upstream/datahub/               # 現有官方固定版本，完全不改
extensions/datahub-agent/
  pi-web/                      # 完整受版本控制的 pi-web source、tests、lockfile
  mfe/                         # 只管 mount、iframe、cleanup、受限 bridge
  integration/                 # DataHub tools／授權／approval；有需要才分檔
  deploy/                      # 本專案獨立部署與憑證掛載
```

- 以完整 source snapshot 納入本 repo，記錄 upstream URL、commit、license；保留 MIT notice。不只複製 components，也保留 app、hooks、lib、public、bin、tests。
- 基準：pi-web `b1a72962d385db4a82b93ad5802e9024d5b44874`，package `0.9.0`；安裝前重新核對完整依賴鎖。
- 將 upstream 匯入、DataHub UI 修改、integration 新增分成可追蹤差異；不放 node_modules、build artifacts、私密設定或 session 進 Git。
- 這會形成需維護的 **pi-web downstream**，不是零維護皮膚；DataHub Core 仍無 fork／patch。
- 升級時更新固定 upstream baseline、處理本地 UI diff，重跑完整功能矩陣；禁止 UI 內一鍵更新繞過本專案版本鎖。

## 4. Layout：一個 DataHub 導覽，一個 Agent 工作區

### 預設畫面

```text
┌────────────────┬───────────────────────────────────────────────────┐
│ DataHub        │ Agent                      Workspace ▾   Settings │
│ 原有導覽       │ Chat   Agents   Tasks   Decisions                  │
│                ├───────────────────────────────────────────────────┤
│ Home           │ History ▾   ＋ New chat      目前對話      Details │
│ Documents      │                                                   │
│ …              │                對話／工具執行結果                 │
│ Agent ← 唯一   │                                                   │
│                │                                                   │
│                │  ┌─────────────────────────────────────────────┐  │
│                │  │ 輸入訊息、@檔案／資產、/skill、附件          │  │
│                │  │ Model ▾  Thinking ▾  Tools ▾       Send    │  │
│                │  └─────────────────────────────────────────────┘  │
└────────────────┴───────────────────────────────────────────────────┘
```

- **不再常駐第二個左側 sidebar**。原 SessionSidebar 改成 History／Workspace 開啟的抽屜；project、session search、rename、delete、branch 功能都保留。
- 預設讓 chat 佔滿 Agent 內容區；不是三欄擠滿資訊。
- header 只留 Agent 名稱、workspace、Settings，不重複 DataHub logo、帳戶、全域搜尋。
- `Chat / Agents / Tasks / Decisions` 是 Agent 頁面內 tabs，不新增 DataHub 左側入口。尚未實作的 Cloud 對等 tabs 不做成可點但無作用的假入口。
- composer 貼齊**工作區**底部，不覆蓋 DataHub 全頁；對話區單獨捲動。

### 開啟右側詳情時

```text
┌──────────────────────────────┬────────────────────────────┐
│ Chat                         │ Details                 ×  │
│                              │ Files | Data | Changes     │
│ messages / tool calls        │ Evidence | Terminal        │
│                              │                            │
│                              │ file preview / lineage /   │
│                              │ diff / approval / terminal │
│ composer                     │                            │
└──────────────────────────────┴────────────────────────────┘
```

- 沿用 pi-web 的 tabs、resize、file viewer 與 terminal state，不把 file viewer 刪掉改成 lineage。
- DataHub 的 Data／Changes／Evidence 是新增 panel content。
- 寬螢幕為可調整 split pane；較窄時為單一 overlay drawer，history 與 details 不同時遮住工作區。
- UI 呈現依嵌入容器可用寬度調整，不只依外層螢幕寬度；resize handle、Escape、focus return、鍵盤操作保留。

## 5. 視覺規格：以本地 DataHub 為準

設計模式：DataHub **Extension**；pi-web **UI overhaul，功能契約保留**。品牌一致性 10/10，視覺變化 1/10，動效 2/10，資訊密度 7/10。

已檢查本地 DataHub 歷史畫面與固定版本 source，採用其既有設計，不另創 AI 品牌：

| 項目 | 規則 |
| --- | --- |
| 字體 | DataHub Alchemy 的 Mulish；內文以 14px 為基準，程式碼保留 monospace |
| 主色 | DataHub themeV2 primary `#533FD1`；選取底色 `#ece9f8` |
| 背景／框線 | 白色 surface、`#ececec` 邊界；中性色依 DataHub color tokens |
| 圓角 | 外層遵循 DataHub MFE 容器，themeV2 navbar-redesign 為 12px；內層避免重複大卡片 |
| 控制項 | 與 DataHub 一致的 tabs、表格、狀態標籤、表單、按鈕、drawer；不保留 Pi 的黑色整頁外觀 |
| 間距 | 以現有 DataHub 頁面及控制項為基準校準，避免 iframe 再加一層巨大留白 |
| 動效 | 只用收合、loading 與必要狀態提示，尊重 reduced-motion |
| 品牌 | 不增加第二個 DataHub／Pi logo；About 保留 upstream attribution |

實作為 pi-web 自有的 DataHub theme token mapping + 必要 JSX layout 修改；不 runtime import DataHub 私有 React components／hooks，不抓外層 DOM class 或 computed style。

MFE host 目前 mount 傳入空 props，**不會自動傳 theme／user／entity context**。初版 host 與子 app 使用同一份部署 theme 設定；即時主題同步若無公開契約，不假裝已支援。Pi 的外觀設定仍保留，embedded theme 跟隨部署設定；standalone 可保留原本 theme 選項。

## 6. 功能全部保留：不是重新拼一個聊天框

| pi-web 模組 | 保留的行為 | 調整方式 |
| --- | --- | --- |
| AppShell | session 選取、tabs、URL state、panel state | 換 DataHub shell，sidebar 改 drawer |
| ChatWindow／ChatInput／ModelSelector | streaming、abort、steer、follow-up、slash、attachments、draft、model／thinking／tools | 換 token、密度與 toolbar，不改 prompt semantics |
| MessageView／MarkdownBody | Markdown、code、tool result、檔案連結 | DataHub typography／status style |
| SessionSidebar／BranchNavigator | session browse、search、fork、branch、rename、export、delete | History drawer／對話選單，不刪功能 |
| FileExplorer／FileViewer／TabBar／TerminalPanel | 上傳、preview、watch、引用、terminal | workspace／右側詳情；原 runtime 保留 |
| worktree modules | 建立、切換、移除與 dirty protection | Workspace menu／drawer |
| ModelsConfig | provider login／API key、model catalog、discover、test、save | Settings → Models，原 handlers 沿用 |
| SkillsConfig | list、scope、toggle、search、install、check、update | Settings → Skills，原 handlers 沿用 |
| AgentsConfig／PluginsConfig | profile、subagent 設定、package 管理、reload | Settings 中保留；Pi subagents 與 DataHub Registry 分開命名 |
| hooks／lib／app/api | AgentSession、SSE、reconnect、compaction、settings、session storage | 預設不重寫；只新增必要授權／隔離 adapter |
| 其他原功能 | 音效、語言、推播、PWA、export 等 | 納入完整 baseline 盤點，不因嵌入而靜默遺失 |

功能保留不代表把所有高權限操作開給所有 DataHub 使用者。停用／受限功能要顯示原因；不得僅隱藏按鈕卻讓 endpoint 仍可呼叫。

## 7. Settings：Models、Skills、MCP 均可在 Agent 內操作

點 Agent header 的 Settings，開啟工作區內設定頁；DataHub 左側選取仍是 Agent。

```text
Agent / Settings                                      Back to chat
General | Models | Skills | MCP | Agent profiles | Plugins
──────────────────────────────────────────────────────────────────
資源清單／搜尋             │ 選定資源詳情／編輯／測試
                           │ Scope / Status / Permissions
                           │                            Save
```

### Models 與 Skills

完整沿用 pi-web 現有能力與 API；不改成只讀清單。Provider credentials 只進 server secret storage，不回傳明文。Project／global scope 在本專案獨立執行環境內保留，不指向開發者 `~/.pi/agent`。

### MCP：新增，而非宣稱上游已有

當前檢查的 pi-web 沒有獨立 MCP server editor；Plugins 設定不等於 MCP 設定。

新增 MCP tab：

- Server list、connection state、enable／disable、連線測試／重新連線。
- 支援選定 bridge 實際提供的 transport：stdio command/args/env secret references，或 HTTP URL/auth；OAuth 若 bridge 支援則提供 login/logout。
- Tools 清單、input schema、read/write hints、per-agent 啟用範圍與 approval policy。
- 新增／修改／刪除配置、scope、儲存後 reload 提示與失敗 diagnostics。
- 不 hardcode DataHub tool names 作唯一能力；依 server `tools/list` 發現，再由 server-side policy 過濾。DataHub MCP 是第一個配置，不是特例 runtime。

MCP client bridge 作 Pi extension 接入既有 runtime。實作前先選定並審查固定版本，不能直接複用此開發機的全域 MCP 設定或擅自安裝任意 extension。新增 stdio command、任意 URL、外掛安裝是管理權限，需防止任意程序執行／SSRF／憑證洩露。

## 8. 必要整合，不以「只改 UI」省略安全

- **Identity**：獨立 app 不會繼承 DataHub cookie 便自動成為相同使用者。採共同 IdP／受信 gateway 驗證後映射 identity；postMessage 的 userId 不算登入證據。若本地無共同 SSO，須先完成 auth spike，不能宣稱已無縫登入。
- **隔離**：專案專用 Pi agent directory、workspace、credentials、session store；多使用者需獨立 runtime／OS 級資源隔離，不能只依 cwd 或 tool preset。禁止掛載開發者 home、Docker socket、其他專案資料。
- **權限**：Models credentials／Skill install／Plugin install／MCP command／terminal／filesystem／worktree 均要 backend 授權。保留操作能力，但 scope 由平台決定。
- **受控寫入**：一般 Agent runtime 不持有可以繞過 approval 的 GMS write credential；write executor 在另一信任區，只有批准精確 proposal revision、actor、scope、有效期限後才能執行。Terminal／自製 CLI 也不得繞過。
- **可信操作介面**：pi-web 具有 terminal／plugins，不能把其 runtime origin 當可信人工核准頁。Ingestion secret 與 approval 表單放在同一 Agent 工作頁中的可信 MFE parent／控制面 origin，仍維持單一入口、DataHub 視覺。Runtime browser grant 僅可用於自己的 app，不具核准／來源 secret 權限；這些操作重新驗 DataHub session、可信 Origin 和精確 revision。不能以隱藏按鈕或 iframe postMessage 的 userId/isApproved 代替。
- **網路實測**：Docker internal bridge 或不同 cwd 本身不是「不能接 host 服務」證據。部署前必須驗證 runtime 不可直達 source／GMS／Docker socket；若需另設 network-none＋受控傳輸／egress，先以隔離 probes 證明且記錄實際成本，不擅改其他專案的 host firewall。
- **DataHub tools**：官方 MCP 用於已驗證的 metadata tools；DataFlow／DataJob／lineage publishing 若不在其 tool list，透過第一方 SDK／CLI tool 補上，不臆測 mutation mode 包含它們。
- **Bridge**：postMessage 只交換有 schema／origin／source 驗證的 ready、導航、context 等資料；不傳 PAT、不執行任意 JS／command。SSO 與執行授權不靠這條 bridge。
- **Lineage**：宣告依賴與觀測執行證據分開；讀 metadata 不等於讀業務 table。不把這類工具使用自動寫成 ETL lineage。

## 9. UI 嵌入的實際契約

DataHub 目前 `useDynamicRoutes()` 對每個 YAML path 加 `/mfe` 且 `exact`。因此配置 `path: /agent` 的入口是 **`/mfe/agent`**，不是任意 `/datahub-agent/*` 都能直接進入。

第一版只註冊這一個 path；settings、session、registry、tasks 在子 app 內路由。分享連結可用外層 query 保存經驗證的 session／view ID，再由薄 adapter 還原，不新增 host 子路由或改 Core router。

iframe 內保留 pi-web root-relative API，避免對所有 fetch 重寫 prefix。若後續選同源 subpath，必須另驗證 basePath、static assets、SSE、OAuth callback、service-worker scope；不能只做 reverse-proxy URL rewrite 就宣稱完成。

## 10. 實作與驗收順序

1. **完整 upstream baseline**：納入固定 source，盤點全部 routes／features／tests；在隔離環境驗證原版功能。此時不做 DataHub 寫入。
2. **嵌入技術 spike**：單一 MFE 入口、iframe、auth、SSE、terminal、OAuth／browser capabilities、cleanup／恢復。阻礙先處理，不以砍功能解決。
3. **DataHub UI v0**：先展示 chat、History drawer、Details、Settings 的一致風格 mockup；確認後才全量換皮。無假完成狀態。
4. **完整換皮與 MCP settings**：保留上游功能，新增 MCP tab／bridge；逐項 baseline 對照。
5. **DataHub 業務整合**：discovery → proposal → approval → SDK/CLI write → readback；Registry／Tasks／Decisions 分增量加入。
6. **交付 gate**：功能 parity、keyboard／IME／a11y、responsive、兩套 UI 視覺一致性、auth／跨使用者隔離、approval bypass、升級／回滾，全部對精確版本驗證。

跨來源 iframe 與多使用者高權限 runtime 是主要技術風險；本方案不是已驗證部署。source 實作不等於部署授權；live ingestion、來源 DB／GMS 寫入與使用中服务切換另行確認。

## 11. 客製 Ingestion：Skill → Datasource MCP → Worker

### 分工與整合點

```text
Agent chat + Sources 視圖／右側 Data Source 面板
  → ingestion skill（引導選來源、補設定、解釋結果）
  → Datasource MCP（結構化工具、權限與工作提交）
  → ingestion worker（固定版本官方／第一方 custom source）
  → 官方 SDK／Emitter → DataHub GMS
```

- Skill 是操作指引，不能授予權限、批准寫入或直接持有 credentials。
- Datasource MCP 是 ingestion 控制面，不等同讀 catalog 的 DataHub MCP；先共用 integration backend，不為每個工具拆服務。
- 官方 source 重用 recipe／connector；第一方 custom source 固定版本安裝在 worker。原生 UI-based ingestion 不支援 custom source，不修改 Core Create Source。
- connector 程式必須先經部署審查；模型不能提供 import path／shell／pip install 指令讓 backend 動態執行。
- 資料來源的 metadata ingestion 與實際 SQL 查詢／關係驗證分開；開啟 profiling／query usage 需另有來源讀取範圍核准。

### 唯一入口內的 UI

Agent 頁面內新增 Sources 視圖，不新增 DataHub 左側導覽。來源列表顯示 connector、設定版本、scope、最近 run、warnings；選取後開右側面板：

```text
Configure → Test connection → Preview → Approve & Run → Run details
```

- Configure：connector schema 驅動的共用欄位驗證，特殊 connector 可提供專用 section；不建立完整萬用表單框架。
- Secret：透過管理表單直接送 secret store，chat／模型／logs 只見 opaque binding ID。password、token、帶密碼 URI／options 不可放一般 config。
- Preview：區分本地設定預覽、來源 discovery 與預計 metadata changes；預覽也可能讀來源，需先授權，未知差異必須標明。
- Approve：明列 source scope、connector／config／secret-binding revision、增加／更新／刪除影響；改動任一核准依據都需重新確認。
- Run：持久 job ID、階段、events／物件計数、warning、redacted logs、取消、結果連結。離開 chat／刷新／SSE 斷線不失去工作；支援回復查詢。
- Metadata 讀取、連線成功、JSON Schema 合法、SDK config 合法、實際 ingestion、GMS readback 是不同證據，不共用一個 PASS。

### 建議工具契約（自製，不冒稱官方現成工具）

| 工具 | 作用／安全邊界 |
| --- | --- |
| list_connectors | 只列部署批准 catalog，不掃描／載入任意 plugin |
| get_connector_schema | 回傳 schema、版本／fingerprint、能力與限制 |
| validate_source_config | schema 與 SDK validators 分階段；不代表可連線／已核准 |
| test_source_connection | worker 解析 secret、驗證來源 ACL／timeout；會讀來源 |
| preview_ingestion | 明確標記 scope、as_of、差異完整性與未能判定部分 |
| submit_ingestion | exact proposal approval + idempotency，caller 不能指定任意 sink/token/import path |
| get_ingestion_run | 綁定 actor／tenant／source 的 status 與 redacted evidence |
| cancel_ingestion | 取消請求與實際停止分開；保留已寫入範圍，不宣稱回滾 |

### 持久化與發布契約

- 此處舊 Extension DB／outbox 必建建議已撤回。先實測 DataHub 原生 Source／Secret／ingestion／執行紀錄；客製資料沿用官方 datamodel 或支援的 Aspect 擴充。不新增 datastore，也不把 secret 寫入一般 Aspect。必要版本／授權／並發語意若無法由公開能力保證，提出具體缺口由使用者决定，不自行另建儲存層。
- DataHub source ID、entity URN 與 run ID 分開，名稱大小寫／environment／platform instance 對齊現有 ingestion，不從 chat 猜 URN。
- 核准 scope 不由 LLM 自稱；HTTP／MCP／CLI 共用 policy。write credential 僅在受控 worker，terminal 不可繞過。
- `QUEUED → RUNNING → SUCCEEDED / FAILED / CANCELLED / INDETERMINATE`；取消與失敗可能伴隨已發布 metadata，另記 partial effects。
- job completion 不等於所有 metadata 完成索引；記錄 emitter acknowledgment、讀回結果與尚待對帳部分。
- 外部 timeout 不盲目重跑；先以 idempotency／attempt／receipt 對帳。移除 metadata、stateful deletion 與來源範圍縮減不得默認啟用。
- 排程新增／變更需獨立核准且有持久 scope grant；到期／失效停止，不能用一次 approve 代表永久任意寫入。

### 第一個實作切片（離線）

先提供部署信任 catalog 的 schema／fingerprint／JSON Schema config validation，讓 UI 和後續 MCP 能用同一契約；使用既有 jsonschema library，不自行實作 SQL／connector validator。不執行 connector create／Pydantic custom validators，不讀 secret、不接來源、不發 GMS request。

限制：此切片是 trusted backend library／離線診斷，不是已暴露的 MCP 或 Web API；schema 合法不代表 SDK 全部驗證通過。正式 UI 還須 secret-binding 表單、schema 裁剪／敏感欄位政策、actor ACL 與 request limits，不能直接對外暴露任意 raw config。

## 12. 來源與目前證據

- DataHub `e99431ec510d7a2001f815c6bf70913c493af76e`／tag `v1.7.0.1`，本輪 git 核對。
- `upstream/datahub/datahub-web-react/src/conf/theme/themeV2.ts`：primary／surface／border／radius。
- `upstream/datahub/datahub-web-react/src/alchemy-components/theme/foundations/typography.ts`：Mulish、14px、weights。
- `upstream/datahub/datahub-web-react/src/app/mfeframework/{README-MFE.md,mfeConfigLoader.tsx,MFEConfigurableContainer.tsx}`：route、mount、props、remote contract。
- 本地先前 `/tmp/datahub-home.png`：導覽與視覺參考，非本輪 live 瀏覽器驗收。
- pi-web 固定 commit 的 README／LICENSE／package.json／next.config.ts／AppShell／SettingsPanel／ModelsConfig／SkillsConfig／PluginsConfig：完整 app、功能、設定與 service-worker path 證據。
- 前期來源研究：`datahub-agent-pi-web-mfe-integration.md`。其抽取與重寫建議已由本方案取代；未驗證的 Core Registry UI 支援仍不宣稱可用。

# A08：重用 MCP adapter 的設定入口

2026-09-11，主代理實作／安全自查，非獨立審查。**已經使用者核准切換線上 Agent，使用者從真 DataHub 確認 MCP 設定頁與 ChatGPT 登入成功；A08 的實際 MCP server 呼叫及 A01–A15 整體仍未完成。**

## 已實作

- 固定未修改的 `pi-mcp-adapter@2.33.0`（MIT），peer 支援固定 Pi SDK `0.85.1`；不重寫 MCP client、transport、discovery 或工具執行。
- Native Settings 新增 MCP：直接編輯 adapter 的 `mcpServers` JSON，保留原生 options。寫入每使用者 runtime 的 Pi-global `mcp.json`，不複製開發機設定／憑證；project config 仍可依 adapter 原生規則覆寫。
- GET/PUT 沿 native API 身分／Origin 防護，固定 server-owned 路徑、1 MiB 限制、no-store、0600 atomic write、SHA-256 revision 衝突拒絕。缺檔預設關閉 host-config discovery；損壞檔案 fail closed，不自動覆蓋。錯誤不回顯輸入。
- 同一 runtime API 的同步保存可序列化；不宣稱與 terminal／外部 editor 有跨程序 CAS。這不是可信 Sources、ingestion-secret 或人工 approval 控制面。
- Main session／允許 extensions 的 native subagent profile 沿既有 `additionalExtensionPaths` 載入固定 adapter；chat-only 不載入。此為原功能接線，沒有派遣子代理。
- Save 不宣稱測試連線；Reload current session 使用原生 reload，沒有自建 MCP reload／管理服務。Network-none／default-deny egress 不變。

## Source／build

- Original 506-file upstream lock 不變。更新獨立 downstream patch/manifest；516 個 current files，反向重建 506 檔及原 foundation checks 通過。舊 manifest/patch 和首次 candidate receipts 保留在 `.local/evidence/agent-mcp/`。
- 使用者已取消 RAM/swap/disk headroom 前置門檻；沒有將舊 checker 改報 READY。仍使用本案專用 `ekop-datahub-agent-limited` builder、isolated HOME/project flock。
- BuildKit `v0.33.0`：`moby/buildkit@sha256:6c2fa84a6b61ccd72899dde4239f8d5717f05f9a8ca6f3cad185fb1a95a94de3`。實際 cgroup：memory.max=3221225472、memory.swap.max=0、cpu.max=`100000 100000`；serial solver、restart=no。建置後已停止，未 prune cache／改 WSL／動其他服務。成功建置不等於舊 hang 根因已修復。
- 隔離 `next build --webpack` 成功；既有 session-export dynamic-dependency warning 保留。未在開發 checkout 做 Next build。
- 最終 image：`sha256:57556f836d4ea1065282fa8309d502f4ff735dca58aa69e5ec68fefbafef64dc`；222 browser assets、operator modules、package lock exact-image gate PASS。

## 實際驗證與失敗保留

- 設定 store/API 的 malformed/size/private-mode/revision/redaction checks、Settings 回歸與 TypeScript check 通過。
- 首次 image suite：953/979，26 fail，非 OOM。21 個舊 source assertions 依賴排版；只修 9 個 tests 的 whitespace/quotes/trailing-comma/block extraction，未改產品行為。另 4 個 plugin-update cases 被測試環境 PI_OFFLINE 阻擋，1 個 theme fixture 誤用 embedded flag；恢復原測試環境，仍 network-none。原失敗 logs 保留。
- 最終 exact-image suite：**979/979，0 fail，0 skipped**；1 CPU/1536 MiB、network-none/read-only/fresh HOME。Embedded 分支另有既有明示雙模式測試及真 browser 檢查。
- 同一 image 內真 SDK＋未修改 adapter＋真 MCP SDK stdio fixture：load/discovery/echo call/reload/disable PASS，無模型／DataHub／OAuth 呼叫。
- 真 production Pi、兩個全新隔離容器、Chromium 153：Settings → MCP → invalid JSON → save/readback → stale revision 409 → real session reload PASS；Bob 看不到 Alice config。三尺寸／drawer/focus、PTY、Files 4 MiB 往返、SW、多分頁、換帳號／logout 舊 cookie 401 亦 PASS。DataHub identity 為 fixture，沒有把此結果當成新版真 SSO 或遠端 MCP 驗收。測試容器／fixture HOME 已清，正式 HOME 未動。
- `rpc-manager.ts`/`subagent-runtime.ts` 的 chained-assertion 告警為固定 upstream 既有內容：移除本輪 6/3 行 loader 接線後，其他 bytes 與原 lock 完全相符（`rpc-baseline-check.json`）。Primary LSP 0；一次 scoped lens cache 回報無 issues，但 turn-end 仍重報舊警告。保留此不一致，不修改既有型別斷言來清工具告警，也不稱全案無警告。

重跑：`tests/check_agent_mcp_adapter.mjs`（fresh HOME/PI_CODING_AGENT_DIR、PI_OFFLINE=1）、`tests/check_agent_pi_web_browser.mjs`（exact image/assets，`AGENT_EXPECT_DATAHUB_SKIN=1 AGENT_EXPECT_MCP_SETTINGS=1`）。後者建立並清理自己的 fixture containers/volumes，不對正式 scope 執行。

主要 receipts：`.local/evidence/agent-mcp/{downstream-final.log,builder-limits.json,build-final.log,artifact-check-final.json,image-tests.log,image-tests-final.log,image-sdk.log,browser.log,browser/skin-mcp.png}`。

## 正式切換及 ChatGPT 登入修復

- 使用者核准切換，僅重啟 Agent gateway/runtime，保留原 HOME volume，DataHub frontend/GMS/DB 容器 ID 不變。新版 MFE/shell bytes 讀回一致、未登入 bootstrap 401；使用者確認真 DataHub 的 MCP 設定頁。
- 使用者隨後回報 ChatGPT 登入 `fetch failed`。真 runtime 的無憑證 HEAD 同樣失敗，CONNECT `auth.openai.com:443` 明確由本案 proxy 回 403；原因是 server entrypoint 尚未接上既有 per-actor egress policy，不是從 OpenAI 收到帳密拒絕。
- 使用者另外明確核准：僅目前帳號的 `https://auth.openai.com`／`https://chatgpt.com`，供登入/refresh/模型請求。新增 operator-only `egressOriginsByActor` 設定接既有 `setAllowedOrigins`，重用原 destination validation，不重寫登入/adapter、不開全網、不更換映像。
- 新設定在 Docker/listener/identity 副作用前驗證；只依官方 me 衍生的 actor key 查表，其餘 actor 預設空清單。7 server/transport checks PASS。3檔 LSP 回報舊 EOF 語法位置，當前 Node syntax check 與 TypeScript parser 都為 0；保存 `egress-source-parse.json`，不修改正確 source 迎合 stale diagnostics。
- 再次核准重啟後，使用者確認 **ChatGPT 登入成功**。實際 runtime 保持 exact candidate image、network-none、UID1000、readonly root、1CPU/1GiB/no-extra-swap、原 HOME；adapter version/path 正確。未批准 `example.com` 及 metadata IP 的 CONNECT 仍 403。
- Receipts：`rollout.json`、`egress-rollout.json`、`model-egress-red.log`、`model-proxy-denial.log`、`egress-wiring-tests.log`、`model-egress-final.log`。未讀 OAuth credentials/token、未代做模型推論；登入成功不等於模型推論或 DataHub MCP 驗收。

## 後續

配置並驗證實際 MCP endpoint；其他 remote MCP 的 transport/auth/OAuth/egress 仍待驗，DataHub UI/GMS URL 本身不是 MCP endpoint。來源／寫入／核准必須走既定可信 backend。接續 A09–A15 Sources／worker／approval／readback／Registry／schedule，不擴建 MCP 框架。

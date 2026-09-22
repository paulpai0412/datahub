# A05 正式 MFE 接線準備與 E2E 關卡

2026-09-11，主代理實作／自查，非獨立審查。**已啟用 MFE，使用者手動登入並確認進入 Pi 工作區；未讀登入帳密，整體 A01–A15 尚未完成。**

## 真入口結果（最新）

- 使用者取消 RAM／swap／磁碟餘裕前置門檻；保留 CPU／memory／network／身分與權限限制。舊 preflight 記錄不再阻擋本次測試，不代表 hang 根因已修復。
- 選用 `3374d158…` image/assets/operator gate 通過。啟動 `.local/agent-server.json`／9041，僅以 pinned image 重建 frontend；比對其餘 DataHub 容器 ID 未變，GMS／DB 沒有重啟。
- 真瀏覽器發現兩個原先 fixture 未覆蓋的問題：官方已部署 Federation unwrap 取 ES module 的 `default`，原具名 mount 因此未執行；補 `export default mount`。接著 bootstrap 401：官方 `AuthUtils.hasValidSessionCookie` 要求 signed `PLAY_SESSION` 與 `actor` companion 相符；現在只把這一對送回固定 frontend，身分仍只取官方 `me`，不把 actor cookie 當授權。
- 保留 `default-export-red.log`／green、`cookie-pair-red.log`／green、`manual-browser.log`。MFE Webpack build 成功（313 ms），served chunk byte-match。兩次修正僅重載 Agent gateway，沒有重建 Pi image 或修改 Core。
- 使用者回覆「已進入工作區」；真 actor runtime `f1aed4633733` running、固定 skin image、network-none、UID1000、唯讀 root/IPC、1CPU/1GiB/no-extra-swap（`live-runtime-safety.json`）。這是首次真登入工作區確認，不代替完整 native API／多分頁／登出／模型／MCP／Sources 驗收。
- A08 現在直接重用 MCP adapter；新的 MCP 設定程式不在這個歷史 skin image 中，需新 candidate 建置與驗收。

## 本輪完成

- `extensions/datahub-agent/deploy/mfe.config.yaml`：官方 MFE config，只有一個 Agent，`subNavigationMode=false`、path `/agent` → `/mfe/agent`，remote 指向 `http://localhost:9041/mfe/remoteEntry.js`，module `datahubAgentMFE/mount`。只含公開設定。
- `deploy/compose.agent.yaml`：opt-in overlay，只新增 frontend 的 `MFE_CONFIG_FILE_PATH` 及一個 read-only config mount；不改 Core，不加 build/dependencies/ports，不自動加入 `compose.sh`。
- `agent-server.example.json`：既有已驗證 skin image `3374d158…` 的本機設定範例，localhost 9002/9041、tenant `ekop-datahub`、每-user 1 CPU/1024 MiB、最多 2 runtimes。**必須核准後複製到 `.local/agent-server.json`**；assets path 相對於 `.local/`，不能直接從 deploy 目錄執行範例。此 image 是歷史已驗證版本，不代表目前有差異的 source 已驗收。
- `tests/test_agent_mfe_config.mjs`：提取並執行固定 Core 原始碼中的 `loadMFEConfigFromYAML`／validator、`getMfeMenuItems`、`useDynamicRoutes` 真實函式 body。4 tests PASS，包含單一導覽/route、缺 module 拒絕、hidden nav、overlay 最小範圍及 gateway origin 對齊。
  - React/icon/hook 是明示 fixture；YAML 使用本案現有 js-yaml，並非啟動 Core dependency tree。因此不是 live DataHub／Federation／SSO 證據。
  - 初次 harness 錯用 js-yaml `index.js`，保留 module-not-found log；改用標準 `createRequire` 尊重 installed package exports，沒有安裝依賴或修改產品遷就。

## 來源差異的進展

- 保留先前 10-file drift，不覆寫來源、不改原 upstream lock 或 downstream lock。
- TypeScript emit／AST 比對僅為定位工具。首輪 AST 還包含 SourceFile 的全文，因此補排除位置/全文的 normalized pass；該 pass 顯示 layout/useTheme/DataHubEmbed/MobilePwaLayout 的 emitted AST 相同，其他仍有 parentheses／JSX text segmentation 等差異；未把這些比對當成全語意／瀏覽器等價證明。
- CSS 已讀前後全文；可見重排、selector 換行、`.16`→`0.16`、`.12`→`0.12`。尚未重新建置或以新 image 驗收。
- 實際針對 drift 跑最小受影響 tests，得到 **14/16**：scroll-position 與 viewport source assertions 被換行／trailing comma／parentheses 破壞。
- 修改 `AppShell.workspace-memory.test.mjs` 與 `MobilePwaLayout.test.mjs` 的 assertion，接受這些排版，仍要求相同 Map key、session ID、null fallback 與 header 高度。加入 wrong key／wrong session ID／wrong height 的字串負例，未刪原邏輯檢查或改產品來遷就。
- 同樣三個檔案重跑 **16/16 PASS**，fresh HOME、sequential、Node heap 256 MiB；沒有模型、Docker 或來源 DB。這不是重跑所有 977 tests，亦未解除 exact-source/image gate。

## 為何只需要重建 frontend 容器

固定 Core 的 `MfeConfigController.java` 從 `MFE_CONFIG_FILE_PATH` 讀取檔案，**啟動時讀一次並 cache**，`GET /mfe/config` 受 Authenticator 保護，response 可 private cache 300 秒。
因此第一次加 env/mount 必須重新建立 frontend 容器；使用同一個固定映像，不需要重新編譯 Core 或 Pi，不需要碰 GMS／DB。只修改掛載檔案而不重啟也不能假設立即生效。

## 首次啟用安排（已執行）

1. 使用者已取消資源餘裕門檻，未修改 WSL/Windows 或清理磁碟；仍保留執行資源上限，不使用 unbounded builder。
2. 完成 source drift 的完整 review／明確記錄新 downstream delta，並對選用版本檢查 exact image/assets/operator。不能用新 hash 假裝舊 source，也不能因既有 image 可用就宣布新來源通過。
3. 使用者本輪已明確核准：**資源／選用版本關卡通過後，只重建 frontend，並由使用者手動登入驗收**。此授權不包含讀 `.local/user.props`、代填帳密、修改 Windows/WSL 或清理磁碟；不需再反覆詢問同一部署／登入安排。
4. 確認只啟動一個 scope controller，既有同 scope container/volume 要先人工核對，不能 adopt 或清除正式 HOME。
5. 已建立 `.local/agent-server.json` 並啟動 `server.mjs`；目前 gateway PID 記在 `.local/evidence/agent-mfe-preparation/gateway-live.pid`。

## 核准後的 frontend-only 操作模板

**下列命令已用於首次啟用，不需為 MCP 設定重複重建 frontend。** `compose.sh` 正常使用本案部署 env；不要輸出完整 compose config（可能含 credentials）。部署前僅核對所選 frontend image/mount/environment *名稱* 等非機密欄位；保留 rollback 設定。

```bash
# Repo root；經核准、所選版本核對通過、gateway 已就緒後。
# 額外 overlay 是 opt-in；不要省略 --no-deps / --no-build / --pull never。
scripts/compose.sh -f deploy/compose.agent.yaml up -d \
  --no-deps --no-build --pull never frontend-quickstart
```

登入請使用 **`http://localhost:9002`**，不是 `127.0.0.1`；目前 gateway 的 exact Origin policy 固定前者，不為了相容另一個 host 放寬授權邊界。

設定撤回時同樣只核准重建 frontend：省略 `compose.agent.yaml`，使用原 pinned files 並 `--force-recreate --no-deps --no-build --pull never frontend-quickstart`。不做 `down`、volume prune 或刪 HOME；也不把 service recreation 稱成 metadata rollback。新舊配置的 browser cache／既有已掛載頁面需納入驗收，不能只改 YAML 宣稱撤銷完成。

## 真端到端驗收次序

- DataHub 登入 → 官方 `me` → 左側唯一 Agent → 官方 `/mfe/config` → Federation mount → gateway bootstrap → per-actor origin → native Pi authenticated API。
- 真 MFE 掛載/卸載、navigation/back、同 actor 多頁、logout/identity loss 舊 API 401；成功 SSO 與先前 synthetic identity 的證據分開。
- 再完成 A07 所有 native 功能／IME/a11y/PWA，並把 Sources/ingestion-secret/approval 留可信 parent control plane。
- A08–A13：MCP settings → source revision/secret binding → test/preview → exact human approval → worker → GMS readback → failure/cancel/reconcile。不是只有 UI 或 SQL/schema 通過。
- A14 Registry/Task/Decision/schedule，A15 安全自查＋upgrade/backup/rollback。
- Model live 需新設定頁完成後使用者自行配置，未配置前不代用 developer credentials。

本輪 evidence：`.local/evidence/agent-mfe-preparation/`。部署／成功 SSO／model／ingestion 的必要 evidence 缺少即維持未完成。

# A07 — 第一版真 pi-web DataHub skin

2026-09-11；主代理實作／自查，非獨立審查。使用者「OK，繼續實作」批准從 A06 候選進入正式 downstream；A01–A15 整體仍未完成。

## 變更與不變項

- `NEXT_PUBLIC_DATAHUB_EMBED=true` 僅控制呈現，不是授權。Production runtime Docker stage 啟用；standalone 預設保留原 UI／主題偏好。
- 沿用原 AppShell、SessionSidebar、ChatWindow、SettingsPanel 與 handlers，新增 Agent header、History/Workspace drawer、Details 標籤及 DataHub scoped tokens/Mulish。關閉 drawer 設 inert、Escape 與焦點返回；不用 modal dialog 包住原 sidebar，以免阻擋掛到 body 的 DirectoryPicker 等 portals。
- Embedded 固定 light，不覆寫 standalone 儲存的主題。新對話 welcome 沿用原 chat/composer；Settings 沿用 General/Models/Skills/Sub-agents/Plugins。Native session/draft/worktree/PTY/files/API 未另寫 backend。
- Settings **仍在 runtime origin**，不是可信 ingestion-secret/approval 控制面；不得把這個頁面當成 A08/A09/A12 完成，也未請使用者輸入憑證。
- 原 506-file lock 不變。`pi-web-downstream.patch` 及獨立 lock 記錄 9 個修改檔＋5 個新增檔，current inventory 511；新增含兩個 Mulish 字型及 OFL。沒有改 baseline hash 掩蓋變更。
- `scripts/check-agent-downstream.py` 驗 current bytes/modes、Git-visible inventory 與 patch hash，於 tempfile 反向 apply，再執行未改動的 foundation tests，確認原 506 檔 Git blob/SHA/mode 與完整 file set。禁止 Python `-O`；不改實際 checkout。此時直接對 downstream 跑原 import-stage snapshot check 會失敗，應使用此 wrapper。

## 必要 gates 與證據

證據目錄：`.local/evidence/agent-skin/`，最終來源／log hashes 見 `source-state.json`。

- **Build／typecheck**：`runtime-build-final.log`，`next build --webpack`、單 page worker 通過；沒有在開發 checkout 執行 Next build。
- **Current candidate**：`ekop-datahub-agent-pi-web:skin`，`sha256:3374d1581eaed39c69feecf57f8b8a1822397a1150c6eb2a8db85abc7420846e`。沒有替換舊 `:runtime` tag 或常駐部署。
- **Artifact exactness**：`artifact-check-final.json`，221 browser assets＋operator modules＋package lock 對 image PASS。`browser-assets-final/` 是對應 export，不混用舊 image 的 219 assets。
- **Native tests**：`upstream-tests-final.log`，977/977、0 skipped；全新隔離容器、network-none、cap-drop/NNP、2 CPU/1536 MiB，測試 env 使用 standalone false，新增 theme 子程序與 workspace callback matrix 同時驗 embedded false/true。
- **初次失敗保留**：`upstream-tests.log` 971/975。VM callback harness 缺新 `DATAHUB_EMBED` binding（含父測試失敗計數），另一 source assertion 未涵蓋 embedded header 高度；補 context 並擴增兩模式 draft restoration，不刪原檢查／不遷就測試改錯 runtime。
- **Baseline/provenance/catalog**：`downstream-final.log`，511 current files＋反向 patch＋原 3 組 foundation tests PASS，包含真官方 MSSQL schema，沒有 source execution。`tests/check_agent_downstream_negative.py` 的 corrupted patch/source 以及 CLI `-O` 拒絕另留 negative logs，未修改 checkout 做負例。
- **Browser／功能**：`browser-final.log`，Chromium 153.0.8010.12、真 production Pi＋兩個隔離容器＋真 MFE/gateway；identity/session data 明示 synthetic。1440/768/390 × 900：header/theme、History/Workspace/Escape/actual-opener focus、composer 底部、General/Models 實際頁面，並驗 PTY、Files、4 MiB download/upload/readback、SW、跨 actor terminal 拒絕、同 actor sibling 關閉後 API/PTY 存活、logout/account-switch 後 old-cookie 401。没有模型呼叫。
- **視覺自查**：`skin-chat-{1440,768,390}.png`、`skin-models.png`、`real-pi-web-terminal.png`。主代理讀代表性 desktop/mobile/settings screenshot；沒有把 Core sidebar reference 重畫進 runtime。
- **高度 fixture 修正**：原 synthetic host body 沒有 definite height，MFE `height:100%` 落在 560px minimum；`host-height-proof.log` 以 standards-mode 隔離 Chromium 確認 560→900。首次 mini fixture 漏 DOCTYPE，quirks mode 得到 900≠560；保留 `host-height-proof-incomplete-fixture.log`，補齊與真 host 相同 DOCTYPE 後才取得此證據（不是 product red）。只修測試宿主 body height，沒改 product CSS 遷就。最終 real-Pi 測試另 assert iframe 900px 與 composer 位置。後續驗證 shell 使用 fail-fast，不能因同一 shell 的後段成功而忽略前段 probe 失敗。
- **Infrastructure failure，非產品 red**：`browser-height-attempt-infrastructure.log` 原始失敗被 finally Docker cleanup error 遮住，不能判為高度 assertion 或確證 timeout。核對 `height-attempt-owned-container.txt`：scope `pi-test-ab33958c89cb` 的一個 Created/PID0 容器及唯一 HOME volume，image/owner/scope 均匹配後只移除這兩個自有資源。確認 scope 空才以新 scope 重跑；未重試模糊 create、未修改 manager 或延長 timeout。測試補安全 primary-error 記錄，最終正常 cleanup PASS。
- **診斷**：變更 TS/TSX primary LSP 與後續 6-file batch 均 0；Webpack typecheck／真 browser 是主要機械證據。最後 4-file primary batch 為 3 clean、CSS timeout/unconfirmed；CSS 另由 PostCSS、Webpack 與真 browser 驗證，不宣稱 CSS LSP clean。Lens session 76 files 無 error，cache-only 不等全案掃描；獨立 review 依 main-only 指示不適用。

## 重跑

```bash
.venv/bin/python scripts/check-agent-downstream.py
# Build/export/artifact commands 見 extension README；使用新的空 export 目錄。
# 以下 HOME 必須為新建空目錄，不帶開發機設定。
env -i PATH="$PATH" HOME="$NEW_EMPTY_HOME" \
  PLAYWRIGHT_BROWSERS_PATH=/home/timmypai/.cache/ms-playwright \
  AGENT_RUNTIME_IMAGE="$EXACT_IMAGE_ID" \
  AGENT_BROWSER_ASSETS="$EXACT_ASSETS_DIRECTORY" \
  AGENT_BROWSER_EVIDENCE="$NEW_EVIDENCE_DIRECTORY" \
  AGENT_EXPECT_DATAHUB_SKIN=1 node tests/check_agent_pi_web_browser.mjs
```

`.local/evidence/agent-skin/upstream-baseline/` 現為暫存 Git staging workspace：index 保留原 506 檔，working tree 是 downstream；不要再將 working tree 當原始備份。可交付來源以原 lock＋downstream patch/lock 驗證，不依賴此暫存目錄。

## 尚未驗收／下一步

成功真 DataHub SSO／正式 MFE 註冊與導覽、完整 upstream live parity、IME/完整鍵盤與 touch/a11y、新對話／worktree 等逐項 UI、PWA icon/manifest 品牌、OAuth/clipboard/installed-PWA/push/其他瀏覽器與離線生命週期仍待完成。Native API key 編輯未測、未填 credential；沒有 model live、DB/GMS writes、MCP bridge、Sources/worker/approval/Registry/排程驗收。

本輪無 DataHub Core 修改、新依賴、其他服務操作、child/goal、commit/push。最終測試 scope 容器/fixture volumes 已移除；9141 loopback 唯讀 v0 preview 仍是原預覽，不是新 Agent server。A04/A05/A07–A15 保持進行中／待辦，不結案。

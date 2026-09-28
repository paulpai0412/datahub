# Full history 認證錯誤 — 2026-09-28

狀態：**使用者核准後，已部署 9041，真正 Full history 按鈕驗證通過**。

## 真實重現與根因

在正式 `/mfe/agent` 使用既有已保存 session：相同 export URL 在已認證的
Actor iframe 內 fetch 得到 HTTP 200、HTML 498,514 bytes；點擊 Full history
直接開新分頁，卻得到 `{"error":"authentication_required"}`。

`AppShell.handleViewFullHistory` 原先對 `/api/sessions/:id/export?inline=1`
執行 `window.open`。Gateway 刻意使用 `HttpOnly; SameSite=None; Secure;
Partitioned` cookie。新頂層 Actor 網頁不再位於 DataHub 的 top-level cookie
partition，因此不能沿用 iframe 的認證。不是 session 消失或 export API 壞掉。
未讀取／匯出 cookie 或 provider credential。

## 修復

- 在點擊當下先建立空白 viewer，立即清除 `opener`，避免等待 fetch 後被 popup blocker 擋住。
- 由原本已認證的頁面 fetch 同源 export，使用 `credentials: same-origin`、`cache: no-store`。
- 只在 HTTP 成功且 content type 為 HTML 時，將既有 SDK 產生的完整 export document
  寫入 viewer，保留原本互動 tree／scripts；不直接渲染原始 Markdown 或任意呼叫者 HTML。
- 401／403／404／500、不合法 content type、網路錯誤顯示為純文字，不渲染錯誤 body、
  不自動 retry。Popup 被擋時不發 export；使用者提前關閉也不重開。
- 沒有新增登入票證、credential URL、cookie 例外、匿名 API 或 gateway 授權放寬。

變更：`pi-web/components/AppShell.tsx`、`pi-web/lib/session-history.ts`；
downstream patch／lock 同步更新，574 files 精確反向還原至原 506-file baseline。

## 驗證

- Pi Web：**1,033 tests PASS**；含 10 個新 history unit／wiring checks。
- Gateway／browser grants：**23 tests PASS**。
- 真 Chromium＋產品 gateway 的可重跑測試：
  `node tests/test_agent_session_history_browser.mjs`。
  原導航 401 且未到 runtime；修正後顯示互動 history、可選 branch、opener 為 null；
  匿名與 HTTP 401 仍拒絕。Identity／export payload 是 synthetic，非部署驗收。
- `tsc --noEmit`、兩個修改 TS／TSX 的 primary LSP clean；修改檔案 Lens cache 無 errors。
- Downstream checker：3 baseline checks PASS。

測試準備失敗保留：anonymous probe 最初用了 Node request client，無法解析
`*.localhost`；改用本測試既有 Chromium。Downstream checker 最初用系統 Python
缺少 SDK，改用既有專案 `.venv` 後通過。沒有更動產品來迎合這兩個測試環境錯誤。

私人證據：`.local/full-history-auth-r1/`，包含正式重現、local tests、before lock／patch。
未啟動模型、執行 SQL／ingestion、修改政策、commit 或 push。

## 正式部署與實測

使用者明確核准 Agent-only 9041 build／switch。建置沿用已核對 manifests 的固定
image dependencies，不是 clean npm-ci。最初額外使用 `--network=none` 擋住既有
`next/font` 字型下載，建置失敗且服務未變；保留原錯誤，移除新增參數後，沿用
既有正常建置流程成功，沒有修改字型／依賴設定。

- 新 image：`sha256:1bad9a98d020088f791a87f85b63eaa5201a8a566a0779c1c1d7e56369e7032c`。
- 574 source files hash／mode 與 image 相符；對應 browser assets check PASS。
- 切換前讀回 active work 為空，再由原 gateway 的正常 close 停止其唯一 owned
  runtime；pidfd 確認退出及 runtime cleanup 後才更新 config／啟動新 gateway。
- Config 僅替換 runtime image／browser assets，政策未變。舊 `d202a29d…` image、
  config、assets 保留；原 **25＋6 個 session JSONL hashes 完全相同**，未新增對話。
  9141 gateway PID／config 不變；沒有操作 Core 或 ingestion executor。
- 正式 `/mfe/agent` → 9041，以原 session 實際點擊 Full history：export 改為
  iframe 內非導航 GET，**HTTP 200**；新 viewer 出現原使用者訊息與完整 SDK UI。
  `User` filter 改變可見 tree，`Default` 恢復；opener 為 null，JSONL 下載控制存在
  （未實際下載）。母頁仍可用，沒有回應改寫或注入測試 renderer。
- `document.open` 會繼承呼叫頁 URL；CDP `page.url()` 曾仍顯示 about:blank，
  已用真正 `location` 核對：Actor origin、`/`、僅 session query，無 grant／credential。
  原 reader 錯誤保留。Viewer 是匯出當下的快照；需要新版內容時重新點 Full history，
  不新增可繞過登入的分享網址。

正式證據：`live-readback.json`、`live-interaction.json`、`deploy/final-readback.json`。
Gateway PID 2469144；部署仍依賴目前 repair worktree／私人 assets，勿移除。
回顧：應保持 authenticated fetch 的原 cookie partition，而不是放寬 gateway
認證；同時驗證真正歷史內容與互動，不能只確認錯誤文字消失。

# T07 整合驗收（進行中，2026-09-13）

主代理自查；不另建平台、不新增 datastore、worker、排程器或帳號。Settings 修復另獲一次限定 Agent 維護批准並已部署，**真入口 7 項檢查通過**；未續簽 Reader、發模型 prompt 或重跑 Task。

## 真 DataHub 入口檢查

沿已授權的 owned Chromium/CDP，本輪只開閉自己的新頁面，不操作 Windows 使用者分頁、不匯出登入資料。使用既有已 End 的 session `01a098e6-8570-72ba-a956-dd6f154e6713`。

- 1440／768／390 viewport：Workspace 鍵盤 Enter 開啟、Escape 關閉並回到實際 opener；Host／iframe 無水平溢出，composer 可用。窄版需使用官方 Navbar toggler 收合 Core sidebar；不是實體手機或完整 mobile Core 驗收。
- Shift+Enter 換行、composition／keyCode 229 與 compositionend 後 Enter 保護通過，沒有嘗試送出 prompt。這是 Chromium DOM 組字事件，不冒充 Windows 原生 IME 候選字測試。
- 既有 `draft-store.ts` 使用記憶體 Map；同頁草稿保持，整頁重載會清空。先前把它當成跨 reload 的 localStorage 草稿，是驗證假設錯誤；不為此新增儲存。已提交對話的持久化是另一項能力。
- 只對測試頁的 heartbeat 注入網路失敗：畫面顯示失敗、移除 iframe；恢復網路並經真入口重新 Open 同 session，歷史 API 200、原 6 messages 保留，沒有 prompt／Task mutation。不是 OS 全域 offline，也不能據此追認先前長等待失效的原因。
- **重現的產品缺陷**：Settings 關閉後焦點落到 BODY，而非開啟按鈕。原始真入口收據 `interactions-1`、`interactions-3`、`interactions-4` 保留；`interactions-4` 其餘 6 項通過，整體仍失敗，不能稱 live 全綠。

檢查腳本 `tests/check_agent_interactions_live.mjs` 現在直接以 `T07_SESSION_ID` 開啟原生 Pi session，不再依賴已移除的舊 Tasks 面板；執行時需顯式提供 `T07_CDP`、`T07_SESSION_ID`、新的 `T07_EVIDENCE`。保留 `wx` 收據，不覆寫失敗來重跑。它攔截並記錄非唯讀 native commands；零攔截才表示 UI 沒有嘗試寫入。部署前一次 cleanup 用到已移除 frame 的舊 locator，舊收據標 unconfirmed；頁面確已關閉、重新開啟的 composer 已驗空白。腳本已更新新 frame 的 locator；部署後收據已確認 marker 草稿移除及自己的頁面關閉。

## Settings 焦點修復與候選證據

- 因果：`SettingsPanel` 處理 Escape 卸載，但沒有保存／恢復 opener，也沒有把開啟焦點移入面板。子控制項被移除後瀏覽器焦點落 BODY。
- **產品僅一檔** `components/SettingsPanel.tsx`：沿元件生命週期保存 opener、聚焦面板，layout cleanup 在 DOM 移除前恢復仍存在的 opener。不改設定資料、子頁掛載、modal/page 設計、SDK 或 RPC；不建立通用 focus manager。
- 精確 SettingsPanel function＋真 React／Chromium 的隔離 fixture 紅轉綠：兩個 opener × 1280／390，驗初始焦點、Escape、Close 與 StrictMode。子設定頁/API 為 stub，不冒充完整產品驗收。
- `scripts/prepare-agent-settings-focus.mjs <新目錄>` 產生上述 fixture；既有固定 Node 映像、Webpack、React 依賴在無網路／唯讀根／1 CPU／512MiB 容器建置，再以 `SETTINGS_FOCUS_FIXTURE=<目錄> node tests/check_agent_settings_focus_browser.mjs` 執行。沒有新增依賴或下載瀏覽器。
- 既有 `tests/check_agent_pi_web_browser.mjs` 加入焦點回歸；**真候選 Pi 映像、兩容器、合成 DataHub identity** 通過：Settings／Models／MCP invalid/save/CAS/reload、初始與關閉焦點、PTY、Files 4MiB、SW、雙使用者與 sibling／logout 清理。不是兩個真 DataHub 帳號的 Host Task ACL 證據。
- 舊 image browser fixture 把 native iframe 高度誤當整個 Host 的 900px；Registry／Tasks 已佔 90px。改驗明確的 Host 高度與 iframe 自身剩餘高度，保留原 810≠900 失敗，不改產品布局迎合。
- 521 檔／mode 與候選 image 一致；reverse patch 還原原 506 baseline 與 3 foundation checks 通過。Settings／SettingsUi／draft 回歸在本機及候選映像通過。Browser assets／operator／package-lock 與精確映像相符。
- 候選 image：`sha256:2f7922820d42a86c8743efbfd2ea02bfac24ce56658ed6faa6e346f8c1d66ff1`。550 inputs 對上一部署僅 SettingsPanel 與 downstream patch／lock 不同；其餘保持。受限 builder 已停止，fixture 容器／volumes 清除。此映像隨後依限定批准部署，見下節。

## 等待中的生命週期與 Windows 真人 IME（2026-09-13）

本輪另獲限定批准：原 Reader 一小時 token 更新原 MCP、真人啟動原兩資產 Task 的一個新 Run、僅該 Run 等待時 Agent 重啟一次、真人關閉。沒有新增產品功能、排程或自動續跑。

- 新 Run `1a6ca8f9-d5ea-4d79-9852-09d8e882ae15`／session `01a09ad3-5816-746d-b93c-eb5c37ad4083`，由 Windows 使用者按 Start。模型讀 metadata 後等待；v2 問題 `3e36e1ed-e72d-45b9-b1d8-2d9a67455c89` 尚無 response。
- **頁面恢復通過**：完整重整、只對自己的測試頁注入 heartbeat 網路失敗再重開，均顯示同一問題，native UI request ID `38a7cd81-0dd5-429c-ac41-ae4239046f88` 不變。Run v2／4 則歷史訊息 hash 不變；沒有 start／respond／cancel 或 native prompt 嘗試。Windows 另一頁仍保留，故這不是所有 browser lease 同時失效的驗證。
- **程序中斷通過本範圍**：fresh identity、唯一活動 session 正是該 pending Run，再執行已核准的一次重啟。gateway `4123209 → 70293`，新 runtime `33d85e9cbb2d…`；image `2f792282…`、operator 全部設定、MFE bytes、Core 容器投影、HOME volume 保持。
- 重啟後真 Tasks／Open session 讀回 v2 和完全相同的 4 則歷史；沒有活動 wrapper／問題 UI，沒有自動續跑。UI 正確區分「Host admission open」與「Pi running」。這是**中斷後歷史保留、無重送及可明確結束**，不是 pending Promise 自動恢復。
- 真人按 **Close Task run and stop Pi**，真 API 讀回 v3／`closedAt=1789305481057`，其他業務 value 不變；v2 未回答歷史仍可讀。這次是關閉 Run，不冒充 DISMISS／RESPOND；沒有假造真人答案。
- **Windows 微軟倉頡／速成：本次真人操作確認** Enter 選字不誤送、Shift+Enter 換行正常、草稿已清空。未獨立觀測 Windows browser 版本，不擴稱所有 IME／瀏覽器通過。
- 使用者另明確確認有刻意送出「中文輸入測試」，之後停止或離開頁面。故原 4 則歷史之後新增 user＋aborted assistant 共 2 則，並非 IME 誤送或重播 Task，也不是成功模型回覆。原 4 則 prefix hash 保持、沒有新 session，native 活動／pending UI 為 0；wrapper 存在不等於工作仍在執行。`closedAt` 只關閉 Host Task 操作，不禁止 owner 在原生 Pi chat 另送訊息。
- Reader 原身分 read 200／write 403、原 metadata 不變，MCP token-only CAS PUT／GET 200，其他設定 hash 保持；本次到期 **2026-09-13T13:38:13.506Z**，無自動續期。一次 Agent 維護已使用。

證據：`.local/evidence/agent-t07-lifecycle/` 的 `waiting-browser-envelope-checked.json`、`pre-restart.json`、`restart-verified.json`、`after-restart-browser.json`、`closure-reconciled.json`、`human-followup.json` 及 `checkpoint.json`。腳本沿用既有 Playwright／公開 API；所有自己的測試頁已關閉，沒有代答或重送。

保留檢查失敗：首次尚無新 Run；Host request envelope／OPTIONS 被初版攔截器誤判；auditStamp 層級、將 wrapper 存在誤當工作活動、將真人另送訊息誤當歷史應完全不變。均依已保存的現場資料修正檢查／對帳，不修改產品配合，也未重播 mutation。

來源對帳：14 檔格式差異已備份並經語法樹核對／使用者批准還原；首次命令內核對相符，但返回後同一批 bytes 差異再次出現。重啟前依同一批准範圍還原，**重啟前與最終收尾均驗 550 個輸入符合已部署候選**，目前沒有殘留 byte-lock 差異。未確證差異的寫入程序，未改工具設定、版本鎖或重建 image；保留過程證據，不宣稱已修復開發工具。

## 範圍與未完成

- 使用者已核准一次限定 image／assets 切換：gateway **3761704 → 4123209**，runtime **56fa02701238…**／image **2f792282…**。部署前 fresh identity／native active 0；後驗 Core 容器投影、MFE bytes、原 HOME volume 保持，operator 設定僅 image／assets 兩欄變更。維護額度已使用。
- `interactions-deployed/result.json` **7/7 通過**：Settings 關閉回到原 BUTTON、三尺寸 Workspace 鍵盤／layout、組字不誤送、原生記憶體草稿行為、heartbeat 失敗移除 frame／重新開啟原歷史。無 page error／被攔截的 mutation attempts；cleanup 已確認。這是本次 Settings 缺陷的真入口恢復證據，並非全部 T07 完成。
- 12 次 Tab 抽查不等於完整焦點循環或 WCAG 合規。Windows 倉頡／速成本次真人操作、等待中的頁面恢復／程序中斷／明確關閉已有上述證據；其餘 a11y、原生功能、多使用者／所有 lease 失效及備份回復仍按 T07 原清單驗證，不擴稱全部完成。
- 第二真 Actor 與 Agent 排程時段／身分尚無新授權；不把合成 identity 當成真 Host ACL，不自行建帳號或 scheduler。
- 13 檔純格式漂移再次出現，與此前已驗並備份的格式 bytes 完全一致；已恢復，不混入候選。一次 shell 前置 assert 失敗後仍執行 lock 更新的錯誤已撤回、留存，再以停止於錯誤的命令核對及生成。最終只有單一產品元件修復，不將格式漂移包裝成需求。
- 未變 `rpc-manager.ts` SHA `799f5e40…` 的舊斷言樣式 findings 保留／暫緩；本輪 scoped primary clean 不等於全 repo lint clean。

全部原始證據位於 gitignored `.local/evidence/agent-t07/`，包含 `candidate-source.json`、`image-source-match.json`、`artifact-check.json`、`image-browser-final.log`、`settings-focus-{red,green}/result.json` 及各次失敗。T06／T07／母 TODO 均未結案。

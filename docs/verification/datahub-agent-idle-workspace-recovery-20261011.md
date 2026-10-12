# Agent 閒置後 workspace 消失：本地修正

## 現況

已重現原問題並完成本地修正；後續使用者明確要求一起部署，**已與增量回覆／容量修正合併部署，真入口 grant 到期自動恢復通過**。詳見[部署紀錄](datahub-semantic-incremental-capacity-idle-deploy-20261011.md)。修正不延長 grant、不放寬登入／Actor 核對，也不重送模型或業務操作。

## 原因與真入口證據

Browser grant lease 為 90 秒，父頁每 20 秒續期。若父頁停頓超過 lease，舊 grant 到期，心跳回傳 401。原 `mount.js` 對任何心跳失敗都移除 iframe／bridges、停止心跳並顯示：

> Agent could not open. Check your DataHub login and retry from the Agent menu.

它沒有重開 workspace 的恢復流程，也把網路中斷與 grant 到期統一呈為登入問題。因此整頁刷新重新 bootstrap 才恢復。

Windows Edge 真 `/mfe/agent`：只暫停 owned 父頁 JS 96 秒，恢復後心跳 HTTP401、上述訊息精確出現、iframe 消失。同一 owned context、不重新登入，另開 workspace 成功。這證明「短期 grant 到期但 DataHub 登入仍有效」的路徑；沒有量測使用者原分頁當時是背景限速、休眠或其他停頓。

首次 `Page.setWebLifecycleState` 探測未停止心跳，未重現，原失敗保留；第二次 debugger 暫停才建立可靠訊號。沒有操作使用者原視窗、讀取憑證內容或觸發模型／原生 Metadata 寫入。

## 修正

`extensions/datahub-agent/mfe/mount.js`：

- 心跳失敗後，最多立即做一次新的、由 Host 核目前登入的 bootstrap。失敗就停止，不建立背景登入重試迴圈。
- 回到分頁／focus／online 時立即核心跳，同時最多一筆續期或重連。
- 若登入已失效，保留安全錯誤訊息及「重新連線 Agent」按鈕；登入後可明確重試，不要求整頁刷新。
- 每次重連建立新 iframe／WindowProxy，移除舊 bridges／審核畫面。舊文件排隊訊息不能取得新連線的權限。
- 每筆 bridge 請求綁定當次 grant 與取消 epoch；取消舊請求，不自動 replay。沒有搬移舊 consent、追認 UNKNOWN 或恢復 publication。
- 保留原沙箱、origin／grant／bootstrap target 驗證、90 秒 lease、20 秒心跳及原操作 timeout。

本地閒置修正階段沒有修改 Host、SDK、Core、Source 政策、模型、預算、業務儲存或正在服務的 dist。後續合併部署另包含已批准的 Host／SDK 增量與容量修正，Source／模型／預算／Core不變。

## 本地驗證

- 原 grant 過期案例先 RED，再 GREEN；45 項 MFE／BrowserGrants／真 HTTP gateway 隔離回歸通過。
- 涵蓋 grant 到期、暫時網路失敗、登入失效、focus／online 單筆續期、明確重試、cleanup／late bootstrap、舊請求取消及同 origin 舊 iframe 訊息隔離。
- 私有 production webpack candidate 建置成功，沒有 checkout Next build 或安裝相依。
- 真瀏覽器載入 candidate MFE，配 disposable identity／HTTP grant／iframe：1440 與 390 都可恢復 workspace，無整頁刷新；登入拒絕停止、手動登入後新 Actor 可恢復，所有 owned resources 關閉。這是合成 browser 驗證，不是部署後 DataHub 恢復驗收。
- scoped diff check 通過。LSP 未證 clean；保留 5 筆既有 nested-ternary advisory、1 筆新 boolean-argument advisory及未確認 coverage，不為通過診斷改無關程式。
- Browser receipt 的 `EEXIST` caller 失敗保留；新私有輸出目錄完成同一 candidate 的驗證，沒有重做實作或重播外部效果。

私有證據：`.local/evidence/agent-idle-workspace-recovery-20261011-foKi7nIH/`，`validation.json` 為 `LOCAL_IDLE_WORKSPACE_RECOVERY_VERIFIED_NOT_DEPLOYED`。

## 部署及後續

後續合併部署先核 fresh Actor／idle／原生計畫／journal／source pins，再正常重載 Host 的 boot-time MFE cache。Windows Edge 真入口暫停 owned 父頁96秒，heartbeat401後只有一次 fresh bootstrap，新 iframe／WindowProxy 以同 Actor 恢復，原保存結果未變。原本地收據保留；新部署授權已消耗。自然背景限速／OS睡眠仍未驗收；新模型續作或 native publication 不在此部署範圍。

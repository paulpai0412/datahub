# 歷史 UNKNOWN 暫緩：本地實作驗證（2026-10-07）

**本頁保留部署前本地證據。後續已部署，r16真驗證因模型GAP輸入不符契約而停止，尚未送審；詳見[最新live結果](datahub-semantic-unknown-deferred-live-20261007.md)。** 使用者要求UNKNOWN先skip，其餘工作繼續，不再被同一歷史未決項卡住。

## 行為

- 重用現有 `prepare_maintenance`／原生GAP觀測，新增 `UNRESOLVED_OPERATION`。Agent提供原因及原已知操作action／Root、可選requestId／itemId；缺失定位省略，不猜填。
- 原計畫保存 `DEFERRED`，不執行原操作、恢復attempt、追認零效果或移除舊歷史。未決部分只有觀測，不能混入target candidates／definition。
- scope封存條件仍核整份原選定範圍與有效依賴；明列暫緩後，其餘完整有據計畫可READY供一次整批真人確認。`deferredItemCount/deferredAssetCount`明示未決，`semanticCompletenessVerified:false`仍在。
- 父頁顯示暫緩原因與原定位，跳過DEFERRED而執行獨立所選工作。未知目標保護、ACL／Source／CAS及真人確認不放寬；新的獨立提案不因暫緩變成資產黑名單。
- 當前正在派送／失去ACK仍先停與唯讀對帳，暫緩不能掩蓋在途效果。沒有新controller／store、Source或資產名字特判、Core patch或自動核准。

契約見[設計第11節](../design/datahub-semantic-maintenance-workflow-first.md)。

## 實際檢查

- 原生maintenance／Catalog／transport／readonly／MFE及SDK→actual Host→synthetic API：93/93。
- 固定SDK／RPC／前景／own-ACK／工具政策回歸：73/73。
- 回歸包含真合成UNKNOWN attempt保留不可重送、相同未決目標更新仍拒絕、DEFERRED不派送、其他分支送審與執行、定位缺失不捏造、獨立同資產提案仍可保存，以及ACL／CAS／混入變更負例。
- 現有React卡片→可信MFE父頁→合成公開API，在390及1440px驗證：暫緩與原定位可見，確認前零target寫入，一次確認後只有獨立項目派送，暫緩保持可見、沒有overflow或pageerror。另保留原定義／套用與真正fixture變更第二輪。這不是正式DataHub、真人consent或實際模型驗收。
- TypeScript、targeted ESLint及scoped whitespace通過；app588檔、reverse精確還原原506檔、原upstream lock不變。相對上一版只改SDK工具、維護卡與Skill三個app paths。
- LSP／補助分析有既有warning與未確認coverage；不宣稱workspace完全乾淨。新增重複巢狀狀態判斷已集中至既有觀測狀態函式。

本地證據：`.local/evidence/semantic-unknown-deferred-local-20261007-1ab2zd/`，含檢查logs與browser-final截图／receipt。未建置或切換新映像，未改真原生計畫或重送r15／成功提案。

## 尚待部署及產品完成

上述是本地階段的部署前缺口。使用者後續已授權部署與一則新提示，暫緩功能生效，但r16仍DRAFT且三筆原定位聲稱不正確；後續模型輪次須新授權，不重播ACK或r16。真人整批確認、原生發布／UI讀回與真正變更後續維護仍未驗收；skip未決不等於全部完成。

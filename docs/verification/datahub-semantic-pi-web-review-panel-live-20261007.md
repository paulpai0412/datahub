# 語義審核右側面板 — 已部署及真入口驗證

2026-10-07。使用者另准「只部署 UI」：更新本案 Agent／MFE及現有審核視窗，不送模型提示、不代確認或發布。

## 最新：審核視窗已退休，交回一般查詢入口（12:22 UTC）

使用者另建對話、選 DataHub only 後仍無回應；原因是審核專用 Playwright context 對所有新提示攔截，不隨對話或工具選擇解除。這是操作 harness 的限制，不是已證實的模型、DB或metadata ACL故障。

已fresh核原生 CONFIRMED v325／114 VERIFIED／22 OBSERVATION_CHANGED／6 GAP及無running工作，關閉已完成的owned審核視窗，保留一次真人確認和114筆成功效果。新一般視窗經真入口開新空白composer並選 DataHub only，不再套用審核網路攔截，也不自動重送問題。原生viewport1548×872、pageerrors零；本地synthetic transport復現攔截失敗及移除後成功，但**尚未實測SalesDatamart查詢或模型回答**。請使用者在新一般視窗手動提交一次。

證據在部署目錄下 `ordinary-query-window-recovery-v9jl8kui/`；前述 `native-window-viewport-fix-_vdeskwh/` 已是關閉的歷史審核證據。沒有部署、改Host安全／權限、改原語義session或重播確認／發布。

## 真人確認後114項原生發布成功（11:02 UTC讀回）

真人整批確認於10:38:35 UTC送出、10:38:43接受；原生計畫成為CONFIRMED v325。114筆唯一發布皆HTTP200／VERIFIED_CURRENT_VALUES，最後一筆10:45:37完成，包含29筆共用定義與85筆Dataset／欄位套用文件。助手沒有代批、重送或新模型提示。

11:02:35直接讀回全部原生項目及Root Aspect：114 VERIFIED、22 OBSERVATION_CHANGED、6 GAP，原planDigest不變。其餘28項未發布；觀測已變更不等於完成或歷史UNKNOWN已恢復。這證明本次批准內容已原生發布並讀回，不等於完整語義代管或真實證據變更後第二輪驗收。

完整項目／請求／回覆比對與摘要位於下述最新真人視窗證據的`after-human-publication-summary.json`及`owner-click-readonly-QXUiyl/native-current-private.json`。下文未確認／零效果為發布前歷史觀測，已不代表目前狀態。已接受的確認和114筆發布不可重送。

## 先前：真人視窗尺寸修正（10:23 UTC）

使用者回報只看得到上半部。實測審核Chrome視窗只有959高，但先前harness將網頁內容固定成1000高；先前「位於1000 viewport內」的DOM檢查不能證明實際螢幕可見。

已在核對沒有確認／發布後，關閉該owned視窗，替換唯一審核視窗，取消固定viewport，沿用原生最大化尺寸。實測視窗1548×959、實際網頁1548×872；確認按鈕下緣830，落在真實可見範圍內。確認框未勾選，142項／114完整預覽與原READY v324不變。没有重建／部署、改系統解析度／縮放或代批。

最新真人視窗收據位於下述部署證據內的`native-window-viewport-fix-_vdeskwh/`；先前部署目錄的真人視窗已關閉，後續應先核新版收據與原生現在態。這項檢查證明目前實際視窗可見，不宣稱所有螢幕尺寸皆已驗證。

## 結果與使用方式

真入口：`http://localhost:9002/mfe/agent`。

- 沿用 Pi Web 可調寬、放大／還原的右側工作區，不再開整批審核獨立 dialog。
- 顯示資產／定義名稱、目前內容、建議內容、理由、證據與影響；沒有 JSON `pre`。技術定位及歷史可展開。
- 標題／搜尋及底部確認／操作固定可見，只有建議清單捲動。
- 搜尋／篩選不改選取。改選取會取消確認；重新開啟不恢復確認。
- 可信父頁仍持有完整內容、選取、真人確認與原 publisher。iframe 只有定位及幾何位置，沒有批准權。

在卡片按「在 Host 核對整批計畫／原生結果」，核對並調整選取後，**由真人**勾選固定底部確認框，再按「確認整批並依序建立／套用」。未勾選時按鈕保持停用。

390 寬度的真 DataHub 頁面需先以原生「Navbar toggler」收起導覽列，再收起 Pi Web 的 History／Workspace；未收起時，既有 Core 導覽列把 iframe 壓至 66px。驗證使用原生操作，沒有修改 Core 或覆寫其 DOM／樣式。

## 實際證據

| 範圍 | 結果 |
| --- | --- |
| 切換前 | 現有真人確認／發布／效果收據均零；當前身分、原 session、同模型 high、idle及原生 READY v324核對 |
| 建置 | 固定 98 個 operator來源、592 個 app來源；reverse patch精確恢復官方506檔；CPU1／3GiB／swap0、serial、credential-free建置；builder停止 |
| 精確映像 | 全部592來源及瀏覽器產物／lock／runtime entry核對通過；映像內81個SDK／RPC隔離測試通過 |
| 切換後 | 原生Task／Root完整Aspect及system metadata、全部142 active項目與scope保持一致；仍 READY v324、161 recorded、91資產、114 PENDING／28 GAP |
| 真 UI | 實際已建置 Pi Web → MFE → 原生公開API，在1440／390讀齊142項、114份完整差異；確認與操作在首屏及清單捲到底均可見，無裁切、無JSON `pre` |
| 互動 | 篩選保留選取、放大／還原、關閉焦點恢復；桌面iframe reload移除父頁內容，重新開啟確認未勾選 |
| 歷史 | 兩個既有HOME的41份journals，部署前後及真UI驗證後皆byte-exact |
| 真人視窗 | 先關閉原owned視窗、確認無效果，再開一個新版replacement；09:55:26 UTC停在READY v324、142項／114完整預覽、確認未勾、pageerrors零 |

09:57:39 UTC再次核對真人確認／發布／效果收據均零。這是當時觀測，不保證之後沒有使用者操作。沒有新模型提示、metadata發布、SQL、ingestion、Source grants、query、模型／預算、Core或其他服務變更。

## 失敗與對帳

保留隔離MFE mountpoint、複製build路徑、Chrome process-title解析及尾端journal-reader的caller失敗；只更正本次caller，未重播舊建置或放寬資源／安全條件。

真UI首次390檢查因原生導覽列擠壓而停在隱藏textarea；以公開原生收合操作完成。兩種尺寸的UI互動之後均完成，但尾端收據彙整誤用不存在的`q.reference`；正確定位是`runUrn + decisionId`。以已保存的全部HTTP回覆重組、核摘要並驗114份完整文件，不重跑已成功的UI流程。該失敗caller未保存pageerror陣列，不能追稱該輪pageerrors零；新版可見視窗另有零pageerror的啟動收據。

## 產物、回復與未完成項

精確映像：`sha256:46f0914cbe3bde35f4e6d30f0dc91cb42c47874e1b6822c05ab816b9b511c88f`。

私有證據：`.local/evidence/semantic-autonomous-plan-20261005-ScQzQE/pi-web-review-ui-deploy-20261007-qr29_83z/`。包含來源／映像／產物pins、原生前後讀回、完整review文件、桌面／窄螢幕截圖、真人視窗與效果收據。舊MFE在`mfe-before/`，舊config／image仍保留；未執行回復。若需回復，先核真人收據、在途及原生現在態，不在執行中切換，也不恢復舊PID或重播發布。

**UI改善已交付，不等於整個語義代管完成。** Tag／Property仍只有定義、未套用；歷史UNKNOWN效果仍未判定；真人一次確認及114項原生發布已完成；完整child Aspect／歷史／Catalog UI驗收及真實證據變更後第二輪仍OPEN。r17提示授權已消耗，本輪UI授權不增加模型提示或代批權。

本地來源與隔離驗證：[本地面板報告](datahub-semantic-pi-web-review-panel-local-20261007.md)。原計畫：[r17結果及限制](datahub-semantic-input-correction-live-20261007.md)。

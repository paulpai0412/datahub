# 語義審核接入 Pi Web 右側面板 — 本地驗證

2026-10-07。本節記錄當時本地實作與隔離驗證，尚未部署。**後續另獲UI-only授權，已部署及完成真入口核對**，見[部署報告](datahub-semantic-pi-web-review-panel-live-20261007.md)。兩者均不等於既有 READY 計畫的真人確認或發布驗收。

## 使用方式

1. 在對話的整批語義維護卡片，按「在 Host 核對整批計畫／原生結果」。
2. Pi Web 原有右側面板開啟審核工作區。可調寬、放大或還原。
3. 查看來源、資產／定義、目前內容、建議內容、理由、證據與影響。搜尋或篩選只改顯示，不改選取。
4. 核對所選內容後，由真人勾選固定底部的確認框，再確認整批。變更選取會取消先前勾選；重新開啟不恢復確認。
5. 缺口／暫緩不是成功。結果未確認時只讀對帳，不重送。

沒有用 JSON 區塊顯示整批差異。結構值以名稱／值、清單及原值／建議值對照呈現。名稱取自 Host 已核對的定義，未取得名稱時保留精確定位，不猜業務意義。版本、摘要、原生 URN、歷史及限制可以展開，未刪除證據。來源文字只以文字呈現，不執行 HTML。

## 插件邊界

- `AppShell.tsx` 沿用既有右側面板狀態、尺寸、slot 與會話／頁籤綁定；不接 DataHub Core 私有元件。
- 新 `DataHubSemanticMaintenancePanel.tsx` 只提供位置、工作區關閉與放大。沿用 Grafana 的父頁掛載模式及樣式。
- `semantic.js` 只接受原生 Root 定位與有界位置；不接受 iframe 的選取、確認、HTML 或發布指令。
- `semantic-maintenance-review.js` 在可信父頁讀齊原生計畫及完整 digest-bound 差異，持有選取、確認與既有 publisher。Host ACL、CAS、依賴及不可重送規則不變。
- 標題／搜尋固定上方，清單獨立捲動，確認與操作固定下方。修正共用 workspace 高度，避免窄螢幕將最後按鈕裁掉。
- iframe 導航／卸載會移除父頁審核並停止後續派送；已在途效果仍須原生對帳，不能推定取消成功。
- 關閉回傳有界公共收據，不把全部審核文件再送回 iframe。收據不代表整批成功或新的執行授權。

## 已執行的檢查

| 檢查 | 證據與結果 |
| --- | --- |
| MFE／HTTP／原生維護／iframe 禁止代批 | 56/56 通過 |
| 實際 AppShell → MessageView → 右側 slot → MFE → fixture 公共 API | 390、1440 寬度通過；Next navigation 與 HTTP 資料為隔離替身，非使用中的部署 |
| 142 項長清單 | 固定確認框及按鈕在首屏與捲動後可見；搜尋／篩選保留選取；文字 HTML 不執行；無 JSON `pre` 區塊；放大／還原／關閉與焦點恢復通過；零目標寫入 |
| 一次確認、依賴執行、後續定義更新、UNKNOWN 暫緩 | 既有可重跑 fixture 流程通過；不冒稱真模型或真來源變更輪次 |
| iframe reload／重新開啟 | 父頁內容移除，未自動執行，確認框不恢復 |
| Grafana 回歸 | 互動、縮放、捲動、遮擋、撤權、卸載及窄螢幕裁切通過 |
| TypeScript／限定 ESLint | 通過 |
| 可持續升級 | 592 檔 downstream、反向 patch 精確恢復官方 506 檔及原有三項檢查通過；上游鎖未變 |
| Impeccable detector | 無 findings；不是完整無障礙合規證明 |

LSP 主動檢查有既有 inline-style／巢狀條件提示與兩項 inconclusive，不宣稱 workspace 全 clean。先前無關 RPC shutdown mock 缺 `clearQueue` 的失敗未改、未重跑。

## 證據與未完成項

本地證據：`.local/evidence/semantic-pi-web-panel-local-20261007-rjbinir1/`。

- `workspace-browser-final/receipt.json` 與 `long-readable-{390,1440}.png`
- `native-ui-final.log`、`grafana-browser-1.log`、`typecheck-final.log`、`lint-final.log`
- `downstream-final.log`、`owned-source.diff`、`before-manifest.json`、`validation-final.json`
- 初始 browser cache／esbuild caller／舊 selector 失敗及窄螢幕裁切失敗保留；未放寬驗收斷言以掩蓋問題。

本轮無新部署、模型提示、真語義寫入、SQL、ingestion、grants、模型／預算變更或 commit／push。2026-10-07 06:43:39 UTC 只讀查到既有真人視窗確認／發布／效果收據均為零；這不是未來也無效果的保證，也不是對原歷史 UNKNOWN 的判決。

上線仍須新的明確 UI 部署授權。先核既有真人視窗及原生現在態，避免批准期間切換或打開第二個批准視窗。保留原 SID／Root／草稿／ACK／HOME／journals，不再送 r17 或新模型提示。完整代管的方案品質、真人確認、原生發布及真正變更輪次仍 OPEN。

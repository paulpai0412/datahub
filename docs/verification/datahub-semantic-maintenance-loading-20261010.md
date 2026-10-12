# 語義維護審核：載入期間空白（2026-10-10）

**已部署，Windows Edge 真入口只讀驗證通過。** 不會自動確認、發布提案或重跑模型。

## 已確認的問題

使用者截圖中的右側 Host 面板已掛載，左側計畫為 READY、13 項；右側仍是「讀齊全部計畫項目與同版本原生差異…」、0／0、正在處理。

Windows Node／既有 Edge、sandbox、新 owned context 的真入口只讀檢查：

- 同一份計畫開啟後約 29.3 秒顯示全部 13 項。
- 刷新整頁再開啟後約 35.8 秒顯示全部 13 項。
- 每次 41 個只讀請求成功，計畫維持 READY v28；沒有確認／發布／模型要求。

原因在於父頁 `loadMaintenancePlan()` 逐項完成全部差異及最後版本核對後，UI 才一次 `render()`。期間沒有進度與已完成內容，看起來像空白或資料消失。**這證明載入呈現缺陷，不證明已找到所有持續卡住或偶發空白的原因。**

第一次真入口檢查的斷言把外層 Core section 也算進面板，造成 caller failure；修正為精確 parent panel selector 後，才完成上述兩輪。原失敗保留。Tracking POST 被攔截與 `Failed to fetch` 亦保留，不宣稱零 browser errors。

## 本地修正

`extensions/datahub-agent/mfe/semantic-maintenance-review.js`：

- 取得原生清單後顯示總項目數、已讀取數及目前項目，不再以 0／0 冒充空計畫。
- 每筆完整差異通過既有 segment／SHA／版本／Source／Root 核對後，先顯示**只讀預覽**。
- 全部項目及計畫最終版本核對完成前，沒有選取／確認框，確認按鈕保持停用。
- 最後版本漂移或讀取失敗維持未確認，不能用部分預覽批准整批。
- 關閉載入中的面板或 iframe 重新載入，取消本面板的未完成讀取；不繼續排空剩餘請求。發布中的 Stop／等待已派送收據行為保持不變。

沒有縮減差異、跳過版本／digest 檢查、增加並行、重試、變更預算、ACL／Source／SDK／Core 或建立新 datastore。

## 可重跑檢查

新增 `tests/check_agent_semantic_maintenance_loading_browser.mjs`。使用 synthetic native API、memory fixture、兩筆完整計畫與刻意暫停的第二筆讀取；沒有真 DataHub 或模型效果。

- 舊版 RED：第一筆完整差異已讀完，面板仍無 1／2 進度或預覽。
- 新版 GREEN：390／1440 成功路徑；最後版本漂移仍鎖確認；關閉取消、不派送剩餘讀取。
- 93 項相關 Host／MFE／delivery／readonly／transport 回歸通過。
- 既有 actual AppShell synthetic 390／1440 整批確認／後續變更、142 項長方案顯示檢查通過；fake effects 不等於真實發布。
- 私有輸出目錄中的 webpack production candidate build 成功；本地驗證階段未替換 `mfe/dist`。其後僅在另行取得部署批准、閒置及保存檢查通過後切換。
- Node syntax checks 通過；機械 detector 未列 findings。兩個 scoped LSP check 均 inconclusive，不宣稱 clean。

## 部署與限制

使用者另行批准「佈署」後，2026-10-10 13:56:39 UTC 完成切換。MFE 在 Host 啟動時讀入記憶體，因此在確認閒置後正常停止舊 Agent Host，再以**同一設定與映像**啟動；Core 及其他服務未重啟。

- 只替換 `89.js`；`remoteEntry.js`、後端／SDK／Core／模型／Source 權限／設定原值不變。沒有新建映像或啟動 builder。
- 實際服務的 chunk SHA 與候選一致，回應為 `Cache-Control: no-store`。
- Windows 真入口「開啟 → 整頁刷新 → 再開啟」兩輪通過：約 2.3／2.2 秒取得可見的 1／13 只讀差異預覽，全部 13 項約 23.1 秒讀齊。這是當次量測，不是縮短全部讀取的效能承諾。
- 部分載入時沒有項目選取或整批同意框，確認按鈕停用；完成後顯示完整 13／13，沒有點選同意或確認。
- 新 Sales 計畫維持 READY v28。五份計畫的完整清單前後一致；四份 Sales 案的完整範圍／未準備項，以及 26 份完整 Review／歷史也相同。比較僅排除讀取 request ID 與即時讀取時鐘。
- 兩份 HOME 的 45 份 session journal SHA／size／mtime 不變。沒有模型要求、prepare／新 Root／native approval／publication 或 metadata 寫入；owned browsers 全部關閉。

第一次新 UI probe 用了不匹配的外層 aria selector，原 caller failure 保留；改用已存在的精確 panel attribute，新 owned context 的兩輪才通過。保存工具的 full-mode 讀取及第一次切換前舊草稿讀取亦曾返回 `semantic_request_failed`；前者改用既有 production receipt／digest reader取得完整結果，後者新的只讀觀測成功且核對五份原清單後才切換，沒有重播效果。這兩次原錯誤的確切來源未證。Tracking blocked／`Failed to fetch` 保留，不宣稱零 browser errors。

完整語義代管品質、原生發布與真正變更輪次不由這個 UI 修正宣告完成，也未證明已排除所有額外持續卡住的原因。

私有原始證據：`.local/evidence/semantic-panel-empty-20261010-yFTpca/`。部署與驗收：`.local/evidence/semantic-mfe-loading-deploy-20261010-q4VKFt/validation.json`，狀態 `DEPLOYED_READONLY_ENTRYPOINT_VERIFIED`。

回復資料保留在部署證據的 `mfe-before/`，以及相同的 image／config／source pins。若需回復，先取得新的操作批准並核對新鮮閒置及保存狀態；不能重跑已消耗的部署 helper 或重啟已退休 PID。

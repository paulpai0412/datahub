# SalesDatamart 繁體中文維護中止：修正已部署

> 本文記錄先前 Aspect 重疊故障及已完成的部署。之後同一提示在新草稿的另一個中止，見[審核內容容量修正](datahub-semantic-sales-review-capacity-20261011.md)；該修正目前僅本地通過，尚未部署。

## 結論與現況

「維護整個Salesdatamart的語義,請用繁體中文來呈現」這次中止，直接觸發點為 `prepare_maintenance` 的 `semantic_maintenance_aspect_overlap`。不是繁體中文輸入拒絕。

使用者批准「修正,佈署」後，修正已於 2026-10-11 部署，並完成真入口只讀驗證。此次部署授權已完成並消耗。沒有自動續跑模型或發布；新的真模型續作仍須獨立意圖，不可重送原提示、原失敗請求或發布操作。

## 原因

模型已為同一 view 保存一筆含 16 個候選的提案，其中有 14 個欄位候選。最後另用 `prepare_maintenance` 新增其他 5 個欄位的 Term。不同欄位仍共同編譯至同一個原生 `editableSchemaMetadata` Aspect，因此兩筆獨立提案競爭同一完整 Aspect，Host 正確拒絕。

問題在於：這個精確比較發生於新 child 寫入前，卻只回傳普通拒絕，沒有 request-bound input rejection。SDK 依安全契約把結果列為未確認準備，呼叫 abort，最後顯示 `This operation was aborted`。

## 修改

`extensions/datahub-agent/integration/semantic-maintenance-plan.mjs` 僅將 prepare/revise 編譯後、寫入前的重疊比較改為 `MaintenanceInputRejection`。

- 保留同一 URN／Aspect 不可跨 active items 競爭的限制。
- 精確證據允許模型提交 **NEW_INTENT_ONLY** 輸入，不允許重試原請求。
- 模型應讀回既有完整提案，再用 `revise_maintenance` 保存完整新候選；SDK 不合併、拆分、補字或翻譯。
- recover 分支、ACL、CAS、原生相依漂移、祖先腐損、缺證據及失 ACK 的硬停止不變。
- 此修正不能回溯為原失敗請求製造零效果證據。

## 驗證

- SDK→實際 Host→合成 public API：先 RED 重現缺證據，再 GREEN；被拒輸入不新增 record／target writes，不改 journal，不 abort、不排入重送。
- 新的完整 revise 保留兩頁繁體中文候選，active item 仍為一筆，歷史為兩筆；隔離方案可 seal 至 READY，沒有真人 consent 或 publication。
- 語義回歸 382／382 PASS；最後加強的 SDK 斷言 6／6 PASS。
- scoped diff check PASS；兩檔 LSP INCONCLUSIVE，不宣稱 clean。
- Windows Edge 真入口只讀核對：原草稿 DRAFT v37／18 active items／7 accounted assets／0 unprepared；Source focus 為 all。此帳面完整不代表業務語義品質驗收。
- 上述診斷階段未部署；後續部署結果見下節。owned browser 已關閉，使用者視窗未動。保留 tracking 被阻擋及 `Failed to fetch`，不宣稱零瀏覽器錯誤。

## 部署及自行驗證

- 只重載可信 Host 的單一修正模組。Runtime 映像、SDK、設定、MFE、Source 政策、模型及預算均未變；8 個 Core 容器未重啟。
- 新 Host PID `2252529`；舊 `2118164` 正常退休，不可重新啟動。設定仍為 `.local/agent-server-semantic-source-governance-20261011-oiYpPD.json`。
- 凍結候選 Host 與既有精確 SDK 映像，在 credential-free、network-none、read-only、CPU1／RAM1GiB／swap0 容器內通過 168 項檢查。修正與完整 NEW revise 成功路徑是合成 public API 驗證，不是真模型原生寫入。
- Windows Edge 真 `/mfe/agent` 兩輪整頁核對原中文草稿：DRAFT v37／18 項完整顯示，112 次 semantic READ 全部 HTTP200；DRAFT 選取及確認框停用、確認框未勾選，發布按鈕停用。完整載入約 38.8 秒，沒有宣稱延遲消失。
- 18 個真入口 Runtime 資產 hash 與既有映像相符；跨 Source 的只讀負例仍拒絕。
- 6 份完整 Root manifest、42 份可讀完整 Review／歷史及兩筆既有相依漂移拒絕前後一致。兩個 HOME 共 47 份 journal 的 SHA／大小／mtime 不變。
- 初版 UI caller 誤以為 DRAFT 不應有確認框 DOM；實際契約是顯示停用、未勾選的確認框。保留失敗證據，修正 caller 後兩輪成功，沒有改產品 UI 或放寬確認限制。
- 零新提示、準備、原生 Root、確認、發布、詞彙搬移及 Source 寫入。所有 owned contexts 均關閉。

診斷證據：`.local/evidence/semantic-sales-zh-abort-20261011-XomYBp/`。部署證據：`.local/evidence/semantic-aspect-overlap-deploy-20261011-JVOKDuaP/validation.json`。完整 Sales／AdventureWorks 語義品質及真 changed-round 仍未完成。

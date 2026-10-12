# 語義維護增量回覆與版本感知：本地驗證

日期：2026-10-11  
狀態：**本地修正與合成驗證完成；後續已獲准部署並通過真入口只讀驗證。** 詳見[增量／容量／閒置重連部署](datahub-semantic-incremental-capacity-idle-deploy-20261011.md)。下列本地收據保留原時間與範圍。

## 修正內容

成功的 `prepare_maintenance`／`revise_maintenance` 不再向 Agent 重列同頁所有既有項目。SDK 在可信傳輸加 `responseMode:"incremental"`，Host 只回本次項目；這是呈現選項，不增加模型的業務工具參數或授權。

回覆保留 `datahub-semantic.maintenance/1`，新增：

- `delivery:"incremental"`、`preparedItemId`；修訂另有 `revisedItemId`。
- `items` 僅一筆，保留精確 `definition.reference`、`reviewRef`、`childVersion`、`planDigest`、依賴、supersedes 與狀態。
- `runVersion` 為確認此次連結後的原生 Root 版本；Source／governance／scopeDigest 與 accounted／unprepared 計數仍保留。
- `delta={baseVersion,completePlan:false,resyncRequired}`。定義修訂或準備期間有其他 Root 更新，要求完整重新同步。回覆讀取期間 Root 再漂移則拒絕，不回過期 ACK。

模型逐筆等待成功 ACK，自己在下一個**新意圖**明確引用最新版本與已確認定義；SDK不代填、合併候選、快取 ACL、刷新或重播請求。新啟空 Root 與本提示連續 ACK 已能辨識本輪工作，不要求逐筆重讀整份 Root。重新接續、知識不完整、版本不連續或 resync 時仍須讀回；修改既存項仍先讀其完整舊輸入與目前來源證據。

## 沒有縮減的保障

- 原生提案、完整 Aspect 前後值、理由、證據、歷史及發布契約不變；沒有新增 datastore 或 Core patch。
- 未指定增量模式的既有寫入回覆，以及 `read_maintenance` 的完整分頁維持原格式。增量卡片明示「不是完整計畫」。
- 可信父頁明確拒絕把增量 ACK 當完整 manifest；照舊讀齊所有項目、完整 digest-bound Review 與最後版本，才開放真人確認。
- Source／ACL／CAS、同 Aspect 整筆修訂、UNKNOWN／失 ACK 停止與一次性 consent 保持。格式錯誤或失 ACK 不代表原生 proposal 未保存，不自動換 UUID 重試。
- [Review 容量無損修正](datahub-semantic-sales-review-capacity-20261011.md)是另一接點；本輪效率修正不能替舊失敗回填零效果證明，也不提高容量上限。

## 已驗證

1. Host 公開入口：定義 → 引用定義套用，ACK 只含新項且完整讀回仍包含所有舊項。定義替換保留歷史並要求 resync；舊 consumer 失效，seal 拒絕。
2. SDK → 實際 Host → 合成 DataHub API：三筆依序準備直接沿用上一筆 ACK 的版本／引用；中途 **0 次 `read_maintenance`**，最後再完整讀回。這證明介面可省去例行讀取，不是已量測真模型的新呼叫數或 token 降幅。
3. 錯誤增量 ACK／失 ACK：只派送一次，保留 unconfirmed 定位並停止；沒有修補、重播或目標寫入。過期版本、撤權、無真人 consent 及重複 publication 仍拒絕。
4. 語義相關回歸 **392/392 PASS**；固定 SDK 0.85.1 的現有生命周期／批次回歸 **48/48 PASS**。TypeScript 全案 noEmit／非 incremental 及修改檔 ESLint 通過。
5. 既有 Playwright／Chromium、loopback 合成 API、實際 AppShell／卡片／父頁：390／1440 寬度，增量卡片 → 全計畫 → 確認前零目標寫入 → 一次整批確認；含合成後續定義更新、UNKNOWN 暫緩及142項完整計畫回歸。owned browser／HTTP servers 已關閉。
6. 593 個 Pi Web downstream 檔案、反向 patch、官方506檔原始基線與3個 foundation checks 通過。UI detector 無項目；LSP 有33個 advisory、5個未確認結果，**不宣稱 workspace clean**。

首次回歸的兩個測試仍把最後 ACK 當全清單，已改以完整讀回核對舊項；瀏覽器既有 literal 文字重複呈現造成 strict locator 失敗，只修 caller，保留失敗紀錄。沒有以降低保護條件取得通過。

## 未驗證與部署邊界

未呼叫真模型、未修改真實原生資料、未續跑既有 Sales 草稿或重送失敗請求。Sales／AdventureWorks 完整語義品質與真實證據變更輪次仍未完成。

本輪修改 Host、SDK／Skill、卡片及父頁 loader，**不能只 reload Host 沿用舊 SDK image**。後續使用者明確批准增量／容量，另加入閒置重連；隔離固定 SDK／MFE 已建置，fresh idle／身份／原生歷史／journals／來源與產物 pins 通過後切換。部署授權已消耗；沒有真模型準備或發布驗收。既有真人 publication consent 和已消耗部署 helpers 均不可重用。

本地證據：`.local/evidence/semantic-maintenance-incremental-local-20261011-pmPJ6Qtp/`；完整 manifest 見 `validation.json`／`CHECKPOINT.md`。

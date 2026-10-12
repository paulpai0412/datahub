# 語義增量回覆、Review 容量與閒置重連：部署驗證

日期：2026-10-11  
狀態：**三項已部署，真入口只讀驗證完成。** 本輪授權已消耗；不含模型續作或原生發布。

## 使用者可見變化

- **增量回覆／版本感知**：成功準備或修訂只回本次項目、精確引用及新版本。增量 ACK 不是完整方案或 consent；重新接續／resync 與最終真人審核仍須完整讀回。
- **Review 容量**：放不下的重複定義按完整內容摘要保存一次，讀回時完整還原。候選、證據、完整 Aspect、容量上限及發布保護不減少。
- **閒置重連**：心跳失敗後只自動嘗試一次新的登入核對／bootstrap，換用新 iframe。登入無效則停止並提供明確重連按鈕，不重播模型或業務操作。

三項實作依據：[增量回覆](datahub-semantic-maintenance-incremental-20261011.md)、[容量修正](datahub-semantic-sales-review-capacity-20261011.md)、[閒置恢復](datahub-agent-idle-workspace-recovery-20261011.md)。

## 建置與切換

使用者先批准增量／容量，後明確加入閒置重連。原驗證登入導向 `/login`；使用者另批准專用登入視窗，本人登入後核對原 Actor，視窗已關閉，owned 暫存 profile 已移除。沒有讀取或填寫密碼，也未操作使用者原有視窗。

隔離 candidate 固定 593 個 Pi Web 檔案；與前版相比只有 SDK、Skill、增量卡片三檔變更。反向 patch 精確還原官方506檔。Host 為四個相關模組；MFE 同時包含增量 manifest 防護與閒置恢復。沒有 checkout Next build、Core patch、新 datastore、相依安裝或 commit／push。

既有專用 builder 限一 CPU、3 GiB RAM、零額外 swap；完成後已停止。fresh Actor／全部 runtime idle、七個原生 Root heads、兩份 HOME journals、Source／設定／映像／MFE pins 通過，才正常 graceful 切換。

部署基準：

| 項目 | 已驗證值 |
| --- | --- |
| Host | PID `3933040`；舊 `2252529` 正常退休，不復活 |
| 固定映像 | `sha256:d426bfa1c61f0cfb2cd05938bcdfab94e1d5d0520f5ec93565b114898db21018` |
| 設定 SHA-256 | `e42dfdce0bf271df3a26beaa00b626a4e1d01d1e80dfe9eaa4cc3eda6534c629` |
| MFE `89.js` SHA-256 | `2562fd0ffe35724298ed8fe11a8991c15f12813ddf51e548a0b02ee8dae15768` |

設定只改 `runtimeImageId`／`browserAssetsDirectory`。Source、ACL、模型、工具、預算及其他設定不變；`remoteEntry.js` 不變。不是只重載 Host 並沿用舊 SDK。

## 驗證結果

- 精確映像：593 份來源與223個 browser assets 相符；credential-free／network-none／read-only 合成檢查 **286/286 PASS**，涵蓋增量 SDK→Host、27欄容量、歷史／人工內容、權限／CAS／失 ACK／無 consent／重播拒絕及閒置 MFE。
- 已固定的本地完整語義回歸 **392/392**、SDK 生命周期／批次 **48/48** 結果沿用；不是再宣稱全部套件都在 Pi runtime 映像執行。
- Windows Node／既有 Playwright／Edge 真 `/mfe/agent`：18個載入產物符合新映像；`get_tools` 的版本感知／增量指引已更新。Sales Source 引用範圍外資產仍拒絕。
- 真閒置恢復：只暫停 owned 父頁 JS 96秒。心跳 HTTP401後，**一次**新 bootstrap HTTP200、exchange HTTP200，新 iframe／WindowProxy 以同一 Actor 恢復。沒有整頁刷新或重新登入，沒有模型續跑／consent 移轉。
- 已發布13項的父頁開啟與整頁刷新，兩輪均完整讀齊，合計82次 READ200；全量呈現約62.785／53.247秒。載入期間確認鎖定；完整 CONFIRMED 計畫沒有新增批准框，已消耗項目的 publisher 保持停用。
- 前後七個完整 Root manifests、57份完整 Review **及其歷史**一致；兩份既有 dependency-drift Review 仍按原錯誤拒絕。AdventureWorks 比對完整 manifest，未重讀其全部142份完整 Review。
- 兩份 HOME 共48份 journal 的 SHA／大小／mtime 相同；八個 Core container 的 ID／image／啟動時間／狀態相同。所有 owned 驗證視窗已關閉。

## 保留的失敗與限制

第一輪映像檢查錯把 Host-only Python／Sales source／Core fixture 套件放進 Pi runtime，結果305/326、21個缺依賴失敗，原紀錄保留。修正檢查邊界後286/286；沒有安裝 Python、放寬產品保護或把原結果稱為全通過。亦保留 sourcePins 格式、private webpack cwd、過期登入基線及 CONFIRMED 按鈕文字的 caller 失敗；修正 caller，沒有重跑部署效果。

Tracking 阻擋及 `Failed to fetch` 紀錄保留，不宣稱 browser／workspace／LSP clean。閒置驗證是受控的真 grant 到期路徑，不是自然背景限速、睡眠或所有瀏覽器情境的驗收。

**沒有新模型提示、原生準備／Root／seal、真人批准、publication、Source 寫入、SQL 或 ingestion。** 原未確認操作、UNKNOWN 及成功項沒有重送或追認。真模型效率／token 改善、Sales／AdventureWorks 完整語義品質及真實 changed-round 仍未驗收。

## 恢復與證據

私有證據：`.local/evidence/semantic-incremental-capacity-deploy-20261011-jQYbDHvs/`；`validation.json` 為 `DEPLOYED_INCREMENTAL_CAPACITY_IDLE_READONLY_ENTRYPOINT_VERIFIED`，授權 `COMPLETE_CONSUMED`。

舊 Source 治理基準的映像 `28724d6d…`／設定 `8a31769d…`、舊 MFE及57份 Host module pins 已保留供回復準備，**未執行 rollback**。回復需要新的明確授權、fresh Actor／idle／原生結果／journals／pins；不重跑本次或舊 one-shot helper，不復活退休 PID，不誤用更早的治理基準。

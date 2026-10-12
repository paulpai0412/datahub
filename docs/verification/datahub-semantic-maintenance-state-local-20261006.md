# 原生語義維護範圍與封存條件：本地驗證（2026-10-06）

**本地契約實作完成；本文記錄部署前檢查。** 新版後續已部署並啟動唯一新模型輪次，見[部署驗證](datahub-semantic-maintenance-scope-live-20261006.md)；完整語義代管仍未交付。使用者要求朝完整目標實作，不以補丁、hardcode 或程式代替 Agent 判斷。

## 已成立的行為

既有 `read_maintenance` 新增 `view:"scope"／"unprepared"`，回傳獨立 `datahub-semantic.maintenance-scope/1` JSON：

- 原生 Task 本計畫選定資產，或其中尚無 active 套用／KEEP／GAP 的精確資產；20資產／頁，有 offset／nextOffset、原生 runVersion 及 scopeDigest。
- 全計畫 assetCount／accountedAssetCount／unpreparedAssetCount；同資產多項只帳平一次，定義證據anchor及 superseded 項目不冒充套用。
- `sealing.checks` 的 condition／met／error，與實際 seal 共用同一函式。尚未封存、Run未關閉、有項目、依賴仍有效、選定資產均有紀錄各自列明。
- `structurallyReady` 不代表語義完整、品質、授權或發布；`semanticCompletenessVerified:false`。已選 Catalog 計畫 `completeSourceInventoryRequired:false`，不放寬舊managed／AUTO或完整來源inventory宣稱。
- 原生身分、目前 Source 範圍、每頁metadata ACL、同版本分頁及讀取期間Root／Source變更核對。沒有active紀錄不證明歷史零效果，也不授權UNKNOWN重播。

SDK schema 接受明確 view，原樣傳遞；核對回應格式、view、offset及明示版本。沒有選下一資產／action、自動修訂、封存、批准、發布或重試。Skill及既有前景提示說明本計畫範圍，不將舊managed／AUTO條件移植到整批Catalog主線。

只使用現有 Task／Run／Decision／公開API；沒有新store、controller、業務狀態權威、Core變更、來源／資產／數量／語義答案hardcode。現有單資產及整份items視圖、真人整批確認與publisher保持原路徑。

契約：[設計第10節](../design/datahub-semantic-maintenance-workflow-first.md)。

## 最初本地階段的實際檢查

以下為初始source／receipt紀錄。部署準備時把需要專案fixtures的SDK→Host整合測試移到 `tests/test_agent_semantic_maintenance_scope_sdk.mjs`，移動後2/2通過；本次映像為588app檔，不是初始589。原本地證據保留。

- 原生維護／Catalog／transport／readonly／MFE：87/87。包括動態混合資產範圍、定義anchor排除、GAP／KEEP與PENDING不冒充語義完整、同資產修訂／supersession、91資產分頁、依賴失效與明確consumer修訂、ACL／Source撤回、讀取中漂移及link偽裝拒絕。
- 固定SDK／RPC／前景／inspection／own-ACK／工具政策及新SDK→实际Host→合成原生API讀取：75/75。新視圖只讀，不從歷史重新啟動續作；錯format／view／offset／version沿原未確認收據＋abort，沒有重送。
- TypeScript `tsc --noEmit --incremental false`、兩個 changed SDK files 的 ESLint、scoped diff檢查通過。
- 新downstream 589檔source及reverse精確還原原506檔，原始foundation／Catalog三項通過；原upstream lock不變。僅工具、Skill及新增scope測試三個downstream paths變更。
- 四檔fresh LSP零回報，但全部inconclusive；不宣稱workspace／LSP已確認乾淨。

原生RED是旧Host不接受view欄位。首次SDK新負例錯把現行typed未確認收據契約當throw，僅修測試斷言並驗abort，沒有放寬程式；失敗證據保留。一個codemode腳本語法錯誤在派送前拒絕，工具未執行；修正腳本後才運行最終檢查。

本輪證據：`.local/evidence/semantic-maintenance-state-local-20261006-5EptBP/`，含before bytes、原始失敗、最終logs及CHECKPOINT；不公開私有原生／對話資料。

## 尚未成立的完成線

測試全部使用合成public API／模型或直接SDK工具；已有合成首輪五類定義／套用、真人一次確認及真正fixture evidence變更後的後續輪次，**不是live模型、真來源、真語義發布或UI驗收**。

在本文最初本地階段，沒有build／image交換／部署、新真模型提示、原生Task寫入、真人consent、語義目標發布、SQL／ingestion或Source／模型／預算變更。其後已按明確授權部署、真入口讀回原計畫及啟動唯一新提示；詳情由部署驗證報告記錄，沒有重播歷史成功操作。

部署及唯一新提示的授權已取得並執行；不可再重送。待本輪結果成立，Agent仍必須自主完成有據完整方案與自查送審，才交真人一次精確確認；實際發布／原生與UI讀回、真正變更後第二輪仍是完整交付的必要条件。

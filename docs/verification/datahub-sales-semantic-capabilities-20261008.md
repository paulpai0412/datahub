# SalesDatamart：來源限定語義維護能力已啟用

## 結果

2026-10-08 使用者實際呼叫 `datahub_semantic/start_maintenance`，代表工具已被模型使用；Host 回 `semantic_publication_not_authorized`。唯讀確認該 SalesDatamart 來源只有 metadata 讀取／預覽能力，原生維護提案能力未開啟。此來源不同於此前完成整批發布的 AdventureWorks；不能套用另一來源的授權。

使用者明確批准 SalesDatamart 的來源限定維護設定及必要 Agent Host 重載後，已啟用：
- 建立審核提案與人工核准後發布能力。
- 共用定義新增提案能力。
- 共用定義修改提案能力。

**範圍保持既有 7 個 Dataset。每輪仍須真人在可信父頁確認完整方案，才可發布。** 共用定義仍需 ACL、精確版本及影響證據；這不是任意修改全部定義的授權。

## 實作與驗證

只有目標來源的三個 capability booleans 從 false 改為 true。其餘設定逐值一致：其他來源、Dataset scope、SQL、ingestion、AUTO、模型、預算、Agent 身分及 audit audience 不變。

- 98 個 Host 支援層、593 個 app 來源 pins 均與原部署一致；沒有改程式或重新建置。
- 實際 `ingestionPolicies` validator 通過新設定。
- 閒置檢查通過後，只重載本案 Agent Host。沿用同一個已驗證映像 `779d9c40…`。
- 從真入口，使用 Windows 原生 Edge 154.0.4258.53 的新測試 profile，在可信父頁讀回三個能力已開啟、scope 仍為 7；來源仍為 deployment-managed。
- 原兩個對話的 model、thinking、active tool schemas 保持一致。
- 原 CONFIRMED v325、全 142 項及 planDigest 精確不變；MFE served bytes 不變。
- 兩 HOME／42 journals 的 SHA、size、mtime 完全不變；測試瀏覽器均已關閉。
- 沒有送模型請求、建立真維護草稿、執行 SQL 或發布 metadata；未 commit／push。

本次能力重載完成時 Host PID `275437`（後續恢復接點部署已由 `917929` 取代，詳見[舊拒絕恢復驗證](datahub-semantic-start-recovery-20261008.md)）；設定 `.local/agent-server-sales-semantic-capabilities-20261008-y0NHtQ.json`，SHA `4865167ddf492d4881308a7a58a6a565baa34e838709dfeff4a0bf8bf7528070`。舊 Host `3820831` 已退休，不重啟。

## 開權後再次手動觸發：仍是旧回覆，不是新的 Host 拒絕

後續唯讀診斷確認，最新 SalesDatamart 對話的完整 active branch 只有 10 則訊息。原 `list_sources` 和唯一 `start_maintenance` 都在 02:55Z；能力於 03:24Z 生效；04:59Z 的再次 skill 輸入後，模型沒有重新讀政策、再次呼叫 start 或核對原生紀錄，而是引用了舊拒絕。實際 Windows Edge 讀回三種能力仍開啟，精確 Sales 對話的 Semantic／Catalog 皆啟用、Luna high／idle，沒有新的 Host 拒絕證據。

原回執的 reconciliation 只有 requestId，沒有 Task／Run 定位。SDK 按未確認寫入停止該輪，不自動重送；這不是永久封鎖所有新提示，但不能把舊拒絕當目前政策或零效果證明。

因此，設定驗證已通過，**Agent 從舊拒絕安全恢復的執行流程仍未完成**。需要重新讀當前政策，補上原精確紀錄的可信唯讀對帳，再依新意圖推進；不是加權限、重新登入、換對話清洗歷史或重送原 request。本次診斷沒有模型請求、配置／部署變更或維護寫入。

私有診斷與 owned browser 關閉證據：`sales-post-grant-denial-diagnosis-20261008-zLHgkV/`，位於與本次啟用相同的 evidence 父目錄。

## 拒絕邊界與未完成事項

`start_maintenance` 會保存原生 Task／Run，不只是生成文字預覽，因此要求來源具備審核提案能力。實際 Host fixture 重現：能力關閉時拒絕、native record／target writes 都為零；新的 synthetic intent 開啟該能力後能建立 DRAFT，但沒有發布 metadata，也不等於真人確認。

此 fixture 不是原失敗 request 的原生效果對帳。**原 request 的 `retryAllowed:false`、SDK 停止與歷史保持不變，未重送或追認。** 設定更新不是批准重播原操作，也不是新的模型執行授權。

重新整理整個 DataHub Agent 頁面可取得重載後的父頁連線，不需反覆重新登入。後續新維護仍須新鮮盤點、證據與原生結果核對；本次只完成能力設定與唯讀驗證，不宣稱新首輪維護或真正變更第二輪完成。

私有證據：`.local/evidence/semantic-autonomous-plan-20261005-ScQzQE/sales-semantic-capability-reload-20261008-y0NHtQ/` 的 authority／stage／validation-final、live-before／after、fresh idle、reload／launch 及 journals 保存核對。來源拒絕診斷及 caller 失敗另保留在 `source-maintenance-auth-diagnosis-20261008-EpyDlr/`。安全護欄攔截 tracking 的 browser errors 保留，不宣稱零 pageerrors。

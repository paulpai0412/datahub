# 使用來源：人工審核語義授權 UI — 2026-10-03

## 結果

已部署至 <http://localhost:9002/mfe/agent>。設定 → 使用來源 → AdventureWorks 提供三項独立能力：

1. 允許建立審核提案與人工核准後發布。
2. 允許提案新增共用定義。
3. 允許提案修改共用定義。

發布範圍沿用頁面選取的Dataset／欄位；AdventureWorks目前91Dataset／744欄，非最新完整掃描的保證。發布Agent僅能選目前actor已有Host配置的身分，稽核範圍固定既有Task／Run ACL。共用定義授權不取代既有ACL、完整影響範圍、版本／CAS及人工審核要求。現有bounded影響讀取不能证明全域完整，共用定義修改仍可能被拒；Structured Property schema migration未啟用。

**部署未開啟任何新發布權限，也未建立真提案／修改metadata。** 管理員仍須在頁面選取所需能力，查看可信父頁面完整前後差異並確認。原`semantic_publication_not_authorized`在未授權前仍是正確拒絕；保存授權後應重新inspect／preview，不沿用授權改變前的snapshot／review。

## 原因與修復

原Source UI明確保存`semanticPublicationApproved:false`，缺少發布所需Agent/audience；Catalog可發布審核編譯要求三者同時成立，因此來源讀取／預覽和SQL連線不等於審核發布權限。

修復在既有Source設定Host/MFE/React主責完成，未放寬compiler或native publisher。UI主責政策附`sourceSettingsManaged:true`於既有operator JSON，允許後續撤權／修改；舊部署端未標記的發布政策、execution、AUTO及audit-recovery仍受保護。兩個definition權限依賴review；關閉review會清除兩者，停用metadata會清除全部三項。舊metadata-only caller不能默默覆寫已有發布授權。Actor隔離、原生雙管理權限、精確scope／recipe、parent proof、plan digest、CAS／atomicwrite／即時套用維持。

## 驗證層次

- **離線回歸**：331/331相關Node檢查通過；涵蓋typed Catalog compiler原拒絕→新UI授權後成功→撤權拒絕、舊snapshot失效、獨立definition flags、偽造Agent/權限依賴、protected operator policy、錯actor、stale／競爭保存、ACL與回傳撤權、既有語義/連線/ingestion契約。
- **隔離真正React→MFE→Host**：1440／390px，預設只讀、parent consent、三能力保存及reload、精確移除、停用及撤權、空referrer、iframe直save拒絕與無overflow。Native資料／driver為fixture，不是live發布。
- **TS／lint**：`tsc --noEmit`、targeted ESLint均exit0。Fresh LSP無reported errors，但push-only silent-on-clean為inconclusive，尚有既有AST hints/warnings；不稱全域clean。
- **固定建置**：專用builder1CPU/3GiB/no-extra-swap/serial，583源檔與stage/image一致，browser artifacts逐檔核對；downstream reverse恢復原506檔並通過原foundation檢查。建置後builder停止，不改Core、模型jar、Compose、DB或其他服務。
- **真DataHub入口**：1440／390px讀回91Dataset／744fields，三能力預設關、只能選已配置Agent；兩次fresh native preview顯示全部三項關→開差異及91精確URN，保存按鈕需真人同意；均取消，reload後仍關，0pageerrors／overflow。只list／inspect／preview，無save／metadata／SQL／模型／AUTO。
- **保留**：37session files在2HOME的SHA/size/mtime完全相同；Sales7Dataset／69fields的native scope fingerprint不變；AdventureWorks與Sales查詢連線、Grafana/subject mapping及全部Source政策JSON值原樣保留。

## 現況與操作

Active Host PID154589，runtime image`sha256:4f5ff812663a68ca10f04da61cafa04f23d03b45667b939e76704d57ceae2b57`。設定路徑及完整操作證據保留於gitignored `.local/evidence/source-review-settings-deploy-20261003-AO9Oah/`的CHECKPOINT／final-receipt；不公開憑證或私人內容。後續真人保存會合法改變config SHA，操作前必須fresh核。

刷新整個DataHub頁面，進入設定 → 使用來源，選AdventureWorks、核對全91個Dataset，開所需能力並選已配置Agent；「檢查差異並保存」後在可信父頁面勾選確認。此為授權政策保存，不會直接套用Product metadata；建立的新提案仍需人工核准才執行。

本輪main-only，無子代理、commit/push或新依賴。部署／UI可用不等於AdventureWorks真語義發布、完整AUTO或產品第二輪已驗收。

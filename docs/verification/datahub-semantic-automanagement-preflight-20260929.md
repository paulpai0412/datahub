# SalesDatamart 語義代管：真範圍唯讀預檢＋本地輪次（未部署）

2026-09-29；本文件區分**真 API 唯讀證據、本地 fixture 檢查、尚未執行的正式發布**，不是自動發布或完整 E2E 收據。對應 `TODO-8cf5df9a`。

## 現場唯讀結果

- 指定 Source：`urn:li:dataHubIngestionSource:c382a4fe-48a9-4a0b-893a-95029a74b25f`。最新成功原生 Run：`urn:li:dataHubExecutionRequest:f9a55669-6c27-49f5-9ff0-d8f04e1f48f5`。
- 目前 Source recipe 為固定 MSSQL allowlist，六個 `dm` 表＋一個 `reporting.v_sales_order_line` view；七個 Dataset 的目前 `schemaMetadata.systemMetadata.runId` 與 `pipelineName` 均指向該 Run／Source。**七個 Dataset、69 個 distinct fieldPath**。版本化 `extensions/sales-datamart/metadata/target-ingestion.json` 已與現場 allowlist 對齊。
- Stateful ingestion 關閉，**沒有已核對的 checkpoint**；成功 Run＋精確封閉 recipe＋七個當前 schema provenance 僅證明上述範圍，並非整庫、非 Dataset Catalog 資產或下一次 Run 的完整清單。先前誤把名稱「6 objects」當作當前 recipe 分母的假設已被真 recipe／Run／schema 讀回推翻，未為此重跑 ingestion。
- `semantic-managed-scope.mjs` 的真 API 唯讀 probe 成功；收據：`.local/evidence/semantic-automanagement-20260929/live-readonly-scope.json` 與 `.log`。該 probe **暫時在記憶體內克隆政策**以測 Reader，不會修改部署政策或證明正式 Agent 能使用此入口。現行 Source recipe pin `57d0a19e…` 與現場 `b535e56e…` 不同，且正式 Sales policy 尚無 Semantic model opt-in；原政策的 Reader 確實回 `semantic_managed_scope_unverified`。原失敗與修正後唯讀 probe 不互相取代。

## 本地實作與真唯讀證據（未部署）

- `datahub_semantic` 的 `inspect_managed_scope` 經可信 Host 原生 Source／Run／Dataset 公開 API、身分和各資產可見性核對；只支援 pinned MSSQL connector 的固定 regex，拒絕模糊 regex、排除、重複、政策 pin 不符、Run 失敗、漏列與 provenance 漂移。回傳 fingerprint、七資產全部 fieldPath、分母及 `checkpointVerified:false`，不帶 recipe／憑證；`publicationAuthorized:false`。
- 真 Catalog 唯讀全頁核對：七個 Dataset／69 欄，**來源 Dataset 說明 0／7、來源欄位說明 0／69**；已有 editable Dataset 說明 1、Domain 1、editable 欄位說明 1、欄位 Tag 1。收據 `.local/evidence/semantic-automanagement-20260929/live-catalog-coverage.json`；首次缺 snapshotDigest 的錯誤留在原始 log，後續成功不能抹掉前次失敗。
- `semantic-managed-evidence.mjs` 僅接受本案固定 `extensions/sales-datamart/metadata/metrics.md` 的 SHA-256 `a10923a6280d63bb3528b1f51ac83afc047650284b7fd195a00ef3b80dbd7c0a`；只抽取欄位主語完全相符的公式，不提升欄名猜測或全文成業務證據。真 API **唯讀**編譯候選 `fact_sales_order_line.linenetamount`：before 空，預期 `editableSchemaMetadata` 版本3 CAS，計畫 digest 見 `.local/evidence/semantic-automanagement-20260929/live-candidate-readonly.json`；只在記憶體內克隆政策，沒有建立 Task／Run、批准、嘗試或目標寫入。把固定契約與唯讀七個 schema 的 fieldPath 做離線精確比對，**只有3個潛在欄位主語**（fact/view 的 `linenetamount` 與 monthly summary 的 `quantity`）；只有上述 fact 欄完成完整 before／ACL／typed compiler 預檢，另2個不稱可發布。
- 本地 `semantic-managed-policy.mjs`／`semantic-managed-cycle.mjs` 和 `native-semantic-tasks.mjs` 提供未配置寫政策的唯讀、`REVIEW` 真人逐項、`AUTO` 可信 Host 政策內新增／補值模式。原生 Task／Run／Decision 綁 Source、Run、actor、政策 digest、scope fingerprint 和兩小時輪次 lease；76 項逐項 verified／exception 收據，分頁20。AUTO 用既有 compiler/publisher 的版本 CAS、完整 Aspect 讀回與唯一 attempt；初始 `outcomeJson` 不因日後 MATCHED 被追認，UNKNOWN 仍待對帳。合成測試涵蓋撤權／到期、人工值、假意義、Lost ACK、覆蓋、REVIEW 不自行核准；此處的「PASS」不等於現場自動 E2E。
- pi-web 的 `DataHubSemanticManagedCycle.tsx` 僅把 Host 回傳的分母、下一頁、例外、UNKNOWN 收據呈現成無寫入權的瀏覽器卡片；歷史結果標成快照，保留後續向 Host 讀回。source render／逃逸／界線測試已加；**未在部署的 DataHub／真瀏覽器驗收**。
- 最終本地檢查：九組後端相關 suite **123／123 PASS**（`.local/evidence/semantic-automanagement-20260929/local-regression-final-r2.log`）；六組 pi-web 關聯 suite **43／43 PASS**（`local-ui-regression-final.log`），`npx tsc --noEmit`、新組件 scoped ESLint、13 檔 primary LSP 0 error、tracked diff check 與 transport 語法檢查 PASS。`lens_diagnostics(mode=all)` 先報新組件 complexity／inline-style 三個非阻擋提示；最終快取另出現 transport／managed-policy 的 line-past-EOF stale 診斷，當前兩檔 `node --check` 與 primary LSP 均乾淨。這些不是全專案或現場部署驗收。

## 尚未完成／不能宣稱

- **正式政策 pin／opt-in、限定部署、真 Agent／原生 API／瀏覽器 UI／歷史自動發布 E2E 尚未執行。**現行 9041 仍是舊人審制；本地原型不等於已上線。整批一次審核 UI、共用定義安全建立／更新與三方語義更新合約仍不足；76 項覆蓋不是整個業務語義層完成，也不是 76 項發布。自動 metadata 寫入風險高，部署前還須新鮮獨立 no-write review；Task Pi preflight 目前 `available:false`、`loaded-runtime-changed`、digest `ef1eeccf866d30de3e5c8027dc6d7a8da74d170964d66f99c57927f1f498eae3`，未 dispatch 或把離線測試當 review。
- 共用定義影響範圍外、來源無足夠語義證據或人工值無可靠 provenance 時應留例外；不得靠 bounded search 宣稱完整，也不得把 DataHub `If-Version-Match` 誤稱批次交易。
- 最新成功 Run 已滿足本次七物件範圍預檢，故未動用「必要時限定 metadata-only ingestion」授權。若 recipe／Run／schema 後續變更須重新對帳，不能沿用此收據。既有 Catalog 主線封存與 UNKNOWN 維持原狀；無 Core 修改、新 datastore、commit／push。

## 後續審查／限定真驗收計畫（**尚未授權執行**）

1. 在 Task Pi 正常路徑恢復且人類確認完整 model／thinking plan 後，以**新鮮、唯讀、無 shell／不寫檔**的獨立 reviewer 檢查最終 dirty source：政策跨來源／撤權、初始 outcome vs 後續 readback、CAS 部分成功、Review 真人權限、UI 無寫入控制。`loaded-runtime-changed` 時不 dispatch；先安全 reload 與另准有界 readiness canary，不改寫 readiness。
2. 於目標 9041／DataHub 現場**先唯讀**核 idle、真 SHA／版本、當前 Task/Run 原生 ACL、Source 最新成功 Run、七 schema、欄位 before、既有 policy。提出差異供核：SalesDatamart Source 的 recipe pin `b535e56eaa31f0546ed3ab6f4e32b6516d1e4ead6d5356a02f7543b14e4b27d1`、精確七資產、Semantic model opt-in、`semanticEvidenceSha256` 固定 `a10923…`、限時綁 Run 的 `AUTO` 僅 description 且 `allowedTargets` **唯一** `dm.fact_sales_order_line.linenetamount`、新 ID／有效期／operator／審核者；其餘來源政策不變。可撤回須透過可信 Host 重新載入設定，未確認切換前不推定生效。
3. **取得本輪明確核准後**，只切本案必要 Host runtime／MFE／browser assets 和上述受限政策；保留 HOME／登入／歷史，無 DataHub Core patch、Source DB 讀寫、ingestion 重跑、全域 ACL、其他專案服務或憑證輸出。若需要 GMS 停機／模型變更／擴權／SQL，另停下確認。
4. 先真 Agent 唯讀 `inspect_managed_scope`，驗與原收據不同時立即停止。canary 政策只允許 `dm.fact_sales_order_line.linenetamount` 的**完全相同契約公式**補入空白 editable 說明；重新編譯當前 before／CAS／policy，原生 Task/Run/Decision 初始 outcome、目標 Aspect 全值與 DataHub UI／歷史讀回。lost ACK 或任何不一致即唯讀對帳，不重播。其餘75目標僅逐項例外並驗分頁／總數；不把例外算成已發布。
5. 待限制性 canary 通過才決定是否留下到期的自動政策／擴大安全候選，或立即撤回至唯讀。真入口/瀏覽器/原生 API、範圍覆蓋、反例和 failure receipts 另立本輪封存；未通過不宣稱交付「全語義層」。

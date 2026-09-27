# Semantic 私密模型本地驗證：0.1.9 模型通過，原生 ACL 待驗

狀態：**LOCAL MODEL PASS／未部署／未發布**。使用者確認指定 actor 政策後，模型載入阻擋已避開；原生 ACL 及 Host 完整資產發布仍未完成。這不是 SalesDatamart 全資產語意完成報告。

## 本輪授權與範圍

使用者已同意本地實作完整 Catalog 資產路徑：精確選取 Dataset、Container、DataFlow、DataJob、Chart、Dashboard，逐項绑定原生身分、ACL、版本及來源／關聯證據；SQL Dataset 保留 ingestion 驗證，其他類型不得偽裝成同一次 ingestion。新審核的可讀者限定 `datahub`，保留原生管理員權限，原先選擇官方自訂 Entity＋ownership／型別政策方向。

此次沒有切換 GMS、Agent、全域政策、Source、模型服務或部署。沒有 metadata 寫入、SQL、ETL、ingestion、送審或代按批准。舊 S3 記錄及保留的 Agent session 未改動。原本 35 個可見資產仍不是完整 Source inventory。

## 已實作的候選

位置：`extensions/datahub-agent/models/`，來源版本 **0.1.9**。只能作下一階段受控測試候選，未獲現場部署／政策變更授權。

- 新 Entity `ekopSemanticReview`；opaque key，不把資產、actor 或提案內容編入 URN。
- 新 `ekopSemanticTask`／`ekopSemanticRun` Aspects，兩者都在新 Entity，不把私密內容放回公開 `dataJob`／`dataProcessInstance`。
- 明列 tenant、可信 actor、Source context、精確 Catalog `assets` 與 session／Task revision。Source context 不表示每個資產的 ingestion membership。
- 共用 publication review 增加 optional `assets`；舊 `datasets` 的 Dataset 型別限制沒有放寬。沒有新增 datastore。
- 保留既有 Decision／typed verdict／attempt／closure 資料結構。Schema **不執行** ACL、append-only、SQL 禁止或 Host admission；這些仍需 Host 接線與驗證。
- 新私密 key／Task／Run 沒有 Searchable／Relationship annotation；這不保證 API／索引隔離。
- 新增可重跑 Pegasus 與官方 Registry loader 檢查。初版重用 ownership 失敗後，使用者核准改採原生指定 actor／型別政策；新候選不含 ownership／status，**必要 loader 檢查及完整新舊 merge 已通過**。沒有刪除或忽略 loader 檢查，也沒有修改 Core。

**尚未實作／驗收**：新 Host 私密路由、六類資產 compiler／writer、MFE 審核整合、原生 ACL 正反例與真正發布。沒有把模型支援的欄位當成這些能力已完成。

## 實際證据

所有建置使用既有固定 image、JDK 21／Gradle 8.14.3／Pegasus 29.74.2；驗過固定 GMS 的 **716 個 Core jars** hash。credential-free、network-none、1 CPU、3 GiB、無額外 swap、max-workers=1；沒有掛使用者 HOME、登入資訊、Docker socket或使用中服務資料。每次獨立 workspace 保留失敗，不覆寫既有 0.1.8 artifact。

證據根目錄：`.local/evidence/sales-semantic-enablement-20260927/`。

| 檢查 | 結果與真正範圍 |
| --- | --- |
| Pegasus 生成／Java 編譯 | PASS；只證明 schema／程式可編譯 |
| 舊 Task／Run／Decision roundtrip | PASS；沒有給舊記錄補出新授權 |
| 新私密模型 roundtrip／必要欄位／錯誤型別／額外欄位負例 | PASS；六類 `assets`、tenant／session／revision、review／verdict／attempt／closure 保留 |
| 官方 Patch／MergedEntityRegistry 載入候選 | 初版 **FAIL**；使用者核准指定 actor 方向後的新候選 **PASS**，含真正分開載入 0.1.8→0.1.9、原生 URN／key 轉換、private-only Aspects 與無敏感搜尋／關聯欄位檢查 |
| 最小 loader 判別實驗 | PASS **僅指成功重現缺口**；不是候選通過 |
| `node --test tests/test_agent_semantic*.mjs` | **75/75 PASS**，全部本地 fixture／既有路徑，不是真 API ACL／发布 |

最終候選建置：`model-build-qXhX6M/build.log`，**exit 0，16 個 Gradle tasks**。原生 checker 明確回報 `ekopAgentTask schema is compatible`，`ekopAgentRun` 的 optional `assets` 為 `OLD_READER_IGNORES_DATA`；不是用新版本 classes 自己比自己。產物位於該 workspace 的 `build/0.1.9/dist/`，SHA-256：`deb514102597d56ca7966ada47b2c33ddb3c76b9cf7c4675af17f54ad2d5ee70`。

`artifact-final.json` 核對目前所有 executable source 與建置 snapshot 相同；ZIP 僅 registry＋兩個插件 jars，82 個插件 classes、0 Core／test classes。Core submodule clean，沒有 commit／push。限定 Java LSP 兩個檔案中一個 clean、一個 timeout，不能稱兩檔 LSP 全通過；同 bytes 已由固定 JDK 真編譯及執行驗證。`lens_diagnostics(mode=all)` 僅本輪檔案無問題，非全 repo clean。原生 class discovery fallback、ANTLR 版本與 Gradle deprecation 訊息保留，不為消除訊息換工具鏈。

原失敗建置 `model-build-ov9X9h/build.log`（exit 1）完整保留，有兩個 codec checks PASS 與 registry FAIL；不能拿原 artifact 代替新候選。`loader-probe/probe.log`／`input.json` 保存最小對照。`semantic-regression.log` 保存 75 個既有路徑檢查。

早先三個失敗保留：`model-build-14Iaya` 的測試未宣告官方 `EntityRegistryException`（它直接 extends Throwable）；`model-build-MBoaa2` 的 Java boxed-number 比較；`model-build-xI3gxd` 的 JSON 字串欄位順序比較。測試修正為完整 JSON tree＋typed access，而非刪欄位或放寬模型。最終實測 `closedAt before=Long, after=Integer, sameSerializationOrder=false, sameJsonTree=true`，前值／後值／核准內容完整比較。

## 原生載入缺口：不是缺 jar，也不是新 PDL 拼錯

固定 Core libraries 下：

```text
ownership: core=true, plugin=false
status: core=true, plugin=false
AS_PACKAGED: confirmed Aspect ownership does not exist
CUSTOM_ONLY_CONTROL: native Patch/Merged loader succeeds;
                     ownership/status are NOT inherited
```

第一次對照僅在私有診斷目錄的 registry 副本移除 `ownership`／`status` 兩行；插件 jars 完全相同，當時未更改產品要求。其後使用者明確核准指定 actor 方向，才修改候選 registry 並從新 source snapshot 重新建置／驗完整 merge。沒有把診斷副本當作發布產物，也未宣稱原生 ownership 已修復。

對應固定 Core 原碼：

- `DataSchemaFactory.loadPdlClasses`：自訂 classloader 掃描後，移除 standard classloader 的 classes（`classes.removeAll(stdClasses)`）。
- `PatchEntityRegistry.buildAspectSpec`：只向該自訂 factory 查 Aspect，不從 base registry 補原生 Aspect；因此找不到 `ownership`。
- `PluginEntityRegistryLoader.loadOneRegistry`：正式載入同樣先建 `PatchEntityRegistry`，再 `parentRegistry.apply`；失敗發生在 merge 之前。

官方文件說明可重用原生 Aspects，但不能替代這個固定版本的實測。未修改 Core／loader、未打包或重定義原生 Ownership、未新增公開 mirror、未以 Host guard 假裝原生隔離。

## 已確認的替代方向與下一個必要條件

使用者已在本輪確認 **專屬新 Entity＋明確指定 `datahub` 的原生型別政策**，不依賴 ownership 自動授權；原生管理員仍保留。這符合目前固定讀者名單，但未來換人需明確調整 native policy，不會隨 Owner 自動轉移。本次只核准本地實作／測試，沒有核准現場部署或全域政策切換。

下一個原生相容性關卡需要獲准的隔離 DataHub 測試環境。檢查時本機總記憶體 15 GiB、available 約 2.9 GiB、swap 已用約 9.3 GiB；不足以不影響既有服務地假定可再啟動一套官方建議 8 GiB 的 Quickstart。沒有因此停掉其他專案或擅建第二套服務。需確認另一個隔離目標或資源安排，才可進行真 native API／政策 canary。

不論選哪個方向，全域 All Users VIEW grant 仍須排除新型別；不能只新增一條 scoped allow。正式切換政策／部署另需精確目標與操作授權，先以無敏感 canary 驗 owner／指定 actor、非 owner、管理員、歷史版本、generic／batchGet／search／scroll／GraphQL／MCP／Host／MFE 及普通 Catalog 不退化。原生隔離未通過前，新敏感審核保持停止。

簡短回顧：先跑固定版官方 loader，提前擋下「schema 編譯成功就能上線」的錯誤假設；75 個既有測試通過也不能消除這個必要證據失敗。

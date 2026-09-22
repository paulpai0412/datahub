# Semantic Steward S3：本地可信審核與條件發布

2026-09-22；工作樹 `feat/semantic-steward`，基準 `a25204e`。設計見 `docs/research/datahub-semantic-steward.md` §14。

**狀態：本地實作／合成閉環已驗，尚未部署或完成真模型／真 DataHub 發布驗收；S4 未實作。** 本段新增 live calls、SQL、metadata writes、ingestion、部署均為 0。先前已核准的一次 ingestion 已成功且授權用盡，不能重送。

## 已接通

- Skill／模型只可 preview、prepare、read。prepare 保存既有 Task／Run／Decision；它是提案 metadata 寫入，不是唯讀操作，也不是目標發布。
- custom card → trusted Host sidepanel → 逐項差異／證據／選取 → 明確核准當前 revision 並發布。iframe 不接收 verdict／selection／Aspect payload 權限。
- 選取縮減以一個 Run CAS 拒絕舊 plan、追加新 Decision；consent 不移轉。原生歷史 reload 可分別查看前後版本。
- Host 比對 actor/tenant key、exact pending Pi UI request、session、Source recipe／Run、ACL、schema／reference、期限、政策與 target versions。Gateway lazy runtime seam 已補測；唯讀操作不配置 runtime。
- 狹義 addition/fill-only compiler 保留既有人工／未知欄位與陣列順序。Steward provenance **不能**讓後續 legacy publisher 宣稱擁有整個 Aspect。舊 LINEAGE／SEMANTIC 路徑的 ownership 規則保留。
- exact schemaField key／v2 fieldPath、字串／數字 properties、policy owner／文件、五類 create-only 新定義。已存在 target／tombstone 不得採納或復活；定義與 association 分開核准。
- 每 Aspect 使用原生 CAS，非全域交易；永久 attempt 防重送。寫後 Source/schema/reference 核對、原生讀回與初始 outcome 分開保存。後來 MATCHED 不會改寫初始 UNKNOWN。closure 不被 outcome 寫入重新開啟。
- 準備提案的失敗回應保留 Task／Run／Decision 定位；整個 HTTP 回應遺失時，MFE 重用既有 Tasks URL locator 保留 intent。定位本身不代表紀錄存在或成功；只讀回，不自動重新準備／發布。

## 權限與稽核可見性

Source operator policy 的 `semanticPublicationApproved` 預設無權限，需同時開放模型 context、指定既有 `semanticAgentUrn`，並明列 `semanticAuditAudience: EXISTING_TASK_RUN_ACL`。新定義另需 `semanticDefinitionCreationApproved`。本段沒有改 live policy 或 recipe pin。

既有 Task／Run 曾實測可由其他 Catalog Reader 讀取；Host 的 owner check **不會**令 Native API 變成私人區。完整 before／after／evidence 只可保存已批准落入這組原生 ACL 的 metadata，禁止憑證。若要求更窄可見性，先以官方 Policy 配置並實測，不另建 store。這個 operator 確認不會自動修改或證明 native ACL。

## 最終檢查

證據根目錄為工作樹 `.local/evidence/semantic-steward/s3/`；原失敗與前次收據保留。

| 檢查 | 結果及實際涵蓋 |
|---|---|
| Semantic、Task records、Gateway、Ingestion、MFE mount、Host bridge | **169/169 PASS**，`integration-final.log` |
| 擴大 Discovery 回歸 | **20/21 PASS**；原有 `analysisVersion 1.0.3 !== 1.0.2` 失敗，兩個正式檔案均與初始 baseline 相同；未改測試掩蓋 |
| pi-web TypeScript | `tsc --noEmit --incremental false` exit 0 |
| MFE production webpack | exit 0；不是 pi-web next build，未啟動第二個 dev server |
| Browser review | 390／1440：實際 React card／跨 origin MFE／Host／records，**fake DataHub 與 native-session boundary**；逐項選取、鍵盤、人工值保留、reload 歷史、偽造 iframe verdict 拒絕、escaped markup、無 overflow，runtimeErrors=[]；每尺寸一次**模擬** target submission |
| Browser preview 回歸 | 390／1440：候選、定義、field properties、共享影響遮蔽、checkpoint scope；runtimeErrors=[] |
| Primary LSP | 最後 UI 6 檔、integration 7 檔 clean；gateway/server/Java 亦分別檢查，Java 最後修改後 clean |
| Lens session cache | 17 檔無 error；保留既有 `DataHubIngestionBridge.tsx` Next 71007 onRespond warning，不假扮 Server Action；不是全專案 clean 宣告 |

涵蓋負例：預設 opt-out／未確認 audit audience、人工值衝突、舊 source/schema/reference/policy/expiry、ACL／actor scope 變更、arbitrary extra payload、同名定義、tombstone、CAS race、partial、lost ACK、source race after CAS、lost approval ACK、incomplete preparation、concurrent closure、既有 ownership 不被 S3 locator 洗成整個 Aspect 所有權。

第一輪 broad run 的 fixed-ETL 測試 fixture 複製清單漏掉新共用 helper，已補 `semantic-preservation.mjs` 後依原測試重跑。失敗 `integration-first.log` 保留；沒有放寬 production 判定。

## 官方模型／原生 shape 契約

- 本地模型版本 **0.1.8**：Review `semanticContextJson`、Change `beforeValueJson`、Attempt `outcomeJson` 都是 optional string；沒有新增 Entity／datastore。
- 使用固定 Core v1.7.0.1 的 **716 個 jars／WAR SHA** 驗證、Pegasus 29.74.2、Gradle 8.14.3、既有 JDK 21。network-none／read-only-root／無 credential 或 Docker socket 掛載的獨立容器，offline＋strict dependency verification。
- `ModelRoundTripCheck` 驗新舊 Task／Run／Decision／publication／ETL records；既有缺欄位不被當成成功。`export_agent_semantic_shapes.mjs` 從真正 compiler 產出 **17 個／14 類原生 Aspect payload**（含 string／double union、欄位與五種定義），由固定 Core 的實際 Pegasus classes 驗 schema／required fields／enum／union。非僅自製 JSON shape assertion。
- `model-native-check.log`：完整 build／annotation／codec PASS；`model-native-check-final.log`：擴至 numeric 後 17 payload PASS。既有 ANTLR 4.5／4.9.3 mismatch 與 Gradle 9 deprecation warning 留在 log，未豁免。
- ZIP：`model-native-check/workspace/build/0.1.8/dist/ekop-agent-tasks-0.1.8.zip`，含兩個 plugin jars 與 entity-registry.yml；確切 SHA／模型 source hashes 收於 verification receipt。舊 build／release 產物保留，**未安裝模型**。

離線 codec 不驗 native ACL／URN 存在性、實際 create privileges、GMS 整批部分成功或線上 registry 相容性；這些仍需授權後的原生驗收。

## 重跑本地檢查

從本工作樹執行：

```bash
node --experimental-strip-types --test tests/test_agent_semantic*.mjs tests/test_agent_task_records.mjs tests/test_agent_gateway.mjs tests/test_agent_native_ingestion.mjs extensions/datahub-agent/mfe/mount.test.mjs extensions/datahub-agent/pi-web/components/DataHubHostBridge.test.mjs
node --experimental-strip-types tests/check_agent_semantic_review_browser.mjs "$PWD/.local/evidence/semantic-steward/s3/browser-new-attempt"
node --experimental-strip-types tests/check_agent_semantic_browser.mjs "$PWD/.local/evidence/semantic-steward/s3/preview-new-attempt"
node --experimental-strip-types tests/export_agent_semantic_shapes.mjs "$PWD/.local/evidence/semantic-steward/s3/native-shapes-new.json"
(cd extensions/datahub-agent/pi-web && node_modules/.bin/tsc --noEmit --incremental false)
(cd extensions/datahub-agent/mfe && node_modules/.bin/webpack --mode production)
```

模型使用已備妥的隔離 workspace／固定 toolchain，以 `-PsemanticFixture=<上述輸出>` 執行 offline `modelCheck`；不執行歷史部署或 ingestion script。

## 尚未驗收／下一步

1. 確認 Task／Run 讀者與 writer 範圍，必要時配置官方 Policy 並實測隔離。
2. 先對帳原 checkout 的獨立漂移與既有 downstream lock 差異，再另取得部署模型／Host／MFE／Skill、Source v5 policy 及限定 Semantic 寫入的授權。本工作樹不自動同步原目錄，不 stage／commit／push。
3. 真 authenticated Composer → 模型 → tool → trusted review → native CAS → readback／reload；含原生已填人工值保護。此次 populated-content 測試是合成資料，不能代替這項證據。
4. S4：prior-Agent／current／proposed 三方比較、人工介入衝突與明確代管權限；不是 S3 現有 addition/fill-only 權限。

回顧：核心修正在責任邊界——保存的是 intent 與精確版本，不是模型批准；保留式更新不建立整個 Aspect 的所有權；失敗 receipt 不因後來看見相符值而被改寫。仍受原生 per-Aspect 非交易性與稽核 ACL 可見範圍限制，沒有用新 store／Core patch 掩蓋。

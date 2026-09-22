# Semantic Steward — S2 本地來源對帳與詞彙提案驗證

日期：2026-09-22。狀態：**本地唯讀功能已實作；整個 S2 與完整 Semantic Steward 尚未完成**。

工作樹 `/home/timmypai/apps/datahub-worktrees/semantic-steward`，分支 `feat/semantic-steward`，base `a25204e`。沿用 S1 的 778 檔來源快照，不同步原 checkout 的並行工作，不部署／讀真憑證／呼叫真 DataHub／執行 ETL／寫 metadata／stage／commit／push。

## 本段實作

| 接點 | 已實作／實際證明 | 不代表 |
|---|---|---|
| Source 唯讀 | 原生 Source aspect + fresh actor/manageIngestion + 原 recipe/CLI pin；與 `native-ingestion.mjs` 的執行限制分離 | 所有 connector、一般 Catalog editor 已在部署上相容 |
| 單 Dataset 來源對帳 | 最新成功 execution、RUN_INGEST/source、精確 recipe 注入、CLI/executor、原生版本與 schema runId/pipelineName 相符；Run/provenance drift 使 snapshot 失效。原 lastRunId 誤讀已按後續真部署證據修正，見 governance 驗證 | 整個來源清單完整、真實 DB 掃描成功、語義正確 |
| 詞彙搜尋 | 原生 GraphQL 搜尋五類詞彙，逐 URN ACL/removed/原生版本，20 筆分頁；property 約束安全投影 | 搜尋是原子快照、搜尋沒找到就一定不存在、詞義相同 |
| 新定義草稿 | Domain/Node/Term/Tag/Property、合法既有 parent、穩定 Host 候選 URN、同名重用衝突、證據位置；與 association 分開 | 已保留 namespace、允許新建／覆寫、查完所有共享依賴 |
| UI/transport | Pi tool schema、原 MessageChannel/MFE、Host HTTP 路由、現有 React 差異卡；恢復序列化結果時檢查格式 | Task/Decision 已持久化、可信核准完成或真 Composer E2E |

所有回應仍為 `publicationAuthorized:false`。整個 scope 仍 `operator_allowlist_subset`、`ingestionMembershipVerified:false`、`completeSourceInventory:false`；只有回應中明確命名的單一 Dataset 可得 `membership.status=NATIVE_RUN_MATCH`。

詞彙搜尋 window 為 start 0..980，每頁 20；query 上限 128 字元。`nextStart`、`searchWindowExhausted`、`hiddenResultsOmitted` 明示結果邊界。搜尋結果不是永久唯一性／全域授權證據。新定義 property 限 Dataset 的 string/number、SINGLE/MULTIPLE、可選 allowedValues。其他類型、schemaField 賦值與 shared-definition update 尚未接入。

## 固定版原始碼證據

唯讀檢查原 checkout 的 `upstream/datahub`：`git describe --tags --exact-match HEAD` = `v1.7.0.1`，該 submodule 工作樹乾淨。下列是**原始碼／公開 schema 證據**，不是使用中部署的 API 驗收：

- `datahub-graphql-core/src/main/resources/ingestion.graphql`：公開 `IngestionSource.latestSuccessfulExecution`、ExecutionRequest、input/result。
- `.../resolvers/ingest/execution/GetLatestSuccessfulExecutionRequestResolver.java`：成功狀態採 `SUCCESS`；不能照 schema 註解中的示例自行使用 `SUCCEEDED`。
- `.../resolvers/ingest/execution/CreateIngestionExecutionRequestResolver.java`：RUN_INGEST、source association、注入 execution URN 作 run_id、原生 source recipe／version／executor。
- `metadata-utils/src/main/java/com/linkedin/metadata/utils/IngestionUtils.java`：保留既有非空 pipeline_name，否則注入 Source URN。
- `metadata-models/src/main/pegasus/com/linkedin/mxe/SystemMetadata.pdl`：欄位存在性。**語意更正**：PDL prose 與固定版 Core `EntityServiceImpl.applyUpsert` 及真部署讀回不一致；runId 保存 incoming run，lastRunId 保存 previous stored run。不能依原 prose 將 lastRunId 當目前來源證據。後續已加精確 native UUID alias／拒絕歷史 run 負例，舊 fixture 收據不作此語意的證明。
- `datahub-graphql-core/src/main/resources/search.graphql`：`searchAcrossEntities` 公開 types/query/start/count 與 searchResults.entity。
- `metadata-models/src/main/pegasus/com/linkedin/{domain,glossary,tag,structured}/`：原生 definition／parent／termSource／property 型別與約束。字串／double union 沿用原生模型，沒有自造 Aspect。

官方 checkpoint 有 formatVersion/serde/bytes payload，且可能未啟用／沒有成功完整狀態。這次未自行新增解碼器、索引或業務狀態檔案庫，也沒有把 run 命中數、搜尋 total 或 taskDatasets 當完整 ingestion 分母。完整 source membership 仍待針對固定部署與現行 source 的公開能力實測。

## 驗證範圍與指令

從本工作樹執行（使用既有 installed dependencies，沒有安裝套件）：

```bash
(cd extensions/datahub-agent/pi-web && node_modules/.bin/tsc --noEmit --incremental false)
(cd extensions/datahub-agent/mfe && node_modules/.bin/webpack --mode production)
node --experimental-strip-types --test \
  tests/test_agent_semantic*.mjs tests/test_agent_gateway.mjs \
  tests/test_agent_native_ingestion.mjs \
  extensions/datahub-agent/mfe/mount.test.mjs \
  extensions/datahub-agent/pi-web/components/DataHubHostBridge.test.mjs
node --experimental-strip-types tests/check_agent_semantic_browser.mjs
```

- Focused tests **57/57 PASS**：包括既有 ingestion/gateway/MFE/Host bridge 回歸，以及成功／缺失／失敗／錯 source／錯 recipe／CLI／executor／舊 provenance、snapshot drift、詞彙五類 enum/ACL/removed、搜尋分頁、parent/新定義 shape、property allowed values、同名重用、惡意 markup／格式／越界與 malformed 原生回應。
- 完整 pi-web `tsc --noEmit --incremental false` PASS；未執行 `next build`。
- MFE Webpack production build PASS。這只產生隔離 worktree 的建置輸出，不切換使用中部署。
- 本輪 4 個 production 檔 scoped primary LSP 無診斷；`lens_diagnostics(mode=all)` 的 8 檔會話快取無 error，保留原有 `DataHubIngestionBridge.tsx:25` Next 71007 `onRespond` warning（S2 未改該檔；不假裝 callback 是 Server Action）。這不是全專案掃描／安全稽核。
- 真 Chromium **合成 React 元件 smoke**：390/1440 的既有候選及新定義卡，keyboard disclosure、escaped markup、同名重用提示、無 page-level overflow、序列化 fixture reload，runtimeErrors=[]。限制 external network，只連隨機 loopback test port，不用既有瀏覽器 profile。
- Node 的既有 `MODULE_TYPELESS_PACKAGE_JSON` 警告不影響通過；沒有為消除它改變整個 pi-web module type。

收據與截圖：`.local/evidence/semantic-steward/s2/`（integration-tests.log、typecheck.log、mfe-build.log、browser.log、browser-result.json、definition-390.png 等）。原 S1 收據保留。外層 checkpoint 指向本段狀態；來源 manifest 與 cumulative patch 只用作此 lane 的變更／恢復證據，不是新增業務 datastore。

## 尚未完成與後續工作

1. 固定部署上核對完整來源 membership／分母與公開 API 行為；不能用 fixture 冒充。
2. 跨來源共享定義影響、schemaField properties、ownership/documentation。
3. 沿用 Task/Run/Decision 與 `publication-review.mjs` 接入語義持久化、可信人審、原生 create/CAS/PATCH、逐項 partial/unknown 對帳與讀回。**目前沒有擴大其 Aspect allowlist，也没有新增任意 writer**。
4. S4 代管／觸發／三方比較與失效。
5. 部署前 reconcile 原有 downstream lock 漂移與本 feature delta；不重算 baseline 來製造假通過。原 checkout 並行 DataFlow 變更不由本 lane 自動同步。

後三階段仍有可授權的本地實作，不全部歸因於缺少部署授權；但真正部署、Credential 使用及 metadata 寫入仍需使用者對目標與動作的明確許可。

簡短回顧：本段把「per-asset 原生 provenance 相符」「完整來源範圍」「詞彙重用搜尋」「建立／修改授權」分開；否則很容易把一個成功 Run 或零搜尋結果誤當成全來源可發布。尚未驗證的能力保持顯式未完成，沒有用新的儲存／框架繞過。

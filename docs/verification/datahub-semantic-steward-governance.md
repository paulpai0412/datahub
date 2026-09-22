# Semantic Steward：欄位屬性、組織規則與共用影響驗證

2026-09-22；`feat/semantic-steward`，獨立 worktree。**本文件保留分段歷史，不是全功能驗收。**

**目前狀態已更新：** 修正旗標經另行批准後，一次 ingestion 已消耗且原生 SUCCESS；Source v5，checkpoint 7 Dataset＋3 Container。Host runtime 接線與七表真讀回亦已通過。詳 [checkpoint 驗證](datahub-semantic-steward-checkpoint.md)；以下「尚未提交／未消耗／全量 runtime 未接線」只描述當時狀態，不是再次執行授權。

## 已補功能

- schemaField Structured Properties 唯讀盤點及 string/number 候選。保持精確 v2 fieldPath、原生保留字編碼；同時驗 Dataset／field ACL、parent/key、status、property entityTypes/cardinality/allowedValues/immutable。原生 field Aspect 與治理 policy 綁入快照，漂移拒絕。
- 明確核准的 ownership 規則與文件 origin：沿用 ingestionPolicies，不新增 policy store。規則預設空；工具無法指定或修改規則。新 owner 須帶組織規則 evidence，逐帳號／群組驗原生 key、ACL、停用／刪除；既有 owner 保留。文件只接受核准 HTTPS origin，不 fetch、不包含 userinfo/query/fragment、不覆寫既有 URL 的人工說明。
- 共用詞彙影響查詢與卡片：原生 incoming relationships／property EXISTS 搜尋，逐引用 ACL、model-context scope；未核准資產識別不出 Host。後續頁綁定義版本；資料分頁不是交易、隱藏依賴與歷史 property versions 仍未知，沒有全域修改授權。

`inspect_dataset.fieldPath` 是根層選取欄位；欄位 property `preview` 必須沿用根層選取及 snapshotDigest，並在 candidate 帶相同 fieldPath。其他欄位的 property 不能混入。新候選 kind 為 `owner`（value、ownerType、policy evidence）和 `documentation`（value、description）。`inspect_impact` 使用 sourceUrn/datasetUrn/kind/referenceUrn，後續 start=nextStart 並帶 definitionVersion。

沒有改動 Core、native ingestion executor、Task/Run/Decision publisher 或發布 allowlist；沒有新增服務／datastore、Source SQL、ETL、metadata 寫入、部署、stage/commit/push。最初離線檢查沒有 credential／DataHub 存取；後續使用者明確核准唯讀登入，實際操作見文末追加紀錄。原 checkout 的並行變更不自動同步。

## 固定版契約依據

唯讀查閱 `upstream/datahub` v1.7.0.1：

- `metadata-models/src/main/resources/entity-registry.yml` 的 schemaField 註冊 schemaFieldKey、structuredProperties、status。
- 公開 SDK `metadata-ingestion/src/datahub/emitter/mce_builder.py::make_schema_field_urn`、`utilities/urn_encoder.py`；對照 Core `metadata-utils/.../SchemaFieldUtils.java`。不依賴其 private implementation 執行，adapter 只生成同一公開 URN。**U+241F 編碼差異拒絕支援；百分比／保留字碰撞拒絕，不自行 alias／downgrade。**
- `common/Owner.pdl`、`OwnershipType.pdl`、`Ownership.pdl`、`InstitutionalMemoryMetadata.pdl`；只讀安全欄位，不讀 owner credentials/info/email。
- `common/GlobalTags.pdl` 的 TaggedWith、GlossaryTermAssociation 的 TermedWith、domain/Domains 的 AssociatedWith、node/domain 的 IsPartOf；關聯可见不代表完整共享影響。
- `datahub-graphql-core/src/main/resources/entity.graphql` 的 Entity.relationships、INCOMING、分頁／includeSoftDelete；search.graphql 的原生 FacetFilterInput/EXISTS。
- `docs/api/tutorials/structured-properties.md` 的公開 structuredProperties.<qualifiedName> 搜尋欄位。當前版本索引結果不能代表歷史 property versions 全部依賴。

上述是原始碼與公開 schema 證據，尚未在使用中的部署驗證。一般 Catalog editor 是否能取得 Source/manageIngestion 或 schemaField granted privileges 仍需現場核對，不能用 fixture 推定。

## 驗證

- **66/66 focused tests PASS**：原有 57 項 + 8 組治理／欄位／impact 行為 + 1 組新卡片及偽造格式負例。包括欄位碰撞、wrong parent、未選欄位、ACL/removed、immutable、漂移、owner rule 缺失、原值保留、不安全文件 URL、共享影響 redaction／分頁／定義漂移。
- 完整 pi-web TypeScript noEmit PASS，未執行 next build。
- MFE Webpack production build PASS；輸出只在隔離 worktree。
- 5 production 檔 scoped primary LSP clean。Lens session cache 無 errors；既有 DataHubIngestionBridge onRespond Next 71007 warning 保留，不改 callback 假冒 Server Action。
- 真 Chromium **合成元件** 390/1440：既有差異／新定義／field properties／shared impact、鍵盤 disclosure、escaped markup、識別遮蔽、無 page overflow、fixture reload；runtimeErrors=[]。不是真 Composer／模型／部署 E2E。

```bash
(cd extensions/datahub-agent/pi-web && node_modules/.bin/tsc --noEmit --incremental false)
(cd extensions/datahub-agent/mfe && node_modules/.bin/webpack --mode production)
node --experimental-strip-types --test tests/test_agent_semantic*.mjs \
  tests/test_agent_gateway.mjs tests/test_agent_native_ingestion.mjs \
  extensions/datahub-agent/mfe/mount.test.mjs \
  extensions/datahub-agent/pi-web/components/DataHubHostBridge.test.mjs
node --experimental-strip-types tests/check_agent_semantic_browser.mjs
```

收據及截圖：`.local/evidence/semantic-steward/s2-governance/`。較早 S1、S2 的收據保留，未冒稱是目前 source 的新驗收。

## 下一個必要證據／未完成

1. 設計第 4 節要求先實測固定部署的 Source→完整資產範圍。後續已取得唯讀授權並完成所選來源的 7 資產 current-run 對帳，詳下。這不是完整 ingestion manifest；stateful 關閉、兩種原生 run 索引讀取皆無列。後續取得限定 checkpoint／一次 ingestion 授權，但原旗標組合未通過 SDK 預檢，尚未更新或執行，詳文末。
2. S3 尚未接好可信 review/publish。既有 `task-records.mjs::ownedPublicationTargets` 拒絕改寫沒有 Agent 發布歷史的 Aspect，且只對原 LINEAGE dataJobInputOutput 有明確 adoption 例外。不能把人寫的 ownership/tag/property Aspect 直接當 Agent 所有，或單純擴大 allowlist 使之通過。需根據原生範圍與條件寫入證據，完成保留原值、逐項授權、attempt/CAS/partial/readback 的接線。
3. S4 代管／增量／三方比較仍未完成。不得以工具輸出中的 false/blockers 或人工聊天同意取代可信狀態。

回顧：本段重用既有入口、policy 與官方模型，不用新的 datastore／writer 解決範圍未知。局部盤點已可用；全域影響與發布仍需更強的原生證據和授權，未將 fixture 數量當成交付完成線。

## 追加：使用者核准的真部署唯讀查驗

使用者明確允許讀原 checkout `.local/user.props`，只登入 localhost:9002 並做 DataHub-only 公開 API 唯讀檢查；先列 5 個 Source 後，由使用者選定 AdventureWorks2019 metadata-only（7 tables）。這一輪唯讀授權沒有批准 recipe 更新、ingestion、Source SQL、metadata 寫入或部署（後續授權與預檢見下）。登入 cookie 只存 process memory，未输出／存檔憑證。沒有讀其他 Source recipe，也沒有修改 runtime policy。

- Source aspect v4、CLI 1.7.0.9、default executor；目前 recipe 的 7 個 literal table allow patterns、schema filter、exclude views；stateful=false、profiling=false、convert_urns_to_lowercase=true，無 transformers／extraArgs。最新原生成功 Run 與 recipe 的官方注入形式完全相符。
- Catalog 搜尋該 DB 命名空間有 95 筆；僅對 7 個配置目標讀取語義／schema，其他候選只作 key 定位並省略。完成兩頁發現，不把首頁 3 個已見目標當完整七表。
- **修正實際缺陷**：PDL 的 runId/lastRunId 註解誤導原 S2 adapter。固定 v1.7.0.1 `EntityServiceImpl.applyUpsert` 將 previous stored runId 移入 lastRunId，incoming runId 寫入 runId。真讀回與此一致。原生執行 URN 的 ID 在 Catalog 使用 UUID 形式；adapter 現只接受該完整 URN 或其精確 UUID，並以 current runId/pipelineName、成功狀態、recipe/CLI/executor、原生版本共同判定。沒有拿歷史 run 當 fallback，亦不接受任意字串 suffix。
- 修復後，以登入身分直接呼叫工作樹的 **真 `nativeSemantic.inspect_dataset`**，7/7 返回 NATIVE_RUN_MATCH，publicationAuthorized 仍 false。不是已部署 gateway／Skill／Composer／模型 E2E；臨時 context 僅用所選七資產及已讀回 recipe pin，沒有把測試 context 寫入 live 配置。
- 原生 GraphQL runId 搜尋，完整 URN 和 UUID 都為 0；官方 `datahub ingest show` 使用的公開 `/runs?action=describe`（經 frontend `/api/gms`），兩種 ID 也為 0。這是「索引沒有返回列」的實際觀察，不是「來源沒有資產」；沒有直接讀內部 DB 或變更索引配置，也未證實索引為何無列。這些 API 不能在本次狀態提供完整 manifest。
- 新增 first-observation／UUID alias／歷史相同但 current 不同／任意 suffix 負例；**67/67** focused tests PASS，2 檔最新 primary LSP clean。前端未再修改，原 typecheck/build/browser 收據按其 source hash 重用。

證據均保留在 gitignored `.local/evidence/semantic-steward/s2-governance/`：`source-list.json`、`adventureworks-source-contract.json`、`adventureworks-catalog-observation.json`（首頁、明示不完整）、`adventureworks-native-run-scope.json`、`adventureworks-runs-describe.json`、`adventureworks-adapter-readback.json`、`native-provenance-regression.log`、`integration-tests-after-native.log`。最後一份 adapter 收據的 fieldTotal=null 是 probe 未捕捉該欄位，不代表零欄位，也不用它宣稱欄位覆蓋率。

截至本紀錄：6 次登入、65 次 metadata 唯讀請求（含 identity），metadata／Source DB writes 均 0。S2 全量 inventory、S3 publisher／可信核准、S4 仍未完成。不能因七資產各自命中便解除 completeSourceInventory/global impact 的未確認狀態。

### 歷史：Checkpoint 原旗標授權後的預檢（當時尚未提交）

使用者後續批准僅對此 Source，安全／版本預檢通過後啟用 `enabled=true, remove_stale_metadata=false` 並執行一次既有七表 metadata-only ingestion；不 profiling/DDL/DML/業務資料列/ETL/Semantic部署，也不改 live runtime policy。這一次 ingestion **尚未消耗**。

但前一提案的旗標不成立：固定 upstream 與已安裝 CLI **1.7.0.9** 的 `StaleEntityRemovalHandler` 均把 checkpointing_enabled 綁定到 remove_stale_metadata。因此 remove=false 連 checkpoint 都不建立，不應照原計畫執行一輪沒有預期證據的 ingestion。

已執行 credential-free、網路呼叫受阻的原生 SDK 局部檢查（不是 live persistence）：
- remove=false：checkpoint=false、0 URN、0 removals。
- remove=true + ignore_old_state=true：checkpoint=true、加入測試 URN 成功、0 previous-state reads、0 removal workunits。

證據及可重跑程式：`.local/evidence/semantic-steward/s2-native/checkpoint-compatibility.{py,json}`，使用既有 `.venv`，未安裝套件、不寫其 pycache。fake provider 只隔離 checkpoint/deletion handler，不證明完整 pipeline、人工內容保護或真 DataHub 持久化已驗。

替代設定仍須使用者確認；不能因它也能達到「不刪除」就自行將剛核准的 remove=false 改成 true。正式操作前仍需讀回當前 Source revision、確認沒有進行中 Run、核現有人工 metadata 與 connector emission 行為，若有風險／版本衝突／需要改 live runtime policy 便停止。沒有新增 inventory store、Core patch 或 silent fallback。

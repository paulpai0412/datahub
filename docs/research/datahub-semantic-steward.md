# DataHub Semantic Steward 設計與實作契約

日期：2026-09-22。狀態：設計已依使用者要求落檔，實作進行中；不是部署或語義發布驗收。

## 1. 目標與完成線

使用者在既有 pi-web ChatComposer 選擇 `datahub-semantic` Skill，指定已 ingest 的來源。Agent 盤點缺口、重用詞彙、提出有證據的語義補全，經 Host 的可信審核／既有授權政策發布到 DataHub，再讀回核對；後續持續處理增量與漂移。人從逐欄維護者轉為政策制定者及例外審核者。

`structured priority` 本方案按 Structured Properties 解讀；business priority 是可選業務屬性，不建立另一種模型。

完整完成線包含真 Composer → 真模型／受限工具 → 精確來源範圍 → 差異 → 真可信核准 → 官方 API 發布 → 原生 UI／讀回 → reload／重跑／衝突驗證。Skill 文件、fixture 測試、HTTP 200 或只有預覽均不代表完整功能交付。

非目標：來源 SQL／profiling／業務資料抽樣、改動來源 schema、任意 Core patch、重建通用平台、新 datastore、任意 Aspect writer、自動新建大量詞彙、可執行 metrics layer、把 Join 當 lineage。既有 ETL 執行／恢復狀態由原工作主線管理；本功能不變更其狀態、不重跑 ETL。

## 2. 入口與使用體驗

原生 `/skill:datahub-semantic`，後接自然語言：

> 針對指定 ingestion 來源補齊 domain、terms、tags、表／欄位說明與必要屬性。优先重用現有詞彙，保留人工內容。只處理 reporting 範圍。

沿用 Pi Skill discovery、slash palette、tool response 與 session 歷史；不重寫 chat runtime。使用者不填 URN／Task ID／Aspect mapping。來源或業務語義有歧義才詢問。選取来源不能構成授權。

聊天卡顯示來源、scope basis、as-of、已檢查／未檢查範圍、現有值→候選值、證據位置、風險與未解項。依表／欄位、分類、詞彙、衝突呈現。可信核准放 MFE parent／Host，不以模型生成按鈕或聊天「同意」代替。

## 3. 原生模型與資料主責

| 內容 | 官方模型／Aspect | 主責與限制 |
|---|---|---|
| 技術 schema | dataset/schemaMetadata | 官方 ingestion；模型不得改寫型別、欄位存在性或來源事實 |
| 表說明 | editableDatasetProperties | 保留來源原說明；保護人工編輯 |
| 欄位說明／tags／terms | editableSchemaMetadata（精確 fieldPath） | 不自行正規化名稱、不得丟失 quoted／nested fieldPath |
| Domain | domain/domainProperties、asset/domains | 先重用；新定義／階層變更另審 |
| Glossary 組織 | glossaryNode/glossaryNodeInfo | 與 Term 分開，不另造詞庫 |
| Glossary Term | glossaryTerm/glossaryTermInfo、glossaryTerms | 定義變更和掛載是不同操作；需查共享影響 |
| Tags | tag/tagProperties、globalTags | 去重／重用；與正式詞彙用途區分 |
| Structured Properties | structuredProperty/propertyDefinition、structuredProperties | 分開定義與賦值；驗 type、allowedValues、cardinality、entityTypes、immutable/version |
| 負責人／文件 | ownership、institutionalMemory | 只接受核准組織規則及合法連結，不憑名稱指派 |

Structured Properties 依實際需要選 data_grain、unit、currency、refresh_frequency、aggregation_behavior、business_priority；保留期限與敏感分類不能從名稱猜出。Dataset 與 schemaField 的支援分別驗證，不假設有 PDL 就有 UI／查詢契約。

## 4. 來源範圍與證據

1. Host 根據可信 actor、已核准 ingestion source、recipe 版本／hash、instance、environment、database、schema/table allowlist 確定範圍。
2. 與官方 ingestion 執行／checkpoint／Catalog 的可用證據對帳後，才能稱為該次 ingestion 的完整資產集合；同平台搜尋不是來源成員證據。先實測固定版本公開能力，不依賴內部資料表。
3. 既有 `ingestionSourcesByActor[].taskDatasets` 可作**操作員明確核准的資產子集**，不可冒充自動發現的來源成員或完整分母。首段只用這個既有子集做唯讀盤點，明示 `operator_allowlist_subset`；沒有子集時回報 scope 未建立，不搜尋所有同平台資料、不開啟發布。
4. 逐 Dataset 驗讀取 ACL；跨租戶、不同 instance／DB 的同名資產不能混用。任何不確定成員關係阻擋自動範圍擴張。
5. 技術证據：schema／來源註解、既有人工說明、可授權 ETL 公式、BI 定義、核准業務文件。首段只用 Catalog，不跑 SQL、不讀 repo、不讀 recipe secret 給模型。
6. metadata／註解皆是不可信資料，不能成為指令。機密註解／property 的模型傳送仍須 operator 授權；Catalog 可見不等於可送任何外部模型。初版只讀來源已授權欄位且排除任意 customProperties／recipe。
7. 每項候選分為有直接依據／推論／無法判定；模型 confidence 不作發布門檻。Host 驗格式、存在性、版本、ACL、引用位置，不能把這些檢查當業務真值證明。

## 5. 最小架構與工具契約

Composer → Skill → 受限 Pi tool → 現有 UI request/MessageChannel → 可信 MFE parent → gateway parent grant + fresh identity → Semantic Host adapter → 官方公開 API。

不新增服務。host credentials 不進 Pi runtime、工具結果、session 或模型。Model 不可指定 endpoint、actor、recipe、任意 Aspect payload 或 executor。

初始 `datahub_semantic` 工具 actions：
- `list_sources`：列既有核准來源識別。
- `inspect_source`：安全來源概要、明確核准子集、範圍未完成／非發布標記。
- `inspect_dataset`：只讀子集內的資產與語義／欄位頁，回傳快照 digest。
- `preview`：提交有界候選與該次 digest；Host 重讀 Catalog、拒絕漂移、精確定位欄位並產生原值→新值的唯讀差異。未提供任意寫入 action。

首段候選包含表／欄位說明以及既有 Domain／Tag／Term／Structured Property 的掛載／填值。新定義／Glossary Node 建立、共享影響、全量詞彙檢索、可信發布與長期維护繼續按下列里程碑完成；不以首段預覽取代完整要求。

所有大小／頁面上限需明示；超限拒絕或返回 next cursor，不靜默截斷為完整成功。Digest 綁 actor/tenant、scope、schema 與相關語義版本。分頁讀取每頁重驗版本；as-of 只是觀測時間，不是交易一致性聲明。

## 6. 審核、發布與維護

三模式：盤點（不寫）、審核發布（精確批次人審）、授權代管（先核准 source/scope/操作/規則/期限，再自動執行）。初版預設前兩者，代管後續獨立驗收。

復用 Task／Run／Decision、SEMANTIC 型別核准、publication attempt／readback。現 `publication-review.mjs` allowlist 主要為 globalTags/glossaryTerms，必須按真 API 與 policy 行為逐項擴充；不可只加字串宣稱支援。共用 Term/Domain/Property 定義修改需列出跨來源依賴，不讓單一來源批准變成全域定義權限。

發布時重新核 actor、write ACL、現行 scope/recipe/schema/metadata/詞彙定義版本、批准者及期限。新增集合項用經驗證的 native PATCH；需要替換時使用 native If-Version-Match，不能以先讀後無條件整體 UPSERT 防併發。PATCH 是否支持版本前置條件需實測；不支援則選有 CAS 的公開入口，不能自降安全。

跨 Aspect／Entity 不假設交易：按依賴順序逐項發布，保留 attempt 與收據；PARTIAL/UNKNOWN 先讀回，不盲目重試，不宣稱全批成功。補償需要重新核版本與權限，不覆寫發布後的人工修改。

持續維護使用上次 Agent 發布值、目前值、本次建議三方比較。人工／其他 writer 的變更轉衝突，不自動搶回管理權；無 provenance 的舊內容視作受保護。歷史與證據追加保留在 DataHub 既有模型／經核准最小 Aspect 擴充，不新建 runtime file store。

成功 ingestion 的增量事件或既有排程触發重分析；失敗／部分掃描／權限縮減不得自動視為刪除。來源漂移、定義变更、證據過舊使舊候選／批准失效。原生已發布值與當前是否仍可信分開呈現，不能說 catalog 自動撤回了舊值。

## 7. 實作順序與驗收

### S1：獨立 worktree、文件、唯讀垂直接線
- 真 source code 的 Skill discovery、tool bridge、MFE/gateway、既有核准 source subset、Catalog 與 preview。
- 不修改 live config，不部署、不使用真憑證；離線 fixture 只證明接線與負例。
- 覆蓋越界、錯 actor、ACL、recipe drift、Catalog 漂移、錯 fieldPath、無證據、惡意 metadata、人工原值保留、上限／分頁、取消、唯讀 API 白名單、session 序列化與元件呈現。

### S2：完整範圍與詞彙治理
- 固定部署上核對 source→assets/成功 ingestion 證據；必要缺口回報，不另造 datastore。
- 原生詞彙搜尋、去重、新 Domain/Node/Term/Tag/Property 提案、共享影響、欄位 properties 與 ownership/documentation。

### S3：真可信核准／發布
- Extend existing typed review + model where demonstrably needed; source-bound approval and native conditional updates.
- 真 Composer、模型、Host、審核、公開 API、UI／搜尋／readback／reload 全閉環。部署、憑證與 metadata 寫入另取得具體授權。

### S4：代管與增量
- 版本化代管政策、既有事件／排程、三方比較與失效；跨 actor/tenant、安全負例、部分失敗與復原。

完整驗收：無重複詞彙／no-op 重跑、人改保護、來源及 schema drift、拒絕過期／重播、部分失敗對帳、原生讀回相符、再 ingestion 不抹除核准語義。各類覆蓋率有授权分母／排除／as-of，不用已解析子集冒充全量。

## 8. 工作樹與版本

- 主 repo `/home/timmypai/apps/datahub`，原 branch master，HEAD a25204e；只有 .gitkeep tracked，其餘現有程式尚未追蹤。
- 新 branch `feat/semantic-steward`，worktree `/home/timmypai/apps/datahub-worktrees/semantic-steward`。
- 現有非 ignored 原始碼快照 778 檔；不複製 .local/.venv/credentials/node_modules/.vscode。基準 SHA manifest 位於本 worktree gitignored `.local/evidence/semantic-steward/source-baseline.json`。
- 這是隔離原始碼快照，不是假稱已有完整 Git baseline；未自動 commit/push。最後以 manifest 比對新變更及原 checkout 未變。
- Core 源版本 v1.7.0.1、SDK/CLI 1.7.0.9；不修改 upstream。Pi web downstream 另記 delta，不覆蓋上游 baseline lock 來掩蓋變更。

## 9. 依據

- `extensions/datahub-agent/pi-web/skills/datahub-etl/SKILL.md`、`lib/datahub-etl-extension.ts`：現有 Skill/tool bridge。
- `integration/native-ingestion.mjs`、`ingestion-policy.mjs`：固定 Source recipe、原生 actor 與已核准 subset。
- `integration/native-discovery.mjs`：fixed public read APIs、逐 URN ACL 與 native versions。
- `integration/publication-review.mjs`、`models/`：既有 typed review/Task/Run/Decision。
- 固定 upstream `docs/advanced/patch.md`、`docs/api/tutorials/structured-properties.md`、editable schema/domain/glossary/structured PDL。

文件中的未驗能力是待驗契約，不是現場已支援或已部署的宣告。

## 10. S1 實作紀錄與當時限制（2026-09-22；目前差異見第 11 節）

- 已接入 `datahub-semantic` Skill、`datahub_semantic` tool、獨立 MessageChannel、MFE `/agent/semantic` 與既有 gateway parent proof／fresh identity；未開放 mutation。
- Host 重用來源 policy，增加可選布林 `semanticModelContextApproved`，預設不開放任何来源。需由操作員明确批准傳送該資產子集的語義資料（含為該子集引用的可見詞彙定義）到既有模型；這不授予新模型／provider 權限。
- S1 重用既有 `nativeIngestion.inspect_source`，所以**目前來源檢視仍要求 manageIngestion，且受現有 MSSQL／CLI 1.7.0.9／固定 executor/recipe 契約限制**。不能宣稱支援所有 connector／一般 Catalog editor；S2 要把來源唯讀解析與執行前置條件正確分離，再做相容性驗證，不能直接放寬原 ingestion 執行安全。
- source 成員對帳尚未完成。使用既有 taskDatasets 操作員子集做盤點；`source_membership_not_verified` 永遠顯示，禁止自動擴大或發布。
- 每資產 20 欄位／頁、每批最多 8 個候選；48KB 回應／24KB intent 上限。多個候選的 before/after 是各項對現況的差異，尚非可直接執行的合併 PATCH。
- 表／欄位說明、既有 Domain／Tag／Term、Dataset string/number Structured Property 的唯讀候選已實作。查詞彙先用既有已授權 Catalog 工具，新的詞彙搜尋／Glossary Node／新定義建立仍屬 S2。其他 property type/qualifier/platform constraints 明確拒絕，不當作已通過。
- 表／欄位原值、來源與人工 tags/terms 分開讀取；衝突標記 `existing_edited_value_protected`。目前沒有 writer，不能把這個唯讀保護測試當作發布端三方合併已完成。
- 跨 HTTP Host 測試、React 呈現／分頁／惡意 markup、iframe origin/cancel 與既有 ingestion/gateway/MFE 回歸共 46 項通過。TypeScript 全案 noEmit、11 檔 scoped primary LSP、MFE build 通過。390/1440 Chromium 是**合成元件 smoke**，不是已部署 Composer／真模型／DataHub E2E。
- 不讀取 `.local` 真設定／憑證、不部署、不改 Core、不寫 metadata、未 commit/push。原目錄另有 8 個 DataFlow 原始碼相較初始快照變動，本輪未寫也未同步；不能宣稱整個原目錄完全未變。
- 原 pi-web downstream lock／patch 在開始前已有漂移；本輪保留原鎖，不更新 hash 使之假綠。發布前需對現有 baseline 與新 delta 做完整來源／映像核對。詳 `docs/verification/datahub-semantic-steward-s1.md`。

## 11. S2 第一段實作紀錄（2026-09-22；後續見第 12 節）

延用同一 Skill、Host adapter、MessageChannel、MFE 與差異卡，沒有新服務、datastore、Core patch 或通用框架。

- **來源唯讀與 ingestion 執行分離**：`nativeSemantic` 不再透過 `nativeIngestion.inspect_source` 借用 MSSQL／executor／sink 執行限制。直接用固定公開 API 讀 Source，仍驗 operator opt-in、actor、DataHub `manageIngestion`、核准 recipe SHA 與 CLI pin。原 ingestion 執行程式未改；其他 connector 的 fixture 可讀不等於現場相容性已驗收。
- **單資產原生來源對帳**：讀 `ingestionSource.latestSuccessfulExecution`，核對原生 execution 的 task/source/status、recipe（包括官方注入的 run_id/pipeline_name）、CLI/executor、Input/Result 版本；再與該 Dataset schema 的 `systemMetadata.runId/pipelineName` 比較。只在全部相符時回 `membership.status=NATIVE_RUN_MATCH`。**現場修正**：原 S2 依 PDL prose 使用 lastRunId，已被固定版 Core applyUpsert 與原生讀回推翻；實際 runId 是此次寫入，lastRunId 是之前儲存的 runId。只接受該 execution 完整 URN 或其精確 UUID，不使用歷史 run／任意 suffix 作 fallback。Run／provenance 改變會使既有 snapshotDigest 失效。
- **不擴大範圍**：`scope.ingestionMembershipVerified:false` 表示整個核准子集尚未對帳，`completeSourceInventory:false` 仍保留。`source_inventory_incomplete` 永遠阻擋本階段發布；只有當前資產的對帳狀態可由 UNVERIFIED 變為 NATIVE_RUN_MATCH。這不是完整 ingestion 分母，也不證明業務語義。
- **`search_vocabulary`**：原生 `searchAcrossEntities`，kind=domain/node/term/tag/property，query≤128 字元，每頁≤20、start≤980。逐結果再次驗 read ACL、原生定義版本及 removed。回傳必要定義／階層、property 的 type/cardinality/allowedValues/immutable 等約束，不返回搜尋 snippet 或任意 customProperties。可見候選搜尋不是原子 inventory；`duplicateAbsenceVerified:false` 與 `sharedDefinitionImpactVerified:false` 明示限制。
- **`preview_definition`**：五類新定義草稿、既有 parent 引用檢查、搜尋重用候選、同名衝突及證據位置。definition 與 Dataset/field association 分開。Host 依 tenant/kind/名稱/parent 產生穩定候選 URN，但它不是保留 namespace、去重證明或 create 權限。Property 新定義目前限 Dataset 的 string/number、SINGLE/MULTIPLE，可指定 allowedValues；不偽稱其他型別／schemaField 支援。
- **仍無 writer**：新定義卡、工具與 Host 都保持 `publicationAuthorized:false`。不更新既有共用定義、不把聊天同意存成可信核准、不寫 Task/Run/Decision 或 metadata。未建立 namespace、驗 native create/CAS 或完成共享影響的候選帶明確 blockers。

尚未完成：部署上的 source→完整資產清單／checkpoint 證據驗證、跨來源共享定義影響、schemaField properties、ownership/documentation，以及 S3 的既有 typed review／持久化／可信批准／條件寫入／partial-readback 整合與 S4 代管。這些不是全部都受部署授權阻擋；可繼續本地實作，但真部署、憑證使用、metadata 寫入須另取目標特定授權。不得以本地 fixture 推定公開 API 在現場已可用。

驗證與可重跑指令：`docs/verification/datahub-semantic-steward-s2.md`。

## 12. S2 欄位屬性、組織規則與共用影響（2026-09-22）

繼續沿用既有 adapter／policy／tool／差異卡；不新增架構。

- `inspect_dataset` 可指定精確根層 `fieldPath`，依固定版公開 URN 編碼讀取 schemaFieldKey、structuredProperties、status，另驗 parent/field ACL。欄位觀測與 governance 規則納入 snapshotDigest；欄位 property `preview` 必須帶同一根層 fieldPath 與快照，candidate 也指向該欄位。定義 entityTypes/cardinality/allowedValues/immutable 照常驗證。現有非空 property 改值呈現保護衝突。
- 不降級 v2 fieldPath；檢測保留字編碼碰撞。固定 SDK/Core 對 U+241F 編碼有差異，此字元明確拒絕，不假稱全格式相容。未讀到 schemaFieldKey 是身分未確認，不等於實體不存在。
- 現有 operator Source policy 增加可選 `semanticOwners:[{urn,type,rule}]` 與 `semanticDocumentationOrigins:[httpsOrigin]`，均預設無授權，未變更 live config。Owner 只支援明列的 TECHNICAL_OWNER/BUSINESS_OWNER/DATA_STEWARD 規則；候選須引用相應 policy evidence，並核原生帳號／群組存在、ACL 與停用／刪除。保留既有 owner。
- 文件候選只接受已核准 origin 的 canonical HTTPS URL，不含 userinfo/query/fragment；不 fetch 遠端內容、也不自動覆寫同 URL 的人工說明。來源規則或原生 ownership/institutionalMemory 變動令旧快照失效。
- `inspect_impact` 查原生 incoming relationships（Domain/Node/Term/Tag）或公開 Structured Property EXISTS filter；20 筆／頁，後續頁綁 definitionVersion。只揭露 actor 可讀、且允許送入模型的資產或詞彙；未核准來源／不支援的資產類別不洩漏識別。列出跨目前資產的依賴，但沒有把單一來源批准提升為共用定義修改權。
- Graph／search 的隱藏、延遲索引、非原子分頁及歷史 property versions 仍有未知，`sharedDefinitionImpactVerified:false` 及 `sharedDefinitionUpdateAuthorized:false` 必須保留。這是可見依賴盤點，不是證明全域無其他使用者。

本地功能／負例／UI 已驗，詳 `docs/verification/datahub-semantic-steward-governance.md`。本段當時未完成的原生範圍證據，後續已完成所選七表／當次 Run 的實測與 Host 接線，見第 13 節；不是其他 connector／整個 DB／歷史 Catalog 的完整性證明。S3 尚需沿用 existing Task/Run/Decision 完成 publisher 接線及 native CAS/readback；不能因已有 SEMANTIC enum 就繞過 `ownedPublicationTargets` 的人工內容保護。

## 13. 原生 checkpoint／S2 Host 範圍接線（2026-09-22）

使用者選定 AdventureWorks2019 七表，另行核准 `enabled=true/remove_stale_metadata=true/ignore_old_state=true`、不得刪除，及一次 metadata-only ingestion。Source 已 CAS v4→v5；執行 `329d2def-4c3d-4b35-829c-8610887f6429` 原生 SUCCESS。一次授權已消耗，不能重播或自行關閉 ignore_old_state。新 recipe SHA256 為 `2f280d3ce4ed302855608710981c12f7457b3febdd942d976991acbba56d20a1`，舊 pin／快照需失效，未自動改 live runtime policy。

官方 CLI/SDK 1.7.0.9 解碼原生 checkpoint 得 7 Dataset＋3 Container；Dataset 集合與核准七表相同。已將 public timeseries 讀取及官方 SDK 解碼接入 production `nativeSemantic`：沿用 Host 固定 Python transport／並行池，輸入、解壓與輸出有界，無新服務／store。只支援實測的 MSSQL job／固定 SDK、formatVersion 1.0、UTF-8／base85-bz2-json；其他 connector／格式不推定相容。

Scope 取原生 checkpoint 成員、操作員模型授權及原生 ACL 的交集。既有 taskDatasets 是工作授權上限，可包含下游發布目標，不是 ingestion 清單；不修改該 Task policy，也不把其他工作資產納入 Source 成員。只有原生 checkpoint 與有效核准集合完全相符時，回 `native_checkpoint_reconciled_operator_scope`、`completeSourceInventory:true`；表示**該次成功 Run 的 Dataset 清單**，不是所有 DB／歷史 Catalog／其他 Entity 完整清單。checkpoint 證據納入 snapshot；單資產 current runId/provenance 仍獨立檢查，不能用 checkpoint 洗掉較新的來源衝突。

直接經 production adapter＋固定 SDK child 的真 DataHub 讀回已確認 Source v5、checkpoint 七表與 7/7 current Run 相符；沒有部署新版 gateway／Skill／Composer，也沒有 Semantic 發布。UI 顯示 checkpoint 時間、限定範圍與未發布狀態。詳細操作、77/77 focused 測試、原生讀回、擴大回歸的既有版本斷言落差及保護證據限制見 `docs/verification/datahub-semantic-steward-checkpoint.md`。

本段完成時 S3／S4 尚未接線；S3 後續本地進度見第 14 節。後續真部署、runtime policy 更新、Semantic 寫入或更多 ingestion 仍需另取目標特定授權。

## 14. S3 本地審核／發布閉環（2026-09-22）

沿用原生 Task（dataJob）／Run（dataProcessInstance）／Decision、既有 publication review、一次性 attempt 與 OpenAPI v3 per-Aspect CAS。沒有新的簽核服務、datastore、Core patch 或通用 Aspect writer。

- UI：Skill prompt → `preview` → `prepare_review` → custom tool-result card → Review / Approve → **可信父層 detail sidepanel**。逐項 before／after、證據、人工內容保護、scope、expiry、planDigest 與歷史均可檢視。縮減選取以單次 Run CAS 拒絕舊 plan、追加新 Decision，不複製 consent。最終按鈕明示「Approve 並發布」；iframe／模型不能送出 verdict 或發布 payload。
- `prepare_review` 將 Host 重編譯的 typed intent、projected evidence、before／after、版本、policy hash 保存到既有記錄；先核對該 actor 私有 Pi runtime 的 exact pending native UI request。審核與 reload 不需假造新 session 或重新送模型 prompt。gateway 只在準備提案時 lazy 取得既有 runtime，唯讀語義操作不配置 runtime。
- 模型擴充 **0.1.8** 只增加 optional 欄位，舊資料可讀。`semanticContextJson` 包含 compiler intent／證據與 guard versions；beforeValueJson 綁原值；outcomeJson 記初始觀測，與後續 current readback 分開。紀錄不是對目標資料的第二份權威。
- Source operator policy 新增預設無權限的 `semanticPublicationApproved`、既有 `semanticAgentUrn`、`semanticAuditAudience: EXISTING_TASK_RUN_ACL`；新定義另需 `semanticDefinitionCreationApproved`。**沒有修改 live policy**。既有 Task／Run 曾實測可被其他 Catalog Reader 讀取，Host owner check 不會令 Native API 私有；未確認稽核讀者範圍不得持久化。需私人審核時先以官方 Policy 隔離並實測，不新建 store。
- 表／欄位說明只填未有人工原值的位置；tag／term／domain／owner／文件採保留式追加，properties 只填缺值，不覆寫既有非空 assignment。完整未知欄位／既有陣列與排序保持不動，只有已知原生 edit audit stamps 可更新。這是**逐提案 addition/fill-only 例外，不是採納或宣稱整個 Aspect 由 Agent 擁有**；原 LINEAGE 與 legacy SEMANTIC ownership 路徑不放寬。
- Dataset/schemaField property、精確 v2／保留字欄位、五類新定義均有 typed compiler。新定義使用 tenant/name/parent 穩定 URN，先讀 key/definition/status，存在或 tombstone 均拒絕採納，只以 `If-Version-Match:-1` 新建；定義與 association 需不同審核。可見搜尋仍不證明全域唯一，不修改既有共享定義。
- 發布前重讀 actor、Source／recipe、Task、native ACL、schema／metadata／引用版本、operator policy、期限及 exact review。CAS 與永久 attempt 防止重送。單一已證明 NATIVE_RUN_MATCH 的明確資產子集可以送審；Source inventory 不完整仍明示，不擴大為整個來源的維護核准。
- **不是跨 Entity／Aspect 交易**：寫後再次核對 source/schema/reference context。race、partial／lost ACK 或讀回不符保留 UNKNOWN／未派送狀態與已消耗 attempt，不自動 retry、rollback 或清除 receipt；之後讀到 MATCHED 也不改寫原 UNKNOWN。讀回有 as-of 限制，不能保證其他 writer 之後不再修改。

本地 production card／MFE／Host 對合成 native boundaries 的閉環與 populated-human-value 保護已測；0.1.8 官方模型產物亦完成 offline codec/annotation/build 檢查。詳細測試、已知限制及 source-bound evidence 見 `docs/verification/datahub-semantic-steward-s3.md`。這不是部署、真模型、真 Task／Semantic metadata 或真 ACL 隔離驗收。S4 的三方比較／代管與實際部署 E2E 仍待完成；一次 ingestion 授權保持已消耗，不再執行。

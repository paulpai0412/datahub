# DataHub Agent 語義代管提案（研究稿）

原提案日期：2026-09-29。以下為更新至 2026-10-01 的歷史狀態；第一版最新方向見下一節及新設計文件。當時狀態：**主線已回到「盤點 → 有證據提案 → 政策內執行／送審 → 驗證與後續更新」；本地已接通描述及其他關聯三方比較、同有效政策 Task CAS 接續多輪、正常保留觀測與可信 Host 批次真人審核，尚未部署／真入口驗收，完整產品仍未交付。歷史 r2 僅真實發布單欄、24例外（25／76），尚缺51收據，已撤回唯讀；audit-only 只完成本地修補，不能取代產品主線**。沿用 [已驗證 Catalog 主線](datahub-semantic-catalog-mainline.md)，不修改 DataHub Core、不新增 datastore。使用者本輪指定：**可設定核准模式，預設自動發布**；權威範圍採**成功 ingestion**；若更新的共用定義影響範圍外資產，**暫停列例外**。觸發方式問卷未答；第一階段建議手動啟動一次代管，事件與排程只是後續方案，非已核准操作。

## 2026-10-03 最新方向：流程優先

使用者明確要求先交付 Domain、Glossary Group／Term、Tag、Structured Property 的**實際建立、套用與後續維護**，不要先做大量 policy。第一版已選「整批計畫一次確認，Host 依序建立與套用」；獨立 managed／AUTO policy、逐目標白名單、背景自動发布不再是第一版前置。必要原生權限、精確確認、憑證保護、CAS與未知 attempt 不重送仍保留。

**目前實作仍未完成這個新流程。** 以[流程優先設計](datahub-semantic-maintenance-workflow-first.md)作為後續第一版實作依據。下方 AUTO／單一成功 Run／逐項政策章節保留為原方案與歷史能力說明，不再當作新第一版的強制先後順序，也不表示已停用現場 guard。

## 現況與缺口

目前 `datahub_semantic` 的 `catalog/1` 能在真入口單資產預覽／準備 review，經可信父層人審、原生 Task／Run／Decision 與 OpenAPI per-Aspect CAS 發布並讀回；實測六類資產、一欄位、七定義。這是**逐提案審核**，不是整個 ingestion 的持續代管。

現有限制：`semantic-catalog-contract.mjs` 每次最多8個 candidate、`native-semantic-catalog.mjs` 每頁20欄／20項資產與詞彙、`semantic-catalog-publication.mjs` 一 review 一資產或一共用定義，預設10分鐘到期。`ingestion-policy.mjs` 目前最多16個 taskDatasets 與64個 semanticCatalogAssets。詞彙搜尋／共享引用是有界、非原子觀測，不能從空搜尋推定全域唯一或無跨範圍影響。官方 OpenAPI v3 的 batchGet 能批讀，但 batchGet 不表示跨實體交易；If-Version-Match 寫入為 **per-Aspect** CAS；batchGet 的 Aspect `headers` 則可選特定歷史版本（官方指南 Batch Get 有 version2 後重讀 version1 的明確例子，不把 CAS 寫入回覆當成歷史讀取證據）（固定上游 `docs/api/openapi/openapi-usage-guide.md`、`docs/advanced/mcp-mcl.md`）。既有 `[UNKNOWN]` attempt 不能重播。

## 產品行為

使用者在 Agent 指定有權管理的 ingestion Source、代管規則與「執行盤點」。完成後看到**範圍與覆蓋率、將自動發布／跳過／待例外**三類摘要，不必逐欄輸入或逐筆點核准。可點進任一候選的精確原值／新值／證據與理由。執行期間可取消後續工作，已發布項不因取消而假裝回滾；結果逐項連回原生審核與目前讀回。

預設核准模式為**政策內自動發布**：管理員／受權人先批准來源、actor、允許的操作種類、來源資料可送入現有模型的範圍、有效期與停用條件。這是持久、可撤回的**範圍授權**，不是讓模型當批准者；未配置、過期、撤權、權限不符時不能發佈。UI 可切換為「一批一次審核」或「唯讀盤點」；既有單筆 review 與舊 consent 不升級。自動模式不意味忽略下列例外門檻；沒有足夠證據的候選只列為待處理。

「整個」的分母明確是**指定成功 ingestion Run／checkpoint 中、且當前 scope／ACL 允許的 Dataset 及其真 schema 欄位**，附 Run、recipe、版本、觀測時間、總數、成功、排除與未判定數。2026-09-29 已在現場找到 SalesDatamart 原生 Source `c382a4fe-…`、最新成功 Run `f9a55669-…`、當前精確 recipe 六表＋一 view，以及七個 schema 的同一 runId/pipelineName（共69欄）。此 Source 的 stateful checkpoint **未啟用**，本案僅能稱「成功 Run＋封閉可列舉 recipe＋七個 current schema provenance」，不稱 checkpoint 已驗證或整庫 inventory。無需為取得重複證據而重跑已成功 ingestion。後續依使用者選擇復原既有 9041 路由，以獨立限定配置對齊 Source recipe SHA 並開啟已核准的唯讀 model opt-in；原配置保留，`semanticPublicationApproved:false`、沒有 AUTO policy，**仍共用本機 Catalog，非隔離 staging**。真模型與完整盤點證據見 [live 紀錄](../verification/datahub-semantic-automanagement-live-20260929.md)。當前被選的 Container／DataFlow／DataJob／Chart／Dashboard 不因同平台或搜尋相符就變成 ingestion 成員；需另外核可精確 Catalog scope，並在報表中與 Dataset 分開。不自動擴成整個 DB、所有歷史 Catalog 或其它來源。固定版本的原生 checkpoint 相容性只在實測 connector／格式成立；不支援的來源不能假造完整分母。

## 已實作的本地界線（與尚未交付者分開）

`inspect_managed_scope` 對 pinned MSSQL recipe 封閉列舉並逐 Dataset 驗最新成功 Run/schema provenance；`semantic-managed-cycle.mjs` 為同 actor／Source／scope／policy 保留穩定原生 Task，第一輪 Run key 向後相容；後輪用 Task 版本 CAS 分配獨立 Run，保留其固定 taskVersion 與前輪 locator。Run CAS 保存逐項 Decision／到期 lease／例外／保留觀測，20 筆一頁讀取全 7 Dataset＋69 欄（76 邏輯目標）。可設定**唯讀（未配置寫政策）／REVIEW（真人逐項審核）／AUTO（直接證據新增，以及政策明列、完整原生 baseline 未變之 Agent 描述更新）**。每項仍用原 typed compiler 與既有 publisher 的 per-Aspect CAS；永久 attempt 初始 `outcomeJson` 與現在值分開報，UNKNOWN 即使後見 MATCHED 也不變成功。共用定義更新與 schema 遷移未自動放行。REVIEW 已有本地「一次確認、循序沿用原生 Decision」批次父層審核；逐筆核版本且不承諾原子交易，未部署。

**真 SalesDatamart 唯讀差異**：7 Dataset／69 欄的來源說明欄位 **0**，資料集來源說明 **0**；既有 editable 欄位說明 **1**、editable Tag 欄位 **1**、Dataset Domain **1**。所以不能假設模型可自動為 69 欄賦予可信意義。`metrics.md` 一方版本化業務契約 SHA `a10923a6…` 僅按**欄位主語完全吻合**投影少數明文公式；2026-09-29 唯讀編譯 `fact_sales_order_line.linenetamount` 公式時 before 為空；2026-10-01 r2 已在一次性授權下真實發布，完整 `editableSchemaMetadata` version3→4 與原生初始成功／目前讀回相符。未證實的欄位及共用定義走明示例外，不能把 76 項有收據等同 76 項已完善。

**尚未完成**：上述本地能力的真入口首輪與後續變更輪次驗收、描述以外各 kind 的自動更新政策（目前替換／移除仍人審）、共用定義更新所需的完整跨範圍影響證據、批次真人審核的真入口驗收、語義品質基準／Holdout。r2 的76項收據與closed仍是獨立歷史支援缺口，不作產品完成度。原窄範圍source review及r2單欄發布／原生與UI歷史證據不涵蓋後續稽核續作的新程式；仍需新的必要驗收及live授權，不能宣稱整體正式自動發布已交付。來源選項與 ACL 仍依原有 Task／Run，可讀性不等於私密。嚴格的新模式必須在這些不足處列例外而非冒充已支援。

## 持續維護本地主線（2026-10-01，未部署）

- `inspect_managed_maintenance` 從直接來源說明／固定第一方公式產生 ADD、UPDATE_AGENT、KEEP、需人審及明確證據缺口；每頁20欄，首頁含 Dataset，後頁綁同一快照。不從名稱猜語義，展示 prior-Agent／current／new、原生來源 locator、版本及明文證據。
- Native `systemMetadata.runId` 只定位先前 Task／Run／Decision；仍須核 actor、Source、Agent、固定 Task 版本、真實核准及初始持久成功。AUTO 描述更新另需 `allowAgentDescriptionUpdates:true`、完整 Aspect 值與版本未變、同 schema，以及欄位／Dataset 原值仍為該 Agent 值。只更新該描述，保留未知成員、人工作品及 sibling。schema 漂移／人工改值／同值重寫走真人 PENDING；UNKNOWN 不轉成可重發待審。
- 使用者選擇 **同有效政策、原生 Task 版本 CAS 接續新 Run**。`inspect_managed_scope` 返回現存輪次或可接續 locator、generation、previousCycleRunUrn；只有完整關閉且所有 attempt 有初始持久成功的前輪可以接續。Task CAS 僅一個分配者勝出；分配後缺 Run／lost ACK 保留不明狀態，不重播、不再配下一輪。歷史讀回用每輪 taskVersion；不把最新 Task 當成舊輪次上下文。Source／Task／Run 之間仍非原子交易，不承諾雙 Aspect 原子建立。
- 描述以外，Dataset／欄位 preview 已用同一原生 baseline 解析 Domain／Tag／Term 關聯及 Structured Property 的 prior-Agent／current／new。`value` 是先前選定集合的比較快照，`changedValues` 僅列實際新增／移除，保留的人工成員不被認領。完整Aspect值／version變更仍報 CURRENT_CHANGED；未知初始結果不追認；同Aspect未被操作的 sibling 語義報 NO_SELECTED_AGENT_BASELINE。欄位Property核精確 schemaField Aspect，不誤套 Dataset property 歷史。
- 有直接證據的非描述 set/remove 或既有Property替換可在AUTO模式進既有精確人審，沒有新增自動覆寫權。修正人審分流在首項提前返回、漏查同批後項證據的根因：先驗完整候選批次，再決定 PENDING。原缺證據／撤權／版本失效仍拒絕。四類關聯首輪→同政策第二輪、真人批准後原生結果、完整人工作品與欄位Property隔離已通過合成檢查；React 顯示可追溯prior與真正改動成員。
- 全為 NO_CHANGE 的精確 `prepare_managed` 候選記為原生 Task／Run／Decision **保留觀測**，不走 publisher、不產生 approval／attempt。選值雜湊與觀測時間保留，讀回核對選值；其他欄位的合法發布不會使它誤判失效。被選值改動／未確認回覆保持未核對，舊觀測不能當成目前值或初始發布成功。
- Agent tool、MFE、React 計畫／輪次卡接線；卡片清楚區分保留、發布、待對帳與例外，不提供模型同意控制。後輪 Task URN 不由 Run URN 推導，寫意圖用 Host 回傳的 cycleTaskUrn。
- 本地合成 caller seam 已證明：首輪新增 → 同政策第二輪安全更新 → 第三輪保留並關閉；原 Task 版本、舊 Run／Decision 不變，政策 id／期限不變。另驗並行分配、pending／UNKNOWN 阻擋、失 ACK 不重播、人工／schema 保護與完整 Aspect 保存。這不是現場 SQL、模型或 DataHub 私有 Aspect 歷史實測。

使用者已選擇共用定義**連結既有獨立原生審核**。`prepare_review` 保留獨立 Task／Run／Decision，`link_managed_definition` 只在代管 Run 新增原生連結決策；不擴大其 Task assets、不建立 datastore，不讓模型同意或發布。Host 核同 actor／Source／Agent／session、anchor Dataset、request digest／planDigest。輪次 `definitions` 以20筆分頁追蹤待審、拒絕、初始成功＋目前匹配、UNKNOWN及未確認；不計入 Dataset／欄位覆蓋。待審／UNKNOWN／失 ACK 不可用例外掩蓋、關閉或跳過接續；已連結且未核對的定義禁止用於後續關聯，AUTO dispatch 前再核依賴。定義發布不是關聯核准。

本地 caller seam 已走通 Tag 獨立人審→定義初始成功→關聯另行人審→完整輪次關閉→同政策接續；另驗 Domain、Glossary Group→Term、Structured Property 定義建立的連結／讀回，並保留原 Task 資產範圍。SDK 真實 execute 契約與 MFE transport 均涵蓋新連結；也修正 KEEP 回傳 managed-cycle 時 SDK 原只接受 review 格式的接線錯誤。React 顯示保留與獨立定義審核，轉義內容且無批准控制。

**共用定義更新仍是能力缺口**：目前 impact 一律有界 `complete:false`，Structured Property assignments 也無全域完整 inventory；`link_managed_definition` 拒絕此類更新，不讓人審連結變成影響範圍授權。`prepare_managed.definition` 繼續拒絕；模型須先 inspect_definition 明示缺口，不自行建立同名定義繞過。現有獨立人審功能不代表代管已具備完整跨範圍證據。

新 reader 可读舊輪次；一旦有新連結／保留／多輪 Task 版本，回復唯讀仍須保留相容 reader，不能退回舊嚴格 reader 或刪除歷史。新部署、模型訊息及真 Catalog 寫入仍需具體授權，沒有沿用過期 r1／r2 grant。

## 批次真人審核（本地完成、未部署）

使用者已選「一次核對選取項目，逐筆沿用原生 Decision」。輪次卡只傳 Run locator，可信父層依同原生Run版本讀完整分頁，再逐筆讀原生提案；不相信iframe傳來的選取、版本、verdict或目標payload。預設不選取，勾選整筆提案後另勾選明確確認；修改選取會清除確認。完整差異、prior-Agent、證據、影響及原生locators沿用單筆審核渲染。

- 修正原一般Task「只有一筆待回答問題」對代管批次造成的阻擋：僅Host經原生managed scope/policy/期限/目標占位核對，可讓多筆typed semantic review在同Run CAS下排隊。一般Task／原生UI問題仍一次一筆；UNKNOWN或未確認非review intent仍阻擋。KEEP、獨立定義連結與明確缺口可和其他目標的待審提案並存，不批准它們。
- 逐筆送出前重新 read_review 取得當前Run CAS版本，但planDigest及完整候選必須仍是使用者看過的精確版本，不自動重算或重準備；共用定義沿獨立Task/Run/Decision，不擴parent assets、不增加Dataset覆蓋。
- 成功只認原生初始成功、目前claimed attempt相符及上下文再核。衝突、撤權、取消、失ACK／不明效果停止後續，保留已成功項目與原歷史，不批次回滾、不自動重送。操作中可「停止後續」，目前送出項仍等候原生結果；離頁會取消前端等待，不能假稱取消已生效寫入。
- 清單預設不包含已attempt項。UNKNOWN不變成可重試；歷史卡不因審核窗關閉就標成成功，需重新讀原生輪次。没有模型bulk-approve工具、新batch datastore、Aspect或第二publisher。
- 合成瀏覽器使用真React/MFE/Host與原生API fixture，390/1440px下驗選取/確認、鍵盤開關、原生逐項結果、部分停止/失ACK/重載與iframe偽造拒絕；不是登入、現場Catalog或模型驗收。Transport可能重送同版本HTTP請求，原生CAS仍拒絕第二效果，應用層不重試。

## 同一輪次的僅稽核續作（2026-10-01，本地完成、未部署）

r2 的發布已成功，但原政策過期後剩餘51筆例外無法追加。不能重做發布、延長舊政策／lease，或另建Run掩蓋未完成；使用者只批准主層本地實作與離線驗證獨立audit-only授權。

- 使用既有 `record_managed_exception`、`finish_managed_cycle` 與原生Run Aspect CAS；不新增action、datastore、模型／前端image或原生Aspect schema。
- 部署端每Source可配置 `semanticAuditRecovery`：嚴格欄位為 `id / cycleRunUrn / sessionId / scopeFingerprint / expiresAt / originalPolicy / targets`。深凍結配置；不接受模型／HTTP自行提供grant。Actor由可信登入及Source配置取得，必須匹配既有Run／Task／Agent／session。
- **發布必須明確關閉**，且不得同時有 `semanticAutoManagement`。`originalPolicy` 只是原AUTO政策的完整digest preimage，必須吻合舊Task instructions，絕非重新啟用；原政策、Task binding與lease保持不變。新grant只有到期前最多30分鐘的有效窗口，可撤回。
- `targets` 為精確Dataset／欄位元組（最多128個），必須在同一成功ingestion／目前schema scope內，而且**不在原政策允許發布的目標中**。僅可追加真實 `POLICY_DENIED`，不可偽稱缺證據。既有target slot仍由原Run CAS保護，不能換requestId覆寫。
- 續作前要求所有publication（包含非首頁）皆為初始持久成功且目前 `VERIFIED`，且沒有pending。UNKNOWN、失去ACK、已消耗NOT_DISPATCHED、後來值改變均不能靠例外變成完成。每筆append及response CAS在最後一次身分await後，同步再次核grant／期限／綁定；grant變更或撤回即拒絕，已存intent不刪、不重播。
- 新Decision的exception JSON額外記錄Host產生的 `auditRecovery`（grant id／digest、原policy digest、scope fingerprint、期限）；讀回檢查policy綁定及有效期內的原始requested/responded時間。原publication／attempt／例外保持原樣，撤回grant後歷史仍可讀。
- `finish_managed_cycle` **沿用既有**owner/session/ACL及完整收據門檻；本來就可關閉已到期但完整的輪次，不藉新grant改寫lease。grant到期／撤回禁止新例外，不改變原有完整Run的owner closure語意。
- DataHub仍只有per-Aspect CAS與觀測快照，沒有跨Source／Task／Run／Dataset原子交易。並發漂移與不明效果仍需唯讀對帳。

**升級／回復界線：**新reader同時讀舊收據與含audit proof的新收據；寫入後停用grant／發布可保持歷史可讀。舊Host嚴格reader不識別新增proof，因此不能在已有新收據後直接退回舊reader；需要保留此reader相容層（先reader、後啟用writer），不能刪除收據來回滾。固定舊MFE／runtime image是否能呈現新收據仍須在另獲批准的真入口驗證；本地測試不是live相容性證據。

離線證據見 [live紀錄的本地續作段落](../verification/datahub-semantic-automanagement-live-20260929.md)。目前沒有新live窗口、模型訊息、reviewer或Task Pi授權，尚未對r2追加任何收據。

## 執行契約

1. **Scope snapshot**：可信 Host 驗 actor、tenant、Source recipe hash、CLI／connector、最新成功 Run／checkpoint、資產及 fieldPath 成員、read/write ACL、政策版本。只在成功的對應掃描範圍判斷缺項；失敗／部分掃描與權限縮減不能自動當刪除。分頁涵蓋全部已核分母，不能因現行20欄／16 Dataset／64資產上限截斷後報完整。
2. **Inventory + evidence**：逐資產讀原生 schema、editable 與 source 值、定義版本、現存 Tag／Term／Domain／Property、人工修改及上次 Agent 已發布值。僅傳已核准且最小化的 metadata 給模型；不得傳 recipe secret、任意 customProperties、原始 SQL／業務資料。輸出含直接依據／推論／無法判定；名稱相似或模型信心不是業務真值。
3. **Plan**：Agent 生成候選；Host 用現有 typed compiler 檢查 operation／型別／父子階層／fieldPath、existing values、原生定義及版本。先查重用，再考慮新定義；同名／同義歧義不自動合併。新定義在受控來源 namespace 用 Host 決定的識別及 `If-Version-Match:-1` create-only；搜尋不足以證明全域語義唯一，撞名／疑似重複停為例外。建立 Group／Domain 等後原生讀回，才按依賴順序建立 Term，再處理資產關聯及欄位值。
4. **三方差異與授權分類**：比較 prior Agent 發布值、current native 值、new proposal。若 current 已被人或其他 writer 改動，不覆寫；無可靠 prior provenance 的舊值視為受保護，更新要政策明列且有適用證據，否則列例外。新增／更新共用定義需觀察跨來源引用；只要影響範圍外或證據無法證明不存在，**暫停該定義更新**。其他互不相依的安全項目可繼續。Property 定義的 type／cardinality／qualifiedName／entityTypes 遷移及共享刪除不自動執行。
5. **Durable plan / execution**：沿用原生 Task／Run／Decision 與受控 Aspect 表示一個代管輪次、policy/scope/source版本、每個 shard 的候選 digest、依賴與進度、lease/attempt。若現有模型不能安全表示，僅採官方 custom Aspect 的最小 expand-contract 並實測固定版本；不建立 Extension DB、狀態檔或第二 publisher。模型只提案；可信 Host 獨立核政策及每個目標的當前 ACL／版本，再調既有 publisher。每個 shard 有穩定 identity；同時只有一個 lease holder；舊 worker 提交拒絕。自動發布也必須有逐項可追溯的授權決策與一次性 attempt，不偽裝成真人逐項按過 Approve。
6. **CAS 與對帳**：按依賴序列、同 Aspect 不並行修改；每項在調用前重讀來源／scope／definition/schema／policy 與 before 版本，OpenAPI If-Version-Match，寫後完整 Aspect 核對。成功／NO_CHANGE／CONFLICT／INCONCLUSIVE／UNKNOWN 分別入帳。跨 Aspect／Entity 非交易，不能對整批承諾原子成功。只對**已證明未派送**且仍有權的工作重排；失去 ACK 或已派送未知時停止該目標，唯讀對帳，永不重播其 attempt 或改寫初始收據。另一個新的意圖須重新盤點和核准。
7. **續跑與漂移**：下一輪只重算受影響範圍；無變更跳過，不製造重複詞彙或寫入。Source/schema/definition/ACL/政策更改會使舊 plan 失效；拒絕／過期不自動復活。將近似值與跨來源語意爭議排入例外清單，不用 LLM 自填答案。

## 審核與資料可見性

儀表板一輪顯示政策、來源 Run、已掃描／排除／未知、依型別統計、預估修改與共享影響、逐 shard/目標收據、目前值與初始結果。人工在例外隊列可核對單個或相容的成組變更；選取或修改會產生新 plan／版本，舊 approval 不沿用。預設自動發佈仍需政策頁明確設置、關閉與到期控制。

現場原生 Task／Run ACL **尚非私人審核**，不能把可能含敏感原值的整批計畫直接寫進目前可讀記錄。第一版只處理已允許在該 ACL 下揭露的 metadata，封存最小審核資料；需要敏感原值或跨人使用時，先完成另行核准的 native S4 ACL 隔離實測（非 owner／管理員／歷史 API 正反例），不得用 Host owner guard、URL 隱藏或改名成插件替代。此邊界不因使用者選擇自動發布而放寬。

## 分階段驗收與未決策

- **A：手動觸發的完整成功 Run**（建議第一階段，非使用者已選觸發）：盤點全數已核 Dataset／欄位、單輪三方差異與有界 shard；預設政策內自動發布、新建／更新與既有值保護、例外、完整 native/UI/readback/coverage。用影子唯讀計畫核對分母與候選後，才在明確授權的隔離範圍做真寫入。不能把目前一欄位 E2E 當此階段完成。
- **B：成功 ingestion 事件**：若使用者選用，以官方 DataHub Actions／MCL 作觸發候選，事件只作喚醒信號；重新核對原生成功 Run 與 checkpoint 才建立輪次。重複、亂序、漏事件及重啟可對帳；來源寫入未完成不發布。
- **C：定時巡檢**：若使用者選用，復用同一輪次與政策，持久 lease、失敗回補與停止開關；不預建另一個排程服務或 datastore。觸發頻率／資源預算需另定。

必驗：大於20欄／16 Dataset 與分頁下的完整分母、不支持 connector/部分 Run、模型不可批准、人工改值保護、共享定義跨範圍／搜尋不完整、重複名稱、policy 撤權與過期、並行 CAS、進程中斷/lease、lost ACK/partial/no replay、重跑 NO_CHANGE、跨版本讀回、真入口 UI 與原生 API。預設「全部自動」僅表示**所有政策允許且可驗證的候選自動發布**，不是未核准範圍或未知業務意義也可強制寫入。

**最新授權／未決**：使用者已核准「六表＋一 view」、必要時本案限定 metadata-only ingestion；上述成功 Run 已存在，未實際重跑。觸發模式仍未選定，先用手動啟動作第一個真驗收；自動政策的具體操作與證據來源、模型可讀資料、預算／吞吐、例外審核者尚需從既有政策與來源契約逐項驗證，不能因選擇「預設自動」推定未列範圍的生產寫入授權。本稿不代表背景觸發或自動發布已部署。Task Pi 的 `loaded-runtime-changed` 只是團隊工具 readiness 缺口，不是本產品方案的批次執行元件或啟用權限。

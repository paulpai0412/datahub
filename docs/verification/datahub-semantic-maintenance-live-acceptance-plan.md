# 持續語義維護：真入口驗收方案

狀態（2026-10-02）：**DataHub介面內Pi Agent已完成本次描述維護首輪：73項補值＋3項KEEP，原Run v32已關閉，0缺漏／待處理／例外。真正變更第二輪及完整語義代管仍未完成。** 已撤回publication，無AUTO／auditRecovery；不沿用本輪批准派送後續模型或發布。詳[真首輪、讀取修復及界線](datahub-semantic-first-round-live-20261002.md)。

首輪前的精確契約／1024候選／512KiB及76目標唯讀预檢見[當時部署紀錄](datahub-semantic-512k-readonly-deploy-20261002.md)。其後使用者批准73補值＋3既有值保持，明確要求由產品Pi Agent執行，不派開發子代理。實際1個新session／2則Sol-medium訊息、7筆發布＋1筆KEEP；中途讀取故障停止並撤發布，另准因果修復後只讀明細／關閉原Run，未重送成功寫入。獨立來源審查依本次測試決定未執行，不宣稱正式上線驗收。舊契約review相容性仍依使用者決定保留、不修、不遷移。

## 1. 完成線與目前結論

驗收仍是 **盤點 → 有依據的新增／更新／保留 → 政策內執行或真人審核 → 原生驗證 → 後續變更輪次**。同一成功 ingestion 範圍須有首輪與真正變更的第二輪，不以單欄 canary、大量 POLICY_DENIED、KEEP-only 第二輪或測試數替代。

本地描述維護、非描述關聯三方比較、同政策 Task CAS 多輪、KEEP、獨立定義連結及批次真人審核已有證據；**不能據此批准現行部署或宣稱全產品完成**。下一步不重跑舊 r1／r2、不先補 r2 的51筆例外。

前置條件的最新狀態：

1. **停用寫入後的原生審核讀取：本地已修，2026-10-01同契約成功歷史曾live核驗。2026-10-02新契約切換後，舊證據ID相容性失敗依使用者決定保留、不修復；不影響新提案預檢的範圍判定。** 其他未配置Source的PENDING／REJECT／UNKNOWN不擴權讀取，仍只有合成證據。 RED 證明 Host `read()` 和 Catalog `readCatalogReviewContext()` 都混用了發布准入。現已分離歷史讀取與修改：publication=false 下合法 owner 可讀 PENDING／REJECT／成功／UNKNOWN 及已建立定義，仍核身分、Source／原生 Run API／資產讀權與 audit audience；準備、選取、批准、拒絕、發布仍須寫入授權；定義修改入口也保留原 creation／updates opt-in，不因歷史可讀而放行 Reject。結果的 `readOnly` 僅供 UI 提示與停用控制，不授權任何操作；舊結果可缺省此欄位，所有 mutation 仍由 Host 核權。初始成功／UNKNOWN、完整 Aspect、原生歷史不變；目前政策已變會顯示 context 未驗證，不追認 UNKNOWN。單筆唯讀 UI 及批次撤權停止已測。**不可用保持 publication=true 冒充唯讀復原**。
2. **測試內容由主層自行準備**：使用者明示不要再索取修訂檔路徑。沿用已有合成首輪／證據變更／KEEP及人審案例，必要時依已有來源契約準備測試；不把合成內容冒充真實業務修訂。固定 `metrics.md` 已另准擴充並啟用同一第一方契約，支援精確URN／fieldPath明文條目及固定ETL／SQL引用，候選項數上限依使用者指定為1024。76條真實實作解讀的技術候選已完成真Host唯讀差異預覽，但不是新一輪來源量測、Catalog發布或首輪之後的真實修訂。詳[2026-10-02本地實作與界線](datahub-semantic-scoped-evidence-local-20261002.md)。未授權向真Catalog寫假source description，也不把KEEP-only當真變更輪次驗收。
3. **原生保留政策已精確套用，9041相容唯讀入口已恢復**：B原診斷為全域20，r2 Run v52可讀／v1空。其後使用者另准，只為 `dataJob/ekopAgentTask`、`dataProcessInstance/ekopAgentRun` 透過官方公開API各新增一條2,147,483,647版本政策；兩筆version1 ACK／exact／current讀回相符，5個fallback鍵未變，YAML已置active plugin目錄。官方int上限不是無限保存，不復活缺失；未執行system-update／重啟。2026-10-02新首輪Run已達v32且精確v1仍可讀，已有真Run跨20版本證據；Task僅v1，Task跨20版及多輪接續仍未live驗收。詳 [B預檢及候選](datahub-semantic-maintenance-readonly-preflight-20261001.md)、[retention接入說明](../../extensions/datahub-agent/deploy/retention/README.md)。

## 2. 可沿用與必須重新核對的證據

| 證據 | 本次核對／可用範圍 | 不足以證明 |
| --- | --- | --- |
| HEAD `7f22e2729e7c02ba66e2bed7c88c4d0571dca47f`、master | 本次本地重核；index 無 staged diff | working tree 乾淨、HEAD 已包含 WIP |
| `.local/evidence/semantic-maintenance-mainline-20261001/source-batch-final.sha256` | A1 修改前20/20檔 hash 相符；保留當時快照 | A1 修改後的現行來源 |
| 同目錄 `source-readonly-final.sha256` | A1當時25檔來源／測試／文件快照；後續計畫文件已更新 | 最新完整來源、可部署artifact或獨立審查 |
| `.local/evidence/semantic-maintenance-readonly-20261001-szxOHq/source-retention-final.sha256` | retention本地候選當時31檔快照；本次狀態文件其後更新 | 完整部署manifest |
| `.local/evidence/semantic-retention-apply-20261001-f5jKds/receipt.json` | 兩條精確政策真ACK／版本讀回、5個fallback鍵未變、YAML落地 | 舊版本復活、真Task／Run跨20版或Agent真入口驗收 |
| `readonly-related-final-r2.log`、`readonly-ui-sdk-r1.log`、`readonly-review-browser-r2/` | A1 後334/334（含28專項）、18/18，真 React/MFE/Host＋合成API的390/1440px歷史讀取與停用修改；tsc/scoped ESLint exit0 | 真登入／Catalog／模型驗收 |
| `batch-related-final-r6.log`、`batch-ui-sdk-r1.log` | 既有306/306與18/18；本次讀回前者結尾 | 現場認證、私有 Aspect 歷史、模型流程 |
| `.local/evidence/semantic-batch-browser-GUNjFA/` | 既有真React/MFE/Host＋合成原生API：選取、確認、停止、失ACK、重載與偽造拒絕 | `/mfe/agent` 已載入新碼、真 Catalog 成功 |
| r2 原生成功與歷史收據 | 保留其初始成功；原一欄已不再是空值 | 可再次使用 fill-only 意圖／過期政策，或本批已部署 |
| 舊 R4 獨立 source review | 只作歷史 | 本批程式已獨立審查；不得沿用舊 child 額度 |
| `.local/evidence/semantic-readonly-deploy-20261001-XxvSzA/`及`semantic-readonly-reader-recovery-20261001-RNArh8/live-receipt.json` | 580檔image來源與artifact核對、真入口scope／成功review／停用mutation、8模型選項、reload、35sessions與完整目標Aspect及Task／Run前後不變 | 其他Source全部歷史狀態、模型回應／tool journey、首輪＋真變更第二輪、真Task／Run跨20版 |

規劃階段沒有重跑未變程式；A1 改碼後已重驗相關 caller、UI／SDK、合成 browser、型別及 lint，產生新 pins。未讀 auth/config secret、未呼叫 live API。LSP 7 paths 無 reported errors，但含8個既有樣式 hints／silent-on-clean 或 timeout，不能稱全 clean。25檔清單也不是完整部署 manifest。

## 3. 真入口與範圍

沿用已選的本案入口：`http://localhost:9002/mfe/agent` → `localhost:9041`。**它共用現行本機 DataHub Catalog，不是隔離 staging。** 不新增另一套服務或資料庫，也不更改 Core／全域 ACL／其他專案。

歷史範圍基線（須另獲唯讀現況核對授權後重核）：

- Source：`urn:li:dataHubIngestionSource:c382a4fe-48a9-4a0b-893a-95029a74b25f`。
- 成功 ingestion Run：`urn:li:dataHubExecutionRequest:f9a55669-6c27-49f5-9ff0-d8f04e1f48f5`。
- recipe SHA：`b535e56eaa31f0546ed3ab6f4e32b6516d1e4ead6d5356a02f7543b14e4b27d1`。
- scope fingerprint：`fdb7b16a75479727135291047e61b3e0de02788a02f4bd1747e5dd588884d3cc`。
- `dm.dim_date`、`dm.dim_product`、`dm.dim_customer`、`dm.dim_territory`、`dm.fact_sales_order_line`、`dm.monthly_category_summary`、`reporting.v_sales_order_line`；7 Dataset／69欄／76邏輯目標。
- 依據是成功 Run＋封閉 recipe＋當前 schema provenance；無 checkpoint，也不是全庫 inventory。scope／最新成功 Run 有變更就停下重新核範圍，不強套舊分母或重跑 ingestion。

只讀核對需包含真正登入 actor、Source／Dataset／欄位 ACL、各種既有人工內容、完整 Aspect／版本、既有 Task／Run／Decision 及初始 outcome。保護範圍外資產及原有 sessions。不可僅從 `taskDatasets` 或搜尋結果推定成功 ingestion 成員。

## 4. 案例清單：先定真值與差異，再開寫入窗口

每個寫入案例須先填齊：**精確 assetUrn、fieldPath、kind、operation、before／版本、new、證據 SHA／定位、適用範圍、AUTO 或真人審核、完整受保護 sibling 及期望原生結果**。共用定義另列 definition URN／完整建立內容／anchor；未填齊不是可執行意圖。

| 案例 | 真實輸入與動作 | 接受條件／目前缺口 |
| --- | --- | --- |
| 全範圍盤點 | 真模型透過 semantic-governance 工具取7 Dataset、69 distinct 欄位及全部頁；讀現有定義／關聯及維護狀態 | 分母、scope、快照一致，資料不得從名稱補猜；不能只讀首20項 |
| 已成功值保留 | `dm.fact_sales_order_line.linenetamount` 的既有公式，先核原始 r2 成功與目前值 | 若完全未變，記 KEEP，不再次發布；保留觀測與原成功是不同紀錄。若版本／人工內容已變，不假設仍為可自動維護 baseline |
| 首輪新增 | 2026-10-02產品Pi Agent已實際發布73個ADD；另2個受保護值及1個原Agent值均按使用者決定KEEP | 7笔初始及目前VERIFIED、3項保留、原Run已關閉；技術敘述不等於業務認證，不擴解至任意同名欄位 |
| 首輪批次真人審核 | 至少兩筆有依據、目標不重疊的真實待審變更；整筆選取、一次確認、逐 Decision 執行 | 必須有實際需要與證據，不能為湊兩筆而建立／替換語義。核原生 CAS、初始成功及當前讀回；未選不動 |
| 適用共用定義 | 優先重用；確有缺口才建立 Domain／Group／Term／Tag／Property，先独立人審，再連結輪次 | 每種類型記為已驗／有據不適用／缺證據，不能互相代證；Group→Term依賴及定義／關聯批准分開。managed shared update 的 complete:false 缺口仍未解決，不安排真更新 |
| 第二輪真實修訂 | 至少一個首輪已發布目標出現**經批准的真實證據修訂**，同有效 managed policy 下接續新 Run，比較 prior-Agent/current/new | 固定契約的精確證據讀入擴充已部署並唯讀預檢，但仍缺新首輪後的真實修訂內容與寫入批准。AUTO描述更新需預先明列 allowAgentDescriptionUpdates、完整 baseline／schema未漂移。若變更 scope 或 managed policy digest，不能算本案例的同政策接續 |
| 第二輪保護人工內容 | 使用現有受保護值，展示送審／保持，不自動覆寫；真正業務修訂若涉及它，由真人明確決定 | 不為負例擅改現行人工值。未選欄位、關聯註記、完整Aspect其他成員保留 |
| 後續讀回 | 真 UI 重載、原生 Task v1/v2、兩輪 Run 與 Decision、原初始 outcome 及目前觀測 | 同Task版本CAS接續；舊輪次不被改写，當前值變動不抹去原始成功；KEEP／definition不混入發布或Dataset覆蓋 |

第一輪的證據缺口應逐項明示，必要時據實記原生例外以支援後續輪次。**例外不是成功語義維護**，也不為填滿分母而一律用 POLICY_DENIED。跨兩輪技術路徑成立仍須另報業務證據／品質缺口。

### 第二輪證據修訂的特殊約束

優先使用真實、版本化且已批准的業務契約修訂；第一輪證據與第二輪證據都保留。若採固定契約新 SHA，須先核當前 adapter、Host 載入及政策綁定如何處理，將 exact bytes／SHA 與切換方式列入批准，而不是讓模型提供檔案或 URL。`semanticEvidenceSha256` 的變更本身也是需要批准的 Host 設定變更；不得只因 managed policy ID 相同就宣稱所有信任輸入都未變。

如現有機制無法在上述界線內承接該證據修訂，先做有界本地修補並重驗，再排真驗收；不在 live 窗口臨時換設計。沒有真實新證據時，第二輪維持 **BLOCKED_INPUT**；只做 KEEP 不可升格成變更輪次驗收。

## 5. 執行順序與各自的批准邊界

A1及retention本地實作、B唯讀／限定歷史診斷、兩條精確政策套用已完成；C受限建置／唯讀部署及reader配置恢復亦已另准完成，證據見B預檢文件最新節。模型／業務寫入及其他政策變更仍須具名批准，部署授權不是新維護輪次授權。

### A. 解開本地已知阻擋、凍結候選

1. **本地及唯讀部署完成**：第1節 read_review／publication gate 分離與正反例，原生ACL／寫入保護仍成立；既有成功歷史可讀，但尚無新兩輪紀錄可驗E段。
2. 測試案例由主層準備；用現有compiler／合成caller seam核首輪及後續變更，不把fixture當真實業務證據。真正Catalog發布仍須有精確、正確的來源依據與目標批准。
3. 凍結完整候選來源、相依清單及 downstream 差異；舊20檔 pins 只作起點。保留全部既有 WIP，不覆寫原 baseline lock 或只對 HEAD 審查而漏 WIP。
4. 正式上線驗收仍需 fresh、no-write 的獨立來源審查，涵蓋本批政策、baseline、批次人審、歷史讀取與不重播。2026-10-02使用者明確選擇main-only產品功能測試，本輪未派reviewer、未聲稱此門檻通過。後續若需team.reviewer，先核能力及確切model/thinking並取得批准，不沿用舊R4或額度、不改走未批准模式。

### B. 現況唯讀核對（已獲准，現場部分完成）

已取得7/69、完整目標Aspect、原初始成功及近期原生歷史證據；當時核retention20版本。其後僅兩個指定Aspect政策已另准提高並讀回，全域20未變。這是13:15Z歷史狀態；15:28Z已恢復9041並真入口讀回新reader成功歷史。原version1空回應保留，不重試、未查内部DB。後續涉及其他資源或寫入不得沿用這次唯讀批准。

只核本案：服務／artifact／idle、登入身分、7/69 scope、真 before／Aspect版本、必要歷史與權限。既有登入失效由使用者正常登入；不自動讀 `.local/user.props`、provider auth 或啟動 OAuth。不能從舊 MCP 401 推定模型失效。

先核能否以公開歷史 API 讀取已存在的私有 Aspect 版本；Round 2 Task版本產生後再核 Task v1/v2。若現場 API 不符合既有讀取契約，保留原版本／locator並停止受影響操作，不改 Core、直查資料表或拿 current 替代 history。

### C. 另准建置及唯讀部署候選（本次已完成）

- 需同時對齊 Host integration、MFE、Pi Web tool/UI/skill 與 browser assets；磁碟來源已改不等於 running Host／image 已載入。
- 使用專用 builder 的既有1CPU／3GiB／no-extra-swap／serial solver、隔離HOME與專案鎖；不重新啟用已取消的 RAM/swap/disk headroom 門檻，不安裝或升級工具以繞過失敗。
- 不在開發 checkout 執行 `next build`。若批准正式 artifact 建置，只在受限建置環境用既有 pinned Dockerfile／lock，保留原downstream baseline並核候選差異；依 `scripts/check-agent-artifacts.mjs` 核 exact image 與 exported assets。
- 先凍結相容唯讀配置：publication=false、無AUTO／audit recovery grant；保留獲准的metadata讀取／模型opt-in、既有semanticAgentUrn與semanticAuditAudience=EXISTING_TASK_RUN_ACL，且先通過第1節修補驗證。兩個reader欄位不可因撤發布而刪掉；缺少它們仍應拒讀，不放寬reader。
- 切換只限本案9041／相应actor runtime／MFE資產；先確認 idle、備份既有配置及 HOME/session，記 exact PID/container/image/assets。保留歷史，不重啟 DataHub frontend/GMS、改 ACL、刪容器 volume 或操作其他專案。
- 真入口驗登入橋接與新提案。2026-10-02使用者已排除舊契約review相容性修復，保留原失敗及歷史，不以修舊資料阻擋本輪新預覽；新原生審核／收據與完整明細仍須在獲准的新紀錄上驗證，不把舊synthetic通過當live結果。失敗停止受影響段，不自動開發布窗口。

### D. 另准精確首輪／後續輪次寫入及模型

批准單須包含：

- 可信actor、Source／成功Run／recipe／scope；第4節逐項真實案例，包含definition建立與關聯各自權限；原生Task/Run/Decision寫入範圍。
- 一份新、明確到期、可撤回的 managed policy，允許kind／target及更新旗標精確列出。首輪與第二輪保持相同 managed policy digest／Task，後者用Task CAS接續。新的授權不得掩蓋或重送既有 UNKNOWN／未確認意圖；r1/r2原狀保留，已成功原意圖不重發。
- 建議窗口：準備完成才設定 T0，最長90分鐘、不自動延長；一個批准session，最多4則模型訊息（兩輪主訊息及最多兩則必要參數補正）。這是**本次驗收成本／操作上限**，不是產品輪數／tool-call上限，也不代表4則必定完成。若不夠，停下保留狀態再請示，不換session/key繞過。
- 模型與thinking需在現場已授權inventory核對後精確列入批准單；歷史 Sol/medium 僅供參考，不能當新授權或擅換provider。不讀／修改provider憑證，不額外購買額度。
- 首輪／第二輪提示詞與UI操作先備好；模型不批准自己。批次真人核准由受權人實際在Host確認，準備操作的授權不等於替真人勾選所有提案。
- 先處理實際可成立的新增／保持／需人審，再完整讀回；第二輪有真證據改變才執行更新。資料、schema、政策／ACL失效時沿既有規則停止或送審，不放寬條件來完成案例。

不執行 Source SQL／DDL／DML／profiling／ingestion、不建立新DB或測試假資產。真環境不故意製造失ACK、修改全域ACL、覆寫人工作品或取消生產操作做破壞性負例；這些已獲本地合成覆蓋，現場只核授權邊界與實際遭遇的失敗。需要真負例時另具名目標／操作授權。

### E. 撤回發布、相容唯讀讀回

1. 撤回新寫政策、publication=false，停止後續模型派送；目前送出的操作須核原生結果，不能把UI停止當取消已提交寫入。
2. 保留候選相容reader，從真入口重讀兩輪Task版本／Run／Decision、KEEP／definition／初始outcome；逐項核metadata及完整受保護Aspect，核原session與其他session未被覆寫。
3. 程式回復不是metadata回滾。不得刪歷史、重做attempt或自動將新值寫回舊值；需要補償變更時另走新證據與真人批准。
4. 若只有退舊reader才能恢復服務，先確認其對新紀錄／多pending的實際相容性；不相容就保留唯讀或停用受影響寫入口並報阻擋，不能以刪紀錄解決。

## 6. 停止與對帳規則

- 發布／分配／連結／保留的ACK不明：保留原request/Task/Run/Decision/attempt locator，停止受影響的寫入，只读對帳；不換UUID、policy或cycle重做。
- Task已分配而Run不明：不重配、不跳到下一generation。歷史初始 UNKNOWN 不因日後 MATCHED 變成成功。
- 可修正的模型參數／格式錯誤：先證明錯誤發生在哪一層、有無副作用；只有已知未造成未知效果者，才在原批准窗口、session與訊息上限內補正。不是重播已消耗意圖的授權。
- runtime／工具／建置失敗：保留錯誤與 exact run/process/source 狀態，停止該段；不自動改builder、模型、工具、權限、執行模式或提高預算。
- 部分成功：逐項列成功／未送出／未確認，保留成功成果。批次停止不把剩餘全說成成功，也不把不明效果說成零寫入。

## 7. 接受報告與下一個決定

報告須分開：

1. 真入口首輪成立的使用者能力、實際目標及證據；
2. 同政策第二輪真實變更、prior/current/new、人工保護與歷史；
3. 尚缺業務依據的目標／定義、待審事項及原因；
4. 未實作／未驗能力（含非描述自動替換政策、共用更新完整影響、品質基準／holdout）；
5. 撤回發布後的真唯讀讀回、session／完整Aspect保存與任何不明效果。

**A1、兩條精確retention政策、相容唯讀部署及成功歷史／模型選單／reload核驗均已完成；下一步為D段準備有依據的首輪與真變更第二輪並取得精確模型／寫入批准，不重做已完成前置，也不補r2例外取代主線。測試內容由主層自行處理，不再要求使用者提供檔案路徑；真實修訂不足時不得偽造。** 本文件不是live receipt，不啟動窗口，也不要求先以歷史audit收尾取代主線。

參考：`docs/design/datahub-semantic-agent-automanagement-proposal.md`、`extensions/datahub-agent/README.md`、本地 `CHECKPOINT.md`。旧 `E2E-STAGING-PLAN.md` 的單欄fill-only與75例外路線只保留為歷史，不再作本次完成線。

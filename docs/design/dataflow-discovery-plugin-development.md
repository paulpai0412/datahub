# DataFlow Discovery：Contract-first 插件開發

日期：2026-09-26。追蹤：TODO-9b105e9b。

## 1. 目標與完成線

使用者在 pi-web 指定新增的 Asset／程式語言／框架能力，Pi Agent 依固定版本的 interface contract 開發插件，透過可重跑檢查證明能力，再經審查及授權啟用。新增契約已能表達的能力不應修改 Discovery 主流程、DataHub Core 或授權規則。

來源與目標是同一資產在不同 edge 的角色。語言解析與框架語意分離；Transform plugin 描述資料依賴，不執行業務轉換。設定只組合已支援能力，不把未知語意变成已支援。

完整完成線：
1. 固定版本契約、可執行檢查、既有 Python 行為相容。
2. 真 pi-web/model 依 skill 開發一項新能力，非主開發者預先提供答案。
3. 候選在無憑證隔離環境執行，檢查結果綁來源、契約、測試與工具鏈版本。
4. 由正常 Discovery 入口使用新插件，核對真實授權來源；必要 DataHub Aspects、關係、ACL、版本及 UI 原生讀回成立。
5. 由使用者核准精確版本啟用。原規劃的獨立審查已由本輪使用者明確免除（第10節），不得聲稱有審查通過；候選保持隔離執行，不因此提升為可在Host直接import的可信程式。插件啟用、來源授權與metadata發布核准互不替代。

**本文件不是完成宣告。** 每項當前狀態見第 9 節及 verification 文件。

## 2. 分支與既有工作

- Branch：`feat/discovery-plugin-contract`。
- Worktree：`/home/timmypai/apps/datahub-worktrees/discovery-plugin-contract`。
- Base HEAD：`641eb966bb9e3f52cad76ed22893e49c8cfb3f36`。
- 帶入主工作樹105個相關未提交檔案；清單及 hashes 在 gitignored `.local/discovery-plugin-contract/baseline.json`。它們不是本次新改動。
- 不 stage／commit／push／merge；不更動主工作樹、既有其他 worktree或來源資料。最新使用者已核准本機`ekop-datahub`的Agent／Host／MFE受控測試更新（第10節），不是Core／DB／其他專案或metadata寫入批准。
- 不複製 `.local`、runtime HOME、credentials、node_modules 或 build outputs。開發工具只連結既有依賴，不安裝。

## 3. 架構與資料主責

```text
pi-web 開發 skill
  → 固定契約／能力盤點
  → 授權的插件開發 workspace
  → 候選程式與 manifest
  → 無憑證隔離執行 → 可信端契約／行為判定
  → source-bound 候選 → 審查／核准啟用

Discovery intent
  → 可信 Host capture／scope
  → 已註冊插件 → 中立 IR／證據／缺口
  → Asset／Catalog resolver
  → DataHub compatibility adapter
  → 既有 preserving diff／Task／Decision／CAS／讀回
```

- `EvidenceProvider`：來源檔案、規格、Catalog 或已授權 execution evidence。
- `Analyzer`：語言／框架分析，輸入已捕捉的資料，輸出中立圖。
- `AssetResolver`：身分、schema／fieldPath與來源scope核對。
- `DataHubAdapter`：IR到官方Entity／Aspect映射，不授予發布權。
- Host 持有授權、凭證、完整性、審核、版本衝突、preservation、取消與對帳責任。

第一版以純 Python callable 作插件實作 ABI；分析的程式語言不限 Python。跨語言 executable adapter 須有固定工具鏈與隔離執行支持，不能把 shell command 放進 manifest。先用現有 Python 分析與 OpenAPI JSON 資產插件驗證介面，不宣稱 Java／TS／Rust 已實作。

## 4. Contract v1

權威規格位於 `extensions/dataflow-discovery/contracts/v1/`；skill只引用，不複製另一份契約。

- Manifest：id、version、contractVersion、kind、capabilities、suffixes、limitations。
- Input：Host建立的不可變Snapshot與有schema的非秘密config。root、cookie、token、DataHub writer不交给插件。
- Output IR：assets／operations／ports、N→1 typed edges、file-bound evidence、逐檔coverage、findings。
- Port保留owner、direction及field paths；API request／response不是同一端口。
- 值依賴與條件依賴分離；calls／contains不推論value lineage。來源欄位不可由名稱相似度補造。
- 穩定node identity綁source scope、種類與原始locator，不含行號或snapshot digest；證據版本另存。
- 每個edge必須有可追溯evidence；每個snapshot file皆有coverage disposition，unsupported不可消失。
- Validator獨立檢查JSON shape、唯一ID、引用存在、port field、證據hash／scope／位置、coverage；Plugin自行輸出的success不具權威。
- Host result綁plugin manifest、config、snapshot、contract及graph digest，始終`publicationAuthorized:false`。Contract合格≠語意完整≠原生已發布。

v1保留既有`AnalysisResult`作legacy附帶證據，避免搬移時丟失Python欄位／unresolved資訊。既有workspace／publisher先保持不變，新IR不是舊publisher的新輸入；其完整遷移及Catalog binder抽離需要後續真來源等價驗證，不能以coarse graph代替既有欄位lineage。

## 5. Skill 契約

新入口 `discovery-plugin-dev` 與既有 metadata 使用 skill 分離。

步驟：需求與能力範圍 → 讀固定契約及相關參考 → 重用能力盤點 → 設定驗證 → 實作 → 固定檢查與修正 → 真來源接縫 → 交付候選。

每步有可檢查完成條件。Agent可改插件、自己的測試、manifest與文件；共用契約、固定測試基準、Host政策、Core、啟用版本清單不屬一般插件任務。契約不足則輸出具體變更提案，不擅改契約。

Skill不保證模型遵守，也不授予工具權限。遵循程度以工具呼叫、實際檔案與可信檢查紀錄評估，不以模型總結、`allowed-tools`或SKILL.md格式檢查認證。

## 6. 開發與驗證的信任邊界

- 新插件未審查前不得import到Host、Pi server或持有模型憑證的runtime。
- Worktree隔離修改，不是sandbox。候選執行使用固定映像、network-none、read-only root、non-root、cap-drop、CPU／memory／PID／timeout／output限制；不掛Docker socket或HOME。
- 可信端取候選的固定快照、執行固定測試集並產生收據；候選不能改測試／填寫合格結果。輸出schema合格仍不代表無惡意，正式啟用須審查。
- 新依賴／工具鏈／網路／來源權限另行批准；不能因缺依賴切換成不隔離的執行。
- runtime／transport異常保留原失敗與確切process狀態，不自動重播。明確的程式／輸入缺陷可修正後驗新候選；新收據不覆寫舊收據。
- 現有pi-web runtime只掛per-actor HOME與唯讀IPC，不能只新增skill就聲稱已有Host可寫workspace。開發runtime接入需實際部署政策及授權。
- 本案不新增datastore。程式與契約在repo；local檢查產物在既有gitignored evidence／session；正式metadata沿DataHub。暫存測試檔案不是業務狀態權威。

## 7. 測試矩陣

| ID | 要求／證據 |
| --- | --- |
| C01 | manifest及IR拒絕未知版本／多餘權限／錯誤引用 |
| C02 | 同名跨scope不碰撞；來源內容修改改receipt、不改穩定資產ID |
| C03 | 每條證據核file hash／scope／位置；漏掃、空結果、未知不可宣稱完整 |
| C04 | 值／條件／呼叫／包含分開；port field必須存在 |
| C05 | plugin id只查固定registry，不interprete成module或command |
| C06 | 舊Python analyzer輸出、candidate digest及validator結果保持等價 |
| C07 | OpenAPI method＋path身分、request／response分離、remote refs／未知語法保留缺口，不呼叫API |
| C08 | 最終source／contract／suite／runtime digest與實際執行收據一致 |
| C09 | 真SDK skill載入／命令展開、真pi-web模型遵循及中斷恢復分開驗證 |
| C10 | 真Discovery／DataHub讀回、preservation、scope撤回與新插件版本啟用 |

沿用既有unittest／Node test，不新增通用測試框架。合成負例只證明對應規則，不能替代真來源／部署验收。新框架首輪新插件由本次主開發者編寫，是ABI示例與本地行為檢查，不冒稱已由pi-web模型獨立開發。

## 8. 相容與升級

Core v1.7.0.1／SDK 1.7.0.9仍為當前基準。Table／Topic優先Dataset；BI使用Chart／Dashboard；API原生模型與OpenAPI connector的API_ENDPOINT Dataset映射不同，須實測選定路徑。一般UI component不可假裝成Chart；需要時使用官方Model／Aspect＋MFE，另驗ACL／query／version／readback。

新增插件不能自動啟用、取得來源或發布權；固定登錄清單經審查部署。舊Evidence及核准不刪除。契約升版需backward compatibility與既有插件回歸，不提供猜測式fallback。

## 9. 固定插件階段交付狀態（歷史；最新見 10.5）

**最新優先序（使用者更正）：先驗證並接通Discovery功能主流程，不先建立受控開發workspace或擴充安全測試。** 既有授權／隔離不變；先以固定第一方插件證明正常入口、完整Python行為與新資產預覽，再完成AI開發候選的admission能力。

- [x] 獨立branch/worktree與既有dirty基線保存。
- [x] 設計落檔。
- [x] Contract／registry／既有Python適配與新OpenAPI插件（本地候選；不取代既有workspace publisher）。
- [x] 已審閱第一方程式的固定本地檢查入口，64項Python測試通過。
- [x] 使用者核准的專用測試映像：固定依賴、無憑證隔離重跑64項第一方測試、10項runtime profile檢查及缺來源掛載負例通過。
- [x] 真ETL原碼＋保存的native Catalog功能重現：4 Jobs／37欄位與3 Jobs／8欄位，7項來源語意核對及現有React guard／server render通過；不是fresh Catalog／瀏覽器驗收。
- [x] 官方Analytics OpenAPI規格經新插件CLI產生API及獨立request／response ports；live規格讀取401，保持未驗。
- [x] **功能接線：新registry／IR接入原`datahub_etl`的list_plugins／analyze_workspace及MessageView預覽；保留完整Python／Catalog binders。** 真來源兩份完整JSON與接線前等價，76項Python、33項Node回歸及390／1280瀏覽器重播通過；不是live模型／認證／DataHub驗收。
- [ ] 其後：受保護的開發workspace、未審查候選runner及不可由writer改寫的驗收服務。
- [x] pi-web skill與opt-in只讀契約tool接線；5項SDK／接線測試及TypeScript檢查通過。
- [ ] 原生skill命令展開、真session工具限制與隔離執行證據。
- [ ] 真pi-web/model開發旅程。
- [ ] Fresh DataHub相容性／原生讀回、獨立審查與批准啟用。使用者本輪明確選擇先交付實作與測試、暫緩獨立審查。

實作及證據見 `docs/verification/dataflow-discovery-plugin-contract.md`。原MCP映像缺`sqlglot`的失敗保留；使用者另行核准後，已從固定Python基底建立專用測試映像，重用CLI鎖定版本及wheel hashes，實際隔離重跑同一64項測試。依賴僅安裝於新測試映像；Host及既有服務不變。此為已審閱第一方程式的隔離檢查，不是任意候選的正式驗收服務。

功能證據見 `docs/verification/dataflow-discovery-functional-flow.md` 第7節。已補齊同一工具／Host通道／聊天預覽；legacy是明確的相容adapter，不是插件失敗時的fallback。共用pi-web suite另有一項本輪改動前即存在的Grafana launcher不一致（34/35），保留基線證明，不修改無關功能來製造全綠；本輪沒有部署，完整模型／來源授權旅程仍需後續驗證。

主工作樹在分支基線之後另有9個既有檔案變動，本分支未同步或覆寫；整合回去之前必須重新比對。未通過的層級保持未完成，不以local PASS取代。

## 10. 最新：真 DataHub Agent 開發插件至啟用 E2E

使用者在能力盤點後明確選擇：

- **也要包含 Agent 開發新插件到啟用**，不只驗既有插件或分析預覽。
- **允許本機 Agent-only 測試更新**：先對帳並保留主工作樹其他功能與回復版本，保留HOME／session／資料；不動Core／DB／其他專案，不讀密碼檔。沿使用者提供的瀏覽器登入流程。

此授權不代表任意候選已獲啟用批准，也不代替逐項metadata差異確認或來源SQL／ETL執行批准。使用者接著明確指示「不用審查，不用子代理」：本輪全由主代理執行，不dispatch reviewer/security/其他子代理，不把主代理自查說成獨立review。候選驗證與啟用後分析皆保持無憑證隔離；未審查程式不import到Host或持有模型憑證的Pi runtime。Host固定驗證、結果綁定及精確版本啟用確認未免除。

### 10.1 現場預檢（唯讀，不是E2E通過）

- 主機DataHub UI與GMS正在運作，`/mfe/agent`及GMS health皆200；無憑證直接訪問Agent gateway回403，不視為功能故障。
- Gateway PID2599432的cwd為主工作樹`/home/timmypai/apps/datahub`。
- 現場runtime ID `58cf880ef2fcedf12f47e6cb881a6b42568c1808eed19bf4cee495e7647f2249`，image `sha256:9c329f1bb4469f519b64aa72a50131039b7a33723b3cede9a029616bc7fbfffc`。這只是本次觀測，實際切換前必須再核對。
- 現場沒有`/app/components/DataHubPluginPreview.tsx`及`/app/lib/discovery-plugin-preview.ts`；既有tool檔hash與功能分支不同。不能在這個舊部署跑完後宣稱新功能通過。
- 17個本輪功能檔在本次修改文件前與`flow-integration-checkpoint.json`一致。先前76／33／browser的範圍與限制不改寫。

### 10.2 同一使用者旅程的完成條件

1. 真DataHub登入與原Agent頁面，使用現有已授權模型；Chat-only仍不載入skills/extensions。
2. 模型讀取固定contract與開發skill，實際寫出一個此前不存在的新插件；不是主開發者預放實作或模型只複誦PASS。
3. writer只能修改候選程式／manifest／自己的測試及說明；不得改契約、Host固定期待、檢查器或啟用registry。
4. 候選只在無憑證、無網路、有資源與輸出限制的隔離環境執行。可信Host在候選程序外驗證結果，收據綁定候選、contract、輸入、suite及toolchain；候選自報成功不採信。
5. 真模型可依可信失敗診斷修改新revision並重驗；舊失敗留存，runtime或未知效果先對帳，不盲目重送。
6. 使用者核准精確候選版本；由operator固定registry／受控部署啟用，仍經隔離runner執行，不自行擴充成插件市場或熱載入管理平台。本輪明示未做獨立review。
7. 原`datahub_etl`列到已啟用版本，分析同一真來源，經Host及MessageView顯示資產／ports／fields／evidence／findings；reload後版本及來源可追溯。
8. 原Python ETL／Summary由真模型與fresh Catalog走原完整分析，既有37／8欄位的值、条件、生成語意仍正確；若現場schema已變，保留差异並依真來源核對，不硬套旧數量。
9. DataHub metadata發布／原生讀回只能在對應adapter、完整性及可信批准成立後驗；新插件啟用不等於metadata已發布。OpenAPI原生映射目前未完成，仍保持缺口，不假裝已發布。

首個新插件可用現有真官方OpenAPI YAML作有界案例：目前產品只收JSON，YAML需要外部預轉檔；讓真模型實作YAML輸入能力，JSON路徑僅作獨立宣告比對。此案例不等於任意語言／框架已支援，亦不執行API。

### 10.3 已定位的實作接縫（啟用前快照；最新見 10.5）

- `discovery-plugin-dev-extension.ts`保留原REFERENCE_ONLY工具；新增opt-in authoring extension與session-scoped源碼revision API。`contract/references/reference/verify`已沿原MFE／gateway／nativeDiscovery接到`plugin-development.mjs`，`save/read`仍只處理Pi HOME源碼revision。服務由operator按actor啟用，不接受模型指定來源路徑／URL／映像。固定原始官方YAML及Host scalar／未解析reference語意suite已實作；尚未部署或由真模型候選完成語意正例。
- `runtime-manager.mjs`只有既有per-actor HOME及唯讀IPC兩個mount。不要為候選掛Host repo、Docker socket或其他HOME；優先重用目前儲存與Host channel。
- `rpc-manager.ts`新增exclusive `plugin-dev` profile，固定第一方resources與工具、拒絕直接bash、跨profile重建會話，不允許缺模型時偷偷換provider。一般會話不自動啟用authoring tool。SDK loader／wrapper與既有RPC等76項Node檢查及TypeScript通過；尚非真登入／模型／部署驗收。
- `python-bridge.mjs`是具有Host檔案系統權限的固定第一方subprocess，不是未審查候選sandbox；不能直接新增candidate動態import。
- `isolated-plugin-runner.mjs`、`candidate_boundary.py`及`candidate_worker.py`新增三個分離容器程序：可信data-only準備、候選執行、候選外契約驗證。沿用固定image，沒有把候選import進Host／Pi。已實跑正例及偽造PASS／污染程序內validator／證據漂移／唯讀stage／輸出上限／逾時／取消；合成未結束journal也會擋住新runner。這些是執行接縫證據，不是新YAML能力、業務語意或live E2E驗收。
- 第一版啟用仍是operator核准的固定版本registry與受控部署；AI產出因未經獨立審查而維持隔離執行，不走Host動態import。沒有新增datastore、業務狀態檔案庫或第二Agent controller的必要。

### 10.4 啟用前的可重跑證據與剩餘完成線

- 專用profile的持久化採`version:1, tools:[], profile:"discovery-plugin-development"`。已用保存的舊reader原碼實測讀成Chat-only、新reader讀成開發profile；不是已部署回滾的證據。
- `tests/check_discovery_candidate_isolation.mjs <captured-request.json> <new-output-dir>`：8項真隔離程序案例＋1項明示合成journal的重啟拒絕案例。Host另讀原生狀態、mount／資源、stage與原始framework hashes；中斷保持BLOCKED，對帳PID0及移除成功後才結束測試，沒有把BLOCKED改成候選PASS。
- 正例使用真官方Analytics規格轉JSON及既有JSON插件的測試adapter（含dataclass import）。不是模型生成的新YAML插件；來源程式／SQL／API都未執行。writer自有`tests.py`目前只保存，不宣稱已執行或可取代Host期待。
- Private證據：`.local/discovery-plugin-contract/authoring-e2e-r2/`的76項Node及typecheck；`authoring-execution-r1/`的首個三階段實跑；`authoring-negative-r3/report.json`、`host-readback.json`及`persistence-rollback-proof.json`。舊r1/r2收據保持原樣。
- 新`tests/check_discovery_authoring_host.mjs`實走Host→Python與隔離prepare：固定契約、原始官方YAML、actor/reference拒絕、>8KB capsule、manifest拒絕（未import候選）、digest drift與普通Discovery原8KB限制通過。身分是synthetic；不是登入／模型證據。`authoring-host-r1/report.json`保留實際執行收據。
- 最新固定映像第一方單元8 suites共82/82通過；Host獨立核對63檔source/stage、image／安全profile／exit0／PID0／無OOM並移除容器，證據`authoring-unit-final-r1/`。Node回歸r2有52項通過，新HTTP測試修正素材fixture後另有`transport-r3.log` 1項通過，實證大payload及斷線取消；不改寫r1/r2的準備失敗。MFE使用既有webpack5.110.3／CLI7.2.3建置，未安裝或執行Next build。
- `rpc-manager.ts`仍有19項既有結構cast提示。AST比對20組chained expressions與修改前一致；primary TypeScript clean不等於結構提示已修復，見`rpc-preexisting-assertions.json`。
- 尚需精確版本operator activation、正常Discovery隔離執行及版本讀回、受控部署、真登入／模型寫碼／Host語意驗證／批准／fresh Catalog回歸。這些仍未完成，不能以契約驗證PASS取代。

上述為啟用前的歷史階段；後續進度與當前限制如下。

### 10.5 已批准的獨立啟用與最新完成線（2026-09-27）

使用者改採 Agent 完整隔離／Core 唯讀共用，僅使用 9141、獨立 tenant／actor HOME／config。真 `openai-codex/gpt-5.6-sol` 已自行完成 YAML 插件 `openapi-scalar-yaml 0.1.1`，由外部 Host suite 驗證 PASS；使用者批准精確 candidate `9bfe9dc8-5694-4c0f-bb9c-f1c5bbe77273`／digest `6bf8ab29051fbd4cb8e2bf0b311aefdc63fc20bcf33038aec495e0fc665b14b9`。這不包含 metadata 發布。

實作 `plugin-activation.mjs` 與 operator `pluginActivationsByActor`：每項固定 candidate、session、verification receipt SHA、source/selection/config，並核對現行 suite/framework、原始候選 bytes／隔離清理證據。只有已有來源與 development 授權的 actor 可用；一般 list_plugins／analyze_workspace 走原 Discovery 及 preview channel，執行仍由三階段無憑證 runner 負責。前後 source recapture、caller snapshot 及新結果 digest 都必須符合核准版本，漂移不回退 legacy。沒有模型 activate action、新 approval datastore 或候選 Host import。

已驗：30 項最終 release 回歸、真來源 Host harness、正常真模型 Discovery 與 MessageView、成功使用後的實際 Gateway 冷重啟／新 execution／版本追溯。原 ETL／Summary 整份 preview 與既有基線等值的 10 項隔離 Host 回歸也通過；後者仍使用歷史 Catalog，不是第 10.2(8) 項的真模型＋fresh Catalog 驗收。

Fresh 原生 Catalog 唯讀查詢成功，但目前 Core GraphQL 的 EntityType 無 API、Api type 為 null。官方 datamodel 已有 api，不能據此宣稱其 UI／GraphQL／REST 全部可用。官方 OpenAPI connector 的 Dataset + API_ENDPOINT 路徑亦未直接保留 method identity 與雙向 ports，需先確認官方 REST／擴充能力或核准語意完整的 adapter 設計；不自行修改 Core、偽造 lineage 或發布 metadata。

剩餘：原 ETL／Summary 在 9141 的明確 source/model-context allowlist 與 fresh Catalog live 驗收；原生 mapping／發布差異批准／ACL/readback；正式共用 MFE 部署另行授權。獨立審查依使用者要求 waived，不是通過。完整證據、保留的準備失敗與範圍見 `docs/verification/dataflow-discovery-parallel-test.md`。

### 10.6 官方 API REST 唯讀實測

後續已確認目前部署的 `/openapi/v2/entity/api`／`/{urn}`、live api registry、`ApiSignature.inputFields/outputFields` 與 `RestApiProperties.method/path`。建議使用官方 api entity＋既有 MFE／相容性 Adapter，而非僅因 GraphQL 未支援就改成 Dataset。這不是發布或正例實體讀回驗收。

實測的重要語意：不存在的 API URN，v2 GET 可合成 `apiKey` 而回200；同 URN 的官方 HEAD 回404。因此未來 adapter 不能以 GET200／key presence 充當存在或已發布證明。新增唯讀 operator checker 與7項 regression，第一輪不可判定保留；使用官方 HEAD 驗證，不改 Core。詳 `docs/verification/dataflow-discovery-api-rest.md`。

此節當時的下一步是離線原生映射／精確差異草稿，後續成果見§10.7。尚需正例entity/aspect讀回、授權矩陣及發布批准；固定YAML scope、來源與metadata寫入限制不變。

### 10.7 離線原生 API 映射與條件式差異

新增 `api_native.py` 相容性 Adapter及operator-only `scripts/draft-discovery-api.py`。不改IR／候選；精確source evidence唯一對應YAML operation/schema，不由localId/name猜method/path。以官方SDK產生apiProperties/subTypes/restApiProperties/apiSignature，原YAML全文保存於schemaDefinition，input/output各自保留；nullable依官方SchemaField的optional OR nullable語意，另記body optional／schema nullable原始差異。

提議的API identity由tenant/source/service/method/path共同決定，與plugin/content版本分離；不是ACL或namespace已核准。差異unknown不推定absence，既有不同aspect列CONFLICT、不自動覆蓋。草稿／差異永遠publicationAuthorized=false，不能套用至舊writer。

34項隔離tests PASS；真模型既有result資料重播＋public SDK roundtrip/MCP序列化PASS，未執行模型或候選。對產生的唯一URN實際HEAD404／GET200 key-only，再生成四個CONDITIONAL_NEW項目；不代表原子create-if-absent、已授權或已發送。SDK JSON與REST v2 wire差異明列，尚未驗write transport。

新增模組只在feature worktree，未更新private release或9141部署；舊驗證／批准收據不改。詳 `docs/verification/dataflow-discovery-api-mapping.md`。下一步先確認官方conditional conflict與ACL契約，再準備可信Host整合和精確發布批准；不能以先HEAD後UPSERT掩蓋並發缺口。

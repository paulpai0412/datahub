# Catalog 語義治理主線：設計與 SalesDatamart 驗收

日期：2026-09-28；驗證更新：2026-09-29。狀態：**主線已部署並完成 SalesDatamart 真 E2E；首筆 UNKNOWN 歷史保留，不宣稱全程零失敗**。結果與限制見 [現場驗證報告](../verification/datahub-semantic-catalog-mainline-live-20260929.md)。

後續方向（2026-10-03）：使用者已選[流程優先整批維護](datahub-semantic-maintenance-workflow-first.md)，一次確認定義、階層與套用計畫，再依序執行，不先配置額外 managed／AUTO policy。這是**新設計，尚未實作／驗收**；本文件的逐提案及定義／套用分開審核仍描述既有介接，不能直接當成新整批流程已完成。

## 1. 使用者目標與本輪取捨

從 DataHub 的 Agent 入口，以 `datahub-semantic` skill 維護**使用者指定的 Catalog**：

> 指定資產 → 讀取現況與來源證據 → Agent 提出定義／關聯／屬性變更 → before/after 人工確認 → 官方 API 條件式寫入 → 原生讀回 → UI／歷史核對。

涵蓋 Domain、Glossary 的 Term Groups／Terms、Tags、Structured Properties；既要維護共用定義，也要把它們套用到指定資產，不能以「只有預覽」、「只建立新值」或「一次欄位說明成功」代替交付。Glossary 是 Term Groups（`glossaryNode`）與 Terms（`glossaryTerm`）構成的詞彙体系，不新增自製 glossary datastore。

使用者本輪明確決定：**先不處理多人存取權限問題，先交付主線**。因此：

- 不部署新的私密審核路徑、不修改全域 Policy，不以私密 S4 模型作本輪前置。
- 審核沿用既有原生 Task／Run／Decision ACL；可能被其他有權讀取原生紀錄的帳號看見。UI 必須揭示，不能宣稱私人聊天或私密審核。
- 仍保留目前登入、原生資產讀／寫權限、使用者確認、版本衝突與一次性 attempt。延後多人隔離不等於匿名寫入或模型可以批准自己。
- 以 SalesDatamart 作真 E2E 目標；產品程式不得 hardcode 該來源、URN 或業務答案。

本輪不做來源 SQL／ETL／ingestion、業務資料修改、可信 Join、排程、長期自動代管、跨來源批量清理、刪除共用定義、第三方插件或新資料庫。不重播既有成功寫入或舊審核。

## 2. 現況與真正缺口

現有 `native-semantic.mjs`、`semantic-publication.mjs`、`native-semantic-tasks.mjs` 及 `task-records.mjs` 已有可信讀取、原生提案紀錄、父層人審、CAS、一次性 attempt、部分／UNKNOWN 對帳；應擴充這條路徑，不另建第二個 publisher。

實作前的現場基準只有一組核准來源、13 個 Dataset；可盤點與送審，五種新定義建立未啟用。既有 `semantic-steward/1` 是 fill/add-only，保護人工原值；共用定義只允許 create-only。單次 S3 真證據僅為欄位說明寫入。

初始缺口不是 LLM prompt 不夠完整，而是 Host 契約尚未具備：

1. Dataset 以外資產的同等讀取、版本、審核與發布接線。
2. 指定現有詞彙的受控更新及階層變更。
3. 明確的資產關聯 add/remove/set，以及已有屬性值更新。
4. 能區分「保留未選值」與「真人精確核准替換」的編譯／保護規則。
5. 上述功能的真 Agent＋官方 API＋UI 讀回證據。

## 3. 資產與更新範圍

### 3.1 Catalog 資產

支援 Dataset（含欄位）、Container、DataFlow、DataJob、Chart、Dashboard。只操作固定 Core 官方 Entity／Aspect；逐類驗證固定 registry 中的合法組合。

- Domain：資產 `domains`，不支援對欄位掛 Domain。
- Tags：資產 `globalTags`；Dataset 欄位使用 `editableSchemaMetadata` 中相應欄位。
- Terms：資產 `glossaryTerms`；Dataset 欄位同樣走官方 editable 欄位 metadata。
- Structured Property：資產 `structuredProperties`；欄位沿官方 `schemaField` entity，保留完整 fieldPath 與精確編碼。
- Description：相应官方 editable properties；欄位沿 editable schema。

資產 scope 是使用者指定並由 Host／當前原生 ACL 核對的精確清單。既有 Source 設定仍作允許模型使用 metadata 與發布的邊界；不把任意新 URN 當 scope，不把核准子集說成完整來源 inventory。非 Dataset 不偽裝成 Dataset 或宣稱有同一次 ingestion membership。

### 3.2 共用定義

| 定義 | 建立 | 修改既有定義 |
| --- | --- | --- |
| Domain | 名稱、說明、可選 parent Domain | 名稱、說明、parent；驗 parent 存在及無循環 |
| Term Group | 名稱、定義、可選 parent Group | 名稱、定義、parent；驗 parent 存在及無循環 |
| Term | 名稱、定義、可選 parent Group | 名稱、定義、parent；保留 termSource 與未選欄位 |
| Tag | 名稱、說明 | 名稱、說明，保留其他原生欄位 |
| Structured Property | 顯示名、說明、string/number、單／多值、適用資產類型、可選允許值 | 顯示名、說明；既有值可在資產端更新。此輪不做會破壞既有 assignments 的 valueType／cardinality／qualifiedName 遷移 |

新建 URN 仍由 Host 產生，不接受任意目標 Aspect／API。更新必須引用已讀回的精確 definition URN／version；不得以新建同名詞彙冒充更新。刪除／復活已刪除的共用定義不在本輪範圍。

共用定義的變更會影響所有使用該詞彙的資產。審核 UI 顯示已觀測依賴與不完整限制，不聲稱 native search 是全域原子清單；SalesDatamart E2E 使用明確屬於本輪的測試定義，不改不相關全域分類。

## 4. 契約與實作接點

### 4.1 保留既有邊界

```text
Agent skill／datahub_semantic（結構化意圖，無 approve/publish）
  → Pi UI bridge → DataHub MFE／Host
  → 當前 DataHub 身分、精確 scope、native snapshot／ACL
  → typed semantic compiler → 原生 Task／Run／Decision
  → 可信父層 Review／Approve
  → 既有 taskRecords publisher：CAS／attempt／readback
  → 語义結果卡、Catalog 原生頁與歷史
```

不增加 worker、SQL runner、datastore、通用 workflow engine；不把秘密放模型、審核紀錄或普通日誌。

### 4.2 新舊版本分離

- 舊 `semantic-steward/1` 的 fill/add-only 與 create-only 保持不變；原 review／consent 不自動升級。
- 新契約使用獨立版本，支援 `assetUrn`、明確 operation、definition 更新目標及版本。
- 一次 review 綁定精確所選資產／定義、snapshot、candidate ids、原值、編譯後值、使用者及 expiry。
- 不把非 Dataset URN 填入 `datasets`。若現有原生模型不能保存必要的精確 scope，採官方 optional 欄位 expand-contract；先通過本地 loader／舊資料相容性檢查，部署另行確認。不得偷偷用 Core patch 或非標準 datastore 繞過。

### 4.3 精確修改而非全 Aspect 接管

- `add`／`remove` 只影響指定的 Term／Tag／Domain 關聯；`set` 顯式呈現被替換的集合或值。
- 刪除欄位的 editable 關聯不宣稱同時刪掉 connector 提供的 source tag／term。
- property 驗原生 definition 的 entityTypes、型別、cardinality、allowedValues、immutable 規則；不把 number 格式任意轉字串。
- beforeValue 必須等於最新讀回值；編譯器從 before 複製後只改契約允許的路徑，保留未知欄位、其他關聯及 metadata。
- 既有值更新在 UI 明示為替換／移除，不再用 fill-only 拒絕所有更新，也不直接移除舊保護讓任意覆寫通過。
- 準備、核准前重編譯與原生 CAS 都使用同一編譯規則，不能只憑模型聲稱有權或已確認。

### 4.4 部分成功與錯誤

官方 CAS 是 per-Aspect，非跨資產 transaction。先驗全部目標，再逐項保留 outcome。attempt 已消耗後，不論成功、部分成功、lost ACK、超時，都只讀回／對帳，不自動重送。修改 source／schema／definition／scope 或 approval 過期須重新準備，不沿用旧 consent。

### 4.5 固定版本原生相容性

- Core Domains v2 會同步 `domains`／`domainAssociations`。新發布在 outgoing payload 明列兩者，保留保留項目的 attribution／未知欄位及原生排序；完整 Aspect 讀回比較不放寬。
- 只有修改 Domains 的新 Catalog review 封存 `domainsAspectVersion:2`。沒有此 marker 的舊 review 仍可按原編碼讀取，但不可在舊 consent 下取得新 payload；舊 attempt 不重送。Legacy fill-only 同樣使用合法原生 shape，不擴張其修改意圖。
- Catalog 共用 GraphQL overview 對六類資產讀取 editable description，不能只讀 Dataset 的 editable 值而讓其他資產回退到舊 source description。
- 公開 UI 路徑為 DataFlow → `pipelines`、DataJob → `tasks`。新結果使用正確路徑；歷史結果的舊路徑只作精確相容輸入，導航一律正規化至正確公開路徑，不放寬任意 URL 路徑。

## 5. UI／skill

- 沿用現有 Semantic preview、review sidepanel 與 history，不另開管理平台。
- 新增「語義治理」工具組，精確使用 `datahub_catalog`、`datahub_semantic`；不擴大既有 DataHub-only 查詢工具組。保存為具名 `semantic-governance` profile，舊版／未知 profile 拒絕恢復，不降為全工具。
- 以固定 SDK 的 `tools` registry 白名單約束延遲註冊、啟用與 reload，不只在啟動時縮減 active tools。切換受限工具組須重建 session runtime；模型、歷史與明確工具選擇保留。既有 DataHub-only 同樣使用其三個工具的 SDK 白名單。
- 顯示目標類型／名稱／原生連結、operation、before/after、證據與目前版本；非 Dataset 不標成資料表。
- 詞彙建立／更新與資產套用分開審核；建立成功讀回後才能把新 URN 用於下一次關聯提案。
- skill 先搜尋／重用、再提案；不得用名稱猜業務口徑，也不能把聊天「同意」當 UI 核准。
- Review 頁明示既有 Task／Run ACL 的可見性，本轮未提供多人隔離。

## 6. SalesDatamart E2E 與完成線

入口 `http://localhost:9002/mfe/agent`，使用人類已登入且模型已配置的現有帳號與模型。不複製 provider credential，不用 CLI 模型回答／直接 Host writes 冒充真入口。

| 情境 | 必要證據 |
| --- | --- |
| 發現與選取 SalesDatamart | 真 Catalog 身分、精確資產清單／類型、模型取得工具／skill；不靠硬編碼答案 |
| 新建 Domain／Term Group／Term／Tag／Property | 真 Agent 提案、UI before/after、人審、官方 API 值／版本讀回；Term 掛在正確 Group |
| 更新這些既有定義 | 第二個精確 review 修改既有同一 URN，而非建立同名替身；未選欄位保留 |
| 套用 Domain／Term／Tag／Property | 實際所選資產與至少一個 Dataset 欄位的官方 Aspect／UI 對帳 |
| 更新已有值／調整關聯 | 所選改動正確、未選既有值保留，移除與來源原始欄位 metadata 的界線清楚 |
| 六類資產路徑 | 每類實際存在的 SalesDatamart 相關資產均取得真讀寫／讀回；若某類不存在，明列證據缺口，不造假或以另一類代替 |
| stale／拒絕／重載 | 先以可重跑 fixture 驗 CAS、父層拒絕、lost ACK 不重送；真入口至少驗拒絕不寫、歷史重開不重新發布 |
| 完成判定 | native readback＋使用者可見結果＋歷史一致；初始 outcome 與後續觀測分開，不以 HTTP200／preview／schema編譯成功代替 |

fixture／單元測試覆蓋型別、範圍、未知欄位保全、階層循環、版本變更、取消／拒絕、partial／UNKNOWN 與舊契約相容性。它們不是 native E2E 證據。

## 7. 部署與操作界線

- 保持 DataHub Core 乾淨、固定版本；使用官方 Model／公開 API／MFE 擴充點。
- Pi 變更需同源 downstream patch／lock、固定映像及 browser assets；只用既有 bounded builder，不在開發 checkout 執行 next build。
- 9041 的切換前版本依賴 Discovery repair worktree／assets；保留原部署與回復資料及尚有引用的 worktree。Git 合併不等於部署或解除其他設定依賴，不自動刪除 worktree。
- 切換前確認 active work、保全 HOME／session、列出精確 config／image／MFE／必要 Model 變更並取得維護確認。保留可回復產物，不自動回退 metadata。
- 本輪未授權新來源憑證、來源 DB 寫入、政策隔離、commit／push 或刪除歷史證據。

本地階段保留於 [本地驗證報告](../verification/datahub-semantic-catalog-mainline-local-20260928.md)，最終部署與原生 API／UI／history 結果見 [現場驗證報告](../verification/datahub-semantic-catalog-mainline-live-20260929.md)。使用者已明確允許本案必要維護與限定 metadata 驗收；0.1.10 官方熱載入成功，GMS 未重啟。沒有覆寫原 checkpoint、S3／S4 或 UNKNOWN 歷史，也沒有執行 SQL／ETL／ingestion 或修改 Core。

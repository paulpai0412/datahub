# S4 原生私密審核：官方 Model／Policy 設計候選

狀態（2026-09-27 更新）：使用者已核准**本地模型與完整資產路徑實作／測試**；新審核讀者限定 `datahub`，保留原生管理員權限。官方 loader 實測不能重用 ownership 後，使用者進一步核准改採**專屬 Entity＋明確 actor 的原生型別政策**，不再依賴 ownership 自動授權。修訂的 0.1.9 候選已通過 Pegasus、官方 Registry 載入與 0.1.8→0.1.9 merge；仍**未部署，原生 API／ACL 與 Host writer 未驗收**。尚未授權切換使用中 GMS／全域政策。詳見[本地驗證及最小對照](../verification/datahub-semantic-private-model-local-20260927.md)。

自 S4 新審核起必須原生隔離；S3 歷史仍依當時核准的 `EXISTING_TASK_RUN_ACL` 保留及標示，不刪、不覆寫。不得把敏感內容回退寫入 S3 公開紀錄。此文件不是可執行的現場變更單。

## 為何不能只補 scoped grant

目前 GMS 16 條 ACTIVE 政策中有 1 條無資產篩選的 All Users `VIEW_ENTITY_PAGE`。真非 owner B 對既存 Semantic S3 Run／Task 和普通 DataFlow Job，三個精確資源的 `VIEW_ENTITY_PAGE` 均僅來自這一條；B 均無 `EDIT_ENTITY`。原生 B batchGet 可讀 S3 review、Decision 及 `beforeValueJson`，Host 不回 Pi state 不能修復這項可見性。固定 `PolicyEngine.getGrantedPrivileges` 聯集所有適用 allow，沒有 deny 可蓋過全域規則。直接移走全域 grant 也會改變普通 Job 的既有可見性。

固定 Policy engine 的 `TYPE` 取自 EntitySpec，`NOT_EQUALS` 對其比對可排除單一 Entity type；但對可缺失欄位如 platform instance 使用 `NOT_EQUALS` 會把空集合也視為符合，不能作防洩漏條件。`dataJob` 的原生 ownership 可重用，固定 registry 的 `dataProcessInstance` 沒有 ownership；自訂 `ekopAgentRun.actor` 不參與原生 owner policy。公開 GraphQL `PolicyUpdateInput` 無 expectedVersion，resolver 用一般 ingest 加 cache invalidation；不得假定 CAS、原子切換或自動安全回退。來源／真收據見 [操作矩陣](../verification/datahub-agent-operations-matrix.md)。

## 目前核准的候選邊界

- 唯一新原生 Entity 為 `ekopSemanticReview`；新 key／`ekopSemanticTask`／`ekopSemanticRun` 均為插件 Aspects，不加 ownership／status，不重定義 Core Aspect。tenant／actor／source／Catalog assets 與 Task revision／session／Decision 留在私密 Entity；不建立公開鏡像。
- 型別級原生政策明確指定 `datahub` 為讀者，保留原生管理員。現有 All Users VIEW grant 必須排除新型別；原生 policy 生效前不能寫敏感資料。Actor 字段、Host guard 或 URI 隱藏本身都不是 native ACL。
- 不再有隨 ownership 自動轉移讀權的行為；更換審核者需明確變更 native policy。使用者目前只核准本地候選，不能据此套用現場政策。
- 模型已在固定 Core jars 載入；仍需獲准隔離環境的無敏感 canary，涵蓋指定 actor、非指定 actor、管理員、歷史版本、公開 API 與普通 Catalog 不退化。沒有把 schema 或 loader PASS 當隔離 PASS。
- 原生隔離及私密 Task／Run 契約通過後，Host 才能啟用新路由；六類資產 compiler／writer、MFE 審核與實際發布尚未完成。

## 原 ownership 草案（保留推導，已由上述方向取代）

1. 透過官方 `metadata-models-custom` 格式建立**專屬新 Entity type**，由插件提供 key Aspect、私密 S4 審核／Decision／執行紀錄 Aspect，並把官方 `ownership` 加到該 Entity，作為該次 S4 審核的**唯一權威紀錄**。這不是把舊 `dataJob`／`dataProcessInstance` 改名；是否以這個原生新型別承擔新流程的 Task／Run 歷史契約，仍須明確驗收。使用既有 DataHub 儲存，無新 datastore 或 Core patch；URN 為不授權的 opaque locator，Actor／tenant／source 僅取自可信 Host 而非呼叫端。固定上游文件允許新 Entity／Aspect，但不保證 GraphQL／原生 UI 自動支援；若 `/mfe/agent` 要讀寫，須以公開 generic／batchGet 與既有 MFE 相容性 Adapter 在實機證明，不能以固定 Core 私有 API 補洞。
2. 在**隔離部署**研議將現有 All Users metadata grant 改成 `TYPE NOT_EQUALS <新 type>`；另外只給 native owner／**經明確核准的審核者**對新 type 的最低讀取權。TYPE 由 `EntityTypeFieldResolverProvider` 必然解析自資源型別，理論上仍允許原 `dataJob`、`dataProcessInstance`、Dataset 與治理資產。這不是現場已驗證語義：對**未附 resource spec** 的權限請求，固定 `PolicyEngine.isResourceMatch` 在有 filter 時直接返回 false，即使既有 Catalog 資源查詢不變，全域 privilege probe／UI 仍可能失效；也要查全部其他 role／user／owner policies 和平台管理員權限是否對新 type 意外給讀。不得以新增另一條無限制 VIEW grant 補 UI，因為它會重新公開私密 Entity。
3. **新 S4 不再把敏感 review 放入現有公開 `ekopAgentRun.publicationReview`／Task 指令或 Pi 外部回應**。現行 `native-semantic-tasks.mjs` 的 `prepare_review` 先建 `dataJob` Task、綁 `dataProcessInstance` Run，再向同一 Run append `publicationReview`；此路徑僅供經核准 ACL 的 S3 歷史。S4 若選專屬 Entity，需在 Host 共用治理邊界按 ref type 明確路由新的準備／核准／歷史讀回，且失敗不能回退寫公開 Run。正式資料形狀與審核者授權、是否留無敏感內容的公開 Task／Run 索引，須在試驗前確認；索引不可包含 review、前值、actor 私有上下文或足以重建之資料。
4. 切換次序須先完成新 Model 在**測試部署**的固定版本載入與公開 API 相容驗證，事前封存完整 policies／版本及代表性 Actor 資產可見性，並有已驗證的恢復程序；再對全域規則與 owner 規則做唯讀對帳。**所有 GMS/Frontend 節點與 cache 已證生效之前不得寫任何敏感 S4 資料**。建立私密資料時先以最小權限寫 native ownership、驗 owner／非 owner 正反例，再 CAS 寫 review；缺 owner 或任何欄位／policy 不明即拒絕。Native CAS 只保證 Aspect 版本，不等於跨 Aspect 原子寫或安全 rollback；未知結果先查回，不重播。

## 可接受試驗與中止條件

- 在 credential-free、與現場隔離的固定版建置環境準備模型候選；**隔離部署／政策試驗仍需對確定目標、操作另取授權**，實測 Actor 憑證只進入受保護的測試環境。以兩名受權 Actor、代表性現有 Dataset／非 Agent Job／Run／治理資產保存前後可見性與功能；不能使用 fixture 冒充正式真入口驗收。若調整政策後 B 的正常 Catalog 讀取、全域 privilege probe、搜尋／MFE 導覽退化，就中止，不能寬放私密 type 的讀權求通過。
- 新 type 使用**無敏感值** canary 測 native owner 可讀、非 owner 無法讀；覆蓋公開 batchGet（含歷史版本）、generic／search／scroll／GraphQL（若支援）、MCP／Host 歷史與 MFE。部分 endpoint 若繞過 ACL 或索引洩露，就禁止敏感寫入，不能以 Host owner guard／隱藏按鈕當補救。核實已知 role/group/admin 的預期讀者名單和跨 tenant／source 範圍，不把 Catalog 可見權當 review 授權。
- 驗證正向人工審核、三方 prior-Agent／current human／proposal diff、stale CAS 拒絕、撤權、失敗及未知提交讀回。拒絕、過期或部分成功不復活舊核准，不重送既成 S3／ingestion／ETL。審核 append 與版本要與實際 native record 綁定，不依賴僅 Host 內部狀態。
- 政策 mutation GraphQL 未提供 expectedVersion：測前後比對全量快照、計畫受控時窗／變更者與失敗對帳；遇未知效果或競爭修改即暫停，不盲目重試／回滾。新資料一旦寫入，不能用卸載新 Model 或刪除歷史當回復；保留可讀的擴充版本與回復相容契約。升級另驗官方 Core／SDK／MFE 的同等 ACL。

**已決定**：新 review audience 為 `datahub`＋原生管理員，以明確 actor 的 native type policy 承擔隔離，不依賴 ownership；完整 Catalog 選取不得偽裝成同一次 ingestion。**仍待決策／驗收**：隔離測試的環境與資源（本機 available 約 2.9 GiB，不假定能安全啟動另一套 Quickstart）；原生 API／ACL；新 Task／Run 歷史與 Host／MFE 接線；以及現場切換的精確目標、政策變更與回復授權。本地候選沒有公開 mirror 或第二份權威。未通過原生讀者隔離前，S4 敏感審核保持停止。

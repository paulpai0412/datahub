# T06 Task／Decision 的最小官方模型擴充

## Semantic Steward 本地候選 0.1.8

本工作樹 `toolchain.lock.json`／`build.gradle` 的目前來源版本為 **0.1.8**。增加三個 optional string：publication review 的 `semanticContextJson`、change 的 `beforeValueJson`、attempt 的 `outcomeJson`。它們沿用既有 Task／Run／Decision，不新增 Entity／store；舊記錄不會因缺欄位被當成已批准或已成功。

0.1.8 已使用固定官方 Core jars、既有 checksum 驗證依賴，在 credential-free／network-none 容器以 Gradle offline 建置並通過 Pegasus roundtrip／annotation 檢查；產物留在工作樹 `.local/evidence/semantic-steward/s3/model-build/`。**未部署**。不得把新欄位送到未載入相容模型的 GMS，不覆寫舊 release 或以刪除歷史回滾。

既有實測 Task／Run 可由其他 Catalog Reader 讀取，並非 actor 私有區。Steward operator policy 必須明列 `semanticAuditAudience: EXISTING_TASK_RUN_ACL` 才能準備提案；這是對既有可見範圍的明確確認，不會自動變更 Policy 或縮限 Native API。若需更窄的讀者範圍，先以官方 Policy 配置並驗證；不得僅依 Host owner check 宣稱底層記錄已隔離。記錄禁止憑證；完整 before／after 也只可涵蓋已批准落入該原生 ACL 的 metadata。

目前 S3 接線與證據見 [Semantic Steward S3](../../../docs/verification/datahub-semantic-steward-s3.md)。**以下 0.1.0–0.1.3 部分是當時記錄，不代表目前線上版本；本輪沒有讀取或切換線上 registry。**


使用 DataHub v1.7.0.1 的官方 `metadata-models-custom` 產物格式及 model registry loader；不修改 Core，不新增 Entity 或 datastore。

| 原生 Entity | 新增 Aspect | 用途 |
| --- | --- | --- |
| `dataJob` | `ekopAgentTask` | Agent、actor、既有 Source、精確 Dataset scope、指令與是否允許 Decision |
| `dataProcessInstance` | `ekopAgentRun` | Task revision、actor／source、既有 Pi session 關聯、Decision 歷史及可選 `closedAt` |

Decision 的問題與回覆是 Run Aspect 裡的 records，不另建實體。沒有 response 表示 pending；RESPOND 與 DISMISS 不代表 SQL、Join 或 metadata write 的授權。原生名稱、ownership、properties、relationships、run events 繼續使用原生 Aspects，沒有重定義或打包 Core classes。

**已部署／真 API 驗證的是 `0.1.1`；目前來源版本 `0.1.3` 只完成本地模型／Host 審核及一次 admission 相容檢查，未部署；`0.1.2` 本地產物也保留。** 模型不會自動執行 Pi，也不提供排程器。Schema 的欄位、註解及版本比較不是 Host 授權、回答一次或 append-only 的實作。

## 建置

版本與輸入見 `toolchain.lock.json`。Pegasus Maven 依賴的 SHA-256 固定於 `gradle/verification-metadata.xml`；它是首次下載的 checksum 記錄，不冒充簽章驗證。Core jars 取自鎖定 GMS image 的 `/datahub/datahub-gms/bin/war.war`，其 libraries 在 `BOOT-INF/lib/`。Core WAR／schema jars 的 SHA-256 已記錄，不接受別版 jars 冒充相容。

在憑證隔離的建置容器，使用對應 JDK、Gradle 與唯讀 Core libraries：

```sh
gradle --no-daemon --max-workers=1 \
  -Dorg.gradle.jvmargs='-Xmx1024m -XX:MaxMetaspaceSize=384m -XX:ActiveProcessorCount=1' \
  -PcoreLibDir=/path/to/pinned-gms-BOOT-INF-lib build
```

本次建置容器固定一 CPU、3 GiB memory、swap 0、256 PIDs；沒有掛入使用者 HOME、登入資料或 Docker socket。依賴取得後，在同一固定容器 `--network none` 配合 Gradle `--offline` 建置通過。使用 Java 21；Pegasus 預設生成 Java 8 相容 bytecode，編譯有 obsolete source/target 警告。Core libraries 的 ANTLR parser／runtime 版本也有原生警告，未為了消除警告換版。Gradle 9 不在支援範圍。

`modelCheck` 直接使用生成的 Java records 與實際 Pegasus codec，驗 Task／Run／Decision roundtrip、pending／RESPOND／DISMISS、缺欄位及無效 action。這不是 GMS ACL 或 Agent E2E。

本地新產物：`build/0.1.3/dist/ekop-agent-tasks-0.1.3.zip`；在獨立、無憑證 workspace 建置，須一併複製既有 `gradle/verification-metadata.xml`，使用 `--offline --dependency-verification strict`。已發布 `0.1.0`／`0.1.1` 保留不變。僅包含 registry YAML 與兩個本插件 jars，不帶入 Core libraries 或 test jar。

`0.1.2` 增加可選 publication review／typed verdict，LINEAGE 與 SEMANTIC 分開；完整 source/candidate／Aspect 值與版本／expiry 綁 digest。一般 RESPOND 不取得授權，新模型可讀舊記錄。`0.1.3` 另在 Decision 加入可選 `publicationAttempt`（Host UUID／claimedAt）；既有 Run CAS 只容許一個 attempt 消耗該 Decision 的核准，關閉、失敗或重啟不清除 marker。marker 不代表已送出 target request 或發布成功，也不是 lease／可攜式 capability。本地 Host admission 與條件 writer／原生 provenance 對帳已驗，真來源 compiler callback 另已有本地驗證，但仍未配置生產 preparation／Agent caller、未部署；詳 [本地審核契約與證據](../../../docs/verification/dataflow-discovery-publication-review.md)。不要把新欄位送到仍為 `0.1.1` 的使用中模型，也不可直接撤 schema／刪歷史當回滾。

## 載入與權限

以下是 `0.1.1` 的既有部署記錄，不授權部署 `0.1.2` 或 `0.1.3`。

取得維護核准後，解開至既有 bind mount：

```text
.local/plugins/models/ekop-agent-tasks/0.1.1/
├── entity-registry.yml
└── libs/*.jar
```

GMS image 使用 UID 100，與本機 UID 1000 不同。公開插件目錄及其子目錄須 `0755`，檔案 `0644`；`.local` 與憑證權限保持不動。`scripts/init-local.py` 已修正原先 `umask 077` 將 plugins 的 `mkdir(mode=0755)` 降成 `0700` 的問題，也涵蓋既有憑證的 early return；檢查為 `python3 tests/test_local_plugin_permissions.py`。

官方 loader 在啟動時遇到不可達／不存在的 model 目錄會停用掃描，後來只建立目錄不會自動恢復；這種情況需要核准的 GMS 重啟。版本目錄及已發布模型不可原地覆寫。新版本、其他服務或部署切換仍需依專案規則取得授權。

載入成功依 GMS `/config` 的 `models.ekop-agent-tasks.0.1.1.loadResult` 與真 Aspect API 判定，不只看 health 200。本次 `0.1.1` 由已啟用的官方 loader 定期掃描載入，無須重啟；這與首次父目錄不可達而停用掃描不同。未寫入新模型資料前的載入失敗，可以在核准範圍撤回新插件並重啟；有新資料後不能直接撤除其 schema 或刪資料當作 rollback。

## 已驗證的 API 契約與界線

使用官方公開 OpenAPI v3：

- `POST /openapi/v3/entity/generic?async=false&systemMetadata=true`：各 Aspect 的 `value` 與 body `headers`；`If-Version-Match: -1` 僅首次建立，既有寫入使用讀回的 `systemMetadata.version`。
- `POST /openapi/v3/entity/{entityName}/batchGet?systemMetadata=true`：讀回最新；body Aspect `headers.If-Version-Match` 可指定歷史版本。
- 真 canary 證明過舊寫入 `412`，兩個並行同版本寫入一個 `200`／一個 `412`，以及 winner／原 pending 歷史讀回；匿名讀取 `401`。
- 真 service Reader 對 Registry／Task／Run 讀取 `200`，對新 Task／Run Aspects 寫入 `403`，內容與 version 未變。本次一次性 token 已立即撤銷並驗 `401`，未保存或配置至 MCP。這不等於 Host owner 隔離；Task 指令／Decision metadata 目前可被其他 Catalog Reader 讀取，尚未當作 actor 私有內容。
- OpenAPI 文件的靜態 schema 清單未出現客製 record，但上述公開 generic／batchGet API 確實成功，不宣稱自動產生 GraphQL 或 UI。

`0.1.1` 僅在 Run 加入可選 `closedAt`：與 Decision 同一 Aspect 做 CAS，表示 Host 不再接受該 Run 的提交，不代表 Pi 已停止。舊資料沒有該欄位仍可讀，不能因此自動恢復執行。真 API 已驗關閉時間讀回、關閉前版本的晚到回答被拒絕 `412`、舊 Task／Run／Decision 最新值及歷史不變。持最新版本者仍須由 Host 拒絕重新開啟或修改歷史，schema 本身不會執行此規則。

Host 接線仍須完成：從可信認證取得 actor，重新檢查來源／資產與 session 所有權；在同一 Run revision 下追加 Decision、拒絕已回覆項目的再答與過期執行者提交；由既有 Pi 功能執行、取消及恢復。CAS 本身不會禁止持有新版本的人改寫舊 Decision；不能把它當成 append-only 或業務審核完成。

本次 canary 明確標記為模型／API 契約檢查，sessionId 為 `model-contract-check-no-pi-session`；沒有真 Pi 執行、人工批准、SQL 或排程。完整證據與未完成項目見 `docs/verification/datahub-agent-task-models.md`、`docs/datahub-agent-todo.md`。

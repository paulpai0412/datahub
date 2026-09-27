# Discovery Plugin Contract — 驗證紀錄

日期：2026-09-26（下文為各階段歷史證據）。任務：TODO-9b105e9b。

**最新狀態（2026-09-27）：**真模型 YAML 候選已通過 Host，使用者已批准精確版本；僅獨立 9141 啟用，正常 Discovery／真預覽／冷重啟新執行及 legacy 完整預覽等值回歸通過。原生 API mapping／發布及 legacy 真模型＋fresh Catalog 仍未完成，無 metadata 寫入；見 [独立啟用驗證與限制](dataflow-discovery-parallel-test.md)。

**早期固定插件功能交付：**已依使用者功能優先序接通`list_plugins → analyze_workspace → Host registry → MessageView插件預覽`，不另建安全框架。真ETL／Summary整份JSON與接線前相等，仍4 Jobs／37欄位及3 Jobs／8欄位；官方OpenAPI規格通過同一Host入口並由實際MessageView瀏覽器重播。76項Python、33項Node回歸及TypeScript通過；共用UI suite有一項已證明改動前即存在的Grafana失敗（34/35）。使用者明確同意暫緩獨立審查；未部署或宣稱真模型／fresh DataHub E2E。詳見 [功能主流程驗證第7節](dataflow-discovery-functional-flow.md#7-已實作插件--原-discovery-入口--聊天預覽)；下文保留各前一輪證據的原始範圍。

## 1. 原始碼與交付

- Worktree：`/home/timmypai/apps/datahub-worktrees/discovery-plugin-contract`
- Branch：`feat/discovery-plugin-contract`
- Base HEAD：`641eb966bb9e3f52cad76ed22893e49c8cfb3f36`
- 新增Contract v1、獨立validator、explicit registry、`legacy-static`與`openapi-operations`、operator CLI。
- 新增固定本地檢查腳本、opt-in只讀契約tool與`discovery-plugin-dev` skill。没有新增套件／datastore、改Core、部署、啟用候選、執行來源SQL／API、commit／push／merge。
- 開始時帶入105個相關dirty檔案，逐檔基線在`.local/discovery-plugin-contract/baseline.json`。既有workspace／publisher／bridge修改保持帶入版本，不當成本次成果。
- 主工作樹之後有9檔與帶入基線不同（Grafana設計、agent README、gateway／native-grafana／server、MFE與兩份測試），詳見`delta-before-docs.json`。本次沒有寫入這些主工作樹路徑、回灌或重新同步；整合前需重新比對。
- 官方Core主checkout乾淨，仍為`e99431ec510d7a2001f815c6bf70913c493af76e`；本worktree無staged檔案。

## 2. 已執行的驗證

| 層級 | 結果 | 證明範圍 |
| --- | --- | --- |
| Python primary LSP | PASS，最後6檔clean；此前一次等待逾時後重查完成 | 本次核心變更／測試／checker的靜態診斷；非全專案證明 |
| 固定Python suite | **64 PASS** | snapshot、既有analysis、Host capture、Python SQL tracing、16項新契約測試 |
| Pi SDK／extension tests | **5 PASS** | SDK 0.85.1實際載入skill及prompt listing、read-only接線、digest漂移／symlink拒絕、預設停用 |
| pi-web TypeScript | PASS | `tsc --noEmit --incremental false --pretty false`；沒有執行`next build`或啟動新server |
| 真repo CLI smoke | PASS，結果不完整如實保留 | 對實際SalesDatamart ETL檔案靜態分析；71 nodes／31 edges／483 findings |
| pi-lens session diagnostics | 10個已診斷檔案無issues | edited-file cache；不是全repo掃描 |
| 原MCP映像預檢 | **歷史 BLOCKED** | 舊映像沒有`sqlglot`；未執行候選，原失敗保留於第4節 |
| 新專用測試映像 | **PASS** | 核准後建置；相同64項測試、10項runtime profile檢查及缺來源掛載負例通過，見第7節 |
| 真pi-web/model、DataHub讀回、獨立審查及啟用 | **NOT RUN** | 沒有使用mock或本地測試代替 |

新契約檢查包含：closed manifest／版本、未知registry ID不import、設定與manifest不可污染收據、跨scope身分分離、來源版本與穩定ID分離、typed edge／port fields、逐檔coverage、hash／行號／RFC6901 pointer拒絕、非有限JSON拒絕、legacy analysis完整保留；OpenAPI request／response、方法／route身分、local refs、remote／cycle／array／方向性schema／global security／非法response／未知文件等負例。

OpenAPI能力只涵蓋3.0 JSON declarations的operation與有限object／scalar ports；不是完整OpenAPI validator，也不是運行中API或欄位value lineage驗證。此契約測試輪尚未驗真OpenAPI來源；後續功能輪已另驗官方Analytics規格，live endpoint讀取仍為401／未驗。

### 可重跑命令（只限已審閱第一方開發checkout）

```sh
# output必須使用新檔名；以下命令不構成未審查候選的sandbox。
PYTHONDONTWRITEBYTECODE=1 .venv/bin/python scripts/check-discovery-plugin-contract.py \
  --output .local/discovery-plugin-contract/conformance-NEW.json

cd extensions/datahub-agent/pi-web
node --test lib/discovery-plugin-dev-extension.test.mjs
./node_modules/.bin/tsc --noEmit --incremental false --pretty false
```

本地工具鏈：Python 3.11.15、jsonschema 4.26.0、acryl-datahub 1.7.0.9、sqlglot 30.12.0、Node 24.18.0、Pi SDK 0.85.1。未安裝依賴。

最終Python收據：`.local/discovery-plugin-contract/conformance-r2.json`

- framework/input/tests source digest：`d04a9de5c27117507d0bb2e01947153e30024b2111ac3f1e7c8a32046406bdc0`
- contract digest：`7c1dceda18b08655955a9ae3a5dd6e3aa80b0fab1ea3813f4d08377c62224402`
- suite digest：`9f091306a858e830eff4930aaed52f2129f1680384e75bbc60021fee6a751060`
- 執行exit 0，source-before／after相同；`isolationVerified=false`、`modelAdherenceVerified=false`、`datahubReadbackVerified=false`、`activationAuthorized=false`。

收據也記錄實際命令、套件版本、測試輸出及逐檔hash。它是本地開發證據，不是Host簽署的正式AcceptanceReceipt或完整工具鏈映像digest。

其他本地原始證據：`skill-r2.log`、`typecheck-r1.log`、`real-source-r2.json`，均在同一`.local`目錄，不提交來源分析內容。

真repo smoke使用絕對root、source ID `discovery-contract-real-repo`及`extensions/sales-datamart/src/sales_datamart/etl.py`。resultDigest為`0f65641ecc47f2c4e71ea36a71f16c8d1118e9894404df052af94af364526482`，snapshot SHA為`22bebaad07fc643caa5631939062009e68b7e8a36eb8311f7468b30538486552`；`coverageComplete=false`、`runtimeVerified=false`、`publicationAuthorized=false`。483 findings主要代表需專用binder的legacy證據；不能把這個coarse graph當成完整ETL lineage或資料庫執行成功。

## 3. 保留的失敗與修正

- `conformance-r1.json`：61項中60成功、1 error。帶入ETL既有修改把`_VIEW_COUNT_SQL`改為`_VIEW_METRICS_SQL`並增加`_UNKNOWN_MEMBERS_SQL`，原SQL tracing測試仍引用舊名稱而KeyError。只更新該測試的target名稱並補新statement檢查；沒有回退／修改ETL，也沒有刪除失敗測試。最終64項完整重跑通過。
- 靜態檢視另修正JSON Pointer不可接受Python負索引／leading-zero、OpenAPI malformed／方向性schema不能静默視為完整、nonfinite config不可送進plugin；相應可重跑負例保留在新suite。
- `real-source-r1.json`：CLI使用相對root被既有capture拒絕（`invalid_root`）；修正為絕對root後，以新證據檔r2執行，未放寬capture驗證。
- 不覆寫失敗收據，不用新的PASS重標舊執行。

## 4. 隔離預檢阻礙與未完成工作

隔離環境預檢使用已存在的第一方MCP image ID：
`sha256:676ffc26f91b811da11ad20d0a4ad09cebc7ac7c7ff72a115f0f04eb6639f4cb`

使用`--pull=never`、network none、read-only、non-root、cap-drop、no-new-privileges及資源限制，沒有掛載候選、Host目錄、HOME、socket或credentials。唯一執行內容為Python套件版本預檢，結果：

```text
importlib.metadata.PackageNotFoundError: No package metadata was found for sqlglot
exit 1
```

預檢container `16243a96faec5bcd6953a0f421c360d147d745eacc282138d1346d55c853f9af`已透過Docker事件確認die(exit 1)及destroy。既有`ekop-datahub-datahub-mcp-1`保持running，沒有修改或重啟。紀錄：`isolation-preflight-r1.json`。沒有盲目重試、下載依賴或換成Host執行候選。

**原環境決策已獲核准並完成：**使用者同意建立固定依賴、僅供隔離測試的新映像，第7節記錄實際建置與測試。這不授權部署或啟用插件。之後仍須實作受保護candidate workspace／runner與可信Host判定接線；不能把補齊映像說成整套驗收完成。

尚未完成：
1. 未審查候選的可信admission、不可由writer更改的固定判定、Host串流output上限及timeout／取消證據；目前只實測已審閱第一方framework的隔離profile。
2. pi-web開發workspace寫入限制、Host固定驗證工具與真session的工具權限；目前沒有這些能力。
3. 原生skill命令展開、真模型遵循流程及中斷續跑。
4. 新資產DataHub官方模型適配／ACL／原生讀回。後續功能輪已完成新IR與正常工具／Host入口／MessageView接線，但仍不是live API／模型或原生發布讀回。
5. 獨立審查與使用者精確版本啟用批准。

## 5. pi-web接線現況

`datahub-extension-entry.ts`呼叫新的developer extension；只有operator同时提供以下配置才註冊：

- `DATAHUB_DISCOVERY_PLUGIN_CONTRACT_ROOT`：受信任、唯讀的Contract v1目錄。
- `DATAHUB_DISCOVERY_PLUGIN_CONTRACT_DIGEST`：精確契約digest（同Python `contract_digest()`）。

缺一、不可讀或digest不符即拒絕；未配置兩項時完全不註冊skill／tool。此輪沒有修改runtime env、映像、掛載或運行中服務。

新增`discovery_plugin_contract`無路徑／command參數，只讀固定三個契約檔，限制內容大小、拒絕檔案symlink、每次重驗digest。回傳`REFERENCE_ONLY`、`candidateExecutionAvailable:false`、`activationAuthorized:false`。不是候選validator，更不是安全執行或批准API。

Skill透過既有`resources_discover`提供，方法與權限分開；不啟動新agent controller。Chat-only現有不載extension／skill的行為不變。

## 6. 前一輪簡短回顧

有用的結果是先把source-bound資料契約與現有分析器接起來，並用OpenAPI端口區分驗證擴充形狀，而沒有改Core或先替換仍有專用語意的publisher。實測也揭露了兩項不能靠skill文字掩蓋的限制：既有container缺工具鏈，現有runtime沒有受保護的插件開發／驗證入口。當時建議補這個執行邊界，而非把本地PASS包裝成插件已可安全自動開發及發布。使用者隨後更正優先序：先驗證／接通功能主線，再處理候選開發驗收；最新結果及順序以本文件開頭的功能驗證連結為準。

## 7. 核准後：專用測試映像與隔離驗證

使用者同意「建立固定依賴、僅供隔離測試的映像，不修改現行部署」後，已完成此項範圍。

### 建置與版本鎖

- 位置：`extensions/dataflow-discovery/testing/`，含Dockerfile、最小build-context allowlist、hash-locked requirements、image entrypoint、image lock及重跑說明。
- Local tag：`ekop-datahub-discovery-test:contract-v1-20260926`。
- **实际image ID／local repo digest：`sha256:98b0694e67703054fdf99179f570a98f19fb4142081719d46316d29718fbe2fa`**，只在本機，沒有push。
- Python base固定registry digest；實際Python **3.11.16**，與本機3.11.15分開記錄，不冒稱相同binary。
- Debian與security repositories使用有簽章的`20260925T000000Z`快照，Git **1:2.47.3-0+deb13u1**。完整118項OS版本在`testing/image.lock.json`。
- 重用`deploy/cli.lock.txt`的全部**73個版本**（原檔SHA256 `e56c0ae09b9e255b86a0c6090eeadfd4e7c6b1cc9c85bba08f23d71925a461e8`）；PyPI版本metadata提供85個相容wheel hashes。`--require-hashes --no-deps --only-binary=:all:`安裝，`pip check`通過，實際版本全部讀回相符。
- requirements lock SHA256：`8fe87e0ec0e4ad990c3eeb5affe2f9db74a2a163f87cc55e9217e3f27522f41a`。
- Build使用空Docker client config及本機daemon，沒有registry credential／secret mount。允許下載固定public依賴，但context只納入Dockerfile、requirements、entrypoint及`.dockerignore`，不包含被分析source、HOME、部署設定或`.local`。
- 原MCP映像進一步預檢顯示其SDK其實為1.3.1.10、jsonschema 4.24.0且無Git；因此沒有在舊service image上疊加更新或更改其tag。

### 實際測試與Host讀回

- 正例container：`23bbee5af0460ed7df6a41dc4eb39fd2777eb831ca0d0b8f7b4747d3c658bc7e`。
- 限定42個已審閱第一方檔案的雜湊快照，單一read-only bind mount；不掛整個checkout／HOME／credentials／Docker socket。
- network none、UID/GID 10001、read-only root、cap-drop ALL、no-new-privileges、1 CPU、512MiB memory+swap ceiling、PID 64、IPC none、64MiB tmpfs、bounded local logs。
- Host在啟動前及退出後核對實際Docker設定、mount、image與限制。容器內10個Linux profile檢查全部通過，包含只有loopback與TEST-NET egress回ENETUNREACH。
- **相同64項測試全部PASS**，exit 0、無OOM、PID歸零。來源與stage前後hash一致，仍綁第2節的source／contract／suite digest，沒有改測試來適配容器。
- 缺來源掛載負例：`image-negative-r1`正常回`runtime_profile_rejected`／exit 2，沒有執行suite；其餘隔離條件保留。
- 從停止的正例容器讀回image內`run_checks.py`及`requirements.lock`，與本次build inputs hashes一致。
- 測試容器均已移除，保留映像與證據，未執行volume/image prune。

原始證據在`.local/discovery-plugin-contract/`：

- `image-r1/build.log`、`image-inspect.json`、`input-manifest.json`、Python wheel metadata／selected hashes。
- `image-r2/container-created.json`、`container-exited.json`、`runtime-receipt.json`、`host-verification.json`及image內檔案讀回。
- runtime receipt SHA256：`16fa060625ebd83d9f744c278ce987a855e2a89c8552d57478319ca9104fe1b0`。
- `image-negative-r1/`保留缺來源掛載負例。

### 保留的啟動參數錯誤

r1第一次`docker start`被拒絕：`compression cannot be enabled when max file count is 1`。實際state為created、PID 0、StartedAt為零、沒有啟動任何程序或執行測試。已保存stderr／Docker state並移除該created container；只補`--log-opt compress=false`，以新r2 container、同一image／source／安全與資源profile驗證。這是已證明未執行的指令參數更正，不是未知runtime效果重播，也沒有改用Host模式。

### 範圍結論

**此輪核准的固定測試映像及第一方隔離測試已完成。** 沒有安裝Host套件、改現行Compose／runtime env、啟用插件或發布metadata。pi-web skill仍只回`candidateExecutionAvailable:false`；完整候選admission、保護workspace、真模型／DataHub與獨立審查仍是第4節的未完成項目。

本輪回顧：補齊的不是單一SQLGlot，而是可核對的獨立工具鏈；原MCP映像的SDK版本差異證明不能僅因容器存在就當成相容測試環境。相同來源與suite在新隔離profile通過，才是這一輪的完成證據。

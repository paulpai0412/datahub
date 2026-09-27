# DataFlow Discovery — 功能主流程驗證

日期：2026-09-26。Task：TODO-9b105e9b。Branch：`feat/discovery-plugin-contract`。

2026-09-27 最新：已完成兩個真 Agent／fresh Catalog ETL 分析主流程與重載（37/37、8/8 欄位；4/3 Jobs）。當次 Catalog 的七個 BI panel 投影不一致仍明確阻擋原生綁定；詳見 [ETL 真實分析驗收](dataflow-discovery-etl-live.md)。下列保存資料回歸證據維持其歷史範圍。

**使用者最新優先序：先驗證 Discovery 功能流程，不先測安全權限或建立受控開發框架。**
既有安全條件保留；本輪沒有新增workspace／admission／權限產品程式。

## 接線前診斷結論（歷史）

第1–6節保留接線前的診斷與證據；**本輪已實作的接線與驗證見第7節**，不要把下列歷史缺口當成目前仍未實作。

- 既有Python／SQL工作流程，使用當前真實ETL原始碼及保存的真Catalog觀測，可經實際Python bridge產生完整的**選定入口靜態欄位分類**及流程預覽。
- 原ETL為4個邏輯Job、37/37輸出欄位；summary為3個Job、8/8輸出欄位。兩份原始回應均被現有React預覽guard接受，server render成功。
- 新OpenAPI插件可解析官方DataHub Analytics規格，產生1個API asset、1個request port、1個response port；未捏造value lineage。
- **新插件尚未接到既有`datahub_etl`／Discovery使用者入口和預覽。** 這是功能接線缺口，不是再缺一輪安全測試。不能把CLI成功或64項契約測試當成插件式Discovery E2E成功。
- 本輪不是fresh Catalog、真瀏覽器／模型、發布或原生DataHub讀回驗收。

## 1. 實際輸入與方法

### ETL來源

選用新worktree內既有`extensions/sales-datamart/`，由原`capture_workspace`自動捕捉17個檔案；沒有生成測試ETL、修改來源或執行其程式／SQL。

- Snapshot：`52f3802ee776607b2a62b36f05d41f187b0cb28531748335738a48127a849903`
- 原入口：`src/sales_datamart/etl.py::run_etl`
- 第二入口：`src/sales_datamart/summary.py::main`
- Namespace選擇沿用既有operator紀錄：原入口source→AdventureWorks2019、target→SalesDatamart；summary engine→SalesDatamart。只選連線scope，不提供逐SQL或欄位答案。

Catalog來自原主worktree保存的`composer-original-related-catalog.json`，包含14個Dataset及7個相關原生BI觀測。Workspace／scope定義取自`composer-workspace-policy-applied.json`，只把root改成隔離容器內的捕捉快照。

**這是歷史native觀測的離線重現，不是假Catalog，也不是新的授權／現行policy證明或fresh read。** 原始檔案路徑及SHA在本輪`input-manifest.json`；沒有讀取登入憑證。

### 執行接縫

```text
實際來源目錄
  → capture_workspace
  → bridge.py workspace_analyze（入口／連線描述）
  → 以回傳的connection IDs選既有scope
  → bridge.py workspace_analyze（真Catalog觀測、欄位／Job／view／BI binders）
  → datahub-etl.preview/3
  → 現有 isEtlPreview guard／DataHubEtlPreview server render
```

分析在已驗證映像`sha256:98b0694e67703054fdf99179f570a98f19fb4142081719d46316d29718fbe2fa`內執行。沿用network none、non-root、唯讀root／單一來源掛載、cap-drop／no-new-privileges與既有資源限制；沒有再建安全框架。

使用實際bridge stdin／stdout及既有128KiB輸入、58,000-byte預覽上限；未放寬上限或截斷結果。Renderer檢查則在既有Node工具鏈讀取真正的bridge回應；沒有補造Host requestId、Actor或認證回應。

## 2. 功能結果

| 項目 | 原ETL | Summary |
| --- | ---: | ---: |
| SQL contexts | 26 | 9 |
| Write slots | 56 | 8 |
| 邏輯Jobs | 4 | 3 |
| 預期輸出欄位 | 37 | 8 |
| 完成分類欄位 | 37 | 8 |
| 未解輸出欄位 | 0 | 0 |
| Bridge回應bytes | 54,506 | 22,367 |
| Source coverage | selected entrypoint完整 | selected entrypoint完整 |
| React guard／server render | PASS | PASS |

兩例都辨識到1個view／24個view輸出欄位、9個BI查詢／18個查詢輸出，以及7個原生panel綁定。這不代表live Grafana查詢或DDL已執行。

原ETL步驟為`extract`、`_load_dimensions`、`_load_facts`、`_validate_target`；summary為`_totals`、`refresh_summary`、`validate_summary`。沒有將所有helper各造一個Job。

### 原始缺口沒有消失

當前snapshot的50項scanner缺口均保留，依選定入口對帳：

- 原ETL：9個`BOUND_SELECTED_WRITE`、41個`OUTSIDE_SELECTED_PYTHON_ENTRYPOINT`。
- Summary：2個`BOUND_SELECTED_WRITE`、48個`OUTSIDE_SELECTED_PYTHON_ENTRYPOINT`。

`fieldPartitionComplete=true`及source coverage完整，只限定選定Python入口的SQL I/O與靜態宣告。不能將這個分母當作整個repo、provisioning或執行期全部已支援。

兩個預覽仍正確保留`complete=false`、`publicationAuthorized=false`，以及本次重播policy未帶原生identity／adoption所造成的`workspace_identity_policy_required`與`dataflow_job_publication_plan_not_compiled`。沒有把歷史policy當成新的發布批准。

## 3. 獨立來源語意核對

先完成分析，再依真實原碼核對輸出；預期不餵回compiler作為mapping。7項核對通過：

1. `LineNetAmount`值來源精確為OrderQty、UnitPrice、UnitPriceDiscount三欄，符合`_FACT_SQL → _parse_facts → _line_net_amount`。
2. `Status`保留為篩選條件，不混成LineNetAmount的值來源。
3. `dim_date.DateKey`是scope日期範圍的宣告型生成，沒有捏造SalesOrderHeader.OrderDate來源。
4. Fact.ProductKey的值來自dim_product.ProductKey，而非把原始ProductID當成已解析的代理鍵。
5. 原始ProductID保留為lookup比對條件。
6. Summary七個有欄位來源的輸出，逐項對應真`_GROUP_SQL`中的日期／類別／distinct order／quantity／net／source-total來源。
7. `COUNT_BIG(*)`為列集合生成，不為LineCount捏造一條欄位來源。

這些核對證明所列靜態來源角色，不證明Decimal rounding、執行期輸入、lookup唯一性或SQL計算數值已正確；`runtimeValuesVerified`保持false。

## 4. 新OpenAPI插件的真實規格測試

本輪先嘗試無憑證唯讀取得本機GMS `/openapi/v3/api-docs`，得到**401**。未讀憑證、改權限或改走另一個live endpoint；此項即時規格讀取保持未驗。

另一項獨立的原始碼規格測試使用乾淨官方Core checkout中的：

`metadata-service/openapi-analytics-servlet/src/main/resources/open-api.yaml`

不是upstream tests／fixture／golden。因目前插件只收JSON，驗證器以固定PyYAML `safe_load`轉成JSON，沒有加入語意／schema／答案；原始YAML及正規化JSON的SHA均保留。這項成功不消除前述401，也不宣稱API已部署或可呼叫。

結果：

- `POST /datahub_usage_events/_search`正確成為API asset。
- request與200 response各有獨立application/json port，方向為input／output。
- 兩者宣告型別皆為string，與官方規格逐項一致；沒有從example猜成object schema。
- 沒有request→response value edge，`runtimeVerified=false`、`publicationAuthorized=false`。
- 在這份規格與插件限定能力內，`coverageComplete=true`。

## 5. 已定位的功能接線缺口

目前是兩條分開的路：

```text
既有 datahub_etl → native analyzeWorkspace → bridge/workspace
  → capture_workspace_and_analyze → analyze_snapshot → 專用binders → preview/3

新 CLI plugin-analyze → builtin_registry → OpenAPI/legacy plugin
  → dataflow-discovery.plugin-result/1 → 尚無使用者入口／對應預覽
```

原碼依據：`host.py::capture_workspace_and_analyze`直接呼叫`analyze_snapshot`；`workspace.py::analyze_workspace`直接串既有Python／MSSQL／view／BI binders；`datahub-etl-extension.ts`的工具契約沒有plugin選擇；新registry只在CLI接入。

實際將新插件原始結果交給現有`isEtlPreview`，回傳false，因其不是`datahub-etl.preview/3`。**不能把這個guard刪掉或放寬為任意JSON來冒充接通。** 需要在入口與預覽的責任層補正式、可驗證的插件結果接線。

此外，`legacy-static`只保留原始analysis並投影coarse IR；它尚未承載這次workspace證明的完整Catalog／lookup／欄位／Job結果。新流程不可用coarse graph替換現有37／8欄位解析，造成能力退步。

**下一個功能Task：以固定第一方插件接通統一Discovery入口與對應結果預覽，保留現有Python完整分析，再讓實際OpenAPI規格通過同一使用者流程。** 之後才補AI自行開發候選所需的protected workspace／admission服務及完整安全驗證。既有授權及隔離條件不因此取消。

## 6. 證據與尚未驗證

Private artifacts：新worktree `.local/discovery-plugin-contract/functional-r1/`。

- `input-manifest.json`：捕捉來源、實際Catalog／policy／官方規格的provenance與SHA。
- `check.py`／`run-report.json`：隔離的實際Python bridge與OpenAPI CLI功能重現。
- `check-semantics.py`／`semantic-check.json`：上述獨立來源核對。
- `render.mjs`／`renderer-check.json`及兩份HTML：原始回應通過既有React guard與server render。
- `openapi-read.json`：即時規格401。
- `container-state.json`／`host-readback.json`：exit 0、無OOM、PID歸零、來源／stage未漂移、兩份原始candidateDigest重算一致；容器已移除。
- Raw functional report SHA256：`790b1b352e9148e02b77ef48385ab53e117c996a8eb052fd54013eae69383eb6`。

**未驗證／未完成：**新插件的真工具／模型／瀏覽器入口、互動圖卡、fresh Catalog、API的DataHub原生映射與讀回、發布及重開session。HTML只是server render，不是瀏覽器驗收；這份報告亦不是獨立review或正式AcceptanceReceipt。

本輪沒有修改產品解析器、Core、部署、scope權限或憑證，沒有執行ETL、SQL、業務API或metadata寫入。

回顧：功能測試把「舊分析主線可用」與「新插件尚未接入使用者流程」分清楚。下一步應修這個可定位的入口／呈現缺口，而不是繼續累加安全測試或把元件PASS擴大成全流程PASS。

## 7. 已實作：插件 → 原 Discovery 入口 → 聊天預覽

使用者核准依上述功能優先序實作後，已在同一branch/worktree完成，**未部署、啟用新runtime或發布metadata**。

### 正常入口與相容路徑

沿用`datahub_etl`工具、`DataHubHostBridge`、MFE Discovery channel、既有Gateway和`nativeDiscovery`，不新增服務、controller、datastore或權限框架。

1. `list_workspaces`取得原有授權來源。
2. 新增`list_plugins`，由固定Python registry回傳manifest、configSchema及previewFormat，不從模型提供的id載入程式。
3. 同一`analyze_workspace`新增可選`pluginId`及`pluginConfig`。
   - 省略id或選`legacy-static`：由`plugin_workspace.py`相容adapter呼叫原workspace／Catalog／lookup／欄位／Job binders，回原`datahub-etl.preview/3`。沒有用coarse IR替代完整結果。
   - 其他已註冊插件：原Host capture → registry及原Contract v1 validator → `dataflow-discovery.plugin-preview/1`；保留manifest、完整plugin result、coverage、findings及版本digests。
4. 原`MessageView`依不同版本契約選既有ETL預覽或新`DataHubPluginPreview`；不是放寬`isEtlPreview`來吞任意JSON。
5. 新預覽呈現資產／程序選擇、方向明確的ports／fields、分類關係、檔案及JSON Pointer證據、缺口與版本。`calls`／`contains`／條件／值依賴分開；沒有捏造API request→response值流。

`openapi-operations`的非秘密config仍需明確`serviceId`；只收OpenAPI 3.0 JSON。來源scope、捕捉限制、既有58KB／60KB傳輸上限、active grant檢查不變。新插件預覽不進舊Python匯入／發布流程；unknown id、錯誤config及oversize不fallback、不截斷成成功。

### 本輪驗證

| 層級 | 結果 | 精確範圍 |
| --- | --- | --- |
| 真來源Host／Python整合 | PASS，10項檢查 | 同一固定Python測試映像＋唯讀掛載既有Node 24.18.0 binary；實際Node `nativeDiscovery`／`analyzeWorkspace`呼叫固定Python bridge及registry |
| 原ETL／Summary相容 | PASS | **整份預覽JSON**與第2節接線前結果deep-equal；預設及明選legacy兩路都相等，仍37／8欄位、4／3 Jobs |
| 真官方規格 | PASS | 新Host入口回API asset＋input/output string ports，原始result未由測試重造 |
| 隔離Python回歸 | **76 PASS** | 原64＋7項新adapter檢查＋5項既有workspace adoption檢查 |
| Node Host／工具／MFE回歸 | **33 PASS** | 包含6項新RPC／list_plugins／插件參數／MFE轉送單元檢查；其RPC framing是測試context，不是假稱真模型 |
| Chromium 153瀏覽器 | PASS | 讀實際Host回應，在**原MessageView**顯示新插件卡片及原ETL／Summary卡片；390／1280寬度、ports、證據展開、鍵盤焦點及新卡片無頁面溢位；6項display guard檢查 |
| pi-web TypeScript | PASS | `tsc --noEmit --incremental false --pretty false`；未執行Next build或啟動新server |
| 共用pi-web測試 | **34/35** | 唯一失敗是既有Grafana launcher測試，見下述基線核對；未改Grafana或移除測試 |
| 獨立審查 | **使用者同意暫緩** | 使用者選擇「先交付實作與測試，獨立審查暫緩」；不視為審查通過或啟用批准 |

Host replay的actor／active檢查是明示的隔離測試context，Catalog仍為第1節的真歷史觀測；沒有取得登入憑證或呼叫live Catalog。Browser載入真正的Host輸出，但不是Pi模型生成tool call、原生RPC session、MFE/Gateway認證或fresh DataHub E2E；這些界線保持未驗。

### 保留的失敗及診斷

- Host r1：ports實際按stable node ID排序，測試卻假設request一定排在response前。保持產品不變，改為按name核對**完整兩個ports、方向及fields**；r2通過。未鬆綁欄位預期。
- Python r2：75/76通過；既有58KB transport測試的mock只提供舊函式名，bridge改接adapter後mock過期。只改mock方法名，57,000允許／58,001拒絕的原預期不動；r3全76通過。
- 瀏覽器r1逾時；同協定診斷r2捕捉到`process is not defined`。實際bundle定位到既有`lib/theme.ts`的`NEXT_PUBLIC_DATAHUB_EMBED`，不是新預覽bug。獨立esbuild測試補與`Dockerfile.pi-web`一致的公開presentation define，沒有改產品、加入process shim或改用webpack；r3通過。兩次失敗browser皆已關閉。
- 初次TypeScript檢查抓到新JSX兩個缺少的閉括號；已修正，最終primary LSP／tsc通過。
- 準備期曾引用不存在的`tests/__init__.py`、另一次Docker create誤抄image digest。皆未執行測試／下載映像；保留錯誤後只修正參數，使用已成功Host receipt中的精確image ID執行真正suite，不用預檢成功冒充測試。
- 共用pi-web suite的Grafana測試期待舊synthetic receipt能顯示「開啟儀表板」，但目前原有Grafana card拒絕該receipt。用**本輪改動前的MessageView原碼**、同一test input及其餘未改的依賴重現相同缺少launcher結果。`grafana-baseline-proof.json`保留證據；這是帶入的既有不一致，本輪不修改Grafana授權／介面或改它的預期。

### 可重跑檢查與交付

- `tests/test_discovery_plugin_workspace.py`：adapter單元回歸。
- `tests/test_agent_discovery_plugin_tool.mjs`：native extension RPC framing及既有MFE channel；不宣稱live驗收證據。
- `tests/check_discovery_plugin_flow.mjs <captured-input-directory>`：需既有真Catalog、policy、官方規格及接線前baseline；在無憑證隔離stage執行，沒有自建假Catalog。
- `tests/check_discovery_plugin_preview.mjs <host-report.json> <new-evidence-directory>`：既有esbuild／Playwright，讀Host真回應，封鎖browser網路，經原MessageView驗證。不執行Next build。

新私有證據位於`.local/discovery-plugin-contract/flow-integration-r{1,2,3}/`。Host成功為r2 `host-report.json`，SHA256 `ba595059687c42a76d7b03a7a2135b6b4653bca5d6191100e1ca54ee91dc0c87`；browser為r2 `browser-r3/report.json`及截圖；Python／Node／TypeScript及Grafana基線核對在r3。r1／r2各失敗不改標為PASS。

本輪完成線是**本地功能接線及其上述實測**。整體插件開發Task仍open：真模型開發候選、protected workspace／admission、fresh DataHub相容性／讀回、獨立審查及批准部署／啟用不在本輪冒稱完成。

回顧：這次修在缺少的入口／結果呈現層，而不是替換成熟欄位分析或先建安全平台；整份預覽等價驗證比只核對37／8數量更能防止功能退步。執行工具、儲存觀測與瀏覽器重播皆分別標示，沒有將它們相加宣稱live E2E。

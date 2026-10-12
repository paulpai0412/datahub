# Catalog 語義治理：SalesDatamart 現場驗證（2026-09-29）

## 結論

**主線已部署並完成修復後的真 E2E：`LIVE_MAINLINE_VERIFIED_WITH_RETAINED_UNKNOWN`。**

從真 DataHub Agent 入口，經既有真模型、精確提案、可信父層人工確認、官方 API CAS 發布，再核對原生值、Catalog 畫面與歷史。不是 fixture／HTTP 200 或單一欄位成功替代驗收，也不是全程零失敗。

- 34 筆審核：**27 筆初始發布讀回成功、1 筆歷史 UNKNOWN、1 筆 Reject、5 筆過期且未嘗試**。
- 28 個一次性 publication attempts；79 個明列 Aspect 觀測。最終 **40 個最新已核准 Aspect** 與原生值逐一相符。
- 六類資產、七個共用定義、一個真欄位；來源屬性／來源 schema 未變，Reject 標記未發布，原 UNKNOWN 紀錄未變。
- **多人私密隔離仍依使用者決定延後**。Task／Run 沿既有原生 ACL，不是私人聊天。

設計：[Catalog 語義治理主線](../design/datahub-semantic-catalog-mainline.md)。[本地報告](datahub-semantic-catalog-mainline-local-20260928.md)保留較早階段，不代表目前仍未部署。

## 入口、範圍及授權

入口：`http://localhost:9002/mfe/agent`。選擇 **Semantic governance／語義治理** 工具組，模型僅有 `datahub_catalog`、`datahub_semantic`；批准／發布只在可信父層審核 UI。使用既有 `openai-codex/gpt-5.6-sol`、medium，沒有改用 CLI／另一個 provider 冒充入口。

使用者已明確允許本案必要部署與限定 metadata 驗收，由主代理核對精確差異後代為操作父層人審；不是授權產品模型自批。

| 類型 | 本輪選取 |
| --- | --- |
| Dataset | SalesDatamart `dm.fact_sales_order_line` |
| 欄位 | 真 schema 返回的 `salesorderid` |
| Container | 盤點取得的 SalesDatamart Container |
| DataFlow | `sales_datamart` |
| DataJob | `load_sales_fact` |
| Chart | Grafana `dataflow-sales-v1.1` |
| Dashboard | Grafana `dataflow-sales-v1` |

Host 的既有 Source 名稱仍是 **AdventureWorks2019 - metadata-only (7 tables)**，僅作配置的 metadata／publication 邊界。未改名、未改 recipe、未執行 ingestion。此次為 `explicit_catalog_selection`，`ingestionMembershipVerified:false`、`completeSourceInventory:false`；不宣稱上述六項屬同一次 ingestion 的完整成員清單。

## 實際走過的行為

| 情境 | 真實結果 |
| --- | --- |
| 建立共用定義 | Domain、Parent Domain、Group、Parent Group、Term、Tag、Property 共七筆，分別提案／審核／發布／讀回。名稱使用 `Catalog E2E 20260928 …`，明示僅為流程驗收。 |
| 修改既有定義 | 五筆在**原 URN**更新名稱／說明；Domain → Parent Domain、Group → Parent Group、Term → 更新後 Group。兩個 parent 定義未改。Property 型別、cardinality、qualifiedName、entityTypes 等未遷移。 |
| 首次資產套用 | 每類五個候選：editable 說明、Domain、Tag、Term、Property。Dataset 首次 attempt 發生下述 UNKNOWN，立即停止後續寫入。修復後另外五類用新 snapshot／新 review 成功；Dataset 原 attempt 未重播。 |
| 已有值更新 | 六類各自新提案：說明 v1→v2、Property `catalog-e2e-v1`→`catalog-e2e-v2`、Domain 改為 Parent Domain、Tag／Term 以 remove 或精確 set 移除。六筆均成功。Dataset 是新的 v2 意圖，不是補送舊 attempt。 |
| 真欄位 | `salesorderid` 的 editable 說明、Tag、Term、schemaField Property 套用成功；另一次新審核將說明改為 field v2，移除這次加入的 Tag／Term／Property。其他欄位與來源 schema 保留。 |
| 其他移除 | Chart 移除本輪 Parent Domain；Dashboard 移除本輪 Property。原生讀回相符，共用定義仍保留。 |
| Reject | Container 提案追加 `[REJECT_THIS_CHANGE]`，由父層選 Reject；原生審核保存拒絕，目標說明與版本未被該提案修改。 |
| 原生 UI | 六個資產頁都顯示 v2 說明，Dataset 顯示 field v2；七個定義在原生頁／Structured Properties 管理頁可見，三條階層關係亦可在頁面文字核對。 |
| 歷史／重載 | 真入口經歷史分頁顯示全部34張審核卡；reload 後219則訊息與 SDK usage 不變、工具仍精確兩個。沒有新模型 prompt 或重發 metadata。兩個 HOME volume 的原有31份 session 檔逐一 SHA 相同。 |
| 響應式／鍵盤 | 真父層拒絕審核於1440／390px可讀，批准 disabled；原生 modal 阻止背景 iframe 取得焦點。Chromium Tab 可經瀏覽器 chrome 返回 dialog，不加自製 focus trap；不是實機手機或完整 WCAG 認證。 |

以上是列明案例的真驗證，不是每個 operation × 每種資產／型別的完整交叉矩陣。數值型 Property、各種非法型別／階層／權限／版本負例等由本地 regression 覆蓋，不冒稱都已對真 Catalog 寫入。

## 現場所揭露與修復的缺口

### 1. 工具組與 SDK 延遲註冊

最初 Semantic 工具組被舊 session selector 拒絕；補上可持久化的具名 profile。隨後真 SDK probe 顯示只限制 active tools 不足以阻擋延遲 MCP 註冊，改由 SDK `tools` registry 白名單限制，切換受限 profile 重建 runtime。保留 RED／GREEN、實際 SDK probe 與1039項 regression；未知 profile 不降為全工具。沒有安裝替代能力或擴大模型權限。

### 2. Domains v2：完整讀回不相符

首筆 Dataset approval 的官方寫入被呼叫後返回 `publication_write_unconfirmed`／`publication_readback_mismatch`：四個 Aspect 相符，Domains 被原生 v2 補上 `domainAssociations`，不再等於原編譯 payload。

- 停止寫入、唯讀對帳，原 attempt 永久消耗；**初始 UNKNOWN 不改寫成成功**。
- 相容性 Adapter 在 outgoing payload 產生合法的兩個 Domains 欄位，保留 attribution／未知欄位與原生排序；**不放寬完整 Aspect 比較**。
- 新 Domain review 封存 `domainsAspectVersion:2`。舊編碼 review 可讀但不能借舊 consent 發布新編碼；舊五筆未嘗試 review 留為 expired。
- 修復後五類資產重新提案成功，之後六類 v2 更新也成功。Native API 的現在值不被拿來追認首筆 UNKNOWN。

### 3. Catalog 連結及 editable description

原生 UI 檢查發現 DataFlow 的 `/dataFlow/…` 返回404；固定 Core 的公開路徑實為 `/pipelines/…`，DataJob 為 `/tasks/…`。修正 Host producer 與 Pi presentation validator；舊歷史 URL 保持可讀，但導航正規化至正確路徑，不接受任意 pathname。

實際 Catalog bridge 另顯示非 Dataset 五類仍只讀 source description，與已發布的 editable 值不符。修正共用官方 GraphQL overview 選取各類 `editableProperties.description`，保留無 editable 值時的 source fallback。修復後六類經真 bridge 與原生 UI 均顯示新值；沒有再寫一次 metadata 來掩蓋讀取缺口。

### 測試與操作錯誤另行保留

原失敗包含：模型14次唯讀參數錯誤後自行修正、Source 名称澄清、approval response wrapper／selector 誤判、session URL 的 cwd 優先規則、Python interpreter 選錯、history 的 `context.messages`／分頁／implicit ARIA role／原生 modal 瀏覽器焦點及 sentinel detach 的 harness 假設。均有原 log；修正的是相應 harness／請求，未放寬 publisher、重播未知寫入，亦未改正確的原生 modal 來迎合錯誤測試。

## 最終部署與回歸

- Core 維持 **v1.7.0.1**，上游 submodule 乾淨；沒有 Core patch。
- 官方 Model **0.1.10** 熱載入 `SUCCESS`／failureCount0；**沒有重啟 GMS**。ZIP SHA：`277acd98cbd8b8f974a1387826bd265086c3850853f25d893afdebab364ace80`。舊 unused private 型別不是已啟用的私密 writer。
- 最終 runtime image：`sha256:ec91ed6ebc785c18b945b5037deedd6a830c297052f85ba58af09816b245c987`。
- 577個 Pi source 的 bytes／mode 與映像相符，223個 browser assets 同源；downstream reverse 至固定506檔與3項 baseline checks通過。專用1CPU／3GiB／無額外swap、序列建置，builder 已停止；npm-ci 使用既有 cache，不宣稱全新依賴安裝。
- **最終 Host／Catalog／Semantic／Task／MFE：183/183 PASS**；**Pi：1039/1039 PASS**；TypeScript PASS。較早76個 compiler shape／官方 loader 證據屬 model 本地階段；Domains 修正另外有 regression 與真原生讀寫證據，不混稱為重跑的 codec 證據。
- 修改範圍 primary LSP 無 error。程式交付檢查的 Lens session cache 涵蓋113檔，17 warnings（含文件連結 cache）及一個 past-EOF stale 項；連結的實際檔案存在，fresh primary LSP／實際183 tests確認當前程式，不為 stale 改碼。不是全 repo／全 scanner／安全認證。
- 一般 source 的 `git diff --check` 通過；完整命令另標出 downstream patch 五個單一空白的 context lines，已核實為 unified diff 的必要格式，沒有剝除或改壞可逆 patch。
- 本輪主代理執行，沒有獨立子代理審查。Task Pi preflight 的 `loaded-runtime-changed` 與產品部署授權分開；沒有捏造 readiness 或 dispatch。

## 證據與操作後狀態

Owner-only、gitignored 證據根目錄：`.local/evidence/semantic-catalog-mainline-20260928-1zK2C8/`。

主要收據：

- `live-e2e/final-native-post-reload/receipt.json`：最新40個 Aspect、來源保全、Reject、歷史 UNKNOWN。
- `live-e2e/native-ui-final/`、`native-vocabulary-ui-final/`、`history-final-r7/`：原生頁、定義頁、真審核／歷史／reload。
- `profile-fix-r3/`、`domains-fix-r1/`、`native-routes-r1/`、`catalog-read-fix-r1/`：逐階段 source／測試／部署；早期 image／PID 不當作現在狀態。
- `sessions-preserved-final.json`、`regression-final.log`、`delivery-final/`：保全與最終交付 checkpoint。原 `checkpoint.json` 與原 hash 清單保持不動。

驗收定義、v2 說明及尚保留的關聯／值留在 Catalog，未自行清除或刪除共享定義。所有名字／說明明示流程驗收，不代表正式業務語意、資料品質或可信 Join。沒有來源 SQL、ETL、ingestion、業務資料寫入、全域 Policy 修改、其他專案操作或 commit／push；既有 brief、歷史工作與 repair worktree 保留。

簡短回顧：沿用官方 Aspect 與同一 CAS publisher 完成更新能力，但真入口仍揭露 SDK 註冊、Domains 原生補值及 Catalog 讀取／導航的整合落差。修復落在各自責任層，沒有降低讀回標準；成功狀態、歷史 UNKNOWN 與延後項目分別呈現。

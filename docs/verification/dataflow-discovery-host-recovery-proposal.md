# 既有 Host 恢復與欄位預覽：待核准方案（2026-09-19）

**狀態：PROPOSED_NOT_AUTHORIZED。沒有執行部署。A／A1／A2 均已結束，不得重播。**

## 本地檢查結論與限制

- 已沿 `server → nativeTasks → taskRecords` 檢查 caller。Server 不提供 `recompilePublication`，JSON config 也不能提供函式；Task JSON actions 沒有 preparation／claim／publish／reconcile 入口。一般 Task／Run／問答／close 仍使用舊欄位。
- `respond_publication_review` 已存在於本地程式，但須先有可信的 publication review；不是一般回答的批准途徑。本輪不呼叫任何 publication 方法，不新增 Task／Run／Decision，也不部署尚未部署的模型 `0.1.2/0.1.3`。已部署模型的歷史證據為 `0.1.1`，不是本輪重新查驗 loader。
- 固定本次 Host 的 18 個直接／遞迴本地 import 檔及 Discovery 的 23 個 Python 模組；對照歷史 T07 source snapshot，而非假稱取得當前執行中程式。Runtime manager、identity、egress、relay 等與該快照相同；Task runtime 的完整差異為格式／尾逗號，TypeScript 輸出並非位元組相等。
- 新執行 **14/14** 測試：11 個欄位 Host／isolated parser 案例，以及 3 個 Task runtime／Decision／scope 接線案例。四個相關 Host 檔的 primary LSP 無 error。既有 81 Node／141 Python 收據保留其原始範圍；一個 test 檔舊雜湊不符，已改用這次重跑，不以未證明的「格式差異」消除問題。
- 以上為主 agent 本地檢查，**不是獨立審查、live Task model 相容驗收或 Agent E2E**。沒有發現欄位預覽必須重建 runtime image／MFE／Core 的理由；實際可用仍須以下真入口驗證。

本地證據（均位於 gitignored `.local/evidence/dataflow-discovery/`）：

- `host-recovery-compatibility-20260919.json`：來源雜湊、caller 結論及比較限制。
- `host-recovery-current-seams-20260919.log`：14 PASS；只有 fixture／暫存 loopback HTTP，沒有真 DataHub／Docker／模型。
- `host-recovery-test-source-reconciliation-20260919.json`：舊測試雜湊差異與新收據。
- `host-recovery-field-policy-proposed-20260919.json`：精確 19 contexts 的待核准設定；檔案中的 `modelContextApproved:true` **目前只是提案資料，不是授權**。

## 精確目標及唯一設定差異

| 項目 | 範圍 |
| --- | --- |
| 專案／scope | `/home/timmypai/apps/datahub`／`ekop-agent-local` |
| Actor | tenant `ekop-datahub`，`urn:li:corpuser:datahub` |
| Actor key | `4d5308a2eadb8da6e430c812dc85e0a571563e339436a89c` |
| Owner label | `4d5308a2eadb8da6e430c812dc85e0a571563e339436a89c4876d3499df8e801` |
| DataHub／Host | `http://localhost:9002`／`http://localhost:9041`，Host 僅 bind `127.0.0.1` |
| 原 runtime image | `sha256:78ac783d33ae42dcfd38ad15872e4e2947c8cb150248dfd46f01bf3f4dbd6294`，不 pull／build／換版 |
| 待清理的已退出 container | `8094c258dc3abba2b28f4d92ef49e01557e8e2fb40b2e880f0e51f578b7a6a28`，必須重新證實其已退出及身分一致 |
| 必須保留的 HOME | `dha-ekop-agent-local-4d5308a2eadb8da6e430c812dc85e0a571563e339436a89c` |
| 設定檔 | `.local/agent-server.json`，只在指定 actor 的 `sales-datamart-case-v1` 加上提案內 `pythonAnalysis` |
| 來源 | 原 9 檔，snapshot `ed276f258ceed74e491d85b16d8e54da9408cc9484b44a3bbccf8e4aec1af77f` |
| Python 宣告入口 | `extensions/sales-datamart/src/sales_datamart/etl.py::run_etl`；只分析，不執行 ETL |

Policy 提案 SHA-256：`a7ec505fc6b7631e7845604ab5fe9a33504b23b06d751896ad4f7f2024006162`。

既有 MFE、browser assets、egress、Source／Task 設定、映像、隔離資源與 HOME 均保持不變。不重新導入舊 Host 模組，也不把尚未接線的 publication 能力當成本輪已啟用功能。

## 核准後的一次操作順序

1. **先確認，任何不符就停。** 本地雜湊／版本／snapshot 必須仍符合提案。新讀設定最多兩次（初讀及變更後讀回），只存受保護備份及 sanitized 摘要；不列印設定值。確認 9041 無 listener、9002 可用；重新對 exact scope／container／image／HOME 做有限 Docker inspection，包含 HOME volume 本身的 scope／owner labels，以及是否有其他 container 使用該 HOME。不得從 mount 名稱推定 volume owner。
2. 確認原 container 唯一、已退出、owner／image／mount／隔離設定一致，且 HOME 存在、labels 正確、無其他使用者後，才允許 **一次 `docker rm <上述完整 ID>`，不帶 `-f` 或 `-v`**。不收養 container、不刪 volume、不碰其他 scope。保存退出狀態；exit 255 原因仍未知，不稱為根因修復。
3. 對原設定做上述唯一變更並讀回核對其他鍵未變；保存受保護原檔供回復。以現有 `integration/server.mjs` **啟動一次** Host。由現有 manager 在已核對的原 HOME／原 image 建立並啟動一個同 actor 新 runtime，保留 UID1000、read-only、network none、1GiB memory=swap、1CPU／128 PIDs。只追蹤此次新 PID／container；不啟動開發伺服器、不重新 build。HOME 不存在或 owner 不符即停，不能建立空 HOME 充當恢復。
4. **一次憑證讀取／一次登入。** 只從 `.local/user.props` 取得 `datahub` 登入值，留於可信測試 Host 記憶體及暫存 browser session；不改權限、不顯示／保存 cookie、密碼或完整 inspect Env。由真正 `http://localhost:9002/mfe/agent` 進入。檢查新 runtime 身分／隔離、既有 session 清單與 active RPC，不自動恢復舊 prompt；若有非預期活動就停止。
5. 在一個新 Pi session 輸入 **一次 prompt**，使用 9/14 成功收據中的 `openai-codex / gpt-5.6-sol` 與既有登入（現場若不同即停，不切換）；允許原 SDK 使用其既有認證，不切換模型、不讀出或重建登入資料、不擴大 egress。僅允許原生 `dataflow_discovery`：一次 `list_sources`、三次 `analyze`（首頁一列、`decoder:_parse_facts` summary 一列，以及該 graph 的 `value:115..119` 五列）。每頁使用真 Host、真 Catalog，後頁綁首頁 digest；用 browser 驗證器拒絕超額或其他操作，不偽造成功回應。
6. Model 輸出必須與真工具結果一致：format v2、snapshot／candidate／Catalog digest、56 欄位槽、19 contexts、graph-scoped references、`INCONCLUSIVE`／`publicationAuthorized:false`。不得把 `value:119 → value:118` 宣告提升成 Decimal 正確性、ETL 成功或可發布 lineage。**一次 reload** 讀回相同回答與 session，不補送 prompt、不重做 Discovery。
7. 同一已認證 parent grant 做兩次非模型負例請求：舊 digest 分頁應拒絕；model-supplied policy／Catalog 欄位應拒絕。最多四次實際 `analyze` 會讀 Catalog（含舊 digest 負例），每次最多 16 個 native reads，合計最多 **64**；不另做一次 standalone Catalog preflight。登入／grant／heartbeat／靜態資產／Pi session 讀取另記，不混作 Catalog 驗收。

整批限 10 分鐘；模型回合最多 5 分鐘（包含工具往返，不表示只有一次 provider HTTP）。不自動重試登入、prompt、寫設定、container 建立或 startup。失敗或結果不明須保留已做操作／PID／ID 與新收據，不以新的執行繞過。

## 明確的模型資料授權範圍

核准本方案才表示允許指定 actor 的欄位預覽將以下 **metadata 與來源宣告** 送入其既有模型；不能把 A2 的 Catalog 讀權當作此授權：

- 同一 snapshot 的原 9 個檔案衍生宣告，包括 SQL 文字、相對路徑、常數及 helper／guard graph；不讀新來源檔或執行程式。
- 精確 13 個 MSSQL Dataset 的 native `datasetKey`／`status`／`schemaMetadata` 由 Host 讀取；模型只收到分析投影／欄位身分／版本綁定摘要，**不收到完整原始 Aspect envelopes、credentials 或業務資料列**。
- `AdventureWorks2019`：`production.product`、`productcategory`、`productsubcategory`；`sales.customer`、`salesorderdetail`、`salesorderheader`、`salesterritory`。
- `SalesDatamart`：`dm.dim_customer`、`dim_date`、`dim_product`、`dim_territory`、`fact_sales_order_line`；`reporting.v_sales_order_line`。完整 URN／PROD／case rules 見 policy 提案。
- 149 fields 是最近觀測，不是對將來值的保證。本輪模型檢查若首頁 Catalog digest 不再符合已驗證的歷史 baseline `e9bc4a5f166c0321828d94f8df450d2bf9c0a21377c8e1cda4b758616f33763b`，在把工具結果交給模型前停止並回報，不擅自擴充本輪測試資料。

**成功後保留 Host 與指定 actor 的欄位預覽設定可用；它會在後續使用時重新讀這 13 個 Dataset 的當時 metadata。** 若不願授權這個持續的 scope，可選只恢復原 basic 模式、不加入 `pythonAnalysis`、不送新 metadata 給模型；不能把一次測試核准隱含成無限制的模型資料授權。

## 失敗回復與非目標

- 明確失敗且此次新 PID／runtime 所有權已證實時，允許一次 native graceful close／SIGTERM（manager 會 stop／remove 本次新 container，**保留 HOME**），再恢復本次備份設定；不重新啟動第二次，不重建已刪除的舊 container。回到 gateway 停止、原 config／HOME 保留的狀態，不假稱恢復舊 PID。
- 過程若有未知 ACK／非預期 container／ownership 不明，先停止新增動作並對帳；不強殺、不強刪、不用猜測的 PID。關閉 browser 也不等於模型已停止。
- 不更動 DataHub／Grafana／MSSQL 服務、Core、模型 plugin、ACL、來源 Secret；零 SQL／ingestion／DataHub metadata writes。正常 Pi session／登入狀態寫入既有 HOME 不冒稱完全唯讀磁碟。
- 不部署 publication、不寫 Task／Run／Decision、不做 LINEAGE 或 SEMANTIC 人工批准；不接受本 Skill／`discovery-validator` 完成。完整語義、跨 actor ACL、publication、ETL 安全及最終 E2E 仍待後續工作。

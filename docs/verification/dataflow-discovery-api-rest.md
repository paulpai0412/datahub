# Discovery 原生 API REST 唯讀相容性

日期：2026-09-27。任務：TODO-9b105e9b。

**結論：目前部署有官方 `api` REST 契約、registry 與可呼叫的讀取路徑；不必因 GraphQL 缺少 `Api` 就改成 Dataset 或修改 Core。尚無正例實體／aspect 讀回，亦未驗證發布或完整 ACL。**

## 範圍與實作

使用者同意先依建議確認官方 API entity 的 REST 能力。本輪只有唯讀／本地測試：不改 Core、9141／9041 設定或服務，不發布 metadata、不執行來源／候選／模型，不擴大來源授權，也不使用子代理。

新增：

- `tests/check_discovery_api_rest.mjs`：重用已由人登入的專用 Chromium，以正常 frontend proxy 查詢官方 OpenAPI、`api` registry、限定名稱且 count=1 的 search、隨機未建立 URN 的 GET／HEAD。固定本機 origin，bounded response／timeout；不讀 cookies、auth storage、credentials 或回應中的登入位置。401／403／5xx 不換身份或重試；每輪要求全新 evidence directory。
- `tests/test_discovery_api_rest_contract.mjs`：**7/7 PASS**。涵蓋方向／method/path 契約、缺路由／缺 output、非預期 refs、空 search 不冒充資料、key-only GET 與 HEAD 不一致、拒絕／失敗／缺證據的分類。這些是明示 synthetic unit fixtures，不是 live 證據。

此為 operator 相容性檢查，不是一般使用者的新 Catalog API、發布工具或 approval registry。沒有新增部署機制或 datastore。

```sh
node --test tests/test_discovery_api_rest_contract.mjs
node tests/check_discovery_api_rest.mjs \
  <本輪既有專用瀏覽器的-CDP-control.json> <全新私有證據目錄>
```

需先有正常登入的本機 DataHub 頁面。registry endpoint 另外要求官方 `MANAGE_SYSTEM_OPERATIONS_PRIVILEGE`；本輪的成功不代表所有 Catalog 使用者都有此權限。

## 現場證據

經 `http://localhost:9002/openapi/…` 的官方 frontend proxy、目前 DataHub actor 進行；没有直接取得 GMS token。公開文件見固定上游 `docs/api/openapi/openapi-usage-guide.md`，frontend `Application.proxy` 由原生 Authenticator 驗證並處理轉送。

| 實測 | 結果 | 能證明／不能證明 |
| --- | --- | --- |
| 真 GraphQL `me` | 200，原 DataHub actor | 當次使用者身分；非跨使用者 ACL matrix |
| `GET /openapi/v3/api-docs` | 200，1,409,126 bytes | 活躍契約有 `/openapi/v2/entity/api` 與 `/{urn}`、GET／HEAD、相關原生 schemas |
| `GET /openapi/v1/registry/models/entity/specifications/api` | 200，name=api | 活躍 registry 列出 apiKey/apiProperties/apiSignature/restApiProperties 等，不只是 repo 中的 PDL |
| `GET /openapi/v2/entity/api?query=…&count=1&aspects=…` | 200，entities=[] | 限定 `"datahub_usage_events"` 的可見頁成功，未翻頁；不證明全域不存在或權限完整 |
| 未建立隨機 URN 的 GET | **200，只有 urn/apiKey** | 不能據此判為實體存在或 aspect 讀回成功 |
| 同 URN 的 HEAD | **404** | 官方 existence endpoint 確認該 URN 不存在；未建立 fixture metadata |
| 同 GET，browser `credentials:omit` | **401** | 這個未認證請求被拒；未換身份／讀取 credentials，非完整 ACL 驗收 |

OpenAPI 原始 SHA：`8eae5a5eff3ace070010342839908267be2e5848e4a5b95be0f715ac1cfb041e`。

契約明確提供：

- `ApiKey.id`：原生 API 身分欄位。
- `ApiSignature.inputFields`、`outputFields`：分開的 `SchemaField` arrays。
- `ApiSignature.schemaDefinition`：原始 signature 表達的官方欄位。
- `RestApiProperties.method`、`path`：可分別保存 HTTP method／route。

這些比官方 OpenAPI connector 的 path-only Dataset identity／first-schema 選擇更貼合目前需要；但 **尚未實作 IR→原生 aspect 映射**，也沒有宣稱 SDK serialization、write/read roundtrip 或原生 UI 可用。先前 GraphQL 的 API 缺口仍存在；REST 與 GraphQL 不混為一談。

## 發現：GET 200 不代表 entity 存在

第一輪 checker 按 OpenAPI 的 404 宣告預期未建立 URN 回 404；實際回 200，故原 `live-r1/report.json` 保留 **INCONCLUSIVE**，沒有改成 PASS。

用相同 URN 做一次 HEAD 得到 404。沿固定版本原始碼確認責任鏈：

1. `GenericEntitiesController.getEntity` 呼叫 `buildEntityList`。
2. v2 `EntityController.buildEntityVersionedAspectList` 要求 `getEnvelopedVersionedAspects(..., true)`。
3. `EntityServiceImpl.getCorrespondingAspects` 的 `alwaysIncludeKeyAspect` 分支，即使沒有儲存 aspects，也由 URN 合成 key。
4. `GenericEntitiesController.headEntity` 則使用真正的 existence 路徑。

因此 checker 改用**既有官方 HEAD 能力**，並核對 GET key-only、HEAD 及請求的同一 URN；不修改 Core、補寫假資料或把 200 視為回復成功。任何多出 aspect、URN 不符或 HEAD204 都保持不可判定。第二輪以新隨機 URN 實跑同一 public protocol，取得相同 key-only200／HEAD404；報告只標 `READ_ONLY_ROUTE_PROBES_PASS`，`entityReadbackVerified=false`、`publicationVerified=false`。

## 下一步與限制

**建議採官方 `api` entity 的 REST／Aspect 路徑，沿既有 MFE 呈現；不要為 GraphQL 缺口深度 fork，也先不轉為會遺失方法與雙向 signature 的 Dataset。**

後續已完成[離線原生映射與差異草稿](dataflow-discovery-api-mapping.md)：保存 tenant/source/service 身分、method/path、input/output 與 source evidence；用精確 YAML evidence 對應，而非從 display name 猜語意。34 項隔離回歸、真既有模型結果資料重播及精確草稿 URN 的唯讀 absent 觀測完成；沒有把 ports 偽裝成 lineage，也未發布。

正例實體讀回尚缺。建立測試 API、aspect 寫入、發布差異、權限矩陣及正式 UI 整合都需要各自的契約與批准；本輪只確認現有唯讀能力，不推定新增 metadata 的權限。原 legacy 真模型＋fresh Catalog 的來源授權仍未擴張。

Private 證據：worktree `.local/discovery-plugin-contract/parallel-test-r1/rest-compat-r1/`。包含首次契約、live-r1 原不可判定與補充 HEAD、live-r2 原始 response/hash/report、anonymous-read、單元 logs 及最終 checkpoint。未改舊啟用收據或候選版本；Core 保持乾淨。

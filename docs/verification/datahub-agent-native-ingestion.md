# T03：原生 Source／Secret／ingestion 實測

2026-09-12。主代理自查，非獨立審查。**T03 原生能力實測完成；這不是 T05 的 Agent 發起／人工確認端到端驗收。** 本輪沒有新增產品程式、datastore、worker、排程器或審批框架。

## 授權與來源恢复

原 `wferp-mssql-test` 容器為 Exited 255，自 2026-09-11 停止。第一次原生 TEST_CONNECTION 工作雖回 `SUCCESS`，但 structured report 的 `basic_connectivity.capable=false`，未判為連線成功。

使用者另明確批准只啟動既有容器 `30601aec1b4e…`。啟動後 running／healthy，沿用 image `sha256:46f719fd3457d4e7e8e5845fe00c35c20e7bae7ff1e8b9fe595f2a81029f5ba8`，沒有重建、拉映像或修改其他服務。該來源的資料位於原容器 writable layer，沒有另外配置 DB volume；本輪未搬移或刪除資料。所有既有 DataHub 容器 IDs 保持不變，Core checkout clean。

## 原生能力與結果

| 項目 | 實測結果 |
| --- | --- |
| Source／connector | 原生 `ingestionSource` 查到 MSSQL，CLI 固定 1.7.0.9、executor `default`；原 Source 未修改。 |
| Secret binding | 原生 Source 使用 `${DATAHUB_MSSQL_PASSWORD}`；Secret 管理 API 只讀取名稱／URN，未取得值。Sink 保留 `${DATAHUB_TOKEN}` 引用，兩者均未交給模型作為實際密碼／token。 |
| 連線測試 | 恢復來源後，同一 recipe 的新 TEST_CONNECTION 回 SUCCESS，且 `basic_connectivity.capable=true`，3,921ms。 |
| Ingestion | `createIngestionExecutionRequest` → 原生 Actions／CLI → SUCCESS，8,470ms。1 table＋3 views 的 schema／lineage 可從 GMS 讀回。 |
| 取消 | 觀察到 RUNNING 才送 `cancelIngestionExecutionRequest`，最後 CANCELLED，438ms。未把「取消請求受理」當成取消完成。 |
| 修改設定與重跑 | 僅修改測試 Source 的 view allowlist 為 vEmployee，建立新的 request；SUCCESS，6,447ms，這次 emitted schema 為 1 table＋1 view。 |
| 舊執行快照 | 原 run／cancelled run 仍保存舊三個 View 的 recipe；重跑保存新單一 View recipe。run_id、pipeline_name、CLI version 與 request URN 可追溯。 |
| 歷史保留 | 成功／取消／重跑的三個獨立 requests 均可查詢；縮小範圍後，前次兩個額外 View 沒有被刪除。 |
| 權限範圍 | 沿用 T02 同版本真 Reader 的 Source／Secret 管理讀取拒絕證據（HTTP 200、GraphQL errors、data=null）；本輪原生管理操作使用已登入且有權限的人類帳號。未把 MANAGE_INGESTION／MANAGE_SECRETS 授予 MCP Reader。 |
| 並发版本 | 原生 OpenAPI v3 `If-Version-Match` 兩個同版本更新競爭：一個 200、一個 412；Source Aspect version 2→3，recipe 不變。只更改測試 Source 名稱。 |

原生 executor 停止／重啟、事件重播後的工作去重、跨程序 lease／舊 worker 提交防護，本輪沒有實測，不能以成功／取消個案替代這些保證。取消亦不等於回滾已寫入的 metadata。

## 測試範圍與讀回

獨立 Source：`urn:li:dataHubIngestionSource:c3b4bb69-28e2-41a7-9692-ae057480aa4b`，名稱現為 `Agent T03 canary 20260912 CAS-A`，不設排程。

獨立 platform instance：`agent_t03_20260912`，避免覆寫原本的 AdventureWorks dataset URNs。停用 profiling、query lineage／usage、stored procedures、jobs 與 stateful ingestion；保留 View／column lineage。Connector 在允許的兩個 schema 中會先列舉候選物件，再套用 table／view allowlist；不是只向來源讀取四個物件名稱。

新 dataset URN 前綴：

```text
urn:li:dataset:(urn:li:dataPlatform:mssql,agent_t03_20260912.adventureworks2019.<schema.table>,PROD)
```

| 物件 | 欄位数 | upstream 总数 | 包含本 instance 的 Person.Person |
| --- | --- | --- | --- |
| person.person | 13 | 0 | 不適用 |
| humanresources.vemployee | 18 | 10 | 是 |
| humanresources.vemployeedepartment | 10 | 5 | 是 |
| humanresources.vemployeedepartmenthistory | 11 | 6 | 是 |

GMS 真讀回與原生 `/ingestion` UI 均確認測試 Source／資產存在。Lineage 包含未選入這次 ingestion 的來源依賴，不將其解釋成全部依賴資產均已盤點。沒有執行業務 DDL／DML，也沒有把 metadata ingestion 冒稱受控使用者 SQL／關係驗證。

## T04 最小接線的實證依據

官方 MCP 0.7.0 的七個唯讀工具沒有 Source／Secret／ingestion 操作；不能只增加 Skill 就宣稱工具已能執行。

但**原生公開能力已足夠提供持久化、版本條件與執行入口，不需要另建儲存或工作系統**：

- Source 更新可用 OpenAPI v3 的 conditional writes。`config.version` 是 CLI 版本，不是並發版本；並發版本應使用 Aspect 的 `systemMetadata.version`。
- 原生 GraphQL 的「依 Source URN 執行」會抓取当时的 Source recipe；此入口本身没有 expected source version 參數。
- 官方 Certified Executor 明確支援 `dataHubExecutionRequestInput`／`Signal` 的 MCL events。已另外真驗 **OpenAPI 建立明確 recipe snapshot 的原生 ExecutionRequestInput**：HTTP 200，原生 Actions 成功執行，7,127ms。
- 使用同一 execution URN、create-only／`If-Version-Match:-1`，重複提交相同 body 被 400 拒絕。這只證明 API 建立時不重複提交，不是 executor 在所有事件重播／crash 情境均 exactly-once。
- 前端既有 `/openapi/*` 與 `/api/v2/graphql` 可使用已登入的人類身分，無需讓 Agent runtime 直連 GMS 或持有寫入 token。

因此 T04 只需銜接 Agent 請求與可信 DataHub MFE 的確認／公開 API；沿用原生 Source、Secret、ExecutionRequest 和 Actions。身份、允許來源／操作及明確快照仍須在可信邊界驗證，不能將 runtime dialog 當成不可繞過的授權。**產品接線尚未實作／部署，不將這次開發者瀏覽器探針稱為 Agent 自主執行。**

本輪的 Source CAS 初次 harness 依生成 API 文件預期 201，但更新既有 Aspect 實際回 200；保留原始 receipt，只修驗收判斷，沒有為修 assertion 重播 mutation。

## 工作與證據

| 工作 | ExecutionRequest ID |
| --- | --- |
| 來源停止時的連線失敗 | `ead448fb-7237-420b-aca1-47d8ae6abccd` |
| 來源恢復後連線成功 | `ec9aab76-2655-439c-9de6-18eb72aca60a` |
| 首次 ingestion | `6017d43a-f0ba-4cf7-8e6e-59d6323e4c8d` |
| 取消 | `c14032cf-4415-404c-9ed2-48ba685d0d34` |
| 修改設定後重跑 | `dac36ad7-0bd9-4509-8fb1-0498f8359bb9` |
| 公開 Aspect 精確 snapshot 入口 | `30cdc584-0569-463a-a816-290286685b8c` |

本地 `.local/evidence/agent-native-ingestion/`：`source-inspection.json`、`binding-check.json`、`test-result.json`、`test-recovered-status.json`、`run-status.json`、`run-cancel-status.json`、`cancel-result.json`、`rerun-status.json`、`final-readback.json`、`native-ingestion-list.png`、`cas.json`／`cas-check.log`、`snapshot-submit.json`／`snapshot-run-status.json`、`source-state.json`。沒有記錄 plaintext secrets、cookie 或 OAuth。

`probe.mjs` 與 `status.mjs` 保存了實際公開 API 操作／有界觀察步驟；舊 receipt 存在時禁止重播 mutation。重新執行 live 寫入測試前須核對目標、權限與既有 requests，不直接刪 receipt 後重跑。可讀現存結果：

```bash
node .local/evidence/agent-native-ingestion/status.mjs snapshot-run
```

官方依據（固定 Core checkout）：`docs/actions/actions/executor.md`、`docs/advanced/mcp-mcl.md`、`docs/api/openapi/openapi-usage-guide.md` 與現場 `/openapi/v3/api-docs/openapi-v3`。原生 Source UI、GraphQL、OpenAPI 是不同證據；不混同 HTTP success、工作完成、連線可用、sink ack 與 GMS 讀回。本次 structured sink 報告曾顯示 pending requests／written=0，故另以 GMS 真讀回確認，不只靠該計數宣告落盤。

T02 短效 Reader token 已到期，未自行延長。T05 再驗真 Agent MCP 前仍需原生重新配置的授權；不重啟 Agent／Core 來假裝解決 token 到期。

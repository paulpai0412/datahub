# Discovery readiness — 2026-09-28

**已完成：原生 ingestion 的 BI 保全、既有測試修復、9041 Agent／runtime／MFE 切換與真入口分析驗證。**
這不是一般 API／DataFlow 發布、受限 Actor ACL 或來源 SQL 執行的完整驗收。
使用者指定主代理單獨執行並豁免獨立審查；豁免不等於 review PASS。
本輪未修改 Core、增加 datastore、執行來源 SQL／業務 ETL、commit 或 push。

## 1. 測試失敗的原因與修復

- SQLGlot 的 set-operation `distinct` 是 boolean，不是 predicate AST。
  `_query_conditions` 現在略過該旗標，仍遍歷 SELECT 與其實際條件。
  UNION／UNION ALL 回歸保留 value／condition origins 與未驗證語意標記。
- Python 測試改依現行契約區分 public-inline engine 宣告與 wrapper 呼叫，
  正面驗證已支援的 INSERT SELECT，保留缺欄、動態、歧義、shadowing 等負例。
- Grafana fixture 使用 SDK 公開、process-only `suppress_telemetry()`，
  不再依賴 SDK import 前後的環境變數順序；另驗證既有 telemetry 已啟用時不送 tracking。
- 四個 Pi Web source-contract 測試接受格式與實際 optional type，並驗證失敗後
  同時恢復草稿及 Catalog references；沒有為過時 regex 改寫產品 hooks。
- 重新產生 downstream patch／lock：572 個檔案可精確還原未更動的 506-file
  官方基準；先前 `unreviewed source files` 失敗保留。

| 檢查 | 結果／範圍 |
| --- | --- |
| 最終 `test_dataflow_discovery*.py` | 260 passed |
| Native Grafana regression | 7 passed，包含 Pipeline.create、CLI 巨集與 REST union |
| `test_discovery*.py` | 42 passed |
| Grafana fixture suite | 6 passed，1 既有 expected failure，保留原 connector drift 證據 |
| Pi Web `npm test` | 1,023 passed |
| Discovery／activation／Grafana publication／native task record | 113 passed |
| Pi Web `tsc --noEmit`、Next／MFE build、artifact check | passed |
| Downstream reconstruction | 3 baseline checks passed |
| 修正檔案 scoped primary Python LSP | clean；最後 native test 型別收斂後再確認 |

未變更來源的既有 receipts 重用。Lens session cache 仍報告三個 Pi Web 檔案的
271 個 module／JSX resolution diagnostics；worktree 使用現有 dependency symlinks，
實際 compiler、build 與 image source 比對通過。未宣稱 Lens／全 repo 無錯，
亦未為快取警報改寫正確產品程式。一般 source diff whitespace check 通過；
生成的 downstream patch 有八個必要的 unified-diff 空白 context marker，外層
`git diff --check` 會報 whitespace，已核對原始 bytes 並保留可逆 patch，不以裁切破壞它。

## 2. BI：修正 owning ingestion path，不只是一次性補資料

原生 Grafana Source 沒有套用現有的 file-sink adapter，故下一次原生 ingestion
會再次寫入推測欄位。新增的 `GrafanaIngestionSchemaTransformer` 使用固定 SDK
`1.7.0.9`／SQLGlot `30.12.0` 與官方 ingestion transformer 擴充點。
原 `GrafanaSchemaTransformer` 仍限定 file sink。

Native entrypoint 要求：Grafana source、精確 dashboard **title** selector、
同步 `datahub-rest`、`retry_max_times: 0`、禁用 preview／stateful ingestion、
完整且正值的 14-aspect expected-version map。先收齊並驗證 bounded batch，
再透過公開 MCP `If-Version-Match` header 輸出；不自動刷新版本、不強制覆寫。
未知 dashboard／Dataset、缺目標、既有 header 或不安全模式均拒絕。

| Panel | 修正後 schema |
| --- | --- |
| 1–3 | `value` |
| 4 | `time,sales_amount` |
| 5 | `category,sales_amount` |
| 6 | `territory,sales_amount` |
| 7 | `line_count,order_count,quantity,line_net_amount,source_line_total` |

使用者核准的七個 `schemaMetadata`、七個 Chart `inputFields` 已條件式寫入。
最後為 **14 fields、14 references**；真正投影的 `time` 保留，沒有欄位名稱黑名單。

### 原生執行與真實失敗紀錄

1. R1 `d327bd89…`：FAILURE。CLI EnvResolver 把 Grafana SQL 巨集當成環境變數。
   只在 recipe 的七個 `rawSql` 對 literal `$` 使用 `\$`，不跳脫 Secret reference。
   真 CLI loader 的 regression 證實還原原 SQL、只解析 fixture secret。
2. R2 `79537c67…`：FAILURE。顯式 REST sink 缺少 `server`。
   補上部署內 GMS server，沿用 executor 提供的認證；新增真 `Pipeline.create` regression。
3. R3 `4f3a76cc…`：SUCCESS；readback 揭露手工修復 helper 未先執行 SDK
   `post_json_transform`，錯解 REST union。修正比較基準並逐項核對；原生輸出
   恢復 Number／Time／String 與 OtherSchema，未帶回多餘欄位。錯誤比較原件保留。
4. 比對後明確重綁 CAS 為 `4`，SourceInfo 為 **version 6**；不是自動 refresh。
5. R4 `3c182ac9-ece0-4c52-aed2-ed00a4a01b8b`：**SUCCESS**。
   14 個目標皆 **version 4、isNoOp=true**，原生 provenance 指向本次執行；
   全值一致，另 **49 個觀察到的 aspect values 未變**（共觀察 63 aspects）。

Source 無排程。之後內容／版本改變須先重新比對並明確授權版本更新；這不保證
跨 aspect 原子性或任意新版 connector 相容性。

### Executor 事故與限制

掛載插件時，idle guard 發現 `datahub-documents` 活動工作，但缺乏 fail-fast 串接，
compose 仍重建 executor。此事故已揭露；停止後續寫入並完成對帳。
經使用者另准，只對該中斷工作送出一次官方 cancel，讀回原生 **CANCELLED**。
沒有手工改 status、重播、刪紀錄或更改排程；**原先可能已產生的 document metadata
效果仍未確認**。使用者知悉此限制後核准續行。後續切換採 fail-fast、精確程序及
idle 檢查；未在 Grafana verification 活動時再重建 executor。

## 3. API 四-aspect 測試：已驗與未驗分開

使用者核准的單一 test API entity 保留：

- 原先 HEAD 404；`If-Version-Match: -1` 建立四 aspects，HTTP 200；HEAD 204。
  公開 SDK 型別比較 4/4 相符，包含 input／output direction、schema、nullability。
- Stale create／update 各 412，readback 未變。
- 相同 expected version 的並發修改得到 200／412；再條件式恢復原 draft。
  最終 `apiProperties` version 3，其餘三 aspects version 1。
- Anonymous 寫入 401，readback 未變。
- 受限使用者瀏覽器實際仍是 administrator，因此在送寫入前停止。
  **Authenticated restricted-Actor ACL 由使用者明確延後**，不能以 anonymous 401 代替。

`getGrantedPrivileges` 的 GraphQL `EntityType` 不接受 API，屬介面驗證錯誤，
不是授權拒絕證據。一般 Agent API writer 仍未開啟，Host review allowlist 未放寬。
以上是 per-aspect CAS 證據，不是跨 aspect transaction 保證。

## 4. 9041 正式部署及真入口

標準 clean `npm ci` 因 `ECONNRESET` 失敗，沒有隱藏重試。
使用者另准沿用既有固定 image 的 dependencies；package manifests／locks 完全相符，
重新建置目前程式並核對全部 572 個 source files 的 hash／mode。
**這不是 clean npm-ci 成功。**

- 本階段 runtime image：`sha256:d202a29dfcce6df5c7efd04b5f68a6ab09ebce14c5e9f6b2dbcb99942cfbf04a`；後續 Full history 修復部署另見 `datahub-agent-full-history.md`。
- 9041 gateway 改由 repair worktree 的 Host 程式啟動；config 只變更
  `runtimeImageId`、`browserAssetsDirectory`。實際 runtime image 再讀回確認。
- 實際供應的 MFE `remoteEntry.js`、`835.js` hash 與新 build 相同。
- 舊 image／config／browser assets／MFE backup 保留。兩個 Actor HOME 沿用，
  原 **22＋6 個 session JSONL 全部 hash 不變**；本次只新增三個成功對話。
- 9141 gateway PID／config hash 不變；沒有把 9141 當作正式入口替身。

由人類已登入的 `http://localhost:9002/mfe/agent` 進入，實際 `/mfe/config` 指向
9041；沒有回應改寫、假 tool result 或 fixture。僅保留拒絕不符合測試範圍請求的
browser guard／prompt admission gate。正式 iframe、bootstrap 與 runtime 請求皆到 9041。

| 真模型 `openai-codex/gpt-5.6-sol` 驗證 | 結果 |
| --- | --- |
| `etl.py::run_etl` | 37/37 fields、4 Jobs、4 次成功 `datahub_etl` |
| `summary.py::main` | 8/8 fields、3 Jobs、4 次成功 `datahub_etl` |
| 兩個分析的 native BI binding | `nativePanels: 7`、`relatedCoverage.complete: true` |
| MessageView／歷史 | 45 欄逐欄、所有 Jobs 與關係證據核對；重載後 messages／usage 相同，未重送模型 |
| 語意回歸 | 7 項 PASS；snapshot 仍為 `52f3802e…` |
| Host Catalog 真模型查詢及 UI | 搜尋＋兩頁 entity，共 3 次 readonly 呼叫；24 欄名稱／型別及 UI 三頁核對、重載 PASS |

Summary 額外恢復兩個 set-operation query node 的 GROUP／JOIN conditions，
符合 boolean distinct 修復；未宣稱 predicate 或 runtime values 已驗證。
其餘歷史 graph／workflow／coverage／source evidence 保留；manifest 僅新增排除的
`__pycache__` 紀錄，不改 snapshot。全 workspace 發布仍有
`dataflow_job_publication_plan_not_compiled`／`workspace_identity_policy_required`，
本次未放寬政策或聲稱發布完成。

補充官方 MCP probe 因 `read-only` preset 下 `datahub_list_schema_fields` 未 active，
在 prompt dispatch 前被 admission gate 拒絕，之後讀回該空白 agent 已停止。
未啟用更廣工具／改政策來繞過；**這項補充 MCP probe 未完成**，不以後來成功的
Host Catalog 查詢冒充。SQL／query execution regression 限於既有離線契約測試，
本輪沒有來源 SQL 執行。Catalog UI helper 的舊 heading／每頁 20 筆假設亦保留失敗
證據；依實際「總覽」及每頁 10 筆修正 reader 後完成，未重送模型。

## 5. 證據與回復入口

私人原始證據位於 repair worktree `.local/readiness-r1/`，不提交／上傳：

- `native-bi-stable/receipt.json`：原生 NoOp／CAS／provenance／63-aspect 比對。
- `api-create/`、`api-cas/`、`interrupted-cancel/`：API 與事故原生 readback。
- `shared-deploy/`：前後 config、舊 MFE、pidfd exit、啟動、實際 assets／image、28 個舊 session 保全。
- `shared-agent/acceptance-report.json`：兩條正式分析與七項語意 assertions。
- `shared-agent/catalog-host/ui-receipt.json`：24-field Catalog 真 UI 與重載。
- `checkpoint-final.json`：本輪結案狀態、限制及證據索引。

回復須先確認該 Actor／gateway 沒有活動工作，再使用保留的舊 config、image、assets
及舊 Host entry；不要刪 HOME／session，也不要以全域 Docker 清理代替回復。
9041 部署依賴 repair worktree 的 Host 程式與私人 browser assets；即使產品程式
已交付 Git，也不可直接移除該 worktree／執行產物。回復未實際演練。本文件不授權新的停機、metadata 寫入、
CAS 更新或部署。

回顧：真正的保全證據是下一次原生 ingestion 的 NoOp readback，而不是手工修完畫面。
CLI recipe、REST union serialization 和真 MFE 入口都必須在各自邊界實測；保留失敗
及未完成的 ACL／MCP 範圍，避免把局部成功擴大為完整發布驗收。

# Semantic Steward S1 — 唯讀垂直接線與驗證

日期：2026-09-22。狀態：**S1 本機原始碼與合成接線通過；完整功能仍進行中，未部署／未發布 metadata。**

設計：[datahub-semantic-steward.md](../research/datahub-semantic-steward.md)。追蹤：TODO-309f35c7。

## 工作位置

- Branch：`feat/semantic-steward`
- Worktree：`/home/timmypai/apps/datahub-worktrees/semantic-steward`
- Base：`a25204e`（原 repo 只有 `.gitkeep` tracked）；778 個現有原始碼檔案另做隔離快照，未複製私人 `.local`、憑證、venv 或 Core working tree。
- 使用兩個 worktree-local node_modules symlink 重用既有固定依賴，沒有安裝套件／跑 install hooks。MFE build、TypeScript 與測試輸出留新 worktree。依賴目錄不是 writer 目標，`tsc --incremental false`。
- 未 commit、stage、push、merge，未修改原 `master` 功能程式。原目錄另有 8 個 DataFlow 檔案相較建立時快照變動；本輪未寫它們，也不自動同步／歸因給特定工作者。

## 已實作

1. 原生 `/skill:datahub-semantic` 及 `datahub_semantic`，由現有 first-party extension entry 註冊，沿用 slash palette，不改寫 Composer。
2. `list_sources`、`inspect_source`、`inspect_dataset`、`preview`。只有唯讀 public GraphQL query／OpenAPI GET、POST batchGet；沒有 mutation action 或任意 Aspect／URL。
3. 既有 Source policy 新增可選 `semanticModelContextApproved: true`。缺省停用；必須配合原 actor 來源政策、taskDatasets 子集、manageIngestion、目前固定 MSSQL／CLI recipe 契約與逐 Entity 讀取 ACL。未修改 live config。
4. 專用 iframe MessageChannel、MFE parent、gateway `/agent/semantic`，保留 exact origin／frame、parent grant/proof、fresh identity、取消與 safe error codes。
5. 逐 Dataset 盤點來源與人工描述、Domain、Tags／Terms、Structured Properties；精確 fieldPath、20 欄位分頁、48KB response／24KB intent 界限，超限報錯不冒充完整成功。
6. digest 綁 actor／tenant／source revision／scope／全部相關 Catalog 值與原生版本。後續頁／preview 重讀，漂移拒絕。
7. 每批 8 個有 evidenceIds 的候選；表／欄位 description、既有 Domain/Tag/Term、Dataset string/number property。詞彙參照存在性／ACL／版本、property type/cardinality/enum/immutable 等已檢查；其他約束明確拒絕。
8. 原值保留／衝突、NO_CHANGE、來源與人工欄位 associations 去重。businessMeaningVerified 永遠 false，所有候選未核准。這不是發布端三方合併驗收。
9. React 差異卡：來源／資產／觀測時間、非完整來源子集提示、before→after、protected value、證據 disclosure、未完成條件。沒有假批准按鈕。手機表格可水平捲動，不強行壓縮全部欄位。

## 驗證證據

全部 raw logs／screenshots 位於本 worktree gitignored `.local/evidence/semantic-steward/`。

| 檢查 | 結果 | 只證明的範圍 |
|---|---|---|
| Node focused suite | 46/46 PASS | 真实 HTTP gateway／adapter／fixture Catalog、Pi tool handler、bridge、React SSR、既有 ingestion/gateway/MFE 回歸 |
| Pi-web TypeScript | `tsc --noEmit --incremental false` exit 0 | 目前 TypeScript 原始碼可型別檢查；不是 Next production build |
| Scoped primary LSP | 11 個改動 production 檔無 error，最後 2 檔再確認 | 限指定檔案，不是全案安全掃描 |
| MFE Webpack | exit 0，固定 5.110.3 | 新 worktree 產物可建置；未部署 |
| Chromium 合成元件 smoke | 390／1440 PASS，runtimeErrors=[] | 真 React 差異卡、鍵盤開合、惡意 HTML 作文字、無 page overflow；不是真 Composer/model/DataHub E2E |
| 序列化／reload | tool details JSON roundtrip、合成頁 reload 內容相同 | 沒有宣稱真 Pi session／原生 Task persistence 已驗 |
| lens all | 無 blocking error；1 個既有 callback 命名 warning | `DataHubIngestionBridge.onRespond` 的 Next 71007；原介面未改，不改名假裝 Server Action |

主要 receipts：
- `integration-tests-final.log`、`typecheck-final.log`、`mfe-build.log`
- `browser-result.json`、`browser-smoke-final.log`、`preview-{390,1440}.png`、`inventory-390.png`
- `source-baseline.json`、`downstream-preexisting-drift.json`、`feature-source-state.json`、`feature.patch`、`checkpoint.json`

測試覆蓋拒絕來源／資產越界、錯 actor、缺 model-context approval、撤銷 grant、recipe／Catalog 漂移、缺 ACL、移除資產／詞彙、錯 fieldPath、捏造 evidence、任意 action/endpoint/actor、無效 property、超限與不完整 Catalog。正例涵蓋表／欄位、Terms/Tags/Domain、string/number property 及重複值 NO_CHANGE。

第一輪新增 transport 測試有三個 harness failure，原始 `integration-tests.log` 保留。HTTP 使用 Node fetch 時 Host header 不符 gateway host 契約；改用既有 gateway 測試的 `node:http` transport。另兩個為 cleanup hook 先還原 window 再卸載 listener；只修測試 cleanup 次序。修正後同一 Node protocol 的 `transport-tests-corrected.log` 3/3 與最終 suite 通過；未改 gateway 安全條件來通過測試。

## 可重跑指令

在 **新 worktree** 執行。只使用既有安裝依賴，不自動安裝或啟動現行服務。

```bash
cd /home/timmypai/apps/datahub-worktrees/semantic-steward
# gateway tests 需要本 worktree 的 MFE 產物
(cd extensions/datahub-agent/mfe && node_modules/.bin/webpack --mode production)
node --experimental-strip-types --test \
  tests/test_agent_semantic*.mjs tests/test_agent_gateway.mjs \
  tests/test_agent_native_ingestion.mjs \
  extensions/datahub-agent/mfe/mount.test.mjs \
  extensions/datahub-agent/pi-web/components/DataHubHostBridge.test.mjs
(cd extensions/datahub-agent/pi-web && node_modules/.bin/tsc --noEmit --incremental false)
node --experimental-strip-types tests/check_agent_semantic_browser.mjs
```

瀏覽器檢查只建臨時 loopback server、全新 headless context、合成 Catalog，不帶既有 browser profile，封鎖外部網路，finally 關閉 browser/server。不使用已登入的 DataHub 視窗。

## 明確缺口與下一步

- **S2 尚未完成**：來源→完整資產集合的原生證據／對帳、其他 connectors 與非 ingestion-manager 的唯讀來源契約、原生詞彙搜尋／去重、新 Domain/Glossary Node/Term/Tag/Property 定義、更多 property 類型／欄位 properties、ownership/documents。
- **S3 尚未實作**：Semantic proposal 到原生 Task／Run／Decision 的持久化、可信差異勾選／批准、定義共享影響、精確 write ACL／native CAS／PATCH、partial/unknown reconciliation、原生 UI/搜尋/metadata readback。新 `preview` 不能直接拿去發佈。
- **S4 尚未實作**：代管政策、增量 trigger／schedule、發布歷史三方比較、失效與人工衝突生命周期。
- 全部 `source_membership_not_verified`、`semantic_publication_not_implemented` 保留，沒有為了展示移除 blocker。不能把操作員 taskDatasets 子集當全來源分母。
- S1 語義候選由模型提供，Host 僅驗可核對的證據位置與定義／結構；沒有量測真模型語義品質，不用 confidence 或格式檢查當業務正确性。
- 原 downstream lock 在本功能前已有 **3 modified＋3 extra files**（既有 ETL Composer）；upstream lock hash 保持相符。本輪不重算原鎖掩蓋歷史變更，需在部署前審核現有 baseline＋本 feature delta。沒有跑一個注定 mismatch 的 lock gate後假稱通過。
- 下一個安全動作是繼續 S2/S3 原始碼實作與離線驗證。**這些程式工作不是都被部署授權阻擋**；只有實際部署／憑證使用／真 metadata 寫入需要另外確認目標與操作。

## 回顧

沿用現成 Pi UI request、Host parent grant、Source policy、原生 editable metadata，避免再造 chat／狀態庫。固定上游的 privilege enum 是 `GLOSSARY_TERM`／`STRUCTURED_PROPERTY`，不是直接 camelCase 名稱 toUpperCase；已按原碼修正並用 fixture 明確驗 enum。最大的未解接縫是來源成員證據及可信發布，而不是再增加 prompt 篇幅；下一階段應優先完成這兩處，不把更多預覽功能當成完整代管。

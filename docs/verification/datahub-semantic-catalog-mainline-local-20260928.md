# Catalog Semantic 主線：本地候選驗證（2026-09-28）

歷史階段狀態（2026-09-28 12:56 UTC）：**LOCAL CANDIDATE VERIFIED／當時未部署／當時尚未執行真 E2E**。設計見 [主線設計](../design/datahub-semantic-catalog-mainline.md)。本報告保留當時的結果與待辦，不是目前部署狀態；後續已完成的部署、修復與真 E2E 見 [2026-09-29 現場驗證報告](datahub-semantic-catalog-mainline-live-20260929.md)。

## 實作範圍

- 新 `catalog/1`／`semantic-catalog/1` 契約：Dataset（含欄位）、Container、DataFlow、DataJob、Chart、Dashboard 的精確 Catalog scope、現況／版本／證據與受控更新。
- Domain、Term Group、Term、Tag、Structured Property 建立及同一既有 URN 更新。Domain／Group／Term 父層驗存在與循環；Property 既有定義只改顯示名／說明，不做型別遷移。
- 資產 Domain／Terms／Tags 明確 add/remove/set、Property 值 set/remove、editable 說明更新；未選 metadata、未知成員、保留關聯的人工註記及來源 schema 保留。
- 沿用原生 Task／Run／Decision、可信父層人審、同一 publisher 的 per-Aspect CAS、一次性 attempt 與讀回；模型没有批准／發布 action，不新增 datastore 或 Core patch。
- Task optional `assets` 由模型 **0.1.10** 保存；非 Dataset 不填進 datasets，也不宣稱 ingestion membership。舊 `semantic-steward/1` 仍是 fill/add-only，舊 consent 不升級。
- Skill、Pi 工具參數、React 差異卡、父層審核與歷史接線。UI 明示既有原生 Task／Run ACL，**未提供多人私密隔離**；符合本輪延後處理多人權限的取捨。

主要程式：`integration/semantic-catalog-contract.mjs`、`native-semantic-catalog.mjs`、`semantic-catalog-publication.mjs`、共用 `semantic-native-client.mjs`，以及既有 publication／Task／MFE 接線。

## 實際檢查

| 檢查 | 結果與界線 |
| --- | --- |
| Semantic／Task／MFE regression | **166/166 PASS**；含六類資產、五類定義 create→update、欄位 property、移除／替換、未知欄位保全、權限／版本／階層負例、拒絕及 lost ACK 不重送。全部本地 API fixture，不是真 Catalog 寫入。 |
| Pi Web 全部既有 tests | **1033/1033 PASS**，serial 執行。 |
| TypeScript | `tsc --noEmit --incremental false` PASS；修改的 TS／MFE 與 Java scoped primary LSP 無 error。不是全 repo 掃描。 |
| Chromium 審核流程 | 390／1440 寬度，真 React→跨 origin MFE→Host／records，但 DataHub 與 session 邊界為 fixture。精確替換／Reject、選取重審、markup escaping、鍵盤操作、無水平 overflow、歷史重載與禁止重送 PASS。 |
| 官方模型 | **76 個實際新舊 compiler 輸出**通過固定 Core Pegasus schema；Task assets／舊紀錄 roundtrip／錯誤型別負例 PASS。716 個 Core jars 核 SHA。 |
| 官方 loader | 原 0.1.8 與候選 0.1.10 由不同 ZIP 載入，Patch／MergedEntityRegistry PASS；Task／Run optional assets 為 `OLD_READER_IGNORES_DATA`。不等於 API／ACL 已通過。 |
| Pi downstream | **575→原始506**精確 reverse patch，3 項 baseline checks PASS；未修改 upstream lock。 |
| 候選建置 | 專用 `ekop-datahub-agent-limited`，1 CPU／3 GiB／無額外 swap、serial；沒有在 dev checkout 執行 next build。沿 repo 固定 Dockerfile，npm-ci layer 是既有 cache，**不是新的 clean npm-ci 證據**。建置後 builder 已停止。 |
| 產物核對 | 映像 **575 個來源檔** byte／mode 全等、同源 **223 個 browser assets**與 runtime entry／relay 核 SHA；MFE webpack PASS。未切換服務。 |

候選 runtime image（以 Docker inspect 的 ID 為準）：

`sha256:61b45b142eb029d0d938cfda736d437a8f0ab0cc2e41690ba36a800f70d54efe`

0.1.10 model ZIP SHA-256：

`277acd98cbd8b8f974a1387826bd265086c3850853f25d893afdebab364ace80`

模型 ZIP 82 個插件 classes、0 Core／test classes。先前 0.1.9 的私密型別仍在包中，但本輪不接線其 writer、不向其寫入，也不宣稱私密隔離。模型建置後只有 README 文件補述，executable model source 與建置 snapshot 相同。

## 修正與原失敗保留

- 新的 read-review 起初只看資產／policy 快照，未把參照詞彙或既有定義的 revision 改變呈現為 stale；批准時的重編譯仍會拒絕。補上讀回的版本比較，保留 `false !== true` RED 與同一案例 GREEN，讓人審畫面在批准前即反映衝突。
- Lost ACK 測試初稿誤期待正常返回，修正為必須收到 `publication_write_unconfirmed`，再唯讀對帳；產品沒有改成重試。
- 原 React unit harness 僅 transpile 單檔，新增 component import 後找不到模組；改用現有 esbuild bundle 真依賴。ETL CLI 隔離 fixture 亦補齊新 import 所需 source。保留原失敗，沒有放寬產品檢查。
- 固定 Core 的 loader class-discovery fallback、ANTLR 版本、Gradle deprecation，以及既有 Next export dynamic-import warning 留在原 log；不換工具鏈消除警告。
- 最後限定 Lens cached 掃描涵蓋21檔，16個 style warnings，另有一個 `native-semantic-tasks.mjs` 的 past-EOF stale diagnostic；当前 Node parsing／真測試通過，fresh primary LSP 無 error，不為 stale 訊息改正確程式。不是全 repo 或所有 scanner 通過。舊 SQL fixture 第92行的重複 SQL injection advisory 已核為固定 SQL＋獨立 bound params，scoped cache 無問題；保留檔案並記 false-positive，不重跑來源 SQL。

## 證據與剩餘工作

私有證據：`.local/evidence/semantic-catalog-mainline-20260928-1zK2C8/`。包含原 RED／harness failure、final tests、browser screenshots／receipts、`model-build-ebqTQs/`、建置／downstream logs、`artifact-check.json` 與 `candidate-proof.json`。不提交或公開私有 evidence。

**尚未完成**：現場 Model／9041 Host／runtime／MFE 切換、SalesDatamart 精確六類資產盤點與核准設定、真 Agent 提案、人審與官方 API 寫入／讀回、真 Catalog UI／歷史 E2E。不能拿上述 fixture 或 schema 通過代替這些必要證據。

沒有執行本輪 live metadata、SQL、ETL、ingestion、全域 Policy 修改、provider prompt、commit 或 push。現行部署仍使用先前 Discovery repair worktree；不能刪除該 worktree。

簡短回顧：版本化意圖沿用既有 publisher，能擴充更新能力而不拆掉舊人工值保護；本地測試也抓到了人審 stale 顯示與測試依賴缺口。但真寫入可用性仍必須透過獲准部署後的原生 E2E 判定。

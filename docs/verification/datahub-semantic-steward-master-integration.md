# Semantic Steward：整合至 master

使用者在 S3 本地驗證後明確授權 commit、整合 branch/worktree 至 master 並 push GitHub；此授權不包含部署、live policy 更新、Semantic 寫入或 ingestion。

## 整合基準與保留事項

- 最新 master 基準：`166fd0f55ac6767500820e31243042028d24c708`（Remove legacy Tasks import panel）。
- 原 feature 以 `a25204e` 的非 tracked source 快照開發。先保存完整原工作樹 stash／52 檔 feature manifest，再將 feature branch fast-forward 至最新 master；只移植經驗證的 feature delta，不以舊整樹覆蓋 master。
- 以開發時已核 SHA 的 baseline 做三方整合。衝突為 native-discovery imports、server handlers／共享分析池、DataHubHostBridge 訊息路由。
- 保留 master 的 workspace import/readback、原生 Task/Run 接線、已發布內容重分析修正與其他來源解析修正。Semantic、Discovery、workspace import 共用既有 bounded parser pool，不新增服務／store。
- 舊 `mfe/tasks.js`／Tasks 匯入面板維持移除；Semantic 的可信審核 sidepanel 是獨立入口，不復活舊面板。
- 私密 `.local/`、憑證、原始設計文件、依賴 symlink／node_modules、測試截圖與執行收據不納入提交。原工作樹與 ignored 證據保留，未強制移除。

## 整合後驗證

- Semantic／Task records／Gateway／Ingestion／server／native runtime transport／Grafana publication／MFE mount／Host bridge：**187/187 PASS**。
- pi-web `tsc --noEmit --incremental false`、MFE production webpack：PASS。
- 390／1440 synthetic card → cross-origin MFE → Host/records 審核／選取／發布／reload 與 preview regression：PASS，runtimeErrors=[]。native DataHub/session boundary 仍是 fake；未宣稱真部署／模型驗收。
- Discovery：**20/21**；保留原有 `analysisVersion 1.0.3 !== 1.0.2` 斷言失敗。不是合併後全專案綠燈。
- 衝突涉及的五檔 primary LSP 無 error；保留 Next 71007 的既有 onRespond warning，不假扮 Server Action。
- 固定 Core／Pegasus 的 0.1.8 build／codec 收據重用前，已逐檔核對模型 build inputs；模型來源未因合併改變。17 compiler payload／14 原生 Aspect 型別證據見 S3 驗證文件。

## 可重現模型產物

新增 `extensions/datahub-agent/models/build/0.1.8/dist/ekop-agent-tasks-0.1.8.zip`，沿用 master 的版本化模型產物方式，保留 0.1.7：

- SHA256：`0cd889758830683d68da9625612f446c5848c07fd9661c8f4e998000f6b2476d`
- 內容：兩個 plugin jars、entity-registry.yml。
- 已比對前次離線建置產物及原始碼，非重新下載的未知 binary；**沒有安裝到 GMS**。

原 S1–S3 文件內「未 commit/push」與舊 baseline／漂移描述均為當時收據；本次 Git 整合授權及證據以本文件與 commit history 為準。原始整樹與三方合併計畫、log、source hashes 留於工作樹 ignored `.local/evidence/semantic-steward/master-integration/`。

## 未被此整合取代的限制

Task/Run 的原生稽核 reader/writer scope 仍需確認或以官方 Policy 隔離；既有 downstream lock 差異未重算成假綠。真部署、Source v5 policy、限定 Semantic 寫入及 Composer/model/native E2E 均仍需額外授權；S4 三方增量代管未完成。一次 ingestion 授權已消耗，不重播。

# Semantic Steward：原生 checkpoint 與 Host 範圍驗證

2026-09-22；`feat/semantic-steward`，獨立 worktree。這是 S2 的原生範圍接線證據，**不是 S3/S4 或已部署 Composer／模型 E2E 驗收**。本文件取代 governance 文件末段「未提交／未消耗／runtime inventory 尚未接線」的目前狀態；舊收據不改寫。

## 核准的一次操作：已消耗，禁止重播

使用者先選 AdventureWorks2019 metadata-only 七表，再核准修正旗標：

```yaml
stateful_ingestion:
  enabled: true
  remove_stale_metadata: true
  ignore_old_state: true
```

**這不是刪除授權。** 固定 SDK 的 remove=false 不產生 checkpoint；先用無憑證、阻斷網路的 SDK 實驗確認替代旗標不讀舊 state／不產生 removal workunit，再取得使用者明確批准。不得自行關閉 ignore_old_state。

- Source：`a513e611-5631-4cf2-8b96-3fa9fd1fee51`，CAS **v4 → v5**，只改已核准旗標。
- 新 recipe SHA256：`2f280d3ce4ed302855608710981c12f7457b3febdd942d976991acbba56d20a1`；舊 recipe pin／快照／批准不能自動沿用。未修改 live runtime policy。
- 唯一執行：`urn:li:dataHubExecutionRequest:329d2def-4c3d-4b35-829c-8610887f6429`，原生 **SUCCESS**，7394 ms。
- checkpoint 與該 Source／pipeline／Run 相符。固定官方 SDK **1.7.0.9** 解出 **7 Dataset + 3 Container**；Dataset 集合與七個核准目標完全一致。
- 七個 Dataset 的 protected semantic Aspects 前後均未變。但**操作前這些 Aspects 全部不存在**；這不證明已填人工內容的真發布保護。
- 第一次 protected-aspect-only batchGet 因所有請求 Aspects 不存在而省略 entity。依原生實作加入 datasetKey 身分錨點後，只修正讀回，沒有重送 ingestion。原失敗收據保留。

操作證據：`.local/evidence/semantic-steward/checkpoint-run/`，含 `execution-intent.json`、`readback-first-receipt.json`、`readback-receipt.json`、`decoded-checkpoint.json`。**不可再執行 execute-once.mjs；後續只對已知 execution 做讀回。**

## 已接入 production adapter 原始碼

- `native-semantic.mjs` 使用公開 timeseries API 讀最新原生 checkpoint；核 Source recipe/version、成功 Run input/result、CLI/executor、pipeline、精確 Run URN/UUID、DataJob ACL。
- `semantic-checkpoint.mjs`／`semantic_checkpoint.py` 將固定版官方 SDK 解碼集中於相容性 adapter，不另建 inventory store。只支援已驗的 MSSQL／CLI 1.7.0.9 job 契約、formatVersion 1.0、UTF-8 或 base85-bz2-json；舊 pickle serializer／未知格式拒絕。
- 原有固定 Python subprocess transport 抽至 `python-bridge.mjs`，Discovery 沿用同一路徑、參數、乾淨環境與錯誤語意。兩種 adapter 共用既有 Host 並行池；沒有新服務、shell、動態 executable 或 credentials 傳入 child。
- checkpoint 輸入最多 64 KiB、解壓最多 512 KiB、解碼最多 512 URN／200 Dataset、輸出最多 60,000 bytes；超界拒絕，不截斷後聲稱完整。官方 SDK 仍負責 state 格式／遷移；stdlib 的有界解壓只在解碼前檢查大小及串接 stream。
- Scope 中每個識別先核原生 Dataset ACL；移除不可讀成員，不因另一個成員被撤權而阻斷可讀資產。`taskDatasets` 是既有工作授權上限，可能還有下游發布目標，不是來源清單；有效 Source scope 取「原生 checkpoint 成員 ∩ 操作員模型授權 ∩ 原生 ACL」。不修改 Task policy、也不把其他工作目標誤列為 Source 成員。未知／未核准識別不傳給模型，既有 policy 的 16 Dataset 上限未放寬。
- 僅當 checkpoint Dataset 集合與有效核准可讀集合完全一致，回傳 `native_checkpoint_reconciled_operator_scope`、`completeSourceInventory:true`。含義是**這一次成功 Run 觀測的 Dataset 集合**，不是所有歷史 Catalog、所有來源 DB 物件或所有種類 Entity。
- 此證據不取代單一 Dataset 的 current `systemMetadata.runId/pipelineName` 對帳；若已被其他 writer 改變，仍保留 `source_membership_not_verified`。checkpoint digest／時間／Run 亦納入快照，分頁漂移拒絕。
- Skill 與 React 卡片呈現 Run 範圍、checkpoint 時間及限制。`publicationAuthorized:false` 和發布 blocker 不變，沒有發布按鈕。

## 真 DataHub 讀回與本地檢查

`.local/evidence/semantic-steward/s2-checkpoint-runtime/native-read-receipt.json`：使用同一已核准登入檔，只做 DataHub-only 公開 API 讀取，直接經 production `nativeSemantic` 與固定 SDK child：

- Source **v5**；原生 checkpoint 的 **7 Dataset** 在 Host 成功完成範圍對帳。
- **7/7** Dataset 同時符合 current native Run provenance，皆仍未授權發布。
- 本段兩次驗證共 **2 次登入、240 次 metadata 讀取、0 寫入、0 ingestion 提交**；第二次驗證最終的 Task 授權上限／原生成員交集修正，第一次收據另存 `native-read-before-task-ceiling.json`。沒有 SQL／業務資料列讀取、ETL、live policy 更新或部署。
- 本工作累計 client 操作：**12 次登入、394 次 metadata 讀取、1 次 Source CAS、1 次 execution submission**。先前 ingestion 自身另有 Catalog/checkpoint metadata emission；不可把它算成零 metadata 寫入或零來源系統讀取。

本地檢查：

- **77/77 focused tests PASS**，含 checkpoint 格式／解壓限制、空／缺失／過期／未核准集合、ACL 撤權遮蔽、Source/Run 綁定、快照漂移、per-asset provenance 不被 checkpoint 取代，以及卡片偽造負例。
- pi-web 完整 `tsc --noEmit --incremental false` PASS；未執行 next build。
- Chromium 合成 React 元件 390/1440，新增 checkpoint 卡片及既有差異／定義／欄位／impact、鍵盤、XSS 文字、遮蔽與 overflow 檢查 PASS，`runtimeErrors=[]`。截圖不是 Composer／模型 E2E。
- Production 檔 primary LSP 無 errors。MFE 原始碼未變，沿用仍有效的前期 Webpack 收據。
- 擴大 Discovery 回歸是 **97/98**，不是全綠：未改的測試期望 analysisVersion 1.0.2，未改的 `candidate.py` 已是 1.0.3；兩者 hash 均等於最初 baseline。只在臨時 probe 將版本斷言對齊既有 1.0.3，原 capture／分頁／source drift 行為經抽出的 transport 通過。沒有改正式測試或 DataFlow source 來掩蓋該既有落差。
- 最初新增 fixture 缺原生必填 platformInstanceId/config/partitionSpec；修正 fixture 後原 SDK 解碼通過。另一輪回歸找出整批 ACL 拒絕會破壞既有 impact 遮蔽，已在 scope 投影層改為逐項原生 ACL 收窄，恢復可讀資產行為。失敗 logs 均保留。

## 未完成與下一步

S3 仍需接既有 Task/Run/Decision 的提案持久化、可信逐項批准、保留人工值的 native CAS/PATCH、attempt／partial／unknown 對帳與原生讀回；不可擴 generic publication allowlist 接管人寫的 Aspect。S4 增量代管與三方比較未完成。一般 Catalog editor、其他 connector checkpoint、全域共享定義完整影響仍未獲此證據驗證。

可繼續上述本地實作；真部署／runtime policy pin 更新／Semantic 發布／額外 ingestion 仍需新的目標特定授權。原 checkout 並行漂移、downstream lock 原有 3 modified + 3 extra 保留，未自動同步、stage、commit 或 push。

回顧：原生 checkpoint 足以補本次 Run 的 Dataset 分母，不需要第二份 inventory authority。最重要的邊界是「當次觀測集合、目前單資產 provenance、業務語義與發布權」各自有不同證據，不能由一個 PASS 互相替代。

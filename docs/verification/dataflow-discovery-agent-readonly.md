# DataFlow Discovery — Agent 唯讀入口（歷史部署／E2E 證據）

> **2026-09-19 現況更新**：以下 9/14 E2E 仍是有效歷史證據，不代表目前可用。經另行核准的唯讀盤點，9041 當時無 listener；原 owned runtime `8094c258…` 已於 9/15 05:36 UTC 退出，exit 255、OOM=false，退出原因未證實。現行設定觀測仍為基本 Discovery，未啟用欄位模式。DataHub Catalog 真 API 的13 Dataset／149欄／39 Aspects讀回成功、值與歷史相同；不是 Agent E2E 或來源 SQL 身分驗證。詳[目前接線與預檢](dataflow-discovery-field-host-integration.md)。恢復 Host／清理已退出runtime／啟用欄位模式均未授權或執行，HOME不得刪除。

2026-09-14，Goal `mtzxzwn6-1zw7vn`，仍 current DM02／2 of12；main-only，無獨立審查。
本次已完成**真 DataHub Agent／模型／Host 的唯讀 Discovery 入口**；不是 ETL DataJob 發布或完整 Skill 驗收。

## 邊界與實作

`dataflow_discovery` Pi tool → native `ctx.ui.input` → `DataHubHostBridge` → DataHub MFE
`discovery.js` → gateway `/agent/discovery` → `nativeDiscovery()` → 固定 Python `bridge.py`。

- 工具只接受 `list_sources`、`analyze`、`sourceId`、offset/limit/candidateDigest。
  不接受 actor/tenant、Host root/path、endpoint、SQL、recipe、憑證或 publish intent。
- gateway 沿用 exact DataHub parent origin、正式身份 verifier、actor-bound grant＋revokeToken；
  runtime origin 不能呼叫控制面。source ACL 來自 operator-owned `discoverySourcesByActor`，
  未列使用者／來源不開放。父頁及Python均不把runtime的模型參數當作核准。
- policy 每筆只有 `sourceId`、absolute `root`、明列 `paths`、`snapshotSha256`、
  `modelContextApproved:true`。這是對已審閱bytes的讀取／模型隱私設定，不是新業務datastore，
  也不給metadata寫入或source execution權限。secret不在config內。
- Python以既有project `.venv/bin/python -I -B`、固定部署程式啟動；忽略caller PYTHONPATH／user site，
  不繼承Host HOME／認證env，也不import或執行snapshot source。沿用安全capture及validator。
- 每次重新capture並核approved snapshot digest；後續頁另外核candidateDigest。
  source或analysis version漂移會拒絕，不回傳已漂移內容。
- 每頁最多10 candidates，預設5，內容44000 UTF-8 bytes上限；候選過大會明確拒絕而非無聲遺失。
  回傳snapshot/candidate digest、analysis version、revision、counts、validation及相對evidence，
  不回傳Host root或整份source。
- 同actor最多1個、Host最多2個分析程序；wall timeout30s／SIGKILL、Python512MiB address-space
  與CPU20/25秒限制。這是有界可信parser，不是sandbox保證。Python讀取權限仍由Host政策限定。
- 回傳前再次檢查grant；MFE卸載取消並不交付遲到結果。無新worker服務、queue、scheduler或存儲。
  取消HTTP後Python可能繼續到30s截止，但它無source execution／metadata寫入能力。
- 每次結果明示 `publicationAuthorized:false`；`resolved`只表示靜態解析層，非Catalog/語義核准。
  Catalog adapter、connection/field evidence與typed publication仍是下一段。

## 已驗證的範圍

所有raw receipts在gitignored `.local/evidence/dataflow-discovery/`：

- `agent-discovery-final-source-tests-20260914.log`：57項PASS，包含policy拒絕、任意path/actor/SQL/publish拒絕、
  grant前後檢查、真Python subprocess不執行source sentinel、snapshot/analysis drift、分頁、
  Pi tool correlation、真HTTP gateway跨使用者/source ACL及revocation、父頁frame/origin/卸載，
  並保留原ingestion/Task Decision/Settings回歸。身份／runtime fixture不是真模型E2E。
- `agent-discovery-typecheck-20260914.log`：pi-web `tsc --noEmit --incremental false` PASS。
  新接線7檔＋MFE/bridge後續4檔scoped primary LSP均無error，不代表全專案安全掃描。
- `agent-discovery-real-source-pages-20260914.json`：已核准九檔source經真正nativeDiscovery→
  isolated Python返回兩頁10候選，total485／analysis1.0.2／validation INCONCLUSIVE；snapshot
  `ed276f258ceed74e491d85b16d8e54da9408cc9484b44a3bbccf8e4aec1af77f`及candidateDigest一致。
  這是direct Host診斷，**不是authenticated gateway／真Agent驗收**。
- `agent-discovery-mfe-build-20260914.log`：webpack5.110.3成功，產物在獨立
  `mfe-candidate-20260914/`；未覆寫現行dist或啟用到服務。
- `agent-discovery-downstream-check-reconciled-20260914.log`：522 downstream檔案逐bytes核對，
  reverse patch還原官方506檔baseline與catalog checks，3 tests PASS；原upstream lock未變。

## 打包對帳（不改既有邏輯以滿足舊提示）

原downstream lock還有3個既存format-only drift：SettingsPanel import排版、datahub-decision-extension
排版、rpc-manager-extension-ui test排版。只讀現有runtime `/app`的三檔，SHA與原lock完全相同；
保存old bytes、閱讀raw diff並用TypeScript syntax-tree equality核等價，沒有改這三個source。
證據 `preexisting-pi-web-drift-20260914.diff`／`preexisting-format-drift-verified-20260914.json`。
新的downstream patch/lock納入這些已核等價bytes與Discovery接線；備份在
`pi-web-downstream.{patch,lock.json}.before-discovery`。

首次重建在60秒deadline停止；確認程序已結束、backup/temp及原artifact寫入尚未發生。
加階段輸出並以同一受限程序續驗成功；未改用另一執行模式，也未影響live服務。
首次baseline checker受外層umask077影響，git reverse重建檔變600而非原644；
改成在private TemporaryDirectory內用原mode的umask022重驗成功，外部receipt仍600。
這是驗證環境差異，不是修改baseline期望／原始碼或取消mode檢查。

已確認的歷史JSON.parse outer-catch、Pyright非project-venv missingImports、boolean identity及
stale dashboard JSON提示不再重開修補迴圈；保存先前有效證據與diagnostic disposition。
不把這些誤報改寫成新缺陷，也不稱全案security clean。

## 已核准的限定部署批次

以下是部署前核對（不是現行映像）：gateway `127.0.0.1:9041`、scope `ekop-agent-local`；目前image
`sha256:2f7922820d42a86c8743efbfd2ea02bfac24ce56658ed6faa6e346f8c1d66ff1`。
owned runtime `33d85e9cbb2d26ee2459f91b8fc739a73c10052c24fdca264d707e2665c19219`；
HOME volume `dha-ekop-agent-local-4d5308a2eadb8da6e430c812dc85e0a571563e339436a89c`保留。
限定builder `ekop-datahub-agent-limited`目前停止；既有container核Memory/Swap均3GiB、1CPU。

使用者已明確選擇「核准建置與唯讀入口部署」，下列限定步驟已執行；沒有擴大為 publication 核准：

1. 用既有受限builder和固定依賴建候選runtime／匯出browser assets，驗image/artifacts後停止builder。
2. 先確認Agent無active工作，備份現行config/MFE；只為datahub actor開啟九檔exact snapshot唯讀policy。
3. graceful停止本案gateway；由原manager停止／移除**它擁有的**上述runtime container，保留HOME
   volume及原image，啟用候選image/MFE/assets。這會短暫中斷Agent；不動DataHub Core服務、MSSQL或Grafana。
4. 真DataHub父頁→Agent呼叫list/analyze、核對tool結果及頁面；沿用既有核准model/provider和runtime
   login，不讀出或搬移模型credential。失敗保留evidence並用原image/config/assets回復，不重播未知副作用。

本批不包含metadata publication、ETL/SQL、Source/Secret mutation或Grafana資產變更。
唯讀Agent入口已通過；ETL DataFlow／三DataJobs及完整欄位/BI語義閉環仍未完成。

## 實際部署與模型結果

- `agent-discovery-deployment-approval-20260914.json` 綁定原提案 SHA；部署前再次從正式父頁確認無active RPC。
  原gateway PID70293由pidfd精確SIGTERM，原manager清理唯一owned舊runtime；没有volume deletion。
- 現行image `sha256:78ac783d33ae42dcfd38ad15872e4e2947c8cb150248dfd46f01bf3f4dbd6294`，
  gateway PID3220470；runtime `8094c258dc3abba2b28f4d92ef49e01557e8e2fb40b2e880f0e51f578b7a6a28`。
  `agent-discovery-live-state-20260914.json` 驗network none／read-only rootfs／UID1000／1CPU／1GiB memory=swap，
  原HOME volume同一個、原image保留、Core clean、原MSSQL container running、restore clone exited保留。
- `agent-discovery-artifact-check-20260914.json`：222個browser assets與exact image逐檔匹配，runtime兩入口檔、
  package-lock一致；`agent-discovery-image-tool-check-20260914.json`：在候選image內真正載入extension並註冊工具。
  受限builder完成後已停止，未在dev checkout跑Next build。
- 現行browser assets：`.local/evidence/dataflow-discovery/browser-assets-candidate-20260914/`；
  舊config/MFE保留在 `agent-before-discovery-20260914/`，原browser-assets路徑未改內容。
  回復須重新核對目前PID／runtime ownership／無active工作，再還原舊config/image/assets；不得重跑一次性部署腳本。
  這是config/image/assets回復；Host接線原始碼仍在，舊config不開放Discovery來源。
- 真入口 `http://localhost:9002/mfe/agent` → 原生workspace `/home/node/pi-cwd-20260913` →
  session `01a0a00f-b459-718a-a9f0-e052b7c90e5a`。沿用既有 `openai-codex / gpt-5.6-sol`，
  沒有切換模型或取出其credential；這是被驗的DataHub產品Agent，非主會話新增子代理。
- **`agent-discovery-model-e2e-retry1-20260914.json`／PNG：
  `REAL_AGENT_NATIVE_DISCOVERY_HOST_AND_MODEL_READBACK_PASS`。** 模型自行呼叫原生工具list_sources→analyze，
  兩個真gateway回應；原生toolResult JSON與Host回應完全一致，沒有其他tool calls。
  回傳analysis1.0.2、total485、validation INCONCLUSIVE、publicationAuthorized=false與定位證據；
  snapshot ed276…、candidateDigest `4b102d6b899c766002148225169c48ccba211323dd4a34806f3b734cd064caf4`。
  模型回答／畫面數值一致，完整parent reload後仍保留答案，沒有重播completed analysis；pageErrors及HTTPerrors均0。

## 初次失敗與恢復（沒有改live功能／重播未知效果）

初始UI檢查找到了disabled New按鈕的title與隱藏project picker，並非可操作入口。
`agent-discovery-workspace-probe-20260914.json`／PNG確認原生Workspace按鈕會恢復既有cwd；改檢查路徑，未改UI。

第一次模型測試在模型仍running時提前結束並關閉browser，故原生list_sources回
`discovery_request_cancelled_or_unavailable`；沒有Host Discovery回應，也沒有metadata寫入。
`agent-discovery-session-reconcile-20260914.json`重新連回**同一session**，確認其已idle：模型如實報錯，沒有偽造結果。

可區分原因的無網路實驗 `agent-discovery-async-wait-probe-20260914.json`：目前安裝的Playwright1.63
`waitForFunction(async () => false)`在25ms返回false，並沒有等到600ms timeout。
檢查改用會await Promise的 `expect.poll`，核對本次user turn後的final assistant與idle，不修改Playwright或產品程式。
UI transcript的toolCall公開投影是toolName/input（不是SDK原始name/arguments），checker亦按實際契約核對。
確認舊turn終止／零Host calls後才在同session送出明示RETRY1驗證，並成功；原錯誤與取消receipt全保留。
這不是盲目重送、換模型或放寬auth；主會話自查也不是獨立審查。

## 下一段界線

只完成固定snapshot的唯讀候選頁；Catalog binding、Python execution/connection、field ownership／轉換、
可信typed Task/Decision、CAS／owned aspects／publication／完整DataFlow/Jobs/BI/column E2E仍未交付。
後續先做離線新模組與回歸；現行Host parser直接載部署原始碼，勿把未驗算法直接接入live import路徑當作未部署草稿。
新算法接線或metadata發布依相應範圍另驗／另准，既有Source/ETL/Grafana成功作業不重播。

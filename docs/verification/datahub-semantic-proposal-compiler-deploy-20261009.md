# 語義提案 compiler：部署與真入口只讀驗證

2026-10-09。使用者批准「部署驗證」，並親自重新登入 DataHub。**已部署，Windows Edge 真入口只讀核對通過；尚未執行新的真模型準備、真人批准或發布。**

## 目前部署

- Agent Host PID：`3356089`；原 `1622510` 已正常停止。
- 映像：`sha256:a438310bb3be7e23a7746ea0f5fd63ce923c4b4ca023e84fca6e7a26cada53e1`。
- 設定：`.local/agent-server-semantic-proposal-compiler-20261009-r9lDKo.json`。
- 設定 SHA：`940554656cd57f2459662839c2bc1debfc6e2bbe28d1c07efd92d389dea7b2c1`。
- 真入口：`http://localhost:9002/mfe/agent`。

此次載入[本地 compiler 實作](datahub-semantic-proposal-compiler-local-20261009.md)：Agent 可提供完整業務提案，Host 取得額外欄位技術上下文、保留意圖、編譯原生操作及核版本。移除不必要的定義／欄位拆項與分頁準備限制；必要 ACL、Source scope、證據、CAS、人工內容、UNKNOWN 不重送與整批真人確認維持不變。

## 部署範圍與證據

- 98 個 operator 檔案凍結核對。相對前版只有四個 Host compiler／契約檔、downstream patch／lock 共六處變化。
- Pi Web 593 檔與 exact image 逐檔核對；只有 SDK、兩個 SDK tests、runtime skill 共四個路徑變化。
- 隔離 serial Docker build：CPU 1、RAM 3 GiB、swap 0；實際 cgroup 核對通過，builder 已停止。未在 checkout 執行 `next build`，未安裝新的瀏覽器或工具。
- 223 個匯出 browser assets 与 exact image 完整相符；部署後真瀏覽器實際載入的 18 個 Next 靜態資源 SHA 亦全部相符。
- exact image SDK＋凍結 Host、合成原生 API 的 **106／106** 檢查通過，涵蓋整份多欄位提案、保留五項定義續作七資產、合成來源變更第二輪、輸入更正、ACL／並發／失 ACK、真正 pinned SDK Stop 及 HTTP 回執邊界。容器 network none、read-only、無憑證、使用空白 HOME。這些不是實際 Sales 模型成果。
- switch 前以真入口核 Actor 與全 runtime 閒置；正常停止唯一舊 Host／runtime，保留 HOME volumes，再啟動新 Host。
- 設定只變更 `runtimeImageId`／`browserAssetsDirectory`；Source grants、來源 scope、SQL／ingestion、連線、模型／thinking／預算不變。
- MFE 的 `89.js`、`remoteEntry.js` 完全不變；沒有重啟 Core／其他專案服務。

## 真入口讀回

使用 Windows Node 24.19.0、installed Edge `154.0.4258.62`、sandbox、新 owned context。測試只准核身分／原指定 Source、原 session 狀態／工具、原 Root／原五项 review 及歷史 start 的只讀對帳；沒有 prompt／prepare／approve／publish。

- Sales：原 SID／Luna-high／Semantic＋Catalog 保留；Source 七資產及原三項語義政策不變。
- 原 Root `56db64c0-0da2-4b38-a0e9-aadf8ef3d572`：**DRAFT v11／五項 PENDING 定義／scope 七資產**。完整 Root／scope／五項 Review 部署前後逐值相同，僅排除 top-level READ correlation `requestId`。
- AdventureWorks：原 CONFIRMED v325／142 項完整 view 與 digest 不變；沒有重送 114 次成功發布。
- 原 0fe start 仍只做精確只讀對帳，`NOT_PROVEN`／`retryAllowed:false`；c547 child 的目前 absence 不解釋成歷史零效果。
- 兩個 HOME volume 的 **42 份 journal：SHA／size／mtime 全部一致**。
- 新頁 Agent shell／composer 可見，owned 瀏覽器均已關閉；原使用者視窗／ordinary observer 未操作。新 context 不能證原 tab cache 已清除；使用者可重新整理 Agent 頁面。

## 保留的失敗與限制

原登入狀態到期導向 `/login`，首次讀回 timeout；沒有因此部署或啟動模型。新真人登入視窗的攔截腳本漏放原生 `/logIn`，修正後真人登入與 Actor 核對通過，沒有讀取／代填帳密。第一次 owned primary process 關閉定位包含 renderer 而拒絕動作；收斂到精確 owned profile 的唯一主程序後正常關閉。最後讀取完整 JSON 的報告 caller 被工具輸出截斷；改有界投影產生報告，沒有重跑部署。上述失敗全部保留。

部署後有一筆 tracking POST 被測試攔截，並有 `Failed to fetch` page error；不宣稱零 browser errors。真入口、指定 API 與靜態資源核對仍通過，沒有 fresh module factory overlay。亦不宣稱既有 LSP inconclusive 已變成 clean。

本次沒有真模型提示、metadata／來源寫入、代批、發布、AUTO、provider／模型切換、Core patch、commit／push／delegation。**實際 Sales 完整方案尚未 READY**，原生完整 Aspect／Catalog UI／真正證據變更第二輪仍 OPEN。若續作，需要新的、明確有界的同原 SID／Root 準備意圖；保留已存五項，不另 start 或重送 0fe／f0d／c547、成功項與旧提示。發布仍須可信父頁真人整批確認。

## 證據與回復

`.local/evidence/semantic-autonomous-plan-20261005-ScQzQE/semantic-proposal-compiler-deploy-20261009-r9lDKo/`：`validation.json`、`launch.json`、`delta.json`、`artifact-gate.json`、`image-source-proof.json`、`image-sdk-final.log`、`live-before-private.json`／`live-after-private.json`、`sessions-before-private.json`／`sessions-after-private.json`、`CHECKPOINT.md`。含登入狀態與私有截圖，**不得公開或上傳**。

前版 image／config 與四個 Host source 基準均保留。回復需核精確來源版本及閒置後取得操作批准；不能只改回舊映像便假定 Host compiler 也已回復。部署及登入 one-shot helpers 已消耗，不能重跑。

# Windows Edge 的 Agent 入口版本核對

## 結果

**Windows 端的 `http://localhost:9002/mfe/agent` 能載入最新核准的 Agent 部署。** 2026-10-08 已用實際 Windows Microsoft Edge 154.0.4258.53 驗證初次載入及重新整理，不是以 Linux Chromium 或修改 User-Agent 代替。

此核對只證明部署版本與工具註冊；**模型仍稱 Semantic 工具不可用的問題尚未修復。**

## 實際核對

使用已安裝的 Windows Node v24.19.0、Playwright 1.63.0 和 Windows Edge，建立全新、獨立的 headless 測試 profile。沿使用者親自登入並已核身分的私有驗收狀態開啟真入口；不讀帳密，不輸出 cookies，不使用其原有 Edge profile。

| 核對 | 觀察 |
|---|---|
| 真入口與 iframe | 頁面維持 localhost:9002/mfe/agent；iframe 指向原 actor 的 localhost:9041 服務 |
| 部署版本 | 初次及 reload 的 DOM 包含 build ID `wNgtLLaA2znbU0VYXLfs5` |
| Build manifest | SHA-256 `a30598a82d4c7a3dac0f14983c2700cdbe890eb89fe1a22d0cd3d761d00e88b3` 符合 pinned 映像 |
| 實際載入產物 | 21 種資源、含 reload 共 42 次 SHA-256 核對，全部符合本次產物；不是僅看檔名 |
| MFE | 實際載入的 remoteEntry.js／89.js 符合原部署 bytes；本次沒有更新 MFE 或 Core |
| 原對話工具 | 透過同一 Windows iframe 唯讀 RPC，實際啟用與系統提示詞宣告均含 `datahub_catalog`、`datahub_semantic` |
| 原對話狀態 | 同原 SID、Luna／medium、idle、pending 0；running 清單空 |
| 後端映像 | 實際執行映像 `sha256:779d9c404b0c4ef9c28aff0b28a9c288e12c285b11e26a948c7a957176cae4b7`，核對前後容器／設定不變 |
| 保存 | 兩 HOME、41 份 journals 的 SHA／size／mtime 全部不變；owned 測試 Edge 已關閉 |

原對話 Semantic schema SHA 仍為 `ad67a18ffedcda6e8ad5b47e9eae108bb23bb552abd9ef47375d285e6ecc2875`。只送 `get_state`／`get_tools` 與 GET；沒有新增模型請求、工具執行、SQL、metadata 寫入、維護 Root、確認或發布。沒有安裝、部署、改模型／權限／預算、commit 或 push。

## 界線與失敗紀錄

- 測試使用新 profile；安全攔截會停用 HTTP cache，且 service workers 被阻擋。入口與版本是真服務，未 mock，但**不代表使用者原有 Edge 分頁的記憶體快取已核對或清除**。
- 两個 tracking POST 被唯讀護欄攔下，另保存兩個 `Failed to fetch` pageerrors／resource errors；不宣稱零瀏覽器錯誤。
- 首次 caller 在 iframe 尚處於空 URL 的 bootstrap 階段就解析 URL，造成 `Invalid URL`。已關閉該 owned browser，保留失敗；改為先等真實 composer 再核 origin，第二次通過。未重送模型或任何效果。
- PowerShell inline quoting 的準備錯誤保留，改用檔案 caller；沒有調整 ExecutionPolicy 或安全設定。
- 一次模型探測與其部署授權仍已消耗；本次 browser 核對不授權第二次模型探測。

私有證據：`.local/evidence/semantic-autonomous-plan-20261005-ScQzQE/windows-edge-deployment-check-20261008-CGMkPQ/` 的 `attempt2/result.json`、`network-assets-private.json`、初次／reload 截圖、cleanup，以及 host-before／after journals 保存核對。

模型問題的既有證據見 [零工具效果診斷](datahub-semantic-model-tool-diagnostic-20261008.md)。

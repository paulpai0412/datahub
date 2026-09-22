# Host 恢復批次 B：真工具回應已取得，驗收未完成（2026-09-19）

使用者透過 `ask_user` 明確核准完整恢復方案。B 已於 **13:46:03.055–13:46:48.966 UTC** 執行並結束，**不得重播**。

## 實際完成

- 41 個 Host／Python source 檔、原 MFE 兩個產物、九檔 snapshot、SDK `1.7.0.9`／SQLGlot `30.12.0` 符合。
- 本次真正讀回 HOME volume 自身的 scope／owner labels，並確認沒有其他 container 使用；修補了 A2 未完成的 volume-owner 證據。
- 依核准刪除原已退出 container `8094c258…`，不帶 force／volume removal。原 image、HOME、MFE、Core 均保留。
- 只加入指定 `pythonAnalysis`，啟動 gateway PID `1652515`／新 runtime `021fc063…`；真入口 `http://localhost:9002/mfe/agent` 開啟成功，owner／image／隔離設定一致，原 active RPC 清單空白。
- 一次登入憑證內容讀取、一次登入、一次 Send 嘗試；**實際捕獲四個原生 Discovery HTTP 200**：list、欄位首頁、`_parse_facts` decoder summary、`value:115..119`。
- 三個分析頁均為真 Host／真 Catalog：56 欄位槽、19 SQL contexts、1423 transport nodes／331 unresolved、4 decoder reports／311 decoder nodes；`decoder:_parse_facts:value:119 → value:118 → value:115 quantize` 可見。
- 各頁 `INCONCLUSIVE`、`publicationAuthorized:false`，runtime／Python value verification 仍 false。Catalog digest 與先前真讀基線相同：`e9bc4a5f166c0321828d94f8df450d2bf9c0a21377c8e1cda4b758616f33763b`。
- 本輪 candidate digest 為 `39fed3c9a795df90d3441fe8867b7ddc39f9d49c7c875b2413516a8356e55fab`，三頁相同。它綁此次固定 policy，不能直接拿舊回放 digest 代替。

這證明真 Agent／工具／Host 已經傳遞欄位結果；**尚未證明最後模型回答、實際 UI session 對應、reload、兩個負例**。沒有把 HTTP 成功視為完整 E2E。

## 失敗與回復

驗收器在 `one_real_model_prompt` 階段得到 `TimeoutError`；原始細節未保存，收據只保留型別與 generic safe code。`promptAccepted` 尚未記錄，但四個真工具回應已到达，因此**不可解讀為 prompt 未送出，更不可重送**。

依 B 核准的失敗回復，已 graceful close 新 gateway／runtime，真 scope 讀回空集合、HOME labels 保持一致，並以保存的原 bytes 還原設定：

- 原 config SHA：`baea5d03e07f30db9e91f80e1964e5490440c361d8b3284d0fe9dd8a931eb172`。
- B 暫時 field config SHA：`dadb6d5749d06c952c5d341e1a08c2f2769413517511388e6566c14b351542f6`。
- Config restore 為 atomic rename ACK；本批沒有另讀一次 config 來冒充未核准的額外 operator read。Operator 兩次 config read，另有已核准 Host CLI 啟動時的正常 config read。
- 截至 B 結束：gateway 已關閉，本 scope 無 container，HOME 保留。原 `8094c258…` 與新 `021fc063…` 均已刪除；**不能再使用要求原 container 存在的 B 腳本／方案**。

SQL、ingestion、DataHub metadata publication／Task writes 皆未執行；沒有改 Core、image、MFE、服務權限或其他專案。正常 Pi session 寫入既有 HOME。

## 離線查明的驗收器缺陷

在不啟動服務、不讀憑證、不呼叫模型的實驗中，使用實際 SDK `SessionManager`、實際 `getRpcSessionInfos()` 函式與 B 的原 ACK predicate 重現：

1. 額外從 API 建立但未送 prompt 的 `ensure_session` 沒有 persisted JSONL。
2. 既有 session index 明確排除這種 idle／empty runtime。
3. `SessionSidebar` 只有在 index 中找得到 URL session 才會選取它；UI 的 `useAgentSession` 自己維護 session id，必要時另外 ensure。
4. B 驗收器卻假定先建的 `01a0b9ea-e551-76c8-826f-37e50b0b6a43` 一定是 UI Send 的目標，ACK predicate 會拒絕另一個合法 UI session 的同一 prompt 回應。

以上三個前端 source 與歷史 T07 快照雜湊相同。**驗收器的 session 綁定假設確實不成立；本次真實 Send 的 ID／原 timeout 方法細節仍須讀既有 session 證據確認，不能用離線重現補造現場記錄。** 正確邊界是觀察 UI 自己初始化的 native session，而非先在 UI 外建一個空 session 再猜測導覽已綁定。不是修改 Core／session 持久化規則或重跑成功的工具呼叫。

## 證據與下一步

Private：`.local/evidence/dataflow-discovery/`

- `host-recovery-approval-20260919.json`、`host-recovery-run-20260919.json`：批准、實際四份回應與回復。
- `host-recovery-browser-20260919.mjs`／`run-host-recovery-20260919.mjs`：保留實際執行版本，勿改寫為成功版本。
- `host-preview-session-ownership-offline-20260919.json`／`verify-host-preview-session-ownership-20260919.mjs`：可重跑的離線缺陷驗證，不是 live session 讀回。

下一步須新的受限批准：恢復同一 Host／policy，只讀本批時間窗與 marker 的既有 session，不送任何新 prompt／不重跑四個 Discovery；再補 saved answer／reload／兩個負例。若既有回答被中斷，明確保留未完成，不自動補問。

回顧：此次有效進展是真欄位工具回應與 HOME ownership 證據；失敗由自行撰寫的驗收器暴露出 session 關聯與錯誤保存不足。應修正驗收邊界並對帳已完成工作，不藉機改 Pi／DataHub 或擴建 parser。Goal 仍 10/18，`discovery-validator` 未完成。

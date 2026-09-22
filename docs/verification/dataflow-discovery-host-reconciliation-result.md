# 批次 C 結果：Host 保留，既有模型回合確為部分回答

2026-09-19，使用者明確核准後執行一次，**14:47:12.248–14:47:21.656 UTC**。C 已結束，不重播。

## 已完成

- fresh empty-scope、HOME owner／無其他 consumer、41 個 source 檔、原 MFE／image／SDK 與 snapshot 檢查通過。
- 原 image／HOME 恢復成功；只加回 B 的相同 field policy。Config SHA `dadb6d5749d06c952c5d341e1a08c2f2769413517511388e6566c14b351542f6`。
- 真入口 `/mfe/agent` 可開，field capability 回應 200。新 runtime 的 owner／image／隔離與 HOME 綁定通過，**健康 Host 與 policy 按核准保留**。
- Operator config 讀兩次、Host CLI 正常讀一次；登入憑證內容讀一次／登入一次。**零新 session、零 prompt／模型生成、零重跑 B 的四個成功工具**。
- 一次 session index、一次指定既有 history 讀取。唯一 B marker session 是 `01a0b9ea-f4ec-76c8-826f-37e683569d2d`，不是驗收器預建的 `01a0b9ea-e551-76c8-826f-37e50b0b6a43`。四個 saved tool results（含 requestId）與 B 捕獲的真 Host 回應逐值相同，沒有其他工具。
- 兩個非模型負例完成：舊 digest 得 **409 `discovery_analysis_drift`**，注入 `catalog` 參數得 **400 `invalid_discovery_request`**；native Catalog reads 上限16。未執行 SQL、ingestion、metadata／Task／Run／Decision／publication writes。

本次新驗收腳本語法檢查與兩檔 primary LSP 通過。沒有 production code／Core／MFE／image／model plugin／權限修改，沒有 commit/push。SDK model plugin 仍依歷史部署0.1.1，不是0.1.3。

## 仍未完成與診斷界線

既有最後一則 assistant 為 `openai-codex / gpt-5.6-sol`、**`stopReason: error`**。已保存的部分文字包含 format、三個完整 digests、56／19／311、`INCONCLUSIVE`、`publicationAuthorized:false` 及 graph namespace 區別；但缺 decoder `value:119 → value:118 → value:115 quantize` 的後半說明與完成標記。

因此：

1. **驗收器的錯誤 session 綁定已由真 history 證實**，不只是離線推測。
2. 另有**模型回合終止錯誤**，不能把它一併歸因於驗收器 timeout／rollback，也不能說完整回答其實早已成功。
3. C 收據保存終止狀態、部分文字與完整四個工具結果，**未保存 `errorMessage` 欄位**；不能憑部分文字推測額度、供應商、網路或 egress 原因。
4. 本地 B gateway log 只有啟動／module-type warning，無相應錯誤細節。已查 gateway proxy／egress source，尚無證據支持「固定20秒 timeout」假說；未改 timeout、權限或 parser。
5. 因完整回答不存在，**未執行回答的 UI／reload 驗收**，也沒有另發 prompt 補寫。Source/runtime／轉換語義及 publication 仍未驗收。

## 當次保留狀態與下一步

- Gateway PID `1897603`，start ticks `16681759`。
- Runtime `9039afd240339b48739c4be9d0a955acb4e39017092124bdc4becc8fde5997ac`，當次末端讀回 `running`。
- 原 HOME 保留；UID1000、read-only、network none、1GiB memory=swap、1CPU、128 PIDs 不變。
- 以上是 **14:47:21 UTC 的觀測**，不是未來健康保證。

下一個有用動作是限定讀回**同一 session 的最後 errorMessage／錯誤分類**，先理解模型錯誤，不盲目重送或換 model。C 的登入與一次執行已結束；若需再次登入／live 讀取，須新批准。不需要再恢復服務、改 config、重跑 Discovery 或重新讀整份 Catalog。

Private evidence：`.local/evidence/dataflow-discovery/host-reconciliation-{approval,run}-20260919.json`；實際腳本 `run-host-reconciliation-20260919.mjs`、`host-reconciliation-browser-20260919.mjs`。原 B 收據／腳本未改寫。

Goal 維持 **10/18**、current `discovery-validator`。回顧：服務可用性、工具結果一致性與真正模型完成必須分開；已修正錯 session 的驗收方法，仍需保留終止錯誤細節，不能用更多成功 HTTP 掩蓋模型失敗。

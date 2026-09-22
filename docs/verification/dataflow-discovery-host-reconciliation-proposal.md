# 批次 C 提案：恢復既有 Host，只讀對帳已送出的回合

**待新批准；B 已關閉。零新 prompt／零新模型生成／不重跑 B 的四個工具呼叫。**

背景見 [B 結果與離線診斷](dataflow-discovery-host-recovery-result.md)。B 已取得四份真 Discovery 回應，但驗收器錯把 UI 外預建的 idle session 當成 Send 目標；實際 session／最後回答未讀回。B 已按原方案關閉新服務、還原 config。此提案不是重試 B。

## 目標及前置條件

沿用 B 的 scope `ekop-agent-local`、actor `urn:li:corpuser:datahub`／tenant `ekop-datahub`、原 image `sha256:78ac783d33ae42dcfd38ad15872e4e2947c8cb150248dfd46f01bf3f4dbd6294`、原 HOME `dha-ekop-agent-local-4d5308a2eadb8da6e430c812dc85e0a571563e339436a89c`。

- 重新確認 9041 無 listener、scope **零 container**、原 HOME 自身 owner／scope labels 相符、無其他 container 使用 HOME。**不再刪除任何舊 container**；`8094c258…` 已不存在。
- 固定同一 18 個 Host import／23 個 Python 模組、原 image／MFE／SDK／九檔 snapshot，不 build、不升級。
- Operator config 初讀須符合 B 原始 SHA `baea5d03e07f30db9e91f80e1964e5490440c361d8b3284d0fe9dd8a931eb172`。只重加完全相同的 field policy，產物須為 B 的 `dadb6d5749d06c952c5d341e1a08c2f2769413517511388e6566c14b351542f6`。不改其他設定／權限。
- 每項不符即停，不收養容器、不重建空 HOME、不套用 B／A 的舊批准。

## 核准的一次操作範圍

1. Operator 讀 config 最多兩次（初讀／變更後讀回），保存受保護備份；另允許既有 Host CLI 在這次啟動時正常讀一次 config。一次 config 更新、一次 Host 啟動、manager 在同 image／HOME 建立／啟動一個同 actor runtime；隔離參數仍 UID1000、read-only、network none、1GiB memory=swap、1CPU、128 PIDs。
2. 讀 `.local/user.props` 的 `datahub` 登入值一次、登入一次；只留於可信測試程序／browser。進真正 `http://localhost:9002/mfe/agent`，核對新 runtime 的身分／隔離與 active RPC；**不建立測試用 session、不按 Send、不回覆 Decision、不送任何 prompt／steer／follow-up／resume-generation**。正常唯讀 session 載入不是恢復模型生成。
3. 一次 native session index 讀取，在可信程序內只選 B 的 **13:46:03.055–13:46:48.966 UTC** 時間窗、first message 含 `FIELD_PREVIEW_APPROVED_20260919` 的本 actor session；須唯一。最多讀兩份候選 session 的最後 30 則訊息。已知預建 ID `01a0b9ea-e551-76c8-826f-37e50b0b6a43` 不被當成實際 Send ID；未找到或不唯一就回報，不猜測、不遍歷其他對話內容。
4. 只對帳該 marker 回合：四個 `dataflow_discovery` tool results 必須與 B 收據逐值一致、沒有其他工具；讀回實際 session ID／model／最後回答／終止狀態。只保存這個核准回合，其他 session index 內容不輸出、不持久化、不送模型。
5. 有完整既有回答時，在真正 UI 開啟該 session、核對 digest／graph namespaces／`INCONCLUSIVE`，並 **一次 reload** 確認仍是相同既有回答。驗證器阻擋任何 prompt 或 Discovery 自動重播；缺少／中斷的回答只能記為未完成，不用新模型請求補寫。
6. 同一已認證 parent grant 最多一次 `list_sources` 確認 field capability，及兩個非模型負例：舊 digest 分頁、model-supplied policy／Catalog。只有舊 digest 負例會讀 native Catalog，最多 **16 個 native reads**；不再取得 B 的三個成功分析頁。登入／grant／heartbeat／既有 session/UI 讀取另記，不將其冒充新的模型或語義驗收。

本批最多 10 分鐘，不自動重試登入、config 更新、startup 或請求。既有 Runtime SDK 可正常使用原認證載入狀態，但不新增、匯出或換 provider／model／憑證。

## 保留服務與失敗處理

**這次把恢復服務與舊回合驗收分開：** 若新 Host／runtime 的 owner、image、HOME、隔離、真入口及 field capability 已驗證，保留健康服務與原核准 field policy；即使舊模型最後回答缺失，仍報告 E2E 未完成，不因收據缺項再次關掉健康服務。

只有 startup／owner／隔離／入口驗證失敗，且此次新 PID／container 所有權可確認時，允許一次 native graceful close／SIGTERM、由 manager stop／remove 此次新 container，保留 HOME，還原備份設定，不第二次啟動。任何未知 ACK／所有權不明都停止新增動作並對帳，不強刪／強殺。

原 9 檔與 13 Dataset 的持續 field-preview 資料範圍不變，仍是 B 批已核准的範圍；C 不把新 metadata 送入模型。沒有 SQL／ingestion／DataHub metadata write、Task／Run／Decision 寫入、publication、Core／model plugin／image／MFE／ACL／其他專案服務修改或 commit/push。正常 session／設定狀態可留在原 HOME。

無論對帳是否成功，都不等於完整 lineage 語義、跨 actor ACL、publication 或 `discovery-validator` 已完成。

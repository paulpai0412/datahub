# Sales 原對話：舊拒絕恢復接點

## 結果

舊拒絕恢復已在原 Sales 對話實際通過；原生同一草稿已保存 **5 項待審定義**。但 7 個資產尚未完成套用方案，**仍是 DRAFT，不是 READY**，沒有批准或發布。

目前 Host PID `1622510`，映像 `c8c42afa…`；原 `1379763`、`917929`、`275437` 已退休。模型前取消與定義輸入契約修正均已部署，MFE 本次不變。來源仍只限既有 7 Dataset、原對話及 Luna/high；Source 設定、SQL、ingestion、其他來源、模型／預算未變。未修改 DataHub Core。

## 已交付的恢復行為

- `reconcile_maintenance_start` 是唯讀 action。由 actor、原 request UUID 決定確切 Task／Run，核身分、Source、scope、版本與 Root 綁定，區分 `NO_CURRENT_RECORDS`、`PARTIAL_PREPARATION`、`SAVED_PLAN`。
- 回傳永遠保留 `effect:NOT_PROVEN`、`retryAllowed:false`、`readOnly:true`、`publicationAuthorized:false`。目前找不到紀錄不是歷史零效果證明，不允許重送原 request。
- 同 session active branch 的可信原 start intent／unconfirmed receipt 配對，讓 `before_agent_start` 在第一次模型回應前讀目前 Source 政策及原紀錄。只提供隱藏事實訊息，不綁 Root、不恢復 continuation／consent、不改舊日誌。
- 讀取不可用時標 `READ_UNAVAILABLE`；不可把舊拒絕當新的 Host 回覆，也不能用不確定讀取宣稱已恢復。

## 已驗證

- Host／SDK RED→GREEN、實際固定 SDK 的第一次 provider context 與 reload、同輪錯誤分類及原 maintenance 回歸通過。
- 部署前 app typecheck／目標 lint、593 來源 pins、reverse 官方 506 來源及 3 foundation 通過。CPU1／3GiB／swap0 隔離序列建置；builder 已停止。精確映像來源、SDK 與瀏覽器資源 byte gate 通過。
- 實際 Windows installed Edge 真入口：三個原對話的模型、推理層級與 active tools 不變；Catalog schema 不變，Semantic schema 是預期更新。原 CONFIRMED325、全 142 項及完整計畫內容不變。
- 跨部署及唯讀驗證，兩 HOME／42 journals SHA、size、mtime 完全一致。必要 MFE allowlist 更新，remoteEntry 保持不變。
- 真人已核來源的原精確 Task／Run 都回 `NOT_FOUND`，目前三項準備能力為 true；原失敗歷史及效果限制不改。

## 最新：定義輸入契約已部署，同一 Root 準備於欄位快照拒絕停止

使用者再准窄部署與同 Root 一次新準備。98 operator 只 Host 純輸入兩行及必要 patch／lock；593 app 只 SDK 提前拒絕與契約說明。精確反向還原驗證既有來源不受其他改動；映像来源、資源及隔離映像內 9 項 SDK／Host／取消／freshness 回歸通過，builder 已停止。

真 Windows 入口確認原 DRAFT／7 資產／0 項、原全 142 項、三個對話模型與工具、MFE、跨 switch 兩 HOME 42 journals 不變。保留驗收 caller 的唯讀 mount／缺靜態 fixture，以及讀取 correlation requestId 比較失敗；修正只在驗收 caller，未重跑部署或效果。

新提示於 **14:33:46.771Z** 進原 Sales 對話，已收到同一 Root 的 `continue_maintenance` 原生 ACK；禁止新的 start／Root、批准、發布。只接受本次已記錄可信回應的完整相同 UI 值，含完整綁定的 typed input rejection。最長 45 分鐘，READY／失敗／不確定即停。本輪於 **14:35:31** 停止：保存 3 個 Term、1 個 Structured Property、1 個 Tag 的待審定義後，首個 Dataset 套用項目把多個欄位 Property 值混在資產層級項目。既有 Catalog 要求每個欄位使用相符的 root `fieldPath` 與獨立快照；Host 回 `semantic_field_snapshot_required`，caller 公開 abort 並停止，不重送。

獨立原生讀回：同 Root **DRAFT／runVersion11／5 active及recorded PENDING／0 accounted、7 unprepared**；5 個精確 child review 與 ACK ID 一致，被拒 child 目前找不到。127-message 完整 active branch、leaf `c07293d5`，原 Luna/high、工具、idle／queue0 保留。未 seal，也未取得發布批准；保存定義不等於定義已發布或完整語義維護。

此後本地補齊同一輸入邊界的欄位 Property 形狀檢查：候選欄位與 root 欄位不同時，SDK 在派送前拒絕；Host 只對這個純結構條件產生精確綁定的 pre-write proof，不將一般 409／過期快照／CAS 放寬為可重試。模型必須自己提出新的完整項目，程式不自動拆分或補快照。RED→GREEN、合法相符欄位快照保存 PENDING 的正例、既有拒絕／失 ACK／maintenance 回歸、TypeScript／目標 lint及官方來源還原通過。**這項後續欄位 Property 修正尚未部署。**

本輪單次授權已消耗。若繼續，需要新的必要窄部署及同 Root 新準備意圖授權，不重送成功的 5 項或被拒請求。完整有據方案、可信父頁真人整批確認、原生／Catalog UI 與真正變更輪次仍未完成。

## 前一輪：建立 DRAFT 後於輸入拒絕停止

使用者另准窄部署取消修正及一次新準備。第二次部署只有 app RPC 取消 guard 與必要版本鎖；精確映像 SDK、Windows 真入口、原全 142 項及跨 switch 42 journals 驗證通過，builder 已停止。

新的一次提示讓 Agent 在原對話讀到目前能力、成功 start；原生 Root 尾碼 `56db64c0-0da2-4b38-a0e9-aadf8ef3d572`。隨後模型在同提示自行更正數個 SDK 純本地輸入拒絕，但第一個送達 Host 的詞彙定義仍带 `fieldPath`。既有 Catalog `preview_definition` 禁止欄位定位，Host 回 `invalid_semantic_catalog_request`。本輪停止並公開 abort；授權已消耗，不重送提示或該請求。

獨立真入口唯讀讀回：新 Root **DRAFT／runVersion1／0 active及recorded items／7範圍資產**；精確被拒請求的 child Run 目前 `task_record_not_found`。65-message 完整 active branch、leaf `22daec85`，原 Luna/high、工具、idle／queue0 不變。這些是目前狀態，不追認原 `0fe65…` 或舊 UNKNOWN 的歷史零效果。

本地已對齊 SDK／Host 輸入契約：共享定義带 `fieldPath` 時，SDK 在意圖日誌／傳輸之前拒絕，只允許模型提出新更正輸入；Host 在純輸入邊界回完整綁定的 typed pre-write proof。沒有自動刪欄位、重寫證據、重播或放寬 Catalog。RED→GREEN 及真正資產層級定義保存為 PENDING 的正例、原 maintenance／start 對帳／失 ACK／拒絕分類回歸、TypeScript／目標 lint 通過；593 sources 只一 SDK delta，可 reverse 精確還原官方 506。這項輸入對齊當時只在本地，已由上述新部署生效。 LSP 保留既有 hint／風格 findings及一檔 inconclusive，非全域 clean。

上述新明確授權已用於窄部署及同 Root 一次新準備；不得另 start／換 Root 或重送被拒操作，也不能把它延伸為無限重試。每輪真人父頁整批确认仍是發布前置。

## 前一輪失敗及責任（歷史）

本地驗收 caller 先遇到「Send／傳送」與 composer `.trim()` 契約差異，兩次都未送達 Host；獨立 42-journal 比對證明未進 SDK／模型。原失敗檔案與 marker 保留，沒有覆寫或重播已接受操作。

最後一次新意圖在 07:10:13.596Z 已進原對話。模型前 `list_sources` 在可信 Host 成功，但 caller 錯擋合法 `extension_ui_response`，回執無法進 SDK。本輪逾時後公開 Stop。完整 15-message active branch 的唯讀核對證明：沒有新的 start；模型另一次 `list_sources` 讀取因取消／回執不可用而停止。當前 idle、queue0、pending UI0，不能再重送此提示。

另發現本次非同步模型前讀取暴露取消時序缺陷：SDK 的低層 run 尚未啟動，Stop 返回後仍可能開始 provider。以實際固定 SDK/RPC 重現 providerCalls=1 的 RED；在既有 RPC preflight callback 核原 prompt 的 Stop signal 後，取消 providerCalls=0 的 GREEN、正常 freshness／reload 與原 RPC 回歸通過。此取消修正當時只在本地；已由上述第二次部署生效。 沒有 Core／SDK patch、替換 stream function 或新增 provider。

接續 caller 模板已準備：只回傳與本輪已記錄可信 Host response 完全相同的 RPC 值；不解除 metadata scope、Root、原 request no-replay 或 publication 禁止。模板不可執行。後來的一次新授權已部署取消修正並完成上述 DRAFT 建立，但該授權也已使用；不因此允許模板重跑。

## 限制與下一步

- 單次新準備授權已使用；失敗不允許自動再發一次。
- 原歷史效果仍 NOT_PROVEN；當前 absence 不清洗 UNKNOWN。
- 本地取消修正的 typecheck／目標 lint／官方 baseline 回歸通過；LSP 2 檔均 inconclusive，不能宣稱全域 clean。
- 完整有据 Sales 方案、父頁真人整批確認／發布、原生／Catalog UI、真正證據變更第二輪仍 OPEN。

最新私有證據：`.local/evidence/semantic-autonomous-plan-20261005-ScQzQE/semantic-definition-input-deploy-20261008-aFwNXi/`；前輪 `.local/evidence/semantic-autonomous-plan-20261005-ScQzQE/semantic-start-cancel-deploy-20261008-6HApEP/`（driver、獨立 native／完整 branch）；前一輪：`.local/evidence/semantic-autonomous-plan-20261005-ScQzQE/semantic-start-recovery-deploy-20261008-cUQaMY/`；本地測試及取消 RED／GREEN：`.local/evidence/semantic-start-recovery-local-20261008-B9YM5r/`。保留 caller failures、tracking errors、非 clean 診斷；未 commit／push。

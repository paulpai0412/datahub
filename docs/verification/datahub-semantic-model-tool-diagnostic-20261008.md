# 模型宣稱 Semantic 工具不可用：歷史診斷與最新進展

## 最新進展：已發生真正工具呼叫

2026-10-08 使用者提供新的 `datahub_semantic/start_maintenance` 呼叫及 Host 回覆。此操作已越過「没有 Semantic 工具」症狀，現在是另一來源的維護能力拒絕，不是工具註冊失敗；不能再把下方歷史探測的「尚未修復」當成本次仍未呼叫的現況。

可信父頁面唯讀確認該來源已允許 metadata 讀取／預覽，但審核提案能力關閉，且來源政策由部署端管理。診斷時沒有修改權限、重送原 request 或追加模型探測。使用者隨後明確批准該來源限定能力及必要 Host 重載，已啟用並唯讀核對；詳見 [SalesDatamart 能力設定](datahub-sales-semantic-capabilities-20261008.md)。仍未送新模型、草稿或發布。此前 payload／模型差異的唯一根因仍未證明；完整語義代管與真變更第二輪仍未完成。

## 結果與界線

2026-10-08，一次真正的零工具效果探測重現了問題：**應用端送出的模型請求包含完整 `datahub_semantic` 定義，但模型仍稱沒有這個工具，沒有產生工具呼叫。**

此前補上 `promptSnippet` 確實修正了工具宣告缺漏，但沒有恢復使用者觀察到的模型行為。不需持續重新登入、改權限或重送維護。現在仍需區分長對話／歷史影響與模型服務處理；本次證據不包含遠端服務內部如何採用工具定義，不能宣稱唯一根因。

## 探測方式

沿原對話、現有模型及推理層級，經原 SDK 的公開 `Agent.streamFunction` 取得**第一個模型回應**。維持原工具名稱、description、schema 和系統提示詞。沒有 Agent loop、工具 dispatcher、`execute` callback 或前景維護續作。

- 應用端 provider payload：`datahub_catalog`、`datahub_semantic`，`tool_choice=auto`。
- 模型：現有 `openai-codex/gpt-5.6-luna`、medium；沒有切換模型、provider 或預算。
- 一次邏輯 provider invocation，HTTP 200；模型正常停止，未回傳 provider error，但仍否認 Semantic 工具可用。
- 工具執行、SQL／Grafana、metadata 寫入、新維護 Root、確認及發布均零。
- 尚未發生 Host ACL／CAS 拒絕：模型沒有呼叫工具。

第一方實作位於 `extensions/datahub-agent/pi-web/lib/model-tool-probe.ts`，由既有已認證 Agent RPC 接點接線。派送前記錄既有 Pi journal 的 ATTEMPTED；失敗、中止及成功回應均消耗探測，不重送。要求精確 session 與實際 Semantic governance 工具集合；busy／queued work 拒絕，探測中不准另送 prompt 或修改模型／工具，Stop 可取消。

## 隔離檢查與部署

- 本地零效果檢查 4 項、既有 RPC 回歸 24 項、TypeScript／限定 lint 通過。
- 即使 fixture 模型要求 `start_maintenance`，也不執行；失敗與中止不得重送。
- 593 個 app 來源、反向 patch 恢復官方 506 個原檔、原 foundation 3 項通過。
- CPU 1／3 GiB／swap 0 隔離序列建置；精確 image 來源一致、223 瀏覽器產物通過。
- 精確映像內 14 個 SDK 檢查通過，network none、無 host HOME／session mounts；builder 已停止。
- 3 個限定 LSP 路徑沒有回報 error，但全為 inconclusive，不是全專案 clean。

本案 Agent 已切換至 image `sha256:779d9c404b0c4ef9c28aff0b28a9c288e12c285b11e26a948c7a957176cae4b7`。Core、MFE、來源權限、查詢／ingestion 設定、模型及預算不改。未 commit／push。

## 保存與恢復

部署前後兩 HOME／41 journals byte-exact。探測後，40 journals byte-exact；只有原對話增加兩個診斷 custom entries，所有舊 bytes prefix 不變。原 138 則模型對話內容未改寫。

獨立唯讀核對原 CONFIRMED v325、全 142 項及 planDigest 均不變；114 VERIFIED／22 OBSERVATION_CHANGED／6 GAP 保留。一次真人確認及 114 成功發布仍已消耗，不能重播。

驗收瀏覽器的舊認證另行到期，造成部署前 iframe timeout；唯讀確認 `/authenticate` 303 回登入頁。使用者親自在專用視窗登入後，核身分並保存新的私有狀態，視窗已關閉。這只是恢復驗收通道，不是工具問題的修復。帳密及 cookies 未輸出。

## Windows Edge 部署版本已另行核對

使用者提供同一入口並允許 browser automation 後，已用實際 Windows Edge 的新測試 profile 核對初次與 reload：DOM build ID、21 種實際載入資源的 SHA，以及原對話的啟用工具均符合本次部署；兩 HOME／41 journals 不變。這不是 Linux Chromium 代測，但仍不代表使用者原有 Edge 分頁快取已核對，也不是模型恢復。本輪沒有新增模型請求。詳見 [Windows Edge 版本核對](datahub-agent-windows-edge-version-20261008.md)。

## 尚缺證據

使用者已有實際 Semantic 工具呼叫後，短上下文對照不再是目前主線的前置。歷史探測中長上下文與模型服務處理的差異仍未完全區分，但不因此追加探測或重送原操作。下一主線是依已啟用的來源限定能力，提出有據方案、真人整批確認、原生執行與讀回，再驗證真正變更輪次；本次設定批准沒有派送新的模型請求或維護。

完整語義維護品質、Tag／Property 適用、歷史 UNKNOWN 精確定位及真正變更第二輪仍未完成。

私有證據：`.local/evidence/semantic-autonomous-plan-20261005-ScQzQE/model-tool-probe-deploy-20261007-pf1c1xfs/` 的 `CHECKPOINT.md`、`validation-final.json`、`model-probe-result-private.json`、原生／對話讀回及 journal 保存證據。失敗 caller 與認證紀錄保留；沒有重跑成功建置或已消耗探測補證。

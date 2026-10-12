# 語義維護輸入與續作修正：本地驗證（2026-10-07）

## 結果與界線

已依使用者「依此方案修正」完成本地 SDK／Host 契約及 driver 分類修正。沒有部署、r17、新模型提示、真原生修訂、真人確認或語義發布。r16 的 3 筆錯誤定位與未知歷史沒有被改寫；最後已觀測的原計畫仍是 DRAFT315／141 active／157 recorded，非本輪 fresh read。

## 工作行為

- GAP schema 分成互斥分支：一般缺口只有 code／reason；UNRESOLVED_OPERATION 必須有原 operation，不能與候選／定義混用。SDK 派送前指出欄位問題，不自動刪欄位、改 code 或填答案。
- 固定 SDK 0.85.1 在 tool_execution_start、執行前驗證同一公開 schema，涵蓋不會進 execute 的 union 拒絕。只將該精確未派送 call 留給模型更正，沒有核心修改。
- Host 的純輸入驗證邊界發出 typed `MaintenanceInputRejection`；gateway 只傳此型別的 `inputRejection`，不信任任意 error 附加欄位。收據綁 action／requestId／Root／完整語義請求 digest，明示 INPUT_VALIDATION、nativeWriteStarted=false、NEW_INTENT_ONLY。父頁後加的 uiRequestId 不納入語義 digest，其餘欄位仍完整綁定。
- SDK 與 `tests/semantic-maintenance-driver-response.mjs` 共用判斷。確定寫入前拒絕可讓模型產生**新意圖**，retryAllowed 仍為 false；沒有 SDK／driver 自動 replay。HTTP400、錯誤名稱、無 reconciliation 不能推論零效果；不符證據、ACL／CAS 或失 ACK 仍停止同一提示。
- `read_operation_history` 先經實際 Host inspect_asset 核目前 Source／asset／field 可見性，再只投影目前 session active branch 的既有 intent。20筆／頁，後頁帶同 historyDigest。保存原 action／Root／已知 ID、原 journal reference；缺 ID 省略。舊 journal 未記 fieldPath 時明示 fieldLocatorRecorded=false。effect=NOT_PROVEN，空結果是定位覆蓋缺口，不是零效果或重播授權。
- 此定位讀取**不涵蓋其他 session／分支**，不遍歷任意檔案，不恢復前景權限或 consent；尚不能宣稱已找回全部真實歷史 UNKNOWN 定位。已知定位不符者在 SDK 派送前拒絕；模型仍負責選擇原操作與提出正確方案。
- 沿既有 revise_maintenance，在同 Root 以精確版本／item／digest 追加替代 DEFERRED，保留舊錯誤觀測與全部 native history；未新增 store、controller、資產特判或 Core patch。

## 可重跑證據

私有證據：`.local/evidence/semantic-input-correction-local-20261007-cOfEdN/`。

| 接縫 | 結果 |
| --- | --- |
| SDK → actual Host → synthetic API、gateway HTTP、真 MFE bridge、native/Catalog/ACL/CAS/readback | 123/123 PASS |
| 固定 SDK 0.85.1 真 prompt／schema／tool／foreground／RPC，僅離線合成 provider | 81/81 PASS |
| TypeScript noEmit、targeted ESLint | PASS |
| reviewed downstream 590 files → reverse exact upstream 506 files，原3檢查 | PASS |

重點案例：模型收到 union 格式錯後自行提交新輸入並在同一提示 READY；Host 格式拒絕後新 requestId 保存一次；缺／錯 Root、requestId、digest、phase 或矛盾 reconciliation 仍停止；真 fixture record write 後失 ACK 不續作；歷史原定位及分頁保留、缺 ID 不捏造、撤權不洩露定位；既存錯 Root 的 DEFERRED 可追加修訂，原紀錄不改。

```bash
node --test tests/test_agent_semantic_input_correction.mjs tests/test_agent_semantic_input_rejection_http.mjs tests/test_agent_semantic_operation_history.mjs
(cd extensions/datahub-agent/pi-web && node --test lib/semantic-*.test.mjs lib/rpc-manager-extension-ui.test.mjs lib/rpc-manager.test.mjs)
(cd extensions/datahub-agent/pi-web && node_modules/.bin/tsc --noEmit)
.venv/bin/python scripts/check-agent-downstream.py
```

保留初始 RED、fixture cookie／事件生命週期錯誤、用錯 system Python 與 TS import extension 的失敗，再修 caller／本次 source 後驗證。三份舊 SDK caller 原本把 bare Host error 當可直接 throw，已按新 fail-closed 收據／abort 行為更新，沒有放寬 drift guard。

額外含 rpc-manager-shutdown 的101項檢查曾有4失敗：3為上述本次回應契約變更，已修正；另1是未修改的既有 idle/Stop mock 缺 clearQueue，保留報告，不修改無關 mock／runtime。非全套 clean 宣稱。LSP scoped probe 有 AST 警告、2項未確認，TypeScript／targeted lint 雖通過仍不宣稱 workspace 無診斷。

## 下一步

另取得部署與一則 bounded 原 SID／Root／high 準備提示授權，先核 fresh identity、idle、版本及歷史保留，再使用新 driver 分類；舊 r16 與成功 ACK 不重播。真歷史 locator 品質、完整有用方案 → 一次真人整批確認 → 原生發布／UI → 真變更後第二輪，仍未完成。

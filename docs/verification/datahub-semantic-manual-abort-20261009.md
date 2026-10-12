# 手動語義測試中止：原因與本地修正

2026-10-09。使用者回報 `Error: This operation was aborted`。**已定位 owning-layer 問題，依「放開不需要的卡控」補齊可更正輸入責任邊界，修正已獲准部署且 Windows 真入口只讀驗證通過；沒有重送手動操作。**

## 原始執行，不是未開始

完整 active branch 43 messages、無剩餘頁，來自本次手動對話 `01a11f53-b262-70c8-afbf-6ad837302aa3`：

1. 06:22:21Z 開始，`list_sources`、七資產 schema 及 vocabulary 讀取成功。
2. `start_maintenance` 保存新 Root `37a90daf-ae17-4429-b25e-a287f7cab663`；這是使用者手動測試建立，不是本輪另建 Root。
3. 前四次 Term 準備均帶九筆已回傳證據，Host 回 typed `INPUT_VALIDATION`／`semantic_invalid_definition`；模型同輪更正後仍受同一隱藏計數限制。
4. 06:23:29Z 保存 Domain item `5968fa53-092c-4318-bcc3-d61e648534c6`，Root 到 v3。
5. 下一次 Term 提案把該 **Domain** item 放入 `parentUrn`。Term 的原生父節點須是 Glossary Group（`node`），不能是 Domain。Host 回 `semantic_maintenance_definition_reference_invalid`，卻沒有純輸入拒絕 proof。
6. SDK 將這個 bare 寫入錯誤視為效果不確定，保存 unconfirmed locator、呼叫公開 `ctx.abort()`；06:23:33Z assistant error 成為 `This operation was aborted`。不是依錯誤字串推測來源 timeout、provider 故障或使用者按 Stop。

另有 MCP `invalid_token` 401 啟動日誌；該輪實際語義呼叫走 native Host，仍成功完成盤點／Root／Domain 保存。不能將 MCP token 問題冒稱本次中止原因；未讀取或旋轉憑證。

## 原生獨立讀回

- 本次 Root：**DRAFT v3／一項 Domain PENDING／七資產未帳平**；完整保存 Review 可讀。
- 被拒 `3df57b56-65fc-4fc5-bb9d-fe5ed3c0c826` child：目前 `task_record_not_found`。absence 不證明歷史零效果，未回填新 proof，不可原樣重送。
- 舊 Root `56db64c0-0da2-4b38-a0e9-aadf8ef3d572`：仍 **DRAFT v11／五項 PENDING／七資產未帳平**；原對話仍 127 messages。
- 本轮只讀既有對話／Root／Review，未觸發模型、準備、封存、批准或發布；owned 瀏覽器已關閉。

## 本地修正

- 去掉 Catalog definition／candidate 的隱藏八筆證據上限，以及 SDK 的證據 array 計數限制。保留所有選定回傳證據；既有 24KB request、identifier 型別／長度、證據存在性／快照與原生 Review 容量限制仍保留。不偷偷删掉第九筆。
- `prepare` 的引用 resolver 只對**已讀回、完整、未消耗的 active 同 Root 定義**之類型不合，以及純引用 shape／缺 input version，發出精確 request-bound `MaintenanceInputRejection`。發生在任何新 child 寫入之前。
- 引用不在目前 active 定義集合（未知／foreign／observation／superseded）仍拒絕，不讀取另一個 Root、不跟隨替代項、不猜 URI；現在回純定位輸入拒絕，允許模型明確選擇新的合法輸入。
- 已嘗試發布／關閉或效果不確定的 child、ACL、scope、Root CAS、I/O、失 ACK 仍拒絕且不給更正豁免；沒有一般 catch 包住 preparation。
- 經 ACL／快照核對後，錯誤 evidenceId／fieldPath／Property 對象型別、值型別、基數或允許值等提案錯誤，由顯式 `rejectInput` callback 回寫入前 proof，不再中止全部準備。immutable／不支援 Property 條件仍不准套用，但可改合法提案或精確 GAP；native 資料損壞與 I/O 不進此 callback。callback 若不 throw，原驗證仍會拒絕，不能繞過條件。
- 工具契約與同輪更正訊息明列：Domain parent→Domain；Group／Term parent→Glossary Group (`node`)；關聯 reference 須匹配 candidate.kind。Host 不把 Domain 改名為 Group、不刪 parent，也不替模型重設業務階層。

## 檢查

`tests/test_agent_semantic_input_correction.mjs` 新增三個回歸，先 RED、後 GREEN：

- 九筆真 fixture 回傳證據：Term 及 Dataset proposal 的完整 Review 保留全部九筆，不中止。
- 同 Root Domain→錯誤 Term parent：typed 更正、native writes 0、abort 0；再由測試明確提出新的 Group＋合法 Term，保留原 Domain，不覆寫或重做。
- 七類輸入錯誤（evidence、field、基數、值型別、allowedValue、entityType、未知 item）逐一拒絕但不取消；新的合法輸入成功保存，沒有刪除意圖、自動重送或 native target 寫入。

**399／399** semantic Host／SDK／HTTP／fixture browser 回歸、TypeScript、SDK ESLint 通過。既有 reference 安全負例仍測 ACL／scope／版本／跨 Root／supersession；只更新純輸入錯誤的 typed receipt 斷言。

Downstream：593 檔，只有 SDK 一檔新增變化；reverse patch 精確還原官方 506 檔，原三項 baseline checks 通過。四來源 fresh LSP 無回報 error，但全部 inconclusive，**不宣稱 clean**。

原始 RED、舊測試期待 raw error code 的回歸失敗及更正後紀錄均保留。所有 fixture 為合成資料、空白 HOME、移除憑證環境；不是實際新 Root 已恢復或完整代管成功。

## 核准部署與只讀驗證

使用者明確選擇「部署修正＋只讀驗證」。2026-10-09 **07:22:02Z** 正常退休舊 Host `3356089`，保留 HOME／全部歷史，啟動 **PID `84631`**。

- Config：`.local/agent-server-semantic-input-boundary-repair-20261009-EOvx4Y.json`，SHA `d391c2535e6b212af8cd50a17ed293da379bbb1fa341d4417e514894f263f13a`。
- Image：`sha256:9662cfae9499da48c90207a0228d8f328ad3fd16516edb3d39bd51dba2caa3cf`；runtime `dha-ekop-agent-local-f10dc723-945d-4326-bf67-8c9b694f219e`。
- 與上版凍結差異只有三個 Host 模組＋downstream patch／lock，593 app 檔只有 SDK 一檔；MFE、Core、Source caps、query／ingestion、模型／thinking／工具選擇／預算未變。設定只切 `runtimeImageId`／`browserAssetsDirectory`。
- credential-free 隔離 serial Docker build：CPU1／RAM3GiB／swap0，實際 cgroup 核對、完成停 builder；無 checkout `next build`。
- exact image：593 source 全對；223 exported assets 一致；**109／109** Host／actual SDK／HTTP／lifecycle 合成檢查通過。
- Windows Node／installed Edge sandbox／fresh owned context 真入口 `http://localhost:9002/mfe/agent` 可讀；四個既有 SID 的 model／thinking／工具選擇未變，Semantic schema 與 exact image descriptor 相同、證據 array 無舊 maxItems，新父節點說明可見；18 browser static assets SHA／200 全對。
- fresh preswitch Actor／完整 Roots＋Reviews／全部 runtime idle／43 journal 核對後才切換。部署後**手動 v3 一項 Domain、舊 v11 五项完整 Root／scope／Review**逐值相同（僅忽略 top-level READ requestId）；AdventureWorks 完整142項／digest逐值相同。
- **兩 HOME volume／43 journal SHA、size、mtime 完全相同**；model prompt 0、native metadata write 0、approve／publish 0。所有 owned 檢查 browsers 關閉；使用者與 ordinary observer 不動。
- 保留 tracking POST 被測試攔截及一個 `Failed to fetch` pageerror，不宣稱零 browser errors或舊 tab cache 已清除。真入口／指定 API／新工具 descriptor／assets 驗證通過，不是實際 post-fix 真模型準備驗收。

## 下一步與證據

請重新整理 Agent 頁面載入新資產。**沒有自動重跑手動測試**。後續若準備，須新明確意圖、同原手動 SID／Root，保留已保存 Domain，先核目前狀態與 original unconfirmed locator；不另建 Root／重送成功項或拒絕 request。舊五項及所有历史 UNKNOWN 不動。發布仍須可信父頁整批真人確認。

部署私有證據：`.local/evidence/semantic-autonomous-plan-20261005-ScQzQE/semantic-input-boundary-repair-deploy-20261009-EOvx4Y/` 的 `authority.json`、`operator-source.json`／`delta.json`、immutable `candidate/`、`image-source-proof.json`、`artifact-gate.json`、`image-sdk-final.log`、before／preswitch／after native full views、`sessions-*-private.json`、`launch.json`、`validation.json`／`CHECKPOINT.md`。build／stage／deploy-intent one-shots 已消耗，不重跑。登入沿用 owner-confirmed private storage，不輸出或上傳。

私有證據：`.local/evidence/semantic-autonomous-plan-20261005-ScQzQE/semantic-manual-abort-diagnosis-20261009-uu745U/`：`manual-session-full-private.json`、`recent-semantic-private.json`、`captured-prepare-calls-private.json`、`manual-native-readonly-private.json`、`abort-input-{red,green}.log`、`regression-final.log`、`typecheck.log`、`lint.log`、downstream logs、`CHECKPOINT.md`。不公開登入狀態、原始公司內容或私有輸入。

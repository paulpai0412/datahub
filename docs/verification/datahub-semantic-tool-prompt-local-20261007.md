# 語義工具已啟用但模型聲稱不可用 — 本地修正

2026-10-07。本報告保留本地階段證據；後續已獲授權部署並核對原對話runtime宣告一致，見[部署與讀回](datahub-semantic-tool-prompt-live-20261007.md)。沒有真模型維護測試，不能宣稱完整語義維護已恢復。下文未部署為當時狀態。

## 現場觀察

使用者已選Semantic governance。公開API讀回其對話：`datahub_semantic`及`datahub_catalog`均active，但模型系統提示詞的「Available tools」只有Catalog。可見尾端只有Catalog查詢成功及模型兩次自行回覆沒有語義工具，沒有semantic工具呼叫。這不是已觀察到的Host權限拒絕，也不是需再選一次preset。

固定SDK0.85.1的公開ToolDefinition契約明定：未提供`promptSnippet`的custom tool不會出現在Available tools。本案Semantic插件缺該欄位，造成實際啟用集合與文字宣告不一致。這個缺漏已確定；真模型恢復仍待新版驗證，不把推論當唯一因果。

## 修改及證據

- `extensions/datahub-agent/pi-web/lib/datahub-semantic-extension.ts`：只補promptSnippet及active-only guidelines，說明語義盤點／完整方案準備及真人確認界線。沒有改工具schema、execute、Host ACL、原生寫入、UNKNOWN或批准流程。
- `tests/test_agent_semantic_tool_prompt.mjs`：實際插件factory＋實際固定SDK，credential-free temp HOME／in-memory session，零模型／Host請求。舊碼真RED（active兩工具、prompt漏Semantic）；新碼2/2 PASS，涵蓋reload及inactive不宣告。
- 既有SDK policy8/8、TS、限定lint通過。592 app來源、reverse官方506及原3foundation checks通過。兩檔LSP沒有診斷，但均inconclusive，不宣稱clean。
- 原有未提交修改保留；只一份app source變更，downstream patch／lock同步，上游DataHub及Pi SDK不改。

本地私有證據：`.local/evidence/semantic-autonomous-plan-20261005-ScQzQE/pi-web-review-ui-deploy-20261007-qr29_83z/edge-semantic-tools-diagnosis-wy946ymd/`，包含CHECKPOINT、現場state／tools／歷史、before、真RED／GREEN、owned diff及validation-local。ESM import、錯用Python及report行數caller失敗亦保留。

## 未完成與下一步

現用Agent仍是舊映像。需另獲本案Agent runtime更新授權；更新前核正在進行的工作，保留session／HOME／歷史／原模型和權限，不修改Core或MFE。更新後先只讀核對該對話的prompt及active工具一致，**不自動重送模型提示或語義維護**；由使用者在Edge發起新意圖。原先114項成功發布與一次真人確認保持消耗，不可重播。

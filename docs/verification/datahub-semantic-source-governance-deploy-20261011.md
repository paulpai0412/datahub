# Source 治理部署與真入口只讀驗證

> 後續狀態：同日完成 [中文維護中止修正部署](datahub-semantic-sales-zh-abort-20261011.md)。現行 Host 為 `2252529`；下文 `2118164` 已退休，屬本次部署的歷史證據。映像、設定與 MFE 不變。新的使用者草稿已只讀觀察到保存 `focus=all`，但真模型業務品質及 changed-round 尚未驗收。

日期：2026-10-11  
結果：**已部署；新映像檢查及 Windows Edge 真入口只讀驗證通過。**

使用者批准「請佈置,再自己測試驗證」。本次部署 Source／資產與類別縮小、完整詞彙階層的 Host／SDK／MFE 修改。沒有建立真新計畫、呼叫真模型、搬移詞彙或代替真人發布。真模型的業務分組判斷與真實後續維護輪次仍未驗收。

## 使用方式

重新整理整個 `http://localhost:9002/mfe/agent` 頁面，載入新 Runtime／MFE。

下一輪維護意圖可指定 Source，並要求全部語義、Source 內單一資產，或只維護 Glossary／Tag／Table／Field。Agent 用 `start_maintenance` 的 `assetUrns`／`focus` 表達縮小；Host 保存範圍，後續 Prompt 不可放大。Table／Field 可包含必要的共用定義。

新計畫的父頁核對介面會顯示保存的 Source／類別及完整詞彙歸屬。技術階層有效不是業務適用證明，Agent 與真人仍須核對完整路徑和描述。舊計畫保留原契約，沒有追寫 focus 或重新取得 consent。本次也未把已發布詞彙搬到新群組。

契約與本地驗證見 [本地紀錄](datahub-semantic-source-governance-local-20261011.md)。

## 部署

- 切換時間：`2026-10-11T00:46:42.158797Z`。
- Host PID：`2118164`；舊 `426856` 正常 graceful shutdown，不再重啟。
- Runtime：`dha-ekop-agent-local-61f41558-8bd5-4715-b98f-497b7e3b6133`。
- Image：`sha256:28724d6d2d5b23b297faa5a213b6cff916ea50073944d3972091355ad7a53ac0`。
- Config SHA-256：`8a31769d786f1c4e2c503f7a35701051320c85d1b9e915aab19d2ec80b62c9a2`。
- MFE `89.js` SHA-256：`2758b154516fedcbfd060e0914f3e4289fc493a99e799abd69f1a7315869d35d`；`remoteEntry.js` 不變。

新 config 只改 `runtimeImageId`、`browserAssetsDirectory`。Source／SQL／Grafana／模型／工具／預算及其他值與舊 config 精確相同。Core／其他 Compose 服務的八個 container ID、映像與啟動狀態未變，沒有修改 Core 或 Model。

用隔離 build context 與既有固定相依層建置。實際 cgroup 為 CPU 1、RAM 3 GiB、swap 0；只一個 Next build worker，沒有在 checkout 執行 Next build。建置器已停止。原 dependency-expression webpack warning 保留，建置成功。

## 已驗證

| 邊界 | 證據 |
| --- | --- |
| 新映像 | 593 Pi Web 原始檔與 lock 逐一吻合；223 個 browser export 與映像吻合 |
| 新映像實際 SDK→合成 Host／API | 167 PASS：Source／focus 保存及類別限制、單資產共用影響、完整階層、同名不同 parent、祖先缺失停止、ACL／CAS／原提案相容性 |
| 真 Windows Edge／Node／既有 Playwright | 從 `/mfe/agent` 登入身分及 Runtime origin 成功；18 個實際下載的 Runtime 資源 hash 與新映像相同 |
| 實際 SDK 工具 | `get_tools` 回傳新 focus 與不可放大範圍指引；沒有模型請求 |
| 真 native vocabulary | 六個已發布 Term 都由目前 Source／資產 ACL 入口讀回完整三層名稱、描述、URN、版本；原 Term 值、parent、版本與 bounded impact 不變 |
| Source 負例 | 指定 Sales Source、引用既有 AdventureWorks 資產的只讀定義請求，被 `semantic_asset_outside_scope` 拒絕，無定義內容回傳 |
| 真父頁＋整頁刷新 | 兩輪都是 CONFIRMED v29／13 項，82 次語義只讀 HTTP200；完整 fieldsets 與差異顯示，沒有點 ack／confirm |
| 原生保存 | 五份完整計畫 manifests、四份 Sales scope／unprepared 及 24 份可讀完整 Review／歷史一致；另兩份原先相依漂移拒絕亦維持原值 |
| Pi HOME | 兩個原 volume、45 份 journals 的 SHA／size／mtime 精確相同 |

載入結果：第一份已驗差異約 5.3／4.5 秒出現；讀齊13項約 59.3／52.6 秒。載入期間沒有 checkbox／ack，確認 disabled。這是目前已發布計畫的實測時間，不宣稱載入延遲已消失；先前 READY v28 的時間不能當本次 CONFIRMED v29 的等條件比較。

Source 新計畫保存 focus 及完整 hierarchy 的確認介面，沿本地 390／1440 合成檢查及新映像測試核對；沒有建立真新 Root 冒充 native 新計畫驗收。所有 owned browser contexts 均 finally close，未關閉使用者原視窗。

## 保留的拒絕與限制

部署前第一輪完整 Review reader 遇到 HTTP409 `semantic_maintenance_dependency_changed`，reader 將其呈為 `semantic_review_detail_unconfirmed`。當時尚未切換。後續盤點保存精確拒絕，發現共兩份舊草稿 Review 有此現況；部署後仍一致，不修改提案、不放寬相依核對、不重送準備。

兩輪 UI 的 tracking POST 被只讀 harness 阻擋，並各有 `Failed to fetch`。原錯誤保留；不是零瀏覽器錯誤宣稱。未修無關 whitespace、未把原 LSP inconclusive 當 clean。

這次不證明真模型一定選對 Source 專屬或中立群組，不完成全來源語義品質或真實 changed-round，也沒有原生建立／搬移／發布 consent。這些仍是後續獨立意圖與驗收，不能重播已消耗的提示、操作或 UNKNOWN。

## 證據與回復

私有證據：`.local/evidence/semantic-source-governance-deploy-20261011-oiYpPD/`。

`validation.json`：`DEPLOYED_SOURCE_GOVERNANCE_READONLY_ENTRYPOINT_VERIFIED`。完整 before／preswitch／after、read-only allowlist、拒絕、建置、cgroup、source／asset hashes、清理收據均保留。

回復候選為先前 `53b6…` image、原 `d313…` config 及本次 `mfe-before/`。回復仍須新的操作批准、fresh idle／actor／資料 pins；不得直接重啟退休 PID 或重跑已消耗的部署 helper。沒有 migration、歷史刪除、commit 或 push。

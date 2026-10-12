# Source 為治理邊界：本地實作與驗證

日期：2026-10-11  
狀態：**本地修改及合成驗證完成；此為部署前切片，未驗證真模型的分組判斷。**

後續已另獲批准部署；現行狀態與真入口證據見 [部署驗證](datahub-semantic-source-governance-deploy-20261011.md)。本文件保留原本地階段的範圍及結果。

## 行為

使用者指定 DataSource，由 Agent 查看目前已授權 Source Catalog 資產並維護語義。Prompt 可縮小至單一資產或類別，不能把 Source 外資產納入。

`start_maintenance` 新增可選 `focus`，預設 `all`：

| focus | 本輪可提出的變更 |
| --- | --- |
| `all` | 選定 Source／資產範圍的完整語義方案 |
| `glossary` | Group／Term 定義及詞彙關聯 |
| `tag` | Tag 定義及標籤關聯 |
| `table` | Dataset 層級候選，可包含必要的共用定義 |
| `field` | 精確欄位層級候選，可包含必要的共用定義 |

`assetUrns` 只縮小 Source Catalog 範圍。Table／Field 預設只選 Source 內 Dataset；明確選入非 Dataset 則拒絕。資產名稱與搜尋關鍵字不是成員資格。

新 Root 把類別保存到既有原生 Task instructions，Receipt／Review 帶 `governance`。準備與修訂核保存的類別；不符者在 child 寫入前回原完整請求綁定的 `semantic_maintenance_focus_mismatch` proof，由模型產生新完整輸入，不自動修補／重播。已知共用定義引用也核本輪資產子集，不能以同 Source 全範圍資格更新未選資產的共用定義。

## 詞彙歸屬

- Catalog 搜尋／定義盤點提供 `hierarchy`：由根到目前定義的名稱、描述、URN、版本。成功 API 精確空陣列若缺的是原生祖先，回 `semantic_definition_ancestor_not_found`，SDK 中止同一提示／工具批次；不是可更正的直接 URN 輸入。祖先 ACL／transport／循環亦不轉成可更正輸入。
- 新 Root 的提案及套用凍結完整階層與引用版本；確認介面顯示 Source／治理類別及完整歸屬路徑、祖先描述。
- 不同 parent 的同名 Glossary Group／Term 列為 `sameNameOtherHierarchy`，不強迫重用；同 parent 同名衝突仍拒絕未解決建立。
- Agent 指引要求依本 Source 治理目標、完整路徑與證據解釋 parent。上游 lineage 或同名不能自動繼承另一 Source 的專屬階層；真正中立共用定義仍可有據重用。
- **Host 沒有依名稱推論業務分類，也沒有自動 reparent。** 路徑可見、技術核對通過，不等於業務範圍已驗證。本次沒有呼叫真模型，因此不宣稱已證明未來所有分組判斷正確。

完整 Source 成員／成功 ingestion 的宣稱仍依既有證據。Catalog 子集不冒充最新完整成功掃描，沒有擴大 Source 政策、重跑 ingestion 或新增授權名單。

## 驗證

均使用既有工具、假憑證／合成 public API、隔離 HOME；沒有生產 API、真模型或真來源查詢。瀏覽器僅接 owned loopback server，使用已安裝 Playwright／Chromium。

| 檢查 | 結果 |
| --- | --- |
| Semantic 回歸，含 Source／focus、SDK→Host、權限／CAS／UNKNOWN／歷史 | 381 PASS |
| 新 Source 專項 | 7 PASS；涵蓋預設／縮小、錯類別新輸入更正、完整階層、祖先 ACL／缺失／循環、同名不同階層、窄範圍共用影響、legacy digest／父頁漂移 |
| 真父頁 MFE，390／1440 viewport | Source／類別／完整路徑／祖先描述可見；HTML literal 為文字；無橫向 overflow；未勾 ack 不可發布；fixture journal 不變 |
| 既有 progressive loading 父頁回歸 | 390／1440、final-version drift、close cancel 四情境 PASS，無提前 consent／fixture 寫入 |
| Pi Web TypeScript、SDK lint | PASS |
| MFE production webpack，私有 candidate 目錄 | PASS；未覆蓋 served dist |
| 下游版本鎖及反向 patch | 593 source files 精確還原官方 506-file baseline；原三項 foundation checks PASS |
| Scoped LSP | 八檔皆 INCONCLUSIVE；不宣稱 clean |
| UI mechanical detector | `[]`；不等於完整無障礙驗收 |

可重跑入口：`tests/test_agent_semantic_source_governance.mjs`、`tests/test_agent_semantic_maintenance_scope_sdk.mjs`、`tests/check_agent_semantic_source_governance_browser.mjs`、`tests/check_agent_semantic_maintenance_loading_browser.mjs`。版本鎖檢查沿既有 `.venv/bin/python scripts/check-agent-downstream.py`；原生完整 semantic 回歸用 `node --test --test-concurrency=1 tests/test_agent_semantic*.mjs`，隔離 HOME 時保留已安裝瀏覽器的 `PLAYWRIGHT_BROWSERS_PATH`。

## 相容性與失敗保存

- 舊 Task 沒有 focus marker 時保留原行為；不追寫 governance，不重新編譯成新提案或移轉 consent。Legacy compiled Review 的原 digest 回歸通過。
- 最初新 governance 未列入 publication review 嚴格 schema、JSON key 順序比較問題已修正；原失敗 logs 保留。
- 回歸 caller 的裸 TS import／缺少官方 SDK sessionManager mock，改用既有 Jiti 與完整 mock；沒有放寬產品 import、Scope 或 ACK 檢查。
- 隔離 HOME 缺少瀏覽器路徑、ESLint 錯 cwd、system Python 缺 DataHub SDK 的 caller 失敗保留；改用已安裝瀏覽器、原設定 cwd、既有 `.venv` 後檢查通過，沒有安裝新能力。
- 全工作樹 `git diff --check` 仍指出既有 AppShell／生成 patch 的 trailing whitespace。本次不清理無關 WIP；版本鎖核對其他 Pi Web source bytes 未變。

## 未包含

沒有部署／重啟、真模型準備、Source grant／設定變更、原生建群組／搬移詞彙／發布、舊提示重送、Core patch、新 datastore、commit 或 push。既有 Root、已發布詞彙 URN／資產關聯／歷史保持原狀。

本地證據：`.local/evidence/semantic-source-governance-local-20261011-rJyb1h/`。真正的部署、新 Root 真入口與真模型語義品質、已發布詞彙的精確歸屬修正，均是獨立後續操作，未用本次合成檢查取代。

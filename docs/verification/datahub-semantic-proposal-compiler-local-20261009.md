# 語義提案：移除非必要 guard、由 Host 編譯原生操作

日期：2026-10-09。本篇保留本地驗證階段的證據。**後續已獲批准部署並完成真入口只讀核對**，見[部署驗證](datahub-semantic-proposal-compiler-deploy-20261009.md)；未執行新的真模型提示或真實 metadata 寫入。下述「未部署」敘述是本地驗證當時狀態。

## 已改變的使用行為

Agent 提供完整業務提案；Host 沿既有公開 API 取得技術上下文，保存完整 before／after，並編譯原生操作。不是只刪掉拒絕條件取得假成功。

| 原限制 | 新行為 |
| --- | --- |
| 共用定義不能帶 fieldPath | 保留精確欄位證據 anchor，綁已盤點的資產 schema；不另要求模型讀欄位 Property 快照 |
| 欄位 Property 必須等於根 fieldPath，且逐欄拆項 | 同一提案可包含 Dataset 與多欄位 Property；Host 核每個欄位 ACL／身分、讀原值／版本，按原生目標 Aspect 編譯 |
| SDK 每個 kind＋fieldPath 只准一個 candidate | 可提出不同關聯成員的多筆 add／remove，以及同欄位多個不同 Property；不丟失候選 |
| 讀完全部欄位分頁之前一律禁止準備 | 可先保存已有證據支持的項目；Agent 仍負責在封存前盤點完整適用範圍 |
| Catalog 純語法錯誤到 Host 後終止整輪 | 只在純 parser 邊界發送綁完整原請求的 typed 寫入前拒絕，附 issue；模型可在同輪提出新的合法輸入 |

同一 scalar 的競爭答案、同成員重複操作、競爭的集合 set 仍是業務意圖衝突。Host 不猜答案、不偷偷刪欄位或換證據。集合 set 仍須明列完整保留值；add／remove 僅改指定成員。

## 必要保障

- 原身分／ACL、Source 選定範圍、證據快照、精確原生欄位定位與並發 CAS 保留。
- Host 新取得的欄位上下文不是替換 Agent 的來源證據；完整原值／版本保存於既有原生 Review，發布前重新編譯並核對 planDigest。
- 對額外欄位的原生版本亦做 drift／未選 Aspect 核對；不能只核 Dataset 快照。
- 未選 metadata、人工註記、來源 schema 保留。明列的人工作品替換仍須精確整批真人確認。
- UNKNOWN、失 ACK、撤權與 CAS 失敗沒有更正豁免；不自動重送。typed proof 只證明該次純輸入拒絕，不追認舊操作零效果。
- 可信父頁一次整批確認、原 publisher 與歷史保留。沒有新 datastore、Core patch、排程、AUTO、來源 grant 或模型／預算變更。
- 原傳輸與原生 Review 容量限制未改；本次不是無限大小提案或原子跨 Aspect 交易。

## 實際驗證

既有 `tests/test_agent_semantic_*.mjs` 及 Pi Web `semantic-*.test.mjs`：**396／396 通過**。使用空白 HOME、移除憑證環境及合成 DataHub API；沒有真模型或部署服務連線。

新增／改寫的整合案例位於 `tests/test_agent_semantic_input_correction.mjs`：

- 精確欄位證據定義，不另做欄位 Property inspection。
- Dataset＋多欄位 Property 單項準備 → READY → 一次整批確認 → 原生目標發布／讀回；無確認不能發布，成功不能重送。
- 同 Root 已存五類定義、v11／5項草稿 → 七 Dataset 完整套用方案；原五項 ID 保留，依賴建立及套用成功。
- 改變合成來源的欄位說明與 schema 版本，再進第二輪：一项更新、六項 KEEP，原計畫／證據歷史不變。
- 多個不同 Property／不同關聯成員、純語法錯誤同輪更正；Review 展示同 Aspect 合併後的完整最終集合，不把各項局部 after 當最終結果。
- 額外欄位版本漂移，即使 Dataset digest 未變也拒絕；人工未選內容保留、欄位 ACL／身分、來源快照與失 ACK 防護。

既有合成 React → MFE 父頁 → Host browser 案例亦通過（390／1440、成功／停止／失 ACK）。使用既有安裝的 Chromium、全新 fixture context、僅兩個自有 loopback server。**不是 Windows Edge／實際 `/mfe/agent` 驗收。**

其他證據：

- TypeScript `tsc --noEmit --incremental false`、SDK targeted ESLint 通過。
- 593 個 downstream 檔案核對；只有 SDK、兩個 SDK tests、runtime skill 共四路徑變更；reverse patch 還原官方 506 檔及原始三個 baseline checks 通過。
- 對保留的已部署 compiler 做七個既有合法輸入向量比較：完整 Review（含 digest）逐值相同。未修改既存 native Review。
- 五個變更來源的 fresh LSP 無回報 diagnostic，但全部 **inconclusive**；不宣稱全 workspace 或這五檔 LSP clean。

本地證據：`.local/evidence/semantic-proposal-compiler-local-20261009-8y756O/`；最終 `validation.json`、`regression-complete-after-pass.log` 及 `frozen-review-compatibility-final.log`。保留初始 RED、fixture 單一 batch 假設、Node／jiti caller、空 HOME browser cache 及缺少公開 SDK ABI stub 的失敗；只修測試 caller／fixture，不為取得 GREEN 放寬產品保障。

## 未完成的真實主線

本地成功不能推定 Sales 已 READY。最近獨立真實讀回仍為原 Sales Root `56db64c0-0da2-4b38-a0e9-aadf8ef3d572`：DRAFT v11、五項 PENDING 定義、七個資產尚未帳平；本輪沒有重新讀取或寫入該 Root。

本次沒有部署／build／新模型提示／原操作重送／代批或發布。現有部署仍是先前映像，未取得本次 Host compiler 與 SDK 行為。後續需明確批准必要的 Agent 部署，以及同原 SID／Root 一次新的準備意圖；保留已存五項，不另 start、不重送原 0fe／f0d／c547 或成功項。READY 後仍需可信父頁真人確認。

真實完整方案品質、原生完整 Aspect／歷史／Catalog UI 及真正來源變更第二輪保持 OPEN。AdventureWorks 已成功的 114 次發布與 UNKNOWN 歷史不重播。

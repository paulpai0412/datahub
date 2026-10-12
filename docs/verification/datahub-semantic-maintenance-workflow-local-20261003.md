# 流程優先語義維護：本地實作紀錄

日期：2026-10-03；本案新建定義更新邊界於2026-10-04真人確認後補齊。依據：[流程優先設計](../design/datahub-semantic-maintenance-workflow-first.md)。

**本紀錄是本地原生 API fixture／合成瀏覽器證據，不是部署、AdventureWorks 真來源或真模型驗收。沒有實際 metadata、SQL、ingestion、grant、AUTO、runtime/config 變更，也沒有 commit／push。**

## 本地已接通的使用流程

1. `start_maintenance(sourceUrn)` 以現行 Source Catalog 範圍建立原生 Task／根 Run；可用 `assetUrns` 縮小到使用者明確選取子集，不能擴大 Source。沒有 latest-single-ingestion、exact inventory64 或 AUTO policy 前置。
2. `prepare_maintenance` 沿用 Catalog 意圖，保存分段的原生子 Run／Decision；定義的 Host URN 可供後续項目引用。涵蓋 Domain、Glossary Group／Term、Tag、Property 新建與階層，Dataset／欄位描述、關聯與 Property 值。全 NO_CHANGE 記 KEEP，`gap:{code,reason}` 記明確未決，不冒稱成功。
3. `seal_maintenance` 封存範圍／原生項目 digest。選定資產尚無套用／保留／缺口紀錄時不能只靠一個定義宣稱 ready。同一 Aspect 的實際變更合併一筆；重疊拒絕，不按讀取頁拆寫。
4. 對話卡片只向父頁面傳根 Run 定位。父頁面讀齊同版本全部 manifest 頁及每筆 digest-bound 完整差異、證據；一次確認記錄精確 plan digest／selection。排除父項會同步排除依賴，選依賴則包含父項。模型工具沒有確認／發布 action。
5. 父頁面依相依順序呼叫既有 publisher／CAS，先建立、核原生初始持久結果及目前版本／attempt 歸屬，再套用。Source 撤權、原值漂移、UNKNOWN 不被略過；已消耗 attempt 不重送。
6. 停止取消後續派送，不宣稱回滾。原生批准已證實、但沒有 native attempt 的項目可在同一確認下繼續；不是重播未知 target write。
7. 後續輪次重新讀 prior-Agent／current／new，保存 KEEP 或新差異；保護既有人工內容及未選 metadata。成功但 schema／目前值改變與原 UNKNOWN 分開呈現。

根 Run 保存 compact native references，子 Run 保存各自完整提案／attempt；沒有第二 datastore、Core patch、新 publisher、背景 worker 或排程。沿用 Task／Run ACL，非私人審核。Task 有 Catalog assets 時可承載最多1024 Dataset；無 assets 的旧接口16上限保持。

## 證據與範圍

- `tests/test_agent_semantic_maintenance_plan.mjs`：五類定義、階層、Dataset／欄位關聯與值；同一真人確認；排除依賴；來源撤權／人工漂移；原 UNKNOWN 不追認／不重送；確定未派送續作；KEEP；真正變更的**合成**第二輪；選定資產未帳平不能封存；明確缺口；91 Dataset／744欄的**合成**容量與分頁。
- 既有 Catalog、Domain、publication、managed publication、Task records、contract guidance、MFE bridge 回歸。
- `tests/check_agent_semantic_maintenance_browser.mjs`：既有 esbuild／Playwright 模式，React 卡片 → 跨 origin MFE → fake public DataHub API／CAS。390及1440寬度；真人確認前0 target write，確認後依序建立 Tag／套用；dependency selection、差異與證據可讀、結果、不可重送及無橫向溢出。第二輪更改同一Tag內容，展開證據／限制實際顯示新建定義影響缺口，再確認一次並原生讀回；KEEP不重寫。每寬度共3個合成target writes。不是五類定義的真瀏覽器／真 DataHub 驗收。
- TypeScript noEmit、targeted ESLint、SDK tool/profile 與 MessageView 檢查；downstream 精確四路徑更新，原上游版本鎖及 reverse baseline 保持。
- LSP15路徑未取得 errors，但 push-only server 回覆 inconclusive；不是15檔已確認 clean或專案整體通過。以可重跑 TypeScript／Node 檢查補充其各自範圍。

最終本地回歸229/229、SDK/profile/render26/26、TypeScript／targeted lint及584個來源的downstream/reverse506通過；數量只證明檢查範圍，不是產品完成度。最新patch SHA `e870071259d1e3a882ccf3ba0e64694b4891cf112fb1b4515268b6e4831be42d`，上游鎖保持。

本地證據：`.local/evidence/semantic-maintenance-workflow-local-20261003/`（gitignored）；最新原始 `final-core.log`／`final-sdk.log`／`final-tsc.log`／`final-lint.log`、`downstream-owned-update-{refresh,check}.log`、`browser-owned-update-final/receipt.json`。原始失敗與修正紀錄保留；包括合成手機長 URN overflow及修复、過度使用個別 review 全上下文 guard 阻擋本輪已知 editable 變更及修復、尚未派送續作的 proof JSON key order修復。

## 仍未完成／不能由本地證據推定

- 未部署新版，尚未經真 `/mfe/agent`／真模型進行 AdventureWorks 全選範圍首輪及真正證據變更的第二輪。
- 全域引用及並發完整性仍未取得證據。使用者於2026-10-04明確選「仍整批確認一次，之後 Agent／Host 直接處理」，不加逐定義批准、不取消每輪確認。現已接通**本案已成功新建且當前完整 Agent 版本未被覆寫**的五類定義內容更新：核原初始建立 Run／Decision／attempt、當前完整值與原初始觀察版本；後續更新保存可再次核對的原建立定位。原生引用／Property assignment 索引分頁觀測最多1000，`complete:false` 與索引／ACL／並發缺口明示在整批精確差異；不是假造完整影響。已觀測引用必須屬於同 Source 資產、其欄位，或能核對本案建立的其他定義；已知範圍外引用、影響讀取不確定、外部／人工定義、人工漂移、原 UNKNOWN 仍阻擋，且發布前再查。合成檢查涵蓋五類後續內容更新、Tag連續兩次更新沿用原建立定位、未確認不能寫、範圍外引用與人工改值拒絕。舊独立個別審核／managed契約及 Property破壞性migration未放寬。
- 每個資產的成功 ingestion provenance／as_of 沿用既有 Catalog 觀測，不宣稱目前全庫完整或新 ingestion 成功；真範圍證據尚須現場核對。
- 單項 request24KB／response512KiB／native record容量保持。超過單項容量回報阻礙，不截斷；沒有宣稱所有可能 schema／大型定義都已實測。
- 真實 schema、Source／ACL、外部 writer、登入續期、長流程中斷與 native versions 必須在核准現場輪次驗證。合成會話沒有真人登入或真授權效果。

下一步：完成當前本地原始證據收尾後，取得必要部署／真模型與metadata操作授權，走同一使用者旅程。不可用單一Term、盤點、PENDING或測試數替代完整交付。

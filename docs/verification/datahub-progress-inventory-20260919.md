# 專案進度盤點與 Goal 任務重整 — 2026-09-19

## 結論

**「目前只做到 DM02、2/12」不能代表實作進度。資料庫、ETL、Grafana、原生 Catalog 與真 Agent 唯讀 Discovery 都已有實際成果。** 尚未完成的主要是將既有分析／安全發布能力接成可核准、可操作、可查完整欄位鏈的產品閉環，以及明確列出的資料／權限負例。

本次由主 agent 盤點現行 source、既有 raw receipts、部署紀錄及必要本地回歸；沒有讀憑證、查 live 服務、SQL／ETL／ingestion／metadata 寫入、部署或子代理。「真環境已驗」指下列歷史批次，不是 9/19 再次驗證服務健康。自查不是獨立審查。

Goal：`mtzxzwn6-1zw7vn`，盤點時paused、原清單12項／2 complete。**18項新清單已原生確認，續行後已登記10項限定里程碑complete，8項仍需完成。** `get_goal`最終讀回running、current `discovery-validator`、next pending `data-safety`。此比例不是產品完成百分比。原2項完成歷史保留，另8項以原生工具依證據补登，未直接修改Goal檔案或重做成功操作。

## 為何長期停在 DM02

1. **任務契約過大且交疊。** DM02把模型／最小相容性canary，與DM06的完整發布、DM07的可信操作／權限、DM08的使用者閉環綁在一起，等同要求後半專案先完成才放行前置任務。
2. **跨任務工作沒有同步成果狀態。** 實際已先建庫、跑ETL、部署Grafana、做原生ingestion及Agent唯讀入口，仍一律記在current DM02；pending被誤讀成尚未開始。
3. **局部已完成與完整交付未分離。** 一個DDL保護負例未驗，遮住了已建庫；publication未接線，遮住了已實作與通過本地回歸的Host控制。
4. **執行曾偏向持續加解析層。** Python離線宣告追蹤已很細，但沒有相應增加live接線。使用者9/15已要求收斂，後續不再以解析模組／測試數替代可用閉環。
5. **文件維護落後。** 主README、設計、TODO與案例README仍有「尚未建表／ETL／部署」舊文字；多個已驗細項未勾。這是狀態管理問題，不是所有功能都沒實作。

這些是先前規劃與回報的缺失；不能把全部原因歸咎於目前Goal paused，也不能只改分母美化成果。

## 整個專案：平台與新業務 Goal 分開

| 範圍 | 已有成果 | 剩餘／限制 |
| --- | --- | --- |
| 官方 DataHub | 固定Core v1.7.0.1、CLI1.7.0.9、digest部署；MFE／公開模型擴充；本次核Core仍clean | 開發環境，不是正式環境全項驗收 |
| Agent T01–T02 | 真DataHub Agent模型回應；官方唯讀MCP schema／lineage查詢、API核對、reload歷史 | 歷史短效Reader token不等於現在有效，重配須另准 |
| Agent T03–T05 | 原生Source／Secret binding／ingestion、取消／版本／恢復；真Agent人工確認→ingestion→MCP讀回 | 限已驗範圍；不等於任意SQL／業務ETL能力 |
| Agent T06 | Registry、Task／Run、真人Decision繼續／End、CAS/history、導航与中斷歷史保留已部署實測 | 真Host跨Actor、其他生命週期及Agent排程仍未完成；母TODO不結案 |
| Agent T07 | Settings焦點、三尺寸操作、Windows IME、reload／單頁斷線／同版重啟後無重播已有證據 | 完整a11y／多使用者／原生功能及平台備份回復等仍缺 |
| DataFlow Discovery業務 Goal | 下表10項限定成果已有證據；真ETL→Datamart→Grafana已跑通，真Agent可分析候選 | 完整欄位與治理發布、Agent固定ETL寫入、全鏈路查询仍未完成 |

平台來源：[Agent TODO](../datahub-agent-todo.md)、[T02](datahub-agent-datahub-mcp.md)、[T04–T05](datahub-agent-ingestion-wiring.md)、[T06](datahub-agent-task-wiring.md)、[T07](datahub-agent-t07.md)。本次不將母任務T06/T07的全部工作／排程搬成此Goal前置。

## 18項新成果任務與驗收判定

下列10項「原已complete／證據齊」均已登記原生complete；限定本地交付仍不代表live驗收。`discovery-validator`已start，其餘7項pending。

| ID | 限定成果 | 盤點判定 | 證據／剩餘所在 |
| --- | --- | --- | --- |
| scope-discovery | 原需求／命名／範圍同步 | 原已complete | 保留既有記錄 |
| dm01 | 環境、授權scope、來源恢復與兩庫隔離回復 | 原已complete | 原生7表88欄canary；兩庫226項對帳及3登入 |
| model-canary | 星型／指標契約＋原生Flow／三Job最小相容性 | **證據齊：真環境** | DDL／metrics.md；19 Aspects／13 direct SQL I/O／UI reload。不是完整source或column lineage |
| dm03 | SalesDatamart schema／view／keys／權限建置落地 | **證據齊：真環境** | 4dims＋fact＋view、61欄、PK/FK與隔離還原；建置防護移至data-safety |
| dm04 | 固定scope ETL初載、重跑對帳、commit前失敗rollback | **證據齊：真環境** | 75,284 facts／17,489 orders／178,425 quantity／72,418,506.319091；timeout等移至data-safety |
| dm05 | 本案Grafana可用dashboard及SQL／filters對帳 | **證據齊：真環境** | 三資產、dashboard v2、7 panels、8場景×9responses；authenticated ACL移至access-boundaries |
| catalog-native | 來源／target原生metadata與view欄位lineage | **證據齊：真環境** | 13datasets／149fields；view五上游、24column edges、原生UI |
| discovery-skill | 安全snapshot、基礎候選分析及真Agent唯讀入口 | **證據齊：限定唯讀入口** | SKILL.md＋真tools；九檔485 candidates／46unresolved、模型與Host一致、reload；完整欄位語義轉discovery-validator |
| grafana-adapter | 固定版schema／Chart相容修正及原生file-sink準備 | **證據齊：本地交付** | 26schema／27Chart引用修為各14；原生tags=false輸出120结构Aspects通過現有review。無live發布 |
| publication-host | typed review／模型0.1.3／CAS admission／conditional writer本地交付 | **證據齊：本地交付** | 模型ZIP／roundtrip、真source重編接縫與Host拒絕／合法fixture；未部署，真入口見publication-live |
| discovery-validator | 接通既有Python欄位鏈、Catalog身份、變更／負例與發布候選 | **部分實作，待整合** | 124項宣告追蹤、56slots／49record-linked／8lookup已有；日期、轉換／成功guards、實際branch、fresh Catalog、變更驗收尚缺；不再建新解析架構 |
| data-safety | DDL同名保護＋ETL有界執行及必要品質負例 | **明確缺口** | 無statement timeout；fetch全量materialize；DDL未驗同名shape；補NULL／unknown／縮scope／keys／並行與取消保留資料，需live批次另准 |
| access-boundaries | Grafana metadata reader及真跨Actor／秘密隔離驗收 | **部分實作，待授權／實测** | DB least privilege／匿名401及fixture已有；folder-only reader、非owner真拒絕、live metadata／SQL權限分離未驗，不自行升Viewer |
| publication-live | 既有Host production preparation／人類審核／安全發布接線部署 | **部分實作，未部署** | fresh source/Catalog/ACL→最終owned diff→typed UI→一次attempt→CAS/readback；需部署批准，不能覆寫未納管canary |
| dm07 | 真Agent固定ETL提案／人工批准／執行與狀態 | **待實作接線及真驗** | 唯讀Discovery已另結；固定ETL ID／版本／scope、過期／漂移／任意指令拒絕、取消／UNKNOWN對帳仍缺 |
| dm06 | 完整DataHub技術／治理metadata、run及Grafana發布讀回 | **部分已有，主鏈未完成** | 原生schema／canary已另結；source→ETL→dm→view→query→Chart、Job dependencies、真run、terms/domain/Join語義、部分恢復仍缺 |
| dm08 | 真Agent／WebUI完整欄位與業務語義查詢 | **局部UI已有，完整待驗** | view Columns及Flow/Jobs頁面已見；Chart來源／UnitPrice影響／AOV／as_of全鏈與負例尚缺 |
| dm09 | 最終整合、變更回歸、回復runbook與交付 | **待驗收** | 重用兩庫隔離回復；只重驗受影響來源，補ETL/dashboard/metadata恢復及最終source-bound閉環，不重跑所有成功操作 |

## 原要求不遺失的移轉表

| 舊任務 | 已證實成果的新位置 | 尚未完成要求的新位置 |
| --- | --- | --- |
| DM02 | model-canary、catalog-native、grafana-adapter、publication-host | discovery-validator、publication-live、access-boundaries、dm06–dm08 |
| DM03 | dm03 | data-safety（同名、重複建置、非法schema） |
| DM04 | dm04 | data-safety（timeout／有界extract／穩定key實證／NULL／unknown／縮scope／並行／取消）；dm07（可信執行）；dm06（run發布） |
| DM05 | dm05 | access-boundaries（真非owner／folder-datasource ACL）；data-safety（來源NULL變體） |
| discovery-skill | discovery-skill | discovery-validator（完整支援模式／實際欄位轉換、接到live工具、非hardcode變更驗收） |
| discovery-validator | 現有library與124項證據保留，不宣称全體完成 | discovery-validator、publication-live |
| DM06 | catalog-native及model-canary的限定部分 | dm06（完整圖與語義）；publication-live（安全寫入責任） |
| DM07 | discovery-skill（真唯讀入口）／publication-host（本地控制） | dm07、publication-live、access-boundaries |
| DM08 | 已有view／Flow／Job頁面證據 | dm08（完整使用者情境） |
| DM09 | dm01已有備份還原可重用 | dm09全部最終驗收／同步／回復，不刪任何原完成條件 |

Goal八項success criteria仍全保留：1→dm03/dm04/data-safety；2→dm05/access-boundaries；3–4→discovery-skill/discovery-validator；5→discovery-validator/publication-host/publication-live；6→catalog-native/model-canary/dm06/dm07/dm08；7→discovery-validator/dm09；8→data-safety/access-boundaries/publication-live/dm09。

## 依賴與下一步

不再以「DM02全部完成」擋住所有成果。現有實作重用，不新增架構：

1. **主線先接discovery-validator**：收斂現有source/context/field模組，完成這條案例必要欄位與語義／變更負例；缺證據不把call graph／同名欄位補成lineage。
2. data-safety可獨立補既有DDL／ETL缺口；access-boundaries先釐清folder-only reader／跨Actor精確授權，不能借過期批准操作。
3. publication-live接真Host caller及typed UI，模型／Host部署經批准；dm07接固定ETL，依data-safety後驗成功／拒絕／UNKNOWN。
4. dm06完成實際技術／語義／Grafana／run發布與對帳；dm08由真入口讀完整鏈；dm09做最終受影響回歸／交付。

Grafana reader唯讀preflight提案只是access-boundaries的一個待批准動作，不是全專案的新架構前置。沒有權限時仍可推進不依賴它的本地整合，不再以連續小提案遮住成果。

## 來源與證據抽核

Private receipts位於 `.local/evidence/dataflow-discovery/`，不公開原始內容：

- ETL：`sales-datamart-etl-20260914.json`、`sales-datamart-etl-rerun-20260914.json`、`sales-datamart-rollback-20260914.json`。current etl.py SHA `ecb353ed…`；九個輸入檔逐SHA全部仍吻合`ed276f258ceed74e491d85b16d8e54da9408cc9484b44a3bbccf8e4aec1af77f`的歷史snapshot。舊receipt固定DB標籤不獨自證明當時connection，另有已核准identity probe；不追認舊runtime分支。
- 模型／schema：`dm02-target-schema-keys-lineage-verified-20260914.json`；`dm02-flow-job-ui-visual-verified-20260915.json`及原19-Aspect readback。
- Grafana：`grafana-browser-matrix-2026-09-14T07-25-52-455Z.json`、v2 readback／真selector receipts。
- Agent：`agent-discovery-model-e2e-retry1-20260914.json`，真兩次tool回應與模型／reload一致；validation仍INCONCLUSIVE，publicationAuthorized=false。
- 模型0.1.3：ZIP實際SHA再次核為`5fc8d52c95d61b700ef5169dc6941c629370ac89c21caf41bfd24f484def2275`；未部署。
- 發現native-discovery及tests有較舊checkpoint hash差異；閱讀raw diff可見排版差異，不把旧hash直接冒充現行證據。**本次現行source回歸：59 Node PASS；93 Python tests＝92 PASS＋1原生Grafana已知expected failure**。logs：`progress-inventory-node-20260919.log`／`progress-inventory-python-20260919.log`。這些都非live證據。
- `lens_diagnostics(mode=all)`最後仍顯示`tests/test_sales_datamart_grafana.py:21–25`五項SDK `reportMissingImports`。專案`.venv`實際imports與本次93項測試可執行，與auxiliary Pyright環境／快取不一致；沿用既有false-positive記錄，不修改正確import或停用規則。**不宣稱全專案diagnostics clean**。
- 原生SDK compiler目前明確拒`native_column_compilation_unverified`；server沒有接入production recompilePublication，不能把本地conditional writer存在當成完整發布已可用。
- Core commit `e99431ec510d7a2001f815c6bf70913c493af76e`仍clean。倉庫多數專案檔尚未tracked，未commit/push；以檔案digest而非root HEAD宣稱本案來源版本。

## 原生狀態同步已完成

`set_goal_tasks`返回「Task list set and confirmed. 18 tasks. (blockCompletion enabled)」。續行checkpoint先以`get_goal`確認running／2 of18，再以`update_goal_task`依序start/complete八項已有證據成果，start `discovery-validator`。最終讀回**10/18 complete、current discovery-validator、next pending data-safety**。

保留scope-discovery、dm01完成歷史；舊dm02由model-canary及明確剩餘任務取代，原要求／證據保留於移轉表與歷史報告。沒有改tool availability、直接改`.pi/goals`或啟另一控制器。這次狀態補登不授權部署、憑證存取或任何外部寫入，Goal與TODO尚未整體結案。

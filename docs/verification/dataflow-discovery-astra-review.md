# DataFlow Discovery — Astra 主會話審查與修正 checkpoint

日期：2026-09-14。主會話 runtime 已核為 `openai-codex / gpt-6-astra`；main-only，未派子代理。本次是主會話對既有草稿的審查與修正，不是獨立第三方驗收。

## 結論

**原實作需要實質調整；DataFlow Discovery、publisher 與真 E2E 尚未驗收。** 原生 Goal `mtzxzwn6-1zw7vn` 為 running，仍停在 `dm01`，1/12 complete。以下離線修正不代表提前通過 DM06，也不追認母任務 T06/T07。

## 已重現並修正

| 問題／原因 | 修正與證據範圍 |
| --- | --- |
| 直接呼叫 validator 的 dataclass 路徑沒有重算 analysis/candidate identity；同時改兩邊 snapshot digest 可通過 | 統一走候選反序列化完整性檢查；重算全部檔案 UTF-8 hash/size、排序唯一 manifest 與 snapshot hash。不只驗有候選引用的檔案。findings 存在即清空所有可發布 IDs。 |
| SQL 正則從 literal/comment 猜出資料表；parse 失敗仍產生 resolved edges；CTE alias 被當實體 | 改由 sqlglot AST 與 scope.selected_sources 辨識實體 table；不支援／動態／macro 明列 unresolved，不做 regex fallback。SELECT INTO 保留讀寫方向；SELECT aliases 僅是 query-local inferred，不是已解析 Catalog 欄位 lineage。 |
| SQLCMD GO regex 過度跳脫，兩批合成一個 process；strip 丟失 evidence 起始行 | 用 tokenizer 識別獨立 GO，不切開字串／註解；保留 batch 原文與行偏移。 |
| Grafana rawSql 位於 targets[]，原程式卻在 target 尋找 panel id，漏掉消費 edge | 依 JSON ancestor path 保留 owning chart；兩個 panel 各自讀不同表的測試驗證沒有互串。JSON embedded SQL evidence 指向 JSON 文件，不把 SQL 虛擬換行當文件行。 |
| Host Git provenance 的 `git status` 可執行 repository 設定的 core.fsmonitor | 在 Git 呼叫明確停用 fsmonitor／hooks。以臨時 repo 與本測試自寫的 sentinel monitor 重現 red，再驗 green；未執行真實來源程式。 |
| Publisher 建構 Chart／Dashboard 共用 `env` 參數，但固定 SDK 不接受 | 移除這兩種類型的 env 參數；直接建構真 SDK entity 並核 URN。僅證明離線 constructor 相容，不是 live API 驗收。 |
| 任一 entity failure 後仍繼續 entity／lineage writes | 首次失敗即停止後續寫入，記錄實際 attempted lineages，不自動 retry／rollback。unknown outcome 仍須人工對帳。 |
| 未 readback 也回 COMMITTED；目前 readback 僅存在性／表級可達性 | 未 readback 改 ACKNOWLEDGED_NOT_READ_BACK；有限讀回改 ENTITY_TABLE_READBACK_ONLY，兩者均非完整 commitment。 |
| 舊 plan 一過期就不能反序列化檢視 | 解析按其 approval 時間驗結構／digest；真正 publish 仍核當下 expiry。 |

Analyzer version 改為 **1.0.1**；validator 拒絕舊版本候選直接進 preview，必須重新分析。Parser 接受不等於語義正確；未知 procedural SQL、templates、複雜欄位／動態 scope 尚未恢復完整探索能力。

## 尚未修復的發布阻擋（不可接 write credential）

1. **Catalog 身分／schema／欄位語義尚未完整解析。** 下述續修已拒絕無關 asset ID、錯誤 edge 端點與偽造分析，且每個 EntitySpec 須回指候選。但這只驗「候選 → Host 宣告的 URN」翻譯一致；Host 宣告本身仍須由官方 ingestion/Catalog 與來源連線 scope 獨立核對。不能將任意手寫 URN 對照或欄位 schema 稱為已探索／驗證。
2. **Approval dataclass 不是可信人類核准。** `actor_urn`／technical_lineage／digest 可由呼叫者提供；尚未接既有 Host Task／Decision、tenant/source ACL 與不可偽造的核准讀回。不可另建第二套權威或讓模型自行批准。
3. **真 Host scope／policy 接線未完成。** 下述續修已在 publish_plan 內強制由 Host-only root/paths/source_id 重新 capture/analyze，不能傳入舊 Snapshot 代替。這不提供 root／allowlist 的人類授權，不是跨檔原子或防止分析後來源再變動的保證；可信 policy／Decision 與真入口尚待接線。
4. **讀回不足。** 目前不能核實欄位 mapping、owned property 值、schema 與語義。SDK constructor 與 fake-client tests 不能替代固定部署上的 emit／完整讀回。
5. **並發／更新政策不完整。** get-then-create／patch 有競態；owned property 值變化一律 conflict 也不足以支援已批准的新 revision。需確認官方 API 能力與既有 Host 的版本授權契約；不可直接換成覆寫或放寬衝突。
6. **分析 coverage 尚不完整。** Python 呼叫／field assignment 不等於資料集 lineage；SQL macro／procedural SQL／跨 scope 欄位解析仍 unresolved。必須以 source-bound golden／改名／轉換／動態負例及真 Agent 入口證明 recovery，而非把未知標籤清掉。

Publisher 檔頭已標明 UNACCEPTED DRAFT。這是狀態揭露，**不是技術性停用或安全修復**；本輪未把它接入 Host／Agent，也未提供任何 live write client。

## 證據

- 初次負例：`.local/evidence/dataflow-discovery/astra-review-red.log`。
- Publisher 原始錯誤：`.local/evidence/dataflow-discovery/astra-publisher-red.log`；局部修正：`astra-publisher-green.log`。
- 最終離線 suites：`astra-review-final-tests.log`（以最新重跑內容為準）。涵蓋 snapshot、analysis、Host Git、publisher 與 ETL 純函式；不跑來源 SQL／DataHub／Grafana writes。
- 9-file 真實 source 重新分析：`sales-datamart-discovery-astra-review.json`。snapshot `d942b3d8f25694baa99845cfb946749da8cff85bafe27fb06270d408ca7cadca` 未變；analysis 1.0.1 digest `e0aaa38546eb3a8524c140cc755fdf7713ddfafc4f71bcc0125b850b553f2ff0`，485 candidates、46 unresolved、222 preview entries；validator **INCONCLUSIVE**／無完整性 findings，不是發布核准。此 receipt 只聲明 content revision，未冒稱 Git commit。
- Python primary LSP 已做 scoped 檢查。原 `technical_lineage is not True` 被 ast-grep 誤報，局部豁免未被 auxiliary scanner 採用；目前改用等價的「必須為 bool 型別且值為真」，移除無效豁免，保留拒絕 `1`／`"true"`／`None`／`False` 的回歸測試。未放寬為一般 truthiness 或 `== True`。opengrep 未回應與 review graph 缺檔的提示，不算安全／下游全掃描通過。

## 續修：候選翻譯與發布前 source capture（同日）

- `publication-plan/2`：每個 EntitySpec 包含候選 ID，拒絕缺失／kind 不符／同 subject 多重身分。每個 edge 必須引用對應 relationship 候選；reads／consumes／contains／depends_on 的 subject/object 明確轉成 DataHub upstream/downstream，不能只核候選 ID 清單。
- 計畫與 emit 邊界重新驗 snapshot/analysis，並從捕獲 bytes 重跑靜態 analyzer，拒絕呼叫者自行生成合法 digest 的假候選。反序列化只驗結構，不賦予發布權限；重新計算 plan digest 也無法繞過 emit 端的候選翻譯驗證。
- `publish_plan` 必須取得獨立的 Host `root/paths/source_id`，內部重用 `capture_and_analyze()`；不從 plan JSON 取得路徑，不再接受 caller 自備舊 snapshot。非 content revision 必須符合 clean Git commit。capture 後再驗期限，未到期／已過期的判定不接受 caller 自報「approved」狀態。
- URN 用固定 SDK 的官方 parser；完整核 edge 兩端型別。未知 schema 不再傳 `schema=[]`，避免產生虛假的空 schemaMetadata（兩個真 SDK 序列化負例 red→green）。
- 欄位 mapping 僅能有已解析的兩端 dataset subject／field 候選支持；目前 query-local inferred alias 不能晉級。這沒有完成 schema-aware column discovery 或完整欄位讀回。
- Publisher tests 不再用手製 file asset 當成功 lineage 證據；用實際 Python embedded SQL／Grafana JSON → analyzer candidates → plan → fake transport，覆蓋合法 reads/writes/contains/consumes 與拒絕路徑。transport 是 mock，**不是 live 發布證據**。
- 既有 `native-tasks.mjs`／`task-records.mjs` 已核：Task 啟動明示 read-only metadata；Decision 只有 question/choices 與 RESPOND/DISMISS 文字回應，沒有綁 publication operation／digest／期限的寫入授權。沒有改動或把文字回答當核准；後續應在既有 Host／官方 Model Aspect 的主責內補齊，不另建權威庫。
- 最终 suites **59 PASS**：`.local/evidence/dataflow-discovery/publisher-binding-final-tests.log`；publisher 單檔進展 log 為 `publisher-binding-tests.log`。2 檔修改 Python primary LSP 0。先前 46-test log 是前一 source checkpoint，保留不冒充新狀態。

回顧：原「任何 approved ID 都能支持 edge」路徑已因真正重建候選與逐項翻譯檢查而移除；**任意 Host URN mapping／文字 Decision 仍不是可信語義或授權**。因此不開放 live publisher、不勾 DM06。

## 外部環境與下一個安全步驟

DM01 尚欠 authenticated ingestion canary／DataHub Secret 同步與隔離 volume backup/restore drill；Grafana 專用資產與真 Agent/WebUI E2E 仍未完成。本輪未重新取得任何 token／cookie、未讀秘密值、未做 DB 或 DataHub/Grafana mutation、未部署、未動 Core、未 commit/push。

下一步先在既有 Host Task／Decision 與公開 API 的邊界修復上述發布主責，不能只加更多可自報 digest。外部 canary／write/readback 需使用既有核准目標及可信秘密通道；缺權限不能被離線綠燈替代。

回顧：本輪有區別力的負例找出了「語法看似通過但產生錯邊」、「完整性檢查漏路徑」與「Host 的唯讀 Git 命令仍可執行來源設定程式」三類實際原因。綠燈只支持已覆蓋的行為修正，不支持 Skill／部署／業務語義整體完成。

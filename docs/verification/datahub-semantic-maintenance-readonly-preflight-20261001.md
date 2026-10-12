# 持續語義維護：B 段唯讀預檢

狀態：**B原失敗證據保留；14:25Z兩條retention政策已套用。其後另准受限建置／唯讀部署與reader配置修正，15:28Z真入口成功歷史、桌面／手機唯讀明細、模型選單及reload核驗完成。首輪＋真變更第二輪仍未驗收。**

使用者批准主層對本案9002／9041、SalesDatamart原7 Dataset／69欄及相關原生歷史做唯讀核對，可使用本案既有DataHub登入；沒有重啟、部署、模型訊息、Catalog或Task／Run／Decision寫入授權。使用者其後明示測試所需內容由主層自行準備，不再要求提供檔案路徑；合成測試不冒充真實業務修訂，也不新增真Catalog寫入授權。

## 15:28Z最新：相容唯讀入口已部署並讀回

- 另准 `approve_build_readonly_deploy_verify`：既有1CPU／3GiB／no-extra-swap／serial builder，凍結context建置，非開發checkout的Next build；580/580 current/staged/image來源與mode一致，artifact gate PASS。相依pins及baseline保留，builder已停止。
- 新image `sha256:e13a62b6af075c5fcd5cb2d24cac87d154b9c7ba6d715545d7b150f56d262945`；MFE536.js／remoteEntry.js實際HTTP供應值与candidate一致。未改Core／模型jar／provider登入。
- 初次切換後 `read_review` 真入口409，已停止保留。根因是舊readonly config缺Agent識別與必要audit audience，部署預檢漏核；不是reader仍要求publication=true。經 `approve_exact_readonly_reader_config_recovery` 只補既有Agent與 `EXISTING_TASK_RUN_ACL`，同Source／7Dataset，發布仍關閉、AUTO／auditRecovery absent；2項合成復現證明讀權不擴寫權。
- 最終配置 `.local/agent-server-semantic-maintenance-reader-20261001.json`、Host PID1173988、runtime9371cd0c776c（本次觀測，非永久識別）。原配置／MFE備份／HOME volumes及所有失敗保留。
- 真 `9002/mfe/agent` → actor-origin9041讀回同7Dataset／69欄scope、r2 accounted25／missing51／pending0／未closed。既有成功review保持原attempt及初始 `VERIFIED_CURRENT_VALUES`；當前撤權context未驗證，不冒充新批准。
- 真桌面1440px及手機390px從既有卡片開明細，發布停用提示可見，修改選取／Reject／Approve禁用、無dialog橫向溢出、Escape可關閉。模型選單可見8個選項；沒有選模型或發送訊息。reload保留78則歷史及原模型設定。
- 全部35sessions／兩個HOME volumes的bytes、size、mtime不變；r2 Run／Task／r1 Run及完整目標 `editableSchemaMetadata` 原生前後相同。沒有Catalog／Task／Run／Decision寫入、模型訊息、SQL或ingestion。
- 驗證脚本兩個生成錯誤保留：Docker inspect報告少JSON結尾，在intent／重啟前停止且零效果，僅補格式；model API漏既有session cwd被403拒，按產品UI的同cwd補正，只續未完成檢查，不改路徑ACL。均非盲目runtime重試。
- 原另一未配置Source的PENDING／REJECT／UNKNOWN不擴權讀取；這些情境仍只有既有合成reader證據，不稱本輪全狀態live通過。模型回應／工具閉環、真Task／Run跨20版及兩輪真維護未驗。
- 私有證據：`.local/evidence/semantic-readonly-deploy-20261001-XxvSzA/`與`.local/evidence/semantic-readonly-reader-recovery-20261001-RNArh8/`；後者 `live-receipt.json`、`session-preservation-final.json`、原生前後／截圖及checkpoint。最終4個private helper的cache讀出20個error finding（18個AST fail-fast／精確bool／風格及2個Pyright optional-binary型別）；已在intent前明確assert node存在，修正後AST／實際binary核對通過，但LSP仍timeout，未宣稱全clean。不是產品碼診斷，不加fallback掩蓋錯誤。

## 已確認（2026-10-01 13:15–13:20Z，歷史預檢）

- DataHub UI／GMS loopback正常監聽；9041無listener，原Host進程不存在。
- 原Agent runtime已於09:06:59Z停止，exit143、OOMKilled=false。這不證明誰停止它或為何停止；未重啟。
- 原唯讀配置SHA及固定image與前次紀錄一致；既有DataHub登入有效，發布關閉、沒有AUTO／audit grant。
- 公開原生API確認同一成功ingestion Run、相同scope fingerprint、7 Dataset／69欄；checkpoint仍未驗證，不代表全庫inventory。
- 讀回7 Dataset所請求的完整Aspects；原r2成功欄位仍為Aspect version4，完整值與原發布後一致。r2 Run目前version53／25 Decisions／1attempt／未關閉；固定Task version1可讀。沒有重播舊發布。

## 新阻擋：固定歷史版本未能讀回

對同一r2 Run，以現有reader和官方文件記載的batchGet方式指定 `ekopAgentRun.headers.If-Version-Match="1"`，原生API回傳空陣列。預檢於此停止，保留原request locator及回應，沒有重試、換API、改資料或拿current冒充history。

首次停止時只能說 **version1未能經此公開契約取回**，不能說歷史已刪除。使用者另准限定唯讀診斷後，13:38Z的新證據如下：

- 固定官方 `v1.7.0.1` 的 [OpenAPI指南](../../upstream/datahub/docs/api/openapi/openapi-usage-guide.md) 確實示範這個header查詢歷史。
- 同Run指定version52成功讀回52／25 Decisions，證明近期歷史可經同公開契約取得。未重試version1。
- GMS非敏感設定 `ENTITY_SERVICE_ENABLE_RETENTION=true`。公開 `dataHubRetention` batchGet核對兩個Aspect的exact／wildcard所有優先鍵後，均只有 `(*,*)` 的 `maxVersions:20` 生效；沒有 `ekopAgentTask` 或 `ekopAgentRun` 專屬override。這證明現行歷史保存只有20版本，與v1不可得、v52仍在的現象一致；沒有直接觀察過去的刪除交易，不能宣稱可還原v1。
- Task version1目前亦是latest，因此本次Task讀取還不能證明舊Task版本可讀。

這是多輪固定Task版本與原生完整歷史驗收的實際阻擋，不能以本地fixture通過略過。未更改DataHub Core、ACL、retention或任何內部資料表。

## 本地候選實作與驗證

- 配置：[ekop-agent-history.yaml](../../extensions/datahub-agent/deploy/retention/ekop-agent-history.yaml)；[接入／升級／回復說明](../../extensions/datahub-agent/deploy/retention/README.md)。只含 `dataJob/ekopAgentTask` 與 `dataProcessInstance/ekopAgentRun`，沒有wildcard、time policy或forceOverwrite。沿用現有`.local/plugins` mount，不改Core／模型jar／Compose，也不新增store或publisher。
- 既有synthetic fixture原先無限保存已改為預設20版本，歷史查詢按真實version而非array index；可由候選配置設定兩個Aspect的limit。
- `tests/test_agent_semantic_retention.mjs`：原20版本下v1缺失、Run當前累積Decision仍在但Host拒絕拿current Task替舊版；候選下Task24／Run53仍可精確讀v1；stale CAS仍拒絕；後加大limit不復活缺失，無target寫入。測試皆合成，不是假業務修訂。
- 最終 `retention-related-final-r1.log` **338/338 PASS**（含4項新專項及舊334，不加總）；未變UI/TS沿用A1證據。LSP3paths無reported errors但inconclusive／timeout，不稱全clean。原 `retention-local-r1.log` 保留：初始測試誤以為失去固定Task版本後Host還應返回Run；依實際fail-closed行為修正測試，未放寬reader。
- 官方loader的解析／registry／路徑由固定來源核對，未執行Java system-update。它可能合併其他bundled/plugin政策，不能把整輪執行假稱只改本案兩條。

## 14:25Z：另准精確政策套用完成

使用者選 `approve_exact_retention_apply`，僅准既有DataHub登入、兩條精確policy及插件YAML，不准9041切換、模型或業務metadata寫入。以官方OpenAPI v3同步generic寫入，每個 `dataHubRetentionConfig` 使用 `If-Version-Match: -1`，共2次請求；各取得version1 ACK、按該版精確讀回，再核current與key Aspect及官方優先序解析。兩個maxVersions均2147483647，5個fallback鍵完整前後相同（含全域20）。原生API同時建立這兩個retention實體的key Aspect，未更動Task／Run內容。

`.local/plugins/retention/ekop-agent-history.yaml`以不覆寫方式建立並核SHA與0644。未跑system-update，因此沒有合併／套用其他插件政策或批次裁剪；沒有重啟、模型、歷史v1重試、業務metadata写入。已設定原生保留政策，但真Task／Run超20版的寫入及歷史仍待另次授權驗收，不能由設定值直接宣稱通過。

一次性操作8/8合成測試通過：兩鍵先預檢、CAS衝突、失ACK停止、身分撤回、部分成功、exact讀回失敗及其他政策漂移。證據 `.local/evidence/semantic-retention-apply-20261001-f5jKds/`，包含authority、before、逐筆intent/ACK/exact、after、plugin-staged與receipt。操作腳本不重跑；失敗不改locator重試。本批沒有失敗的現場操作。LSP3paths無reported errors但inconclusive，非全clean。

## 下一步與證據

限定歷史診斷已完成。使用者已批准只針對兩個插件Aspect各採2,147,483,647版本上限，先完成本地候選；不能改全域預設或把新datastore當替代品。固定版本的 `RetentionService.getMaxVersionsToKeepForWrite()` 對沒有version policy回傳1，因此不能只用空retention宣稱無限歷史。已選官方int上限仍是極高有限上限、會增加儲存量，且既有缺失不會自動恢復。政策方向與本次精確套用均已批准，且套用已完成；今後更改、降低上限或執行system-update仍須另准。

測試案例由主層自行準備並區分合成與真實資料，不再要求使用者填檔案路徑。9041相容唯讀部署及歷史／模型選單核驗已另准完成；新模型訊息及真維護寫入仍未授權。下一步回首輪＋真正變更第二輪的具名證據與精確批准，不重做retention或補例外取代主線。

本次原始證據位於 gitignored `.local/evidence/semantic-maintenance-readonly-20261001-szxOHq/`：`authority.json`、`scope.json`、完整Aspect／原生歷史private JSON、`failure.json`、`preflight.log`、`history-authority.json`、`historical-run-v52-private.json`、`retention-policies-private.json`、`history-diagnosis.json`及`CHECKPOINT.md`。未讀provider憑證或Source密碼、未執行SQL／ingestion／模型／子代理。

Host／UI產品程式未變；新增本地部署候選、更新fixture／tests／docs，本地候選當時31檔pins見同證據目錄`source-retention-final.sha256`（本次僅更新相關狀態文件；新快照在套用證據目錄），A1舊pins保留當時快照。早先直接native API讀取不等於真入口；最新另准部署及真入口證據見上節。兩者均不代表第二輪維護已完成。

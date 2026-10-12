# 精確資產契約證據：本地實作（2026-10-02）

**本地完成，尚未部署／真寫入。** 後續已另准512KiB單次回覆及精簡收據／原生明細按需分頁；下文24KB／48KB描述是此slice當時狀態，最新修复與證據見[收據與明細本地驗證](datahub-semantic-review-delivery-local-20261002.md)。 使用者選擇擴充同一固定第一方契約、先本地實作；其後明確指定候選項數上限為1024。既有唯讀入口不因這項修改取得發布權。

## 實作與邊界

- `semantic-managed-evidence.mjs`仍只讀固定`extensions/sales-datamart/metadata/metrics.md`與操作者批准的SHA。新增`projectManagedContractEvidence()`純投影，支援同文件內的`ekop-semantic-catalog-evidence/1` JSON區塊。
- 格式`salesdatamart.semantic-evidence/1`：`sources`固定實作檔案→SHA；`statements`包含精確`assetUrn`、可選`fieldPath`、明文`text`及固定檔案行範圍`references`。Dataset不帶fieldPath，欄位不轉小寫；重複target、未知欄位／格式、其他資產／檔案與不合法引用拒絕。Host重核引用的來源bytes SHA及行範圍；不執行Python／SQL。
- 只允許既有七個SalesDatamart資產及四個既有ETL／SQL檔案。新區塊取代該版本legacy公式投影，不混合兩者；原legacy文件／SHA行為保留。
- statement IDs只擴充描述證據，不擴充非description AUTO、共用定義更新或ACL。技術實作的明文解讀不代表來源目前值、業務認證或即時觀測。
- Host／SDK候選項數及原生Review candidate IDs上限對齊1024。24KB請求、48KB回應、128政策targets、Aspect數、evidence IDs、native record大小、CAS與不重播界線不變；1024不是保證1024項可發布，也不是新增範圍或權限。
- scoped文件最多65536 bytes，legacy最多8192；statement數最多128。這些是各自獨立的界線，未因候選項數而放寬。

## 首輪不能按盤點頁拆寫

原76目標回歸把同Dataset分成8項多批。每批初始發布成功，後批卻改動前批共用的完整`editableSchemaMetadata`；finish只核算28、missing48、前批`UNKNOWN_OR_CHANGED`。原RED保留。

修正是移除8項寫入障礙，先收齊同快照的盤點頁，再以同Dataset完整提案發布本輪同Aspect實際變更（目前最大24欄＋Dataset共25項）。不修改reconciliation或追認UNKNOWN。模型skill已同步；讀取分頁不是拆寫邊界。KEEP依既有selector／question-size界線另記，不改目標Aspect；不可把KEEP混合實際寫入以規避驗證。超出任何大小界線，報具體阻擋，不拆寫冒充輪次完成。

## 驗證結果與範圍

| 證據 | 本次結果 | 只證明 |
| --- | --- | --- |
| 新runnable contract regression | 16/16 PASS | 真integration／固定reader與mock public API：76目標首輪關閉；同Task／同政策第二輪一個合成明文修訂更新＋75保留；舊Task／Run與未選metadata不變。另驗1024／1025、來源漂移、人工作品、撤權、ACL、identity、超大輸入與非description不擴權 |
| `node --test tests/test_agent_semantic*.mjs tests/test_agent_task_records.mjs` | 326/326 PASS（包含上述16，不加總） | 受影響Host／compiler／native record相關合成caller |
| SDK＋managed cycle UI | 6/6 PASS | 真固定SDK注册／transport與React render；25項傳送、超24KB在UI前拒絕、超48KB拒絕；沒有模型prompt |
| `tsc --noEmit`／scoped ESLint | exit0 | Pi-web型別及修改的tool來源 |
| fresh LSP 10 paths | 0 errors，45 style warnings/hints；4未確認 | 不宣稱全clean。未清理無關既有風格問題 |

## 真實實作來源候選，不是現場成果

私有本地目錄：`.local/evidence/semantic-scoped-evidence-local-20261002-uDMf9P/`。

- `metrics.scoped-candidate.md`：76個具名技術statement（7 Dataset／69欄），SHA `638826bfae0e1e40e8eb76430dad2d7436aa5d9acec2e16143794818db5be624`，36937 bytes。逐项從固定ETL／DDL／view／summary解讀，不用欄名猜商業語義。
- 明列日期Unknown與locale、維度來源／代理鍵、訂單明細與本地scope限制、LineNetAmount量化與容差、月／分類GROUP BY、OrderCount不可跨分類直接相加、view直接投影和同名SourceLineTotal不同粒度。不建立Domain／Term／Tag／Property事實。
- `candidate-contract-receipt.json`與`draft-host-receipt.json`：候選實際bytes／source pins在mock metadata上經真Host首輪核算76、missing0、closed；不是fresh source inventory、live Catalog或SQL執行。
- 初稿兩次大小失敗完整保留：r1在view盤點回應超48KB；r2在view prepare返回超48KB，**已涉及mock native records／targets，不能說零mock效果**。owned temp已清理，沒有live API。修訂僅精簡候選：同檔引用用保留全部原行的覆蓋區間、view明文只描述其直接投影而不重複整套上游敘事。沒有提高byte caps、截斷證據或改Host安全檢查。r3 mock首輪PASS。
- 超大prepare回覆仍可能在持久化／attempt後才拒絕；項數1024不解決這個界線。真執行前須按fresh metadata／完整提案核大小；若遇回覆失敗，以原locator只讀對帳，不重播或把錯誤當零效果。此次未新增通用response框架，也未宣稱任意1024項端到端可用。
- 現行`metrics.md`仍是原SHA `a10923a6280d63bb3528b1f51ac83afc047650284b7fd195a00ef3b80dbd7c0a`；未改現場契約、configuration、provider auth、model、Catalog／Task／Run／Decision或SQL／ingestion。無部署、子代理、commit／push；既有WIP、Core與index保留。

## 尚未成立的完整完成線

真正第二輪仍缺首輪後經批准的實際證據修訂；`BLOCKED_NO_GENUINE_SUBSEQUENT_EVIDENCE_REVISION`，不能故意改公式或拿合成文字充數。真首輪也尚未執行。候選scope identities沿既有成功盤點，須真執行前fresh重核，不能把這份本地投影當新成功ingestion。

下一步是批准候選exact bytes／SHA、相容部署及精確模型／Task／Run／Decision／必要Catalog操作，核對完整初始差異；後續有真實證據改變再進第二輪。適用共用定義、bounded impact、人工保護、語義品質及跨20版真歷史依原acceptance plan仍待驗。不要重做retention、reader恢復或用r2例外收尾取代主線。

**回顧：** 新證據格式解開Dataset及有粒度限定的欄位描述；整範圍測試也暴露「按候選數拆寫」與Aspect責任邊界不一致。以完整提案消除該需要，而非放寬初始成功／漂移檢查。大小失敗證明項數與傳輸預算不能混為一談；真業務／現場輪次尚不能用本地PASS代證。

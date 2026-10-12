# DataHub Pi Agent：描述維護首輪真入口驗收（2026-10-02）

## 結果與界線

**本輪由 DataHub 介面內的 Pi Agent 實際執行並關閉，不是開發子代理或操作者腳本代為發布。**

| 項目 | 原生核對結果 |
| --- | --- |
| 成功 ingestion 範圍 | 同 Source、7 Dataset／69欄，76個邏輯目標；非全庫 inventory、無 checkpoint 證明 |
| 描述維護 | 73個空值依固定契約補值，3個既有值保持原樣 |
| 發布／觀測 | 7筆完整 Dataset 提案、1筆 KEEP；共8個 Decision、7個一次性 attempt |
| 初始與目前結果 | 7筆初始 `VERIFIED_CURRENT_VALUES`、7筆當前 `VERIFIED`；KEEP含3個 `OBSERVED_NO_CHANGE` 目標 |
| 完成狀態 | accounted76、missing0、pending0、exception0、closed=true |
| 原生歷史 | Task v1、Run v32；Run精確v1仍可讀，證實該Run跨20版保留；不代表Task已跨20版 |
| 產品模型 | `openai-codex/gpt-5.6-sol`／medium，1個新session、總共2則模型訊息 |
| 最終部署 | Catalog publication=false；無AUTO／auditRecovery，無進行中的模型session |

3個KEEP是 `dm.fact_sales_order_line` 的Dataset描述、`salesorderid`、`linenetamount`。保留是當前值觀測，不認證舊值的業務含義、不認領其他Source的作品。技術敘述依已批准的固定第一方契約與實作定位，不擴充為業務認證。

**這只完成本次描述維護首輪。** 未完成首輪後真正證據修訂的第二輪、適用共用定義／非描述維護與真人批次審核的完整產品驗收。沒有為測試編造修訂、KEEP-only第二輪或灌入政策例外。使用者明確選擇本輪main-only功能測試，未派獨立來源reviewer；不宣稱獨立審查或正式上線驗收。

## 執行與故障處理

1. 使用者批准73補值＋3KEEP、必要原生Task／Run與至多8個Decision；另澄清必須由產品內Pi Agent執行，不啟動開發子代理。
2. fresh核身分、scope／recipe／schema、664來源pins、七Dataset完整before與新Task／Run不存在。06:23Z啟用限定AUTO，保留完整Aspect合併規則、ACL、CAS及人工作品保護，不允許Agent描述更新。
3. 第一則產品訊息實際完成7筆發布及KEEP，逐筆原生對帳至76/76；之後讀完整明細失敗，06:30Z停止模型。沒有重送發布。
4. 原生對帳證實73補值、3KEEP、7筆初始成功、Run v31未閉。06:37Z撤回原唯讀配置；先前成功資料不回滾。
5. 另准修復及受限部署後，07:43Z最終MFE／Host修正版就位。真入口讀齊7筆明細，桌面1440px／手機390px可開25項大提案，批准控制停用，背景與主動讀取沒有重試或容量擴張。
6. 使用者另准的唯一續驗訊息仍進同一產品session。Pi Agent重新讀原Run及25項提案完整明細，**只關閉原Run**並讀回。07:52Z最終核對Run v32，唯一value變更是 `closedAt`；Task、8個Decision／7個attempt、七Dataset完整Aspects均與首輪寫入後相同。舊78訊息session未變，產品新歷史reload可讀。

關閉原Run使用既有Host原生契約，在Catalog publication=false下完成；沒有再開AUTO或auditRecovery。Catalog發布停用與原生Run關閉是不同操作，不把前者冒稱全部metadata操作都不可能。

## 因果修復

### 明細識別混入每次觀測時間

模型傳入的version／planDigest／detailDigest正確。固定Run v31及同plan的健康讀回，只因 `currentContext.observedAt` 改變就產生不同明細SHA，下一個detail請求因而被拒。

修復在 `native-semantic-tasks.mjs`：穩定文件不含此次讀取的時間；時間保留在fresh receipt，MFE loader核完整文件及最後fresh receipt後展示最後觀測時間。ACL、Run／plan、狀態、metadata漂移、到期與撤權仍會驗證；原始attempt outcome及其時間完全保留。不是略過SHA或重試讀取。

### 背景卡片與模型共用互斥／容量

原 `mfe/semantic.js` 把所有讀取與整段真人審核共用同一`pending`鎖，卡片自動讀回讓模型收到`semantic_request_busy`。首次修正只分離鎖，真入口仍遇Host `semantic_capacity_exhausted`；此失敗保留，未當成成功。

來源核實：Host `analyzeBounded` 每actor只允許1個operation。經使用者再確認，橋接層改成**最多32個待處理請求、首次HTTP送出循序化**；讀取各自可等待／取消，發布及真人審核另維持互斥。每請求最多送一次，不提高Host容量、不設錯誤重試；取消中的等待項目不得送出，unmount取消所有所屬請求。原發現的「直接並行」版本已被此修正取代。

## 驗證證據

- 因果RED：移动觀測時鐘導致detail失敗；背景讀取占用mutation鎖及取消行為，三個回歸先失敗。
- 最終相關Node測試 **360/360**，含明細漂移／ACL／UNKNOWN不追認、首次送出容量與互斥、取消／unmount、原生Task／Run及既有語義流程。
- 真React→跨origin MFE→Host、合成DataHub的10個瀏覽器journey通過；這些不是live寫入證據。
- 實際7筆新原生提案在**捕獲的原有效政策、只讀HTTP防護**下，移動時鐘仍可完整讀取，原Run不變；這是本地整合讀取，不是重新啟用發布。
- 最終部署真入口：7筆明細共73候選、3個同時提出的讀請求依序完成、25項明細桌面／手機可讀；無新增模型／metadata effects。後續產品Pi Agent本人讀明細、關閉原Run及原生讀回另有獨立收據。
- MFE使用凍結來源、現有固定image工具鏈、network-none、1 CPU／3 GiB／swap.max=0；未重建Pi-web image、未在開發checkout執行Next build。
- fresh LSP未報錯，但相關檔案為inconclusive／silent-on-clean，**不是全clean**。Node執行測試、語法及scoped diff另核。

驗證器的錯誤亦保留：歷史API誤用selector後改用 `headers.If-Version-Match`；舊transport測試仍預期readonly互斥而逾時，依新契約更新且保留新互斥測試；末態驗證器重用已到期的20秒client，改以新只讀client完成末態檢查，未修改產品timeout。均不冒充產品成功、未因此重送native寫入。

## 定位與下一步

私有證據根目錄（不公開原生payload或session）：

`.local/evidence/semantic-first-round-20261002-6CR6uf/`

最終收據：`reader-repair/admission/final-receipt.json`；真入口明細：`reader-repair/admission/deployed-readonly-proof.json`；新Run尾碼 `3d39432d-99ed-3c37-a3ad-dea1a43c43c2`，session `01a0fb48-a40a-7097-be47-10b613d953f6`。

下一步是取得**首輪之後真正且有依據的修訂**，再確認後續輪次的精確政策／模型／原生操作授權；不能沿用已撤回的AUTO、重播已消耗操作或為湊第二輪自行改語義。現有共用definition完整影響證據等缺口繼續如實保留，整體任務仍open。

本輪教訓：明細識別須綁持久狀態，不綁每次讀取的時鐘；UI請求所有權與Host容量是兩個邊界，必須在真入口一併驗證。成功寫入與讀取失敗分開保存，修復後只續作未完成步驟。

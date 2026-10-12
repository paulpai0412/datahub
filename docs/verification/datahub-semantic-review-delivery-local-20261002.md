# 代管收據與完整明細：本地驗證（2026-10-02）

**已本地實作與驗證，尚未部署／真實首輪。** 使用者批准「收據與明細分開」，其後批准建議：單次語義回覆上限從48000 bytes提高至**512KiB＝524288 bytes**；寫入精簡收據，完整明細容得下即一次讀，超過才分頁。48KB原為本案界線，並非DataHub硬限制。

## 原因與修復

重現舊較長契約候選（非縮短後的候選）：最後25項提案preview約41430 bytes，發布後加上attempt、目前對帳及Run歷史，總回覆48171 bytes；目標已寫入，才因回覆上限出錯。原始`response-causal-red.log`保留。

- `native-semantic-tasks.mjs`：新client以`responseMode:receipt`讀／寫審核。收據包含locator、Run版本、plan、狀態、項數、初始結果摘要及完整明細digest，不攜帶全部差異。小型舊caller仍可取得舊完整結果；超過512KiB改回收據，不以大小錯誤掩蓋已消耗的attempt。
- 完整明細仍從原生Task／Run／Decision導出，**沒有新增datastore、cache或背景worker**。`read_review_detail`重新核身分、Source、資產ACL與audit audience，綁定Run version、planDigest及整份文件SHA。UTF-8與JSON escaping按完整wire envelope計算，超過512KiB才切精確JSON文件片段；不是把單筆候選拆成多次發布。
- `semantic-review.js` parent loader核全部片段順序／长度／digest／版本，重組後核SHA與完整候選數，最後fresh read確認觀測未變，再開放完整差異的真人核准。缺頁／竄改／版本變更／撤權／取消不提供可批准的半份提案。仍使用原本mutation CAS，不讓iframe／模型傳批准。
- SDK、React card／preview、MFE讀回及批次批准已接線。收據card只開明細；parent持有核准。批次收到Host的初始成功收據後記錄成功，不把後續明細顯示能否讀取當作重新發布條件。lost ACK保留原UNKNOWN，現在MATCHED不能追認。
- 項數1024及24KB請求、原生record/Aspect/政策/KEEP等其他界線不變。1024不是任何內容都能一次發布的承諾。完整明細client總組裝另有1,048,576字元有界限制；這不是原生紀錄容量放寬。盤點／一般preview超512KiB仍拒絕；本次分頁的是原生review文件，不是所有API的通用分頁框架。

## 證據

私有目錄：`.local/evidence/semantic-managed-real-readiness-20261002/`。

- 相關Host/Task/semantic回歸`related-r2.log`：**336/336 PASS**（含当時10個新delivery tests）；隨後加入lost ACK receipt驗證，`delivery-final-r2.log`：**11/11 PASS**，不要相加。後續未改受驗產品碼。
- SDK／managed UI：6/6；`tsc --noEmit`及6個修改TS元件／tool的scoped ESLint exit0。fresh LSP15 paths reported errors為0，但15皆inconclusive（2 timeout），不宣稱全clean；另以實際tsc／語法檢查核對。SDK測試證明48171 bytes回覆可用、524288 bytes以上仍拒，24KB請求界線未放寬。
- `draft-host-green-r2.log`：原較長候選在mock public API經真Host首輪7完整提案、76accounted、missing0、closed。每筆收據1873–1892bytes，最大完整detail（含loader附帶收據）48771bytes，所有明細各只需一頁。這是實作來源技術草稿＋合成metadata，不是live Catalog或業務認證。
- 11個delivery tests：25欄大證據、真Host批准與原生fixture歷史、wrong version/digest/offset、撤權/ACL/到期、lost target ACK不追認、超512KiB的UTF-8/escaped JSON分頁與缺頁／亂序／竄改／跨版／取消拒絕。超512KiB文件案例只證傳輸，不宣稱原生admission接受任意大型提案。
- `browser-final/browser-review-result.json`：真React card→跨origin MFE→Host＋mock DataHub，在390及1440寬度核原歷史／選取／批准／拒絕／撤權／重載，新增25項完整提案、損壞detail禁批准、手動重讀恢复、單Aspect寫一次、重載不重播。10個journeys，zero page errors；兩張大提案截圖已目視。這不是現場登入或模型E2E。
- 批次瀏覽器在相關suite內完成：`.local/evidence/semantic-batch-browser-zK771S/result.json`，成功／停止後續／lost ACK／重載及iframe偽造拒絕；沒有live calls。

## 失敗保留與界線

- 首次related suite的批次3情境失敗：實作在成功ACK後強制完整detail讀取，撤權／取消使成功项被說成UNCONFIRMED。修到消費可信Host寫入收據判定初始結果、下一項仍fresh核；沒有放寬UNKNOWN。另readonly測試更新為3個唯讀呼叫，不新增mutation。
- 私有draft helper第一次接新參數時，沒有同步原native pending body而被`semantic_native_request_mismatch`拒於提案寫入前；原log保留。只更正fixture一致性，不改Host檢查；重新使用獨立owned mock temp，無live重播。
- lost ACK新測試最初期待approve成功返回；實際既有Host正確拋`publication_write_unconfirmed`。測試改為核原錯誤＋只讀receipt／detail的初始UNKNOWN，沒有改產品去吞錯。
- 沒有部署、改現場配置／metrics契約、模型prompt、provider auth、SQL／ETL／ingestion、Core、live metadata、子代理或commit／push。既有WIP保留。

## 下一步：真正代管，不是再作本地收尾

先取得本案新候選相容部署及同Source／7Dataset的現場唯讀預檢批准，核fresh identity、完整before／versions／scope、契約pins、原歷史及提案大小，形成實際首輪差異。現行active metrics.md仍原SHA，待批准候選為上一報告36937bytes／SHA638826bfae0e1e40e8eb76430dad2d7436aa5d9acec2e16143794818db5be624，不自動啟用本次較長回歸草稿。

真模型／Task／Run／Decision／Catalog發布另列精確批准與必要fresh review。真正第二輪仍要首輪後的實際證據修訂，不能改字湊驗收；共用定義適用性、完整影響、品質及真歷史仍依完整acceptance plan處理。retention及舊readonly恢復不重做。

回顧：本次修的是「寫入結果與大明細傳輸綁在一起」；容量提高與收據分離各解不同問題。512KiB讓目前提案保持單頁，原生分頁保留完整證據及版本一致性，並未增加批准權。

# 流程優先語義維護：部署與真入口準備驗證（2026-10-04）

## 最新本地：原生範圍與封存條件結構化完成，未部署

使用者要求朝完整目標繼續實作，不用補丁／hardcode替Agent判斷。既有`read_maintenance`新增`view:scope/unprepared`，以原生Task／active links提供精確選定／尚未準備資產與20資產分頁、Root版本／scopeDigest；`sealing.checks`與實際seal共用條件函式。定義anchor／superseded不算套用，帳平及structurallyReady不代表語義完整。完整來源inventory不是此整批已選Catalog路徑的封存條件；原session／Source／ACL／CAS與真人一次確認保留，沒有controller／store／自動選動作、修訂、封存、批准或重送。

原生／Catalog／transport／readonly／MFE87項、SDK／RPC75項、TS／targetlint／scopedDiff通過，589downstream／reverse精確506及原三項baseline通過。四LSP零回報但全inconclusive。來源／Source變更及ACL、版本／依賴、GAP／KEEP／定義與整筆修訂／後續fixture輪次均有本地證據；不能推定真Agent語義能力已恢復或完整交付。

**未build／部署／新真提示／原生写入／consent／發布。** 最新live仍為下節r14觀測DRAFT285／16未準備，沒有本輪fresh live讀回；歷史UNKNOWN及所有成功效果保留、不重播。新部署與一則原對話／Root／同模型high有界完整方案驗證仍需明確操作授權，真人確認／實際發布／原生UI及真正後續變更輪次仍OPEN。

詳見[本地行為與證據](datahub-semantic-maintenance-state-local-20261006.md)、[設計第10節](../design/datahub-semantic-maintenance-workflow-first.md)。私有checkpoint：`.local/evidence/semantic-maintenance-state-local-20261006-5EptBP/CHECKPOINT.md`。

## 2026-10-06 最新r14：明確參照真寫入成功，但完整維護仍未完成

r14新提示11:08:34Z接受，11:24:46Z正常結束／running空。28次明確定義參照帶來16筆已ACK未核提案（14整筆GAP修訂＋2新增），包含Domain16／Term11／description91；沒有Host或工具錯誤，未封存／批准／發布。**本次實際解除r13搬運長URI的阻擋，但沒有Tag／Property套用或完整方案驗收。**

可信原生RootTask及全頁讀回：**DRAFT285／126active／142recorded／75of91／16未準備／selectionnull**；29定義、73套用PENDING、24GAP、無stale dependencies。四歷史UNKNOWN不變，成功保存不重播。

完整owned journal證實前景確實排入兩次續作，最後模型卻聲稱只剩四UNKNOWN與`completeSourceInventory=false`，沒有再做原生進展，原無進展guard正常停止。實際另有12未準備資產，包括Employee／Person／Product／Customer／SalesOrder等，不是四UNKNOWN全部；Host封存規則也不以completeSourceInventory=true為門檻。**這是未完成且誤判剩餘工作，不是runtime失敗，不能靠放寬guard或盲目新提示處理。**

目前PID1727288／imagee00ad984保持；r14已消耗、不重送，無r15授權或準備。下一建議沿同一原生view明確提供待準備subject與真正封存條件，供Agent自主處理；不新增controller／store／自動核准。完整有用方案、一次真人確認後真執行／UI及真正變更輪次仍OPEN。證據`r14/closeout-summary.json`、原生scope讀回、1420筆私有journal與最新CHECKPOINT。

## 前次操作：項目參照修補已部署，r14新提示啟動（已由上節取代）

使用者另准受控部署與原會話／原Root／同模型high一則新≤45分鐘提示，非語義發布consent。新獨立freeze96／candidate588／reverse506／source一致／artifact223／映像SDK40通過；建置沿CPU1／3GiB／swap0／隔離HOME串行限制。兩HOME／41journals在本次部署前後（新提示前）保持，Source grants／query／設定／模型與預算不變；MFE未更動或重建。

11:06:09Z切換 **PID1727288／config SHA67624772…／imagee00ad984…**；舊1337653退休不再啟動。真父頁／iframe讀回同session／high／idle，原Root DRAFT253／124active126recorded／無selection、定義明確reference已返回，BOM12候選含Term保留。r14新harness1734398於11:08:30Z啟動一則全方案自查／必要整筆修訂提示，**結果尚待核對**；不重送r13或已保存操作，不批准／發布。完整有用方案、整批真人確認／原生UI與真正變更輪次仍OPEN。

## 前次本地：明確定義項目參照完成，當時未部署／未新增提示

使用者另准本地實作及正反向驗證。`read_maintenance`定義項目提供`definition.reference={definitionItemId}`，供Agent明確選同Root有效定義；Host精確解析成原URI，再走既有ACL／編譯／依賴／完整提案／整批確認／publisher。適用Domain／Tag／Term／Property候選及Domain／node階層，可混合保留既有URI；Property業務值不被當參照。參照必傳目前Root版本，前後核Source／scope及child版本／digest；未知／外Root／錯類／GAP／被取代／已消耗項目拒絕。不猜名稱、不補錯URI、不自動合併／刷新／重試、不增store／controller／權限。

- 83項相關原生／Catalog／transport／readonly／MFE與73項固定SDK／RPC檢查通過，TS／targetlint／scopedDiff、downstream588與reverse506通過。合成完整旅程涵蓋五類定義、階層、混合人工作品、Dataset／field Property、整筆GAP修訂、一次同意後既有publisher讀回；不能冒稱live驗收。
- SDK只傳明確選擇，不解析URI或代填版本；缺版本在intent／派送前要求模型更正。固定SDK合成模型亦能傳參照物件並沿原own-ACK規則更正舊版輸入，Host漂移仍停止。
- 失敗caller保留：欄位Property漏candidate.fieldPath造成正確overlap拒絕；revision fixture缺可信session包裝及錯認revisedItemId／preparedItemId，僅修caller，不放寬Host。五檔LSP0errors但均inconclusive，cached179檔0errors不是workspace證明。

**僅本地完成這個阻擋修補。** 當前PID1337653／imagea9a73仍前版，沒有再build／部署／送提示／真native寫入或consent。最後實測仍r13的DRAFT253／18未準備／無selection；歷史UNKNOWN不變。完整有用方案、真人一次確認後真執行／UI讀回及真正變更輪次仍OPEN；下一主線須另准新部署及同SID／Root／high有界驗證，不重送r13。私有證據`definition-item-reference-local/`、最新CHECKPOINT；契約見[設計第9節](../design/datahub-semantic-maintenance-workflow-first.md)。

## 前次真入口：修補已部署，r13因抄錯Domain定位停止，仍未完成

r13在07:38:37Z第一筆修訂被`semantic_catalog_invalid`拒絕，0保存／封存／發布，已停止且running空。精確原生拒絕child `c38a487e…`不存在、原Department GAP完整；Root仍DRAFT253／124active／126recorded／18資產未準備／無selection，不是四個歷史UNKNOWN已解。

完整owned journal1233筆與原生讀回證實：模型把既有Domain URI中的`…b52aaacaf0fe252…`抄成`…b52aaac0fe252…`，漏掉`af`。它不是既有計畫定義的精確key，因而走普通native entity查詢；精確錯誤URI的native batchGet回200空陣列，依現有client契約必然拒絕。Root253與全部lineage evidence IDs正確，非再次自過期或外部漂移。

**新自過期修補未被本次真提示走到**（沒有自身成功寫入ACK）；不以部署／offline READY當live recovery。當前PID1337653／imagea9a73…保持，r13與部署操作授權已使用，不重送／新UUID重建／自動補URI／放行Host錯誤。後續建議沿既有原生計畫提供明確參照選擇與Host精確解析，避免模型搬運長opaque定位；此句為r13當時狀態；新本地授權與實作已由上節取代，尚未部署驗證。整份有用方案、整批真人確認與真執行／讀回／真正後續轮次仍OPEN。

## 前次部署及r13起跑（保留歷史，並非仍在執行）

使用者另准部署＋原session／Root／high一則新≤45分鐘提示。等待ACK時的input reset/rebind邊界亦經before-gate RED／固定SDK GREEN核對；只讓同一個派送時Root綁定的ACK提供本提示自身證明。最終71項SDK／RPC、TS／targetlint、588source/reverse506／新image38項SDK檢查及223browser artifacts通過；版本patch為`ab648040…`。MFE未變，沒有重建或交換其檔案。

07:35:17Z切換至PID1337653／config SHA428d1b70…／imagea9a73ef5…；旧995101已退役，41份journals／兩HOME跨部署保持，Source grants／query／settings／model high與預算不變。入口讀回原Root DRAFT253／124active／126recorded／無selection，BOM原12候選含Term保留。

r13新提示07:37:52.308Z已接受200/success，harness1345439觀察原session前景；不重送舊r12，不重新建立Root，不重播已ACK修訂，不批准或發布。**尚未取得最終方案與品質結果，不能宣稱真修補／完整維護已驗收。** 完整整批真人確認、實際發布／讀回及真正後續輪次仍OPEN。最新證據：`self-stale-root-deploy/`、`r13/`、CHECKPOINT。

## 前次本地修補：未部署階段（以下保留歷史證據）

使用者明准本地修補／正反向驗證。沿既有Root綁定，只記同一已接受提示中自身成功原生寫入ACK的版本；在同Root／session有效前景中，明確比這個已確認版本舊的輸入於派送前拒絕，由模型讀回並自行更正精確整筆。SDK不代填版本、不刷新／重試、不恢復authority、不新增controller／store、不放行真正Host CAS。讀取／歷史／新提示均不能建立或復活自身寫入證明。

固定SDK0.85.1的可重跑旅程：舊本地與目前部署映像都重現兩笔251→首笔成功253→次笔Host409／DRAFT；新碼改為次筆本地拒絕（沒有intent或派送）→模型明確讀Root253→模型生成正確253修訂→兩筆ACK後同提示正常續作。外部漂移、只讀歷史及新input reset負例仍停止，沒有自动替换版号。69項SDK／RPC通過，加做的reset案例與原3例共4項通過；TS／targetlint／downstream588-reverse506通過。早期fixture的followup分支順序及Host throw斷言错误仅修caller，失败证据保留。

**仍未真入口驗收這個修補。** 目前PID995101／image2b328…仍舊SDK，r12停在DRAFT253／18資產未準備／無selection或發布。沒有另一則提示或部署授權被推定；需新操作授權與fresh入口核對才能實測，不能重播r12。完整自動代管、一次真人确认后的真执行／读回及真正後續輪次仍OPEN。證據：`self-stale-root-local/`／最新CHECKPOINT。

## 2026-10-06 前次真入口：視圖已部署，r12因同批舊版Root停止

使用者明准一次新部署與同SID／原Root／high提示，已消耗。05:41:46Z部署PID995101／image `sha256:2b3285783e3feec01917d3aab3d0a106581c01b4cb98618d2817fe076f77c0d8`；source587／artifact223／imageSDK32通過。兩HOME／41journals跨部署（提示前）完整保留，grants／query／connection／模型／預算不變；PID759202已退休。

r12新第十則05:44:09Z接受。真入口與Agent均成功使用同資產視圖，BillOfMaterials既有12候選含Term保留、不再重複prepare。vEmployee的GAP也實際整筆修訂成19候選PENDING（1Domain／18description），原歷史保留。但Agent同批預先產生四筆revision，全部version=251；第一筆ACK後Root變253，第二筆仍帶251，Host正確拒絕。完整1204-entry journal證實此因果：不是外部漂移，也不是SDK沒有序列执行；序列执行不能让预先生成的第二笔参数自动看到第一笔ACK。

05:47:57Z已停止／running=[]，1真保存／0seal／0publication。最新 **DRAFT253／124active／126recorded／29definitions＋57applications＋38GAP／73有提案或GAP／18未準備／selectionnull**。成功revision6733261d…不重播；被拒第二筆e3e3b4de…可信父層精確原生讀取task_record_not_found，原GAP20d324f0…完整。此證據不解決歷史四UNKNOWN。第三／四筆沒有派送。

下一修正必須處理同Root的「前一筆ACK後再產生下一筆正確版本」接點；不可代填版號、放寬Host CAS、重試已保存效果或單純再送提示。尚未實作此修正，更未完成全方案／一次真人確認後發布讀回／真正後續輪次。證據：`asset-maintenance-view-deploy/`、`r12/`、最新私有CHECKPOINT。原生寫入的是未確認提案，**沒有語義目標發布**。

## 2026-10-06 前階段：同資產維護視圖本地完成（歷史）

使用者選擇改進既有原生計畫的同資產維護視圖。沿 `read_maintenance` 加 `assetUrn＋version=目前root runVersion`，在當前Root範圍／Source／metadata ACL下列出該資產所有active套用與GAP／KEEP。每頁一筆完整歷史preparedRequest／observation，保留原item修訂tuple；只是用該資產作證據anchor的共用定義不誤算套用，全計畫仍20項／頁。讀後由Agent明確保留／整筆修訂／新建；Host不代選、不合併、不重試、不新增store或controller。舊輸入不是當前inspection或執行授權。

本地合成旅程驗證：GAP＋既有PENDING並列、完整保留原Term與描述候選、重複prepare仍拒絕、顯式revise與舊歷史保留、舊版本分頁／scope外／ACL拒絕、既有真人確認／publisher接點正向讀回。75項原生／Catalog／transport／readonly檢查通過；SDK原批次65成功＋新mock錯誤，修正caller的agent_end.messages後該7項全通過（另59項既有成功證據沿用），TS／targetlint／downstream587-reverse506通過。LSP4檔零errors但全inconclusive；不宣稱全workspace乾淨。

**這證明新讀視圖與既有保護可用，不證明真模型已恢復正確規劃，更不是完整代管完成。** 尚無新build／部署／提示／原生實際寫入；last-known live仍PID759202／image43f03…，r11已停，DRAFT251／124active／125recorded／18未準備／無selection或發布。部署與一則新同Root／high驗證須另取得操作授權及fresh入口核對；不重播r11。證據：私有 `asset-maintenance-view-local/` 與最新CHECKPOINT。

## 2026-10-06 前次真入口：明細修補已部署／真讀成功，但r11仍未完成方案

使用者明准受控部署與一則新的同對話／Root／high驗證。04:25:10Z切換完成，PID759202／image `sha256:43f03b0bc3657abb081d08d9c32ba0d9a9f759e51f75c38a6edf3e9c59347f7b`；source587／artifact223／映像SDK33通過，兩HOME／41journals在部署前後完整保留、設定／grants／模型high／budget不變。PID3622115已退休，不重啟。

r11新第九則04:28:08Z接受。原本失敗的review-detail用正確完整tuple於04:28:33Z真讀成功；沒有故意重造漏欄位測試。Agent兩次讀齊原生計畫，卻對已有PENDING的BillOfMaterials再呼叫新增prepare，而非保留或按原item整筆revision；Host正確拒絕Aspect重疊，04:29:55Z已停止／running=[]／0新保存／0seal／0publication。完整原生仍 **DRAFT251／124active／125recorded／73有提案或GAP／18未準備／selectionnull**。

- 原BillOfMaterials PENDING990322f9…child2／digest及12候選完整；被拒新4801d099…的11候選包含10description＋1Domain，並非可追加的非重疊效果。可信父層精確讀該新child得到task_record_not_found，原提案不變。這僅證該次拒絕child，歷史四UNKNOWN仍未解。
- owned1116-entry journal保存，確認這次是Host重疊拒絕後停止，不是明細修補未生效。不放寬overlap、不自動改action／合併／重試或加Host錯誤放行。
- 下一問題是Agent如何正確使用既有完整原生計畫，區分未準備／保留／需整筆修訂；不能只再加提示或guard。原生資料本身正確，尚未證明API投影是因果缺陷。可評估沿既有native plan提供同資產維護對照／完整定位，無新store／controller／authority；尚未實作或宣稱恢復。

**仍未完成自動代管**：完整有用方案、適用欄位／TagProperty、精確GAP、一次真人確認後真執行／原生UI驗證、真正後續變更。r11已消耗，不重播；最新私有CHECKPOINT／review-detail-recovery-deploy／r11保留完整證據。

## 2026-10-06 r10原因已核清，修補當時僅本地（歷史）

完整owned1025-entry journal證明：Agent正常結束後前景有正常排入續作，之後才被明細讀取拒絕停下。Agent剛取得正確收據，下一筆卻漏`version／planDigest／offset`，Host把undefined與原生版本比較而回一致性錯誤；不是據錯誤碼推測資料真的漂移。可信父層新唯讀核對同原始version／plan／detail digest均未變，帶完整tuple讀明細成功，沒有模型提示或寫入。

SDK只在派送前檢查明細必帶定位／版本／兩digest／整數offset，缺欄位沿既有精確call更正機制讓模型自行更正。不代填、刷新、重送或放寬Host；真正帶齊但已漂移的proof仍停止。工具／Skill明示收據欄位對應。

- 原固定SDK正向fixture先重現DRAFT≠READY；新版恢復同提示自行更正→讀完整明細→不重播原保存→續作READY，真drift負例仍拒絕續作／封存。66SDK／RPC、12原生明細邊界、TS／targetlint／scopedDiff及587source／reverse506通過；兩檔LSP零errors但inconclusive，非workspaceclean。
- **只有本地修補**：尚未再次建置／切換部署或送新提示；目前仍診斷版PID3622115，最近真原生計畫DRAFT251。新patch439fa3…不是現部署映像。
- 完整有用方案、18剩餘資產／適用逐欄語義／TagProperty、精確GAP修訂、一次真人確認後實際執行／原生UI核對、真變更後續輪次仍OPEN。r10及30已保存項不重播；本地fixture不冒稱語義代管已成立。

私有證據：`semantic-autonomous-plan-20261005-ScQzQE/review-detail-input-local/`、`r10/full-session-journal-private.jsonl`與最新CHECKPOINT。

## 2026-10-05 r10已停止（歷史），仍未完成自動語義代管

第八則驗證已結束：讀提案明細時回覆HTTP409 `semantic_review_detail_changed`，驅動依安全邊界停止，20:58:15Z running=[]、harness3649072退出。這只是觀察到的一致性核對拒絕；未讀完整r10 journal／核對精確定位前，不宣稱已證明資料漂移或停止根因。

本輪真保存30項：27套用提案＋3GAP；套用候選description182／Domain27／Term14，沒有Tag／Property／欄位根item／revision。全頁原生 **DRAFT251／124active／125recorded、73／91有提案或GAP、18尚未準備、selectionnull**；沒有封存、人審或發布。項數不代表完整逐欄語義或代管驗收，既有genericGAP精確修訂與完整方案仍未做好。

使用者產品完成線：Agent自動完成盤點、全方案規劃／自查修訂／送審；人只一次確認精確整份計畫；確認後系統依序執行及核對，真變更後自行比較並送下一輪確認。不能要使用者反覆提示、修工具參數或逐批批准。下一必要工作是核r10原始journal與明細定位、修已證明的owning seam，再完成方案與真正首輪／後續輪次；不重送r10或其30已保存項目，不以新UUID／Root洗掉不明歷史。

## 2026-10-05 最小生命週期診斷已部署（歷史）；當時同計畫驗證執行中

使用者明選在既有Pi journal記錄實際停止／重設／排隊分支，再以同SID／Root／high送一則新有界提示；不是語義發布consent。只增加diagnosticOnly／retryAllowedfalse紀錄，不記提案或來源文字、不加controller／store／retry、不改guards或恢復權限，尚未宣稱找到或修好r9根因。

- 診斷版64 SDK／RPC、TS／target lint、587source／reverse506、223artifact、映像31測試通過。初版追蹤不必要地讀取inactive context，暴露兩舊mock缺API；已使追蹤遵守既有inactive return。測試兩次猜錯runtime-error分支，依真fixture的model stopReason=error修正斷言，失敗證據保留。LSP兩檔零errors但均inconclusive，不稱全workspaceclean。
- **20:31:26Z受控切換完成**，PID3622115／固定image `sha256:f8fd6778bdc7e217f6f5e1b1e562a12cf5e8285771e15f1906402a5977515e97`／patch `06d010e134ccb56b8f888166096062e794b501bcb3b0a5faa2a0bca6e1309800`。兩HOME及41 journals在部署前後完整保持，此比較先於新模型工作；身分／grants／來源查詢／模型high／defaults／budget不變。PID2858169已退休，不能重啟舊配置。
- 真父頁／iframe再次核對同SID／Root／high／idle，**DRAFT191／94active／95recorded、selectionnull**。新r10第八則20:40:25Z已接受、harness3649072執行中；早期仍讀取盤點、尚無新保存或seal，不當作最終效果。會核完整owned journal與原生分頁辨認真分支，不故意造錯、不以counts或診斷fixture代替代管。

完整有用方案、46尚未準備資產／適用逐欄語義、一次真人整批確認、原生執行／UI讀回及真正後續變更仍OPEN；四舊UNKNOWN未解、r9不重播。私有恢復點：`semantic-autonomous-plan-20261005-ScQzQE/CHECKPOINT.md`、`foreground-diagnosis-local/`、`foreground-diagnosis-deploy/`、`r10/`。下段r9現況已是歷史。

## 2026-10-05 r9 已結束（歷史）：真修訂／套用有進展，但仍未完成代管

- 第七則新提示16:14:03Z接受，沿同一Root／模型high。vIndividualCustomer原GAP成功整筆修訂為PENDING：一Domain、一完整Termset／18說明，20候選；新child23590928…保存並精確supersedes原8352661d…版本／digest／recordRef，不重送被拒e4df2004…。
- 另真保存20筆來源有據套用，包括AWBuildVersion／ErrorLog／EmployeePayHistory／JobCandidate／Shift等原泛化GAP資產；本輪21Domain／16Term／131description候選，**沒有Tag／Property套用**。這20資產原就帳平為GAP，故45／91不變；20個舊generic GAP仍與新PENDING並存，並未都被整體自查更新。項數或來源說明複製不是代管品質驗收。
- 最終16:32:40Z模型正常stop，driver16:32:48Z running=[]／0seal／0publication，完整原生分頁 **DRAFT191／94active／95recorded＝29definitions＋29PENDING＋36GAP，45accounted／46未accounted、selectionnull**。`proposal_not_ready_for_whole_plan_review: DRAFT ≠ READY` 是未達完成線，不是native runtime或UNKNOWN。真發布／人審未發生。
- 完整owned770-entry JSONL揭示11個已知派送前缺inspection拒絕，模型在同提示自行更正後成功保存；compacted API漏掉這些錯誤。**前景最後為何未續作仍未證明**：有一次foreground followup，final沒有continue191。實際read回覆readOnlyfalse，排除「read自行取消」猜測；pinned SDK successful compaction不發tree／failed事件。私有離線重放實際calls／ACK（只fixture nonce重綁，無model／nativeeffects）反會排兩次followup，但未重現live的pendingMessages／signal／input／settled等事件，不能冒稱根因或修復。沒有放寬guard試錯或送第八則。

目前部署保持下節PID2858169／image52cc…；r9 harness2871241已退出。兩種授權修补／部署完成及此真修訂結果不等於全方案驗收。下一步先取得實際lifecycle停止原因，再依證據修owning seam；任何新的診斷部署／同計畫模型提示需新操作授權，不能重播r9。恢復點CHECKPOINT／r9 closeout-summary及原始private證據。

## 2026-10-05 兩種已知輸入更正已部署；同計畫新驗證中（歷史）

r8 精確continue成功後讀完整plan／review／details／inspection；首筆整筆修訂同Dataset有兩個term.add，Host `semantic_duplicate_candidate`拒絕。已停止／running空，0保存／0seal，RootDRAFT149／74。可信父層另讀**該精確新replacement child** 得task_record_not_found、原active item版本／digest不變；不是用counts證absence，也不釐清歷史四個UNKNOWN。不重播原拒絕payload。

使用者明選「補本地參數更正能力，再部署驗證」：SDK只在派送前檢查未綁定漏Root、Catalog prepare／revise重複kind＋fieldPath。沿既有精確tool-call更正機制，模型可在同一accepted foreground自行重作完整輸入；不自動猜Root／continue／合併／重試，不放寬Host、撤權／scope／drift或ACK不明。多Term／Tag／Domain須單筆set／完整values，保留必要既有成員及整份候選其他適用變更。

- 兩項pinned0.85.1 positive recovery先在舊本地及舊部署映像重現DRAFT≠READY；新版64SDK／RPC、45相關原生／MFE、TS／lint／diff、587downstream／reverse506 PASS。LSP三檔零回報：1確認、2不明，非workspaceclean；不改標既有四個繼承SDK mocks為全套clean。
- 新獨立候選單CPU／3GiB／swap0／isolatedHOME串行build；587source／223artifacts／映像SDK31PASS。**16:09:30Z受控切換完成**，兩HOME／41份journal在本次部署前後hash／size／mtime一致；比較在新提示之前，不冒稱所有模型操作後journal不變。Source grants／connection／query／model／high／設定／budget保持。
- 新提示前真父頁／iframe核對同SID／Root／high／idle，DRAFT149／74active／74recorded、無selection／consent／attempt。現runtime `.local/agent-server-semantic-input-recovery-20261005-ScQzQE.json`、PID2858169、image `sha256:52cc12241adf3c84eb2a1b23fba0f26bdc6ddcd0089899ea4919befa73fceda7`，patch `e91c94892cfa13fc01634d5c6e3002680ada69775efcef5475ccf0163c7221ab`。PID2469189已退休，不重啟舊配置。成功build/deploy/helpers不可重跑。
- 新r9第七則有界提示沿原Root／同模型high自查有据完整方案與整筆修訂，不故意造錯測guard、不重建Root／重送舊payload／歷史不明GAP，不批准／發布、SQL／ingestion或改設定。須核其真原生結果，不能以部署／synthetic READY代替代管。

**仍未完成**：完整有用方案、適用逐欄套用、精確真人整批確認、依序原生發布／UI讀回、真變更後續輪次。私有證據input-recovery-local／input-recovery-deploy／r9位於 `.local/evidence/semantic-autonomous-plan-20261005-ScQzQE/`，不上傳。

## 2026-10-05 新版部署完成；原計畫輸入更正續作中（歷史）

專用WSLg視窗第一次未完成人工登入逾時，保留故障後另開最大化owned視窗，使用者親自登入；同一datahub身分／idle已核對，不讀取或代填帳密。

- 14:35:31Z受控切換新版完成：PID2469189、configSHA `79d5c948686b41638934266c54fc59c642a6dd8eab40bc343f18973770ee6ab4`、映像 `sha256:c5048b61c2282cbc60ec4a127c6301c230fa37732f8b7472c6b9eb07b5d9d7d6`。Source grants／模型high／defaults／預算／query／connection設定保持；兩HOME、41份對話journal在部署前後sha／size／mtime保持。此歷史保存核對早於後續新提示，不冒稱模型執行後journal不變。
- 新真入口核對原SID與Root成功：同模型high、idle，DRAFT149／74active及74recorded、無selection／consent／publication；本地受控修訂及inspection-input correction如今已部署，尚非語義代管驗收。
- r7第五則新提示已接受14:43:17Z，隨後模型在continue綁定前四筆read漏Root，Host `semantic_maintenance_actor_mismatch`拒絕，已停止且running空。來源條件明確在讀原生紀錄前拒絕undefinedRoot；不是登入者換了或寫入UNKNOWN。全為READ，start／continue／prepare／revise／seal及saved均0；帶Root的原生全頁讀回仍DRAFT149／74。原失敗、ACK與停止證據保留，不用counts推論absence。
- 最小修正只改呼叫提示順序：精確Root continue成功後再讀全頁，不改程式、身分或既有guards、不重建計畫／重新部署。使用者另明准此同流程輸入更正，r8第六則新有界提示已啟動；需消費其實際結果，不重送已接受提示，不把運行中當完成。

全方案品質、一次精確真人確認、依賴序原生發布／UI讀回及真正變更後續輪次仍未成立。最新私有恢復點：`semantic-autonomous-plan-20261005-ScQzQE/CHECKPOINT.md`、`draft-refinement-deploy/`、`r7/`及`r8/`；較早未部署敘述保留為歷史階段。

## 2026-10-05 候選映像已驗證，部署等待驗證瀏覽器重新登入（歷史）

使用者已明准部署新版並沿原測試對話／原Root、同模型high驗證完整方案自查；仍沒有語義發布consent。

- 新 `draft-refinement-deploy/` 候選已獨立freeze／隔離serial建置完成；587映像source一致、223browser artifact通過、映像內29固定SDK回歸通過。96個operator source只七個預期改動；單CPU／3GiB／無額外swap，builder已停。候選映像為 `sha256:c5048b61c2282cbc60ec4a127c6301c230fa37732f8b7472c6b9eb07b5d9d7d6`，**不是目前部署映像**。
- 部署前真入口iframe等待60秒逾時；唯讀證據顯示 `/authenticate`303導向`/login`200，未建立Agent iframe。舊PID1336358／configSHA保持、未stage新config、未切換部署、未送第五則提示，沒有native preparation／consent／publication。此登入阻擋不是nativeRoot不存在／SDK失敗的證據。
- 使用者選擇親自登入專用驗證瀏覽器；新視窗與私有session只在核對同一actor及idle後保存，不讀取／代填帳密、不覆寫歷史登入證據。恢復登入後才進行fresh preflight／history preservation／部署與原計畫新提示，不重跑已成功freeze/build或已接受模型提示。

最新恢復點：`.local/evidence/semantic-autonomous-plan-20261005-ScQzQE/CHECKPOINT.md`、`draft-refinement-deploy/`。完整語義代管仍未验收；下段本地-only敘述保留為較早階段。

## 2026-10-05 受控草稿修訂：本地完成，未部署／未驗證代管品質

使用者已選擇先补受控未核草稿修訂及整體自查，再驗證完整方案；不是同意發布目前的碎片提案。

- 新 `revise_maintenance` 沿同一原生 root，核 root／child 版本、原 item digest、同資產／根 fieldPath／定義 identity，僅 DRAFT、未封存／批准／attempt。建立 immutable replacement child，追加 supersession；舊 proposal／GAP／KEEP 與原生歷史保留，原 overlap 保護不解除。最後計畫／consent／publisher 只用 active items。
- 定義修訂不偷偷改舊套用的依賴；`requiresRevision/staleDependencies` 明示待 Agent 整筆重看／修訂，否則 seal 拒絕。修訂為完整候選，不是同 Aspect 追加覆蓋。未納入的原 proposed change 不會執行。
- 新 revision 的精確已保存 child 可沿既有 recovery 補原 root link；含有 supersession 證明的 replacement observation 亦可對帳。沒有重建／重播 child，沒有處理歷史缺 ID 的4筆UNKNOWN。SDK未知ACK仍中止同批次，不能順勢seal或重試。
- 工具、skill與MFE已接線；Agent自查要求讀齊來源、完整plan及必要review details，檢查概念重用／階層／逐欄套用／Property值，重新審視有來源說明卻判缺證據的GAP。這不是新增自動核准器，也不保證模型已做到。
- 原生／MFE合成28通過，固定SDK／RPC／binding38通過，tsc與target lint通過；下游587及reverse精確原506通過。定義→修訂consumer→seal正向流程抓到錯誤的association依賴循環，已在planning選取因果修復，未放寬guard。
- 擴大回歸388中384通過、4個舊SDK mock失敗；隔離使用凍結的已部署Source SDK重現同4失敗（缺sessionManager、appendEntry或完整inspection回覆），未修改或隱藏。六檔LSP零diagnostics但全inconclusive，不稱整套／workspace clean。
- **僅本地：未freeze／build／deploy、未送第五則提示、沒有真native準備／批准／發布。** 最近實測仍為下段r6的DRAFTv149／74，沒有品質或完整代管改善的live證據。後續须依適用授權及fresh runtime／idle／source／session gates驗證最新版真入口，再續同Root自查／完整修訂；完整READY之後才交真人一次確認，不能把目前GAP帳平當完成。

恢復點與原始證據：`.local/evidence/semantic-autonomous-plan-20261005-ScQzQE/CHECKPOINT.md`、`draft-revision-local/`。最新local downstream patch為 `98d5f9104c1efba26d586db66e0fc80347358fc71a60b65ba79d4041bb64ef13`；不是目前部署映像。

## 2026-10-05 r6 最近實測：仍不是可用的完整方案

- Source transport binding 已部署；成功 start／continue 的同提示 Root 保留 Host 實際 Source，後續 Catalog 可省略 Source；明示不同 Source 仍派送前拒絕、不偷偷換目標。原生 scope／身分／ACL／快照核對不變。r5 新增16個定義後，Malformed Source 的唯讀操作被驅動於 HTTP 前擋住，未冒稱原生未知效果。
- 同一新測試對話／Root／同模型 high 的 r6 已正常結束、running=[]。原生全頁為 **DRAFT v149／74項：29定義、8個資產的套用審核、37個GAP；45／91資產帳平**。沒有seal、真人consent、attempt或目標發布。套用請求涵蓋62個description候選、8個Domain、3個Term；沒有Tag／Property套用。候選数不是已發布語義成果。
- 大量 GAP 使用相同的「缺充分／已驗證業務定義」理由，沒有形成精確的逐項維護取捨；**不能把37個GAP或帳平數當成代管成立**。具體反例：r6實際Shift inspection已提供來源說明 `Work shift lookup table.`、`Shift start time.`、`Shift end time.` 及紀錄更新時間，仍整表判缺充分語義證據；來源說明足以支持相應受限概念建議，不需要憑名稱猜測或補造資料列證據，亦不代表已驗證全表唯一性／時區／班表業務規則。目前還沒有完整有用的欄位概念、Tag／Property及後續維護閉環。
- r6結束原因另有SDK owning-layer缺陷：Person.Address 的 prepare 缺當前inspection，實際原生session JSONL保留 `semantic_inspection_required…no request dispatched`。這是在SDK建Host body／intent／UI派送前的確定輸入拒絕，不是模型所稱「Host拒絕」，也不是runtime／UNKNOWN效果。SDK仍因此disarm前景，模型後來正常finish不能續作。只改此三個已知local inspection guard讓精確tool-call保留模型自行更正；不代查／重送，Host漂移／錯誤ACK／未知準備仍停止。**新inspection修正僅本地36GREEN，未部署**；實際目前Source-binding映像同fixture RED DRAFT≠READY。LSP2零diagnostics但inconclusive，TS／lint無errors／既有1warning，下游587／reverse506及scoped diff通過。
- 現部署 Source-binding image 保持原41session／兩HOME、Source grants、模型預算／defaults／查詢bindings。最新local source／patch另含上述inspection修補，不宣稱與部署相同。
- 下一步應先處理可修訂完整方案的必要能力及Agent規劃品質，而不是再追加GAP湊分母。既有native preparer禁止同URN＋Aspect重疊，已保存的部分Aspect也不能直接追加更多同Aspect欄位內容；未實作受控未核草稿修訂，不擅自解除這個保護。

最新恢復點：`.local/evidence/semantic-autonomous-plan-20261005-ScQzQE/CHECKPOINT.md`、`r6/fresh-driver-receipt.json`、`r6/fresh-plan-pages-private.json`、`r6/full-session-journal-private.jsonl`。歷史4筆UNKNOWN保持原狀。完整方案品質／整批人審／原生發布與UI／真正後續輪次仍OPEN。

## 2026-10-05 原方向與較早現況（以下歷史已由r6取代）

使用者已要求不再續補舊草稿，重點改為讓 Agent 依最新版自主設計完整、一致、可實際套用及後續維護的語義方案；不得為湊完成度而補證據。已明選**新測試對話＋新方案**，保留舊歷史／未知效果，模型仍為 `gpt-5.6-luna/high`，沒有發布 consent。

- 原草稿最後核對為 DRAFT v271／135項，九個 view 已有實際準備；盤點帳平91／91不代表語義代管成立，舊提案不再是本輪續補主線。
- 最新版已部署：SDK在當次提示內綁定同session／Source／asset／根fieldPath／evidenceMode的完整inspection，詞彙搜尋不改寫該綁定；Host仍拒絕漂移，不自動刷新／重送。工具與技能改為先形成共用概念／階層及完整套用，缺核准詞彙或敏感性政策不再是全面停止的指引。**不是已實作草稿修訂API，也不是已證明語義品質改善。**
- 真父頁入口的新空對話 UI 以同模型high接受首個提示；模型盤點時把一筆完整Dataset URN抄缺前綴，Host唯讀拒絕，沒有start/preparation/root。發現SDK與driver也把這類已確認輸入錯誤當停止：已修正同流程模型自行更正的分類，沒有SDK替模型修locator／重送，runtime／ACK不明仍停止。實際固定SDK回歸在原部署映像停於DRAFT，新版能模型改正→保存fixture項目→同提示續作READY，僅證明此生命週期。新修正版已部署，原新對話以新的明示更正提示繼續，未換root掩蓋效果或重播已保存項目；新對話實際保存13項共用定義、91資產schema inspection，但0資產套用／未封存；再次因模型抄缺Root UUID連字號停止。實際前端Source+同一失敗輸入對照證明是send前的格式拒絕，通用訊息被誤判runtime，不靠Root項數推論未派送。SDK現於成功start/continue後綁定本提示的已驗證Root，後續prepare/seal/read可省略；明示錯誤Root派送前拒絕、可由模型更正，不靜默換目標。新增Root ACK精確匹配，錯誤Root回應必停止同一寫入提示、保留不明效果。原部署兩個固定SDK回歸失敗，新版恢復模型更正→原Root保存→同提示READY且未知Root ACK不再派送後續write，仍是fixture範圍。修正版已部署，同一新Root／同一high對話明示續作，尚待完整方案／實際套用／品質驗證。測試驅動的空會話載入及Node DNS入口問題亦完整保留／對帳，不冒稱原生語義故障。
- 本地、建置映像、部署／歷史保留證據通過其實際範圍，LSP零diagnostics仍全部inconclusive。**完整方案品質、真人一次確認、原生發布／UI讀回及真正後續變更輪次仍未完成。**

最新私有恢復點：`.local/evidence/semantic-autonomous-plan-20261005-ScQzQE/CHECKPOINT.md`。以下保留較早部署／原草稿歷史，不作最新版完成度或剩餘工作分母。

## 歷史結論

新版已依使用者授權部署，真 `/mfe/agent` 已讀回授權的 AdventureWorks 91 Dataset 範圍，並在同一原生 Task／Run 保存五類定義、Glossary 階層、Dataset／欄位關聯及 Structured Property 值的待審提案。**尚未完成全範圍準備、整批封存、真人確認、目標發布及真正變更第二輪，不是產品完整驗收通過。**

此段取代先前[本地驗證](datahub-semantic-maintenance-workflow-local-20261003.md)的「尚未部署」現況；原合成證據仍只證明本地行為，不能改標為真寫入。

## 部署與保留

- 隔離／serial 建置使用既定單 CPU／3 GiB／無額外 swap 限制，不在開發 checkout 執行 `next build`。
- 使用固定映像及瀏覽器產物，部署僅切換本案 runtime image／browser assets；保留 Source grants、查詢／Grafana bindings 及既有 HOME histories。
- 建置映像 source gate、artifact gate、下游正反還原與真入口／既有模型／metadata 讀回已通過。適用核心／SDK 回歸、TypeScript／targeted lint 通過；四檔 LSP probe 零 diagnostics 但全部 inconclusive，不能稱為 clean。
- 首次模型在 `start_maintenance` 多帶 `contract`，拒絕前無原生 preparation；Host／SDK 已修正 pre-preparation 格式拒絕分類並部署。真正 ACK／部分效果不明仍禁止重送。
- 使用者其後明選只將既有驗收會話的同模型推理改為 high；同模型／provider、全域 model listing／defaults 與部署設定雜湊均保持不變。

## 最新原生準備核對

最新核對（2026-10-05 UTC）：同原會話／原草稿完整原生分頁讀回為 **DRAFT v223／111項／75／91資產帳平**：54筆PENDING（含25個定義）、56筆GAP、1筆KEEP。先恢復一筆已保存子review的原根連結（v219→v221），再保存CurrencyRate Dataset對既有待審匯率Term的有據關聯（v221→v223）。全部原110項及最早68項凍結内容完整保留。91 Dataset／744欄位完整讀取不是語義驗收；沒有seal、真人整批consent或目標發布，running=[]。

- 新增來源有據的共用定義及Dataset／欄位Term、Tag、Property關聯；PurchaseOrderHeader、ShipMethod、Vendor的新Term效果不同於四筆歷史未確認GAP，沒有重播舊觀察。
- CurrencyRate來源只稱currency code，未假定ISO；另準備明確限制範圍的匯率定義，不宣稱實際幣別、時區或來源資料列值。
- 最新SpecialOffer定義請求帶9個evidenceIds，Host定義契約上限為8而正確拒絕；純definition validator通過，完整preview parser可重現此拒絕。exact child讀回task_record_not_found。
- 同批UUID `676b13b7-268a-4de6-a576-5f522a15eabd`沒有回覆；原生子Run v2已有PENDING review、綁原計畫但缺manifest link。**先前誤稱為Store，現已依原始request與原生review更正：實際是SpecialOfferProduct的Product Special Offer Mapping定義，Store仍未準備。** 使用者選擇補精確綁定恢復後，已部署並在原會話真入口一次恢復該原UUID；子review仍v2／原digest／僅PENDING，沒有重寫、重準備、批准或發布。
- 四筆歷史GAP的UUID仍缺失，未確認狀態保留；新的exact child證據不替它們追認absence。

最新私有核對：`.local/evidence/semantic-known-child-recovery-20261004-1yaso6/CHECKPOINT.md`、`recovery-after-private.json`、`final-r15-private.json`；舊v219及失敗 chronology 仍保留於`.local/evidence/semantic-maintenance-full-verification-20261004-hgNnjR/`。完整首輪確認／發布／讀回及真正變更第二輪仍未完成。

### 精確原子review連結恢復

- Host `recover_maintenance` 只補根manifest，重用原生append/respond CAS；核exact root/child版本與digest、actor／Source／Task/version／session／原root、無approval/attempt/closure、當前scope/ACL/政策/schema、完整review重編譯、精確依賴及Aspect不重疊。可處理已寫link但未回應的中斷；不重建child、轉移批准、放寬UNKNOWN，亦不自行啟動foreground。
- 114 scoped Host/Catalog/Task/transport/MFE、28 SDK/RPC/foreground檢查通過；部署映像內SDK6通過。TypeScript通過；lint0errors／一筆既有無關hook warning。5檔LSP0diagnostics但inconclusive；cached檢查僅支援其實際coverage，不稱全域clean。
- 585 image-source一致、reverse精確還原506原始檔、artifact gate通過；95 operator paths中只五個預期變更。單CPU／3GiB／無額外swap／隔離HOME serial建置，builder已停。部署前後40份session／兩HOME完全保留；模型、Source grants、Query／Grafana及預算未改。
- 原session真一次恢復後，獨立原生全頁讀回v221/110及原109項不變，子review回傳完整projection與history不變。其後r12/r13模型錯拼read_review RunURN而唯讀拒絕，0準備；r14將snapshot `b8c3`抄為`c8b3`而pre-native拒絕，其exact child absent。所有失敗／Stop保留，未放寬guard；父層逐字讀五筆正確reviewRef均成功，證明不是actor/review變更。r15修正後真保存一筆CurrencyRate有據關聯，原110項保留、依賴指向原匯率定義。這是提案準備成功，不是發布或完整產品驗收。

## 前景停止部署時的歷史原生準備結果

該階段同一根讀回：`DRAFT`、Run version137、68 items；保留六筆定義提案（Domain、Glossary node、兩個 Terms、Tag、Structured Property）及原Glossary階層，累計11筆PENDING（含定義及資產審核）、56筆GAP、1筆KEEP。沒有整批 consent、seal 或 target publication。

按非 definition 項目的精確 Dataset URN 去重，目前帳平60／91資產，仍有31個；**68 items 不等於68個資產，56筆GAP也不是語義維護成功，不能据此聲稱744欄已完成維護。** 前景續作前是DRAFTv59／29items／21資產，此次實際新增保存39項，而不是39次語義目標發布。 已授權 Catalog 範圍不是最新完整 ingestion inventory；盤點頁與原生提案記錄也不是語義目標寫入。

## 真錯誤與恢復

- 模型誤用 Source URN 做 asset inspection：純唯讀格式拒絕，核對原根後沿原根續作，不重新 start。
- 模型將 Domain URN 放入 node.parentUrn：typed reference guard 拒絕；確認對應 child Run `task_record_not_found`，才修正為正確 glossary 父節點型別。原成功 Domain 提案不重建。
- 同一目標傳兩個 term.add 候選：duplicate candidate guard 拒絕；確認 child absent 後，改成保留完整既有／新增 URN 集合的一個 term.set，Dataset／欄位正向提案成功保存。
- high 仍會在全範圍要求下正常回覆並提早結束。最後一段只讀完當前 plan 分頁與91個精確 URN，新增 preparations0／seals0；driver 的 seal assertion 失敗不是 Host／native runtime failure，不可當成全輪成功。

未放寬 guard、重播 consumed／UNKNOWN／expired attempts，也沒有 SQL、ingestion、grants／AUTO、Core／datastore、commit／push 修改。

## 未完成及下一步

完成剩餘範圍與適用語義、封存精確整批計畫，再由可信父頁面每輪真人確認一次，依相依序發布及原生讀回，之後驗證真正變更第二輪。不得以五類單一資產正向提案、GAP 數量、合成測試或部署成功替代。

使用者已明選實作有界前景準備續作，現已部署。固定產品SDK0.85.1的公開agent_end／followUp沿原提示持續busy；Host的continue_maintenance核原session、當前Source資格及scope，僅準備到READY。普通read／reload不啟動，取消／無進展／上限／撤權／不明ACK停止，沒有背景AUTO、額外publisher／store／scheduler或metadata批准。原Stop入口也使用公開clearQueue，再abort當前工作。

### 瀏覽器中斷後的停止邊界修補

真入口沿原會話、同模型high保存39項後，驗證Bash／瀏覽器被中斷；driver沒有完成收據。SDK其後出現semantic_request_cancelled_or_unavailable，卻仍派送當前工具批次／下一回合。只disarm下一段foreground不足以停止現行prompt；原throw也遺失requestId。已先對帳並由公開Stop中止、清空queue，沒有重新送原準備。

修正為回應不明／錯誤ACK／原生準備不明時使用SDK公開ctx.abort中止同一prompt；寫入派送前及不明回覆的locators保存於**既有Pi session**，僅作關聯／對帳，不是業務狀態權威或零效果證明。pre-native格式拒絕仍可修正，不誤標未知效果。固定SDK的三個回歸在修前均錯誤走到READY，修後保持DRAFT且不派送後續seal／模型重試；已部署映像內同三個離線測試也通過。此為合成故障驗證，不冒稱真正首輪／第二輪通過。

- 本次SDK／RPC 51/51、相關原生／transport 34/34；TS／target lint通過。兩組不同範圍，不與先前294或39累加為產品完成度。
- 下游585檔、原上游正反精確還原、映像source／artifact gates通過；單CPU／3GiB隔離建置。
- 新部署真入口讀回91 Dataset、Product schema及模型連線；切換前後兩HOME的40份session JSONL完全不變，Source grants／Query／Grafana設定不變。5檔LSP零errors但均inconclusive，不稱全域clean。
- 該次部署後唯讀核對原根仍DRAFTv137／68items／60資產，running=[]，沒有seal／consent／attempt。取消時已知pending child可讀回task_record_not_found。
- **仍有4筆舊逾時prepare缺少原requestId／child定位**：PurchaseOrderHeader、ShipMethod、Vendor、vVendorWithAddresses。root未增加不證明child不存在；未以相同值、例外、新UUID或新root追認／重播。另有已發出但無ToolResult的5個工具呼叫，與成功派送不同；原終止歷史保留。

後续允許沿原根準備有獨立證據、不同效果的新candidate／definition；這不解決上述4筆舊GAP未知結果。目前剩16資產尚未帳平；已定位的SpecialOfferProduct子review連結已恢復（先前Store誤稱已更正），其他適用語義及定義套用仍須續作，再進行精確整批確認。不得用大量HUMAN_VALUE／GAP替代主線；完整首輪確認／發布／讀回及真正變更第二輪仍未完成。

最新私有證據與恢復定位：`.local/evidence/semantic-foreground-stop-20261004-HJAdMP/CHECKPOINT.md`。此前續作／中斷證據：`.local/evidence/semantic-foreground-continuation-20261004-mnLrlc/`；更早格式修補證據保留於`.local/evidence/semantic-maintenance-format-deploy-20261004-jq3qCp/CHECKPOINT.md`。

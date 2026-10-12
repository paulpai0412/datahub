# SalesDatamart 再次中止：審核內容容量修正

## 現況

**本地修正與回歸通過；後續已與增量／閒置重連合併部署並完成真入口只讀驗證。** 詳見[部署紀錄](datahub-semantic-incremental-capacity-idle-deploy-20261011.md)。這次容量故障不是前一次已部署的 Aspect 重疊修正，也不是登入逾期已被證實。原失敗請求仍為未確認；沒有重送提示、準備或發布。

真入口只讀核對顯示：新草稿為 DRAFT v31，保存 15 項，7 個資產中已涵蓋 6 個。最後對 `v_sales_order_line` 準備 27 個候選，工具回覆 `service_unavailable`，SDK 按未確認操作契約中止。

## 診斷

以原候選、保存的定義提案及讀回的原生 metadata，在編譯器／驗證器邊界重現 `PublicationReviewError: invalid_semantic_review`。完整詞彙定義及階層逐欄重複，導致語義 context 為 93,555 個字元，超過既有 80,000 上限；整份 review 為 136,948 bytes，也超過 131,072 bytes 上限。Gateway 對這個未分類的內部錯誤回傳通用 503 `service_unavailable`。

沒有保留原線上例外堆疊，不能宣稱直接取得原程序的內部 stack。離線讀取 Adapter 使用受控 Source recipe fixture，避免取得來源憑證；候選、定義提案與其他原生讀取結果均保存在本機私有證據。此結果不是真模型重跑或原生寫入驗收。

## 修正

- 只有原本放不下的 Catalog review，才將重複定義按**完整內容的 SHA-256**保存一次。相同 URN、不同內容或階層不會被合併。
- 候選、理由、證據、順序、完整 Aspect before／after、版本、引用 guards 和治理範圍不變。
- Host 驗證字典格式、內容摘要與引用。父頁讀回前還原全部定義與階層，不顯示縮水內容。
- 未超限的既有 review 保留原格式與 digest。沒有修改舊原生紀錄、提高容量、拆欄位提案或讓 SDK 自動修補候選。
- ACK／UNKNOWN、ACL、CAS、相依漂移及真人整批確認規則不變。修正不替原失敗請求回填零效果證據。

修改位於 `publication-review.mjs`、`semantic-catalog-publication.mjs`、`native-semantic-tasks.mjs`，均在 `extensions/datahub-agent/integration/`。新增回歸：`tests/test_agent_semantic_catalog_capacity.mjs`。

## 已驗證

- 原完整 27 候選的離線編譯通過：context 74,120 字元、review 108,167 bytes，均低於原上限。
- 還原的完整 preview、三個 Aspect 的 before／after、候選 ID 與 candidate digest，與修正前完整提案精確一致；重新編譯的 plan digest 相同。全程無網路、無原生寫入。
- 合成 Host 流程：一筆完整 27 欄提案 → READY → 父頁 detail 完整還原 → 未確認不得發布 → 精確確認後發布一次 → 歷史可讀且保留人工 metadata。重複發布仍拒絕。
- 損壞字典、缺引用、不同階層及舊格式負例通過。
- 隔離語義回歸 **387／387 PASS**。LSP 有 advisory 與一檔未確認 coverage，不宣稱 workspace clean。

證據：`.local/evidence/semantic-sales-zh-new-abort-20261011-eqEAFnsl/`。完整業務語義品質及真實 changed-round 仍未完成。

## 待完成

本次修正後續已獲明確部署授權，三項合併切換並完成精確映像／真入口只讀核對；原本地驗證收據不改寫。27候選的真實新準備／發布尚未驗收。原草稿不自動續跑；後續維護需新的有界意圖，先讀回既有項目及未確認操作，不重送原請求。

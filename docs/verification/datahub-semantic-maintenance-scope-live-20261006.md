# 原生範圍／封存 JSON：部署與 Agent 驗證（2026-10-06）

後續使用者決定UNKNOWN先暫緩；新版本已部署，但r16仍未送審。此頁保留r15歷史，[目前部署與真驗證結果](datahub-semantic-unknown-deferred-live-20261007.md)優先。

**新版已部署；新 Agent 驗證已結束，仍是DRAFT，完整語義代管未交付。** 本次只授權部署及同對話／原計畫／原模型 high、最長45分鐘的新提示，不含真人同意、語義發布、SQL／ingestion或Source／模型變更。

## 已核對的實際行為

- 原登入狀態被導向登入頁。使用者親自登入新專用驗證瀏覽器；保留原登入與失敗證據，沒有讀取／代填帳密。
- 限制建置：CPU1、3GiB、swap0、隔離build HOME；builder已停止。App保持獨立588檔建置範圍、reverse精確還原原506檔；upstream lock不變。
- SDK→Host→合成原生API整合測試移至專案 `tests/test_agent_semantic_maintenance_scope_sdk.mjs`，避免獨立runtime測試依賴專案外部fixtures；移動後2/2通過。初始本地589檔證據保留，不冒稱為本次映像清單。
- 精確新映像source／browser artifact核對通過；映像內73項SDK／RPC測試及新scope schema／transport／錯view未確認收據檢查通過。這些是無網路、無主機憑證HOME的合成Host檢查，不是模型品質驗收。
- 只切換本案Agent runtime與browser assets設定；Core／MFE／Source授權／查詢連線／模型及high／預算不變。兩個既有HOME及41份對話journal在提示前保持原bytes。
- 官方 `/mfe/agent` 父頁／iframe真入口，切換後、提示前讀回原計畫 **DRAFT285**：全部既有active提案內容不變，選定91資產、16尚未準備。新的scope與unprepared分頁具同原生版本與scopeDigest。
- `sealing.checks` 真實指出只有選定資產尚未全部有紀錄；依賴等其他結構条件成立，`completeSourceInventoryRequired:false`。沒有用程式替Agent選資產、產生業務語義或放寬seal／真人確認。

新映像：`sha256:cc35a9de5980c403e6823d64472005831431c28b7bf7975bf846376ee890f983`。

## 新模型輪次（已結束，未達送審）

唯一新提示於 **2026-10-06 15:24:42.552Z** 被真入口正常接受。同原對話／Root／`openai-codex/gpt-5.6-luna/high`，最長45分鐘，只準備完整未核方案。

Agent自行讀齊scope五頁與unprepared，再檢查items及個別資產，正常保存12份新未核套用：Domain12、Term6。沒有新增欄位描述、Tag／Property套用或定義，沒有修訂／seal／consent／發布。模型於15:35:01Z正常結束，原生Task與完整pages獨立讀回 **DRAFT309／138active／154recorded／87of91／4尚未準備／selection null**；既有126份active提案內容保持不變，依賴未失效。數量不是有用完整方案或交付證明。

完整owned journal證明前景確實續作一次（142→154），其後無進展而停止，沒有Host／工具／runtime錯誤。最終Agent正確辨識當前4個未準備資產與非inventory條件，卻將歷史UNKNOWN作為四個資產都不能獨立維護的理由。核對歷史輸入：原操作是舊計畫的GAP保存、沒有candidate，不是Dataset語義發布；原請求定位／效果仍未決，不能由缺少active項目推論零效果或重播。**本輪未嘗試這四項的獨立有據提案，也沒有Host拒絕此類提案的證據。** 不以放寬guard、排除資產、空KEEP／GAP或盲目補提示處理。

只讀最終比較caller首次用了不存在的itemId，誤報內容差異；原失敗保留，僅改用公開id後核對全部原提案一致，沒有修改來源資料或產品來滿足錯誤報告。

完整有用方案、欄位與Tag／Property用途自查、一個可信父頁精確整批真人確認、原生發布／UI读回，以及真正變更後的維護輪次仍未完成。唯一新提示授權已使用；下一次live提示／部署需另獲授權。

私有證據：
- `.local/evidence/semantic-autonomous-plan-20261005-ScQzQE/native-scope-contract-deploy-20261006-IUkwEt/`
- `.local/evidence/semantic-autonomous-plan-20261005-ScQzQE/native-scope-contract-r15-20261006-IUkwEt/`

不要重跑既有成功建置／部署／讀回helpers、r13／r14／r15提示或已ACK操作；這不是額外發布授權。

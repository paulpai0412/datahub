# Source 授權後的 Catalog 人工送審恢復（2026-10-03）

## 結果與範圍

已部署授權語意／action 參數提示修正，並經真 `/mfe/agent`、目前設定 GPT-5.6 Luna／medium，建立一筆 Product Identity Glossary Term 定義的原生待審紀錄。1 新 session、1 訊息、1 `prepare_review`，自然停止；不是 fixture 或直接 shell/API 建立提案。

原生讀回 PENDING、相同 plan digest／review reference；Product 的原始 snapshot/current/fields 不變，新 Term 尚不存在。未批准、未發布、未建立關聯、未 SQL／ingestion／AUTO，沒有調整使用者已保存的 Source 三項權限或兩條查詢連線。

**這筆是有時效的驗證提案，不是已建立的 Term。** 17:52 建立，18:02:24 到期；到期後仍可讀明細／稽核，發布按鈕確實停用。沒有延長、重播或另建立第二筆。其餘七組 Terms、Product 關聯與正式發布仍未完成。

## 原因

1. Source 的真人送審、共用定義新增／更新三項批准已在可信 Host 生效，Product 在 91 個選定 Dataset 中。不能再稱使用者沒有授權。
2. 最新對話的 Catalog 呼叫缺 `sourceUrn`，或在 list_assets 帶不接受的 query／assetUrn；又轉回 legacy inspect_dataset 第一頁帶無 snapshotDigest 的 offset。原始錯誤是 invalid_semantic_catalog_request／invalid_semantic_request，沒有送審嘗試。
3. 讀取／預覽固定 `publicationAuthorized:false`，代表沒有這份提案的真人執行 consent；不代表 Source 送審 grant 為 false。舊完整來源 inventory 缺口不能套到精確 Catalog 人工送審。

## 修正

- 可信讀回新增 `reviewPolicy`：目前 Source 的送審／定義新增／更新政策資格、必須真人批准、不能直接發布。原生 ACL、證據、衝突、版本及完整共用更新影響仍另行核對。
- 每個 list_sources entry／Catalog preview 提供此資格；不放進 source identity 或穩定 review context／digest。原始 policy hash 仍綁定，不讓 delivery guidance 破壞舊審核。
- SDK tool／skill明列每個 Catalog action 必要欄位及 paging，區分 grant 與 consent，禁止錯誤時改走 legacy 以繞契約。
- 唯讀格式錯誤給固定、有限提示，不自動修參數／重試／回顯 payload。未知 preparation 繼續保留 reconciliation／no-retry。

## 證據

- 7 新回歸：原錯誤→正確明確 scope→PENDING fixture／零 target writes→撤權拒絕，穩定 context/digest，SDK false guard，unknown不重試。
- 62 相關 Node 檢查、TypeScript／target ESLint通過。LSP7paths無 reported errors，29 auxiliary hints/warnings、2inconclusive；不是全專案 clean。
- 凍結583Pi-web檔／runtime image原碼吻合／browser artifact gate通過；downstream只有SDK／skill2檔差異，reverse原506baseline與既有 .venv foundation通過。
- 舊兩 HOME 的38session檔 SHA/size/mtime不變，新增僅此次授權 session；Sales7Dataset69fields原生scope不變。所有 config 值除 image/assets 外保留。Core無本地patch。
- 真入口讀回25欄、Source three eligibility true而publicationAuthorizedfalse；模型完整讀兩頁、搜尋、預覽、準備一次、讀回PENDING。
- 到期後真 parent審核明細顯示Product Identity並停用批准按鈕；未選取／批准。

私有證據 `.local/evidence/semantic-review-contract-recovery-20261003-w9BHH0/`：authority、frozen inputs、原準備／登入錯誤与對帳、launch、live-readonly-receipt、agent-driver-receipt、native-pending-receipt、pending-card-r3-receipt、HOME preservation。憑證／cookies／私有metadata不提交。

## 操作

刷新整個DataHub頁面，使用相同Source走Catalog preview→prepare_review；不需要再開權限。真人於提案卡開啟Review／Approve核對精確差異與證據。已到期的驗證紀錄僅供稽核，不能發布；正式工作應重新讀目前metadata並產生新提案，不重播舊UUID、快照或attempt。定義批准並讀回成功後才另提Product／欄位關聯。

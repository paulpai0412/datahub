# 512KiB 唯讀部署：新契約76目標預覽通過

## 目前結論

2026-10-02 已依使用者批准完成受限建置、唯讀切換及精確契約啟用。初始舊審核明細與新規劃器各發現一項問題；使用者明示測試階段不處理舊資料，並另准只修新規劃器。05:38Z 真入口經 Host 完成 **7 Dataset／69欄、76個目標的同快照差異與證據預覽**。這輪唯讀新提案預檢成立；沒有執行發布，**不是完整代管或真兩輪驗收**。

- 580 個 Pi-web 檔案：目前來源、凍結 context、image 的 bytes／mode 相同；browser assets／runtime adapter／package lock artifact gate 通過，builder 已停止。
- Image：`sha256:a8c048ecc459d3797aa2d8666af11dcfd097f0d2dc2f38a672d72843f686d456`。
- 契約：`extensions/sales-datamart/metadata/metrics.md`，36,937 bytes，SHA `638826bfae0e1e40e8eb76430dad2d7436aa5d9acec2e16143794818db5be624`；四個 ETL／SQL 實作來源 pins 均相符。舊契約保留於私有證據目錄。
- 維持 publication=false、無 AUTO／auditRecovery，同 Agent／audit audience／Source／7 Dataset，沒有模型訊息或 Catalog／Task／Run／Decision 寫入。

## 已驗證的現場範圍

使用者重新手動登入 DataHub 後，核對可信身分、session 閒置、原生基線。新服務的真入口可開啟，scope 仍為 7 Dataset／69 欄、相同 successful ingestion／recipe／schema fingerprint；原 r2 輪次仍 accounted 25／missing 51／未關閉。這不是全庫 inventory 或維護完成。

初切換失敗後與新規劃器續驗後的唯讀對帳分別確認：

- 初切換失敗後：r2 Run／Task、r1 Run、既有成功欄位的完整 Aspect 未變；未重播原 attempt。
- 七個 Dataset 的 schema、description、Domain／Tag／Term／Structured Property 等完整讀取快照未變。
- 兩個 HOME 的 35 份 session bytes／size／mtime 均未變；既有 78 則訊息未變。
- MFE 實際 served bytes 與本次產物相同。

## 舊審核相容性限制（依最新決定不修復）

既有成功審核的 `read_review`（receipt mode）回 HTTP 400／`semantic_invalid_evidence`，完整明細 loader 因此拒絕。不是 512KiB 容量問題，也沒有重播原 attempt。

原生審核儲存的證據 ID 是 `field:11:contract-metric-17`。離線以相同原生 schema／request 投影驗證：此 ID 在原契約存在，在新 scoped 契約不存在；新契約刻意改以精確 target 的 `contract-statement-*` 投影，不混合舊公式。

目前呼叫路徑：

`native-semantic-tasks.read` → `readCatalogReviewContext` → `inspectCatalogIntent(saved.request, {readback:true})` → `selectedEvidence`。

歷史讀取仍把舊 proposal evidence IDs 對照目前契約驗證，在返回原生儲存明細前失敗。應區分「現在能否讀取原生歷史」與「舊提案現在能否發布」；修正仍須保留當前身分／Source／資產及引用 ACL，不可略過權限、把證據漂移視為目前有效或追認 UNKNOWN。

## 新規劃器的因果修復與恢復

使用者選擇不修復舊審核後，續驗新提案。四個維度Dataset／28目標通過，第五個Dataset的規劃卻回 `task_owner_mismatch`。受控唯讀診斷證實：既有Dataset描述的原生provenance指向同actor、不同Source的Run；錯誤位於 `task-records.mjs` 的 `priorSemanticSelection`，不是目前登入身分或資產ACL失敗。

只修改該判定：不同Source不能成為本Source的Agent基線，回既有 `NO_AGENT_BASELINE`；現有非空值仍走人工保護，不認領或自動覆寫。沒有新增fallback、catch-all或狀態框架；getRun的身份／API ACL／Task-Run綁定及後續相同Source的Agent／scope檢查均保留。未修改舊審核reader，也未遷移、刪除或寫入舊資料。

本地8項新回歸包含於相關 **345/345 PASS**：保護舊Dataset值、讓空白新欄位實際走fixture發布成功、保留原歷史；相同值KEEP不認領；身分／ACL／binding／transport錯誤仍拒絕。原RED保留。另修一項舊測試將部署契約SHA硬編碼為原版本的耦合：改用獨立legacy projection fixture，固定檔案與scoped sources讀取仍由既有contract-evidence測試覆蓋，不改現場契約求綠。Node syntax／scoped diff檢查通過；3檔fresh LSP無reported errors但皆inconclusive，不宣稱全clean。

依新增精確批准，只重啟本案Host載入修復，image／MFE／契約／配置皆不變。新入口24個唯讀Host呼叫完成全部7 Dataset／69欄及view的20+4分頁：

| 規劃結果 | 目標數 | 目前行為 |
| --- | ---: | --- |
| ADD | 73 | 有精確契約證據的新增預覽，未寫入 |
| REVIEW_HUMAN_OR_CHANGED_VALUE | 2 | fact Dataset描述及salesorderid欄位受保護，未覆写 |
| UPDATE_AGENT | 1 | linenetamount的原生Agent基線可核；只是新版技術敘述候選，未更新 |

76個目標皆 `READ_ONLY`，before與目前值逐項相符，完整提案依Dataset合併而不是依讀取頁拆寫；最大preview 31,838 bytes、最大request 9,334 bytes。reload保留78訊息；最後七個Dataset完整Aspect及兩HOME／35session bytes、size、mtime皆不變。

## 限制與下一步

新提案唯讀預檢完成；舊契約review讀取失敗仍是保留的已知限制，不冒稱已修，也不再以此旁支取代新主線。真新模型／Task／Run／Decision／Catalog寫入、native新收據／完整明細及真人審核入口、真實變更第二輪，仍需各自精確批准與證據。本次沒有新寫入，故不能以76個preview代替首輪維護。手機／桌面新原生明細尚未live驗收；先前synthetic證據只證其原範圍。

預檢 helper 曾把外層 `preview/1` 誤認為內層 `managed-scope/1`；原錯誤保留，使用同一成功回覆完成核對，沒有重播請求。這與上述真 Host 400 阻擋分開記錄。

私有證據：`.local/evidence/semantic-512k-readonly-deploy-20261002-5dFcns/`，新規劃器修復及實際恢復在 `new-planner-fix/`，含原failure、部署intent／launch、before／after、session preservation及測試RED／GREEN。不公開登入state／config／真實metadata。回顧：本案兩次失敗都來自現場既有證據／主責資料與乾淨fixture的差異；只修阻擋新提案的主責分類，不藉測試階段放寬ACL或自動覆寫舊值。

# 原生 Task／Run 歷史保留插件設定

**狀態：2026-10-01 14:25Z，經具名批准，兩条精確政策已透過官方公開API套用並讀回；YAML已放入使用中的plugin目錄。未執行system-update／重啟／業務metadata寫入。**

`ekop-agent-history.yaml` 使用 DataHub **v1.7.0.1** 的官方 retention plugin 格式，只新增兩個精確規則：

| Entity | Aspect | maxVersions |
| --- | --- | ---: |
| dataJob | ekopAgentTask | 2147483647 |
| dataProcessInstance | ekopAgentRun | 2147483647 |

這是使用者核准的原生正整數上限，**不是數學上的無限保存**。會增加歷史儲存量；套用範圍是所有使用這兩個插件 Aspect 的實體，不只 SalesDatamart。沒有 wildcard／時間規則／forceOverwrite，不改 Dataset、Source、標準 Task Aspect 或全域 retention。

## 為何需要

13:38Z的現場唯讀核對證明兩者當時繼承全域20版本：r2 Run最新53、52可讀、1回空。Host須讀Run固定的Task版本；Task多輪改版後若該版被清除，即使Run目前值還含完整Decision，Host也不能拿最新Task冒充舊版授權。修復層應是官方原生保留設定，不是放寬reader、回填版本或另建store。

固定Core的 `RetentionService.getMaxVersionsToKeepForWrite()` 在沒有version policy時回傳1，故不以空`retention`宣稱可無限保留。不得停用retention service作為解法。

## 本次精確套用證據

使用者選 `approve_exact_retention_apply` 後，以 `/openapi/v3/entity/generic?async=false&systemMetadata=true` 各新增一次 `dataHubRetentionConfig`，每筆帶 `If-Version-Match: -1`，不覆寫既有設定；官方API同時建立相應原生key Aspect。兩筆均獲ACK並按ACK的version1讀回，再核當前exact key優先解析為2147483647。5個其餘fallback鍵完整前後相同，全域20沒有改動。

YAML已用不覆寫方式放至 `.local/plugins/retention/ekop-agent-history.yaml`（0644），SHA256 `1d82c3884145c80a133661c46e619cea13dffd39659af23ff15ac0319ab36c35`。政策由真登入actor透過API建立，**不是偽裝成system actor**；後續YAML相同即無需更新，差異仍遵守官方對user-managed政策的保護，不加forceOverwrite。

私有收據與一次性操作程式：`.local/evidence/semantic-retention-apply-20261001-f5jKds/`，含before、逐筆intent／ACK／exact readback、after及receipt；8項合成操作測試涵蓋衝突、失ACK、身分撤回與部分成功，不是另一套服務。沒有執行全域／批次歷史裁剪，也沒有為驗收額外更新Task／Run。**這证明原生政策已設定，不等於現場已完成超過20版的業務維護驗收。**

## 接入與後續變更界線（後續操作仍須批准）

- 官方路徑為 `/etc/datahub/plugins/retention`（`RETENTION_PLUGIN_PATH`）；本案 `deploy/compose.local.yaml` 已把 `.local/plugins` 唯讀掛到GMS及system-update。**不用新增mount、修改Core或重建模型jar。**
- 經批准後才將候選複製成 `.local/plugins/retention/ekop-agent-history.yaml`。公開插件目录0755、檔案0644；`.local`／憑證權限不動，不覆寫其他插件檔案。
- 固定版本只在官方 **non-blocking system-update的IngestRetentionPolicies步驟** 讀取YAML；單純放檔或重啟GMS不是套用證據。
- 該步驟也合併bundled defaults與其他plugins，可能套用其他政策；執行整輪system-update前須檢查所有預期差異並取得相應授權，**不可把它宣稱只寫本案兩條規則**。本次沒有執行它，也沒有新增第二套publisher／啟動自動更新。
- Upgrade所用registry必须已有兩個Aspect，否則官方loader會skip；不能只因GMS目前可讀就假設upgrade registry相容。
- 若exact key已有人工管理政策且不同，保留官方的skip／報告行為；不設forceOverwrite或全域overwrite旗標繞過。套用後必須從公開API讀回兩個exact key與effective policy，核無關政策未變；再批准後續維護寫入。

## 升級、回復與現有缺口

- 新設定只能保留尚存與後續產生的版本，**不能復活已不可取得的舊版**；保留既有成功、UNKNOWN與failure證據，不改原Task／Run locator。
- 刪除候選檔不表示原生policy自動回復。降低上限或重新套用20可能立即裁剪歷史，是另外的破壞性操作；不得隨程式回滾自動執行。
- Core升級時要再核YAML解析、exact key優先、registry載入、int上限、寫入保留和舊版本API；本地fixture不代替升級實測。

## 本地可重跑檢查

```sh
node --test tests/test_agent_semantic_retention.mjs
```

使用已鎖定依賴的YAML parser及既有synthetic public-API fixture，不連服務、不讀憑證。覆蓋原20版本缺失、候選下Task v1／Run v1跨越20版本仍精確可讀、stale CAS拒絕、後加設定不恢復缺失、原累積Decision保留及未改其他Aspect政策。

這些是宣告配置與native caller seam驗證；本次真實API套用另有上段證據，**未執行官方system-update，也尚未以真Task／Run跨20版驗證保留行為**。現場證據及邊界見 [唯讀預檢報告](../../../../docs/verification/datahub-semantic-maintenance-readonly-preflight-20261001.md)。

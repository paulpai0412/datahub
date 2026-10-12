# 資料庫連線＋語義來源設定 UI 合併部署（2026-10-02）

## 結論

依使用者「先支援 SQL Server」、「允許 UI 輸入／更新憑證」及「兩個設定 UI 一起打包部署」決定完成。真 `/mfe/agent` 的 **設定 → 使用來源／資料庫連線** 均已可操作；沒有替使用者保存任何真連線或來源 grant，也沒有執行業務 SQL、模型訊息或 AUTO。

- 最終 Host PID：`1358452`。
- 現行配置：`.local/agent-server-connection-source-settings-20261002-rbipnm.json`。
- 配置 SHA：`151b57a54aade4098256856032cea5947846df1fcd934f61b440dae49e6de8ac`（管理員日後保存設定會合法改變此 SHA，不應硬套成永久版本）。
- Image：`sha256:450d47f2d9180ed8a158b02d4abcee5c927b3c2b09733d94d0101d366915bfb0`。
- MFE `remoteEntry.js`：`81a1f1e635641b1d8b446009334d94fabb7cf0c00e2091fb39f62b25574be03f`；`492.js`：`f82a036c7ce9b4c3a314232340deb0a3879b7dcc55d9e00c69e9b98da36a257f`。
- 583 個 Pi-web source bytes／mode 與映像逐檔對帳，browser assets／runtime adapter／package lock artifact gate PASS；downstream patch 可精確 reverse 至固定 upstream baseline。
- 原 SQL／Grafana queryConnections、queryGrafana／subject mapping、backend key reference 及語義政策保留；啟用 `sourceSettingsEnabled`、`connectionSettingsEnabled`，不改 DataHub Core。

## 直接驗證的使用者行為

| 行為 | 證據 |
| --- | --- |
| SQL連線新增／保存／修改／留空保留密碼／停用／reload | 隔離真 React SettingsPanel → 跨origin正式MFE → 真Host／受保護fixture檔案通過；metadata及connector為fixture，不是真來源保存 |
| 測試連線 | 只接受固定 SELECT 1 的 child契約，rollback／close與錯誤清理通過；此次未對真來源按測試 |
| 密碼邊界 | 只出現在父頁表單／Host；回覆無password/path、iframe無password欄位，保存／關閉清空；無模型工具入口 |
| 權限與並發 | 原生admin不足、偽身分、iframe origin、缺proof、舊revision、外部改檔、並發保存、重複定位、無效connection欄位拒絕 |
| 查詢整合 | source/connection共用CAS，互相保存不丟另一方設定；未變binding可讀，修改／停用拒絕舊結果及失效中的execute |
| 真資料庫連線設定頁 | 1440／390px：既有SalesDatamart清單與讀回、新增表單、AdventureWorks metadata搜尋、取消及reload通過；不保存／不測試真連線 |
| 真語義來源設定頁 | 原no-referrer阻擋已修復，原生清單6個來源可讀；既有受保護來源明細7Dataset／69欄可讀，save維持禁用，不覆寫部署管理政策 |
| 歷史與服務 | 兩HOME／37份歷史session SHA、size、mtime不變；目前7／69語義scope fingerprint不變；原query/semantic配置完全保留 |

本地：66/66 scoped Node、8/8 Python PASS；TypeScript與scoped ESLint通過；1440／390真React／MFE／Host fixture通過。CSS另增加66px實際窄容器回歸。LSP scoped無reported errors但多為inconclusive，不聲稱全專案clean。

## 修復與部署過程

1. 接手另一會話已切換的來源設定版本 PID1074707／image e8581553。其UI因 `document.referrer` 與Gateway no-referrer衝突而未送出來源清單；已存在本地修正，本輪保留並一起封裝，不回退舊semantic-only配置。
2. SQL連線保存與來源保存會寫同一operator JSON，因此整合原CAS／lock／atomic保存主責，沒有新增業務狀態庫。憑證採新受保護檔案再切binding，不把密碼塞operator JSON或覆寫in-flight讀取的舊檔案。
3. 第一個本地browser紅燈是新增表單誤讀不存在的 `initial.binding.enabled`；修正可選屬性後完整流程恢復。
4. 第一個合併部署 PID1297450／image60544d已接通真安全表單；1440px通過。390px的底層DataHub側欄讓設定區只有66px，ConfigButton原本nowrap產生溢出。只修共用設定按鈕換行，窄容器及來源UI回歸通過；第二次凍結與前次 **只差同一CSS檔**，Host／MFE程式不變。
5. 用相同1CPU／3GiB／no-extra-swap／serial builder協議重建並切換最終版本；builder已停止。保留每次原始失敗，不重新執行SQL或metadata寫入。
6. 真UI檢查器另有兩個觀測錯誤：label模糊命中TLS與同意checkbox，以及mobile reload後等待隱藏的聊天textarea。修正精確selector、desktop reload／attached判斷後唯讀驗證通過；不是Host或來源執行失敗。

## 證據位置及未驗範圍

- 本地：`.local/evidence/connection-settings-local/`；最終connection browser `connection-settings-browser-xvtN7L`，來源browser `source-settings-browser-lFoDDe`。
- 第一輪：`.local/evidence/connection-source-settings-deploy-20261002-R165hX/`。
- 最終：`.local/evidence/connection-source-settings-narrow-20261002-rBipNM/`，包含 `live-ui-receipt.json`、`source-detail-receipt.json`、image/artifact proof、config/source hashes、session snapshots、原始失敗與截圖。private metadata／端點／憑證／cookie不公開。

**未驗收／未執行**：AdventureWorks新真連線保存、真密碼更新、來源連線probe、各表SELECT權限及新的Agent SQL／Grafana模型閉環。這些需管理員在UI輸入／確認真正的唯讀帳號後操作；不以fixture的保存或既有SalesDatamart歷史成功代替。語義AUTO與Source grant同樣沒有自行啟用。此次完成的是可交使用者操作的合併UI與既有功能保留，不是新增來源業務資料驗收。

操作說明：[資料庫連線](../design/datahub-agent-connection-settings.md)、[使用來源](../design/datahub-agent-source-settings.md)。

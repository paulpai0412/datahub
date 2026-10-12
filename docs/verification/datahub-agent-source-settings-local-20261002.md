# 使用來源設定：本地驗證（2026-10-02）

## 結論與證據層級

「設定 → 使用來源」的 React 設定頁、可信父頁面確認及 Host 配置保存已在隔離環境接通。**未部署、未呼叫真實 DataHub、未啟用 AdventureWorks、未開啟 AUTO，也未送出模型訊息。**

- 最終相關 Node 回歸：393/393 PASS，涵蓋 semantic、Task、gateway、native ingestion、server、來源設定及設定導覽。
- TypeScript `tsc --noEmit` 與三個相關檔案 ESLint：退出碼 0。
- 最新 browser fixture：`.local/evidence/source-settings-browser-aoMGh9/receipt.json`。
- 真 React `SettingsPanel`／正式 CSS → 跨 origin iframe MessageChannel → 正式 MFE source bridge → 真 Host 邏輯；原生 DataHub API與operator配置檔為 synthetic fixture。不是 live DataHub E2E。
- 1440／390px：91 Dataset全選、新增、父頁真人確認、取消不寫、移除1項精確差異、90項範圍保存、停用及reload皆 PASS。停用後實際 semantic reader拒絕；不直接以UI顯示冒充效果。
- iframe直接送save被拒；Source名稱中的`<script>`只呈現文字；錯actor／origin／proof／admin撤權拒絕；沒有啟動runtime。
- 已驗證配置revision／plan衝突、並發保存、外部配置變更、ACL／provenance／removed負例、其他actor及部署端政策保留。
- 保存後真 Catalog reader跨5頁取得91筆，inspect及proposal preview可用，但publication仍false、businessMeaningVerified仍false。
- Source撤權發生在await中與HTTP回傳前，皆不回傳受撤權資料。
- 最終 scoped LSP：7檔零reported diagnostics，但全部inconclusive（silent-on-clean）；不可宣稱LSP確認clean。session cache `mode=all`亦無warning。以成功typecheck／lint／runnable tests補充其證據，不當作全專案clean。
- scoped `git diff --check` PASS，Core submodule乾淨、無staged變更；既有大量WIP未重設。

## 可重跑檢查

```bash
node --test tests/test_agent_source_settings.mjs tests/test_agent_gateway.mjs tests/test_agent_server.mjs
node tests/check_agent_source_settings_browser.mjs
cd extensions/datahub-agent/pi-web
node_modules/.bin/tsc --noEmit
node_modules/.bin/eslint components/DataHubSourceSettings.tsx components/SettingsPanel.tsx lib/settings-navigation.ts
```

Browser script只開啟兩個臨時loopback fixture server，阻擋其他browser origin，使用臨時synthetic配置；finally關閉browser／server並移除臨時配置。畫面及receipt存入gitignored `.local/evidence/source-settings-browser-*`。

## 修正與回顧

- 首版測試fixture缺status version、誤用reader return shape，已修fixture／assertion；未改產品契約迎合mock。
- 加入正式Settings CSS後發現內容需要容器捲動，已修來源panel，手機可操作完整保存流程。
- HTTP撤權測試發現assertActive包裝讀回被替換的context造成遞迴；改為捕捉原guard，原生身分／browser grant及來源撤權guard均保留。回歸證明舊請求不洩漏回應。
- 本次重用既有Host配置與原生權限；未新增datastore、Core patch、scheduler或publisher。

## 尚未驗收

- 真實DataHub入口、原生Source／Dataset ACL、實際91筆盤點延遲、Host重新啟動後的配置讀回。
- 部署artifact／下游patch鎖更新及精確image驗證；本輪未跑`next build`，未切換部署。
- AdventureWorks成功Run多版本範圍、835目標AUTO政策及證據閉環；UI新增不解除這些阻擋。
- 正式獨立review未執行；本輪維持main-only。

使用及限制見[設計／操作說明](../design/datahub-agent-source-settings.md)。下一步需要另行確認受限建置／部署及真入口驗證範圍，不能重用先前已消耗的deployment intents，也不能藉UI先開AdventureWorks讀取而違反完整AUTO後一起啟用的決定。

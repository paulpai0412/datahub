# DataHub Agent：隔離 baseline 與 MFE／identity 契約

整體 A01–A15 **未完成**。本文件是進度證據，不是部署／安全／UI／模型驗收報告。

## 已執行

- 完整 pi-web upstream `b1a72962d385db4a82b93ad5802e9024d5b44874`，未刪功能或測試。
- 本專案 baseline image：`sha256:6212fb3a19251575911cb23b1a8d065c1c74f8050b1f06dc8b4506ba3aa6c1f7`。
- Node base 固定 digest，Docker build context 僅 pi-web；`npm ci --ignore-scripts --no-audit --no-fund`。未載入 host HOME、Pi 設定或模型／DB 憑證。
- 測試容器 non-root、`--network none --cap-drop ALL --security-opt no-new-privileges`。最後 baseline 複驗另限制 2 CPUs／3 GiB。
- `tsc --noEmit`、`npm run lint`、upstream **973 tests PASS，0 skipped**。真 `node-pty` shell smoke `pty-ok`，不是只 mock terminal。
- 初次 972/973 的失敗來自 image 缺 Git；加入 Git 後全通過，保留失敗 log，不刪測試。曾有 npm network failure，保留 log。
- 新 MFE 使用官方 Webpack ModuleFederationPlugin，固定 webpack `5.110.3`／webpack-cli `7.2.3`，保留 package-lock。產出 `remoteEntry.js`／`datahubAgentMFE/mount`；沒有手刻 Federation loader 或修改 DataHub。
- MFE 3 個子契約（Node 顯示 4 tests）PASS：bootstrap 不傳 caller actor、拒絕不符使用者子 origin 的 launch target、cleanup 後晚到結果不再掛載。使用 synthetic DOM／gateway，不是 browser E2E。
- Identity 6 個子契約（Node 顯示 7 tests）PASS：真 loopback HTTP＋synthetic identity provider；固定官方 GraphQL 路徑、只轉發 session cookie、拒絕 forged／duplicate／malformed cookie、HTTP／GraphQL／response limit／error redaction。
- 本地真 DataHub frontend 的 **無 cookie、無效 cookie** identity requests 均返回 HTTP 401。沒有使用真登入憑證；這不是成功登入或 SSO 驗收。
- 原 foundation 3 groups 再次 PASS；upstream 506 檔 source baseline 未改。
- `browser-grants.mjs`：一次性 ticket、actor/origin 綁定、90 秒 lease、identity 續期、撤銷／restart fail-closed、容量與 connection 上限；6 cases PASS。
- `gateway.mjs`：root Host／DataHub Origin／identity 驗證、一次性交換、HttpOnly Secure Partitioned cookie、受限 HTTP proxy、Cookie/Authorization stripping、runtime origin 不可呼叫控制面、stream revoke callbacks；4 HTTP 子契約 PASS（synthetic identity/runtime）。未宣稱真 SSE 連線撤銷 E2E 已測。
- Chromium `153.0.8010.12`、1280×720、全新無憑證 context／HOME、sandbox enabled，只允 localhost 流量：兩個 48hex 子 origin 的 cookie/localStorage/SW/cache 隔離 PASS。
- 同一 Chromium 執行真 Webpack Federation mount＋gateway＋HTTP proxy：bootstrap cookie、fragment 清除、download、不同使用者 storage、帳戶切換 heartbeat 拒絕並移除舊 frame、cleanup PASS。Identity 與 runtime 是合成 fixture；**不是正式 DataHub SSO、pi-web UI 或容器隔離驗收**。
- Browser harness 初次 CommonJS named import 失敗，改用官方 CJS default export；下一次因 fixture 把 Federation init 當 Promise 失敗，依真契約改為 await（可接受 undefined）。保留 debug log，沒有改產品來遷就 fixture。

## 功能矩陣與未驗證項

| 保留功能 | 已有證據 | 仍必要的 live 證據 |
| --- | --- | --- |
| Chat／stream／abort／steer／follow-up／compaction | 原 973 tests | 真模型、新 session、SSE 重連與取消 |
| Models／API key／OAuth／thinking／tools | 原 source/tests | 使用者在新設定頁配置後，真 provider／popup／reload |
| Skills／Agents／Plugins | 完整 source/tests；未在本次執行動態安裝 hooks | 隔離使用者 install／disable／reload／權限 |
| History／search／rename／delete／fork／branch／export | 完整 source/tests | 換皮後逐功能操作與跨使用者負例 |
| Files／upload／preview／watch／tabs／worktrees | 完整 source/tests，Git 補齊 | 真 files/worktree、dirty protection、path escape、隔離 |
| Terminal／resize／shell | 真 PTY smoke | iframe 中真互動、SSE、撤銷授權與網路隔離 |
| Draft／localStorage／service worker／PWA／push | 原 source/tests | 子 origin 隔離、登出／帳戶切換、browser permissions |
| Layout／theme／responsive／IME／keyboard／a11y | 設計文件 | UI v0、使用者視覺確認、browser acceptance |
| MCP settings／Sources／worker／approval／Registry／Task／Decision | 設計＋離線 connector catalog | 實際實作、持久狀態、負例、GMS readback、live canary |

## 目前部署邊界

沒有部署正式 Agent runtime／gateway／MFE，也沒有變更 DataHub MFE 配置。Bootstrap／短效 grants／proxy 已有 source 與合成驗證；browser grants 是記憶體狀態，restart 全撤銷，不是 workflow persistence。真 runtime provisioner、網路／volume 隔離、egress、官方 DataHub 登入、持久 Source／jobs／worker 仍未實作。

Ingestion secret／人工 approval 必須落在可信控制面 origin（例如 DataHub MFE parent），不能放到可被 terminal／plugins 控制的 runtime origin 再只靠同 origin cookie 當人工授權。現有 gateway 在 runtime 子 origin 拒絕 `/agent/*` 控制面操作；完整 Sources／approval 介面尚未實作。失去 parent heartbeat 最多保留 90 秒 lease、sweep 最多再 1 秒；不聲稱無 heartbeat 的登出立即撤銷。

未讀開發機憑證、未接來源 DB、未写 GMS、未修改 DataHub Core、未重啟其他服務、未 commit/push。

使用者最新決定「主agent執行執行」：主代理處理實作與安全自查，不派 reviewer。以上是主代理檢查，不是獨立審查；不豁免實際安全負例／live／隔離 gate。

## 證據與重跑

`.local/evidence/agent-foundation/`（gitignored）：

- `pi-web-image-build.log`、`pi-web-image-build-network-failure.log`
- `pi-web-baseline-tests-missing-git.log`、`pi-web-baseline-tests.log`
- `pi-web-baseline-checks.log`、`pi-web-baseline-final.log`
- `mfe-install.log`、`mfe-checks-final.log`、`identity-tests-final.log`、`tests.log`
- 最後複驗曾逾時且 identity log 為空；現場 swap 幾乎耗盡，沒有可用通過證據。確認無遺留容器後，以 1 CPU／256 MiB（identity）、512 MiB（MFE）同方式重跑 PASS。最後 source 以 `*-final.log` 為準，不能使用較早的 MFE log 代替 48 字元 DNS key 修正後證據。
- `embed-source-state.json`：先前切片 source／log SHA-256 與 image／Core refs。
- `gateway-tests-final.log`、`mfe-heartbeat-checks.log`、`origin-browser-final.log`、`gateway-browser-final.log`：新增切片最後狀態。`gateway-browser.log`／`gateway-browser-debug.log` 保存 harness 失敗原因。
- `gateway-source-state.json`：grants／gateway／heartbeat 與 browser harness 最後 source／log hashes。

離線 source checks：

```sh
.venv/bin/python tests/test_agent_foundation.py
node --test tests/test_agent_identity.mjs
cd extensions/datahub-agent/mfe
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run build
```

第三方 install/build/test 應繼續使用無憑證容器，build context 不擴到 repository／HOME。npm 安裝需要網路，實際測試與 Webpack build 不需要。source diff 檢查還需涵蓋 untracked 檔案，不能只看 `git diff --check`。

# Agent browser lease／多分頁生命週期

2026-09-11；主代理實作與自查，**非獨立審查**。A05 仍 partial，A01–A15 未結案。

## 真正重現的問題

1. 同使用者第二頁交換新 cookie 後關閉，第一頁 API **401 而非 200**。
2. 即使重用 cookie，兩頁首次同時交換仍會競爭 `Set-Cookie`；關閉最後寫入 cookie 的頁面會讓另一頁 401。
3. 切換 DataHub 帳號時，舊 MFE 被移除，但另留同 origin probe 後，舊 cookie 的 API 仍 **200 而非 401**。只驗 iframe 消失不足以驗證撤銷。

## 修正與權限邊界

- Browser session 與每個 MFE mount 的 lease 分開。持有有效既有 cookie **且**持有新的同 actor 一次性 ticket，才能加入原 session；不同 browser/profile 沒有 cookie，不會合併。只保存 token hashes。
- 每個 mount 單獨續期／釋放；最後一個有效 lease 失去後，整個 session cookie 與連線撤銷。RTE readiness 另外核對本次 exchange 的具體 grant，不能借用仍存活的 sibling 復活過期 exchange。
- Bootstrap 使用原生 Web Locks，在同 origin/storage partition 序列化交換；等待＋請求上限 25 秒。沒有支援時明示錯誤、fail closed，不以任意 client actor 替代認證。
- Parent bootstrap 另取得 32-byte `revokeToken`：**僅可撤銷**，不能交換 ticket、讀取 API 或單獨續期；不放在 iframe URL／cookie／storage／runtime。它綁定單一 grant，server 只保存 hash。
- `/agent/heartbeat` 必須有該 proof 與每次重新驗證的 DataHub 身分。偵測身份失效／變更或 verifier 失敗時，以 proof 撤銷該 browser session 全部 mounts；不影響同 actor 的其他 browser session。
- `/agent/revoke` 仍限 DataHub Origin 的 root 控制面，要求 proof，但不再依賴可能已消失的 DataHub cookie，因此登出後仍能釋放本 mount。沒有 proof、錯 proof、跨 origin、runtime 控制面呼叫不獲得權限。
- 身分變更必須被 heartbeat／cleanup 觀測到。網路中斷、crash、無 heartbeat 仍保留原本 **90 秒 lease＋最多 1 秒 sweep** 上限；不宣稱即時取得 DataHub 登出事件。

## 驗證

- Integration／MFE unit tests：33 tests，0 skipped；同 cookie 的成員到期／釋放、最後成員 callback、跨 actor／browser、stop-only proof、偽造 proof／origin、具體 readiness grant。
- Webpack MFE 重建成功；不新增依賴。
- Chromium 153.0.8010.12，sandbox、新 HOME／context：真 Federation＋gateway，依序／同時兩頁、故意延遲 exchange、同 actor sibling cleanup、跨 actor storage、舊 cookie 真 API 拒絕、清除 DataHub cookie 後 cleanup。
- 明確關閉 Web Locks 的 test-only negative control 得到預期 `401 !== 200`；部署 script 未加入 bypass。
- 真 production pi-web＋兩個受限容器：原頁面／session／PTY、Files、4 MiB upload/download/readback、SW、同 actor 第二頁關閉後第一頁與 PTY 存活、外來 terminal 404、切換／登出後舊 cookie 401，全部通過。
- 以上 browser 的 DataHub identity 是明示 fixture；**不是成功登入真 DataHub 的證據**。正式 entrypoint 對真 `localhost:9002` 的無／錯 session 拒絕另外通過。
- 所有自有測試 container／fixture volume 已清理，未停止其他服務。没有 model call、來源 DB／GMS write、DataHub MFE 註冊、常駐部署、commit/push。

## 映像／provenance

最終 runtime：

```text
sha256:b6e7b580ffedefbd09a299fb8a323dff02c1378eb04306792a250fdec4fe45f8
```

第一次 artifact check 抓到 host `runtime-entry.mjs` 與舊 image 僅格式不同，未忽略或更改 expected hash。保存差異、以現有 Webpack Dockerfile 重建，再驗全部 219 browser assets／operator modules／package-lock 完全一致，並重跑真 pi-web browser。原 506 檔 upstream baseline 再驗通過，沒有 downstream UI 變更。

## 證據與重跑

`.local/evidence/agent-multitab/`：

- `browser-red.log`、`grants-red.log`：原多分頁失敗。
- `concurrent-unlocked-red.log`：刻意取消 Web Locks 的競態失敗。
- `account-switch-red.log`：舊 cookie 仍可讀的失敗。
- `unit-final.log`、`mfe-build.log`、`browser-lifecycle-final.log`、`real-pi-browser-final.log`。
- `artifact-check.json`、`runtime-entry-format-delta.diff`、`runtime-rebuild.log`、`entrypoint-final.log`、`foundation-final.log`、`source-state.json`。
- `concurrent-unlocked-dns-failure.log` 為 harness Node resolver 不認得 Chromium 的 `*.localhost`；`probe-cross-site-denial.log` 為正確的 cross-site gate 拒絕。二者不是產品 red，沒有放寬 gate；修正 probe 後再取得上述真正 red。

```bash
node --test tests/test_agent_{browser_grants,gateway,transport,identity,server}.mjs \
  extensions/datahub-agent/mfe/mount.test.mjs
# 新 HOME + PLAYWRIGHT_BROWSERS_PATH；不使用開發者 Pi 設定。
node tests/test_agent_gateway_browser.mjs
# 額外需要已核對的 AGENT_RUNTIME_IMAGE、AGENT_BROWSER_ASSETS。
node tests/check_agent_pi_web_browser.mjs
```

待完成：成功 DataHub SSO／實際 MFE 註冊、其他瀏覽器與 bfcache/offline 等完整生命週期、OAuth／clipboard／installed PWA/push、A06 UI v0 與 A07–A15。不是以此作最終交付。

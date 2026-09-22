# DataHub Agent — 真 runtime／browser 驗證

日期：2026-09-10～11（本機）；**主代理自查，非獨立審查**。
母任務 `TODO-a2daa81d` 仍進行中，A01–A15 整體未完成。

本頁保留該輪 477b946… image／測試證據；後續多分頁、登出／切換帳號的真正 cookie 撤銷、source-aligned b6e7b580… image 與 33 tests 見 [browser lifecycle](datahub-agent-browser-lifecycle.md)。未將舊證據改寫成新 source 的驗收。

## 已驗證的精確範圍

| 項目 | 結果 | 不代表 |
| --- | --- | --- |
| 完整 pi-web production build | `next build --webpack`；一個 page worker；TypeScript／15 static pages 成功 | DataHub skin 已完成 |
| production image 原 upstream tests | 973/973，network-none／2 CPUs／1536 MiB | 全功能 live parity |
| integration Node tests | 25 tests、0 skipped；identity/grants/gateway/transport/server config | 真登入或模型執行 |
| 真容器隔離 | UID 1000、network-none、唯讀 root／IPC、cap-drop ALL、NNP、PID/CPU/memory limits | kernel escape／正式 security audit 已通過 |
| 每使用者資料 | 兩個 HOME volume；Alice/Bob marker 分離；重啟保留；錯 actor key 拒絕 | durable Source/job/approval 已完成 |
| egress | 預設拒絕；Alice 單獨核准 `https://registry.npmjs.org` 的無憑證 HEAD 200；Bob 拒絕；移除／重啟再次拒絕 | 私有 model/MCP endpoint 支援或模型 canary |
| 固定 browser assets | 219 個檔案與確切 image 全部 SHA-256 相同；operator modules、package-lock 亦匹配 | 任意 runtime response 可公開 |
| 真 pi-web + Chromium | 原頁面／session、真 PTY、Files、4 MiB download/upload/readback、SW、雙使用者、外來 terminal 404、account-switch heartbeat | 真 DataHub 成功 SSO、OAuth、clipboard、installed PWA/push、完整跨瀏覽器矩陣 |
| 正式 server entrypoint | 官方 `me` verifier 接線；真 `localhost:9002` 無／錯 session 拒絕 401；caller actor 欄位拒絕 | 已常駐部署、MFE 已註冊或成功登入 |
| upstream provenance | 原 506 檔案／mode／hash 再驗通過；DataHub submodule clean | 已開始換皮 |

本輪 pi-web image：

```text
sha256:477b946f5f05322c9328d529c76b69b360ebcbdedb11c7b896705418a82ea437
```

Build 有既有 export route dynamic-dependency warning，Google font TLS 曾自動重試一次後成功；不是無 warning build。未修改 upstream `package.json` 或原 baseline hashes，未改成 `next dev --webpack`。

## 實際邊界

- `runtime-manager.mjs` 只使用明確的本地 image ID，不 pull、不掛 developer HOME／Docker socket／來源或 GMS credential。
- Host 建立自己的 Unix listener；runtime 透過唯讀 IPC mount 主動連入，避免 host 連向 runtime 可以替換／symlink 的 socket pathname。
- 兩個 runtime 只看到 `lo`；直接 public IP／metadata IP TCP 結果為 `ENETUNREACH`，不是把 timeout 算 PASS。Socket replacement 為 `EROFS`；來源憑證的環境變數不存在。
- Egress 是 HTTPS:443 的 network-destination policy，不做 TLS interception／HTTP path approval。所有 IPv4 DNS 結果須為允許的 public address，並以已檢查 numeric IP 連線。IPv6、private/special/host IP 拒絕；移除政策關閉 tunnel。
- 單 gateway／scope、本機 Linux UID 1000；未實作多控制器共用 scope。啟動遇既存 container 狀態要求人工 recovery；不自動接管／重跑 ambiguous create。正式 HOME volumes 不因 shutdown 刪除。
- Source secrets／approval 仍必須留可信 parent/control plane。沒有把它們放進 pi-web runtime，也沒有以 iframe cookie 當人工 approval。

## 認證與 PWA 修正

1. 先前 fixture 錯誤地接受了 `gateway:password` Basic Auth；真 pi-web 要求帳號 `pi`，而且 pages 不接受 Basic。新的回歸以原 upstream token validator 得到 401，再改為直接重用 `createWebSessionToken()`，只注入私有 upstream cookie。DataHub cookie、browser grant cookie、client Authorization 不轉發。
2. 真 browser 發現 SW script／worker navigation 缺少 partitioned cookie；一般 window API fetch 仍帶 cookie。不能以放寬 API auth 或把 routing key 當密碼處理。
3. Gateway 改公開固定 SW/offline/icons/manifest，以及從 image 匯出的純靜態 HTML/client assets。**從 operator-owned artifacts 讀取，不是匿名呼叫 runtime**。有 agent cookie 的頁面／RSC 仍走 upstream；API、使用者檔案一直受 grant 保護。Static requests 不觸發 provisioning。
4. Native SW 仍保留，沒有停用 PWA 或修改 upstream SW。獨立安裝／新視窗／push 與非 Chromium 行為仍待驗。

## 保留的失敗與證據限制

- 初期測試 fixture 用錯 gateway 參數，且 startup 失敗時清理不足，造成測試程序不退出；已補 cleanup。另修 IPv6 URL bracket hostname 的 fail-closed 驗證。這些不是 pi-web build 問題。
- 最初 browser harness 在 frame commit 後立即再導覽，會中斷 bootstrap／assets；現改等 document load，並允許 native 自行更新 session query。失敗前先保存診斷與 screenshot。
- 曾觀測 `ERR_CONTENT_LENGTH_MISMATCH`。Relay 原本第一側 close 就 destroy peer，有未排空 buffer 的風險，現共用雙向 EOF/drain helper，強制取消仍關閉兩側。
- **單程序大檔檢查與重建舊 relay image 的 A/B 也通過**，因此不能把該用例寫成穩定 red/green，或宣稱所有舊 JS 失敗都已由 EOF 因果實驗證明。舊 image ID 曾不存在的 A/B 是 infrastructure failure，不算產品負例。這些 log 全保留。
- LSP 曾返回舊文件尾端的語法警告（112/113/118 行，當時檔案只有 110 行）；實際 `node --check` 和執行測試通過。不能把 cache-empty lens 或 stale LSP 當全 repo clean 證明。

## 重跑

先依 [extension README](../../extensions/datahub-agent/README.md) 建 image、匯出 assets，並以 checker 確認 image/source/asset 匹配。Tests 必須使用新 HOME；browser 開啟 Chromium sandbox，只允 localhost 網頁流量。

```bash
.venv/bin/python tests/test_agent_foundation.py
node --test tests/test_agent_{identity,browser_grants,gateway,transport,server}.mjs
node scripts/check-agent-artifacts.mjs "$IMAGE_ID" "$BROWSER_ASSETS"

# 下列是明確、有副作用的本案測試，使用獨立 scope／container／volume。
# IMAGE_ID/ASSETS 僅為已驗證 artifact，不是 credential。
env -i PATH="$PATH" HOME="$NEW_EMPTY_HOME" \
  AGENT_RUNTIME_IMAGE="$IMAGE_ID" AGENT_BROWSER_ASSETS="$BROWSER_ASSETS" \
  node tests/check_agent_entrypoint.mjs

env -i PATH="$PATH" HOME="$NEW_EMPTY_HOME" \
  PLAYWRIGHT_BROWSERS_PATH=/home/timmypai/.cache/ms-playwright \
  AGENT_RUNTIME_IMAGE="$IMAGE_ID" AGENT_BROWSER_ASSETS="$BROWSER_ASSETS" \
  node tests/check_agent_pi_web_browser.mjs
```

`tests/check_agent_runtime.mjs` 另需 `Dockerfile.runtime-fixture` 的明確 image ID，放在 `AGENT_FIXTURE_IMAGE`；它是真容器、合成 HTTP app，不是 pi-web。

證據：`.local/evidence/agent-isolation/`：

- `native-auth-red.log`、`unit-final.log`、`production-baseline-tests.log`、`foundation-final.log`
- `pi-web-runtime-build.log`、`pi-web-runtime-eof-build.log`、`browser-assets-export.log`
- `artifact-check.json`、`container-check-final.log`、`entrypoint-final.log`
- `pi-web-browser-static.log` 與最終 browser log；`real-pi-web-terminal.png`
- 所有 `*-diagnostic.log`、`pi-web-browser-pwa.log`、old-relay A/B／rebuild logs
- `relay-eof-before-single-process.log`（舊版通過，不能當 red）

所有測試 runtime／具識別標籤的 fixture volumes 已清理；測試 images／debug artifacts 保留。沒有 model call、來源 DB／GMS metadata 寫入、DataHub MFE 配置切換、其他服務重啟、commit/push。下一步仍是成功 SSO／多分頁和 A06 UI v0，之後完成 A07–A15，而非以此結案。

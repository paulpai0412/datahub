# Agent 白頁修復與 T01 真模型驗證

日期：2026-09-12。主代理實作及安全自查，非獨立審查。

## 真入口問題與根因

使用者在隔離的 headed Chromium 完成 DataHub 登入後，由自動化操作真 `http://localhost:9002/mfe/agent`。MFE bundle、bootstrap、ticket exchange 均 200，但 iframe 的 `/` 回傳 408，顯示白頁。

Runtime relay 會提前開啟至 Pi HTTP server 的 TCP 連線。HTTP server 在閒置 header timeout 後送出 408；Host pool 的閒置 socket 沒有讀取監聽，未淘汰這種已失效的連線，下一次 acquire 才收到舊回應。這不是 DataHub 登入失敗，也不是 OOM：當時 runtime running、0 restarts、OOM=false。

`integration/reverse-http.mjs` 現在只在閒置期間監聽可讀資料／EOF，將未曾分配請求卻有回應的連線銷毀；acquire 移除該監聽並拒絕已結束或已有資料的 socket。已分配的 HTTP／SSE 不受這個閒置規則影響。不延長 timeout、不重播使用者請求、不改 MCP／Pi／Core。

## 驗證及部署

- 新 regression 使用真 Node HTTP server、runtime relay 與 reverse pool，縮短 fixture timeout，確認過期連線被淘汰、補回新連線並回應 200。原碼失敗，修正後通過。
- gateway／identity／server／transport 共 **22/22 PASS**，包括既有撤銷、容量、egress與大回應傳輸檢查。兩 primary LSP clean；scoped lens cache 無 findings，不是全專案無告警宣稱。
- 使用者明確選擇「現在套用」，接受 Agent／terminal 短暫中斷；以原 controller 正常關閉 owned runtimes，保留 HOME，再啟動 gateway。
- Runtime image仍為 `sha256:57556f836d4ea1065282fa8309d502f4ff735dca58aa69e5ec68fefbafef64dc`，沒有重建 Pi image。DataHub frontend／GMS／DB等容器 IDs 不變；HOME 名稱前後一致。
- 真瀏覽器重新開頁 `/` 為 200、Settings 可見。
- 再離開 Agent，使連線閒置；獨立的無憑證 runtime loopback TCP 探針在 **84,527ms** 收到原生 `HTTP/1.1 408 Request Timeout`。之後重新開 Agent，exchange與頁面仍 200，排除僅剛重啟暫時恢復的情況。

## T01：真模型與 session 讀回

沿同一個真 DataHub iframe／原生 chat，建立只有合成測試問題的對話，使用 `chat-only`，不給模型工具。

- GPT-5.4 mini 與 GPT-5.4：請求到達 Codex，但服務明確拒絕目前 ChatGPT 帳號使用該型號；保留原失敗，不宣稱所有列表型號可用。
- GPT-5.6 Sol：回覆 **`AGENT_E2E_OK_20260912_SOL`**。
- 整個 DataHub 頁面 reload 後，該回覆仍可從原生 session 讀回。
- 未讀 OAuth/token、未搬移登入憑證、未使用開發機模型設定，也沒有 CLI／mock 代替原生 chat。

**T01 完成；T02 DataHub MCP 查詢仍未驗證。** T02 需使用原生允許 extensions 的模式，不能把本次刻意選用的 chat-only 沒有 MCP 工具誤判為 adapter 故障。

## 本地證據與恢復

`.local/evidence/agent-open/`（gitignored，不上傳）：

- `browser-red.json`／`after-login.png`：原白頁與 408。
- `idle-red.log`／`idle-green.log`／`regression.log`：原失敗與回歸。
- `deploy-before.json`／`deploy-after.json`：容器／HOME／image 比對。
- `native-idle.json`／`browser-idle-green.json`／`after-native-idle.png`：原生 idle timeout 後開頁成功。
- `model-test.json`／`model-gpt54.json`：不支援型號的原始結果。
- `model-sol.json`／`model-readback.json`／`model-readback.png`：真回覆與 reload。
- `source-state.json`／`gateway-live.pid`／`gateway-live.log`：目前 source hashes、部署與 PID。

目前 gateway PID `1965881`；恢復操作必重新驗證 PID/cmdline/cwd/scope，不盲 kill。自動化使用 owned session `datahub-agent-open-20260912`，HOME 在本證據目錄的 `browser-home/`；保留供後續 T02 使用，不匯出 cookies 或 auth state。測試失敗與本輪歷史登入狀態不應被重新解釋為未曾成功或全案驗收。

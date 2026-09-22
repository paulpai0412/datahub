# T06 Task／Pi／人工 Decision 接線 — 已部署，E2E 未完成

**真 Task 的 End 與繼續 lineage 兩分支已通過，T06／整案仍未結案。** 2026-09-13 限定導航修正已核准部署；使用者在 Windows 真 Tasks 入口開新 Run，確認自動切換並親自回答繼續。Run revision 3 保存 RESPOND、revision 2 保留未回答歷史；模型成功查 lineage 並停止，結果與公開 Aspect 核對。先前 End 分支的 DISMISS／closedAt／native 停止證據保留。主代理獨作；沒有新 datastore、Entity／Aspect、worker、排程框架、Pi image 或 Core patch，也未 commit／push。

## 已接上的責任邊界

- `integration/task-records.mjs`：沿既有 `dataJob/ekopAgentTask`、`dataProcessInstance/ekopAgentRun` 與公開 v3 API，create-only、原生版本／歷史、CAS、ACK 版本讀回；寫入結果未知不重送。
- Metadata 讀取沿原生 DataHub ACL，不改成 actor 私有。啟動、提問、回答、關閉驗 owner／session／Task revision／核准 dataset scope；非 owner 的讀回不包含 Pi state。完整 Pi 對話與登入仍只在原 actor runtime。
- `integration/native-tasks.mjs`、`task-runtime.mjs`：原生 `ensure_session` → 綁 Run → 唯一 prompt。相同 start key 只對帳，不再次送 prompt；新 Run 才是明確的新執行。使用目前 Pi 模型／MCP設定，Registry URN 是 metadata 參照，不執行 Registry 文字。
- Decision 必須對上真 native pending UI 的 session、id、title、run／request／question／choices，再以 CAS 追加問題／一次回答。只允許一個 pending；已回答、已關閉、Task 改版／scope 撤除不能繼續提交。重載後只對仍 pending 的同一個 native request 取回既存回答，不重寫歷史。
- End／cancel 先在同一 Run Aspect 寫 `closedAt`，再原生 `clear_queue`／`abort`／state 讀回。`closedAt` 不等於 Pi 停止；`stopObserved` 只是此次狀態觀察，失敗明示未確認。不存在的 wrapper 只讀，不為了停止而重新載入。
- 同一 Host 內，同 Run 的 start 與會停止 Pi 的操作只串行到原生呼叫完成；這是暫時的呼叫順序，不是業務儲存。回歸重現「name 尚未完成 → cancel 已停止 → 舊 start 又 prompt」，才加此排序；DataHub CAS 仍是持久化權威。不宣稱多 Host 或程序崩潰後的跨程序 fencing。
- `/agent/tasks` 沿 trusted parent origin、fresh DataHub identity、現有 grant／revoke proof；Task body 上限 16 KiB，ingestion 保持 4 KiB。runtime 只收自己的私有 Pi auth，不收 DataHub cookie／來源憑證。
- Pi `datahub_decision` 用既有 blocking `ctx.ui.input`；`get_state` 提供現有 pending UI 的快照，沿用 SSE replay，不建第二份等待狀態。Client bridge 只把有 Run version 的人類 RESPOND 送回 native UI；Host 未確認／衝突／缺少 parent 只顯示訊息，保留等待、不自動重送。已重現舊版誤把 status 當回答、使已保存問題失去 native 等待的缺陷，並驗錯誤保留等待、正常回答與原 ingestion 行為。
- MFE 的 Tasks／Decision 是薄控制與讀回頁；原生 chat／session 保留。URL 保存 Task／Run URN，可讀指定版本並開啟原 Pi session；沒有本機 Task 歷史庫。重新開啟仍活著的 native 等待與程序重啟後的恢復不能混為一談；沒有自動重播舊 prompt。

## Operator 設定（2026-09-13 已依核准套用）

只在既有 `ingestionSourcesByActor` 的已核准 Source 項目加可選 `taskDatasets`，不改原 `urn`／`cliVersion`／`recipeSha256`：

```json
{
  "taskDatasets": [
    "urn:li:dataset:(urn:li:dataPlatform:mssql,agent_t03_20260912.adventureworks2019.person.person,PROD)",
    "urn:li:dataset:(urn:li:dataPlatform:mssql,agent_t03_20260912.adventureworks2019.humanresources.vemployee,PROD)"
  ]
}
```

這是 Task 登記／操作範圍，不是來源 SELECT 權限，也不取代 MCP 的原生 metadata ACL。現有設定無 `taskDatasets` 時不開放建立／啟動 Task。本節兩個 dataset、candidate 2 與原 Reader 一小時 MCP token 更新已獲核准並套用；不延伸為其他來源、模型憑證、全域 ACL 或排程授權。

## 已讀取的證據

根目錄：`.local/evidence/agent-task-wiring/`。

| 檢查 | 結果與界線 |
| --- | --- |
| Host／gateway／ingestion／MFE mount | `host-final.log`：47/47；模擬 DataHub API、真本機 HTTP seam，包含 foreign metadata read／owner mutation 拒絕、scope／revision／session、CAS 競爭、未知不重送與 start/cancel 排序 |
| 未確認回覆恢復 | `decision-unknown-{red,green,final}.log`：原 Client effect 2 個反例失敗，修後 4/4；真 MessagePorts、只模擬 React scheduling。Host 另驗 question／answer ACK 遺失後，用仍 pending 的同 request 讀回，不重播 writes |
| Pi 呼叫接縫 | `pi-seams-first.log`：105/105；含 native wrapper pending UI／SSE 同步、abort／reload／idle／prompt admission，部分既有檢查是 source assertions，不是真模型 |
| Chromium | `browser-second.log`：真 browser + 產品 MFE module、合成 API／Pi；create→明確 start、錯 window／origin、人工回答、同 request 讀回答、End 與 native UI unmount 競態、pending 歷史／URL／cleanup／390px controls。非真 DataHub Task |
| TypeScript | `tsc-final.log`：exit 0；`native-tasks.mjs` 的 LSP 1128 與目前 bytes 不符，Node import／`--check`、TypeScript 5.9.3 fresh parse 均通過，見 `parser-confirmation.json`；不為 stale diagnostics 改正確來源 |
| Downstream | `downstream-final.log`：521 檔 hash／mode、reverse patch、原 506-file baseline 與 3 項既有 foundation tests 通過；upstream lock 不變 |
| Pi candidate build | `build-final.log`：既有 1 CPU／3 GiB／no-extra-swap、serial solver builder；只在凍結 context 內 Next/Webpack build。Git／npm 安裝層 cache hit；保留原 export route dynamic dependency warning。未污染開發 `.next` |
| 精確映像 | `image-tests-final.log`：984/984；network-none、read-only、1 CPU／1 GiB。既有 upstream tests 使用其預設非 embed 環境；這不替代 embedded browser 驗收 |
| 真 SDK／adapter 接線 | `sdk-image-final.log`：該映像內 Pi 0.85.1／adapter 2.33.0，兩個 DataHub tools 各載入／reload 一次、真 stdio discovery/call/disable 通過；沒有模型、DataHub 或 OAuth 呼叫 |
| 產物一致 | `image-source-final.json`：映像內 521 個來源 hash／mode 全相同；`artifact-final.json` 驗 222 個 browser assets／runtime relay／package lock；`mfe-bounded-build.log` 為另一次 network-none／1 CPU／512 MiB 凍結 MFE build |

最終 candidate image：`sha256:89103c07c3cfa70f2c81c695d5cb38c07a3652564c5646785f2d48248c7eb2a0`（本機 tag `ekop-datahub-agent-pi-web:t06-task-candidate-2`）。Browser assets 在 `browser-assets-2/`，MFE 沿用 `candidate-context-1/mfe/dist/`；兩次凍結 MFE source 逐檔相同，未重建未改動的產物。`final-source-build-state.json` 核對 550 個最終輸入無 drift、Core 乾淨、builder 已停止且無 OOM。**candidate 2 已於 2026-09-13 套用。** Candidate 1 保留為歷史，不再代表最終 Client 修正。後續空批次與原生工具 preset 修正只影響兩個 Host adapter 檔案：548/550 凍結輸入不變（`candidate-source-host-preset.json`），Pi 映像與 MFE 未變，不重建未改動產物。

保留失敗，沒有靠改產品遷就測試：第一次完整 image suite 975/980，四個 plugin checks 被測試環境 `PI_OFFLINE=1` 擋住；另一個 upstream palette test 與 image 的 embed-light 設定不同。確認 fixture 前提後，以相同 image、仍 network-none 跑預設 upstream suite，980/980。第一次 browser fixture 等待原生 `<option>` 可見而 timeout，改等 attached 後通過。第一個 downstream 重建在原 repo 子目錄被 `git apply` prefix 跳過，未寫新 patch；改用既有 checker 一樣的 repo 外 temporary directory 後完成。

舊資源 checker 的 BLOCKED 保留為 snapshot，不改寫為 READY；最新使用者決定已撤 headroom 門檻，仍保持既有實際 CPU／memory／network 限制。不得把舊門檻重新列成阻擋。Scanner 的既有 RPC type-assertion style findings／不完整 coverage，不等於本輪已全部消除；不宣稱全 repo lint clean。

## 2026-09-13 本機部署與第一個真 Task

- 沿既有 owned browser／手動登入，fresh DataHub identity 與 native running snapshot 為空後，核准範圍內切換 Agent。Gateway PID `791716` → `2521868`；runtime 是上述 `89103c…` 映像，原 HOME volume 保留。`deploy-verified.json` 核對 Core ID／image／PID／StartedAt／mounts 前後投影相同、operator 僅指定差異、MFE 位元組相同。沒有操作 Core／GMS／DB。Rollback 保留原設定、實際曾服務的 Registry MFE 與原 Host／Pi source，不複製 HOME／登入資料。
- 真 `/mfe/agent` 顯示 Tasks、兩個核准 dataset，既有 sessions 可讀回。最初模型 probe 未帶 `cwd` 而收到 403；API 來源預設 `/app` 並檢查 allowed roots，改用既有 session workspace 後 200，沒有放寬權限。一次舊 frame lookup 失敗後重新從 owned entrypoint 取得 frame，當時尚未發 token。
- 原 Reader 新 `ONE_HOUR` token 僅存入原 actor 的 Pi MCP 設定，未輸出 token、未讀模型憑證、不自動續期；PUT／GET 200，排除 Authorization 後設定 hash 完全相同。真 Reader identity／Registry read 200，Registry write 403，管理者讀回值與版本不變。見 `reader-configured-live.{json,log}`；不能把舊已撤銷 ACL token 當作這個新 token。
- 真 Tasks UI 建立 Task 成功（revision 1，ID 尾碼 `c7d56704-e848-4f1b-8f2a-b7f5f17215f3`）。唯一 start attempt（Run 尾碼 `bbe6ead3-8f01-4add-b8ea-2a28be6159ae`）收到 **502 `invalid_datahub_task_response`**，沒有重送。`start-failure-readback.json`：Run 的公開 v3 batchGet 是 **200 + `[]`**；Task 仍存在且 revision 1。
- 根因：Host 在 createSession／bindRun／prompt 之前先查 Run；adapter 把官方「缺失 Entity 的空批次」誤當格式錯誤 502，controller 只對 404 開啟新 Run。舊 fixture 用 HTTP 404，掩蓋此差異。該次失敗未進入上述 native 啟動步驟，不是模型失敗。
- 最小修正只在 `task-records.mjs` 把空陣列轉成既有 `task_record_not_found` 404；畸形／錯 URN／重複批次仍拒絕，空 write ACK 仍是未確認、不重送。fixture 改成現場 200／空批次後，原成功啟動回歸與缺失讀取都 RED；修後完整 Host **49/49**（`missing-batch-{red,green}.log`），兩檔 primary LSP clean。只修改 adapter／對應測試，未改 Core 或增加重試／狀態層。
- `host-empty-batch-fix.{json,diff}`／`candidate-source-host-fix.json` 保存該階段修正；後續已另獲核准，gateway `2521868` → `2833070` 套用。首次未正規化的 Core 投影斷言曾失敗，未保存該次差異；後續原始投影逐鍵相同，最終以 mount destination 排序比較通過，不指定最初失敗原因。

## 第二項呼叫修正與真人工等待（2026-09-13）

- 第二個明確新 attempt `613cf051-c2fe-4dc1-8cf7-8502ffc28e67` 回 `task_runtime_unconfirmed`；未重送。官方讀回 Run 不存在、無新 persisted session。隔離同映像／空 HOME 的真 native HTTP 重現 default-cwd 200、ensure_session 500：`toolNames must contain only built-in tool names`。Host 誤把 extension 名稱 `datahub_decision` 傳入 built-in selection；不是 MCP token 失效造成此驗證拒絕。
- 使用者明確核准沿 T02 的原生 Read-only（read／grep／find／ls），接受不是 MCP-only／憑證檔案隔離，仍禁止實際讀憑證。僅改 Host 使用既有 `getToolNamesForPreset("read-only")`，不改 Pi 選工具契約。忠實 native 錯誤 fixture 先 RED，修後 Host 49/49、兩檔 primary clean。相同映像再以修正後產品 caller 建 session 200；native `get_tools` 驗 active Read-only＋MCP＋兩個 DataHub extensions、無 bash／write／edit。空 HOME 探針未呼叫模型，容器與新 volume 均移除；早期額外猜測 `get_all_tools` 得 unsupported 500，不當成功 inventory 證據。見 `native-preset-{red,green}.log`、`native-transport-{probe,green}.json`。
- 再一次特定 Agent 維護經核准執行：gateway `2833070` → `3099853`，同映像／HOME／MFE／其他 operator 設定；`preset-deploy-verified.json` 核對部署投影。原 Reader 另簽一小時 token，MCP CAS PUT／GET 200、非憑證設定 hash 不變，Registry read 200／write 403／讀回不變。此 token 於 **2026-09-13 04:52:23.596Z 到期**，沒有自動續期。
- 第三個明確新 Run `1be51248-c460-466a-87ac-2ce1236901dd`：Host start 200／accepted，Run revision 1 與真 session `01a098e6-8570-72ba-a956-dd6f154e6713` 綁定；只提交一次 prompt。Native 歷史已有 `datahub_get_entities` 非錯誤結果、接著等待 `DataHub task decision`；完整兩資產結果仍需核對。
- 真畫面暴露另一缺陷：MFE 從父頁直接設定私人 iframe session URL，顯示 `untrusted_origin`，未到人工框；既有 gateway 明確拒絕 cross-site runtime 請求。未放寬防護。經既有 bootstrap 回到原生入口，再由 frame 自己導向同一 session，人工框成功出現；這是手動對帳／恢復，**不是 Task 導航修復**，未重送 prompt。`task-pending-live.json` 官方讀回 Run revision 2，question／choices 存在、response 尚不存在。
- 04:10Z 曾確認問題可見；使用者稍後表示找不到，08:32Z 現場已是 `Agent could not open`。當時 fresh identity 200、原 runtime 仍 Up 5 hours；未擷取造成頁面失效的原始 heartbeat 回應，不能歸因登入或 MCP token。經同一原生入口再次恢復同一 pending 問題，無 prompt 重播；見 `task-native-help-recovered.json`、`task-human-restored.png`。真人尚未送出回答／取消，不能當人工分支通過。

## 真人 End 分支與 metadata 核對（2026-09-13）

- 使用者實際看不到 WSL 的測試 Chromium；「CDP 可連線／截圖可見」先前被誤當作桌面可見，已更正。確認同台 Windows 後，只以 Windows 預設瀏覽器開 `http://localhost:9002/mfe/agent`，由使用者自行登入；未搬移登入資料／讀模型憑證，沒有控制其其他分頁。使用者從原生 History 搜尋 `1be51248`，確認同一 Task decision 可見並親自按 End task。
- 官方 API 最新 Run **revision 3**：唯一既有 question 的 response 為 **DISMISS**，response actor 為原使用者，`closedAt === respondedAt`。同一原生 session 的 `isStreaming/isPromptRunning/isBashRunning/isCompacting` 全 false，pending messages／UI 都 0；wrapper 仍存活，不能解作整個 Pi 容器已關閉。讀回程序沒有送 answer／abort／clear_queue／prompt。
- 首次歷史檢查脚本錯用 `headers.version`，API 忽略而回最新 v3，斷言正確失敗；產品 adapter 原用正確 `If-Version-Match`，沒有產品修改。保留 `human-end-readback.{json,log}`，只補正唯讀歷史查詢，`human-end-history-confirmed.json` 證 **v2 尚未回答、沒有 closedAt**，沒有重做取消。
- 原 Task 的 `datahub_get_entities` 保存結果只包含兩個核准 URN：Person.Person **13 fields**、vEmployee **18 fields**。與目前公開 schemaMetadata API 的 fieldPath／nativeDataType／nullable 集合一致；比較不當作欄位順序。見 `task-metadata-result.json`、`task-metadata-verified.json`。這是原呼叫的 metadata 證據；沒有補發模型或 MCP 請求，沒有取得業務資料列／執行 SQL。
- 「真 Task → 模型讀 metadata → 真人 End → Host 關閉＋native 停止＋歷史讀回」分支已取得證據。此分支當時仍經 History 手動定位；後續導航與另一真人分支見下節，不以後續修正改寫歷史收據。

## 限定導航部署與真人繼續 lineage（2026-09-13）

- 根因為 Tasks 父頁直接導向 private session，被既有跨站防護拒絕。僅 gateway 與 Tasks 兩個接點改走 `/bootstrap?session=<UUID>`，再由同 origin 轉至 private session；目的地仍驗 cookie／grant。query 強制完整文件導航，避免 fragment 在既有錯誤頁不重新執行；不交換新授權、不加重播／控制通道。
- 凍結時發現另外 13 檔格式漂移；保存原檔／diff、語法树比對後另獲核准恢復至已驗 bytes。最終 550 inputs 僅上述兩檔不同，548 不變。Host **49/49**、Chromium 導航正負例／Task UI、隔離 MFE build 通過；Pi 521 檔／reverse patch／原 506 baseline／3 foundation checks 通過，未重建未變的 Pi 映像。誤用系統 Python 執行 downstream check 時缺 DataHub SDK；使用既有 `.venv/bin/python` 後通過，未安裝新依賴。
- 核准一次 Agent-only 維護：gateway PID **3099853 → 3761704**，只更新 gateway／MFE；Core 容器投影、Pi image、HOME volumes／設定保持。真 MFE 靜態回應與新 build bytes 一致，既有 closed session 的 Open 經 bootstrap／private root 均 200、歷史可讀，沒有新 prompt。第一個 read-only 檢查漏呼叫 response `status()`，保留失敗收據；修正檢查後通過，不是另一個產品缺陷。
- 原 Reader 另核准 ONE_HOUR token，只更新原 MCP；identity／read 200、write 403／原值不變、CAS 讀回及非憑證 hash 保持。到期 **2026-09-13T11:38:47.858Z**，不自動續期。此輪維護額度已使用。
- 使用者 Windows 真入口按一次 Start，回報正常自動切換並亲自選「繼續讀取 lineage」。新 Run **99b1cf9b-8028-4f50-a63f-f5ca4ca1a60f**／session **01a09a5d-a4b7-74b5-a3c8-fa6922fccab1**；公開 API 核同 Task／session，v3 唯一既有 question 保存本人 RESPOND，v2 未回答歷史不變。不是重播已 End 的舊 Run，助手未代答／補 prompt。
- 真模型先 `datahub_get_entities`、`datahub_decision`，再四次 `datahub_get_lineage`，均非錯誤；最後 stop，native streaming／prompt／bash／compacting 全 false、pending messages／UI 0。Person／vEmployee 的 **13／18 欄**與 schemaMetadata 集合一致；MCP Person 的 **3 個一跳下游**均在公開 upstreamLineage Aspect 找到對應邊。
- **範圍限制**：MCP 搜尋可見的 vEmployee 上游為 1（Person），原生 Aspect 有 **9 個 upstream references**；不可把可見搜尋結果冒充全量 lineage，0 返回也不證明全域不存在。沒有 SQL 執行／Join 核准／來源資料列讀取。
- 證據：`navigation-{restore,deploy-verified,live-confirmed}.json`、`candidate-source-navigation.json`、`navigation-restored-*.log`、`navigation-downstream-final.log`、`reader-configured-navigation.json`、`windows-task-run.json`、`windows-lineage-verified.json`。均在 gitignored `.local/evidence/agent-task-wiring/`；不公開執行資料。

## 尚未完成

1. 真 Host 跨 Actor 操作拒絕／不洩漏他人 Pi state，及其餘 T07 多使用者、IME／鍵盤／a11y、生命週期整合；不以 Reader 的 Aspect ACL 或 synthetic fixture 代替。
2. 先前長時間等待頁顯示 Agent could not open 的原始原因尚未確認；本輪修復／程序重啟後舊 terminal session 歷史可讀，不證明重啟能自動恢復 pending 問題。
3. Reader 到期後如需 MCP，仍須另核准，不自動續期。
4. Agent 排程的實際 scope／時段／身分尚待確認；原生 ingestion scheduler 不能冒充 Agent scheduler。不先建立通用排程器，T06／母 TODO 不結案。

# T06 Task／Decision：官方模型與公開 API 實測

日期：2026-09-12。此為必要模型／API 相容性證據，**不是 Task／Decision 或整案 E2E 驗收**。

## 結果

新增 `extensions/datahub-agent/models/`，使用官方 `metadata-models-custom` registry ZIP 格式，在原生 `dataJob`／`dataProcessInstance` 分別增加 `ekopAgentTask`／`ekopAgentRun`；不新增 Entity、datastore、worker、排程器或 Core patch。

- Core `v1.7.0.1`／`e99431ec510d7a2001f815c6bf70913c493af76e` checkout 乾淨。
- 固定 GMS image `sha256:74e15e982b94d0e147de41d05133ef3df48f74a1004a9c997805e0aa7e010173`。
- Gradle `8.14.3`、Pegasus `29.74.2`、JDK `21.0.12+8`；鎖檔與建置方式見模型 README。
- 首版產物 `ekop-agent-tasks-0.1.0.zip` SHA-256：`cb5b9ec9b4cd868fea965184303266d8f41c751d38f9644928ac3b84944bcd3f`。
- 產物只有 registry YAML、本插件 main／data-template jars；24 個 class entries 全在 `com/ekop/agent/`，沒有打包 Core classes。
- 離線隔離容器建置及真生成 records／codec roundtrip 通過；缺欄位、無效 Decision action 負例通過。這部分是離線模型測試，不是部署證據。

## 維護與權限根因

使用者先核准僅套用模型並重啟 GMS，以及重新開本案隔離登入視窗。未操作其他服務、映像、資料 volume，未讀取登入憑證或匯出 cookie／OAuth token。

第一次重啟後模型未載入：GMS UID 是 100，但 `.local/plugins` 為 UID 1000、`0700`，真 `docker exec` 以 GMS UID 讀取得到 Permission denied。Java loader 將無法遍歷的目錄記為不存在並停用掃描。此前漏核 UID 是本輪維護錯誤，不歸咎模型 schema。

根因在 `scripts/init-local.py`：`umask(077)` 將 `mkdir(mode=0755)` 降成 `0700`，且既有 credentials 分支提早返回。僅對公開 plugins 目錄改成明確 `chmod(0755)`，並在既有 credentials 分支返回前準備它；不改 `.local` 或憑證權限。`tests/test_local_plugin_permissions.py` 修前重現缺目錄／0700，修後驗缺目錄與既有目錄兩種情況、憑證 bytes／mode 不變。真 GMS UID 100 已能讀取 registry 及 jar。

使用者另外核准第二次 GMS 重啟後，原生 loader 記錄載入成功；`GET http://localhost:18080/config` 返回：

```json
{"models":{"ekop-agent-tasks":{"0.1.0":{"loadResult":"SUCCESS","failureCount":0}}}}
```

GMS health 200，同一容器、映像、mount；所有本案其他容器 IDs 不變。啟動期間短暫 503／connection reset 不算健康通過；穩定後才做 Aspect 寫入。

## 真公開 API canary

人類已在重新開啟的 owned browser 登入，從真 `/mfe/agent` 頁內 same-origin fetch；先由真 GraphQL `me` 確認 actor，未匯出憑證。

| 情境 | 實際結果 |
| --- | --- |
| Task Aspect conditional create `If-Version-Match: -1` | 200，scope／指令／原生 version 讀回 |
| Run Aspect conditional create | 200，pending Decision 讀回 |
| 依最新 version 寫回 response | 200 |
| 舊 version 嘗試覆寫 | 412；最新 response 仍是成功寫入者 |
| 用歷史 version 讀 pending | 200；保留原 pending 值 |
| 同一 version 兩個並行 HTTP 更新 | 一個 200、一個 412；winner 與原 pending 歷史讀回正確 |
| 匿名 Aspect 讀取 | 401 |
| 同一原生 Reader 的 Registry／Task／Run 讀取 | 各 200；先用真 `me` 核對 service Reader 身分 |
| Reader 對 Task／Run 的寫入 | 各 403；管理者讀回確認內容與 version 不變 |
| 本次一次性 Reader token 撤銷 | 原生 revoke 返回 true，原 token 隨後請求 401 |

API 使用官方文件的 `/openapi/v3/entity/generic?async=false&systemMetadata=true` 與 `/{entityName}/batchGet?systemMetadata=true`；條件在 body Aspect 的 `headers`，不是自行建立外部版本庫。實際 OpenAPI 靜態文件未列出新 record，不代表 generic API 不支援；本輪以上述真行為判定，不宣稱 GraphQL／UI 自動產生。

Canary URNs：

- `urn:li:dataJob:(urn:li:dataFlow:(pi,ekop-t06-model-canary-20260912,DEV),aspect-contract)`
- `urn:li:dataProcessInstance:ekop-t06-model-canary-20260912-aspect-contract`

它們的內容明確標記 API contract check；`sessionId` 為 `model-contract-check-no-pi-session`。沒有真正 Pi session、Agent 推論、人工批准、來源 SQL、ingestion 或排程執行，也沒有修改兩個既有 Dataset。

## 0.1.1：同版本關閉提交入口（2026-09-12）

接線查核確認 `pi-web/lib/rpc-manager.ts` 的 `send("abort")` 解除當下 UI 等待並呼叫原生 `inner.abort()`，不會更新 DataHub Run。官方 `DataProcessInstanceRunEvent` 是另一個 timeseries Aspect，不能與 Decision 同一次 CAS 更新。僅依取消請求或分開查事件，再寫回舊 Run，不能提供相同版本下的關閉防護。

使用者明確核准在既有 `ekopAgentRun` 增加可選 `closedAt`，以及本機檢查通過後的模型更新／最多一次 GMS-only 重啟。它只關閉 Host 提交入口，**不等於 Pi 已停止**；不新增 Entity、儲存或排程。未覆寫已發布的 `0.1.0`。

- 新 ZIP `ekop-agent-tasks-0.1.1.zip` SHA-256：`76b4584cd52af6f469387ad4f7af0da6e3e629fd85c17d425f6df0c8caca884a`。
- 同一固定工具鏈離線 `clean build` 通過；真生成 Java records 驗舊 Run 無關閉欄位仍有效、關閉欄位往返、既有回答保留及無效時間型別拒絕。
- 建置只掛 workspace、Core jars、Gradle cache／distribution、JDK；未再掛整個 evidence 父目錄，因該處現在包含隔離瀏覽器 HOME。沒有掛入瀏覽器登入資料。
- ZIP 仍只有 registry 與兩個插件 jars，24 個 class entries 全在 `com/ekop/agent/`。部署前驗 GMS UID 100 可讀；以完整版本目錄原子移入 loader 位置。
- 已正常啟用的官方 loader 依原生 60 秒週期掃描並載入 `0.1.1`，`loadResult=SUCCESS`、`failureCount=0`。**本次未重啟任何服務**；所有本案容器 ID、image、PID、啟動時間及 mount 均未變，`0.1.0` 檔案 bytes 未變。GMS／frontend health 均 200。
- 原 CDP `36135` 拒絕連線，未送出 API 寫入；保留失敗 receipt。經另行核准重新開啟隔離瀏覽器並由使用者手動登入後，才取得升級前後基準；沒有讀取或匯出登入憑證。
- 真 same-origin 公開 API 驗舊 Task／Run 最新內容和版本、原 pending Decision 歷史與升級前完全一致。
- 新可辨識 canary `urn:li:dataProcessInstance:ekop-t06-model-011-closure-20260912`：建立 pending、同版本寫入 `closedAt`、關閉前舊版本回答被拒絕 `412`、關閉值及原 pending 歷史讀回通過。

上述只是 schema／API 相容性與版本衝突證據。**尚未證成 Host 對持最新版本的已關閉 Run 拒絕提交，也不是 Pi 取消、人工 Decision 或 Task E2E。** 下一步須在真 Host 操作入口落實不可重新開啟、回答一次、owner／session／scope 及原生停止讀回，不能再以增加欄位當作完成。

新增證據位於同一私人 evidence 目錄：`build-closed-run.sh`、`model-0.1.1-build.log`、`model-0.1.1-before.json`／`after.json`、`model-0.1.1-loader.json`、`model-0.1.1-before-api.json`／`after-api.json` 與 logs、`check-closed-run.mjs`。canary 腳本有首次建立／關閉寫入，不可盲目重跑；失敗時先依 receipt 對帳。

## 未完成與下一步

- Reader 的 Registry／Task／Run 讀取與新 Aspects 寫入拒絕已驗；Registry 寫入拒絕及 Host 跨 Actor 所有權防護仍未驗。使用者另核准一個原生一小時 service Reader token，只留記憶體用於本次測試，完成後已撤銷且驗 401；未配置 MCP、未保存／輸出 token，沒有自動續簽。
- 實測 Reader 可讀另一 actor 的 Task 指令與 Decision metadata；它們目前遵循 DataHub Catalog 的 Reader 可見權限，不是 actor 私有儲存。使用者已明確核准沿用此原生 metadata ACL；Task 啟動、回覆、取消仍須 Host 檢查所有權，完整 Pi 對話與憑證保持 actor 隔離。不改全域政策，也不以 UI 過濾假裝 metadata 私有。
- Task 啟動、既有 Pi session 執行接線、人工回覆後繼續／結束、取消／恢復與歷史 UI 尚未完成。
- 新 Aspect 的 CAS 只提供版本衝突防護；回答一次、append-only、來源／資產 ACL、session owner 與失效／舊執行者防護仍須在 Host 接線實作，不能拿 schema 註解冒充。
- 原定 Person.Person／vEmployee metadata → 人工決定是否查 lineage → 繼續／結束案例不變。排程啟用時段／scope 仍需另外核准；T07 未開始驗收。

## 證據與回顧

`.local/evidence/agent-task-models/`：`core-libraries.json`、`model-build-first.log`、`model-build-second.log`、`artifact-check.json`、`deployment-before.json`／`deployment-after.json`、兩次 restart logs、`plugin-permission-{red,green,live}.log`、`public-api-after-load.json`、`live-aspects.json`／`.log`、`live-cas.json`／`.log`、`reader-live.json`／`.log`。私人證據不提交或上傳；Reader receipt 只有非秘密 token metadata／撤銷結果，不含 token。

首次 build 的 PDL 同 namespace import 與缺少原生 Urn schema dependency 已在模型原始碼修正，第二次離線 build 才通過。首次 Gradle ZIP 下載 timeout 後，在同一官方 URL 續傳並核對官方 SHA-256；未換來源或執行未校驗 ZIP。

本輪證明了官方模型及原生 CAS 可用，避免提前建外部儲存；也暴露出必須檢查真容器 UID 的部署權限問題。兩者都以原失敗及成功行為核對，未修改 Core 或疊加權限放寬／重試框架。

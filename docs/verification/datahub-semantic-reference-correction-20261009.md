# 語義引用錯誤：可更正，不取消整輪

> 2026-10-10 更新：本修正的後端映像與設定保持不變。另經批准部署 [MFE 載入呈現修正](datahub-semantic-maintenance-loading-20261010.md)，Host 已由 `1086550` 正常重載為 `426856`；下方 PID／runtime／44 journals／MFE 未變均為 10 月 9 日驗證時點。最新驗證保留五份計畫及 45 journals，其中使用者另建的 READY v28／13 項計畫與三份原草稿獨立；未自動準備或發布。

2026-10-09。**修正已依使用者「佈署」批准部署，Windows 真入口只讀驗證通過；未重跑真模型準備或發布。** 使用者先要求只讀查明真正原因，再批准「不要卡死，繼續修正」。本地驗證及原始失敗證據保留。

## 原因

最新手動提案最後一個欄位的 Term URN 與先前原生讀回的值不同。授權後的 public batchGet 回 HTTP 200／空集合；對照正確 URN 回一筆有效資料。原 Host 把這個正常的缺失結果變成 `semantic_catalog_invalid`，沒有寫入前輸入拒絕 proof。SDK 因此保存 unconfirmed locator、取消整輪，最後顯示 `This operation was aborted`。

未修改程式的離線重現兩次得到相同結果；其他引用及完整多 Aspect 提案的編譯比較均通過。中途另有 `WebSocket closed 1000`，其後仍成功準備；未將它冒稱最後中止的觸發原因，該連線錯誤的來源仍未證實。

## 修正邊界

- `semantic-native-client.mjs`：只有成功、精確的空集合才呼叫 `onMissing`。傳輸／HTTP 錯誤、非陣列、錯誤 URN、重複列及損壞 Aspect 不會進入此 callback。callback 返回也不能繞過原生驗證。原有明確 `allowAbsent` 語義不變。
- `native-semantic-catalog.mjs`：直接候選引用及直接 `definition.parentUrn` 缺失，回 `semantic_reference_not_found`。維護準備的可信寫入前比較透過既有 `rejectInput` 回 typed proof，附 `location`：`inputPath`、必要的 `candidateIndex`／`fieldPath`、`kind` 及原 `referenceUrn`。不猜 URI、不刪候選，不替模型選業務答案。
- `semantic-maintenance-plan.mjs`：proof 仍綁定本次 action、requestId、Root 及完整 requestDigest；`nativeWriteStarted:false`、`NEW_INTENT_ONLY` 不變。新增位置資訊不授予重送權限，不追認原來失敗操作。
- SDK：直接 `inspect_definition` 的已知引用缺失不停止同一輪前景準備。維護寫入仍只接受 request-bound typed proof；其他 bare 寫入錯誤及失 ACK 不豁免。
- 原生父節點的祖先缺失、預覽後引用消失、ACL／Source／CAS／I/O／UNKNOWN 仍安全停止。發布端没有更正 proof，不自動重試。

## 已觀察的驗證

- 完整 fixture 對保留的實際部署 Source／SDK 重現兩個 RED；目前修正為 GREEN，原始失敗紀錄保留。
- **406／406** scoped semantic Host／actual SDK／HTTP／fixture browser 回歸通過；沿用既有瀏覽器、空白 HOME、移除憑證環境，沒有安裝。這是合成驗證，不是真來源部署驗收。
- 同 Root 先保存七項，v15 的錯誤末欄引用被拒絕，但 `abort=0`、新增 record／target writes=0，七項及版本保持不變。測試明確提出新的合法輸入後成功保存第八項、保留完整提案；SDK 未自行替換或重送。
- Domain／Tag／Term collection／Property／直接 parent 的缺失位置正確；ACL、HTTP／I/O、malformed native、ancestor 缺失及 read/compile race 均沒有更正豁免。
- 實際 HTTP gateway 傳遞完整位置及 request-bound proof；不同 requestId 不得使用此 proof。
- TypeScript／SDK ESLint 通過。593 downstream 檔僅 SDK 一檔新變化；reverse patch 精確還原官方 506 檔及三個 baseline checks。七個既有合法完整 Review／digest 向量逐值不變。
- 四來源 active LSP 有既有型別 hint／靜態規則 findings，沒有宣稱 workspace clean。

保留首輪回歸中的舊錯誤碼斷言失敗、空 HOME 瀏覽器 cache 路徑失敗、legacy raw TypeScript import／Jiti preload 不相容及 HTTP fixture transport caller 失敗。更正測試 caller／預期，不修改上游 SDK、安裝瀏覽器或清洗歷史。406 scoped suite 不包含舊 `tests/test_agent_semantic.mjs` 的 raw TypeScript import harness。

## 核准部署與真入口只讀驗證

使用者明確批准「佈署」。2026-10-09 **14:13:31Z** 正常退休舊 Host `84631`，保留兩個 HOME volume，啟動 **PID `1086550`**。

- Config：`.local/agent-server-semantic-reference-correction-20261009-pYI9Kw.json`，SHA `d31372f5787fe4d1d1353033765a8c69434b6272e5fd26631722d805341d6041`。
- Image：`sha256:53b6dbdc3339a3d87edcb254a71cbcd98d7aaba65e8c8acccfd3fb1d2be50bb8`；runtime `dha-ekop-agent-local-810b69b5-b7bd-46f8-b9eb-1966739282b6`。
- 相對前版只三個 Host 模組＋downstream patch／lock，593 app 檔僅 SDK 一檔。設定只切 image／browser assets；MFE、Core、Source 授權、查詢／ingestion、模型／thinking／工具選擇不變。
- credential-free 隔離 serial Docker build：實際 cgroup CPU1／RAM3GiB／swap0，完成停 builder；沒有 checkout `next build`。
- exact image 的 **116／116** Host／actual SDK／HTTP／lifecycle 檢查通過；593 source hashes／223 exported assets 一致。
- installed Windows Node／Edge sandbox、新 owned context 從 `http://localhost:9002/mfe/agent` 驗證；18 個實際 browser assets SHA／HTTP200 與映像一致，五個既有 SID 的 model／thinking／工具選擇及完整 descriptors 相同。
- fresh Actor／全部 runtime idle／三份完整草稿與 Reviews／歷史核對後才切換。before／preswitch／after 逐值比較：最新 **DRAFT v15／七項 PENDING／三資產未帳平**、舊 **v3／一項 Domain**、原 **v11／五項**，完整 Reviews／scope 不變；只忽略 top-level READ requestId。
- AdventureWorks 完整142項／planDigest 不變；兩 HOME 共 **44 份 journal 的 SHA、size、mtime 完全相同**。所有 owned browsers 關閉，使用者視窗不動。
- tracking POST 被攔截及一個 `Failed to fetch` pageerror 保留，不宣稱零 browser errors或原 tab cache 已清。首次 availability 查詢找到 Windows Node 後，過廣的 find timeout；已核 freeze 完成、未 build／switch，再沿已知安裝路徑前進，沒有重跑 freeze 或部署效果。

部署／只讀授權已完成消耗。請重新整理 Agent 頁面載入目前資產；沒有自動重跑模型、真實準備／封存、批准、發布、Source 授權或 SQL。三份草稿仍不是完整 READY，完整語義代管與真正變更第二輪保持 OPEN。

新的更正 proof 只描述新的呼叫，不回填原失敗操作的零效果證明。所有成功／UNKNOWN 操作不重送；真正維護續作與可信父頁真人整批確認不由本次部署授權代替。

部署私有證據：`.local/evidence/semantic-autonomous-plan-20261005-ScQzQE/semantic-reference-correction-deploy-20261009-pYI9Kw/` 的 `authority.json`、source／image／artifact gates、116 image checks、before／preswitch／after full views、44 journal snapshots、`launch.json`、`validation.json`／`CHECKPOINT.md`。one-shot build／stage／deploy 已消耗；原登入狀態保持外部私有引用，未公開或上傳。

證據：`.local/evidence/semantic-reference-missing-local-20261009-bnkwLp/` 的 `red.log`、`green-1.log`、`targeted-*.log`、`regression-*.log`、TypeScript／lint／downstream／frozen Review logs、`validation.json`、`CHECKPOINT.md`。原只讀診斷證據保持私有，不公開登入狀態、原始公司 metadata 或 URN。

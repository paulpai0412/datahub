# Agent SQL／Grafana UI 接線恢復（2026-10-02）

## 結論

現行 Agent 已恢復 metadata 驅動的受控 SQL／Grafana 接線。真 `/mfe/agent` 的 `datahub` 使用者，透過既有模型與三個 DataHub 工具，完成一次 SalesDatamart 三表 JOIN、一次唯讀 SQL、建立一張 org2 原生 Grafana 長條圖與同次結果表；兩個原生 datasource 回覆皆 200，图表／表格與同次 Host 來源結果對帳一致。

**本次模型自然文字收尾未通過驗收**：檢查腳本在最後持久訊息仍為 `toolUse` 時判失敗並送 Stop，最終為 `aborted`。SQL／Dashboard／數值對帳已在 Stop 前成功，沒有重跑 SQL、重送原 prompt 或重建 Dashboard。保留原 exit1，不報成完整無干預模型 E2E。較早的自然收尾證據仍只證明[其原範圍](datahub-agent-metadata-query-native-20260926.md)，不替代此次 `datahub/admin` 證據。

## 原因與部署修復

不是缺少 merge：查詢實作已包含於 `master` 的 `32db4b1`。9/29 為語義維護測試改用同一入口上的限定唯讀配置，沒有 SQL／Grafana 三個部署配置鍵；後續沿用它，使已實作的功能未接通。

本次以目前語義配置為基礎，新增：

- `queryConnections`：既有 SalesDatamart MSSQL 唯讀連線 binding。
- `queryGrafana`：既有 org2 專用 writer／Infinity datasource／私有 folder 與 Dashboard 發布。
- `grafanaServiceKeyPath`：既有受保護結果後端認證。

目前 DataHub 登入者為 `datahub`，不等於先前測試使用者。使用者另外選擇 **`urn:li:corpuser:datahub → admin`** 的一對一 Grafana 登入對應；保留原 subject mapping，不借用測試帳號，不新增帳號或角色。

新的 operator 配置：`.local/agent-server-integrated-query-semantic-20261002.json`。舊配置及完整私有備份保留，可對帳；不能直接覆蓋回舊整份配置而丟失新的語義能力。來源與 Grafana 秘密仍透過既有受保護檔案提供，不輸出或提交。

- Host：PID `111661 → 869656`，舊 Host 正常關閉其自有 runtime，HOME volumes 保留。
- Pi 映像未換：`sha256:a8c048ecc459d3797aa2d8666af11dcfd097f0d2dc2f38a672d72843f686d456`。
- MFE／browser assets／原 Source 範圍／語義 contract 與 publication=false 政策均未變。
- 另一會話的 Source Settings Host 改動原本尚未部署。協調其停止修改、核對固定 source pins，**另獲使用者確認**後才重啟載入；`sourceSettingsEnabled` 維持未設定／關閉，不部署它的 Pi／MFE 新介面、不啟用 AdventureWorks 或 AUTO。
- 不改 DataHub Core／org1／來源資料，不新增業務 datastore、commit 或 push。

## UI 操作範例

1. 同一瀏覽器先登入 <http://localhost:3000> 的 **Grafana admin**，選擇 **org2**；使用自己的登入，不把密碼貼到聊天。
2. 以 DataHub `datahub` 登入 <http://localhost:9002/mfe/agent>，建立對話，選擇已連線模型。
3. 輸入框工具選單選 **`datahub-only`**，不是「語義治理」。此組合為 `datahub_catalog`、`datahub_sql`、`datahub_grafana`。
4. 輸入以下範例：

   > 請查 SalesDatamart 在2014年6月各產品分類的淨銷售額。先用 Catalog 核實 dm.fact_sales_order_line、dm.dim_product、dm.dim_date 的精確資產與欄位；fact 的 productkey 連 product 的 productkey，orderdatekey 連 date 的 datekey。依 productcategoryname 分組，加總 linenetamount，金額由高到低最多20類。實際執行唯讀查詢，建立 Grafana 長條圖與同次查詢的結果表。图表已有附表，不要為附表重送同一查詢；資訊不足請指出缺口，不要猜測，執行失敗或未知結果不要重試。

5. 點訊息卡 **「開啟儀表板」**，在右側原生 Grafana 檢視圖表及「查詢結果」，可放大／關閉。SQL 卡另提供 **「查看產生的 SQL（不重執行）」**；本輪只確認該入口可見，未另外點擊验其 SQL 預覽。

這不是任意 SQL 字串執行入口。目前實測連線為 MSSQL SalesDatamart；其他來源、自由 SQL 或跨來源查詢不能由本次推定可用。資料可見性仍由當前 DataHub 身分／metadata ACL 核定，DB 依部署連線帳號限制執行，不新增逐人 SELECT 清單或逐題審批。

結果預設短效15分鐘，瀏覽器授權失效也會停止讀取；歷史 Dashboard／卡片保留不代表仍有數值。關閉測試瀏覽器後不能把本次舊 display 當成永久報表，刷新／重開也不暗中重跑來源 SQL。需要新資料時由使用者提出新查詢。

## 原始驗證範圍

| 項目 | 本次結果 |
| --- | --- |
| 現有 source／driver／protected files／org2 原生資源及 actor 預檢 | 通過；預檢無 SQL 或 Dashboard 寫入 |
| 查詢 scoped 回歸 | 37/37 PASS；fixtures，不冒稱新來源驗收 |
| 新 Host scoped 回歸 | 通過；原 393/393 原始回歸與固定 pins 另核對，沒有重跑所有功能 |
| 真 Agent UI | 目前 `datahub`、既有 `openai-codex/gpt-5.6-sol`、`datahub-only` |
| 真 SQL | 一次、三表、兩個 JOIN、bar；沒有重送來源查詢 |
| 真 Grafana | org2 `admin`，一張新 Dashboard；chart／table 各一個原生 datasource 200 |
| 數值 | 表格兩列精確字串與同次來源一致；圖表按數值投影一致，不宣稱浮點是任意精度 |
| 結果安全負例 | 錯 Viewer／org／缺 backend key 各403 |
| 保留 | 七 Dataset 完整選取 Aspect＋systemMetadata 與既有語義 Run 不變；原歷史 session bytes／size／mtime 不變，只多一個本次範例 session |
| 模型文字收尾 | **未驗收**；驗收腳本送 Stop，最終 aborted，原 exit1 保留 |
| LSP | 私有 operator scripts 多數 inconclusive；JSON／validator／subprocess fail-closed advisory保留，不宣稱全 clean |

私有證據：`.local/evidence/query-restoration-20261002-bILlfo/`，以 `final-receipt.json`、`ui-example-progress.json`、`values-private.json`、`ui-dashboard-private.png`、`native-*-private.json`、`sessions-*-private.json` 及 source/config hashes 對帳。秘密、來源數值、完整 metadata 與登入 state 不納入公開文件。

## 回顧

已修復的是部署配置缺口，不是重寫查詢或用額外 grant 繞過現行授權。也補上目前登入者與 Grafana 帳號的真正對應，並在 restart 前解決共用工作目錄的未部署 source 邊界。

驗收腳本只等 RPC idle，卻立刻要求最後訊息為 stop；本輪快照仍為 toolUse，腳本因此送了 Stop。已將其修正為同時等待實際 idle 與最後持久 assistant 的 terminal stop，但**未重跑已成功的 SQL／prompt**，故不宣稱修正後的自然收尾已驗證。這個檢查器修正不修改產品 runtime，亦不以此次腳本停止當成模型／來源故障。

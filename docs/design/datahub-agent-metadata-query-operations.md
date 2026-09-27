# Metadata query：部署接線與驗證邊界

此文件描述新的通用路徑，不是已部署宣告。**Join、Pi/MFE/Host UI 與 Dashboard writer 均為本輪程式範圍**；部署秘密、切換使用中的服務及真來源操作仍須對具體環境另獲授權，不是產品逐題審批。

## Host 設定

`integration/server.mjs` 的既有設定中加入下列欄位（範例值，不是可直接套到真來源的設定）。不得同時啟用舊 `sqlSourceOnlyGrantsByActor`、`sqlPasswordPath` 或 `grafanaDisplaysByActor`。

```json
{
  "queryConnections": [{
    "id": "warehouse-a", "tenant": "example",
    "platform": "mssql",
    "platformInstanceUrn": "urn:li:dataPlatformInstance:(mssql,warehouse-a)",
    "environment": "PROD", "database": "warehouse",
    "datasetPrefix": "warehouse-a.",
    "connectionPath": "/protected/query-warehouse-a.json"
  }],
  "queryGrafana": {
    "origin": "http://localhost:3000", "orgId": 2,
    "folderNamespace": "datahub-query", "datasourceUid": "datahub-query-results",
    "dataUrl": "http://127.0.0.1:9041/agent/grafana-data",
    "writerTokenPath": "/protected/query-grafana-writer"
  },
  "grafanaServiceKeyPath": "/protected/query-result-backend-key"
}
```

- 每個 binding 是**部署連線定位**，沒有 Actor 清單、逐題 approval 或累計查詢配額。tenant 要與 server 的 `tenant` 相等；平台 instance／environment／database／前綴以當前 ingestion metadata 精確匹配。歧義、缺 binding、跨來源 Join 都拒絕，不能改用猜測的來源。`queryGrafana` 啟用時，Catalog 仍以登入者公開 API/ACL 決定可見內容，不要求另列每人 Catalog grant。
- `connectionPath` 為同 UID、一般檔案、無群組／其他人權限、非 symlink 的絕對路徑。其 JSON 欄位：`host, port, username, password, database`；Oracle 可加 `serviceName`，MSSQL 可加 `cafile`。這是 Host 部署的受保護秘密輸入，不是普通 Aspect、Pi 設定或第二份業務 datastore。不得自行抽取 ingestion 管理帳號／舊試點秘密使用；若採既有 Secret manager，由可信部署供給此輸入，不把秘密交给 Reader 或模型。
- `integration/requirements-query.txt` 固定本地測過的 SQLAlchemy／python-tds 版本。2026-09-27 MSSQL 已以新唯讀帳號在 B／org2 完成兩題真三表 Join、原生 bar/stat 與附表逐值對帳及模型自然收尾；Oracle／PostgreSQL／MySQL 只做方言／程式接點，driver 尚未安裝，不能宣稱真支援已驗收。缺 driver 回 `query_driver_unavailable`，不偷偷安裝／換帳號。
- Python child 用固定 script、`-I -B`、隔離環境與 stdin 收秘密；不跑模型 shell、不接受 SQL 字串、不繼承 Host 憑證環境。SQLServer/Oracle/PostgreSQL/MySQL 僅執行由結構化 SELECT 編譯的語句，值參數化、identifier 由剛授權的 schema 得到，完成及失敗均不 commit。

## Grafana 的一次性環境配置

沿用既有同站 sibling portal 與 Infinity **backend** 模式，不改全域 Cookie／主題／org1。

1. 同站獨立 Grafana origin、固定 org 與已釘版本的 Infinity datasource。datasource 只能取部署指定的結果端點；需要 server-only `X-DataHub-Grafana-Auth`，以及原生登入者／org 插值的 `X-DataHub-Grafana-Login`、`X-DataHub-Grafana-Org`。Infinity 3.11.2 已知 org2 namespace 為 `org-2`。不得從模型／一般 Viewer 自填這些身份標頭。
2. 預設以 DataHub `urn:li:corpuser:<subject>` 的 subject 對應該 org 的 Grafana `login`（例如同一 SSO subject）。若既有帳號名稱不同，可在 `queryGrafana.subjectLogins` 設定經確認的 `{"urn:li:corpuser:alice":"alice-viewer"}` 身分對照；不能由模型或 metadata 自填，不能讓多個 subject 共用一個 Viewer，也不能以預設同名方式占用已映射給別人的帳號。這是顯示身分對照，**不是 SQL grant 名單**，沒有此項的普通同名 SSO 使用者仍能使用。缺少可信對應時回 `query_grafana_identity_unavailable`，不自動冒用別人的 Viewer。後端結果再核 current DataHub session、Actor、tenant、browser grant、Grafana login/org 與 metadata ACL。
3. Writer token 存受保護檔案，最少需原生 org/user lookup、`serviceaccounts:read`、folder create/ACL read-write、Dashboard create/read 能力。Grafana 13 的 Service Account `/api/user` 回傳 `id:0`；Adapter 透過公開 `/api/serviceaccounts/search` 以原生 name/login/org 核對唯一且啟用的帳號，取得 ACL principal ID，不解析 opaque UID、不以 0 寫 ACL。Writer 不交給 Pi、瀏覽器或模型。13.1.2 實測 Editor 的 org user lookup 回 403；正式 org2 Admin Service Account 經使用者另行核准後才建立，未取得 Grafana Server Admin。不得把 org1 或其他專案的管理 token 當替代。
4. **每人私有原生 folder**：Host 查 `/api/org`、`/api/user`、`/api/org/users/lookup` 精確定位身分；依 namespace/org/native user ID 產生 `dqf-*`。新建空 folder 後，只給該 Viewer View 與 Writer Admin，讀回 ACL 確認沒有 Viewer/Editor/team/inherited 泛用權限，才寫 Dashboard。既有 folder 的 ACL 若被分享，停止發布，不覆寫其權限。這避免另一個使用者經 Grafana JSON 看到不屬於其可見 metadata 的欄名／標題。Grafana 原生 org administrators 的管理存取權仍存在。
5. 每次查詢產生新的 `dq-*` Dashboard UID，`overwrite:false`，寫入後讀回 panel/UID/folder；失敗或未知效果不盲目重寫、不重跑 SQL。實際圖表使用浮點繪圖；附屬表格使用字串保留 decimal／大整數精度，避免假稱圖表浮點與任意精度值完全相同。time-series 範圍由此次結果時間欄位決定，不固定「今年／現在」。原生 frame URL 指定 `theme=light`。Infinity 3.11.2 的 URL target 必須明確帶 `url_options: {method: "GET"}`；只給 `source:"url"` 不會自動補齊，前端會在發送 datasource request 前拋錯。

2026-09-26 隔離的真 Grafana **13.1.2** 已驗證 Service Account、私有 folder/ACL、兩個動態 Dashboard 與另一 Viewer 拒讀；合成帳號、network-none/tmpfs 資源已清理。後續經核准完成正式 org2 writer/datasource/Viewer 與 Agent 切換，首題真 Join 與 Dashboard 發布成功，但 Infinity 缺 URL method 導致 client 拋錯；該輪已停止。method 修正完成原生瀏覽器 RED→GREEN 後，另經使用者确认重載 Host。r2 已完成兩個真三表 Join、bar/stat 原生表格逐值對帳及錯 Viewer/org/key 拒讀；模型額外附表查詢被驗收 guard 擋下的兩筆紀錄保留，不稱無干預模型收尾。r3 已補清楚兩個工具的自帶附表說明，經另次確認切換 Pi 映像／assets 後，以相同原兩題、無成功次數攔截通過真模型自然收尾及圖表／附表逐值對帳，沒有額外 SQL 或工具錯誤。每個非 table Dashboard 已附同次回傳結果表，受 limit／truncation 限制；它不是聚合前的交易明細，無須只為附表重送相同 SQL。詳見[後續驗證](../verification/datahub-agent-metadata-query-native-20260926.md)。

## 資源與生命週期（非固定業務限制）

- 查詢意圖：同來源最多 8 個 table alias、inner/left/full Join（MySQL 拒絕 full）、多個 ON predicates；投影、聚合、日期分桶、AND filters、group/order。沒有自由 SQL、任意函式、跨來源 Federation；尚未支援的語法明確拒絕，不宣稱覆蓋所有 SQL。
- 返回 1–1000 筆；多讀一筆判斷 truncation。每來源並行 2，driver timeout 30 秒，單 child 上限 40 秒，取消後等待 child 結束才釋放名額；不自動 retry。
- 數值結果最多 1 MiB、預設保留 15 分鐘；Host 總暫存有界。重啟會遺失暫存，不是恢復舊 SQL 額度，不會重播歷史查詢。
- `resultRef` 只給模型無数值收據，`displayRef` 只在已綁身分下讀值，不是 bearer。Pi SQL preview 走 UI-only channel，查詢／顯示的工具收據拒絕 SQL、rows、秘密與 URL 夾帶。
- `EMPTY` 只表示來源回空結果，不是技術／業務關係 PASS。過期、撤權、schema 改變或失去 browser grant，均停止新讀回；重開圖表不暗中重跑 SQL。Grafana 的原生 folder/Dashboard 可保留（無結果資料），不自行破壞歷史。

## 正式驗收仍需的證據

r3 已完成真 `/mfe/agent` 的 B／org2 兩種不同問題／條件／圖型、多表 Join、原生圖表與結果表對帳，以及無攔截的模型正常收尾；實際錯 Viewer／org／key 與失去 browser grant 拒讀也通過。後續隔離真 SQL Server 已驗 driver timeout、HTTP cancel、來源 session 終止、相同請求不重跑及並行名額／新查詢恢復，見[生命週期證據](../verification/datahub-agent-query-lifecycle-20260927.md)；DataHub identity／metadata 為 fixture，不冒稱真模型 Stop 按鈕完整 E2E。[結果邊界收尾](../verification/datahub-agent-query-result-boundaries-20260927.md)另已完成隔離真 MSSQL 的 8 次 SELECT 與固定 Infinity 原生解析：空結果、NULL、精確字串、截斷及超量拒絕／恢復均通過。所有圖表／附表的可見截斷標題經核准只重載 Host 生效（PID 2364312；Pi image／assets／設定不變），不修改歷史 Dashboard。仍需 metadata 撤權與 schema 變動、正式來源／audit 對帳及其他來源證據；這些不在本輪繼續擴張。不以目前兩題成功取代這些尚缺的證據，也不得以 fixture、HTTP200、可按訊息卡或歷史固定試點代替。

公共 API 依據（2026-09-26 閱讀；需在本案固定版本重驗）：[org API](https://grafana.com/docs/grafana/latest/developer-resources/api-reference/http-api/org/)、[folder API](https://grafana.com/docs/grafana/latest/developer-resources/api-reference/http-api/folder/)、[folder permissions](https://grafana.com/docs/grafana/latest/developer-resources/api-reference/http-api/folder_permissions/)、[Service Account API](https://grafana.com/docs/grafana/latest/developer-resources/api-reference/http-api/serviceaccount/)。

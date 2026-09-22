# T02：真 DataHub Agent → 官方 DataHub MCP

2026-09-12，主代理實作與安全自查，非獨立審查。

## 結果

**T01 + T02 的第一條 Agent E2E 已通過。** 在真 `http://localhost:9002/mfe/agent`，GPT-5.6 Sol 經未修改的 `pi-mcp-adapter@2.33.0` 實際呼叫 `datahub_get_entities` 與 `datahub_get_lineage`，回覆 `DATAHUB_MCP_E2E_OK_20260912`；整頁 reload 後仍能讀回回答。

- Dataset：`urn:li:dataset:(urn:li:dataPlatform:mssql,adventureworks2019.person.person,PROD)`。
- 真工具結果包含 13 個 schema fields，與直接 GMS GraphQL 讀取的欄位／型別一致。MCP 輸出會重排欄位，不能將其列序解釋成來源 ordinal。
- Downstream 本次只取 3 個 View：`humanresources.vemployee`、`humanresources.vemployeedepartment`、`humanresources.vemployeedepartmenthistory`；其完整 URN 與大小寫留在證據。另以 GMS GraphQL 分別讀三個 View 的 upstream，均包含 Person.Person。
- MCP 回報 downstream total=10、returned=3；這是限定頁，不是全部 lineage。即使該版結果有 `hasMore:false`，也不據此聲稱全量覆蓋。
- 沒有執行來源 SQL、沒有重新 ingestion、沒有把 FK 當成 lineage；工具回覆中的 View DDL 是既有 metadata，不是本輪執行指令。

## 最小接線與權限

使用者明確批准官方固定版 MCP、本機 8042、專用唯讀帳號／短效 token、僅目前 Actor 的 MCP 連線，以及必要的 Agent restart。

1. 官方 `mcp-server-datahub 0.7.0` 使用原生 stateless HTTP 與 per-request DataHub bearer token，無自製 MCP 協定、共享管理員 token 或新 datastore。
2. 透過公開 GraphQL 建立原生 service account「Agent T02 MCP reader」，指派既有 Reader role；未修改全域政策。實際 metadata 查詢 200，使用該 token 嘗試寫入合成 canary Aspect 得到 **403**；未將此憑證交給 runtime 前先完成權限確認。
3. MCP 停用 mutation、document、semantic-search 工具；discovery 實際只有 7 個唯讀工具。匿名／無效 token 的 `/mcp` 都是 **401**。`/health` 的 200 只證明程序存活。
4. 沿用 operator-only `egressOriginsByActor`，只對既有核准 Actor 加入 `http://datahub-mcp:8042`。這是固定映射至 Host `127.0.0.1:8042` 的專用名稱，不經 DNS，也不是任意內網 allowlist。其他 GMS／來源 DB／metadata IP 仍拒絕；原 OpenAI HTTPS443 規則不變。
5. 既有 egress proxy 同時支援這個固定目的地的 CONNECT 與 absolute-form HTTP。HTTP 模式同樣套用 Actor policy、容量及撤銷，移除 proxy authorization；不修改 adapter/client。
6. 唯讀 token 透過原生 MCP config API 保存與讀回，未輸出 token。没有讀使用者 OAuth、開發機憑證或來源 Secret 值。

**本次 token 的原生到期時間是 2026-09-12 08:35:15 +08:00。** 到期後新查詢需由 operator 透過原生機制重新配置；本輪沒有自動續期／長效化。歷史成功與 session 讀回仍有效，不代表連線永不過期，也不代表 ingestion／寫入權限已授予。

## 固定版本與部署

- 官方 source commit：`3c2d18cb87dab223568610651fc8b91dfab27a8e`（v0.7.0）。
- Archive：`https://codeload.github.com/acryldata/mcp-server-datahub/tar.gz/3c2d18cb87dab223568610651fc8b91dfab27a8e`。
- Archive SHA256：`78038af05c181fc95964e9cce6a31f132d44aacce4b9ff1515f1fd4cb616ee18`。
- 本地映像：`sha256:676ffc26f91b811da11ad20d0a4ad09cebc7ac7c7ff72a115f0f04eb6639f4cb`，linux/amd64，沒有發布至 registry。
- `extensions/datahub-agent/deploy/Dockerfile.datahub-mcp` 依官方 Dockerfile，只固定 base digest／release defaults；原 `uv.lock` 與 MCP 實作不改。授權保留於同目錄 `MCP-LICENSE`。
- 映像內 29 個非生成 Python 檔逐檔與官方 source 相同；版本為 MCP 0.7.0、其鎖定的 acryl-datahub SDK 1.3.1.10、FastMCP 3.2.3、MCP SDK 1.26.0。未變更本專案 CLI 1.7.0.9。
- Docker Hub 公開查詢 404、GHCR 預建映像 denied 已保留；沒有取得 registry 私人憑證，而以既有 `ekop-datahub-agent-limited` builder（1 CPU／3 GiB／無額外 swap／serial／flock）建置，完成後停止 builder。沒有 build Pi image。
- `deploy/compose.mcp.yaml` 僅新增 MCP service：loopback 8042、non-root、唯讀 root、cap-drop、no-new-privileges、1 CPU／1 GiB、有限 tmpfs；沒有新增 volume／資料庫。

已建置相同映像後，啟停只指定這個 service，不使用 `--remove-orphans`：

```bash
env -i PATH="$PATH" HOME="$PWD/.local/agent-build-home" \
  docker compose -p ekop-datahub -f deploy/compose.mcp.yaml \
  up -d --no-deps --pull never datahub-mcp
# 停止 MCP 時使用同一組 -p/-f，再執行 stop datahub-mcp。
```

建置時以已校驗 archive 的解壓目錄作 context，使用上述 Dockerfile、既有受限 builder 與 `.local/agent-build.lock`；不得因本地映像不存在就改用浮動 latest 或無限制 builder。

Gateway 最終 PID `2281517`，恢復前仍須重新核對 PID/cmdline/cwd。兩次本輪 Agent 切換均保留原 HOME 與 Pi image `57556f…`；所有既有 Core 容器 IDs 不變，Core checkout clean。

## 失敗與回歸

- 第一個 CONNECT-only 版本：獨立 MCP SDK discovery 成功，但真 Agent adapter 回 405，未冒稱 E2E 通過。
- 真 native adapter 的一般 HTTP proxy 請求被舊 handler 拒絕；補出同一限制下的 HTTP 轉送前，原生 HTTP regression 為 405 red，修正後 green。
- 最終 transport 測試包含未授權 Actor、錯誤目的地／userinfo／port、request body、移除 proxy authorization、CONNECT 及 HTTP/SSE 中途撤銷；在隔離 network-none container 通過。既有 gateway／server／identity／transport **22/22** 通過。
- `tests/check_agent_datahub_mcp.mjs --live` 使用明確指定的 0600 唯讀 token file，實際 discovery／schema／lineage 通過；它另標示不取代瀏覽器驗收。
- 修改的 JS／YAML primary LSP clean；Dockerfile 無可用 LSP。Pi RPC 檔未修改，hash 仍為先前 `69ac6662…`；既有 20 個 assertion 診斷沿原 source-bound 查核 defer，舊行號 advisory 仍出現，不為清告警擴改 Pi，也不宣稱全 repo clean。

```bash
# 顯式 live opt-in；檔案必須由 operator 提供，不自動找憑證。
DATAHUB_MCP_READ_TOKEN_FILE=/path/to/private-read-only-token \
  node tests/check_agent_datahub_mcp.mjs --live
```

## 證據與後續

本地 `.local/evidence/agent-datahub-mcp/`（不提交／上傳）：`build-inputs.json`、`build.log`、`official-code-match.json`、`http-auth-negative.json`、`reader-live-permissions.json`、`tools-live.json`、`egress-*-red.log`／`egress-final.log`、`regression-final.log`、`browser-query-first.json`／`browser-query-second.json`、`browser-tool-results.json`、`browser-readback.json/png`、`gms-lineage-readback.json`、`live-check.log`、`source-state.json`。其中憑證檔不是驗收附件，禁止輸出或上傳。

T03 已開始原生只讀盤點：查到既有 `AdventureWorks2019 - all metadata` MSSQL Source，無排程；三筆歷史 execution 為兩次 SUCCESS、一次 FAILURE。尚未執行新工作／取消／重跑，也未讀取 Secret 值。`adventure` 搜尋為零，改用 `mssql` 後找到一個原生 Secret 的名稱／URN；仍不等於已驗證 recipe binding。Reader 呼叫 Source／Secret 管理查詢均得到授權拒絕（HTTP 200 但 GraphQL errors、data=null），不能只按 HTTP 200 判成功。官方這 7 個 MCP 工具不含 Source／Secret／ingestion 操作；先完成 T03 公開 API 與原生執行機制實測，再決定 T04 必要缺口。

# DataHub Plugin Platform

以官方 DataHub 作為標準 Metadata Catalog；本專案承載本機部署設定與後續第一方插件，不修改 DataHub Core。

## 現況與進度（2026-09-19盤點）

已交付官方DataHub、真Agent模型／MCP／原生ingestion，以及本案SalesDatamart建置、Python ETL真載入／重跑／rollback、Grafana v2及唯讀Discovery入口。完整欄位／治理發布、Agent固定ETL操作及最終跨入口閉環仍未完成；不是只做到初始安裝。

詳見[整案進度盤點與任務移轉](docs/verification/datahub-progress-inventory-20260919.md)、[業務Goal TODO](docs/datahub-sales-datamart-todo.md)、[平台T01–T07](docs/datahub-agent-todo.md)。已驗歷史不代表本日live健康／過期token仍有效。

## 部署與範圍

- 固定 DataHub Core `v1.7.0.1`，官方原始碼以 `upstream/datahub` Git submodule 管理。
- 上游 commit：`e99431ec510d7a2001f815c6bf70913c493af76e`。
- 使用官方預建容器；不是從原始碼重新編譯 Core。
- `deploy/images.lock.yaml` 固定全部七個容器的 digest；CLI 固定 `1.7.0.9`。
- 本機 UI：<http://localhost:9002>；GMS：<http://localhost:18080>。
- 已透過插件／Host擴充接入核准AdventureWorks2019，並實際執行固定SalesDatamart ETL及Grafana唯讀SQL。尚無任意來源查詢Broker／通用受控SQL查詢，也未完成Agent固定ETL可信操作。
- Ingestion 預設匯入表／欄位／關係等 Metadata，不複製整庫業務資料。

這是單機開發環境，不是正式環境，也尚未完成架構文件 G0 的全部插件能力驗收。

## 安装

需求：Docker Engine、Docker Compose ≥2.24.4（支援 `!override`）、Git、Python 3.11+。官方 Quickstart 建議至少 2 CPU、8 GiB RAM、2 GiB swap，與既有服務共用主機時另留餘裕。

```bash
git clone --recurse-submodules https://github.com/paulpai0412/datahub.git
cd datahub
# 已有 checkout 時：git submodule update --init --recursive
python3 scripts/init-local.py
./scripts/compose.sh pull
python3 tests/test_installation.py
./scripts/compose.sh up -d --wait --wait-timeout 600
python3 tests/test_installation.py --live
```

`init-local.py` 首次產生本機隨機密碼與簽章金鑰；重跑保留既有值。不要刪除 `.local/` 後直接沿用舊資料卷啟動；來源密碼與 token 金鑰必須保持一致。

### 登入

使用者：`datahub`。密碼存於本機 **`.local/user.props`**（格式 `使用者:密碼`），請在自己的編輯器中查看，不要貼到 issue、聊天、Git 或公開日誌。官方預設密碼 `datahub` 已被替換。

UI 和 GMS 僅綁定 `127.0.0.1`；Windows/WSL 通常可透過 localhost 使用。未開放區網或網際網路入口。若 Windows localhost forwarding 未啟用，先確認 WSL 設定，不要直接改成 `0.0.0.0`。

### CLI

若主機已安裝 `uv`：

```bash
uv venv --python 3.11 .venv
uv pip sync --python .venv/bin/python deploy/cli.lock.txt
.venv/bin/datahub version
```

本案SQL Server connectors／既有Source、Secret bindings及限定native ingestion已實測；版本鎖與證據見專用TODO。新Oracle或其他來源仍須先確認範圍、權限及秘密交付；不能沿用本案授權，也不因歷史憑證曾有效就假定目前可用。

## 日常操作

```bash
./scripts/compose.sh ps -a
./scripts/compose.sh stop
./scripts/compose.sh up -d --wait --wait-timeout 600
python3 tests/test_installation.py --live
```

- Compose project：`ekop-datahub`；網路與三個資料卷均使用 `ekop-datahub-` 前綴。
- 常駐容器設定 `restart: unless-stopped`；`system-update` 為一次性初始化工作，成功退出是正常狀態。
- 自動恢復以 Docker daemon 已啟動為前提；本專案不設定 Windows 登入時自動啟動 WSL，也不重新啟動整台主機。
- 不執行 `down -v`、`docker volume prune` 或上游 `nuke`；它們可能刪除資料。
- 不使用未固定版本的 `datahub docker quickstart`，避免意外啟動另一套服務或換版。
- 日誌可能含敏感資訊，僅在本機檢視；不要直接提交完整 `docker inspect` 或 `compose config` 輸出，它們含環境變數／密碼。

## 安全與插件開發

- GMS 與 Frontend 同時啟用 Metadata Service Authentication。
- MySQL、Kafka、OpenSearch 不發布主機埠；仍屬開發用內部信任網路，不能把任意不可信容器接入。
- 移除官方 Actions 預設的 `~/.aws` 掛載；不掛 Docker socket 或任何既有專案憑證。
- `.local/`、`.venv/`、私人環境檔與工具快取不進 Git。
- `.local/plugins` 與 `.local/search` 為本機唯讀掛載入口；Agent Task／Run官方模型擴充0.1.1已有部署證據。publication模型0.1.3已本地建置驗證但尚未部署，不能混稱。
- 上游來源保持乾淨；後續 Model／MFE／Actions／Ingestion 適配器放在本專案，產物再部署到正式擴充點。
- 使用者 2026-09-12 核准：先打通 Agent 真模型→DataHub MCP 的 E2E，再沿原生 Source／Secret／ingestion 推進；不另外建立新 datastore，未來客製沿用官方 datamodel／Aspect／API。詳見 [最新 TODO](docs/datahub-agent-todo.md)。
- [T01–T02 第一條 Agent E2E 已通過](docs/verification/datahub-agent-datahub-mcp.md)：真模型、官方唯讀 MCP、schema／lineage 與 session 讀回；本次使用短效 token，並非 ingestion 或全平台驗收。

正式接入前需補：SSO／角色與來源授權、資料分類、來源帳號 least privilege、網路/TLS、保留政策、備份及還原演練。`restart` 和 Docker volume 不等於備份。

## 下一步：接入資料庫

請先提供（不要在聊天貼密碼）：

1. Oracle／SQL Server 版本、連線位置、service/PDB 或 database。
2. 可讀取的 schema/table allowlist、平台來源識別名稱。
3. 來源帳號的權限範圍與安全憑證交付方式。
4. 是否允許讀 Query Store／V$SQL、是否允許 profiling／聚合 SQL。
5. 允許的查詢負載、timeout、並行數與觀測時段。

先跑 metadata-only 小範圍盤點，確認 URN、欄位、權限與 ingestion 報告後再擴大；SQL 驗證與使用者查詢執行分別設計授權，不因 Catalog 可見就授予來源 SELECT。

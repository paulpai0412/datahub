# OpenSearch curl 殭屍累積：根因與修復

2026-09-12；使用者要求先處理系統異常，暫停 T06。已明確核准只重建本案 OpenSearch，保留原資料 volume／映像，不動其他容器。

## 已證實的因果鏈

固定官方 `v1.7.0.1` 的 `upstream/datahub/docker/quickstart/docker-compose.quickstart-profile.yml:370–377` 使用：

```yaml
test:
  - CMD-SHELL
  - curl -sS --fail http://search:$${DATAHUB_ELASTIC_PORT:-9200}/_cluster/health?wait_for_status=yellow&timeout=0s
interval: 5s
```

URL 沒有被 shell 引號包住。`&` 不是傳給 curl 的 query separator，而是 **shell 背景執行操作符**：

1. shell 啟動背景 curl，只傳入 `...?wait_for_status=yellow`。
2. shell 執行 `timeout=0s` 變數賦值並以 0 結束；不等待 curl，也不傳回 curl 的錯誤。
3. 尚未結束的 curl 被重新歸給容器 PID 1，即 Java；Java 不會作為通用 init 回收这些孤兒。
4. curl 結束後保持 zombie，每 5 秒累積一次。這不是 Java heap／GC 問題，也不是 15,000 個 curl 還在進行查詢。

證據交叉吻合：

- 真容器 healthcheck 與上述命令一致，未配置 init；host PID **851** 的 `NSpid: 851 1`。
- 初查 15,213 個 curl zombie 全部 `PPid=851`；時序樣本 15,217 個，主要間隔 5.04／5.05／5.06 秒，跨 21.54 小時。
- 修復前正式快照累積到 **15,258** 個 curl zombie。
- 原指令的本地 shell 判別實驗，將 curl 換成會回 7 的函式：URL 參數確實缺少 `&timeout=0s`，healthcheck shell 卻回 0。實驗最後 `wait` 回收其子程序，沒有再留下孤兒。
- Docker health log 有 `procReady not received`／`unable to start container process`；此前宿主也有 EAGAIN。大量 zombie 佔用程序資源是確定異常，但取樣時 cgroup `pids.events max=0`，不能宣稱已證明所有 EAGAIN 都是撞到某個特定 PID 上限。

## 最小根因修復

只在 `deploy/compose.local.yaml` 覆寫 OpenSearch healthcheck，改成直接 exec：

```yaml
test: [CMD, curl, -sS, --fail, "http://localhost:9200/_cluster/health?wait_for_status=yellow&timeout=0s"]
```

沒有 shell，也就沒有 `&` 背景化／退出碼遺失；Docker 直接等待 curl。維持既有 interval、timeout、retries、固定 9200 服務、映像及 volume。不加新 reaper、不提高 PID 限額、不停用 healthcheck、不 patch Core。

既有 zombie 已死亡，`kill curl` 無法回收。以使用者核准的單一容器重建，結束原 Java/PID namespace，釋放已累積的程序表項：

```sh
scripts/compose.sh up -d --no-deps --no-build --pull never --force-recreate --timeout 60 opensearch
```

未使用 `down -v`、prune、remove-orphans；Compose 的 MCP orphan 提示未被當成刪容器指令。

## 真實恢復證據

- OpenSearch container `279a99a5a620…` → `4063fc3a46f9…`；新 Java PID **918264**。
- 映像仍 `sha256:e96cc6ae1500a073d973c0906f30f7cf4d9c461f32f855f9242a2da933660cdd`。
- 同一個 `ekop-datahub-opensearch` volume、mount 完全一致；其他本案容器 IDs 不變。
- OpenSearch zombie **15,258 → 0**；後續再查仍 0，原 PID 851 已不存在。整機可見程序 137，其他 parent 尚有 5 個 zombie（GMS Java 3、SQL Server 2），未擅自重啟那些服務。
- `python3 tests/test_opensearch_healthcheck.py --live` 通過：六次**新增的真 Docker healthcheck**、同一 Java PID、零 zombie；不存在的唯讀 HTTP route 正確使 curl 回 **22**。
- 91 個索引名稱／UUID 全部相同；90 個 docs.count 不變，`top_queries-2026.09.12-04090` 從 1260 增至 1276，無索引消失或筆數下降。不是全資料 checksum 或備份回復驗收。
- 真 `datasetindex_v2/_search` 回 4 個既有 canary URN，包含 Person.Person／vEmployee，無 timeout／failed shards。
- UI `/health`、`/login`、GMS `/health` 均 200；shell／Docker／Python 執行恢復。
- **已登入 DataHub GraphQL 搜尋未重驗**：保留的 browser CDP 38755 已 `ECONNREFUSED`。未另開身份或讀憑證；上述搜尋證據是 OpenSearch 真搜尋，不冒充完整瀏覽器 E2E。

## 可重跑檢查與原始證據

`tests/test_opensearch_healthcheck.py` 預設驗真正合併後 Compose；`--live` 再觀察真 healthcheck、退出碼及 zombie。避免使用會讀登入帳密的既有 installation live harness。

本機 `.local/evidence/opensearch-zombies/`：`before.json`、`after.json`、`before/after-indices.json`、`compose-check.json`、`shell-semantics.log`、`recreate.log`、`healthcheck-live.log`、`index-diff.json`、`recovery-check.json`、`opensearch-search-readback.json`、`opensearch-search-check.log`、`system-recovered.json`、`source-state.json`。

保留的檢查差異：初版 capture 的 Docker template 直接取不存在的 `HostConfig.Init`，改用 map lookup；首次「所有筆數完全相同」斷言失敗，查明只有上述一個索引增加 16，未重播操作；搜尋 receipt 初次斷言使用 display-name 大小寫，改用兩個精確 lowercase URN 重驗已存回應，未重跑查詢。這些不是 OpenSearch 修復失敗或成功的替代證據。

Python primary LSP clean。通用 YAML scanner 不識 Compose 官方 `!reset/!override`；實際 Docker Compose parser 已通過，標為 false-positive，沒有刪除安全設定。測試的 sleep 是有 deadline、依 healthcheck Start 判斷的 polling，不以固定等待時間當成功。

**結論：根因是 shell 誤解析 healthcheck URL，加上 Java PID 1 未回收被收養的 curl；消除產生端後，一次受控重建回收存量，並驗實際檢查不再增生。**

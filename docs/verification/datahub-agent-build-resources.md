# Docker 建置資源防護（歷史門檻研究）

**最新決定：使用者已取消 RAM/swap/disk headroom 前置門檻。以下保留首次 source-only 研究及舊模板，不再作為目前的執行流程。** 舊 checker 的 BLOCKED 不是新測試的阻擋，也沒有改報 READY。

本案專用 builder 已完成實際 1 CPU/3 GiB/no-extra-swap/serial solver cgroup 驗證與 MCP candidate 建置，現已停止；未 prune／修改 WSL/Windows，亦不宣稱修復了原 hang。現行版本及 receipts 見 [MCP 建置驗證](datahub-agent-mcp.md)。

以下為 2026-09-11 首次暫停重型操作時的歷史紀錄。

## 已修改

- `Dockerfile.pi-web` 的 Git/CA 安裝移至 package manifests 和完整 source COPY 之前。UI 修改不再使套件安裝層失效；保留 Node/image pin、non-root、npm lock、Webpack 與原 runtime。
- `scripts/check-agent-build-resources.py` 是純讀取 preflight，不會呼叫 Docker。資源不足或資訊未知 exit 1；允許的 snapshot 回 `READY_FOR_REVIEW`，不是授權或可安全建置的保證。不存在 force bypass。
- `deploy/buildkitd.toml` 設定 OCI solver `max-parallelism=1`。**TOML 本身不限制總記憶體或 CPU，亦尚未載入任何 daemon**；完整上限需搭配下列官方 docker-container driver options。
- 離線回歸：`tests/test_agent_build_resources.py`，涵蓋各門檻、無 swap、非 WSL、NaN/Infinity/負數/不完整資料、真 parser 錯誤與 main fail-closed、Dockerfile cache 順序及 solver 設定。它不是 hang 的 red→green 證據。

### 保守准入門檻

| 指標 | 必要餘裕 |
| --- | --- |
| Linux MemAvailable | 至少 6 GiB（預留 builder 3 GiB＋其餘 3 GiB） |
| SwapFree（有 swap 時） | 至少總量 25% |
| memory full PSI avg10 | 小於 1% |
| I/O some PSI avg10 | 小於 5% |
| Linux `/` free | 至少 20 GiB |
| WSL 的 Windows C 槽 free | 至少 25 GiB；無法讀取則拒絕 |

這是暫定安全政策，不是推算完成時間或根因。Swap 使用量可能是歷史殘留；低剩餘量在此仍保守阻擋。Linux sparse VHD 顯示的剩餘空間不等於實體 backing disk 餘裕；C 槽也不一定是 VHD 所在磁碟。正式執行前仍須確認實際 Docker/WSL storage 所在磁碟與 Windows RAM；不得自動 prune、刪 cache/volume、swapoff 或改 `.wslconfig`。

```bash
python3 scripts/check-agent-build-resources.py
python3 tests/test_agent_build_resources.py
```

## 待核准的專用 builder 配置

**以下是操作模板，不是已執行／已驗收狀態。** 需資源檢查通過、核准使用官方 BuildKit 映像的 exact digest，才可初始化。未引入浮動 BuildKit 版本，沒有自動安裝新依賴。

使用專案獨立空 HOME，不繼承 developer Docker registry login/context；不使用 `--use` 改全域 builder。不採用／覆寫同名未知 builder。命令中 endpoint 明確限定本機 Unix socket；不要改接 remote daemon。

```bash
# REVIEWED_BUILDKIT_IMAGE 必須先完成映像審查，不能用 latest/tag 代替。
# 預期格式：moby/buildkit@sha256:<64 hex>
# 首次核准後才建立，不能重複對未知同名 builder 執行。
(
set -eu
python3 scripts/check-agent-build-resources.py
python3 -c 'import re,sys; sys.exit(0 if re.fullmatch(r"moby/buildkit@sha256:[a-f0-9]{64}", sys.argv[1]) else 1)' \
  "${REVIEWED_BUILDKIT_IMAGE:?review exact BuildKit image first}"
mkdir -m 700 .local/agent-build-home

env -i PATH="$PATH" HOME="$PWD/.local/agent-build-home" \
  docker buildx create --name ekop-datahub-agent-limited \
  --driver docker-container \
  --driver-opt "image=${REVIEWED_BUILDKIT_IMAGE:?review exact BuildKit image first}" \
  --driver-opt memory=3g --driver-opt memory-swap=3g \
  --driver-opt cpu-period=100000 --driver-opt cpu-quota=100000 \
  --driver-opt restart-policy=no \
  --buildkitd-config "$PWD/extensions/datahub-agent/deploy/buildkitd.toml" \
  unix:///var/run/docker.sock
)
```

`create` 未加 bootstrap。後續啟動 builder 可能拉取映像，亦須核准，不能當成純讀取。啟動後核對：

- driver 為 `docker-container`、僅一個本機 node；不是 default/unbounded/remote builder。
- 專用容器 HostConfig：Memory=3221225472、MemorySwap=3221225472、CpuPeriod=100000、CpuQuota=100000。相同 memory/swap 表示不額外提供 swap。
- 容器內 `/etc/buildkit/buildkitd.toml` 的 OCI max-parallelism=1，且 daemon 確實載入此 config。
- 非上述值即停止，不能 fallback 原始 `docker build`。還需以有界 canary 驗 cgroup/readback；目前未做。

## 歷史建置模板（門檻已撤，不再作為執行流程）

確認上述限制後才使用 `--builder ekop-datahub-agent-limited`；每次都重新做 preflight，並持有本專案 `flock`，避免本案同時跑兩個建置。資源不足時不能略過檢查。

```bash
# 在 repository root，核准的 builder 已初始化／限制已核對後。
# 用一個專案鎖涵蓋 runtime build 和 cached assets export。
mkdir -p .local
env -i PATH="$PATH" HOME="$PWD/.local/agent-build-home" \
  flock -n .local/agent-build.lock sh -eu -c '
    python3 scripts/check-agent-build-resources.py
    .venv/bin/python scripts/check-agent-downstream.py
    docker buildx build --builder ekop-datahub-agent-limited --target runtime \
      --build-context agent-integration=extensions/datahub-agent/integration \
      -f extensions/datahub-agent/deploy/Dockerfile.pi-web \
      --load -t ekop-datahub-agent-pi-web:limited-candidate extensions/datahub-agent/pi-web
    python3 scripts/check-agent-build-resources.py
    assets=$(mktemp -d "$PWD/.local/agent-assets-XXXXXX")
    docker buildx build --builder ekop-datahub-agent-limited --target browser-assets \
      --build-context agent-integration=extensions/datahub-agent/integration \
      -f extensions/datahub-agent/deploy/Dockerfile.pi-web \
      --output "type=local,dest=$assets" extensions/datahub-agent/pi-web
    printf "Candidate assets: %s\n" "$assets"
  '
```

不覆蓋已驗證 runtime tag 或 export 目錄。新 image 仍需原 tests、artifact exactness、browser 驗收才能交付。失敗／逾時／取消時先確認 builder 的實際工作狀態，不自動重試；CLI 結束不保證 backend 已無工作。

**限制的邊界**：driver options 不是整台 Windows／Docker daemon 的上限，`--load` 匯入、磁碟寫入與其他程序仍在部分限制之外。Preflight 是瞬間觀測，鎖只約束遵循此程序的本案操作；不能承諾再也不 hang。不要同時跑瀏覽器矩陣／其他 build。OOME/編譯失敗時不擅自提高限制。

MFE 的 YAML/env/mount 更新不需要 build image，只需經核准後以既有映像重新建立 frontend；目前尚未執行。

官方依據（2026-09-11 查閱）：

- <https://docs.docker.com/build/builders/drivers/docker-container/> — memory/memory-swap/cpu-quota/cpu-period 等 driver options。
- <https://docs.docker.com/build/buildkit/configure/> — `--buildkitd-config` 與 solver max-parallelism。

本輪另外發現 10 個 pi-web 檔案不符合上次 downstream lock 的 bytes；抽查有排版變更，但未全數判定語意等價，亦未歸因給特定修改者。差異保留在 `pi-web-source-drift.json`／`.diff`，沒有覆寫這些來源、重生 lock 或藉舊 image 的 PASS 放行；部署前必須另外核對。上面的建置流程因此也先執行 downstream gate。

現場 snapshot／離線測試／來源 hashes：`.local/evidence/agent-build-resources/`。既有 A07 image `3374d158…` 的證據維持歷史真實；不拿它背書本輪 Dockerfile 新排序或新 builder。A04/A05/A07–A15 未結案。

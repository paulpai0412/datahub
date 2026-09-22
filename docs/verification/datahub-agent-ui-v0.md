# A06 — DataHub Agent UI v0 視覺候選

2026-09-11；主代理自查，非獨立審查。母任務 `TODO-a2daa81d` 仍 `in_progress`；A06 等待使用者視覺確認，A01–A15 不結案。

## 交付邊界

候選位於 `extensions/datahub-agent/design/`，使用已定 DataHub tokens、真官方 wordmark、Mulish 字體。Chat、History/Workspace、Details、Settings 六個分頁、Sources 可切換版型；不發送訊息、不儲存設定、不建立 terminal、不讀 inventory，所有敏感／執行欄位停用。左側 Core 導覽只是明示視覺參考，**不是成功 SSO 或真正 MFE 截圖**。

此候選未套進 pi-web，也沒有改 MFE/gateway/runtime。保持 506-file upstream baseline；不是刪掉既有功能後做一個新聊天 backend。Sources／secret／approval 的可信 parent 邊界仍待正式接線驗證；單一 preview document 不證明 origin 隔離。

詳細設計與 assets 來源：[brand-spec](../../extensions/datahub-agent/design/brand-spec.md)。

## 開啟／重跑

```bash
node scripts/preview-agent-ui.mjs 9141
# http://127.0.0.1:9141 — Ctrl+C 關閉；不是 Agent server
```

Preview server 只預載六個固定公開 artifacts，綁 loopback、GET/HEAD、無 API；不公開 repo root。CSP 禁 backend connect、表單提交、被其他頁嵌入；沒有模型／來源憑證路徑。以 HTTP 開啟，`file://` 不保證可載入 ES module。

```bash
HOME_DIR=$(mktemp -d /tmp/datahub-ui-v0-home-XXXXXX)
env -i PATH="$PATH" HOME="$HOME_DIR" \
  PLAYWRIGHT_BROWSERS_PATH=/home/timmypai/.cache/ms-playwright \
  node tests/check_agent_ui_preview.mjs
.venv/bin/python tests/test_agent_foundation.py
```

Browser/server 由 `finally` 關閉；新 HOME 可能保留空 cache/config 目錄。沒有常駐預覽／Agent server。

## Evidence / gates

| Gate | 結果／範圍 |
| --- | --- |
| Mechanical | Node syntax 三個 modules、既有 PostCSS parse 126 rules；foundation 3 groups、506-file baseline PASS |
| Browser | Chromium 153.0.8010.12、sandbox、新 HOME/context；1440×900、1280×720、768×1024、390×844 全通過 |
| Interaction | Chat/Settings/Sources 切換、六個 settings sections、History/Workspace、Files/Terminal details、Escape/native dialog 關閉及 focus return、手機 toolbar/composer 44px、reduced motion |
| Preview safety | POST/API/private/traversal/query 路徑拒絕；只載六個本地 assets；無 cookie/storage/backend traffic、credential fields disabled、console/page/network errors 0 |
| Diagnostics | 5-file primary LSP batch：4 clean、CSS timeout（未確認，不能算 clean）；CSS另以 PostCSS parse＋真 browser 驗。session `lens all` 最後回報 61 檔無 cached issues，不是全 repo proof；早期 opengrep silent 不算通過 |
| Visual | 主代理檢視代表性 desktop/mobile renders；20 張四尺寸／五狀態截图供使用者確認。非與已部署版比對的 visual regression |
| User approval | **待確認**；未開始把此候選當作正式 UI 套入 runtime |
| Full Pi/DataHub/model/DB/upgrade | 本輪不適用；A04/A05/A07–A15 的 required gates 仍 pending，不由此候選取代 |

`.local/evidence/agent-ui-v0/`：

- `browser-first.log`、`chat-390-red.png`：真手機版型錯誤。隱藏 Core reference 後，auto-placement 把 main 排入零寬第一欄；不是 auth／Playwright infrastructure failure。
- `agent-frame { grid-column: 2 }` 修根因；新增正向 width assertion，不能只以「沒有水平 overflow」當版型正確。
- `browser-after-grid-fix.log`、`browser-final.log`：修正後通過；最後另驗手機 controls 44px、screenshots 在 finite transitions 終點截取。
- `chat-*`、`workspace-*`、`details-*`、`models-*`、`sources-*`：四尺寸 final screenshots；`chat-390-red.png` 不屬 final。
- `syntax-final.log`、`foundation-final.log`；`source-before-final.json` 與 `source-state.json` 核對測試前後 source hashes 及複製 assets。

本輪沒有 child/model、DB/GMS write、DataHub MFE 註冊、Docker build／部署、Core 修改或 commit/push。既有 runtime image 的驗收仍屬原 lifecycle 證據，不被此 UI 候選覆蓋。

## 下一步與回顧

使用者確認版型後，正式換皮須重用 native components/handlers，另追蹤 downstream diff、production Webpack build、exact-image assets 與功能 parity。成功 DataHub SSO、MCP/Source/approval/worker/Registry 都仍需實作／驗收。

教訓：零 overflow 可能只是整個工作區消失；保留正向幾何與實際 hit-target 檢查。設計稿保持明示未接線，避免把假的 inventory 或成功狀態當進度。下一輪直接沿用已核准 tokens，不重做品牌研究或未改 source 的全套容器測試。

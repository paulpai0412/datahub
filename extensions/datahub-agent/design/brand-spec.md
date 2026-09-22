# DataHub Agent UI v0 — review artifact

狀態：A06 視覺候選，等待使用者確認；不是 Agent 部署或完整功能交付。
沿用已核准 [v2 設計](../../../docs/research/datahub-agent-pi-web-plan-v2.md) §4–6，不另提品牌方向。

## Design Read

- Artifact / audience：DataHub metadata 工作區；使用者在單一 Agent 入口整理對話、檔案、來源與設定。
- Mode：DataHub Extension；pi-web 視覺 overhaul，但 runtime、routes、API、session/draft/worktree 行為是保護契約。
- Visual language：DataHub 原生操作介面，白色 surface、細框、低動效、漸進展開。
- Dials：variance 1（穩定版型）、motion 2（只有按鈕反馈）、density 7（功能分 drawer/page，不塞三欄）、asset dependence 2（以介面結構為主）、brand fidelity 10（固定版本 tokens／真 wordmark／字體）。
- Viewports：1440×900、1280×720、768×1024、390×844；Agent 內容以 container query 決定 Details split/overlay。
- 不做多種未受邀風格、裝飾圖、假對話、假清單、成功 run、第二個 Pi/DataHub logo。

## Source-bound design system

DataHub `v1.7.0.1` / `e99431ec510d7a2001f815c6bf70913c493af76e`：

- `datahub-web-react/src/conf/theme/themeV2.ts`：primary `#533FD1`、selected `#ece9f8`、border `#ececec`、surface white、外框 12px。
- `src/conf/theme/colorThemes/{light,color}.ts`：gray200 `#F5F6FA`、gray400 `#F9FAFC`、gray700 `#5F6685`、gray800 `#374066`；shadow 使用 light theme 的既有 rgba。
- `src/fonts/Mulish-{Regular,SemiBold}.ttf`：未修改副本放在 `assets/`，14px 基準、程式碼在真 runtime 保留 monospace。
- `src/images/datahub_core.svg`：未修改官方 wordmark，僅在 **模擬 host 導覽** 顯示；真正 MFE 不會再畫 host/sidebar/logo。
- 歷史真 DataHub 畫面 `/tmp/datahub-home.png` 僅作本地參考，不複製進候選頁，不冒充本輪 live screenshot。
- Assets SHA-256 與來源比對記錄在 `.local/evidence/agent-ui-v0/source-state.json`。DataHub LICENSE / NOTICE 隨副本保留。
- Mulish name table 的 copyright / license ID 0、13、14 已查核；附 `assets/MULISH-OFL.txt`。完整 OFL 1.1 取自 [Google Fonts 官方檔](https://raw.githubusercontent.com/google/fonts/main/ofl/mulish/OFL.txt)（2026-09-11）。

## Preserve / improve / remove

- Preserve：原 pi-web 506-file baseline、session URLs/state、models/skills/plugins/profiles、terminal/files/worktrees；本輪完全不改該 snapshot。
- Improve：Chat 主區、History/Workspace drawer、Details、工作區內 Settings/Sources；窄容器 Details overlay、Escape/focus return、reduced motion。
- Remove：候選頁不保留第二套常駐 sidebar；只有外部 host 視覺參考 sidebar。
- 信任邊界：Sources / secret / approval 在可信 parent。這個單一 preview document **不是** origin 隔離驗證；真正接線仍須分離。
- Highest risk：把視覺候選誤認成已接線功能。因此全頁標示 Not connected，所有執行/存檔/憑證欄位停用，inventory 明示未載入而非宣稱空庫。
- Rollback：本輪沒有改 MFE、gateway、runtime image 或 pi-web；移除 preview artifact 即可，不涉及 production 回滾。

## View and check

在 repo root：

```bash
node scripts/preview-agent-ui.mjs 9141
# http://127.0.0.1:9141 — Ctrl+C 關閉
```

以 HTTP 預覽；不保證 `file://` 能執行 ES module。Server 僅提供固定六個 public artifacts，唯讀、loopback、無 API，CSP 禁 connect/form/embedding；不公開 repo root。

`tests/check_agent_ui_preview.mjs` 使用既有 Playwright，產生四尺寸 Chat / Workspace / Details / Models / Sources screenshots，測 keyboard、focus、44px mobile toolbar/composer targets、disabled credentials、no storage/cookie/backend traffic。Browser tests 必須用新 HOME/context；不是 DataHub/Pi/模型 E2E。

待使用者确认版型後，再把 token/layout 移入正式 pi-web downstream／可信 MFE，逐功能接線並重新 build/比對 image；不可直接把 preview 當正式 Agent 發佈。

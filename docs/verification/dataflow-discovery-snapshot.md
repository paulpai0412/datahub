# DataFlow Discovery — 唯讀快照 library 驗證

2026-09-13。Goal `mtzxzwn6-1zw7vn`／`discovery-skill` 進行中，非完成。主 agent 實作與自查，沒有子代理／獨立審查。

## 結果

新增 [snapshot.py](../../extensions/dataflow-discovery/src/dataflow_discovery/snapshot.py) 與 [本機測試](../../tests/test_dataflow_discovery_snapshot.py)。可信 Host 可捕獲明列路徑的 immutable in-memory source text／manifest：source scope、file／snapshot SHA256、大小與UTF-8檢查、不跟隨symlink的directory-relative open、常見敏感檔／內容拒絕。沒有任何持久化store、DB／模型／network操作。

- Python 3.11.15（本專案既有 `.venv`）：15 tests PASS。
- Python 3.14.4（本機既有系統Python）：15 tests PASS。
- 3個Python檔案 primary LSP：0 diagnostics。
- 新module／test／README共4檔 cached lens all：無issues，非全repository掃描。寫檔時auxiliary `opengrep silent` coverage警告保留，不宣稱完整security scanner覆蓋。
- Core `git status --short` 空白。root repository維持既有大量untracked狀態，未commit／push；未修改其他專案／服務／runtime。

## 可重跑命令與證據

```bash
.venv/bin/python tests/test_dataflow_discovery_snapshot.py -v
python3 tests/test_dataflow_discovery_snapshot.py -v
```

原始log在gitignored `.local/evidence/dataflow-discovery/`：

- `snapshot-first.log`：初次15 tests中2個secret-content子案例失敗（YAML未加引號密碼、ODBC PWD字串被接受）。修正capture層的已知敏感值判斷，不改預期或以redact隱藏失敗。
- `snapshot-final.log`：Python3.11最終15／15。
- `snapshot-python314.log`：Python3.14最終15／15。
- `snapshot-source-state.json`：最終source／README／tests與log hashes。

最終主要source：snapshot.py SHA256 `32039e6071a9232a366c98eb14506e575e665a1b2751bee925b2789b8ff23624`；test SHA256 `febba3cdfb003e99255aee8f001dc185533533745c9781aa4d254a7f0594c003`。

## 實際驗證範圍

1. Files排序穩定，manifest独立重算SHA256相同；改內容／路徑／source_id會改digest；text保留Unicode／CRLF，manifest不含text／host absolute path／捏造commit。
2. 只讀explicit files；輸入程式含有建立marker指令但未執行，marker不存在；原file mode／內容／mtime保持。
3. `..`／absolute／空segment／backslash／控制字元等非法path、重複paths、隱藏／secret檔名、tests／fixtures／golden／vendor、未知filetype均拒絕。
4. Known secret literals／未加引號YAML／ODBC／URL credentials／private-key marker拒絕且錯誤不回顯內容；empty／null／明確環境引用的正向可讀。
5. File count／file size／total bytes邊界；missing／非UTF8／NUL、hardlinks、FIFO、directory拒絕，FIFO不阻塞。
6. 最終file／中間directory／root symlinks拒絕。刻意在file open前將parent換成外部symlink，directory handle仍讀原核准file，不越界；後續新capture拒絕該symlink。
7. 單file讀取期間及其他file讀取期間修改已讀file，capture拒絕，不產生半份結果。

## 限制與剩餘交付

- Snapshot函式不是授權API；root／paths／limits由可信Host選擇。目前未暴露Agent工具，未處理模型任意host path。
- Screening只是已知模式檢查，不是完整DLP。operator核准／審閱source與模型privacy要求仍必要，不能因regex無命中宣稱檔案可任意送模型。
- Immutable僅指已捕獲的memory內容，沒有transactional跨file Git版本／snapshot artifact store保證。捕獲後原path可以改；發布前必須再驗current source／scope／candidate版本。
- 此版manifest明示`revision_kind=content`。可用commit／dirty、snapshot交付到現有HOME/session與Host授權仍待接線，不勾整個snapshot交付項。
- 尚無已註冊 `SKILL.md`、真Agent Skill載入、Python／SQL／Grafana候選分析、Host關係validator／publisher。這15tests只證明本機capture行為，不證明lineage／ETL／Grafana或真入口成功。
- MSSQL既有instance消失／port不可連仍待使用者確認恢復方向，見 [環境盤點](dataflow-discovery-environment.md)。未自行重建SQL Server、安裝driver、啟停服務、讀credential檔或寫metadata。

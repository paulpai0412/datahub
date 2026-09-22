# DataHub Agent foundation 驗證

範圍：`TODO-a2daa81d` 的 A01–A03，主代理 source-only 切片。不是功能移植完成或部署驗收。

## 本輪成果

1. `docs/research/datahub-agent-pi-web-plan-v2.md` 加入客製 ingestion、Sources UI、Skill/MCP/worker 分工、secret／approval／run 契約。
2. `docs/datahub-agent-todo.md` 建立 A01–A15 的工作、依賴與驗收條件。
3. `extensions/datahub-agent/pi-web/` 納入完整 upstream commit `b1a72962d385db4a82b93ad5802e9024d5b44874`，506 tracked files、6,003,980 bytes，保留原始 mode 與 MIT license。沒有執行下載 source 的 installer hooks、tests 或 runtime。
4. `integration/connector_catalog.py` 完成純離線 library：list、schema、fingerprint、設定 JSON Schema validation；使用既有 jsonschema／referencing，不 import 動態 connector、不新增依賴。

## 執行證據

```bash
.venv/bin/python tests/test_agent_foundation.py
```

結果：3 組 tests PASS，涵蓋：

- 506 檔案的 SHA-256、Git blob ID、mode；另查實際 file set 與 manifest 完全一致。
- 第一方 synthetic schema 的 required/type/minimum/additionalProperties/nested local refs。
- 未批准 connector ID、任意 import-like 字串、stale fingerprint、超大／非 JSON／非 object config 拒絕。
- 呼叫端修改原 entry／get-schema 回傳值不改變 catalog；schema 或 version 變動使 fingerprint 改變。
- validation error 不回顯 input 值／使用者 dictionary key；錯誤列表有界並標記截斷。
- 外部 schema reference、未知 schema dialect、錯誤 schema、unresolved local reference 失敗關閉。
- 已安裝官方 `acryl-datahub 1.7.0.9` 的 `SQLServerConfig.model_json_schema()` 合法／非法 config；不執行 model_validate／connector create／Pipeline。

主要 LSP：2 Python files、0 diagnostics。Scoped lens：2 檔無剩餘 blocking findings；不是全專案檢查。Git blob SHA-1 用於 Git 格式相容，不作安全 hash，另有 SHA-256；對應 `python-weak-hash` 誤報已標記 false-positive。

文件及新檔另檢查 whitespace；`git diff --check` PASS，但本 repo 多數檔案尚未 tracked，不能僅靠這項代表所有新檔通過。

本機私有 evidence：

- `.local/evidence/agent-foundation/tests.log`
- `.local/evidence/agent-foundation/source-state.json`：精確 source hashes／Git refs／未執行範圍。

官方 DataHub checkout `e99431ec510d7a2001f815c6bf70913c493af76e`，`git status --porcelain` 為空。未改 recipe、secret、Core、部署或其他服務；未 commit／push。

## 限制與下一步

- A02 只完成 source 匯入，不是 pi-web baseline runtime／功能 parity（A04）。
- A03 是 `json_schema_only`，沒有 SDK custom-validator／format assertion／connection／policy／approval 證據；不應對外暴露成完整的 `validate_source_config` 產品 endpoint。
- raw connector schema 與 config 的 UI／模型可見投影尚待 secret policy；不准拿這個 library 直接處理未授權前端 recipe。
- 無 MCP bridge/server、Skill 安装、source worker、資料庫持久化、DataHub寫入、SSO／browser／live E2E。
- UI v0 未建立，iframe/auth 能力待驗證；runtime 開放前須有 credential-free baseline、安全審查及隔離。
- 後續修改 pi-web 要保留原 baseline lock 與本次匯入 evidence，再记录 downstream diff；不能以更新 hash 把未審查變更當作原版。

## 回顧

官方 source registry 可把含 `.`／`:` 的字串當 Python import path；因此第一版不向 caller 暴露 registry.get，而只接受部署批准的 catalog ID。Schema 檢查可在不建立來源連線的情況共用；它不能替代 connector validators、權限或執行證據。

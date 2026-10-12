# Semantic 工具宣告修正 — 已部署及原對話讀回

2026-10-07。使用者明確授權只更新本案Agent runtime；不代送維護測試或metadata寫入。

**2026-10-08 更新：使用者重登後仍失敗。一次已授權真模型探測確認應用端 payload 包含 Semantic 工具，模型卻仍否認可用；尚未修復。** 最新 runtime 與證據見[模型工具診斷](datahub-semantic-model-tool-diagnostic-20261008.md)。下文是本次宣告修正當時的部署與驗證紀錄，不代表目前已恢復維護，也不建議反覆重新登入或重送。

## 已驗證結果

Windows Edge原對話經公開`get_state`／`get_tools`讀回：`datahub_catalog`與`datahub_semantic`均active，系統提示詞的Available tools也列出兩者。工具schema／完整description保持不變；模型、推理層級、權限及查詢設定沒有改動。

先前實際工具已啟用，但固定SDK會省略未提供`promptSnippet`的custom tool。本次只在第一方Semantic插件補工具宣告及使用界線；不改Pi SDK或DataHub Core。

- immutable592 app來源及精確image source核對通過；223瀏覽器產物與package-lock／runtime entry相等。
- 固定CPU1／3GiB／swap0，credential-free serial build；builder停止。
- 精確映像內10個SDK檢查通過（新prompt/reload/inactive2＋既有policy8），network none、沒有host HOME或session mounts。
- 兩HOME／41 journals部署前後及實際讀回後byte-exact。
- 原CONFIRMED v325、全142項及planDigest不變；114 VERIFIED／22 OBSERVATION_CHANGED／6 GAP不變。一次真人確認及114筆成功發布仍消耗，不可重送。
- MFE89.js／remoteEntry原bytes不改；config只更新runtimeImageId及browserAssetsDirectory。Core及其他服務不改。

當前runtime image：`sha256:23a5f60729ccf03cf17d1a89e3d3afd640abdb22bd21bf8543f6014ec72d80d6`。13:57:57 UTC啟動本案Agent；原runtime退休，未rollback。

## 使用方式與未驗證部分

在Windows Edge重新整理，沿原對話及Semantic governance提出新的明確語義維護需求即可，不需重新改權限或更換模型。維護仍經現有Host ACL／證據／CAS及真人整批確認流程。

**部署及runtime宣告一致已驗證，但沒有真模型提示，因此尚未驗證模型能完成這次SalesDatamart語義維護。** 本輪operator模型提示、SQL、Grafana、native維護／發布均零；不自動重送或建立新Root。完整語義品質及真實變更第二輪仍未完成。

私有證據：`.local/evidence/semantic-autonomous-plan-20261005-ScQzQE/semantic-tool-prompt-deploy-20261007-glryv4z4/` 的CHECKPOINT／validation-final／source及image proofs／deployed-entry／session保存證據。initial caller誤把app檔期待在operator manifest，已在建置前停止並校正；失敗保留，不重播成功helpers或效果。

[本地原因、真RED及修正](datahub-semantic-tool-prompt-local-20261007.md)。

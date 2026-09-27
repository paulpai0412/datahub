---
name: discovery-plugin-dev
description: 開發或修改 DataFlow Discovery 的 Asset、語言或框架語意插件。依固定 contract、來源證據與可重跑檢查交付候選；不適用於單純使用既有插件匯入 metadata，也不授予來源、執行或部署權限。
---

# Discovery Plugin Development

交付目標：在授權開發 workspace 實作一項明確能力，交付有版本、測試證據及限制的插件候選。Skill 是指引，不是驗收、sandbox或授權。

## 1. 確認開發範圍與工具可用性

- 使用者必須是在要求開發插件。單純分析 repo／metadata 使用既有 `datahub-etl`，不自行開始開發。
- 在 pi-web 選擇專用 **plugin-dev** 工具組；使用 `discovery_plugin_dev(action="contract")` 取得 Host 固定契約、digest、ABI 與可用工具鏈。`references` 列出 Host 提供的文件／真來源案例，`reference(referenceId=...)` 讀指定項目，不接受任意路徑或 URL。
- 若只有舊 `discovery_plugin_contract`，那是 reference-only 模式；不能假定有候選 workspace／runner。缺工具、契約不符或 Host 不可達就回報，不安裝 extension／改設定／改走普通 shell。
- 候選只存於既有 Pi HOME 的目前 native session 範圍。`save(files=...)` 只收 `plugin.py`、`manifest.json` 及選用 `tests.py`／`README.md`；每次取得新 candidateId/digest。`read(candidateId=...)` 只讀自己的版本。不能寫共用契約、收據、啟用清單或其他路徑。
- 區分「可編輯候選」與「可執行候選」。`candidateExecutionAvailable:false` 時可完成授權檔案工作，但未審查程式不可用普通bash／import／測試命令在Pi或Host執行。

完成條件：範圍、契約digest、可寫目錄、執行環境與必交能力明確；缺項列出具體blocker。

## 2. 判斷擴充種類並重用

- 新 Asset：透過 Host `reference` 讀 `asset-plugin`（文件原文：[asset-plugin](references/asset-plugin.md)）。
- 新語言或框架／轉換語意：同樣讀 `language-plugin`（[language-plugin](references/language-plugin.md)）。專用 profile 沒有一般 read/bash 工具，不能為讀參考資料切回完整工具組。
- 先查看現有registry與最接近的第一方插件，只讀範圍內必要原碼。Source／Target是同一Asset的edge角色，不各造一套connector。
- 契約可以表達就只改plugin、其manifest／測試／文件。若需要新的IR語意、來源suffix權限、DataHub model或工具鏈，列出無法表達的實例、影響及相容性方案，交由owner決定；不悄悄修改共用契約、validator、固定測試、Host政策或Core。

完成條件：每項要求對應到既有契約或具體gap，沒有以未知行為冒充已支援。

## 3. 先建立可判定的驗證

列出需求→檢查→預期結果，重用固定conformance suite並補插件自己的案例。預期值從獨立契約／實際來源取得，不由待測parser反算。至少覆盖身分隔離、證據、unsupported、空輸入、多輸入及新能力的負例。

本地開發案例只能證明對應行為，不能冒充真pi-web/model、真來源、DataHub或部署驗收。沒有新的正確性問題就不添加重複測試。

完成條件：所有必交能力均有可執行判定；驗證需求不隨第一次實作結果降低。

## 4. 實作插件

依純`analyze(snapshot, config) -> graph`介面實作，使用可信capture傳入的資料，不重新讀任意filesystem、不呼叫業務API、不execute／import被分析repo、不取得憑證。每個來源檔必須有coverage；無法解析、schema歧義與動態行為保留finding。

資產ID與版本分離，值／條件／呼叫／包含分開，request／response／message等端口保留。輸出只含允許的metadata與證據，不複製payload範例、秘密literal或原始程式內容到摘要。插件只產生候選，不批准或發布。

完成條件：程式、manifest、設定schema、限制、測試与使用說明齊備；沒有Core／政策／固定驗收基準變更。

## 5. 執行檢查與修正

- 用 `verify(candidateId, candidateDigest, referenceId)` 送交指定版本。Host 重新核對原碼，使用自己的輸入、契約、判定及固定映像，在無憑證、無網路的隔離程序執行；候選 stdout／自行撰寫 tests 不是可信 PASS。
- 錯誤修正用 `save` 建立新 revision，再驗新 digest；不覆寫舊版或改固定期待以配合結果。只有 Host 收據算對應範圍的檢查，仍不是啟用／發布授權。
- 主開發者已審閱的第一方framework本地檢查，可依repo固定 `scripts/check-discovery-plugin-contract.py` 操作；該命令不是未審查候選的sandbox，也不是正式驗收工具。
- 明確程式或LLM參數錯誤：修正原問題，再驗新版本並保留舊結果。runtime／transport／未知副作用：先停止該路徑、保存錯誤與process/source狀態，不重派、不改模式或自動安裝依賴。
- 改動後收據需綁最後source hash；不拿舊PASS覆蓋新版本，不刪測試或把不支援改成成功。

完成條件：必要檢查有可信實際結果；缺隔離環境或必要證據則候選未驗，不能說已完成。

## 6. 真來源接縫與交付

授權齊備才經正常Discovery入口分析真來源並驗DataHub適配／原生讀回，保持ACL、preservation、版本與既有資料。不可替使用者按批准，也不把插件啟用當metadata發布批准。

最後報告：插件版本、source／contract／suite digest、變更檔案、每項檢查與來源、未解限制、尚未驗證層級及下一個具體操作。聲明是草稿、本地合格、整合已驗或已啟用，不能混淆。是否需要獨立審查依本次 owner 政策；免除審查不代表審查通過，也不免除隔離與精確版本批准。Skill 不自行派子代理。關閉或重開session只對帳，不重播部署／發布。

完成條件：指定能力及所有必要證據成立；否則交付可繼續的候選與明確blocker，不更改完成定義。

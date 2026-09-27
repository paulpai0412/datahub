# Asset plugin reference

先用 `discovery_plugin_dev(action="contract")` 讀 Host 固定 Contract；本文是方法，不是另一份 schema。舊 `discovery_plugin_contract` 僅是 reference-only 工具，不是目前專用 authoring profile 的入口。

1. 確認資產自然身分：scope／instance／service／environment＋原始locator。API包含HTTP method與route；MQ不能只用topic名稱跨cluster合併。同一asset可以同時被讀／寫。
2. schema來自已授權metadata或捕捉的規格，記錄其版本。推論範例不是權威schema；未知欄位、open object、動態schema須列限制。
3. API request／response、UI props／state、MQ key／value／headers按實際契約分開。Port不是DataHub Dataset的同義詞。
4. 跨資產value edge需要序列化／mapping證據；規格裡有endpoint或topic不能證明某段程式使用它。
5. 優先重用官方DataHub connector；Table／Topic常可用Dataset，BI適用Chart／Dashboard。原生API模型與OpenAPI connector的API_ENDPOINT Dataset不同，需選定並實測；UI component不可假裝成Chart。
6. 新原生Model／Aspect須另外核對ACL、version、query、UI與readback，不能把customProperties內的JSON當原生lineage。

當前第一方 `plugins/openapi.py` 僅抽OpenAPI 3.0 JSON的operation與宣告JSON ports。它不呼叫API、不猜examples、不生成request→response value edges、不處理任意schema或宣稱route已部署。新插件不得照抄這些限制當成自己的完整支援宣告。

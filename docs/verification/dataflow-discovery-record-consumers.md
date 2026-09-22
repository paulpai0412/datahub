# Record collections → SQL parameter consumers（離線，2026-09-15）

## 結果與限制

`python_record_consumers.bind_python_record_consumers(...)` 已將returned record/container宣告、decoder invocation與SQL parameter consumer接成**有條件的宣告依賴**。
不是執行紀錄、核准lineage或已證明的當前值。

- 重現source/context/Catalog/write declarations與query-decoder report；producer identity使用完整caller path＋call位置＋decoder，不只用同一function/process/field名稱。
- shared graph保留helper return的完整invocation path；可展開單一return local list／record declaration，選取dataclass container的宣告field。
- 允許不與field衝突、非dunder、未shadow builtin property的唯讀property宣告，但不以property結果當field、不執行getter；custom initializer/post-init、collision等仍拒絕。
- 修正comprehension target不屬於外層function loop variable的scope；不把另一個generator的同名row當rebind。
- 跨guard的assignment仍unresolved，只保留initial declaration與chain findings；helper／validation／collection effects仍未驗，不由鏈接自動升格。
- lookup key與lookup values區分；來源ID作為dictionary key不等於surrogate-key結果值。條件依賴與decoder的prior declaration也各自保留。

## 檢查

新增7tests，相關12suites共 **118 PASS**：

- returned Bundle／guarded initializer→不同名稱的record field→SQL bind。
- 同一producer AST被兩個DB inputs呼叫，仍使用不同producer context與URN；不最後一筆覆蓋。
- lookup-key不是lookup-result value；missing record field不以query/target同名補線。
- property不是field；collision/custom initialization不提供普通record assembly。
- comprehension scope正確。
- shared branch DAG red反例證明小圖可被展開成指數多路徑；加入每次unfold 4096訪問預算（depth96），超限以owned `record_consumer_traversal_limit`拒絕，不回假完整結果。

## 真九檔case

`python-record-consumers-case-20260915.py`／JSON核fresh批准source、原probe／conditional policy與舊Catalog hash；沒有新live IO。

- 保留56 write slots，其中 **49有record declaration dependencies**；7個日期維度slots未硬接來源。
- 共77 references：consumer role value57／lookup_key12／condition8；decoder role value59／condition16／prior_declaration2。
- **8個surrogate-key slots只有查找鍵／條件依賴，lookup result仍unverified**，不可發布成來源ID→生成鍵的值lineage。
- Fact line_net_amount仍依qty/price/discount；source_line_total仍僅prior declaration。
- producer context、decoder/record field、query result label及physical origins均與先前query-decoder／SQL slot期望核對。
- expanded transport graph1167 nodes、335 unresolved；不同於先前631-node圖的133 unresolved，不是可比較的通過率或退步率。
- 全部links保留chain findings，所有runtime/publication flags為false；4個舊generator gaps及branch/override限制不因此解除。

證據：`.local/evidence/dataflow-discovery/`

- `python-record-consumers-first-20260915.log`：首6tests。
- `python-record-consumers-shared-branch-red-20260915.log`：DAG展開反例。
- `python-record-consumers-final118-20260915.log`：final source的118tests。
- `python-record-consumers-case-20260915.py`／`.json`：完整trace與role/golden核對。

checker初次將無slots的SELECT也視為有target的write，發生KeyError；修正checker只查有slots的statement，未改產品協定，沒有重播任何外部操作。

## 尚未完成

現在具備query→decoder→record collection→consumer→SQL slot的**部分宣告依賴鏈**，不表示完整值／成功路徑契約。
仍需處理lookup result、日期生成、helper數值／rounding／日期轉換、validation effects、mutable objects／成功guards，以及真正Host branch/override/freshness/ACL邊界。
來源record與query-origin存在不證明SQL實際成功，也不構成typed lineage/semantic核准。

Catalog仍為既有時間的readback，未fresh讀取；沒有captured-source execution、secret、network、SQL/ETL/ingestion、publication或deployment。
Core、analysis1.0.2與live bridge/Agent不變，Goal仍DM02／2 of12。
Scoped LSP的測試dict型別錯誤已修；9項auxiliary imports已由真.venv/PYTHONPATH/118tests/case反證並記false-positive。舊快取不重開，不宣稱全案clean。

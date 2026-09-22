# Python row decoder／dataclass 宣告（離線，2026-09-15）

## 本段結果

新增 `python_decoders.analyze_python_decoder(source, entrypoint=...)`，重用expression graph，
從指定函式的return expression追list／tuple／generator／append到dataclass construction。

- 只接受module-level、未重綁、官方dataclass decorator的plain required-field class；依宣告順序及keyword名稱核constructor欄位。
- 不以輸出與輸入同名猜來源；field value reference追到對應decoder symbolic iterable parameter的mapping read。
- direct value、condition與已失效的prior declaration分開；lookup／算式／helper calls不當成copy。
- 列出直接使用的local helper之return／raise／If或While condition，保留位置、graph refs、lexical guards；不把這些位置當完整成功路徑契約。
- 呼叫、參數／record身分與所有值均未執行；不驗losslessness、值域、generator consumption或任意Python side effects。
- 不支援custom initializer/post-init、inheritance、defaults、kw-only、ClassVar/InitVar/KW_ONLY與string annotations等constructor情境；不套用一般位置參數規則。
- 先經既有SourceFile integrity/import resolver，再建graph；不import捕獲的source。

## 反例與修正

新增10tests，相關10suites共 **103 PASS**：

1. positional／keyword constructor與不同名稱input mapping；保留真正來源參數。
2. conversion call operands、nullable condition與derived value分開。
3. local alias／append list；未知method effects僅保留prior declaration，不追認當前值。
4. missing／duplicate／starred／unknown constructor arguments拒絕組裝。
5. 非plain dataclass、parameter／exception shadowing拒絕普通constructor語意。
6. 不返回的record不列為decoder output；不執行module／錯誤literal不回顯。
7. SourceFile drift與unknown entrypoint拒絕。
8. 多層iteration不壓平成原輸入的一列；未知owner留空。

實測red修正：dependency traversal原漏了call `arguments` reference list，導致遺失運算元；
exception binding曾錯認為class，改在名稱解析層處理該binding；nested iteration曾錯指同一input row，現不授單層owner。
沒有新增fallback或以成功schema遮蔽這些錯誤。

## 真ETL source核對

仍是批准九檔snapshot `ed276f…`，沒有SQL、source execution或network。

| decoder | record | fields |
| --- | --- | ---: |
| `_parse_products` | ProductRow | 7 |
| `_parse_customers` | CustomerRow | 2 |
| `_parse_territories` | TerritoryRow | 4 |
| `_parse_facts` | FactRow | 13 |

**26 fields／304 nodes**與主會話逐欄另列的來源期望吻合，非獨立reviewer驗收：

- 27個value read references、5個condition references、1個prior-declaration reference；這不是27個physical columns或已發布edges。
- `line_net_amount`的宣告輸入是order_qty、unit_price、unit_price_discount及 `_line_net_amount`，不是同名query alias。
- `source_line_total`的 `_as_decimal` 結果後有method call；本層尚未證明其effect，只把原mapping read列為prior declaration。
- 五個helper：`_as_int`、`_as_text`、`_as_date`、`_as_decimal`、`_line_net_amount`，各有return／raise宣告。
- **decoder子圖仍28個unresolved nodes**。與上一段631-node SQL-parameter graph的133個unresolved不是同一分母，不能宣稱133降至28。
- 同一final source重新跑per-context Catalog／SQL parameter integration，原 **56 slots／mapping references仍吻合**。Catalog沿用原時間的既有紀錄，非fresh readback。

`python-decoders-case-20260915.py`／`.json`保存完整reports、golden、source hashes與56-slot regression。
`python-decoders-first-20260915.log`與`python-decoders-nested-row-red-20260915.log`保留red；
`python-decoders-final-source103-20260915.log`為最後原始碼的103tests。

## 限制／下一段

這些row inputs仍是**decoder函式參數**，尚未與 `_fetch`／Result.mappings／query context做可信跨函式連接；
`Extracted`集合、query實體欄位、下游bind-value與decoder outputs的整鏈仍未閉合。
helper exits只是宣告，Decimal精度／rounding／日期轉換／成功guards／mutation effects尚未驗成可發布契約。

下一步需在caller seam核query-result→decoder input、record collection→consumer field，保留branch／override與context身份；
之後才處理fresh Catalog／ACL、typed lineage/semantic approval與發布讀回，不用同名或唯一命中補線。

未接live bridge/analyzer/Agent、未變更analysis1.0.2或Core、未執行probe/ETL/ingestion/deployment；Goal仍DM02／2 of12。
Scoped LSP兩production modules無type errors，tests兩項auxiliary imports以實際.venv/PYTHONPATH測試反證；
internal generated graph ID轉int的靜態警示已記false-positive，未以catch或fallback遮蔽。歷史快取不等全專案clean。

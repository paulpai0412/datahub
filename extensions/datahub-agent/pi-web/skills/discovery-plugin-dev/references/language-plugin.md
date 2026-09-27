# Language / semantic plugin reference

先讀固定Contract。把語言syntax／symbol解析與框架I/O／轉換語意分開；支援一種語言不代表已支援它所有ORM、UI framework、client與巨集。

- Python先沿用既有AST與SQL／record／lookup分析，不重新建parser。`legacy_static`保留完整舊analysis；coarse IR不是已迁移的欄位publisher。
- TypeScript／Java／Rust依實際框架選既有parser／compiler公開API。Tree-sitter語法樹不等於符號解析、interprocedural value flow或跨服務lineage。
- 編譯器、build script、annotation processor、Rust proc macro可能執行被分析repo；不得為取得型別而在普通Host執行。先限定可靜態處理能力，或提出有界隔離工具鏈需求。
- 回傳值來源不等於所有實參；helper呼叫不等於Job；condition、join、filter、group/window依賴不混成value origin。
- 連線、HTTP route與topic需scope／deployment綁定，不能用同名或唯一搜尋結果猜測身分。跨語言邊界先證明共同API／訊息契約及欄位映射。
- 動態SQL、反射、動態路由、未知dispatch、生成碼缺失保留finding。解析失敗不以regex／LLM猜测降級成功。
- 新suffix不會自行獲得capture權限；需要可信Host核准的來源擷取政策。新增依賴、工具鏈或權限屬明示變更，不以skill授權。

驗證包含至少一個真實支援入口及其正確輸出分母、跨檔／呼叫／序列化邊界、未知行為負例與既有插件回歸。靜態聲明、已觀測execution、Catalog binding、人工核准各自標示，不互相替代。

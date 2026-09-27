# Discovery → 官方 API Aspect：離線映射與差異草稿

日期：2026-09-27；TODO-9b105e9b 仍 OPEN。

**已完成離線 Adapter、CLI、34 項隔離回歸，以及真模型既有結果的資料重播。針對草稿的唯一 URN 做正常認證唯讀 HEAD／GET，確認當次不存在；產生四個 `CONDITIONAL_NEW` aspect 差異。沒有發送 MCP／REST write，亦未部署新 Host 或執行模型／候選。**

## 實作與邊界

- `extensions/dataflow-discovery/src/dataflow_discovery/api_native.py`
  - `compile_api_draft(trusted_input, result, context)`：讀取既有可信 prepare／validate **資料**，沿原 `decode_input`／`validate_candidate_output` 重驗 snapshot、manifest/config/contract/result digest、graph evidence、coverage；不是重新 import 或執行插件。
  - `compare_api_draft(draft, observations=None)`：唯讀值比較，不是可套用的 patch，不是 approval 或 fresh-readback receipt。
- `scripts/draft-discovery-api.py`：operator-only 離線 CLI，接既有 `prepare.stdout`／`validate.stdout` 封套及明確 tenant/source/service context。不接 URL、token、source root，不執行候選，不作 HTTP／emit。
- `tests/test_discovery_api_native.py`：13 項 synthetic regression；沒有引用／執行模型的 plugin.py 或 tests.py。
- `tests/check_discovery_api_mapping.py`：以本案真來源／真模型既有結果重播 Adapter 和 CLI，驗官方 SDK round-trip／MCP serialization 與保存的 public OpenAPI property 對應。

不新增 registry/controller/datastore，不改 Contract v1 或 model-authored candidate，不影響既有 Discovery／legacy。新檔只在 feature worktree；**未複製至現行 private release／9141**。日後整合改版仍須按既有 framework/source freshness 契約處理，不能改寫原候選驗證收據。

### 不從名稱猜語意

Contract v1 沒有結構化 method/path。Adapter 以固定 snapshot 的 YAML syntax nodes，將 operation／scalar schema 的**唯一、精確檔案 SHA＋行號範圍**對應 asset／port，另核 owner、direction、field path/type/nullable。display name 和 localId 都不解析成 REST 語意。

所有來源 operations 與 IR subjects 必須一對一完整對帳；無唯一證據、漏 port、額外 subject、findings／不完整 coverage 或 edges 都拒絕。這不是通用完整 OpenAPI parser；本版只支援 OpenAPI 3.0、inline scalar string/integer/number/boolean、單一 JSON media type／單一明確 response status。多 media／response、reference、object/array/composition、path-level parameters、callbacks、YAML aliases/重複 keys/非標準 tags 等不降級為「取第一個」。

### 官方模型，不偽裝 Lineage

四個官方 aspects：

| Aspect | 此次預期內容 |
| --- | --- |
| apiProperties | name=`POST /datahub_usage_events/_search`；不捏造 owner、描述或 repository |
| subTypes | REST_ENDPOINT |
| restApiProperties | POST 與 `/datahub_usage_events/_search` 分開保存 |
| apiSignature | inputFields/outputFields 各一個 root string；schemaDefinition 保留原 YAML 全文 |

使用 `datahub.metadata.schema_classes` 公開 SDK，API URN 可由官方 `ApiUrn` 解析；MCP 只在記憶體中序列化、驗 schema，從未 emit。

重要語意：原 requestBody 沒有 required，依 OpenAPI 預設是可省略。DataHub `SchemaField.nullable` 定義為「optional OR nullable」，因此 input nullable=true、output=false；`portBindings` 分別保存 bodyOptional/schemaNullable/mediaType/responseStatus，原始 YAML 留在官方 schemaDefinition。不能把 input=true 解釋成來源 schema 宣告 nullable=true。integer/number 的原生型別字串亦保留，不只保留 SDK NumberType。

### 身分與差異

提議的 URN：`urn:li:api:discovery-v1-<SHA256(canonical tenantId/sourceId/serviceId/method/path)>`。

- scope、method、path 大小寫都參與；不同來源／租戶／service／方法不撞同一路徑。
- plugin version、文件描述及 content hash 不決定資產 identity；它們仍由來源與結果 digest 追蹤。
- context 必須由 operator／未來 Host 身分與政策取得，不信任模型聲稱。**hash namespace 不是 ACL 或已註冊 ownership，仍需治理契約。**
- 無 baseline → `CATALOG_UNOBSERVED`，不能因無 search hit 或 GET200 key-only 推論不存在。
- 外部提供 HEAD404 且無 stored aspects → `CONDITIONAL_NEW`，不是立即可新增。
- HEAD204＋未提供某 aspect → `ASPECT_UNOBSERVED`，不將可能沒讀到的內容判為刪除。
- 同值 → `UNCHANGED`；任何不同的既有 aspect → `CONFLICT`，保留完整 before/after；不默默替換 description、其他欄位或舊 signature。

所有 draft/diff 都有內容 digest，且 `publicationAuthorized=false`。比較函式不驗證呼叫者提供的 observation 來源，故即使外層確有真唯讀紀錄，函式本身仍維持 `liveReadbackVerified=false`。既有 metadata writer 不接受此新格式。

## 驗證

### Synthetic 與相容性回歸

固定 image `sha256:98b0694e67703054fdf99179f570a98f19fb4142081719d46316d29718fbe2fa`，network none／UID10001／readonly root＋單一 staging mount／cap-drop ALL／NNP／1CPU／512MiB／PID64，無 HOME／credentials／Docker socket 掛載。

`isolated-r2`：**34 tests PASS**（新13＋既有 candidate protocol5＋Contract16）。覆蓋：

- source 而非名稱的 method/path、同路徑多方法、租戶/來源/service/case identity、版本不改 identity。
- 四種 scalar、optional/nullable 分離、官方 SDK round-trip。
- drift／偽造 authorization flags、source/context mismatch、fields/direction/evidence 不符、漏 subjects、不完整、重複、aliases、tags、refs／無網路與程序執行。
- unknown／absent／present／unchanged／conflict、保留人工 metadata、GET key-only 不是 baseline、失效 digest／越界 observation。
- 實際 CLI 正負例與輸出大小界限。

### 真既有結果資料重播

`isolated-r3` 僅重跑已修正的真資料 harness，未重跑 r2 的成功34項。兩輪所測 product module／CLI／unit source hashes 相同；r3 exit0，SDK1.7.0.9 round-trip 和 MCP schema validation 通過。這不是新模型 prompt 或重新執行候選。

來源與原始結果：

- 真正常 Discovery execution `59f02de3-8764-4f34-8ce5-87ac333a3342` 的 prepare.stdout／validate.stdout。
- 原模型 `openapi-scalar-yaml 0.1.1`，resultDigest `5e930083a1cf536339246546a25705d505016fd91274f9b4eafd31150a9eaa10`。
- 固定官方 YAML 730 bytes，SHA `93cb72529313ffced744e21465206bc921b229ef726cbb3530454af0afc5e424`；再次比對現行乾淨 Core 的同一檔案。
- 上輪真 public OpenAPI SHA `8eae5a5eff3ace070010342839908267be2e5848e4a5b95be0f715ac1cfb041e`，離線核對 model properties。

**SDK JSON 的 qualified Avro union 與 REST v2 的 `__type` JSON 不是相同 wire format。** 本輪確認 SDK/MCP serialization 與 public property correspondence，不宣稱 REST write body／write-read roundtrip／原生 UI 已驗。

### 精確 URN 唯讀 before

正常已認證的專用 browser → localhost9002 官方 frontend proxy，me 確認原 DataHub actor。只查：

`urn:li:api:discovery-v1-19414336bbe296458b0dd413a3192af1f000ca9c922dc51cc0da135fcfb43979`

同 URN HEAD404；GET200 只有匹配該 URN 的合成 apiKey，沒有 stored aspects。未 broad search／翻頁或接其他來源。外層 report 綁 draft digest、URN、actor 與觀測時間；缺可靠回應本應維持未知，而不是改寫／新建資料。

最終 CLI 採這份已保存的 absent observation，四個 aspects 均 `CONDITIONAL_NEW`：

- draftDigest：`8be783a9f130f2f5f0d68b1e1565e945c41c170af183f91d74a80fc6e47db099`
- diffDigest：`d90c6bb7a9d95140c0f2a7052d43e0a7cb0e028d32522822757603d7c742eed8`
- 完整私有草稿：`.local/discovery-plugin-contract/parallel-test-r1/api-mapping-r1/proposed-diff.json`

HEAD404 是當次觀測，不是 lease/CAS、寫權限或未來仍不存在的保證。

### 保留的失敗與處置

1. 初始本地 data-only smoke：YAML MappingNode end mark 指向下一 key 的縮排，誤把其 column>0 當作包含下一行，造成 port evidence 不匹配。修正為既有 Contract v1 YAML 的 exclusive end-line 語意；不改來源、候選、IR 或批准收據。
2. `isolated-r1`：staging 根目錄受 umask 成0700，Python在載入測試前 Permission denied。容器exit2／PID0／移除與source hashes已對帳；修測試根目錄 chmod0755後，同一固定image/profile另跑r2，未切Host模式或重播live E2E。
3. r2 的34項已成功；真資料 harness 接著因預期 schema 直接有 properties 而 KeyError。實際 public schema 用 allOf，與上輪REST checker相同。只修 harness 的 property projection；保留r2非零 exit，不稱整輪成功。r3針對該harness PASS。

所有三個專有容器均 exit／PID0／無OOM／移除、raw stdout/stderr SHA及stage/current-source重新核對；Core、9141、9041、HOME、原候選與歷史收據不變。Primary LSP四個產品／test檔案 clean。既有RPC結構finding不在此次修改範圍，未為清綠而改。

## 重跑與下一步

```sh
# trusted first-party unit checks；專用image中已有全部依賴
python -I -B tests/test_discovery_api_native.py

# 只讀保存的JSON，不執行plugin、不發送metadata
python -I -B scripts/draft-discovery-api.py \
  --prepared-input <原可信prepare.stdout> \
  --validated-result <原可信validate.stdout> \
  --tenant-id <operator-tenant> --source-id <approved-source> --service-id <service> \
  --observations <可選的SDK-value-observations.json>
```

不得把 CLI 任意輸入的 PASS 字串、context 或 observations 視為 Host 認證。重用時須外部核對既有來源授權、原 Host provenance、source freshness 與 artifact hashes。

**下一步先確認官方 write／conditional-conflict／ACL 契約並完善可信 Host 接縫，再提交精確差異供批准。** 本輪不授權建立測試 metadata、發布、變更使用中部署或放寬安全條件。若官方並發保護不足，須先回報具體缺口，不能用先HEAD再UPSERT冒充原子 create-if-absent。原 legacy 的真模型＋fresh Catalog source scope仍另案未擴張。

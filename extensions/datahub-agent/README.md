# DataHub Agent extension — implementation in progress

Latest SQL/Grafana direction (2026-09-26): [metadata-driven queries](../../docs/design/datahub-agent-metadata-query.md). DataHub visibility is the query authorization; no second per-user SELECT grant list or per-query approval. Database privileges remain enforced by the actual connection. The local implementation now includes multi-table/composite joins, protected source adapters, Pi/MFE/Host wiring, per-user private native Grafana publication, and a light-theme interactive portal. See [local evidence](../../docs/verification/datahub-agent-metadata-query-local-20260926.md) and [deployment prerequisites](../../docs/design/datahub-agent-metadata-query-operations.md). This new path is **deployed, with two B/org2 native flows live-verified in r3** after explicit source/org2/Agent approval; broader SQL acceptance remains open. The first real B model query executed a three-table Join and published a Dashboard, but Infinity 3.11.2 failed before its data request because the URL target lacked `url_options.method`. The failed round stopped without SQL replay. After separate confirmation, the fix was reloaded; two real three-table Join questions now have distinct bar/stat Dashboards with exact native-table/Host value matches. In r2, two additional same-plan table requests were blocked by the test harness; that original failure remains preserved. In r3, both tool descriptions clarify the automatic companion table, and an explicitly approved image/assets switch was followed by the same two prompts without a success-count guard. Each naturally finished with one SQL and one Grafana call, no tool errors, and exact table plus native chart-frame/Host matches. Each non-table Dashboard includes the same returned rows/columns, subject to limit/truncation—not a drill-down into underlying transactions. An [isolated real MSSQL lifecycle check](../../docs/verification/datahub-agent-query-lifecycle-20260927.md) now verifies driver timeout, HTTP cancellation, database-session termination, slot/recovery behavior and no replay. The [result-boundary closeout](../../docs/verification/datahub-agent-query-result-boundaries-20260927.md) also passed eight isolated real SQL executions and native Infinity parsing for empty/null/exact numeric strings/truncation/oversize recovery. Visible truncation titles were deployed by an approved Host-only reload (PID2364312), without changing the Pi image/assets/config or historical Dashboards. Real-model Stop-button E2E, metadata revocation, relationship validation/audit and other-source acceptance remain open; this round does not expand into them. See [current native evidence](../../docs/verification/datahub-agent-metadata-query-native-20260926.md). The fixed B/org2 live flow passed and its temporary grants were revoked; see [live evidence](../../docs/verification/datahub-agent-grafana-b-live-20260926.md). Historical candidate/deployment statements below describe earlier stages.

Full design: [v2 + ingestion](../../docs/research/datahub-agent-pi-web-plan-v2.md).
Catalog query UI: [B 方案／Catalog Explorer](../../docs/design/datahub-agent-catalog-explorer.md) — capabilities, eight result cards and a right-side interactive Detail Sidecard porting the pinned DataHub native layout/styles and compact profile format. Query-only: no edit/create/delete/publish actions or raw JSON presentation. Local implementation continues on the existing Host/public-API path (`TODO-cdd3f40a`), not an all-MCP migration. Thirty-two real native-adapter reads pass, including native Browse V2 database/schema scope and a real multi-input field-mapping group with downstream readback. Governance associations are wired but no non-empty anchor was found in the bounded 91-dataset scope. Pinned native glyphs and field metadata/provenance are now implemented; the static icon archive/license and 10 real field projections were checked. Entity governance reads now follow the pinned type's public fields, with explicit returned coverage rather than unsupported empty sections. The compact schema presentation, request-scoped refresh and graph viewport restoration are wired. Fresh native data also exercises the product graph helpers; a later real Salesdatamart two-hop case now passes, while cycle cases and nonempty field-governance chips remain unverified. Native platform display names and user profile text are now projected from public properties; a newly authorized 32-read run verified a nonempty platform display name and user title, but not nonempty editable names/about-me or group descriptions. Read-only governance pills use the pinned native sizing without invented colors. Catalog displays only DataHub-managed `/assets/` images, never arbitrary metadata URLs. Live MSSQL logo HTTP/browser, native `/Columns?highlightedPath=…` and `/Lineage` links, and the fixed Host Browse V2 DataPlatformInstance permission boundary now have real evidence. After the Host/MFE fix, live model → Host search/entity/fieldLineage → native card/Sidecard works; 33 native reads pass, and a real 3-input/1-output mapping is visible in the Sidecard list and graph at 1440 and 390px. The currently active Agent-only local image `sha256:34b3978d916da3518fe5e1f20ac0567715d50e800ed4418109263f3c8aa6edff` was rebuilt against the **pinned previous dependency image** after two standard-Dockerfile `npm ci` attempts failed with `ECONNRESET` (a bounded `--maxsockets=4` diagnostic also failed). A subsequent authorized mirror (`registry.npmmirror.com`) probe verified one locked tarball SHA-512, but full private Dockerfile clean `npm ci` still timed out/reset across multiple registry/CDN URLs; 541 image source files and 223 browser assets match, but a clean reproducible build has **not** passed. Only the approved Actor's Catalog policy remains enabled; Core/GMS/DB were not changed. At 390px, users must explicitly collapse the official DataHub Navbar first (66→318px); the close target is then 44×44px and the real 3→1 graph is readable. This is **not** full B1/B2 acceptance: a No Role second test Actor was provisioned through native local UI; same-browser A→B yields old Host Catalog 401 and old Runtime 401 while B's new Runtime is 200, but the existing unfiltered All Users `VIEW_ENTITY_PAGE` policy makes both actors see the sampled datasets. The owner chose **not** to modify that global policy; asset-differential ACL and in-flight rejection, complete native visual parity, and formal downstream lock integration remain unverified. A separate same-Actor offline 96-second real browser-grant expiry correctly returned 401; this does not cover Actor switching. Real Chromium native 200% zoom is now verified for the saved session at a 1440px physical viewport (focus containment and Escape included); Files panel restoration and a no-command Terminal handoff passed. A single new real model submission with an existing removable Catalog reference performed one `datahub_catalog` call, rendered a new card and left the selected metadata unchanged. In the saved real session, a downstream-impact card rendered five native edges, an equivalent graph/list, a one-hop path, one-layer expansion and center/back navigation with three authorized Host reads; an AdventureWorks scan (47 native reads/80 candidate assets) had no qualifying two-hop path, but the user-suggested Salesdatamart supplied a real three-asset two-hop path in the Agent Sidecard (six Host reads, 16 graph/list edges, exact URNs, no new model); real cycles are still unverified. FileViewer contents, trusted review coordination and all combined keyboard scenarios remain unverified. An isolated upstream→HEAD+Catalog 541-file downstream patch/lock and a separate complete-current-worktree 541-file candidate passed reverse/source and original checker tests; the latter contains independent ETL/Semantic/process-details changes and is held for independent review by owner decision. The checked-out formal lock still rejects dirty work; neither candidate is the released artifact. See [checks and remaining gaps](../../docs/verification/datahub-agent-catalog-explorer-local.md).
Tracking: [TODO](../../docs/datahub-agent-todo.md), `TODO-a2daa81d`.

## Implemented

- `pi-web/`: complete upstream plus explicit DataHub UI downstream from commit
  `b1a72962d385db4a82b93ad5802e9024d5b44874`, MIT license retained.
- `pi-web-downstream.patch` / `pi-web-downstream.lock.json`: separately pinned
  skin and MCP-settings changes; reversing the patch restores all original 506 files.
- `pi-web-upstream.lock.json`: all 506 tracked files, original Git blob IDs,
  file modes and SHA-256 hashes. The import baseline remains unchanged; tests and
  the complete production runtime have now executed in isolated containers.
- `integration/connector_catalog.py`: shared offline catalog contract with
  `list_connectors`, `get_connector_schema`, `validate_source_config`.

The deployment supplies reviewed `{id, version, config_schema}` entries. The
library imports no connector code. IDs are looked up, never interpreted as
Python paths. Configuration changes must use the current schema fingerprint.
It returns `schema_valid` or `invalid`, explicitly `json_schema_only`; it does
not emit a recipe, resolve credentials, connect to sources or publish metadata.
Errors contain schema locations/keywords, not submitted values or exception text.
Remote schema references and unsupported dialects are rejected. Only draft
2020-12 (or an unlabelled schema interpreted as that draft) is supported.

This is NOT a public endpoint, MCP server, worker, approval implementation or
secret-safe UI form. Callers must not use `schema_valid` as authorization or
connection evidence. Format annotations and SDK custom validators are not
validated by this slice. Unknown/unresolvable schemas fail closed. Schema output
is suitable only for reviewed, non-sensitive schema definitions; future user/LLM
projections must omit secret fields and sensitive options before exposure.

## Grafana sidecard candidate (not deployed or source-verified)

[Design and verification boundaries](../../docs/design/datahub-agent-interactive-grafana-sales.md).
`datahub_sql` must first return a freshly authorized short-lived `resultRef`;
`datahub_grafana` accepts that reference only and returns a URL-free message-card
launcher. Clicking opens the right-side workspace via the DataHub MFE's same-site
sibling iframe. History does not automatically mount a frame or re-execute SQL.

Optional operator-only `grafanaDisplaysByActor` maps a 48-hex actor key to
`{dashboardUid, datasetUrn, title, viewerLogin, orgId, grafanaOrigin, expiresAt}`.
It must match that actor's Catalog scope and source-only SQL policy, including
`maxExecutions: 1` and an expiry at least as late as the display policy. The
policy does **not** grant source SELECT. The operator also supplies a mode-600
`grafanaServiceKeyPath` containing a random 32-byte base64url server key;
only the Grafana datasource's encrypted `secureJsonData` holds its other copy.
The URL contains the URL-free card's **same opaque displayRef**, not a bearer
query capability. Infinity must send the server key plus datasource-level
`${__user.login}` and `${__org.id}` headers. In Grafana OSS 13.1.2 the latter
expands from the plugin namespace (`org-2` for org2), **not** numeric `2`;
the Host adapter compares that exact namespace. The Host compares all three,
rechecks DataHub identity, native Dataset/Chart/Dashboard privileges, active
browser grant and original SQL result, then serves the previous in-memory
aggregate at `/agent/grafana-data?display=...`; this GET never executes SQL.
The logged-in Grafana Viewer still needs its own org ACL. Never put the server
key, SQL, credentials or numerical values into the URL, model receipt or Pi
session. A first disposable org2 live probe verified the encrypted key and B Viewer
login, but rejected the org header under the earlier numeric expectation;
the datasource was deleted and read back as 404. A separately approved **second** disposable org2 probe verified the corrected
`org-2` namespace and B-only native query (one synthetic frame), as well as
Viewer attempts to override login/org/key, wrong path/port, org1 and anonymous
denials. Its datasource was deleted and read back as 404. This proves the
plugin/header boundary for a synthetic endpoint only, not a live Host result,
real MSSQL values or sidecard acceptance.

**No live real-data Dashboard is currently provisioned.** The existing org2
`datahub-agent-sales-probe`/datasource still targets a stopped synthetic test
endpoint. B's OpenAI Codex OAuth is connected (8 models read back). One real B
`/mfe/agent` prompt with the explicitly selected `gpt-5.6-sol` and no enabled
tools returned the requested text; a separate read-only session inspection
confirmed provider/model, 22 output tokens and `stopReason=stop`. This proves
only model connectivity, not a Catalog/MCP/SQL/Grafana round trip. The
existing source-only grant is expired. The owner subsequently approved **only
bounded B/org2 preparation** of the backend-secret design: check plugin/Host
negative cases first. The owner subsequently requested **no independent review**;
there is no independent security verdict and tests must not be described as one.
Before generating a service key, provisioning/repointing Grafana, switching the
active Agent or running source SQL, obtain separate exact target/operation and
fresh source-query time-window approval. The old URL-bearer candidate remains blocked
because the browser could see its token. Neither candidate is a live Dashboard
or numerical E2E acceptance. Unit tests are not E2E evidence:

```bash
node --test tests/test_agent_grafana.mjs extensions/datahub-agent/mfe/grafana.test.mjs extensions/datahub-agent/pi-web/lib/datahub-grafana-extension.test.mjs
```

## Offline check

Uses the project's existing environment: acryl-datahub 1.7.0.9,
pydantic 2.13.5, jsonschema 4.26.0, referencing 0.37.0; no new dependencies.

```bash
.venv/bin/python scripts/check-agent-downstream.py
```

The checker validates downstream bytes/modes/file inventory and reverses its
patch in a temporary directory before invoking the unchanged foundation tests.
It rejects Python `-O`; original baseline hashes are never replaced.
Tests verify the reconstructed import baseline, generic custom-source schema behavior and a
real official MSSQL configuration schema. The MSSQL config class is imported
only to obtain JSON Schema; no source instance, pipeline or SDK custom validator
is run. All configuration data is synthetic.

The source-byte test is an import-stage gate, not a requirement to keep pi-web
unchanged forever. Before intentional UI changes, retain this baseline lock and
record/review the downstream diff; do not overwrite original hashes to hide it.

## Runtime / integration

- `runtime-manager.mjs`: single-controller local Docker provisioning, per-actor
  named HOME, network-none, read-only image/IPC, non-root and resource limits.
  Existing container state blocks restart for explicit recovery; normal shutdown
  stops owned containers but does not delete HOME volumes.
- `runtime-relay.mjs` / `reverse-http.mjs`: runtime-initiated Unix transport;
  the gateway never opens a runtime-owned socket pathname. HTTP/SSE/PTY and files
  retain their native pi-web endpoints.
- `egress-proxy.mjs`: default-deny HTTPS:443 CONNECT, public IPv4 only, checked DNS
  results pinned to the dialed IP. No source/GMS access or source credentials.
- `server.mjs`: official DataHub `me` identity adapter + grants + gateway + manager.
  Operator config only, loopback-only listener, clean proxy environment required.
- Public PWA files and optional exported HTML/client assets are **immutable build
  artifacts**, not anonymous proxy access to a user runtime. APIs/private files
  always require a valid browser grant. See the [verification report](../../docs/verification/datahub-agent-runtime-isolation.md).

The user removed RAM/swap/disk headroom admission thresholds; the old read-only
resource checker is historical, not a deployment gate. Resource limits remain:
dedicated docker-container builder, 3 GiB RAM/no extra swap, one CPU, serial
solver, isolated HOME and project lock. These limits were verified in the actual
cgroup during the MCP candidate build. The builder is stopped afterward, without
pruning caches. See the [build record](../../docs/verification/datahub-agent-mcp.md).
This successful bounded build does not establish the cause or cure of earlier
host stalls; do not fall back to unbounded builds or change host settings.

After an approved build/export, retain the exact-image artifact gate:

```bash
node scripts/check-agent-artifacts.mjs "$EXACT_IMAGE_ID" "$NEW_ASSETS_DIRECTORY"
```

MFE configuration changes do not require rebuilding images. Reuse the reviewed
image. The opt-in `deploy/compose.agent.yaml` and `deploy/mfe.config.yaml` are
active; the user manually logged in and confirmed the Pi workspace. No credential
file was read. See the [MFE activation record](../../docs/verification/datahub-agent-mfe-preparation.md).
`.local/agent-server.json` is live; do not overwrite it with the example. Its assets
path is relative to `.local/`. Updating the Agent image requires a controlled
Agent restart, not another DataHub frontend recreation.

The runtime build uses `next build --webpack` and one page worker. Google font
assets are fetched only at build time. The default Dockerfile target still runs
baseline tests; it does not silently build/start a server.

After matching artifacts to the exact image, an operator-owned configuration
may start the gateway with:

```bash
env -i PATH="$PATH" HOME="$PWD/.local/agent-control-home" \
  node extensions/datahub-agent/integration/server.mjs .local/agent-server.json
```

Configuration fields: `scope`, `runtimeImageId` (full local `sha256:` ID),
`gatewayOrigin` (e.g. `http://localhost:9041`), `datahubOrigin`, `tenant`,
`browserAssetsDirectory` (relative to the config file), and optional
`memoryMiB`, `cpus`, `maxRuntimes`, `egressOriginsByActor`. The latter maps an
operator-approved 48-hex actor key to HTTPS origins; it reuses destination/DNS
checks, defaults to deny for every unlisted actor, and is never browser-supplied.
The optional `discoverySourcesByActor` maps the same actor keys to exact approved
source snapshots (`sourceId`, absolute `root`, explicit `paths`, `snapshotSha256`,
`modelContextApproved:true`). It defaults to no sources and enables only read-only
Discovery candidate pages, never SQL or publication. The approved local deployment
has passed real Agent/model/Host read-only E2E, including full-page reload; this is
not ETL/BI publication acceptance. See [Discovery boundary and evidence](../../docs/verification/dataflow-discovery-agent-readonly.md).
The new Catalog path additionally requires optional `catalogReadByActor`, mapping
operator-approved actor keys to `{modelContextApproved:true, propertyNames:[]}`.
It defaults to disabled, uses the current DataHub browser actor rather than a service
Reader, and still checks native read privileges per request. Custom properties are
restricted to reviewed names. The scoped local Catalog policy is currently enabled for one operator-approved actor after authorized Agent-only deployment; the initial invalid-response failure has been traced to Browse V2 instance ancestors and repaired for this actor. Do not expand the policy or mistake a recovered local session for complete acceptance; see the failure, fix and remaining blockers in the [Catalog report](../../docs/verification/datahub-agent-catalog-explorer-local.md).
No model/source secrets belong in this file.
One gateway per scope; the current local implementation requires host UID 1000.
Runtime model/MCP egress configuration is not yet exposed in a settings UI.

Browser sessions now share a cookie across sibling leases in the same browser,
with Web Locks serializing first exchange. A parent-only stop proof permits
cleanup after DataHub logout; failed identity renewal revokes that browser
session, not other browser profiles. The proof cannot authorize API access or
renew without DataHub identity. See [lifecycle evidence](../../docs/verification/datahub-agent-browser-lifecycle.md).

## UI v0 — visual review only

From the repository root: `node scripts/preview-agent-ui.mjs 9141`, then open
`http://127.0.0.1:9141`. Ctrl+C closes the preview. This is a disconnected layout
candidate, not the Agent server: no live DataHub identity, runtime, saved settings,
source inventory, or enabled credential inputs. The reference Core sidebar is
not a second sidebar to ship inside the real MFE.

See [design and asset provenance](design/brand-spec.md) and
[four-viewport evidence](../../docs/verification/datahub-agent-ui-v0.md).
The user approved continuing from this layout. The first real pi-web skin now
has production-image evidence: [A07 report](../../docs/verification/datahub-agent-skin.md).
The loopback preview remains the disconnected v0, not that production runtime.

## Not yet product-ready

- Extended live lifecycle coverage (other browsers/bfcache/offline),
  OAuth/clipboard, installed PWA/push and the full upstream feature matrix.
- Full skin/parity acceptance and trusted parent Settings/Sources UI. The first
  real skin reuses native components and handlers; native Settings still lives
  in the runtime origin, not the trusted ingestion/approval control plane.
- Actual configured MCP remote-server/auth/OAuth acceptance;
  datasource MCP, ingestion skill, source secrets/ACLs/workers.
- Explicit scope/version approval, traceable execution outcomes, Registry, schedules and rollback. Reuse native DataHub records/execution first; a separate jobs/outbox framework is not a required implementation.

The MCP version is live after explicit approval, using unmodified
`pi-mcp-adapter@2.33.0` with native config/save/session reload. 979 tests, real
container/browser settings isolation and real SDK stdio discovery/call pass.
The user confirmed the MCP page and ChatGPT login from DataHub. Only the approved
current actor has auth.openai.com/chatgpt.com egress plus one fixed local MCP route;
other private destinations remain denied. T01–T02 now pass in the real DataHub
Agent browser: GPT-5.6 Sol calls the official DataHub MCP for schema/lineage,
results match GMS, and a full-page reload retains the response.
See [T02 verification, deployment and short-lived token expiry](../../docs/verification/datahub-agent-datahub-mcp.md)
and [white-page repair/T01](../../docs/verification/datahub-agent-open-and-model.md).
Do not use the developer's Pi HOME/configuration or DataHub write credentials in
any runtime. Retaining terminal functionality does not grant host access.

The user's 2026-09-12 decision supersedes the old implementation order: real model
response → DataHub MCP query → native Source/Secret/ingestion capability checks →
necessary gaps only → ingestion/lineage readback → Registry/Task/Decision/schedules
→ integration acceptance. See [T01–T07](../../docs/datahub-agent-todo.md).
Do not create another datastore. Custom data must use existing DataHub models or
official Model/Aspect extensions through public APIs, never Core SQL tables.
The unshipped PostgreSQL prototype and gateway wiring have been withdrawn; its
local fixture evidence is not product acceptance. Ingestion E2E and full platform
acceptance remain incomplete.

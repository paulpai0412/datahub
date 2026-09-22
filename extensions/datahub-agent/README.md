# DataHub Agent extension — implementation in progress

Full design: [v2 + ingestion](../../docs/research/datahub-agent-pi-web-plan-v2.md).
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

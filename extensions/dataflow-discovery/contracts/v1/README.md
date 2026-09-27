# Discovery Plugin Contract 1

Status: local candidate, not a deployed plugin-development service. Runtime ABI is Python 3.11 `analyze(snapshot, config) -> graph`. Analysis inputs may describe other languages. `snapshot` is the existing immutable `dataflow_discovery.snapshot.Snapshot`, captured by an authorized Host. Candidate plugins run only in a credential-free isolated process. A Python callable/Protocol is not a sandbox.

## Files and entrypoints

- `manifest.schema.json`: closed manifest; no shell commands, module paths, credentials or publication permissions.
- `graph.schema.json`: closed language-neutral graph.
- `src/dataflow_discovery/plugin_api.py`: public `Plugin`, `PluginRegistry`, `node_id`, `file_evidence`, `validate_manifest`, `validate_graph`.
- Host CLI: `python -m dataflow_discovery.cli plugins` and `plugin-analyze --plugin ID --root APPROVED_ROOT --source-id ID --path FILE`. CLI is an operator interface, not a grant to access arbitrary roots from an Agent.
- Registration is an explicit tuple of reviewed Plugin objects in `plugins/registry.py`. No directory scan, entry-point import from user input, dynamic installation or automatic activation.

## Input

`Snapshot.source_id` is a nonsecret source-scope identifier selected by Host. It is not actor authorization. `files` retain UTF-8 bytes through text, path, sha256 and byte size; snapshot sha256 binds the exact inventory. Config must match the plugin's closed, self-contained JSON Schema. Never include credentials, a graph client, live reader, arbitrary command or Host root in plugin config.

Current capture supports the existing `.py/.sql/.json/.yaml/.yml/.md` inputs. A new language needs an explicitly reviewed capture-policy change as well as an analyzer; adding a manifest suffix alone cannot expand access. Current built-ins introduce no new capture permissions.

## Graph

`nodes`, `edges`, `coverage`, `findings` are required. Only `legacyAnalysis` is an optional transitional extension for preserving the existing source-bound candidate result exactly. It must pass the existing validator and is not new-IR publication authority.

Nodes:
- `asset`: stable data boundary with `assetType`, e.g. table, topic, api. Source/target are edge roles, not two asset classes.
- `operation`: logical computation/call with `operationType`. Do not make every helper a DataJob. Optional expressionSha256 is evidence identity, not proof of execution.
- `port`: owner asset/operation, input/output/inout direction and declared fields. Use exact field paths; nested JSON paths should use JSON Pointer escaping. Do not flatten distinct request/response ports.

Every node has `localId`, name, source evidence and `id = node_id(snapshot.source_id, kind, localId)`. localId must include its semantic namespace (e.g. `api:service-id:GET:/orders/{id}`), not a line number or content hash. Scope changes change ID; content changes alter evidence, not stable identity. This is a candidate identity, NOT a DataHub URN nor a verified Catalog binding.

Edges have typed kind, nonempty `sources` and one `target`, with evidence. Endpoint references name a node and optionally one of its port fields. `value_dependency` and `condition_dependency` use ports and may have multiple sources; never turn control/selecting fields into value origins. `reads`, `writes`, `calls`, `contains`, `depends_on` are single-source structural relations, never field edges. Calls do not prove data flow. Generated/constants without a source must not invent an upstream edge: retain a finding/declaration until a model-supported generation representation is approved.

Evidence references exact captured file hash and 1-based inclusive lines, optionally an RFC 6901 JSON Pointer resolvable inside that file. Duplicate JSON keys/nonfinite numbers and noncanonical array indexes cannot support pointer evidence. Never emit raw source bodies, passwords, example payloads or literals just to explain an edge. Hashes alone do not anonymize sensitive values; keep such values out of public output.

## Completeness and errors

Every snapshot file occurs exactly once in coverage (`analyzed` or `unsupported`, with reason). Every unsupported file has a finding. Analysis of a file is not a statement that every semantic feature was supported: all unsupported constructs still produce findings.

The Host computes coverageComplete only for a nonempty graph with all files analyzed and zero findings. This is scoped to the plugin's declared capability and config, never whole-program correctness, runtime evidence or publication. Result always says publicationAuthorized=false and runtimeVerified=false.

Host validates schema, references, source hashes, lines, pointers and coverage, and computes resultDigest over plugin manifest, contractDigest, source/snapshot, configDigest and complete graph. Plugin output is untrusted data. These checks do NOT prove the output is semantically true; fixed behavioral expectations, real-source review and independent review remain necessary. A successful JSON response or self-reported PASS is not an acceptance receipt.

Errors use bounded codes without raw exception/source text. Unknown/incompatible plugin IDs fail; no fallback. Over-limit output fails, rather than dropping findings. v1 result limit is 4 MiB for local verification, not permission to enlarge the existing 60KB Agent transport or expose full graphs to a model.

## Authoring and verification

Read the design in `docs/design/dataflow-discovery-plugin-development.md`. Implement only the requested plugin capability and its tests/docs. Keep shared contract, fixed conformance expectations, publisher and Host policy unchanged. A needed ABI/model change is a separate versioned proposal.

Reuse `plugins/legacy_static.py` for existing analyzer integration and `plugins/openapi.py` for a real pure-schema plugin. They are implementations, not golden expectations. Test new behavior independently; do not generate expected output by calling the implementation under test. Preserve failures and identify unsupported constructs. Candidate code must not execute on a credential-bearing Pi/Host merely because it is called a test.

For reviewed first-party development source only, run from the repository root:

```sh
PYTHONDONTWRITEBYTECODE=1 .venv/bin/python scripts/check-discovery-plugin-contract.py \
  --output .local/discovery-plugin-contract/conformance-NEW.json
```

The output must be a new path. It records actual command results, framework/input/test file hashes, contract and suite digests, installed dependency versions, and checks for source drift. This developer command is NOT a sandbox or a protected approval service; generated/unreviewed plugins must not be added to its in-process registry and executed on Host. A PASS covers the listed local tests only; it cannot activate a plugin. The isolated candidate runner and protected pi-web development workspace are not yet implemented.

The built-in suite checks C01-C07 local behavior and legacy equivalence. Real pi-web model adherence, production Host isolation/admission, new-asset DataHub model integration, ACL/readback and activation remain separate gates. No v1 API installs, deploys, publishes metadata or marks a plugin approved.

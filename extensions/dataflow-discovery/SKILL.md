# DataFlow Discovery Skill

- **Skill ID:** `dataflow-discovery`
- **Version:** `1.0.2`
- **Role:** produce neutral, source-bound data-flow candidates for trusted Host validation.

## Contract

The Skill accepts an already authorized Host snapshot, not a model-supplied path,
credential, endpoint, SQL command or repository program. `capture_snapshot()` pins
approved Linux directory handles, reads only the explicit UTF-8 allowlist, and keeps
source text in memory. `capture_and_analyze()` is the trusted Host adapter: it
captures, runs Git provenance only for the approved paths, and invokes the static
analyzers. No snapshot code is imported as a module, called, or executed.

```python
from dataflow_discovery.host import capture_and_analyze

receipt = capture_and_analyze(
    "/approved/source/root",
    ["pipeline.py", "model.sql", "dashboard.json"],
    source_id="approved-source-scope",
)
```

The caller must authorize the root, allowlist, actor, tenant/source scope and model
privacy before sending any source text to a model. The Skill itself is not an ACL,
DLP system, sandbox, transaction snapshot, or persistent state store.

## Supported first-version inputs

- **Python:** syntax tree, functions, calls, annotations, embedded literal SQL and
  simple dictionary/keyword field assignments. Dynamic dispatch/import is emitted
  as `unresolved`; a call graph is never silently called data lineage.
- **SQL:** token-aware SQLCMD `GO` batches and `sqlglot` T-SQL AST/scope analysis
  for physical table references and statement roles, including SELECT INTO. CTE
  aliases, comments and literals are not physical tables. Unsupported structures
  and templates emit `unresolved`, never regex-derived fallback edges. Simple
  SELECT aliases are query-local `inferred` mappings, not resolved Catalog columns.
  SQL is never executed.
- **JSON:** explicit BI identities (`uid`), dashboard/panel containment,
  datasource identities and `rawSql` dependencies. Panel transformations and macro
  expansion still require Host/runtime validation.
- **YAML/Markdown:** bounded identity/heading/fenced-SQL extraction. A heading is
  only a governance proposal, never an approved term.

Unknown encodings, unsupported syntax, dynamic names, missing evidence and runtime
semantics must remain unresolved. The analyzers do not contain business table names,
formulas, golden mappings or case-specific answer lists.

## Candidate output

`AnalysisResult.to_dict()` returns `dataflow-discovery.analysis/1` with:

- source and snapshot digest, analysis version and candidate digest;
- neutral `asset`, `process`, `type`, `relationship`, `field_mapping`,
  `governance_proposal` and `unresolved` candidates;
- status `resolved`, `inferred` or `unresolved`;
- relative evidence path, line range, file digest, source scope and method;
- limitations that prevent overclaiming semantics.

A candidate digest is an integrity identifier, not a semantic correctness score.
`validator.validate_analysis()` independently rechecks the snapshot digest, file
hashes, evidence ranges, candidate IDs, relationship direction and mapping shape.
`publication_preview()` excludes unresolved, inferred and governance candidates,
and rejects stale analysis versions. A non-FAIL
`INCONCLUSIVE` report still requires human/Host decisions; it is not a publish ack.

## Optional Host-configured Python field view (implemented, not deployed)

The existing Agent `analyze` intent may return `dataflow-discovery.agent-python-fields/2`
when the operator explicitly configures `pythonAnalysis` for that approved source.
`list_sources` advertises `analysisKind: python-field-declarations` for such sources.
The Agent cannot supply an entrypoint, connection scope, Catalog body or credentials.
The Host checks actor/metadata grants and reads native key/status/schema versions;
the same credential-free parser then composes the existing query/record/lookup analysis.

Pages contain field declarations, SQL contexts, decoder summaries and value nodes
with explicit gaps. `sections` and `decoderSections` give their offsets; use the
returned `candidateDigest` for pagination. Ref IDs are graph-local: field/consumer
refs use `graphId: transport`; query decoder refs use that context's `decoderGraphId`.
Resolve `(graphId, node.id)`, never `value:N` alone. Decoder summaries preserve
helper returns, raises and lexical conditions without claiming successful-path proof.
Here the digest binds the page-format version, full report, scopes and Catalog versions;
`baseCandidateDigest` identifies the separate basic analysis. Do not pass a field-page
digest as a publishable `AnalysisResult`. Source/context/schema drift requires new
Host validation, not model-authored replacement policy.

`INCONCLUSIVE`, unverified runtime/lookup/transform flags and `publicationAuthorized:false`
remain binding. This view does not turn lookup keys, conditions, generated values or
prior declarations into approved lineage. The deployed basic view is unchanged until
an explicitly approved Host deployment/configuration change. See
[Host integration evidence](../../docs/verification/dataflow-discovery-field-host-integration.md).

## Trusted Host command

From the repository root, with `PYTHONPATH=extensions/dataflow-discovery/src`:

```bash
python -m dataflow_discovery.cli analyze \
  --root /absolute/approved/root \
  --source-id approved-source-scope \
  --path pipeline.py --path model.sql --path dashboard.json
```

`validate` recaptures the same explicit paths before producing a publication preview.
The command is a Host-side utility and must not be exposed as an unrestricted Agent
tool. Candidate JSON is an artifact/preview, not a new datastore and not a DataHub
write. DataHub publication, governance approval and runtime execution are separate
Host responsibilities. The current `publisher.py` is an unaccepted draft. Plan v2
checks candidate-to-declared-URN translation and reproduces analysis from a fresh
Host-only allowlist capture at publication; caller-authored claims with valid hashes
are not sufficient. The Host-only `catalog.py` adapter now checks native MSSQL
DatasetKey/Status/SchemaMetadata against explicit per-statement connection scopes
and an exact URN allowlist. It does not infer those scopes, promote query aliases,
change candidate status, or authorize publication. Missing/ambiguous scopes remain
unresolved; `Database..Table` is rejected rather than losing the omitted qualifier.
Integration of these checks into the publisher, automatic source/field ownership,
trusted Task/Decision authorization, and complete aspect/column readback remain missing.
Its limited receipts must not be interpreted as a committed publication. See the repository's
`docs/verification/dataflow-discovery-astra-review.md` before further integration.

## Security and evidence limits

The snapshot rejects common secret file names, sensitive literals, URL credentials,
private-key markers, symlinks, hardlinks, special files, binary/non-UTF-8 content,
source changes observed during capture and size-limit violations. SQLCMD `${...}`
and `$(...)` variable references are placeholders, not secret values. Screening is
not complete DLP; operators must review approved inputs. Git `commit`/`dirty` is
reported only for the approved paths, and uncommitted content is never presented as
commit content. Publication must recapture/revalidate current source and bind the
actor, scope, approved revision, candidate digest and policy decision.

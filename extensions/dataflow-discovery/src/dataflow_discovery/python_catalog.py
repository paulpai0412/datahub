"""Offline SQL/Catalog seam. Host supplies scopes; never infer connection identity.

No model-facing endpoint, publication authority, source execution or persistence.
The same SQL process may have several independently scoped uses.
"""
from __future__ import annotations

import ast
from collections import Counter
from typing import Any

from .analyzer import analyze_snapshot
from .candidate import AnalysisResult
from .catalog import BoundDataset, CatalogBindingError, CatalogReader, MssqlScope, _digest, resolve_dataset
from .python_sql import analyze_sql_execution, python_sql_literals
from .snapshot import Snapshot
from .validator import validate_analysis


def _source_sql_contexts(analysis, snapshot, path, entrypoint):
    """Reproduce source evidence before either connection selection or Catalog IO."""
    validation = validate_analysis(analysis, snapshot)
    if validation.findings or analyze_snapshot(snapshot).digest != analysis.digest:
        raise CatalogBindingError("catalog_analysis_not_source_bound")
    if not isinstance(path, str) or not isinstance(entrypoint, str) or not entrypoint:
        raise CatalogBindingError("invalid_host_python_entrypoint")
    source = next((file for file in snapshot.files if file.path == path), None)
    if source is None or not path.endswith(".py"):
        raise CatalogBindingError("invalid_host_python_entrypoint")
    try:
        trace = analyze_sql_execution(source, entrypoint=entrypoint)
    except ValueError:
        raise CatalogBindingError("python_sql_trace_unavailable") from None
    trace_digest = _digest(trace)
    binding_identity = {"source_id": analysis.source_id, "snapshot_sha256": snapshot.sha256,
                        "candidate_digest": analysis.digest, "trace_sha256": trace_digest}
    contexts = [{"context_id": "sql-use:" + _digest({**binding_identity, "index": index, "use": use}),
                 "use": use} for index, use in enumerate(trace["uses"])]
    return source, trace, trace_digest, contexts


def bind_python_sql_dependencies(
    analysis: AnalysisResult, snapshot: Snapshot, *, path: str, entrypoint: str,
    scopes_by_context: dict[str, MssqlScope], reader: CatalogReader,
) -> dict[str, Any]:
    """Resolve reproduced SQL contexts only against explicitly Host-scoped Catalog.

    Scopes do not prove branch selection, execution or runtime engine identity.
    """
    source, trace, trace_digest, contexts = _source_sql_contexts(analysis, snapshot, path, entrypoint)
    identifiers = {context["context_id"] for context in contexts}
    if (not isinstance(scopes_by_context, dict) or not set(scopes_by_context).issubset(identifiers)
            or any(not isinstance(scope, MssqlScope) for scope in scopes_by_context.values())):
        raise CatalogBindingError("invalid_host_sql_context_scope")

    # Process labels remain line-based. Count complete declarations, not the
    # fragments of a proven f-string, but never conflate same-line declarations.
    strings = python_sql_literals(ast.parse(source.text))
    per_line = Counter(line for line, column in strings)
    statements = {item.subject: dict(item.attributes)["statement_kind"] for item in analysis.candidates
                  if item.kind == "process" and item.method == "sql_ast_statement"}
    dependencies: dict[str, list] = {}
    for item in analysis.candidates:
        if item.kind == "relationship" and item.method == "sql_ast_dependency":
            dependencies.setdefault(item.subject, []).append(item)
    unsupported_lines = {evidence.start_line for item in analysis.candidates
                         if item.kind == "unresolved" and item.method == "sql_static_parser"
                         for evidence in item.evidence if evidence.path == path}
    cache: dict[tuple[MssqlScope, str], BoundDataset] = {}
    for context in contexts:
        use = context["use"]
        context["bindings"] = []
        context["processes"] = []
        try:
            if use["binding_status"] != "SYNTAX_BOUND":
                raise CatalogBindingError("sql_execution_binding_unresolved")
            sql = use["sql"]
            if per_line[sql["line"]] != 1:
                raise CatalogBindingError("ambiguous_python_sql_line")
            if sql["line"] in unsupported_lines:
                raise CatalogBindingError("sql_structure_unresolved")
            base = sql["process"]
            processes = sorted(process for process in statements
                               if process == base or process.startswith(base + ":statement-"))
            context["processes"] = processes
            context["statement_kinds"] = {process: statements[process] for process in processes}
            if not processes:
                raise CatalogBindingError("sql_process_unmatched")
            scope = scopes_by_context.get(context["context_id"])
            if scope is None:
                raise CatalogBindingError("connection_scope_unresolved")
            for process in processes:
                for item in dependencies.get(process, []):
                    entry = {"candidate_id": item.candidate_id, "process": process, "dataset_subject": item.object,
                             "relation_type": dict(item.attributes)["relation_type"]}
                    try:
                        if not item.object or not item.object.startswith("dataset:"):
                            raise CatalogBindingError("invalid_dataset_candidate")
                        identifier = item.object.removeprefix("dataset:")
                        key = (scope, identifier)
                        if key not in cache:
                            cache[key] = resolve_dataset(identifier, scope, reader)
                        entry.update(status="CATALOG_BOUND", dataset=cache[key].to_dict())
                    except CatalogBindingError as error:
                        entry.update(status="UNRESOLVED", reason=str(error))
                    context["bindings"].append(entry)
            if not context["bindings"]:
                context.update(status="NO_DATASET_DEPENDENCIES")
            else:
                context.update(status="CATALOG_BOUND" if all(binding["status"] == "CATALOG_BOUND" for binding in context["bindings"]) else "INCONCLUSIVE")
        except CatalogBindingError as error:
            context.update(status="UNRESOLVED", reason=str(error))
    complete = bool(contexts) and not trace["unresolved"] and all(context["status"] in {"CATALOG_BOUND", "NO_DATASET_DEPENDENCIES"} for context in contexts)
    return {"format": "dataflow-discovery.python-catalog-binding/1", "source_id": analysis.source_id,
            "snapshot_sha256": snapshot.sha256, "candidate_digest": analysis.digest, "trace_sha256": trace_digest,
            "path": path, "entrypoint": entrypoint, "contexts": contexts, "trace_findings": trace["unresolved"],
            "factory_calls": trace["factory_calls"], "status": "CATALOG_BOUND" if complete else "INCONCLUSIVE",
            "runtime_identity_verified": False, "publication_authorized": False,
            "limitations": ["Host independently supplies connection-scope provenance and ACL per context",
                            "Scopes do not prove branch selection, execution or arbitrary engine overrides",
                            "Line-only legacy labels with multiple literals are not joined",
                            "Trace gaps remain; Catalog binding is not field lineage or business semantics",
                            "Catalog reads are non-atomic and require fresh validation before publication"]}


def describe_python_connections(
    analysis: AnalysisResult, snapshot: Snapshot, *, path: str, entrypoint: str,
) -> dict[str, Any]:
    """Group the existing source-bound SQL trace by actual engine origin.

    This removes the need for users/operators to enumerate every SQL-use digest.
    It does NOT select a database from table names, infer credentials, or silently
    assign an unresolved invocation to a nearby connection. The Host binds the
    returned connection IDs to its approved Source choices before field analysis.
    """
    _, trace, _, contexts = _source_sql_contexts(analysis, snapshot, path, entrypoint)
    assignments = {item["id"]: item for item in trace["factory_calls"]["assignments"]}
    groups: dict[str, dict[str, Any]] = {}
    unresolved = []
    for context in contexts:
        use = context["use"]
        connection = use.get("connection")
        # An unbound invocation deliberately has connection=None. Preserve the
        # unresolved branch below instead of dereferencing a missing origin.
        origin = connection.get("engine_origin", {}) if connection is not None else {}
        assignment = assignments.get(origin.get("assignment_id"))
        if (use.get("binding_status") != "SYNTAX_BOUND"
                or origin.get("kind") != "factory_selection" or assignment is None):
            unresolved.append({"context_id": context["context_id"],
                               "reason": "connection_origin_unresolved"})
            continue
        identifier = "connection:" + _digest({"source_id": analysis.source_id,
            "snapshot_sha256": snapshot.sha256, "path": path,
            "entrypoint": entrypoint, "assignment": assignment})
        group = groups.setdefault(identifier, {
            "connection_id": identifier,
            "label": assignment["name"],
            "function": assignment["function"],
            "line": assignment["line"],
            "origin": assignment["value"],
            "context_ids": [],
        })
        group["context_ids"].append(context["context_id"])
    return {
        "format": "datahub-etl.python-connections/1",
        "source_id": analysis.source_id, "snapshot_sha256": snapshot.sha256,
        "path": path, "entrypoint": entrypoint,
        "connections": list(groups.values()), "unresolved": unresolved,
        "trace_findings": trace["unresolved"],
        "context_count": len(contexts),
        "runtime_identity_verified": False,
    }


def scopes_for_python_connections(
    analysis: AnalysisResult, snapshot: Snapshot, *, path: str, entrypoint: str,
    scopes_by_connection: dict[str, MssqlScope],
) -> dict[str, MssqlScope]:
    """Expand Host-authorized connection choices using a freshly reproduced trace.

    Never accept a caller's SQL-context list as the grouping authority. Snapshot
    changes, missing connection choices and unknown origins fail explicitly.
    """
    description = describe_python_connections(analysis, snapshot, path=path,
                                             entrypoint=entrypoint)
    identifiers = {item["connection_id"] for item in description["connections"]}
    if (not isinstance(scopes_by_connection, dict)
            or set(scopes_by_connection) != identifiers
            or any(not isinstance(scope, MssqlScope) for scope in scopes_by_connection.values())):
        raise CatalogBindingError("host_connection_selection_required")
    if description["unresolved"]:
        raise CatalogBindingError("connection_origin_unresolved")
    return {context_id: scopes_by_connection[group["connection_id"]]
            for group in description["connections"] for context_id in group["context_ids"]}

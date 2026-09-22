"""Static DataFlow Discovery analyzers for approved in-memory snapshots.

The analyzers never import or execute snapshot code. They use Python AST,
SQL structure/identifier parsing, JSON structure, and bounded YAML/Markdown
scans to emit neutral candidates. Unsupported or dynamic constructs become
explicit ``unresolved`` candidates instead of guessed lineage.
"""

from __future__ import annotations

import ast
from contextlib import redirect_stderr
from dataclasses import dataclass
import importlib
import io
import json
import re
from pathlib import PurePosixPath
from typing import Any, Iterable, Mapping, Sequence

_candidate = importlib.import_module("dataflow_discovery.candidate")
ANALYSIS_VERSION = _candidate.ANALYSIS_VERSION
AnalysisResult = _candidate.AnalysisResult
Candidate = _candidate.Candidate
Evidence = _candidate.Evidence
analysis_digest = _candidate.analysis_digest
make_evidence = _candidate.make_evidence

_SQL_WORD = re.compile(r"\b(?:SELECT|INSERT|UPDATE|DELETE|MERGE|CREATE\s+(?:VIEW|TABLE|SCHEMA|DATABASE)|EXEC(?:UTE)?|DECLARE|THROW|SET\s+(?:NOCOUNT|XACT_ABORT|LOCK_TIMEOUT))\b", re.I)
_SQL_MACRO = re.compile(r"\$__(?:timeFilter|timeFrom|timeTo)|\$\{[^}]+\}")
_DYNAMIC_CALLS = frozenset({"eval", "exec", "getattr", "__import__", "import_module"})


def _safe_line(value: Any, fallback: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


def _line_range(node: Any) -> tuple[int, int]:
    start = max(1, _safe_line(getattr(node, "lineno", 1), 1))
    end = max(start, _safe_line(getattr(node, "end_lineno", start), start))
    return start, end


def _value_name(node: ast.AST) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        prefix = _value_name(node.value)
        return node.attr if prefix is None else f"{prefix}.{node.attr}"
    if isinstance(node, ast.Subscript):
        base = _value_name(node.value)
        key = node.slice
        if isinstance(key, ast.Constant) and isinstance(key.value, (str, int)):
            return f"{base or 'value'}[{key.value!r}]"
    return None


def _literal_text(node: ast.AST) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return None


def _call_name(node: ast.Call) -> str:
    return _value_name(node.func) or "<dynamic>"


@dataclass
class _Builder:
    """Deduplicate equivalent claims while retaining independent evidence."""

    candidates: dict[tuple[Any, ...], Candidate]

    def __init__(self) -> None:
        self.candidates = {}

    def add(
        self,
        *,
        kind: str,
        subject: str,
        object: str | None = None,
        status: str = "resolved",
        method: str,
        attributes: Mapping[str, Any] | None = None,
        evidence: Sequence[Evidence] = (),
        limitations: Sequence[str] = (),
    ) -> Candidate:
        normalized_attributes = tuple(sorted((str(key), value) for key, value in (attributes or {}).items()))
        key = (
            kind,
            subject,
            object,
            status,
            method,
            json.dumps(dict(normalized_attributes), sort_keys=True, separators=(",", ":"), ensure_ascii=False),
            tuple(limitations),
        )
        old = self.candidates.get(key)
        if old is not None:
            all_evidence = tuple(dict.fromkeys((*old.evidence, *evidence)))
            if all_evidence != old.evidence:
                old = Candidate.create(
                    kind=kind,
                    subject=subject,
                    object=object,
                    status=status,
                    method=method,
                    attributes=dict(normalized_attributes),
                    evidence=all_evidence,
                    limitations=limitations,
                )
                self.candidates[key] = old
            return old
        candidate = Candidate.create(
            kind=kind,
            subject=subject,
            object=object,
            status=status,
            method=method,
            attributes=attributes,
            evidence=evidence,
            limitations=limitations,
        )
        self.candidates[key] = candidate
        return candidate

    def ordered(self) -> tuple[Candidate, ...]:
        return tuple(sorted(self.candidates.values(), key=lambda item: item.candidate_id))


def _file_evidence(source_file: Any, source_id: str, method: str, start: int = 1, end: int | None = None) -> Evidence:
    lines = source_file.text.count("\n") + 1
    return make_evidence(source_file, start, end or lines, method, scope_id=source_id)


def _node_evidence(source_file: Any, source_id: str, node: ast.AST, method: str) -> Evidence:
    start, end = _line_range(node)
    return make_evidence(source_file, start, end, method, scope_id=source_id)


def _add_file_asset(builder: _Builder, source_file: Any, source_id: str) -> None:
    suffix = PurePosixPath(source_file.path).suffix.lower().lstrip(".") or "unknown"
    builder.add(
        kind="asset",
        subject=f"file:{source_file.path}",
        method="snapshot_file_inventory",
        attributes={"asset_type": suffix, "path": source_file.path},
        evidence=(_file_evidence(source_file, source_id, "snapshot_file_inventory"),),
    )


def _sql_batches(sql: str) -> list[tuple[int, str]]:
    """Split only standalone SQLCMD GO tokens, never strings or comments."""
    try:
        sqlglot = importlib.import_module("sqlglot")
        tokens = sqlglot.tokenize(sql, read="tsql")
    except Exception:
        # The analysis entrypoint will report unavailable/invalid syntax.
        return [(1, sql)]
    separators = {token.start for token in tokens if token.text.upper() == "GO" and token.token_type.name == "COMMAND"}
    result: list[tuple[int, str]] = []
    start_line = 1
    offset = 0
    current: list[str] = []
    for line_number, line in enumerate(sql.splitlines(keepends=True), 1):
        go_offset = offset + len(line) - len(line.lstrip())
        if go_offset in separators and re.fullmatch(r"\s*GO(?:\s+--[^\r\n]*)?\s*", line, re.I):
            batch = "".join(current)
            if batch.strip():
                result.append((start_line, batch))
            current = []
            start_line = line_number + 1
        else:
            current.append(line)
        offset += len(line)
    batch = "".join(current)
    if batch.strip():
        result.append((start_line, batch))
    return result


def _sql_dependencies(statement: Any) -> tuple[str, list[tuple[str, str]]]:
    """Extract physical tables from parser scopes, not token-like raw text."""
    exp = importlib.import_module("sqlglot.expressions")
    scopes = importlib.import_module("sqlglot.optimizer.scope")
    control = importlib.import_module("dataflow_discovery.sql_dialect").control_statement_kind(statement)
    if control is not None:
        return control, []
    kind = statement.key.upper()
    target = None
    if isinstance(statement, (exp.Insert, exp.Update, exp.Delete, exp.Create)):
        target = statement.this
        if isinstance(target, exp.Schema):
            target = target.this
        if not isinstance(target, exp.Table):
            raise ValueError("unsupported_sql_target")
        if isinstance(statement, exp.Create):
            kind = "CREATE_" + str(statement.args.get("kind"))
            if kind not in {"CREATE_TABLE", "CREATE_VIEW"}:
                raise ValueError("unsupported_sql_statement")
        if isinstance(statement, (exp.Update, exp.Delete)) and (statement.args.get("from_") or statement.args.get("using") or target.args.get("joins")):
            raise ValueError("unsupported_sql_update_alias")
    elif not isinstance(statement, exp.Query):
        raise ValueError("unsupported_sql_statement")
    if isinstance(statement, exp.Select) and statement.args.get("into") is not None:
        target = statement.args["into"].this
        if not isinstance(target, exp.Table):
            raise ValueError("unsupported_sql_target")
        kind = "SELECT_INTO"
    # Functions/remote queries and temporary identifiers need a separate scope
    # resolver. Do not treat their arguments as table names.
    for table in statement.find_all(exp.Table):
        # SQLGlot Table.parts drops the missing schema in db..table. Flattening
        # that to db.table would falsely reinterpret the database as a schema.
        if table.args.get("catalog") and not table.args.get("db"):
            raise ValueError("unresolved_sql_default_schema")
        if not isinstance(table.this, exp.Identifier) or table.this.args.get("temporary") or table.args.get("catalog") and not isinstance(table.args["catalog"], exp.Identifier):
            raise ValueError("unresolved_sql_table")
    dependencies: set[tuple[str, str]] = set()
    if target is not None:
        dependencies.add((_sql_table_name(target), "writes"))
    for scope in scopes.traverse_scope(statement):
        for _node, source in scope.selected_sources.values():
            if isinstance(source, exp.Table):
                dependencies.add((_sql_table_name(source), "reads"))
    return kind, sorted(dependencies)


def _sql_table_name(table: Any) -> str:
    # Preserve case and quoted dots rather than conflating [a.b] with a.b.
    return ".".join(part.sql(dialect="tsql") if "." in part.name else part.name for part in table.parts)


def _sql_projection(statement: Any) -> list[tuple[str, str]]:
    exp = importlib.import_module("sqlglot.expressions")
    query = statement if isinstance(statement, exp.Select) else statement.args.get("expression")
    if not isinstance(query, exp.Select):
        return []
    # These are local query-output aliases, not resolved Catalog column edges.
    return [(item.this.sql(dialect="tsql"), item.alias) for item in query.expressions
            if isinstance(item, exp.Alias) and isinstance(item.this, exp.Column) and not item.this.is_star]


def _analyze_sql(
    builder: _Builder,
    *,
    sql: str,
    source_file: Any,
    source_id: str,
    start_line: int,
    statement_label: str,
    evidence_method: str,
    end_line: int | None = None,
) -> set[str]:
    """Parse first; unsupported SQL never falls back to regex dependencies."""
    evidence = (_file_evidence(source_file, source_id, evidence_method)
                if evidence_method == "json_embedded_sql" else
                make_evidence(source_file, start_line, end_line if end_line is not None else start_line + sql.count("\n"),
                              evidence_method, scope_id=source_id))
    issue = None
    parsed = []
    try:
        parser = importlib.import_module("dataflow_discovery.sql_dialect")
        if _SQL_MACRO.search(sql):
            issue = "template_requires_runtime_validation"
        else:
            with redirect_stderr(io.StringIO()):
                parsed = [node for node in parser.parse_sql(sql) if node is not None]
    except ImportError:
        issue = "sql_parser_unavailable"
    except Exception:
        issue = "sql_parse_error"
    if issue or not parsed:
        builder.add(kind="unresolved", subject=f"unresolved:sql:{source_file.path}:{statement_label}",
                    status="unresolved", method="sql_static_parser",
                    attributes={"issue": issue or "sql_parse_empty"}, evidence=(evidence,),
                    limitations=("No resolved dependency is emitted for unsupported SQL",))
        return set()
    datasets: set[str] = set()
    for index, statement in enumerate(parsed, 1):
        label = statement_label if len(parsed) == 1 else f"{statement_label}:statement-{index}"
        process_subject = f"process:sql:{source_file.path}:{label}"
        try:
            kind, dependencies = _sql_dependencies(statement)
        except Exception:
            builder.add(kind="unresolved", subject=f"unresolved:{process_subject}", status="unresolved",
                        method="sql_static_parser", attributes={"issue": "unsupported_sql_structure"},
                        evidence=(evidence,), limitations=("No resolved dependency is emitted for this SQL structure",))
            continue
        builder.add(kind="process", subject=process_subject, method="sql_ast_statement",
                    attributes={"statement_kind": kind, "statement_label": label}, evidence=(evidence,))
        for name, relation in dependencies:
            dataset = f"dataset:{name}"
            datasets.add(dataset)
            builder.add(kind="asset", subject=dataset, method="sql_ast_table_reference",
                        attributes={"identifier": name}, evidence=(evidence,))
            builder.add(kind="relationship", subject=process_subject, object=dataset,
                        method="sql_ast_dependency", attributes={"relation_type": relation, "statement_kind": kind},
                        evidence=(evidence,), limitations=("Static SQL dependency; not Catalog identity or business semantics",))
        for source_field, target_field in _sql_projection(statement):
            builder.add(kind="field_mapping", subject=f"field:{process_subject}:{target_field}",
                        object=f"field:{process_subject}:{source_field}", status="inferred", method="sql_select_alias",
                        attributes={"source_field": source_field, "target_field": target_field,
                                    "transformation": "select_expression", "statement": label}, evidence=(evidence,),
                        limitations=("Query-local alias requires schema and scope resolution before column publication",))
        if kind in {"INSERT", "UPDATE", "DELETE", "CREATE_VIEW", "SELECT_INTO"}:
            builder.add(kind="unresolved", subject=f"unresolved:sql-mapping:{source_file.path}:{label}",
                        status="unresolved", method="sql_mapping_scan", attributes={"statement_kind": kind},
                        evidence=(evidence,), limitations=("Target column lineage still requires schema-aware resolution",))
    return datasets


def _field_expression(node: ast.AST) -> tuple[str | None, str, tuple[str, ...]]:
    direct = _value_name(node)
    if direct is not None:
        return direct, "identity", ()
    if isinstance(node, ast.Call):
        call = _call_name(node)
        sources = tuple(name for arg in node.args for name in [_value_name(arg)] if name is not None)
        return None, call, sources
    return None, "unknown", ()


def _python_mapping(builder: _Builder, source_file: Any, source_id: str, target: str, value: ast.AST, node: ast.AST) -> None:
    source, transformation, sources = _field_expression(value)
    if source is None and not sources:
        return
    attributes: dict[str, Any] = {
        "source_field": source or ",".join(sources),
        "target_field": target,
        "transformation": transformation,
    }
    if sources:
        attributes["source_fields"] = list(sources)
    builder.add(
        kind="field_mapping",
        subject=f"field:{target}",
        object=None if source is None else f"field:{source}",
        status="resolved" if source is not None and transformation == "identity" else "inferred",
        method="python_static_mapping",
        attributes=attributes,
        evidence=(_node_evidence(source_file, source_id, node, "python_static_mapping"),),
        limitations=("Static assignment does not prove runtime row semantics",),
    )


def _analyze_python(builder: _Builder, source_file: Any, source_id: str) -> None:
    try:
        tree = ast.parse(source_file.text, filename=source_file.path)
    except SyntaxError as error:
        error_line = error.lineno if error.lineno is not None else 1
        builder.add(
            kind="unresolved",
            subject=f"unresolved:python-syntax:{source_file.path}",
            status="unresolved",
            method="python_ast_parser",
            attributes={"issue": "syntax_error", "line": max(1, error_line)},
            evidence=(_file_evidence(source_file, source_id, "python_ast_parser"),),
            limitations=("The file was not executable or imported; syntax must be fixed before analysis",),
        )
        return
    # The import resolver already proves module-level literal importlib calls
    # and invalidates shadowed/rebound aliases. Do not label those declarations
    # as unknown dynamic dispatch merely because the syntax is a Call.
    imports = importlib.import_module('dataflow_discovery.python_imports').resolve_python_imports(source_file)
    literal_imports = {}
    for statement in tree.body:
        if not isinstance(statement, (ast.Assign, ast.AnnAssign)):
            continue
        call = statement.value
        targets = statement.targets if isinstance(statement, ast.Assign) else [statement.target]
        if (not isinstance(call, ast.Call) or len(call.args) != 1 or call.keywords
                or not isinstance(call.args[0], ast.Constant) or not isinstance(call.args[0].value, str)):
            continue
        for target in targets:
            binding = imports.bindings.get(target.id) if isinstance(target, ast.Name) else None
            if binding and binding.qualified_name == call.args[0].value and call.lineno in binding.lines:
                literal_imports[id(call)] = binding
    module_subject = f"process:python:{source_file.path}"
    functions = [node for node in ast.walk(tree) if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))]
    builder.add(
        kind="process",
        subject=module_subject,
        method="python_ast_module",
        attributes={"process_type": "python_module", "function_count": len(functions)},
        evidence=(_file_evidence(source_file, source_id, "python_ast_module"),),
    )
    for node in functions:
        function_subject = f"process:python:{source_file.path}:{node.name}"
        calls = sorted({_call_name(call) for call in ast.walk(node) if isinstance(call, ast.Call)})
        builder.add(
            kind="process",
            subject=function_subject,
            method="python_ast_function",
            attributes={"process_type": "python_function", "name": node.name, "calls": calls},
            evidence=(_node_evidence(source_file, source_id, node, "python_ast_function"),),
        )
        for called in calls:
            if called in _DYNAMIC_CALLS or called.endswith(".import_module"):
                continue
            builder.add(
                kind="relationship",
                subject=function_subject,
                object=f"process:call:{called}",
                status="inferred",
                method="python_call_graph",
                attributes={"relation_type": "calls", "callee": called},
                evidence=(_node_evidence(source_file, source_id, node, "python_call_graph"),),
                limitations=("Call graph is not data lineage",),
            )
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            name = _call_name(node)
            if id(node) in literal_imports:
                binding = literal_imports[id(node)]
                builder.add(kind='process',
                    subject=f'process:python-import:{source_file.path}:{node.lineno}:{node.col_offset}',
                    method='python_literal_import_declaration',
                    attributes={'qualified_module': binding.qualified_name, 'binding_lines': list(binding.lines)},
                    evidence=(_node_evidence(source_file, source_id, node, 'python_literal_import_declaration'),),
                    limitations=('Syntactic module target only; runtime module identity/effects are not verified',))
            elif name in _DYNAMIC_CALLS or name.endswith(".import_module"):
                builder.add(
                    kind="unresolved",
                    subject=f"unresolved:dynamic:{source_file.path}:{_line_range(node)[0]}",
                    status="unresolved",
                    method="python_dynamic_construct_scan",
                    attributes={"construct": name},
                    evidence=(_node_evidence(source_file, source_id, node, "python_dynamic_construct_scan"),),
                    limitations=("Dynamic dispatch or import target cannot be safely inferred",),
                )
        if isinstance(node, ast.Dict):
            for key, value in zip(node.keys, node.values):
                key_name = _literal_text(key) if key is not None else None
                if key_name:
                    _python_mapping(builder, source_file, source_id, key_name, value, node)
        if isinstance(node, ast.Call):
            for keyword in node.keywords:
                if keyword.arg:
                    _python_mapping(builder, source_file, source_id, keyword.arg, keyword.value, keyword)
        if isinstance(node, ast.AnnAssign):
            target = _value_name(node.target)
            annotation = _value_name(node.annotation)
            if target and annotation:
                builder.add(
                    kind="type",
                    subject=f"type:{source_file.path}:{target}",
                    method="python_ast_annotation",
                    attributes={"field": target, "annotation": annotation},
                    evidence=(_node_evidence(source_file, source_id, node, "python_ast_annotation"),),
                )
    literals = importlib.import_module('dataflow_discovery.python_sql').python_sql_literals(tree)
    for node, text in literals.values():
        if _SQL_WORD.search(text):
            _analyze_sql(
                builder, sql=text, source_file=source_file, source_id=source_id,
                start_line=node.lineno, end_line=node.end_lineno,
                statement_label=f'python-string-{node.lineno}', evidence_method='python_embedded_sql',
            )


def _json_walk(value: Any, path: tuple[str, ...] = ()) -> Iterable[tuple[tuple[str, ...], Mapping[str, Any]]]:
    if isinstance(value, Mapping):
        yield path, value
        for key, child in value.items():
            yield from _json_walk(child, (*path, str(key)))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from _json_walk(child, (*path, str(index)))


def _analyze_json(builder: _Builder, source_file: Any, source_id: str) -> None:
    try:
        document = json.loads(source_file.text)
    except (TypeError, ValueError, json.JSONDecodeError):
        builder.add(
            kind="unresolved",
            subject=f"unresolved:json:{source_file.path}",
            status="unresolved",
            method="json_parser",
            attributes={"issue": "json_parse_error"},
            evidence=(_file_evidence(source_file, source_id, "json_parser"),),
            limitations=("The JSON document could not be structurally analyzed",),
        )
        return
    evidence = _file_evidence(source_file, source_id, "json_structure")
    dashboard_subject: str | None = None
    charts_by_path: dict[tuple[str, ...], str] = {}
    for path, item in _json_walk(document):
        uid = item.get("uid")
        if isinstance(uid, str) and uid:
            item_type = "dashboard" if isinstance(item.get("panels"), list) else "configured_asset"
            subject = f"bi:{item_type}:{uid}"
            builder.add(
                kind="asset",
                subject=subject,
                method="json_identity_scan",
                attributes={"asset_type": item_type, "uid": uid},
                evidence=(evidence,),
            )
            if item_type == "dashboard":
                dashboard_subject = subject
        panels = item.get("panels")
        if isinstance(panels, list) and isinstance(item.get("uid"), str):
            for index, panel in enumerate(panels):
                if not isinstance(panel, Mapping):
                    continue
                panel_id = panel.get("id")
                if isinstance(panel_id, (str, int)):
                    chart_subject = f"bi:chart:{item['uid']}:{panel_id}"
                    charts_by_path[(*path, "panels", str(index))] = chart_subject
                    builder.add(
                        kind="asset",
                        subject=chart_subject,
                        method="json_panel_scan",
                        attributes={"asset_type": "chart", "panel_id": panel_id, "title": panel.get("title")},
                        evidence=(evidence,),
                    )
                    builder.add(
                        kind="relationship",
                        subject=f"bi:dashboard:{item['uid']}",
                        object=chart_subject,
                        method="json_dashboard_contains",
                        attributes={"relation_type": "contains"},
                        evidence=(evidence,),
                    )
        datasource = item.get("datasource")
        if isinstance(datasource, Mapping) and isinstance(datasource.get("uid"), str):
            builder.add(
                kind="asset",
                subject=f"bi:datasource:{datasource['uid']}",
                method="json_datasource_identity",
                attributes={"asset_type": "datasource", "uid": datasource["uid"]},
                evidence=(evidence,),
            )
        raw_sql = item.get("rawSql")
        if isinstance(raw_sql, str) and _SQL_WORD.search(raw_sql):
            label = ".".join((*path, "rawSql")) or "rawSql"
            datasets = _analyze_sql(
                builder,
                sql=raw_sql,
                source_file=source_file,
                source_id=source_id,
                start_line=1,
                statement_label=label,
                evidence_method="json_embedded_sql",
            )
            # rawSql belongs to targets[]; the owning panel id is on its
            # ancestor, not on the target. Resolve by structural path.
            chart_subject = next((charts_by_path[path[:length]] for length in range(len(path), 0, -1)
                                  if path[:length] in charts_by_path), None)
            if chart_subject is not None:
                for dataset in datasets:
                    builder.add(
                        kind="relationship",
                        subject=chart_subject,
                        object=dataset,
                        method="json_chart_query_dependency",
                        attributes={"relation_type": "consumes"},
                        evidence=(evidence,),
                        limitations=("Panel runtime transformations and template expansion require validation",),
                    )
    if dashboard_subject is None and isinstance(document, Mapping) and isinstance(document.get("dashboard"), Mapping):
        builder.add(
            kind="unresolved",
            subject=f"unresolved:json-dashboard:{source_file.path}",
            status="unresolved",
            method="json_dashboard_shape",
            attributes={"issue": "dashboard_uid_not_at_root"},
            evidence=(evidence,),
            limitations=("Nested dashboard identity needs an explicit BI adapter",),
        )


def _analyze_yaml_or_markdown(builder: _Builder, source_file: Any, source_id: str) -> None:
    lines = source_file.text.splitlines()
    raw_sql: list[str] = []
    in_sql = False
    fence = None
    sql_start = 1
    for index, line in enumerate(lines, 1):
        stripped = line.strip()
        if fence is None and source_file.path.lower().endswith(".md") and stripped.startswith("#"):
            heading = stripped.lstrip("#").strip()
            if heading:
                builder.add(
                    kind="governance_proposal",
                    subject=f"governance:{source_file.path}:{index}",
                    method="markdown_heading_scan",
                    attributes={"heading": heading},
                    evidence=(make_evidence(source_file, index, index, "markdown_heading_scan", scope_id=source_id),),
                    limitations=("A heading is a proposal for review, not an approved business term",),
                )
        marker = re.match(r'^ {0,3}(`{3,}|~{3,})(.*)$', line)
        if marker and fence is None:
            run, info = marker.groups()
            if run[0] == '`' and '`' in info:
                continue
            fence = run
            language = info.strip().split(maxsplit=1)
            in_sql = bool(language) and language[0].lower() in {'sql', 'tsql', 't-sql', 'mssql'}
            sql_start = index + 1
            continue
        if (marker and fence is not None and marker.group(1)[0] == fence[0]
                and len(marker.group(1)) >= len(fence) and not marker.group(2).strip()):
            if in_sql and raw_sql:
                _analyze_sql(builder, sql='\n'.join(raw_sql), source_file=source_file,
                    source_id=source_id, start_line=sql_start, statement_label=f'fenced-{sql_start}',
                    evidence_method='markdown_fenced_sql')
            raw_sql = []
            in_sql = False
            fence = None
            continue
        if fence is not None:
            if in_sql:
                raw_sql.append(line)
            continue
        if source_file.path.lower().endswith((".yaml", ".yml")) and re.match(r"^\s*uid\s*:", line, re.I):
            value = line.split(":", 1)[1].strip().strip("'\"")
            if value:
                builder.add(
                    kind="asset",
                    subject=f"configured:{value}",
                    method="yaml_identity_scan",
                    attributes={"asset_type": "configured_asset", "uid": value},
                    evidence=(make_evidence(source_file, index, index, "yaml_identity_scan", scope_id=source_id),),
                )
    if in_sql and raw_sql:
        _analyze_sql(
            builder,
            sql="\n".join(raw_sql),
            source_file=source_file,
            source_id=source_id,
            start_line=sql_start,
            statement_label=f"fenced-{sql_start}",
            evidence_method="markdown_fenced_sql",
        )


def analyze_snapshot(snapshot: Any) -> AnalysisResult:
    """Analyze an already captured snapshot and return source-bound candidates."""
    builder = _Builder()
    for source_file in snapshot.files:
        _add_file_asset(builder, source_file, snapshot.source_id)
        suffix = PurePosixPath(source_file.path).suffix.lower()
        if suffix == ".py":
            _analyze_python(builder, source_file, snapshot.source_id)
        elif suffix == ".sql":
            for batch_number, (start_line, batch) in enumerate(_sql_batches(source_file.text), 1):
                _analyze_sql(
                    builder,
                    sql=batch,
                    source_file=source_file,
                    source_id=snapshot.source_id,
                    start_line=start_line,
                    statement_label=f"batch-{batch_number}",
                    evidence_method="sql_file_parser",
                )
        elif suffix == ".json":
            _analyze_json(builder, source_file, snapshot.source_id)
        elif suffix in {".yaml", ".yml", ".md"}:
            _analyze_yaml_or_markdown(builder, source_file, snapshot.source_id)
    candidates = builder.ordered()
    return AnalysisResult(
        source_id=snapshot.source_id,
        snapshot_sha256=snapshot.sha256,
        analysis_version=ANALYSIS_VERSION,
        candidates=candidates,
        digest=analysis_digest(snapshot.sha256, ANALYSIS_VERSION, candidates),
    )

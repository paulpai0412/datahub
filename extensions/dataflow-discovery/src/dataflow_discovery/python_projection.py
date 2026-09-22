"""Offline query-output value origins, not Python transformations or publication."""
from __future__ import annotations

import ast
import hashlib
from typing import Any

import sqlglot
from sqlglot import exp
from sqlglot.lineage import lineage
from sqlglot.schema import MappingSchema
from sqlglot.optimizer.scope import Scope, traverse_scope
from datahub.metadata.urns import DatasetUrn

from .catalog import BoundDataset, CatalogBindingError, MssqlScope, _dataset_urn
from .python_catalog import bind_python_sql_dependencies
from .python_sql import python_sql_literals
from .sql_dialect import parse_sql


def _physical_origins(root, scope, datasets):
    origins = {}
    for node in root.walk():
        if node.downstream:
            continue
        if isinstance(node.expression, exp.Table):
            table = node.expression.copy()
            table.set('alias', None)
            urn = _dataset_urn(table.sql(dialect='tsql'), scope)
            if urn not in datasets:
                raise CatalogBindingError('projection_owner_not_bound')
            column = sqlglot.parse_one(node.name, read='tsql')
            if not isinstance(column, exp.Column) or column.is_star:
                raise CatalogBindingError('projection_column_unresolved')
            dataset = datasets[urn]
            field = dataset.field(column.name)
            origins[(urn, field)] = {'dataset_urn': urn, 'field_path': field, 'schema_sha256': dataset.schema_sha256}
        elif isinstance(node.expression, exp.Placeholder) or next(node.expression.find_all(exp.Column), None) is not None:
            raise CatalogBindingError('projection_column_unresolved')
    return [origins[key] for key in sorted(origins)]


def _column_origins(column, unit, scope, datasets, *, value_role=False, seen=frozenset()):
    owner = unit.sources.get(column.table)
    if isinstance(owner, exp.Table):
        table = owner.copy()
        table.set('alias', None)
        urn = _dataset_urn(table.sql(dialect='tsql'), scope)
        if urn not in datasets:
            raise CatalogBindingError('query_condition_owner_not_bound')
        dataset = datasets[urn]
        return [{'dataset_urn': urn, 'field_path': dataset.field(column.name), 'schema_sha256': dataset.schema_sha256}]
    if isinstance(owner, Scope):
        if value_role:
            raise CatalogBindingError('projection_conditional_derived_unresolved')
        root = lineage(column.name, owner.expression, scope=owner, dialect='tsql', trim_selects=False)
        return _physical_origins(root, scope, datasets)
    if not column.table and column.name not in seen:
        selections = [item for item in unit.expression.selects if item.alias_or_name == column.name]
        if len(selections) == 1:
            origins = {}
            for item in selections[0].find_all(exp.Column):
                for origin in _column_origins(item, unit, scope, datasets, value_role=value_role, seen=seen | {column.name}):
                    origins[(origin['dataset_urn'], origin['field_path'])] = origin
            return list(origins.values())
    raise CatalogBindingError('query_condition_owner_unresolved')


def _projection_roles(expression):
    """Structural value/condition roles; not evaluation or branch selection."""
    columns = []
    pending = [(expression, 'value')]
    while pending:
        node, role = pending.pop()
        if isinstance(node, exp.Query):
            raise CatalogBindingError('projection_conditional_subquery_unresolved')
        if isinstance(node, exp.Column):
            columns.append((node, role))
            continue
        for key, value in node.args.items():
            child_role = role
            if ((isinstance(node, (exp.Case, exp.If)) and key == 'this')
                    or (isinstance(node, exp.Window) and key != 'this')):
                child_role = 'condition'
            for child in value if isinstance(value, list) else [value]:
                if isinstance(child, exp.Expr):
                    pending.append((child, child_role))
    return columns


def _query_conditions(query, scope, datasets):
    """Describe query selection columns separately from returned-value columns.

    Uses SQLGlot's already qualified scopes, including CTE/derived outputs.
    No SQL text/literals are exported and no predicate is a business Join approval.
    """
    conditions = []
    for unit in traverse_scope(query):
        clauses = [(kind, unit.expression.args.get(kind))
                   for kind in ('where', 'group', 'having', 'qualify', 'order', 'limit', 'offset', 'distinct')]
        for join in unit.expression.args.get('joins') or ():
            if join.args.get('using') or join.args.get('method') == 'NATURAL':
                raise CatalogBindingError('query_join_condition_unresolved')
            clauses.append(('join', join.args.get('on') or join))
        for kind, clause in clauses:
            if clause is None:
                continue
            origins = {}
            for column in clause.find_all(exp.Column):
                # Nested SELECTs are described by their own qualified scope.
                if column.find_ancestor(exp.Query) is not unit.expression:
                    continue
                for origin in _column_origins(column, unit, scope, datasets):
                    origins[(origin['dataset_urn'], origin['field_path'])] = origin
            conditions.append({'kind': kind,
                'expression_sha256': hashlib.sha256(clause.sql(dialect='tsql').encode()).hexdigest(),
                'origins': [origins[key] for key in sorted(origins)],
                'parameter_names': sorted({node.name for node in clause.find_all(exp.Placeholder)}),
                'predicate_semantics_verified': False})
    return conditions


def _projection_origins(query: exp.Query, scope: MssqlScope, datasets: dict[str, BoundDataset]) -> tuple[list[dict], list[dict]]:
    if not scope.lowercase_fields or not scope.lowercase_urns:
        raise CatalogBindingError("projection_case_policy_unsupported")
    schema = MappingSchema(dialect="tsql")
    for dataset in datasets.values():
        parts = DatasetUrn.from_string(dataset.urn).name.split(".")
        if len(parts) != 3 or len({field.lower() for field in dataset.field_paths}) != len(dataset.field_paths):
            raise CatalogBindingError("projection_schema_ambiguous")
        table = exp.Table(this=exp.to_identifier(parts[2], quoted=True),
                          db=exp.to_identifier(parts[1], quoted=True), catalog=exp.to_identifier(parts[0], quoted=True))
        schema.add_table(table, {field: "UNKNOWN" for field in dataset.field_paths})
    roots = lineage(None, query, schema=schema, dialect="tsql", catalog=scope.database,
                    db=scope.default_schema, validate_qualify_columns=True,
                    infer_schema=False, trim_selects=False)
    if not roots:
        raise CatalogBindingError("projection_outputs_missing")
    # lineage(None) returns a dict and can silently collapse duplicate outputs.
    # Inspect its fully qualified/expanded SELECT, including wildcard expansion.
    qualified = next(iter(roots.values())).source
    if not isinstance(qualified, exp.Query):
        raise CatalogBindingError("projection_query_unresolved")
    names = qualified.named_selects
    if not names or any(not name or name == "*" for name in names) or len(set(names)) != len(names):
        raise CatalogBindingError("projection_output_names_ambiguous")
    conditions = _query_conditions(qualified, scope, datasets)
    outputs = []
    for name in names:
        root = roots[name]
        # Conditional/window expression roles are explicit. Do not ask generic
        # lineage to conflate their tests/partition keys with returned values.
        output_conditions = {}
        if root.expression.find(exp.Case, exp.If, exp.Window) is not None:
            unit = next(item for item in traverse_scope(qualified) if item.expression is qualified)
            values = {}
            for column, role in _projection_roles(root.expression):
                target = output_conditions if role == 'condition' else values
                for origin in _column_origins(column, unit, scope, datasets, value_role=role == 'value'):
                    target[(origin['dataset_urn'], origin['field_path'])] = origin
            origins = [values[key] for key in sorted(values)]
        else:
            if any(node.expression.find(exp.Case, exp.If, exp.Window) is not None for node in root.walk()):
                raise CatalogBindingError('projection_conditional_derived_unresolved')
            origins = _physical_origins(root, scope, datasets)
        outputs.append({"output_name": name, "status": "PHYSICAL_VALUE_ORIGINS" if origins else "NO_PHYSICAL_COLUMN_ORIGIN",
                        "origins": origins, "condition_origins": [output_conditions[key] for key in sorted(output_conditions)],
                        "expression_sha256": hashlib.sha256(root.expression.sql().encode()).hexdigest(),
                        "transformation_semantics_verified": False})
    return outputs, conditions


def bind_python_sql_projections(analysis, snapshot, *, path: str, entrypoint: str,
                                scopes_by_context: dict[str, MssqlScope], reader) -> dict[str, Any]:
    """Reproduce the Catalog seam first; never accept a caller-made binding report.

    SQLGlot qualifies against only bound physical schemas, with inference disabled
    and strict column validation. Outputs are query-local names, not target fields.
    No expression text, literal values, bind values or credentials are exported.
    """
    result = bind_python_sql_dependencies(analysis, snapshot, path=path, entrypoint=entrypoint,
                                          scopes_by_context=scopes_by_context, reader=reader)
    source = next(file for file in snapshot.files if file.path == path)
    literals = python_sql_literals(ast.parse(source.text))
    for context in result["contexts"]:
        context["projections"] = []
        if context["status"] != "CATALOG_BOUND":
            context["projection_status"] = "CATALOG_CONTEXT_UNRESOLVED"
            continue
        try:
            sql = context["use"]["sql"]
            _, text = literals[(sql["line"], sql["column"])]
            if hashlib.sha256(text.encode()).hexdigest() != sql["text_sha256"]:
                raise CatalogBindingError("projection_literal_mismatch")
            datasets = {entry["dataset"]["urn"]: BoundDataset(**{**entry["dataset"], "field_paths": tuple(entry["dataset"]["field_paths"])})
                        for entry in context["bindings"]}
            statements = [item for item in parse_sql(text) if item is not None]
            for index, statement in enumerate(statements, 1):
                process = sql["process"] if len(statements) == 1 else f"{sql['process']}:statement-{index}"
                if process not in context["processes"]:
                    raise CatalogBindingError("projection_process_mismatch")
                if not isinstance(statement, exp.Query) or statement.find(exp.Into):
                    context["projections"].append({"process": process, "status": "NOT_QUERY_PROJECTION", "outputs": []})
                    continue
                outputs, conditions = _projection_origins(statement, scopes_by_context[context["context_id"]], datasets)
                context["projections"].append({"process": process, "status": "QUERY_VALUE_ORIGINS_DESCRIBED", "outputs": outputs,
                                               "conditions": conditions})
            context["projection_status"] = "DESCRIBED" if all(p["status"] == "QUERY_VALUE_ORIGINS_DESCRIBED" for p in context["projections"]) else "PARTIAL"
        except Exception as error:
            # SQLGlot errors may contain SQL/literals. Export only owned reason codes.
            context["projection_status"] = "UNRESOLVED"
            context["projection_reason"] = str(error) if isinstance(error, CatalogBindingError) else "sql_projection_unresolved"
            context["projections"] = []
    result["format"] = "dataflow-discovery.python-projections/1"
    result["catalog_status"] = result["status"]
    result["projection_status"] = "DESCRIBED" if result["contexts"] and all(c["projection_status"] == "DESCRIBED" for c in result["contexts"]) else "PARTIAL"
    if result["projection_status"] != "DESCRIBED":
        result["status"] = "INCONCLUSIVE"
    result["limitations"].extend(["Query-local output names are not physical write-target fields",
                                  "Value origins exclude complete predicate/rowset/grain semantics",
                                  "No Python transformation, losslessness, generated-key or semantic approval claim",
                                  "Case-sensitive Catalog policies and write-target projections are not supported"])
    return result

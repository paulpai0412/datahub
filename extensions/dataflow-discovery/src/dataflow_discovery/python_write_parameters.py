"""Offline SQL bind-slot to physical write-field syntax. Never executes writes."""
from __future__ import annotations

import ast
import hashlib
from typing import Any

import sqlglot
from sqlglot import exp
from sqlglot.errors import ParseError
from sqlglot.optimizer.scope import traverse_scope
from datahub.metadata.schema_classes import SchemaMetadataClass

from .analyzer import _sql_batches
from .catalog import BoundDataset, CatalogBindingError, MssqlScope, _dataset_urn, _digest
from .python_catalog import bind_python_sql_dependencies
from .python_sql import python_sql_literals
from .python_projection import _projection_origins
from .sql_dialect import parse_sql


def declared_identity_fields(snapshot, targets, scopes, reader):
    """Read captured CREATE TABLE declarations; never claim DDL was applied.

    Exact observed field sets and SQL types must agree. Duplicate definitions,
    unknown scopes, absent declarations and unsupported forms give no fact.
    Native identity/default state itself is not exposed by schemaMetadata.
    """
    declarations, schemas = {}, {}
    for source in snapshot.files:
        if not source.path.lower().endswith('.sql'):
            continue
        database = None
        for line, text in _sql_batches(source.text):
            try:
                statements = parse_sql(text)
            except ParseError:
                continue  # Not an alternative parser or a generation fact.
            for statement in statements:
                if statement is None:
                    continue
                if isinstance(statement, exp.Use):
                    database = statement.this.name if isinstance(statement.this, exp.Table) and len(statement.this.parts) == 1 else ''
                for creation in statement.find_all(exp.Create):
                    if creation.args.get('kind') != 'TABLE' or not isinstance(creation.this, exp.Schema):
                        continue
                    table = creation.this.this
                    if not isinstance(table, exp.Table):
                        continue
                    physical = table.copy()
                    if database is not None and not physical.catalog:
                        if not database:
                            continue
                        physical.set('catalog', exp.to_identifier(database))
                    matches = set()
                    for scope in scopes:
                        try:
                            urn = _dataset_urn(physical.sql(dialect='tsql'), scope)
                        except CatalogBindingError:
                            continue
                        if urn in targets:
                            matches.add(urn)
                    if len(matches) != 1:
                        continue
                    urn = next(iter(matches))
                    columns = [node for node in creation.this.expressions if isinstance(node, exp.ColumnDef)]
                    fields = {(column.name.lower() if targets[urn]['lowercase_fields'] else column.name): column
                              for column in columns}
                    declarations.setdefault(urn, []).append((source, line, fields, len(columns)))
    facts = {}
    for urn, definitions in declarations.items():
        if len(definitions) != 1:
            continue
        source, line, fields, column_count = definitions[0]
        target = targets[urn]
        if len(fields) != column_count or set(fields) != set(target['field_paths']):
            continue
        schema = reader.get_aspect(urn, SchemaMetadataClass)
        if not isinstance(schema, SchemaMetadataClass) or _digest(schema.to_obj()) != target['schema_sha256']:
            raise CatalogBindingError('generation_schema_changed')
        native_types = {}
        for field in schema.fields:
            try:
                definition = sqlglot.parse_one('_field ' + field.nativeDataType, read='tsql', into=exp.ColumnDef)
            except ParseError:
                break
            if not isinstance(definition, exp.ColumnDef) or not isinstance(definition.kind, exp.DataType):
                break
            native_types[field.fieldPath] = definition.kind.sql(dialect='tsql')
        if any(not isinstance(column.kind, exp.DataType)
               or native_types.get(name) != column.kind.sql(dialect='tsql') for name, column in fields.items()):
            continue
        schemas[urn] = target['schema_sha256']
        for name, column in fields.items():
            identities = [constraint.kind for constraint in column.constraints
                          if isinstance(constraint.kind, exp.GeneratedAsIdentityColumnConstraint)]
            if len(identities) != 1:
                continue
            identity = identities[0]
            numbers = [identity.args.get(key) for key in ('start', 'increment')]
            if not all(isinstance(value, exp.Literal) and not value.is_string for value in numbers):
                continue
            facts[(urn, name)] = {'method': 'sql_identity_declaration', 'declaration_only': True,
                'path': source.path, 'file_sha256': source.sha256,
                'line': line + column.this.meta.get('line', 1) - 1,
                'schema_sha256': schemas[urn], 'sql_type': column.kind.sql(dialect='tsql'),
                'start': identity.args['start'].sql(), 'increment': identity.args['increment'].sql(),
                'ddl_applied_verified': False, 'runtime_value_verified': False}
    return facts


def _parameters(expression: exp.Expr) -> list[str]:
    names = []
    if next(expression.find_all(exp.Parameter), None) is not None:
        raise CatalogBindingError("sql_variable_binding_unresolved")
    for parameter in expression.find_all(exp.Placeholder):
        if not isinstance(parameter.this, str) or not parameter.this:
            raise CatalogBindingError("unnamed_sql_bind_parameter")
        names.append(parameter.this)
    return sorted(set(names))


def _insert_query_targets(query, dataset, fields, scope, datasets):
    """Bind INSERT positions to a strictly qualified SELECT, not Python binds.

    A row count is generated from the selected rowset, never a fabricated
    upstream field. Query conditions stay separate from value dependencies.
    Parameterized SELECT values need value transport and remain unresolved.
    """
    outputs, conditions = _projection_origins(query, scope, datasets)
    if len(outputs) != len(fields):
        raise CatalogBindingError('insert_query_column_shape_mismatch')
    inputs = set()
    for unit in traverse_scope(query):
        for source in unit.sources.values():
            if isinstance(source, exp.Table):
                table = source.copy()
                table.set('alias', None)
                inputs.add(_dataset_urn(table.sql(dialect='tsql'), scope))
    if not inputs.issubset(datasets):
        raise CatalogBindingError('insert_query_input_not_bound')
    slots = []
    condition_origins = {(origin['dataset_urn'], origin['field_path']): origin
                         for condition in conditions for origin in condition['origins']}
    for position, (field, output) in enumerate(zip(fields, outputs)):
        expression = query.selects[position]
        value = expression.this if isinstance(expression, exp.Alias) else expression
        parameters = _parameters(expression)
        generated, constants = [], []
        if not output['origins']:
            if isinstance(value, exp.Count) and isinstance(value.this, exp.Star):
                generated.append({'method': 'sql_rowset_count_declaration', 'declaration_only': True,
                    'expression_sha256': output['expression_sha256'],
                    'input_datasets': sorted(inputs), 'runtime_value_verified': False})
            elif isinstance(value, (exp.Literal, exp.Null, exp.Boolean)):
                constants.append({'kind': type(value).__name__, 'expression_sha256': output['expression_sha256']})
        resolved = not parameters and bool(output['origins'] or generated or constants)
        local_conditions = dict(condition_origins)
        local_conditions.update({(origin['dataset_urn'], origin['field_path']): origin
                                 for origin in output['condition_origins']})
        slots.append({'row_index': 0, 'position': position, 'dataset_urn': dataset.urn,
            'field_path': field, 'schema_sha256': dataset.schema_sha256,
            'parameter_names': parameters, 'target_read_fields': [], 'value_kind': 'SQL_QUERY_VALUE',
            'expression_sha256': output['expression_sha256'], 'parameter_values_verified': False,
            'transformation_semantics_verified': False,
            'sql_value_dependencies': {'status': 'STATIC_VALUE_DEPENDENCIES' if resolved else 'INCONCLUSIVE',
                'origins': output['origins'], 'condition_origins': list(local_conditions.values()),
                'generated': generated, 'constants': constants,
                'transformations': [{'operation': 'sql_select_expression', 'expression_sha256': output['expression_sha256']}]}})
    return {'status': 'WRITE_PARAMETER_TARGETS_DESCRIBED', 'target_urn': dataset.urn, 'slots': slots,
        'unassigned_catalog_fields': [field for field in dataset.field_paths if field not in fields],
        'conditions': conditions, 'predicate_parameter_names': sorted({name for clause in conditions for name in clause['parameter_names']}),
        'predicate_semantics_verified': False}


def _write_targets(statement: exp.Expr, scope: MssqlScope, datasets: dict[str, BoundDataset]) -> dict:
    target = statement.this.this if isinstance(statement.this, exp.Schema) else statement.this
    if not isinstance(target, exp.Table):
        raise CatalogBindingError("write_target_unresolved")
    physical = target.copy()
    physical.set("alias", None)
    urn = _dataset_urn(physical.sql(dialect="tsql"), scope)
    if urn not in datasets:
        raise CatalogBindingError("write_target_not_bound")
    dataset = datasets[urn]
    if isinstance(statement, exp.Delete):
        if any(statement.args.get(key) for key in ('using', 'joins', 'with_', 'tables')):
            raise CatalogBindingError('delete_source_scope_unresolved')
        predicate = statement.args.get('where')
        if predicate is not None:
            raise CatalogBindingError('delete_predicate_scope_unresolved')
        return {'status': 'WRITE_PARAMETER_TARGETS_DESCRIBED', 'target_urn': urn, 'slots': [],
                'row_effect': 'DELETE_ALL_ROWS', 'unassigned_catalog_fields': [],
                'predicate_parameter_names': [], 'predicate_semantics_verified': False}
    rows = []
    # Insert.where is a parser flag, not an UPDATE/SELECT Where expression.
    predicate = statement.args.get("where") if isinstance(statement, exp.Update) else None
    if isinstance(statement, exp.Insert):
        if not isinstance(statement.this, exp.Schema) or not statement.this.expressions:
            raise CatalogBindingError("explicit_insert_columns_required")
        columns = statement.this.expressions
        if any(not isinstance(column, exp.Identifier) for column in columns):
            raise CatalogBindingError("insert_target_column_unresolved")
        fields = [dataset.field(column.name) for column in columns]
        if len(set(fields)) != len(fields):
            raise CatalogBindingError('write_column_shape_mismatch')
        values = statement.expression
        if isinstance(values, exp.Select):
            if any(values.args.get(key) for key in ("from_", "joins", "with_", "group", "having", "qualify")):
                # COUNT(*) is not a wildcard output. Bare SELECT stars and an
                # outer WITH need separate positional/scope support.
                if statement.args.get('with_') or any(item.is_star for item in values.selects):
                    raise CatalogBindingError('insert_query_shape_unresolved')
                if len(values.selects) != len(fields):
                    raise CatalogBindingError('insert_query_column_shape_mismatch')
                return _insert_query_targets(values, dataset, fields, scope, datasets)
            rows = [values.expressions]
            predicate = values.args.get("where")
        elif isinstance(values, exp.Values) and all(isinstance(row, exp.Tuple) for row in values.expressions):
            rows = [row.expressions for row in values.expressions]
        else:
            raise CatalogBindingError("insert_value_shape_unresolved")
    elif isinstance(statement, exp.Update):
        if statement.args.get("from_") or statement.args.get("with_"):
            raise CatalogBindingError("update_source_scope_unresolved")
        assignments = statement.expressions
        if not assignments or any(not isinstance(item, exp.EQ) or not isinstance(item.this, exp.Column)
                                  or item.this.table or item.this.db or item.this.catalog for item in assignments):
            raise CatalogBindingError("update_assignment_unresolved")
        fields = [dataset.field(item.this.name) for item in assignments]
        rows = [[item.expression for item in assignments]]
    else:
        raise CatalogBindingError("write_statement_not_supported")
    if len(set(fields)) != len(fields) or not rows or any(len(row) != len(fields) for row in rows):
        raise CatalogBindingError("write_column_shape_mismatch")
    slots = []
    for row_index, row in enumerate(rows):
        for position, (field, expression) in enumerate(zip(fields, row)):
            if next(expression.find_all(exp.Query), None) is not None:
                raise CatalogBindingError("write_value_subquery_unresolved")
            parameters = _parameters(expression)
            reads = set()
            for column in expression.find_all(exp.Column):
                if (not isinstance(statement, exp.Update) or column.is_star or column.db or column.catalog
                        or (column.table and scope.normalize(column.table) not in {scope.normalize(target.name), scope.normalize(target.alias_or_name)})):
                    raise CatalogBindingError("write_value_column_unresolved")
                reads.add(dataset.field(column.name))
            value = expression.this if isinstance(expression, exp.Alias) else expression
            kind = ("DIRECT_PARAMETER" if isinstance(value, exp.Placeholder) else
                    "DEFAULT_VALUE" if isinstance(value, exp.Var) and value.name.upper() == "DEFAULT" else
                    "EXPRESSION" if parameters or reads else "NO_BIND_PARAMETER")
            slots.append({"row_index": row_index, "position": position, "dataset_urn": urn,
                          "field_path": field, "schema_sha256": dataset.schema_sha256,
                          "parameter_names": parameters, "target_read_fields": sorted(reads), "value_kind": kind,
                          "expression_sha256": hashlib.sha256(expression.sql().encode()).hexdigest(),
                          "parameter_values_verified": False, "transformation_semantics_verified": False})
    return {"status": "WRITE_PARAMETER_TARGETS_DESCRIBED", "target_urn": urn, "slots": slots,
            "unassigned_catalog_fields": [field for field in dataset.field_paths if field not in fields],
            "predicate_parameter_names": _parameters(predicate) if predicate is not None else [],
            "predicate_semantics_verified": False}


def bind_python_sql_write_parameters(analysis, snapshot, *, path: str, entrypoint: str,
                                     scopes_by_context: dict[str, MssqlScope], reader) -> dict[str, Any]:
    """Reproduce source/Catalog binding before extracting INSERT/UPDATE slots.

    Predicate parameters stay separate from SET/VALUES/SELECT slots. Positional
    INSERT needs an explicit column list; omitted columns are not invented keys.
    This is not Python value propagation, authorized SQL execution or lineage.
    """
    result = bind_python_sql_dependencies(analysis, snapshot, path=path, entrypoint=entrypoint,
                                          scopes_by_context=scopes_by_context, reader=reader)
    source = next(file for file in snapshot.files if file.path == path)
    literals = python_sql_literals(ast.parse(source.text))
    for context in result["contexts"]:
        context["write_statements"] = []
        if context["status"] != "CATALOG_BOUND":
            context["write_status"] = "CATALOG_CONTEXT_UNRESOLVED"
            continue
        try:
            sql = context["use"]["sql"]
            _, text = literals[(sql["line"], sql["column"])]
            if hashlib.sha256(text.encode()).hexdigest() != sql["text_sha256"]:
                raise CatalogBindingError("write_literal_mismatch")
            parsed = [item for item in parse_sql(text) if item is not None]
            for index, statement in enumerate(parsed, 1):
                process = sql["process"] if len(parsed) == 1 else f"{sql['process']}:statement-{index}"
                if process not in context["processes"]:
                    raise CatalogBindingError("write_process_mismatch")
                if not isinstance(statement, (exp.Insert, exp.Update, exp.Delete)):
                    context["write_statements"].append({"process": process, "status": "NOT_SUPPORTED_WRITE_STATEMENT", "slots": []})
                    continue
                datasets = {item["dataset"]["urn"]: BoundDataset(**{**item["dataset"], "field_paths": tuple(item["dataset"]["field_paths"])})
                            for item in context["bindings"] if item["process"] == process}
                described = _write_targets(statement, scopes_by_context[context["context_id"]], datasets)
                context["write_statements"].append({"process": process, **described})
            context["write_status"] = "DESCRIBED" if all(item["status"] == "WRITE_PARAMETER_TARGETS_DESCRIBED" for item in context["write_statements"]) else "PARTIAL"
        except Exception as error:
            context["write_status"] = "UNRESOLVED"
            context["write_reason"] = str(error) if isinstance(error, CatalogBindingError) else "sql_write_parameters_unresolved"
            context["write_statements"] = []
    result["format"] = "dataflow-discovery.python-write-parameters/1"
    result["catalog_status"] = result["status"]
    result["write_status"] = "DESCRIBED" if result["contexts"] and all(c["write_status"] == "DESCRIBED" for c in result["contexts"]) else "PARTIAL"
    if result["write_status"] != "DESCRIBED":
        result["status"] = "INCONCLUSIVE"
    result["limitations"].extend(["Bind names are syntax, not Python values or upstream columns",
                                  "Omitted fields are unassigned here, not proven generated keys",
                                  "Predicates, affected rows, coercions, triggers/defaults and business semantics are not verified",
                                  "No SQL execution, write authorization or publication approval"])
    return result

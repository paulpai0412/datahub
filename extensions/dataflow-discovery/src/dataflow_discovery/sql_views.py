"""Catalog-bound view declarations captured alongside an ETL entrypoint.

Uses the existing SQLGlot compatibility/parser and schema-aware projection seam.
No DDL execution, live database introspection, query execution or guessed schema.
"""
from collections import defaultdict

from sqlglot import exp
from sqlglot.errors import ParseError
from sqlglot.optimizer.scope import traverse_scope

from .analyzer import _sql_batches
from .catalog import CatalogBindingError, _dataset_urn, _digest, resolve_dataset
from .python_projection import _projection_origins
from .sql_dialect import parse_sql


def bind_declared_views(snapshot, scopes, reader):
    definitions = defaultdict(list)
    unresolved = []
    for source in snapshot.files:
        if not source.path.lower().endswith('.sql'):
            continue
        database = None
        for line, text in _sql_batches(source.text):
            try:
                statements = parse_sql(text)
            except ParseError:
                continue  # Original source-parser finding remains; not a view fact.
            for statement in statements:
                if isinstance(statement, exp.Use):
                    database = statement.this.name if isinstance(statement.this, exp.Table) and len(statement.this.parts) == 1 else ''
                if not isinstance(statement, exp.Create) or statement.args.get('kind') != 'VIEW':
                    continue
                target = statement.this
                query = statement.expression
                if not isinstance(target, exp.Table) or not isinstance(query, exp.Query):
                    unresolved.append({'path': source.path, 'line': line, 'reason': 'view_shape_unsupported'})
                    continue
                physical = target.copy()
                if database is not None and not physical.catalog:
                    if not database:
                        unresolved.append({'path': source.path, 'line': line, 'reason': 'view_database_unresolved'})
                        continue
                    physical.set('catalog', exp.to_identifier(database))
                matches = []
                for scope in set(scopes):
                    try:
                        urn = _dataset_urn(physical.sql(dialect='tsql'), scope)
                    except CatalogBindingError:
                        continue
                    matches.append((urn, scope))
                if len(matches) != 1:
                    unresolved.append({'path': source.path, 'line': line, 'reason': 'view_scope_ambiguous_or_unapproved'})
                    continue
                urn, scope = matches[0]
                definitions[urn].append((source, line, physical, query, scope))
    views = []
    for urn, declarations in sorted(definitions.items()):
        if len(declarations) != 1:
            unresolved.append({'urn': urn, 'reason': 'view_definition_ambiguous'})
            continue
        source, line, physical, query, scope = declarations[0]
        try:
            target = resolve_dataset(physical.sql(dialect='tsql'), scope, reader)
            inputs = {}
            for unit in traverse_scope(query):
                for _, owner in unit.selected_sources.values():
                    if isinstance(owner, exp.Table):
                        table = owner.copy()
                        table.set('alias', None)
                        dataset = resolve_dataset(table.sql(dialect='tsql'), scope, reader)
                        inputs[dataset.urn] = dataset
            outputs, conditions = _projection_origins(query, scope, inputs)
            by_field = {target.field(output['output_name']): output for output in outputs}
            if set(by_field) != set(target.field_paths) or len(by_field) != len(outputs):
                raise CatalogBindingError('view_output_schema_mismatch')
            views.append({'urn': urn, 'target': target.to_dict(),
                'inputs': [dataset.to_dict() for dataset in inputs.values()],
                'outputs': [{'field': name, **output} for name, output in by_field.items()],
                'conditions': conditions,
                'evidence': {'path': source.path, 'line': line, 'fileSha256': source.sha256,
                             'querySha256': _digest(query.sql(dialect='tsql'))},
                'ddlAppliedVerified': False, 'runtimeValuesVerified': False})
        except (CatalogBindingError, ParseError) as error:
            unresolved.append({'urn': urn, 'path': source.path, 'line': line,
                               'reason': str(error) if isinstance(error, CatalogBindingError) else 'view_projection_unresolved'})
    return {'format': 'datahub-etl.declared-views/1', 'views': views, 'blockers': unresolved,
            'sourceParserFindingsSuperseded': False, 'publicationAuthorized': False}

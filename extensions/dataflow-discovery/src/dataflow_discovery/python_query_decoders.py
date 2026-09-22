"""Declared SQLAlchemy mapping-result -> decoder input seam, offline only."""
from __future__ import annotations

import ast
import hashlib

from sqlglot import exp
from sqlglot.optimizer.normalize_identifiers import normalize_identifiers

from .catalog import CatalogBindingError
from .python_bind_values import _Graph
from .python_calls import _arguments
from .python_imports import _assigned_names
from .python_decoders import analyze_python_decoder
from .python_projection import bind_python_sql_projections
from .python_sql import python_sql_literals
from .sql_dialect import parse_sql


def _at(graph, function, line, column):
    return next(node for node in graph.local_nodes(function) if isinstance(node, ast.Call)
                and (node.lineno, node.col_offset) == (line, column))


def _function_name(graph, expression, caller, frame):
    parameters = {arg.arg: graph.add(arg, 'decoder_input', name=arg.arg, frame=frame)
                  for arg in [*caller.args.posonlyargs, *caller.args.args, *caller.args.kwonlyargs]}
    reference = graph.resolve(expression, caller, parameters, {}, frame)
    node = next(node for node in graph.nodes if node['id'] == reference)
    return node['name'] if node['kind'] == 'function_syntax' else None


def _bounded_result(graph, block, result_name):
    """Recognize only materialize/reject-overflow/return with Result.close.

    No handlers, data mutation, replacement return or arbitrary finally effects.
    This describes a public Result protocol, not proof of runtime bounds.
    """
    if (not isinstance(block, ast.Try) or block.handlers or block.orelse
            or len(block.body) != 3 or len(block.finalbody) != 1):
        raise CatalogBindingError('query_result_transport_unresolved')
    assignment, guard, returned = block.body
    if (not isinstance(assignment, ast.Assign) or len(assignment.targets) != 1
            or not isinstance(assignment.targets[0], ast.Name)
            or not isinstance(returned, ast.Return) or not isinstance(returned.value, ast.Name)
            or returned.value.id != assignment.targets[0].id or returned.value.id == result_name
            or not isinstance(guard, ast.If) or guard.orelse or len(guard.body) != 1
            or not isinstance(guard.body[0], ast.Raise) or guard.body[0].exc is None):
        raise CatalogBindingError('query_result_transport_unresolved')
    value = assignment.value
    if not isinstance(value, ast.Call) or len(value.args) != 1:
        raise CatalogBindingError('query_mapping_materialization_unresolved')
    fetch = value.args[0]
    if (not isinstance(fetch, ast.Call) or len(fetch.args) != 1 or fetch.keywords
            or not isinstance(fetch.args[0], ast.BinOp) or not isinstance(fetch.args[0].op, ast.Add)
            or not isinstance(fetch.args[0].left, ast.Name) or not isinstance(fetch.args[0].right, ast.Constant)
            or type(fetch.args[0].right.value) is not int or fetch.args[0].right.value != 1):
        raise CatalogBindingError('query_mapping_result_protocol_unresolved')
    limit = fetch.args[0].left.id
    if limit == 'len':
        raise CatalogBindingError('query_result_bound_identity_unresolved')
    expected_guard = ast.parse(f'len({returned.value.id}) > {limit}', mode='eval').body
    expected_close = ast.parse(f'{result_name}.close()').body[0]
    if (ast.dump(guard.test) != ast.dump(expected_guard)
            or ast.dump(block.finalbody[0]) != ast.dump(expected_close)):
        raise CatalogBindingError('query_result_transport_unresolved')
    # A shadowed len or non-primitive bound could mutate rows while testing them.
    definitions = [node for node in graph.tree.body if isinstance(node, ast.Assign)
                   and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name)
                   and node.targets[0].id == limit and isinstance(node.value, ast.Constant)
                   and type(node.value.value) is int and node.value.value > 0]
    writes = [node for node in ast.walk(graph.tree) if isinstance(node, ast.Name)
              and node.id in {'len', limit} and isinstance(node.ctx, (ast.Store, ast.Del))]
    shadowed = any(
        isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Import, ast.ImportFrom,
                          ast.ExceptHandler, ast.MatchAs, ast.MatchStar, ast.MatchMapping))
        and bool(_assigned_names(node).intersection({'len', limit, '*'}))
        or isinstance(node, ast.arg) and node.arg in {'len', limit}
        for node in ast.walk(graph.tree))
    if len(definitions) != 1 or writes != [definitions[0].targets[0]] or shadowed:
        raise CatalogBindingError('query_result_bound_identity_unresolved')
    return value, returned


def _result_return(graph, function, execute):
    """Exact mapping transports, not a helper-name convention."""
    body = function.body
    if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant) and isinstance(body[0].value.value, str):
        body = body[1:]
    if len(body) != 2 or not isinstance(body[0], ast.Assign) or len(body[0].targets) != 1 or not isinstance(body[0].targets[0], ast.Name) or body[0].value is not execute:
        raise CatalogBindingError('query_result_transport_unresolved')
    bounded = isinstance(body[1], ast.Try)
    if bounded:
        returned, return_statement = _bounded_result(graph, body[1], body[0].targets[0].id)
    elif isinstance(body[1], ast.Return):
        returned, return_statement = body[1].value, body[1]
    else:
        raise CatalogBindingError('query_result_transport_unresolved')
    if not isinstance(returned, ast.Call) or not isinstance(returned.func, ast.Name) or returned.func.id != 'list' or len(returned.args) != 1 or returned.keywords:
        raise CatalogBindingError('query_mapping_materialization_unresolved')
    parameters = {arg.arg: graph.add(arg, 'decoder_input', name=arg.arg, frame=f'result:{function.name}')
                  for arg in [*function.args.posonlyargs, *function.args.args, *function.args.kwonlyargs]}
    reference = graph.resolve(returned.func, function, parameters, {}, f'result:{function.name}')
    materializer = next(node for node in graph.nodes if node['id'] == reference)
    if materializer['kind'] != 'builtin_syntax' or any(isinstance(node, ast.ImportFrom) and any(alias.name == '*' for alias in node.names) for node in ast.walk(graph.tree)):
        raise CatalogBindingError('query_result_materializer_identity_unresolved')
    chain = returned.args[0]
    for method in ('fetchmany' if bounded else 'all', 'mappings'):
        if not isinstance(chain, ast.Call) or (chain.args and method != 'fetchmany') or chain.keywords or not isinstance(chain.func, ast.Attribute) or chain.func.attr != method:
            raise CatalogBindingError('query_mapping_result_protocol_unresolved')
        chain = chain.func.value
    if not isinstance(chain, ast.Name) or chain.id != body[0].targets[0].id:
        raise CatalogBindingError('query_result_owner_mismatch')
    return {'execute_line': execute.lineno, 'execute_column': execute.col_offset,
            'return_line': return_statement.lineno,
            'protocol': 'bounded list(Result.mappings().fetchmany(limit+1)); reject overflow; finally close' if bounded else 'list(Result.mappings().all())',
            'runtime_result_verified': False}


def _decoder_consumer(graph, entrypoint, use):
    path = use['call_path']
    if len(path) < 2:
        raise CatalogBindingError('query_result_helper_required')
    caller = graph.functions[entrypoint]
    for step in path[1:-1]:
        position, name = step.split('->', 1)
        line, column = map(int, position.split(':'))
        _at(graph, caller, line, column)
        caller = graph.functions[name]
    position, name = path[-1].split('->', 1)
    line, column = map(int, position.split(':'))
    call = _at(graph, caller, line, column)
    function = graph.functions[name]
    execute = _at(graph, function, use['line'], use['column'])
    transport = _result_return(graph, function, execute)
    parent = graph.parents.get(id(call))
    if isinstance(parent, ast.keyword):
        parent = graph.parents.get(id(parent))
    if not isinstance(parent, ast.Call):
        raise CatalogBindingError('query_result_direct_decoder_call_required')
    name = _function_name(graph, parent.func, caller, f'consumer:{parent.lineno}:{parent.col_offset}')
    if name is None:
        raise CatalogBindingError('query_decoder_callable_unresolved')
    decoder = graph.functions[name]
    arguments, reason = _arguments(parent, decoder)
    parameters = [key for key, value in (arguments or {}).items() if value is call]
    if reason or len(parameters) != 1:
        raise CatalogBindingError('query_decoder_argument_binding_unresolved')
    return {'decoder': name, 'input_parameter': parameters[0], 'caller': caller.name,
            'consumer_line': parent.lineno, 'consumer_column': parent.col_offset,
            'helper_call_line': call.lineno, 'helper_call_column': call.col_offset, 'transport': transport}


def _result_labels(graph, context):
    sql = context['use']['sql']
    _, text = python_sql_literals(graph.tree)[(sql['line'], sql['column'])]
    if hashlib.sha256(text.encode()).hexdigest() != sql['text_sha256']:
        raise CatalogBindingError('query_decoder_sql_literal_mismatch')
    statements = [node for node in parse_sql(text) if node is not None]
    if len(statements) != 1 or not isinstance(statements[0], exp.Select) or len(context['projections']) != 1:
        raise CatalogBindingError('query_decoder_single_select_required')
    projection = context['projections'][0]
    conditions = {(origin['dataset_urn'], origin['field_path']): origin
                  for clause in projection['conditions'] for origin in clause['origins']}
    outputs = {}
    for output in projection['outputs']:
        selected = {**conditions, **{(item['dataset_urn'], item['field_path']): item for item in output['condition_origins']}}
        outputs[output['output_name']] = {**output, 'condition_origins': [selected[key] for key in sorted(selected)]}
    labels = {}
    for selection in statements[0].expressions:
        alias = selection.args.get('alias') if isinstance(selection, exp.Alias) else None
        if alias is None or not isinstance(alias, exp.Identifier):
            raise CatalogBindingError('query_decoder_explicit_result_alias_required')
        normalized = normalize_identifiers(alias.copy(), dialect='tsql').name
        if alias.name in labels or normalized not in outputs:
            raise CatalogBindingError('query_decoder_output_identity_unresolved')
        # Preserve exact result label spelling. Catalog/SQLGlot normalization
        # must not make Python mapping keys case-insensitive.
        labels[alias.name] = outputs[normalized]
    if len(labels) != len(outputs):
        raise CatalogBindingError('query_decoder_output_shape_mismatch')
    return labels


def bind_python_query_decoders(analysis, snapshot, *, path, entrypoint, scopes_by_context, reader):
    """Reproduce query/Catalog context before linking any decoder mapping read."""
    result = bind_python_sql_projections(analysis, snapshot, path=path, entrypoint=entrypoint,
                                        scopes_by_context=scopes_by_context, reader=reader)
    source = next(file for file in snapshot.files if file.path == path)
    graph = _Graph(source)
    decoders = {}
    for context in result['contexts']:
        context['query_decoder'] = {'status': 'UNRESOLVED', 'links': []}
        try:
            if context['projection_status'] != 'DESCRIBED':
                raise CatalogBindingError('query_decoder_projection_unresolved')
            consumer = _decoder_consumer(graph, entrypoint, context['use'])
            labels = _result_labels(graph, context)
            name = consumer['decoder']
            if name not in decoders:
                decoders[name] = analyze_python_decoder(source, entrypoint=name)
            decoder = decoders[name]
            if decoder['findings'] or not decoder['records']:
                raise CatalogBindingError('query_decoder_returned_records_unresolved')
            links, unresolved, static_fields = [], [], []
            for record in decoder['records']:
                for field in record['fields']:
                    value = field['value_dependencies']
                    origins, conditions, value_gaps = {}, {}, list(value['unresolved'])
                    for read in value['input_reads']:
                        output = labels.get(read['field_name'])
                        if read['input_parameter'] != consumer['input_parameter'] or output is None:
                            value_gaps.append({'node_ref': read['node_ref'], 'reason': 'scalar_query_label_unresolved'})
                            continue
                        if not output['origins']:
                            value_gaps.append({'node_ref': read['node_ref'], 'reason': 'query_non_column_value_requires_classification'})
                        target = conditions if read['role'] == 'condition' else origins
                        for origin in output['origins']:
                            target[(origin['dataset_urn'], origin['field_path'])] = origin
                        for origin in output['condition_origins']:
                            conditions[(origin['dataset_urn'], origin['field_path'])] = origin
                    static_fields.append({'record_ref': record['node_ref'], 'record_field': field['name'],
                        'status': 'STATIC_VALUE_ORIGINS' if not value_gaps else 'INCONCLUSIVE',
                        'origins': list(origins.values()), 'condition_origins': list(conditions.values()),
                        'constants': value['constants'], 'transformations': value['transformations'],
                        'scalar_type': field['scalar_type'], 'unresolved': value_gaps,
                        'runtime_value_verified': False})
                    for read in field['input_reads']:
                        output = labels.get(read['field_name'])
                        if read['input_parameter'] != consumer['input_parameter'] or not read['input_owner_described'] or output is None:
                            unresolved.append({'record_ref': record['node_ref'], 'record_field': field['name'],
                                               'read_ref': read['node_ref'], 'reason': 'decoder_read_not_bound_to_result_label'})
                            continue
                        links.append({'record_ref': record['node_ref'], 'record_field': field['name'],
                                      'read_ref': read['node_ref'], 'role': read['role'],
                                      'result_label': read['field_name'], 'query_output_name': output['output_name'],
                                      'origins': output['origins'], 'condition_origins': output['condition_origins'],
                                      'runtime_value_verified': False})
            context['query_decoder'] = {**consumer, 'status': 'DECLARATION_LINKS_DESCRIBED' if links and not unresolved else 'PARTIAL',
                                        'links': links, 'unresolved': unresolved, 'static_fields': static_fields}
        except (CatalogBindingError, ValueError, KeyError, StopIteration, RecursionError) as error:
            context['query_decoder']['reason'] = str(error) if isinstance(error, CatalogBindingError) else 'query_decoder_seam_unresolved'
    result['format'] = 'dataflow-discovery.python-query-decoders/1'
    result['decoder_reports'] = decoders
    result['status'] = 'INCONCLUSIVE'
    result['runtime_values_verified'] = False
    result['limitations'].extend(['SQLAlchemy mapping-result protocol is source syntax, not executed result or actual branch evidence',
                                  'Only exact two-statement result helpers and direct decoder arguments with explicit SELECT aliases',
                                  'Value/condition/prior-declaration links stay distinct; no Python losslessness or complete successful-path contract',
                                  'No connection to downstream bind values or approval of cross-database lineage'])
    return result

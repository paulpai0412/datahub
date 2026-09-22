"""Declared row decoder outputs and helper exits, without executing Python.

A mapping read is tied to a decoder's symbolic iterable input, not a SQL
Dataset. Prior (invalidated) declarations and conditional reads remain separate.
"""
from __future__ import annotations

import ast
import hashlib

from .python_bind_values import _Graph, _collection_declarations


def _references(value, role='value'):
    if isinstance(value, dict) and value.get('kind') == 'call':
        # Calling f(x) evaluates x, but does not establish f(x) == x or even
        # dependence of the returned value on x. Return summaries are source
        # declarations, not effect-checked or runtime-verified value edges.
        callee_role = 'prior_declaration' if role == 'prior_declaration' else 'evaluated_callee'
        argument_role = 'prior_declaration' if role == 'prior_declaration' else 'evaluated_argument'
        return_role = 'return_declaration' if role in {'value', 'return_declaration'} else role
        yield value['callee_ref'], callee_role
        for reference in value['arguments']:
            yield reference, argument_role
        for keyword in value['keywords']:
            yield keyword['value_ref'], argument_role
        if value.get('declared_return_ref'):
            yield value['declared_return_ref'], return_role
        return
    if isinstance(value, dict):
        for key, item in value.items():
            nested_role = 'prior_declaration' if key == 'initial_declaration_ref' else 'condition' if key in {'condition_ref', 'condition_refs'} and role == 'value' else role
            if key.endswith('_ref') and isinstance(item, str):
                yield item, nested_role
            elif (key.endswith('_refs') or key in {'arguments', 'operands', 'items'}) and isinstance(item, list):
                for reference in item:
                    if isinstance(reference, str):
                        yield reference, nested_role
            elif isinstance(item, (dict, list)):
                yield from _references(item, nested_role)
    elif isinstance(value, list):
        for item in value:
            yield from _references(item, role)


def _input_owner(reference, nodes):
    visited = set()
    iteration = False
    while reference not in visited:
        visited.add(reference)
        node = nodes[reference]
        if node['kind'] == 'decoder_input':
            return node['name'] if iteration else None
        if node['kind'] == 'iteration_element':
            if iteration:
                return None
            iteration = True
            reference = node['iterable_ref']
        elif node['kind'] == 'parameter':
            reference = node['argument_ref']
        elif node['kind'] == 'assignment':
            reference = node['value_ref']
        else:
            break
    return None


def _field_dependencies(reference, nodes, role='value'):
    pending = [(reference, role)]
    visited = set()
    reads, calls, unresolved = [], [], []
    while pending:
        reference, role = pending.pop()
        if (reference, role) in visited:
            continue
        visited.add((reference, role))
        node = nodes[reference]
        if node['kind'] == 'mapping_field':
            owner = _input_owner(node['owner_ref'], nodes)
            reads.append({'node_ref': reference, 'role': role, 'input_parameter': owner,
                          'field_name': node['field_name'], 'input_owner_described': owner is not None})
        if node['kind'] == 'call':
            callee = nodes[node['callee_ref']]
            calls.append({'node_ref': reference, 'role': role, 'callee_ref': node['callee_ref'],
                          'local_helper': callee['name'] if callee['kind'] == 'function_syntax' else None})
        if node['kind'] == 'unresolved':
            unresolved.append({'node_ref': reference, 'role': role, 'reason': node['reason']})
        pending.extend(_references(node, role))
    return {'input_reads': reads, 'calls': calls, 'unresolved': unresolved}


def _value_dependencies(graph, reference, bound_reads=None):
    """Returned scalar dataflow, distinct from evaluated call arguments.

    Follow source helper returns and the small public scalar-operation contract.
    Opaque calls never inherit their arguments' origins. This is possible static
    value provenance on successful paths, not execution or losslessness proof.
    """
    nodes = {node['id']: node for node in graph.nodes}
    bindings = bound_reads or {}
    known_types = {ref: value.get('scalar_type') for ref, value in bindings.items()
                   if value['status'] == 'STATIC_VALUE_ORIGINS'}
    pending, seen = [(reference, 'value')], set()
    reads, constants, transforms, gaps = [], [], [], []
    physical, conditions = {}, {}
    generated = []
    while pending:
        ref, role = pending.pop()
        if (ref, role) in seen:
            continue
        seen.add((ref, role))
        if len(seen) > 4096:
            gaps.append({'node_ref': ref, 'role': role, 'reason': 'value_dependency_limit'})
            break
        node = nodes[ref]
        kind = node['kind']
        if ref in bindings:
            binding = bindings[ref]
            if binding['status'] != 'STATIC_VALUE_ORIGINS':
                gaps.append({'node_ref': ref, 'role': role, 'reason': 'bound_value_origin_unresolved'})
                continue
            target = conditions if role == 'condition' else physical
            for origin in binding['origins']:
                target[(origin['dataset_urn'], origin['field_path'])] = origin
            for origin in binding.get('condition_origins', []):
                conditions[(origin['dataset_urn'], origin['field_path'])] = origin
            constants.extend({**item, 'role': role} for item in binding.get('constants', []))
            transforms.extend({**item, 'role': role} for item in binding.get('transformations', []))
            generated.extend({**item, 'role': role} for item in binding.get('generated', []))
            continue
        if kind in {'mapping_field', 'mapping_get'}:
            owner = _input_owner(node['owner_ref'], nodes)
            if owner is None:
                gaps.append({'node_ref': ref, 'role': role, 'reason': 'scalar_input_owner_unresolved'})
            else:
                reads.append({'node_ref': ref, 'role': role, 'input_parameter': owner, 'field_name': node['field_name']})
            continue
        if kind == 'generated_date_series':
            generated.append({'node_ref': ref, 'role': role, 'method': 'declared_calendar_range',
                'start_parameter': node['start'], 'end_parameter': node['end'], 'step_days': node['step_days'],
                'inclusive': node['inclusive'], 'loop_line': node['loop_line'],
                'runtime_parameter_verified': False, 'iteration_verified': False})
            continue
        if kind == 'literal':
            constants.append({'node_ref': ref, 'role': role, 'literal_type': node['literal_type']})
            continue
        if kind == 'import_syntax' and node['qualified_name'] in {
                'decimal.ROUND_HALF_UP', 'decimal.ROUND_HALF_EVEN', 'decimal.ROUND_DOWN', 'decimal.ROUND_UP',
                'decimal.ROUND_CEILING', 'decimal.ROUND_FLOOR', 'decimal.ROUND_HALF_DOWN', 'decimal.ROUND_05UP'}:
            constants.append({'node_ref': ref, 'role': role, 'library_constant': node['qualified_name']})
            continue
        children = []
        if kind in {'parameter', 'assignment'}:
            children = [(node['argument_ref'] if kind == 'parameter' else node['value_ref'], role)]
        elif kind == 'return_alternatives' and node['explicit_exit_coverage']:
            children = [(item['value_ref'], role) for item in node['alternatives']]
            children += [(condition, 'condition') for item in node['alternatives'] for condition in item['condition_refs']]
        elif kind == 'conditional_choice':
            children = [(node['if_true_ref'], role), (node['if_false_ref'], role), (node['condition_ref'], 'condition')]
        elif kind == 'boolean_choice':
            children = [(item, role) for item in node['operands']]
        elif kind in {'binary_expression', 'unary_expression'}:
            if graph.scalar_type(ref, known_types=known_types) in {'int', 'float', 'decimal.Decimal', 'str'}:
                children = list(_references(node, role))
                transforms.append({'node_ref': ref, 'role': role, 'operation': kind, 'operator': node['operator']})
            else:
                gaps.append({'node_ref': ref, 'role': role, 'reason': 'scalar_operator_type_unresolved'})
                continue
        elif kind == 'comparison' and role == 'condition':
            children = list(_references(node, role))
            transforms.append({'node_ref': ref, 'role': role, 'operation': kind})
        elif kind == 'attribute' and node['attribute'] in {'year', 'month', 'day'} and graph.scalar_type(node['owner_ref'], known_types=known_types) in {'datetime.date', 'datetime.datetime'}:
            children = [(node['owner_ref'], role)]
            transforms.append({'node_ref': ref, 'role': role, 'operation': 'calendar_component'})
        elif kind == 'call':
            callee = nodes[node['callee_ref']]
            operation = None
            if callee['kind'] == 'function_syntax' and node.get('declared_return_ref') and node.get('return_paths_explicit'):
                children = [(node['declared_return_ref'], role)]
                operation = 'source_helper_return'
            elif (callee['kind'] == 'builtin_syntax' and callee['name'] in {'int', 'str', 'float', 'bool', 'abs'}
                  and len(node['arguments']) == 1 and not node['keywords']):
                children = [(node['arguments'][0], role)]
                operation = callee['name']
            elif (callee['kind'] == 'builtin_syntax' and callee['name'] == 'isinstance'
                  and len(node['arguments']) == 2 and not node['keywords'] and role == 'condition'):
                target = nodes[node['arguments'][1]]
                if target['kind'] in {'builtin_syntax', 'import_syntax'}:
                    children = [(node['arguments'][0], role)]
                    operation = 'type_condition'
            elif (callee['kind'] == 'import_syntax' and callee['qualified_name'] == 'decimal.Decimal'
                  and len(node['arguments']) == 1 and not node['keywords']):
                children = [(node['arguments'][0], role)]
                operation = 'decimal.Decimal'
            elif callee['kind'] == 'attribute':
                receiver_type = graph.scalar_type(callee['owner_ref'], known_types=known_types)
                method = callee['attribute']
                if (receiver_type == 'decimal.Decimal' and method == 'quantize' and len(node['arguments']) == 1
                        and all(item['name'] == 'rounding' for item in node['keywords'])):
                    children = [(callee['owner_ref'], role), (node['arguments'][0], role)]
                    children += [(item['value_ref'], role) for item in node['keywords']]
                    operation = 'decimal.quantize'
                elif (receiver_type == 'datetime.datetime' and method == 'date'
                      and not node['arguments'] and not node['keywords']):
                    children = [(callee['owner_ref'], role)]
                    operation = 'datetime.date'
                elif (receiver_type in {'datetime.date', 'datetime.datetime'} and method == 'strftime'
                      and len(node['arguments']) == 1 and not node['keywords']
                      and nodes[node['arguments'][0]]['kind'] == 'literal'
                      and nodes[node['arguments'][0]]['literal_type'] == 'str'):
                    children = [(callee['owner_ref'], role), (node['arguments'][0], role)]
                    operation = 'datetime.strftime_locale_dependent'
            if operation:
                transforms.append({'node_ref': ref, 'role': role, 'operation': operation})
            else:
                gaps.append({'node_ref': ref, 'role': role, 'reason': 'call_return_provenance_unresolved'})
            pending.extend(children)
            continue
        if children:
            pending.extend(children)
        else:
            gaps.append({'node_ref': ref, 'role': role, 'reason': node.get('reason', 'scalar_value_unresolved')})
    return {'status': 'STATIC_VALUE_DEPENDENCIES' if not gaps else 'INCONCLUSIVE',
            'input_reads': reads, 'constants': constants, 'transformations': transforms, 'unresolved': gaps,
            'origins': list(physical.values()), 'condition_origins': list(conditions.values()),
            'generated': generated, 'runtime_values_verified': False}


def _function_exits(graph, function, frame):
    parameters = {argument.arg: graph.add(argument, 'decoder_input', name=argument.arg, frame=frame)
                  for argument in [*function.args.posonlyargs, *function.args.args, *function.args.kwonlyargs]}
    result = {'function': function.name, 'definition_line': function.lineno, 'returns': [], 'raises': [], 'conditions': []}
    for node in graph.local_nodes(function):
        if isinstance(node, ast.Return) and node.value is not None:
            result['returns'].append({'line': node.lineno, 'guards': graph.guards(node, function),
                                      'value_ref': graph.resolve(node.value, function, parameters, {}, frame)})
        elif isinstance(node, ast.Raise):
            result['raises'].append({'line': node.lineno, 'guards': graph.guards(node, function),
                                     'expression_sha256': hashlib.sha256(ast.dump(node).encode()).hexdigest()})
        elif isinstance(node, (ast.If, ast.While)):
            result['conditions'].append({'line': node.lineno, 'kind': type(node).__name__,
                                         'condition_ref': graph.resolve(node.test, function, parameters, {}, frame)})
    return result


def analyze_python_decoder(source, *, entrypoint: str) -> dict:
    """Describe a stable local function's returned plain-dataclass constructions.

    Unsupported constructors, defaults, inheritance and custom initialization do
    not inherit ordinary dataclass field positioning. No callable is imported or
    invoked. Helper exits are declarations, not proof of their runtime semantics.
    """
    graph = _Graph(source)
    if not isinstance(entrypoint, str) or entrypoint not in graph.functions:
        raise ValueError('invalid_python_decoder_entrypoint')
    records, helpers, findings = [], [], []
    exits = None
    try:
        exits = _function_exits(graph, graph.functions[entrypoint], f'decoder:{entrypoint}')
        nodes = {node['id']: node for node in graph.nodes}
        declarations = {}
        for returned in exits['returns']:
            for record, collection_findings in _collection_declarations(returned['value_ref'], nodes, 'record_construction'):
                declarations[record['id'], collection_findings] = record
        helper_names = set()
        for (reference, collection_findings), record in declarations.items():
            fields = []
            for field in record['fields']:
                dependencies = _field_dependencies(field['value_ref'], nodes,
                    'prior_declaration' if collection_findings else 'value')
                helper_names.update(call['local_helper'] for call in dependencies['calls'] if call['local_helper'])
                values = _value_dependencies(graph, field['value_ref'])
                if collection_findings:
                    values['status'] = 'INCONCLUSIVE'
                    values['unresolved'].extend({'node_ref': reference, 'role': 'value', 'reason': reason}
                                                for reason in collection_findings)
                fields.append({**field, **dependencies, 'value_dependencies': values,
                               'scalar_type': graph.scalar_type(field['value_ref'])})
            records.append({'node_ref': reference, 'record_type': nodes[record['callee_ref']]['name'],
                            'fields': fields, 'collection_findings': list(collection_findings), 'construction_verified': False})
        for name in sorted(helper_names):
            helpers.append(_function_exits(graph, graph.functions[name], f'helper:{name}'))
        if not records:
            findings.append({'reason': 'returned_record_declaration_unresolved'})
    except (ValueError, RecursionError):
        findings.append({'reason': 'decoder_graph_limit_or_incomplete'})
    return {'format': 'dataflow-discovery.python-decoder/1', 'path': source.path, 'file_sha256': source.sha256,
            'entrypoint': entrypoint, 'exits': exits, 'records': records, 'helpers': helpers,
            'nodes': graph.nodes, 'findings': findings, 'status': 'INCONCLUSIVE',
            'source_executed': False, 'runtime_values_verified': False, 'transformation_semantics_verified': False,
            'publication_authorized': False,
            'limitations': ['Returned constructions and helper exits describe source syntax, not execution or losslessness',
                            'Input parameter/field names are query-local; SQL context and physical owner are not inferred',
                            'Direct mutation/unknown effects retain prior declarations separately, not current value origins',
                            'Only required-field plain local dataclasses; custom initialization/defaults/inheritance are unresolved',
                            'Raise sites and lexical conditions are not a complete path-sensitive success contract']}

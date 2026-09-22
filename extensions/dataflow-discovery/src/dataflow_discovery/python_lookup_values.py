"""Dictionary lookup key/value declarations, not uniqueness or match proof."""
from .python_bind_values import _Graph
from .python_decoders import _references, _value_dependencies
from .python_write_parameters import declared_identity_fields
from .python_query_decoders import _at, _result_labels, _result_return
from .python_record_consumers import _unfold, bind_python_record_consumers
from .catalog import CatalogBindingError


def _reachable(reference, nodes, role='value'):
    pending, seen = [(reference,role)], set()
    while pending:
        reference, role = pending.pop()
        if (reference,role) in seen:
            continue
        seen.add((reference,role))
        node = nodes[reference]
        yield node, role
        if node['kind'] != 'iteration_element':
            pending.extend(_references(node,role))


def _query_index(graph, contexts):
    result = {}
    for context in contexts:
        if context['projection_status'] != 'DESCRIBED' or len(context['use']['call_path']) < 2:
            continue
        try:
            use = context['use']
            position, name = use['call_path'][-1].split('->',1)
            line, column = map(int,position.split(':'))
            function = graph.functions[name]
            _result_return(graph,function,_at(graph,function,use['line'],use['column']))
            labels = _result_labels(graph,context)
            key = (tuple(use['call_path'][:-1]),line,column,name)
            result.setdefault(key,[]).append((context['context_id'],labels))
        except (CatalogBindingError, KeyError, ValueError, StopIteration):
            continue
    return result


def _mapping_reads(reference, nodes, queries):
    reads = []
    for node, role in _reachable(reference,nodes):
        if node['kind'] not in {'mapping_field','mapping_get'}:
            continue
        for owner, warnings in _unfold(node['owner_ref'],nodes):
            if owner['kind'] != 'iteration_element':
                continue
            for producer, trail in _unfold(owner['iterable_ref'],nodes):
                if producer['kind'] != 'call' or not producer.get('caller_path'):
                    continue
                callee = nodes[producer['callee_ref']]
                if callee['kind'] != 'function_syntax':
                    continue
                key=(tuple(producer['caller_path']),producer['line'],producer['column'],callee['name'])
                matches=queries.get(key,[])
                if len(matches)!=1:
                    continue
                context_id, labels=matches[0]
                output=labels.get(node['field_name'])
                if output is not None:
                    reads.append({'read_ref':node['id'],'read_role':role,'producer_context_id':context_id,'result_label':node['field_name'],
                                  'origins':output['origins'], 'condition_origins':output['condition_origins'],
                                  'chain_findings':[*warnings,*trail], 'runtime_value_verified':False})
    return reads


def _merged_origins(values, key='origins'):
    origins = {}
    for value in values:
        for origin in value.get(key, []):
            identity = (origin['dataset_urn'], origin['field_path'])
            if identity in origins and origins[identity] != origin:
                raise CatalogBindingError('scalar_origin_schema_conflict')
            origins[identity] = origin
    return [origins[key] for key in sorted(origins)]


def _combined_value(values):
    types = {value.get('scalar_type') for value in values}
    return {'status': 'STATIC_VALUE_ORIGINS' if values and all(value['status'] == 'STATIC_VALUE_ORIGINS'
            for value in values) else 'INCONCLUSIVE',
            'origins': _merged_origins(values), 'condition_origins': _merged_origins(values, 'condition_origins'),
            'constants': [item for value in values for item in value.get('constants', [])],
            'transformations': [item for value in values for item in value.get('transformations', [])],
            'scalar_type': next(iter(types)) if len(types) == 1 else None}


def _static_slot_values(slot, graph, queries, query_contexts):
    """Consume reproduced value summaries, not the legacy evaluated-argument links."""
    if slot['value_kind'] == 'SQL_QUERY_VALUE':
        slot['static_value_dependencies'] = [slot['sql_value_dependencies']]
        return
    nodes = {node['id']: node for node in graph.nodes}
    bindings = {}
    grouped = {}
    for link in slot['record_consumer']['links']:
        key = (link['producer_context_id'], link['record_field'])
        grouped.setdefault(link['consumer_ref'], {}).setdefault(key, []).append(link)
    for reference, producers in grouped.items():
        values = []
        for (context_id, field), links in producers.items():
            fields = query_contexts[context_id]['query_decoder'].get('static_fields', [])
            matches = [item for item in fields if item['record_field'] == field]
            if (not matches or len(matches) != len({item['record_ref'] for item in fields})
                    or any(link['chain_findings'] for link in links)):
                values.append({'status': 'INCONCLUSIVE'})
            else:
                values.extend(matches)
        bindings[reference] = _combined_value(values)
        if len(producers) != 1:
            bindings[reference]['status'] = 'INCONCLUSIVE'

    def mapping_reads(reference):
        result = {}
        for read in _mapping_reads(reference, nodes, queries):
            value = {'status': 'STATIC_VALUE_ORIGINS' if read['origins'] and not read['chain_findings']
                     else 'INCONCLUSIVE', 'origins': read['origins'], 'condition_origins': read['condition_origins']}
            result.setdefault(read['read_ref'], []).append(value)
        return {ref: _combined_value(values) for ref, values in result.items()}

    for declaration in slot['python_declarations']:
        bindings.update(mapping_reads(declaration['value_ref']))
    lookup_bindings = {}
    for lookup in slot['lookup_values']['declarations']:
        mapping = nodes[lookup['mapping_ref']]
        local = {**bindings, **mapping_reads(mapping['key_ref']), **mapping_reads(mapping['value_ref'])}
        value = _value_dependencies(graph, mapping['value_ref'], local)
        keys = [_value_dependencies(graph, mapping['key_ref'], local),
                _value_dependencies(graph, lookup['input_key_ref'], local)]
        keys.extend(_value_dependencies(graph, ref, {**local, **mapping_reads(ref)}) for ref in lookup['filter_refs'])
        complete = (not lookup['chain_findings'] and value['status'] == 'STATIC_VALUE_DEPENDENCIES'
                    and all(item['status'] == 'STATIC_VALUE_DEPENDENCIES' for item in keys))
        typed = {ref: item.get('scalar_type') for ref, item in local.items() if item['status'] == 'STATIC_VALUE_ORIGINS'}
        bound = {'status': 'STATIC_VALUE_ORIGINS' if complete else 'INCONCLUSIVE',
                 'origins': value['origins'],
                 'condition_origins': _merged_origins(keys) + _merged_origins([value, *keys], 'condition_origins'),
                 'constants': value['constants'], 'transformations': value['transformations'],
                 'scalar_type': graph.scalar_type(mapping['value_ref'], known_types=typed)}
        lookup_bindings.setdefault(lookup['lookup_ref'], []).append(bound)
    bindings.update({ref: _combined_value(values) for ref, values in lookup_bindings.items()})
    values = []
    for declaration in slot['python_declarations']:
        described = _value_dependencies(graph, declaration['value_ref'], bindings)
        if declaration['collection_findings'] or described['input_reads']:
            described['status'] = 'INCONCLUSIVE'
        values.append({'parameter_name': declaration['parameter_name'], **described})
    slot['static_value_dependencies'] = values


def _output_partition(report, generated_fields):
    """Partition observed target schemas, including fields omitted by INSERT.

    A resolved subset never establishes completeness. Missing generation facts,
    unsupported writes, and unknown contexts remain explicit blockers.
    """
    fields, gaps = {}, []
    for context in report['contexts']:
        if context['status'] not in {'CATALOG_BOUND', 'NO_DATASET_DEPENDENCIES'}:
            gaps.append({'context_id': context['context_id'], 'reason': 'context_unresolved'})
        for binding in context['bindings']:
            if binding['relation_type'] != 'writes':
                continue
            if binding['status'] != 'CATALOG_BOUND':
                gaps.append({'context_id': context['context_id'], 'reason': 'target_schema_unresolved'})
                continue
            dataset = binding['dataset']
            for field in dataset['field_paths']:
                identity = (dataset['urn'], field)
                if identity in fields and fields[identity]['schema_sha256'] != dataset['schema_sha256']:
                    raise CatalogBindingError('output_schema_conflict')
                fields.setdefault(identity, {'dataset_urn': dataset['urn'], 'field_path': field,
                    'schema_sha256': dataset['schema_sha256'], 'declarations': [], 'insert_omissions': []})
            statements = [item for item in context['write_statements'] if item['process'] == binding['process']]
            if not statements or any(item['status'] != 'WRITE_PARAMETER_TARGETS_DESCRIBED' for item in statements):
                gaps.append({'context_id': context['context_id'], 'reason': 'write_statement_unresolved'})
            if context['statement_kinds'].get(binding['process']) == 'INSERT':
                for statement in statements:
                    assigned = {slot['field_path'] for slot in statement['slots']}
                    for name in dataset['field_paths']:
                        if name not in assigned:
                            fields[(dataset['urn'], name)]['insert_omissions'].append({
                                'context_id': context['context_id'], 'process': binding['process']})
        for statement in context['write_statements']:
            for slot in statement['slots']:
                identity = (slot['dataset_urn'], slot['field_path'])
                if identity not in fields:
                    gaps.append({'context_id': context['context_id'], 'reason': 'slot_target_unobserved'})
                    continue
                fields[identity]['declarations'].append({'context_id': context['context_id'],
                    'process': statement['process'], 'position': slot['position'], 'row_index': slot['row_index'],
                    'expression_sha256': slot['expression_sha256'], 'target_read_fields': slot['target_read_fields'],
                    'value_kind': slot['value_kind'], 'parameter_names': slot['parameter_names'],
                    'values': slot['static_value_dependencies']})
    for field in fields.values():
        declarations = field['declarations']
        values = [value for declaration in declarations for value in declaration['values']]
        identity = (field['dataset_urn'], field['field_path'])
        generation = generated_fields.get(identity) if field['insert_omissions'] else None
        unresolved = (bool(field['insert_omissions']) and generation is None
                      or any(not declaration['values'] for declaration in declarations)
                      or any(value['status'] != 'STATIC_VALUE_DEPENDENCIES' for value in values)
                      or any(declaration['target_read_fields']
                             or not (declaration['value_kind'] == 'SQL_QUERY_VALUE'
                                     or (declaration['value_kind'] == 'DIRECT_PARAMETER'
                                         and len(declaration['parameter_names']) == 1))
                             for declaration in declarations))
        origins = _merged_origins(values)
        field.update(origins=origins, condition_origins=_merged_origins(values, 'condition_origins'),
                     generated=[item for value in values for item in value.get('generated', [])],
                     constants=[item for value in values for item in value.get('constants', [])])
        if generation is not None:
            field['generated'].append(generation)
        if unresolved:
            classification = 'UNRESOLVED'
        elif origins:
            classification = 'SOURCE_FIELDS'
        elif field['generated']:
            classification = 'DECLARED_GENERATED'
        elif field['constants']:
            classification = 'CONSTANT'
        elif not declarations and not field['insert_omissions']:
            classification = 'PRESERVED_EXISTING_VALUE'
        else:
            classification = 'UNRESOLVED'
        field['classification'] = classification
        if classification == 'UNRESOLVED':
            field['reason'] = 'omitted_field_generation_unproven' if not declarations else 'value_origin_unresolved'
    ordered = [fields[identity] for identity in sorted(fields)]
    unresolved_fields = sum(field['classification'] == 'UNRESOLVED' for field in ordered)
    return {'format': 'datahub-etl.output-partition/1', 'scope': 'selected_python_entrypoint_target_schemas',
            'denominator_established': bool(fields) and not gaps,
            'expected_fields': len(fields), 'classified_fields': len(fields) - unresolved_fields,
            'unresolved_fields': unresolved_fields, 'fields': ordered, 'blockers': gaps,
            'complete': bool(fields) and not gaps and unresolved_fields == 0,
            'runtime_values_verified': False, 'publication_authorized': False}


def bind_python_lookup_values(analysis,snapshot,*,path,entrypoint,scopes_by_context,reader):
    result=bind_python_record_consumers(analysis,snapshot,path=path,entrypoint=entrypoint,
                                       scopes_by_context=scopes_by_context,reader=reader)
    source=next(file for file in snapshot.files if file.path==path)
    graph=_Graph(source)
    queries=_query_index(graph,result['query_decoders']['contexts'])
    nodes={node['id']:node for node in result['transport']['nodes']}
    for context in result['contexts']:
        for statement in context['write_statements']:
            for slot in statement['slots']:
                lookups={}
                for declaration in slot['python_declarations']:
                    collection_findings=tuple(declaration['collection_findings'])
                    for node, role in _reachable(declaration['value_ref'],nodes,
                            'prior_declaration' if collection_findings else 'value'):
                        if node['kind']=='lookup':
                            lookups[(node['id'],role,collection_findings)]=node
                declarations=[]
                for (_, consumer_role, collection_findings), node in lookups.items():
                    for mapping, trail in _unfold(node['owner_ref'],nodes):
                        if mapping['kind']!='dictionary_comprehension' or len(mapping['iterators'])!=1:
                            continue
                        keys=_mapping_reads(mapping['key_ref'],nodes,queries)
                        values=_mapping_reads(mapping['value_ref'],nodes,queries)
                        # These are reads made by the key/value expressions,
                        # not verified origins of their results. Keep evaluated
                        # call inputs visible with their distinct read_role;
                        # never relabel them as returned values to pass this gate.
                        if not keys or not values or len({read['producer_context_id'] for read in [*keys,*values]})!=1:
                            continue
                        declarations.append({'lookup_ref':node['id'],'consumer_role':consumer_role,
                                             'mapping_ref':mapping['id'],'input_key_ref':node['key_ref'],
                                             'map_key_reads':keys,'map_value_reads':values,'chain_findings':[*collection_findings,*trail],
                                             'filter_refs':mapping['iterators'][0]['condition_refs'],
                                             'duplicate_keys_verified':False,'key_conversion_verified':False,
                                             'lookup_match_verified':False,'runtime_value_verified':False})
                slot['lookup_values']={'status':'KEY_VALUE_DECLARATIONS_DESCRIBED' if declarations else 'UNRESOLVED_OR_NOT_LOOKUP',
                                       'declarations':declarations}
    # The graph's type summary only reads these reproduced nodes; no resolve/add
    # operations occur after replacing the query-index scratch node list.
    graph.nodes = result['transport']['nodes']
    query_contexts = {context['context_id']: context for context in result['query_decoders']['contexts']}
    for context in result['contexts']:
        for statement in context['write_statements']:
            for slot in statement['slots']:
                _static_slot_values(slot, graph, queries, query_contexts)
    targets = {binding['dataset']['urn']: binding['dataset'] for context in result['contexts']
               for binding in context['bindings']
               if binding['relation_type'] == 'writes' and binding['status'] == 'CATALOG_BOUND'}
    generations = declared_identity_fields(snapshot, targets, tuple(set(scopes_by_context.values())), reader)
    result['output_partition'] = _output_partition(result, generations)
    result['format']='dataflow-discovery.python-lookup-values/1'
    result['limitations'].extend(['Dictionary key/value expression reads are separate; evaluated_argument reads do not prove returned-value influence',
                                  'No unique key, successful lookup or conversion proof',
                                  'Tuple unpack and helper effects remain conditional declarations',
                                  'Only single-iterator dictionary comprehensions with key/value reads in one mapping-result context',
                                  'No supersession of prior unresolved lookup-result runtime flags or authorization for publication'])
    return result

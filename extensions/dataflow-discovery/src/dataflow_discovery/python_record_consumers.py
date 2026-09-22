"""Record/collection declarations to SQL parameter consumers; never approved edges."""
from __future__ import annotations

from .catalog import CatalogBindingError
from .python_bind_values import bind_python_parameter_declarations
from .python_decoders import _references
from .python_query_decoders import bind_python_query_decoders


def _unfold(reference, nodes, trail=(), active=None, budget=None):
    budget = [4096] if budget is None else budget
    budget[0] -= 1
    if budget[0] < 0:
        raise CatalogBindingError('record_consumer_traversal_limit')
    active = set() if active is None else active
    if reference in active or len(active) >= 96:
        return []
    active = active | {reference}
    node = nodes[reference]
    kind = node['kind']
    if kind in {'parameter', 'assignment'}:
        return _unfold(node['argument_ref'] if kind == 'parameter' else node['value_ref'], nodes, trail, active, budget)
    if kind == 'unresolved' and node.get('initial_declaration_ref'):
        return _unfold(node['initial_declaration_ref'], nodes, (*trail, {'node_ref': reference, 'reason': node['reason']}), active, budget)
    if kind == 'call' and node.get('declared_return_ref'):
        # Keep the invocation as well as its return declaration. A query decoder
        # is identified by this exact call site; expanding its body must not
        # erase that identity or substitute the collection in an evaluated arg.
        # For an unguarded single return the existing expression graph already
        # carries each mutation/escape on the returned object. A blanket helper
        # warning must not duplicate (or replace) those source-specific findings.
        # Guarded/finally returns still need their conditional-effect evidence.
        returned_trail = trail if not node.get('declared_return_guards') else (
            *trail, {'node_ref': reference, 'reason': 'helper_return_effects_unverified'})
        return [(node, trail), *_unfold(node['declared_return_ref'], nodes, returned_trail, active, budget)]
    if kind == 'tuple_item':
        result = []
        for sequence, warnings in _unfold(node['sequence_ref'], nodes, trail, active, budget):
            if sequence['kind'] == 'sequence_literal' and sequence['sequence_type'] == 'Tuple' and len(sequence['items']) == node['arity']:
                # Exact literal arity establishes the resource selected by a
                # successful unpack into new locals; it does not prove execution.
                conditional = (node.get('has_incoming_definition', True) and node.get('guards'))
                selected_trail = (*warnings, {'node_ref':reference, 'reason':'tuple_unpack_success_unverified'}) if conditional else warnings
                result.extend(_unfold(sequence['items'][node['index']], nodes, selected_trail, active, budget))
        return result or [(node, trail)]
    if kind == 'attribute':
        result = []
        for owner, warnings in _unfold(node['owner_ref'], nodes, trail, active, budget):
            if owner['kind'] == 'record_construction':
                for field in owner['fields']:
                    if field['name'] == node['attribute']:
                        result.extend(_unfold(field['value_ref'], nodes, warnings, active, budget))
        return result or [(node, trail)]
    if kind in {'conditional_choice', 'boolean_choice'}:
        choices = [node['if_true_ref'],node['if_false_ref']] if kind == 'conditional_choice' else node['operands']
        return [item for choice in choices for item in _unfold(choice, nodes, (*trail, {'node_ref': reference, 'reason': 'branch_selection_unverified'}), active, budget)]
    return [(node, trail)]


def _record_reads(reference, nodes, role='value'):
    pending = [(reference,role)]
    seen, reads, unresolved = set(), [], []
    while pending:
        reference, role = pending.pop()
        if (reference,role) in seen:
            continue
        seen.add((reference,role))
        node = nodes[reference]
        if node['kind'] == 'attribute':
            owners = [(owner, trail) for owner, trail in _unfold(node['owner_ref'],nodes) if owner['kind']=='iteration_element']
            if owners:
                for owner, trail in owners:
                    reads.append({'node_ref':reference,'consumer_role':role,'record_field':node['attribute'],
                                  'iterable_ref':owner['iterable_ref'],'chain_findings':list(trail)})
                continue
        if node['kind'] == 'iteration_element':
            continue  # Do not turn an entire producer object into scalar origins.
        if node['kind'] == 'lookup':
            pending.extend([(node['key_ref'],'lookup_key' if role=='value' else role),
                            (node['owner_ref'],'lookup_values' if role=='value' else role)])
            unresolved.append({'node_ref':reference,'consumer_role':role,'reason':'lookup_result_value_unverified'})
            continue
        if node['kind'] == 'unresolved':
            unresolved.append({'node_ref':reference,'consumer_role':role,'reason':node['reason']})
        pending.extend(_references(node,role))
    return reads, unresolved


def bind_python_record_consumers(analysis, snapshot, *, path, entrypoint, scopes_by_context, reader):
    """Match producer invocation + record field, never a process/name-only join.

    Guarded initial declarations and unknown helper/collection effects remain
    explicit. Lookup-key dependencies are not lookup-result value lineage.
    """
    parameters = bind_python_parameter_declarations(analysis,snapshot,path=path,entrypoint=entrypoint,
                                                     scopes_by_context=scopes_by_context,reader=reader)
    queries = bind_python_query_decoders(analysis,snapshot,path=path,entrypoint=entrypoint,
                                        scopes_by_context=scopes_by_context,reader=reader)
    if parameters['trace_sha256'] != queries['trace_sha256']:
        raise CatalogBindingError('record_consumer_trace_mismatch')
    producers = {}
    for context in queries['contexts']:
        decoder = context['query_decoder']
        if decoder['status'] != 'DECLARATION_LINKS_DESCRIBED':
            continue
        key = (tuple(context['use']['call_path'][:-1]),decoder['consumer_line'],decoder['consumer_column'],decoder['decoder'])
        producers.setdefault(key,[]).append(context)
    nodes = {node['id']:node for node in parameters['transport']['nodes']}
    for context in parameters['contexts']:
        for statement in context['write_statements']:
            for slot in statement['slots']:
                links, gaps = [], []
                for declaration in slot['python_declarations']:
                    collection_findings = declaration['collection_findings']
                    reads, unresolved = _record_reads(declaration['value_ref'],nodes,
                        'prior_declaration' if collection_findings else 'value')
                    gaps.extend(unresolved)
                    for read in reads:
                        matched = False
                        for producer, warnings in _unfold(read['iterable_ref'],nodes):
                            if producer['kind'] != 'call' or not producer.get('caller_path'):
                                continue
                            callee = nodes[producer['callee_ref']]
                            if callee['kind'] != 'function_syntax':
                                continue
                            key = (tuple(producer['caller_path']),producer['line'],producer['column'],callee['name'])
                            candidates = producers.get(key,[])
                            if len(candidates) != 1:
                                continue
                            upstream = candidates[0]
                            for origin in upstream['query_decoder']['links']:
                                if origin['record_field'] != read['record_field']:
                                    continue
                                matched = True
                                links.append({'parameter_name':declaration['parameter_name'],
                                              'consumer_ref':read['node_ref'],'consumer_role':read['consumer_role'],
                                              'producer_context_id':upstream['context_id'],'producer_call_ref':producer['id'],
                                              'record_field':read['record_field'],'decoder_read_role':origin['role'],
                                              'result_label':origin['result_label'],'origins':origin['origins'],
                                              'chain_findings':[*collection_findings,*read['chain_findings'],*warnings],
                                              'runtime_value_verified':False})
                        if not matched:
                            gaps.append({'node_ref':read['node_ref'],'consumer_role':read['consumer_role'],
                                         'reason':'record_producer_invocation_unresolved'})
                slot['record_consumer']={'status':'DECLARATION_DEPENDENCIES_FOUND' if links else 'UNRESOLVED',
                                         'links':links,'unresolved':gaps,'runtime_value_verified':False}
    parameters['format']='dataflow-discovery.python-record-consumers/1'
    parameters['query_decoders']=queries
    parameters['status']='INCONCLUSIVE'
    parameters['limitations'].extend(['Matched declarations may cross guarded initializations or unverified helper/collection effects',
                                      'Lookup-key and condition dependencies must not be published as lookup-result value origins',
                                      'Producer identity includes full invocation path, not just function/process/field names',
                                      'No complete successful-path, mutable-object or runtime-value proof; no publication authorization'])
    return parameters

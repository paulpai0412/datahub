"""Source-declared SQL phases in one selected Python entrypoint.

A phase is an outermost local call containing Catalog-bound SQL, not every
helper/function. This describes conditional source structure, never execution,
scheduler order, arbitrary Python effects or publication authority.
"""
from __future__ import annotations

import ast
from collections import defaultdict

from .catalog import CatalogBindingError, _digest


def _compatible_guards(left, right):
    choices = {(guard['kind'], guard['line']): guard.get('branch')
               for guard in left if guard['kind'] == 'if'}
    return all((guard['kind'], guard['line']) not in choices
               or choices[(guard['kind'], guard['line'])] == guard.get('branch')
               for guard in right if guard['kind'] == 'if')


def describe_python_jobs(analysis, snapshot, report):
    """Consume the freshly reproduced binder report within the trusted analyzer.

    Stable source identities exclude line numbers/snapshot hashes. Proofs retain
    both. No supplied native URN, graph, Job label or dependency is accepted.
    """
    if (analysis.source_id != report['source_id'] or snapshot.sha256 != report['snapshot_sha256']
            or analysis.digest != report['candidate_digest']):
        raise CatalogBindingError('job_analysis_source_mismatch')
    source = next(file for file in snapshot.files if file.path == report['path'])
    tree = ast.parse(source.text)
    definitions = {}
    for node in tree.body:
        if isinstance(node, ast.FunctionDef):
            if node.name in definitions:
                raise CatalogBindingError('job_function_identity_ambiguous')
            definitions[node.name] = node
    entry = definitions[report['entrypoint']]
    candidates = {dict(item.attributes).get('name'): item for item in analysis.candidates
                  if item.method == 'python_ast_function' and len(item.evidence) == 1
                  and item.evidence[0].path == source.path}
    identity = {'sourceId': analysis.source_id, 'path': source.path, 'entrypoint': entry.name}
    evidence = lambda node: {'path': source.path, 'line': node.lineno, 'endLine': node.end_lineno,
                             'fileSha256': source.sha256}
    jobs, owners, occurrences, controls = {}, {}, {}, []
    gaps = [{'reason': 'job_sql_trace_unresolved', 'traceFinding': finding} for finding in report['trace_findings']]
    contexts = {context['context_id']: context for context in report['contexts']}
    data_paths = [context['use']['call_path'] for context in contexts.values()
                  if context['status'] == 'CATALOG_BOUND']
    # CLI wrappers must not collapse all underlying phases into one Job.
    # Peel only a common invocation prefix shared by every data-bearing path;
    # a direct SQL operation at that depth owns the remaining phase boundary.
    phase_depth = 1
    while (data_paths and all(len(path) > phase_depth + 1 for path in data_paths)
           and len({path[phase_depth] for path in data_paths}) == 1):
        phase_depth += 1
    for cid, context in contexts.items():
        use = context['use']
        if context['status'] == 'NO_DATASET_DEPENDENCIES':
            controls.append({'contextId': cid, 'callPath': use['call_path'], 'guards': use['guards'],
                             'statementKinds': context['statement_kinds']})
            continue
        if context['status'] != 'CATALOG_BOUND' or any(item['status'] != 'CATALOG_BOUND' for item in context['bindings']):
            gaps.append({'reason': 'job_catalog_context_unresolved', 'contextId': cid})
            continue
        steps = use['call_path']
        if len(steps) <= phase_depth or steps[0] != f'entry:{entry.name}:{entry.lineno}':
            gaps.append({'reason': 'job_phase_boundary_unresolved', 'contextId': cid})
            continue
        position, name = steps[phase_depth].split('->', 1)
        line, column = map(int, position.split(':'))
        definition = definitions.get(name)
        candidate = candidates.get(name)
        if definition is None or candidate is None or candidate.evidence[0].start_line != definition.lineno:
            gaps.append({'reason': 'job_phase_definition_unresolved', 'contextId': cid})
            continue
        identifier = 'python-step:' + _digest({**identity, 'function': name})
        job = jobs.setdefault(identifier, {'id': identifier, 'name': name, 'candidateId': candidate.candidate_id,
            'evidence': evidence(definition), 'boundaryMethod': 'entrypoint_local_sql_phase', 'callDepth': phase_depth,
            'contexts': [], 'invocations': {}, 'reads': defaultdict(set), 'writes': defaultdict(set)})
        job['contexts'].append(cid)
        job['invocations'][(line, column)] = {'line': line, 'column': column}
        owners[cid] = identifier
        occurrences[cid] = (line, column)
        for binding in context['bindings']:
            relation = binding['relation_type']
            if relation not in ('reads', 'writes'):
                gaps.append({'reason': 'job_relation_unsupported', 'contextId': cid})
                continue
            job[relation][binding['dataset']['urn']].add(cid)
    dependencies = defaultdict(set)
    # Reuse the binder's source-reproduced record and lookup transport links.
    # Evaluated arguments establish resource use, not returned-value lineage.
    roles = {'value', 'condition', 'lookup_key', 'lookup_values', 'evaluated_argument', 'evaluated_callee'}
    for cid, context in contexts.items():
        if cid not in owners:
            continue
        consumer = owners[cid]
        producers = set()
        for statement in context['write_statements']:
            for slot in statement['slots']:
                for link in slot['record_consumer']['links']:
                    if not link['chain_findings'] and link['consumer_role'] in roles and link['decoder_read_role'] in roles:
                        producers.add((link['producer_context_id'], 'record_transfer'))
                for lookup in slot['lookup_values']['declarations']:
                    reads = [*lookup['map_key_reads'], *lookup['map_value_reads']]
                    if (not lookup['chain_findings'] and reads and lookup['consumer_role'] in roles
                            and all(not read['chain_findings'] and read['read_role'] in roles for read in reads)):
                        producers.update((read['producer_context_id'], 'lookup_transfer') for read in reads)
        for producer_id, method in producers:
            if producer_id not in owners:
                gaps.append({'reason': 'job_producer_not_owned', 'contextId': producer_id})
                continue
            for binding in contexts[producer_id]['bindings']:
                if binding['relation_type'] == 'reads':
                    jobs[consumer]['reads'][binding['dataset']['urn']].add(producer_id)
            if owners[producer_id] != consumer:
                dependencies[(owners[producer_id], consumer, method)].add((producer_id, cid))
    # Dataset-level possible read-after-write dependencies retain both concrete
    # SQL occurrences and compatible source guards. Never infer runtime success,
    # field values or data-subset overlap from this coarse relationship.
    writes = defaultdict(list)
    for cid, owner in owners.items():
        for binding in contexts[cid]['bindings']:
            if binding['relation_type'] == 'writes':
                writes[binding['dataset']['urn']].append(cid)
    for cid, owner in owners.items():
        for binding in contexts[cid]['bindings']:
            if binding['relation_type'] != 'reads':
                continue
            for producer_id in writes[binding['dataset']['urn']]:
                if (owners[producer_id] != owner and occurrences[producer_id] < occurrences[cid]
                        and _compatible_guards(contexts[producer_id]['use']['guards'], contexts[cid]['use']['guards'])):
                    dependencies[(owners[producer_id], owner, 'possible_dataset_read_after_write')].add((producer_id, cid))
    result_jobs = []
    for job in jobs.values():
        result_jobs.append({**job, 'invocations': list(job['invocations'].values()),
                           **{relation: [{'urn': urn, 'contextIds': sorted(ids)} for urn, ids in sorted(job[relation].items())]
                              for relation in ('reads', 'writes')}})
    return {'format': 'datahub-etl.python-jobs/1',
        'flow': {'id': 'python-flow:' + _digest(identity), 'name': entry.name,
                 'candidateId': candidates[entry.name].candidate_id, 'evidence': evidence(entry)},
        'jobs': result_jobs, 'controls': controls,
        'dependencies': [{'from': start, 'to': end, 'method': method,
                          'contextPairs': [list(pair) for pair in sorted(pairs)]}
                         for (start, end, method), pairs in sorted(dependencies.items())],
        'coverage': {'contexts': len(contexts), 'ownedContexts': len(owners), 'controlContexts': len(controls),
                     'sqlOwnershipComplete': len(owners) + len(controls) == len(contexts) and not gaps},
        'blockers': gaps, 'allPythonEffectsVerified': False, 'executionVerified': False, 'publicationAuthorized': False}

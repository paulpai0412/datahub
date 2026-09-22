"""Composer workspace analysis using the existing source/Catalog analyzers.

No repository imports, execution, publication or persistent state. A declaration
preview is deliberately not a publishable lineage plan.
"""
from __future__ import annotations

import ast
from collections import Counter
from typing import Any

from .catalog import CatalogBindingError, MssqlScope, _digest
from .host import capture_workspace_and_analyze
from .sql_views import bind_declared_views
from .grafana_schema import describe_dashboard_queries, scopes_from_native_query_catalog, bind_native_dashboard_queries
from .python_bind_values import _Graph
from .python_catalog import describe_python_connections, scopes_for_python_connections
from .python_lookup_values import bind_python_lookup_values
from .python_jobs import describe_python_jobs
from .publisher import compile_workspace_lineage
from .python_sql import analyze_sql_execution
from .validator import validate_analysis


def _entries(snapshot, selection):
    entries = []
    selected_file = next((file for file in snapshot.files if file.path == selection), None)
    files = [selected_file] if selected_file is not None else snapshot.files
    for source in files:
        if not source.path.endswith('.py'):
            continue
        try:
            graph = _Graph(source)
        except SyntaxError:
            continue  # The source validator's unresolved candidate remains in the preview.
        called = {node.func.id for function in graph.functions.values()
                  for node in graph.local_nodes(function)
                  if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)}
        for name, function in graph.functions.items():
            if name in called:
                continue
            trace = analyze_sql_execution(source, entrypoint=name)
            if trace['uses']:
                entries.append({'path': source.path, 'name': name, 'line': function.lineno})
            if len(entries) > 128:
                raise ValueError('workspace_entrypoint_limit')
    return entries


def _source_gaps(analysis):
    groups = {}
    for candidate in analysis.candidates:
        if candidate.kind != 'unresolved':
            continue
        # File hashes are already bound by the root manifest; retain every
        # candidate/location without repeating the same digest in every group.
        files = [{'path': item.path} for item in candidate.evidence]
        key = _digest({'method': candidate.method, 'attributes': dict(candidate.attributes), 'files': files})
        group = groups.setdefault(key, {'method': candidate.method, 'attributes': dict(candidate.attributes),
                                       'files': files, 'candidates': []})
        group['candidates'].append({'id': candidate.candidate_id,
            'locations': [{'file': index, 'line': item.start_line, 'endLine': item.end_line}
                          for index, item in enumerate(candidate.evidence)]})
    return list(groups.values())


def _source_coverage(analysis, report):
    """Reconcile broad scanner notices against the selected SQL-use evidence.

    Provisioning scripts and other entrypoints are not silently 'resolved'. They
    remain visible as outside this execution trace; related view/BI declarations
    require their own binder below. Unknown selected SQL remains blocking.
    """
    statements = {}
    for context in report['contexts']:
        for statement in context['write_statements']:
            statements.setdefault(statement['process'], []).append(statement)
    rows = []
    for candidate in analysis.candidates:
        if candidate.kind != 'unresolved':
            continue
        selected_file = any(item.path == report['path'] for item in candidate.evidence)
        process = candidate.subject.replace('unresolved:sql-mapping:', 'process:sql:', 1)
        matched = statements.get(process, [])
        if (candidate.method == 'sql_mapping_scan' and matched
                and all(item['status'] == 'WRITE_PARAMETER_TARGETS_DESCRIBED'
                        and all(slot['static_value_dependencies'] and all(value['status'] == 'STATIC_VALUE_DEPENDENCIES'
                                for value in slot['static_value_dependencies']) for slot in item['slots'])
                        for item in matched)):
            disposition = 'BOUND_SELECTED_WRITE'
        elif not selected_file:
            disposition = 'OUTSIDE_SELECTED_PYTHON_ENTRYPOINT'
        else:
            disposition = 'UNRESOLVED_SELECTED_SOURCE'
        rows.append({'candidateId': candidate.candidate_id, 'disposition': disposition})
    return {'scope': 'selected_python_entrypoint_sql_io', 'items': rows,
            'counts': dict(Counter(row['disposition'] for row in rows)),
            'complete': not report['trace_findings'] and all(context['status'] in {'CATALOG_BOUND', 'NO_DATASET_DEPENDENCIES'}
                for context in report['contexts']) and all(row['disposition'] != 'UNRESOLVED_SELECTED_SOURCE' for row in rows),
            'otherEntryPointsAndProvisioningExecuted': False}


def _catalog_graph(report, catalog, path, snapshot):
    nodes, edges, targets, generations = {}, {}, {}, {}
    slots = 0
    gaps = Counter()
    queries = {item['context_id']: item for item in report['query_decoders']['contexts']}
    for context in report['contexts']:
        cid = context['context_id']
        sql = context['use'].get('sql', {})
        line = sql.get('line', context['use']['line'])
        # The enclosing result carries the single snapshot binding for all
        # points; repeating 64 bytes on every node/edge exhausts the bridge cap.
        evidence = {'path': path, 'line': line}
        nodes[cid] = {'id': cid, 'kind': 'sql', 'label': f'{path.rsplit("/", 1)[-1]}:{line}',
                      'status': context['status'], 'evidence': evidence, 'fields': [],
                      'conditions': [{'kind': clause['kind'], 'expressionSha256': clause['expression_sha256'],
                                      'sources': [{'urn': origin['dataset_urn'], 'field': origin['field_path']}
                                                  for origin in clause['origins']],
                                      'parameters': clause['parameter_names'], 'predicateSemanticsVerified': False}
                                     for projection in [*queries[cid]['projections'], *context['write_statements']]
                                     for clause in projection.get('conditions', [])],
                      'rowEffects': [statement['row_effect'] for statement in context['write_statements']
                                     if 'row_effect' in statement]}
        for optional in ('rowEffects', 'conditions'):
            if not nodes[cid][optional]:
                del nodes[cid][optional]
        if context['status'] not in {'CATALOG_BOUND', 'NO_DATASET_DEPENDENCIES'}:
            gaps[context.get('reason', 'catalog_binding_incomplete')] += 1
        for binding in context['bindings']:
            if binding['status'] != 'CATALOG_BOUND':
                gaps[binding.get('reason', 'dataset_binding_incomplete')] += 1
                continue
            urn = binding['dataset']['urn']
            native = catalog[urn]
            fields = [{'name': field['fieldPath'], 'type': field['nativeDataType']}
                      for field in native['schemaMetadata']['value']['fields']]
            nodes[urn] = {'id': urn, 'kind': 'dataset', 'urn': urn,
                          'label': native['datasetKey']['value']['name'],
                          'status': 'CATALOG_BOUND', 'fields': fields,
                          'schemaVersion': native['schemaMetadata']['version']}
            relation = binding['relation_type']
            if relation not in {'reads', 'writes'}:
                gaps['unsupported_relation_kind'] += 1
                continue
            start, end = (urn, cid) if relation == 'reads' else (cid, urn)
            edges[(start, end, relation)] = {'from': start, 'to': end,
                                           'kind': relation, 'evidence': evidence}
            if relation == 'writes':
                targets[urn] = {field['name'] for field in fields}
        for statement in context['write_statements']:
            slots += len(statement['slots'])
            if statement['status'] not in {'WRITE_PARAMETER_TARGETS_DESCRIBED', 'NOT_SUPPORTED_WRITE_STATEMENT'}:
                gaps[statement['status']] += 1
    partition = report['output_partition']
    if not partition['denominator_established']:
        gaps['output_denominator_unestablished'] += 1
    if partition['unresolved_fields']:
        gaps['output_origins_unresolved'] += partition['unresolved_fields']
    for blocker in partition['blockers']:
        gaps[blocker['reason']] += 1
    for output in partition['fields']:
        dataset = nodes.get(output['dataset_urn'])
        if dataset is None:
            gaps['output_dataset_missing'] += 1
            continue
        field = next((item for item in dataset['fields'] if item['name'] == output['field_path']), None)
        if field is None:
            gaps['output_field_missing'] += 1
            continue
        generation_refs = set()
        for value in output['generated']:
            # A graph node ref is not an algorithm identity. Preserve the actual
            # source/parameter/loop facts once instead of repeating them per use.
            fact = {key: item for key, item in value.items() if key not in {'node_ref', 'role'}}
            identifier = 'generation:' + _digest(fact)
            generations[identifier] = fact
            generation_refs.add(identifier)
        field['origin'] = {'classification': output['classification'],
            'sources': [{'urn': item['dataset_urn'], 'field': item['field_path']} for item in output['origins']],
            'conditionSources': [{'urn': item['dataset_urn'], 'field': item['field_path']} for item in output['condition_origins']],
            'generationRefs': sorted(generation_refs),
            'operations': sorted({operation['operation'] for declaration in output['declarations']
                                  for value in declaration['values'] for operation in value['transformations']})}
        if output.get('reason'):
            field['origin']['reason'] = output['reason']
    # Field classification alone does not establish logical Jobs or authorize
    # import. Keep the existing global completion/publication gate closed.
    gaps['dataflow_job_publication_plan_not_compiled'] += 1
    for finding in report['trace_findings']:
        gaps[finding['reason']] += 1
    # References are local to this immutable preview. Native IDs and schemas
    # remain on dataset nodes; repeated long URNs are not separate evidence.
    node_list = list(nodes.values())
    dataset_indexes = {node['id']: index for index, node in enumerate(node_list) if node['kind'] == 'dataset'}
    for node in node_list:
        references = [clause['sources'] for clause in node.get('conditions', [])]
        for field in node['fields']:
            if 'origin' in field:
                references.extend([field['origin']['sources'], field['origin']['conditionSources']])
        for items in references:
            for item in items:
                item['dataset'] = dataset_indexes[item.pop('urn')]
    condition_sets, condition_indexes = [], {}
    for node in node_list:
        for field in node['fields']:
            if 'origin' not in field:
                continue
            values = field['origin'].pop('conditionSources')
            key = _digest(values)
            if key not in condition_indexes:
                condition_indexes[key] = len(condition_sets)
                condition_sets.append(values)
            field['origin']['conditionSet'] = condition_indexes[key]
    # SQL steps have no Catalog schema. Omit only their empty wire arrays;
    # internal field-reference normalization above keeps its canonical shape.
    for node in node_list:
        if node['kind'] == 'sql':
            del node['fields']
    indexes = {node['id']: index for index, node in enumerate(node_list)}
    edge_list = [{**edge, 'from': indexes[edge['from']], 'to': indexes[edge['to']]} for edge in edges.values()]
    return {
        'nodes': node_list, 'edges': edge_list, 'generations': generations, 'conditionSets': condition_sets,
        'coverage': {'sqlContexts': len(report['contexts']), 'writeSlots': slots,
                     'observedTargetSchemaFields': sum(len(fields) for fields in targets.values()),
                     'outputDenominatorEstablished': partition['denominator_established'],
                     'expectedOutputFields': partition['expected_fields'],
                     'classifiedOutputFields': partition['classified_fields'],
                     'unresolvedOutputFields': partition['unresolved_fields'],
                     'fieldPartitionComplete': partition['complete'], 'runtimeValuesVerified': False},
        'blockers': [{'reason': reason, 'count': count} for reason, count in sorted(gaps.items())],
    }


def _workflow_preview(workflow, graph, compiled):
    indexes = {node['id']: index for index, node in enumerate(graph['nodes'])}
    jobs = {job['id']: index for index, job in enumerate(workflow['jobs'])}
    point = lambda item: {'path': item['path'], 'line': item['line']}
    return {'flow': {'name': workflow['flow']['name'], 'evidence': point(workflow['flow']['evidence']),
                     'urn': compiled['flowUrn'] if compiled else None},
            'jobs': [{'name': job['name'], 'evidence': point(job['evidence']),
                      'urn': compiled['jobUrns'][job['id']] if compiled else None,
                      'contexts': [indexes[cid] for cid in job['contexts']],
                      'reads': [indexes[item['urn']] for item in job['reads']],
                      'writes': [indexes[item['urn']] for item in job['writes']]}
                     for job in workflow['jobs']],
            'dependencies': [{'from': jobs[item['from']], 'to': jobs[item['to']], 'method': item['method'],
                              'contextPairs': [[indexes[a], indexes[b]] for a, b in item['contextPairs']]}
                             for item in workflow['dependencies']],
            'controlContexts': [indexes[item['contextId']] for item in workflow['controls']],
            'coverage': workflow['coverage'], 'blockers': workflow['blockers']}


def analyze_workspace(policy: dict[str, Any], request: dict[str, Any], catalog=None, *, compile_native=False, related_catalog=None) -> dict[str, Any]:
    """Host policy authorizes the root; requests can only select within it."""
    # pi-lens-ignore: no-identity-operator-on-literals
    if (policy.get('workspace') is not True or policy.get('modelContextApproved') is not True
            or set(policy) != {'sourceId', 'root', 'workspace', 'modelContextApproved', 'catalogScopes'}):
        raise ValueError('workspace_policy_rejected')
    receipt, manifest = capture_workspace_and_analyze(policy['root'], request['selection'], source_id=policy['sourceId'])
    if request.get('snapshotSha256') is not None and request['snapshotSha256'] != receipt.snapshot.sha256:
        raise ValueError('workspace_source_drift')
    validation = validate_analysis(receipt.analysis, receipt.snapshot)
    if validation.findings:
        raise ValueError('workspace_analysis_not_source_bound')
    entries = _entries(receipt.snapshot, manifest['selection'])
    path, entrypoint = request.get('pythonPath'), request.get('entrypoint')
    if path is None and entrypoint is None and len(entries) == 1:
        path, entrypoint = entries[0]['path'], entries[0]['name']
    result = {
        'format': 'datahub-etl.preview/3', 'sourceId': policy['sourceId'],
        'snapshotSha256': receipt.snapshot.sha256, 'manifest': manifest,
        'stage': 'ENTRYPOINT_SELECTION', 'entrypoints': entries,
        'entrypoint': None, 'connections': [],
        'scopeChoices': [{'id': identifier, 'database': scope['database'], 'env': scope['env']}
                         for identifier, scope in policy['catalogScopes'].items()],
        'sourceCandidateCount': len(receipt.analysis.candidates),
        'sourceUnresolvedCount': len(validation.unresolved_candidate_ids),
        'sourceGaps': _source_gaps(receipt.analysis),
        'relatedCatalogRequests': describe_dashboard_queries(receipt.snapshot, {}, None)['catalogRequests'],
        'graph': {'nodes': [], 'edges': []},
        'coverage': {'outputDenominatorEstablished': False},
        'blockers': [{'reason': 'entrypoint_selection_required', 'count': 1}],
        'complete': False, 'publicationAuthorized': False,
    }
    if path is not None or entrypoint is not None:
        if not isinstance(path, str) or not isinstance(entrypoint, str):
            raise ValueError('workspace_entrypoint_rejected')
        description = describe_python_connections(receipt.analysis, receipt.snapshot, path=path, entrypoint=entrypoint)
        result.update(stage='CONNECTION_SELECTION', entrypoint={'path': path, 'name': entrypoint},
                      connections=description['connections'],
                      blockers=[{'reason': 'connection_selection_required', 'count': len(description['connections'])},
                                *description['unresolved'], *description['trace_findings']])
        choices = request.get('connections')
        if choices is not None:
            if not isinstance(choices, dict) or any(value not in policy['catalogScopes'] for value in choices.values()):
                raise ValueError('workspace_scope_rejected')
            scopes = {identifier: MssqlScope(**{**policy['catalogScopes'][scope_id],
                      'allowed_dataset_urns': tuple(policy['catalogScopes'][scope_id]['allowed_dataset_urns'])})
                      for identifier, scope_id in choices.items()}
            expanded = scopes_for_python_connections(receipt.analysis, receipt.snapshot, path=path,
                                                     entrypoint=entrypoint, scopes_by_connection=scopes)
            allowed = {urn for scope in scopes.values() for urn in scope.allowed_dataset_urns}
            if not isinstance(catalog, dict) or set(catalog) != allowed:
                raise CatalogBindingError('workspace_catalog_rejected')

            class Reader:
                def get_aspect(self, urn, aspect_type):
                    return aspect_type.from_obj(catalog[urn][aspect_type.ASPECT_NAME]['value'])

            report = bind_python_lookup_values(receipt.analysis, receipt.snapshot, path=path,
                        entrypoint=entrypoint, scopes_by_context=expanded, reader=Reader())
            source_coverage = _source_coverage(receipt.analysis, report)
            views = bind_declared_views(receipt.snapshot, scopes.values(), Reader())
            bi_scopes, _ = scopes_from_native_query_catalog(related_catalog or [], scopes.values())
            bi = describe_dashboard_queries(receipt.snapshot, bi_scopes, Reader())
            native_bi = bind_native_dashboard_queries(bi, related_catalog or [])
            related_blockers = [*views['blockers'], *bi['blockers'], *native_bi['blockers']]
            report.update(declared_views=views, dashboard_queries=bi, native_dashboard_queries=native_bi)
            workflow = describe_python_jobs(receipt.analysis, receipt.snapshot, report)
            environments = {scope.env for scope in scopes.values()}
            compiled = None
            if not related_blockers and source_coverage['complete'] and report['output_partition']['complete'] and workflow['coverage']['sqlOwnershipComplete'] and len(environments) == 1:
                compiled = compile_workspace_lineage(receipt.analysis, receipt.snapshot, report, workflow, env=next(iter(environments)))
            if compile_native:
                if compiled is None:
                    raise ValueError('workspace_lineage_incomplete')
                return {**compiled, 'catalogDigest': _digest(catalog), 'relatedCatalogDigest': _digest(related_catalog), 'sourceCoverage': source_coverage,
                        'sourceUnresolvedCount': len(validation.unresolved_candidate_ids),
                        'complete': False, 'remainingGate': 'source_coverage_native_merge_and_trusted_consent'}
            graph = _catalog_graph(report, catalog, path, receipt.snapshot)
            if compiled is not None:
                graph['blockers'] = [item for item in graph['blockers'] if item['reason'] != 'dataflow_job_publication_plan_not_compiled']
                graph['blockers'].append({'reason': 'native_merge_and_trusted_consent_required', 'count': 1})
            result.update(stage='FIELD_ANALYSIS', graph={name: graph[name] for name in ('nodes', 'edges', 'generations', 'conditionSets')}, 
                          workflow=_workflow_preview(workflow, graph, compiled),
                          sourceCoverage={key: value for key, value in source_coverage.items() if key != 'items'},
                          relatedCoverage={'views': len(views['views']), 'viewFields': sum(len(v['outputs']) for v in views['views']),
                              'biQueries': len(bi['queries']), 'biFields': sum(len(q['outputs']) for q in bi['queries']),
                              'nativePanels': len(native_bi['bindings']), 'complete': not related_blockers,
                              'liveGrafanaVerified': False, 'ddlAppliedVerified': False},
                          relatedCatalogDigest=_digest(related_catalog),
                          nativePlan={'compiled': compiled is not None, 'aspectCount': len(compiled['aspects']) if compiled else 0,
                                      'nativeMergeRequired': True, 'publicationAuthorized': False},
                          coverage=graph['coverage'], blockers=[*graph['blockers'], *workflow['blockers'], *related_blockers], catalogDigest=_digest(catalog))
            # The descriptor is only for the Host's initial native identity read.
            # Full analysis carries verified coverage, not duplicated requests.
            del result['relatedCatalogRequests']
    elif request.get('connections') is not None:
        raise ValueError('workspace_entrypoint_rejected')
    if compile_native:
        raise ValueError('workspace_lineage_incomplete')
    if result.get('sourceCoverage', {}).get('complete') is not True and result['sourceUnresolvedCount']:
        result['blockers'].append({'reason': 'source_scope_coverage_requires_reconciliation',
                                   'count': result['sourceUnresolvedCount']})
    result['candidateDigest'] = _digest(result)
    return result

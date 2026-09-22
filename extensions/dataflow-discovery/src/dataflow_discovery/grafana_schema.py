"""Pinned Grafana ingestion-artifact adapter, not a publisher or a new parser.

The Host supplies its captured dashboard, datasource scopes and ACL-bound reader.
Only official SDK Model/Aspect objects and Graph.parse_sql_lineage are used. This
prepares a complete in-memory batch; it never writes Catalog metadata. Do not put
it behind a streaming REST sink or treat its output as publication approval.

Supported: SDK 1.7.0.9 / SQLGlot 30.12.0, MSSQL, explicit single-SELECT projections, one SQL target
per panel, no panel transformations or platform instances. SQL types/nullability
remain the connector's inferences, not runtime guarantees. Existing Host snapshot,
ACL, typed approvals, owned-aspect/CAS and readback gates are still required.
"""
from __future__ import annotations

import copy
import hashlib
import json
import re
from importlib.metadata import version
from typing import Iterable

import sqlglot
from sqlglot import expressions as exp
from sqlglot.errors import SqlglotError
from sqlglot.optimizer.scope import traverse_scope
from sqlglot.tokenizer_core import TokenType
from datahub.emitter.mce_builder import make_chart_urn, make_schema_field_urn
from datahub.emitter.mcp import MetadataChangeProposalWrapper
from datahub.ingestion.graph.client import DataHubGraph
from datahub.ingestion.api.common import EndOfStream, PipelineContext, RecordEnvelope
from datahub.ingestion.api.transform import Transformer
from datahub.metadata.schema_classes import (
    ChartInfoClass, InputFieldClass, InputFieldsClass, SchemaMetadataClass,
    UpstreamLineageClass, ViewPropertiesClass,
)
from datahub.metadata.urns import DatasetUrn

from .catalog import CatalogBindingError, MssqlScope, _digest, resolve_dataset
from .python_projection import _projection_origins


SUPPORTED_SDK = "1.7.0.9"
SUPPORTED_SQLGLOT = "30.12.0"


def parameterize_declared_query(sql: str, variables: set[str]):
    """Represent supported Grafana MSSQL templates with symbolic parameters.

    Documented $__timeFilter is a UTC BETWEEN; :sqlstring denotes a quoted
    scalar/list input. No TRUE/1 substitution, sample time/value or execution.
    Token spans avoid modifying SQL literals/comments. Unsupported macros fail.
    Contract: grafana.com/docs/grafana/latest/datasources/mssql/query-editor/
    and /dashboards/variables/variable-syntax/#sqlstring (reviewed 2026-09-22).
    """
    tokens = sqlglot.Dialect.get_or_raise('tsql').tokenize(sql)
    if any(token.text.startswith('dh_grafana_') for token in tokens):
        raise CatalogBindingError('grafana_symbolic_parameter_collision')
    replacements, declarations = [], []
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if token.token_type in {TokenType.STRING, TokenType.IDENTIFIER}:
            if re.search(r'\$(?:\{|__[A-Za-z]|[A-Za-z_])', token.text):
                raise CatalogBindingError('grafana_quoted_template_unsupported')
            index += 1
            continue
        if token.text == '$__timeFilter':
            if index + 1 >= len(tokens) or tokens[index + 1].text != '(':
                raise CatalogBindingError('grafana_time_filter_shape')
            end = index + 2
            depth = 1
            while end < len(tokens):
                depth += (tokens[end].text == '(') - (tokens[end].text == ')')
                if depth == 0:
                    break
                end += 1
            if end == len(tokens):
                raise CatalogBindingError('grafana_time_filter_shape')
            argument = sql[tokens[index + 1].end + 1:tokens[end].start]
            column = sqlglot.parse_one(argument, read='tsql')
            if not isinstance(column, exp.Column) or column.is_star:
                raise CatalogBindingError('grafana_time_filter_column_required')
            replacements.append((token.start, tokens[end].end + 1,
                f'({argument} BETWEEN :dh_grafana_time_from AND :dh_grafana_time_to)'))
            declarations.append({'method': 'grafana_mssql_time_filter', 'timezone': 'UTC',
                'startOffset': token.start, 'endOffset': tokens[end].end + 1,
                'parameters': ['dh_grafana_time_from', 'dh_grafana_time_to'], 'runtimeValuesVerified': False})
            index = end + 1
            continue
        if token.text == '$':
            group = tokens[index:index + 6]
            if (len(group) != 6 or [group[i].text for i in (1, 3, 4, 5)] != ['{', ':', 'sqlstring', '}']
                    or not group[2].text.isidentifier() or group[2].text not in variables):
                raise CatalogBindingError('grafana_variable_declaration_required')
            name = group[2].text
            parameter = 'dh_grafana_var_' + name
            replacements.append((token.start, group[-1].end + 1, ':' + parameter))
            declarations.append({'method': 'grafana_sqlstring_variable', 'name': name, 'parameter': parameter,
                'startOffset': token.start, 'endOffset': group[-1].end + 1,
                'cardinality': 'runtime_list', 'runtimeValuesVerified': False})
            index += 6
            continue
        if token.text.startswith('$'):
            raise CatalogBindingError('grafana_macro_unsupported')
        index += 1
    normalized = sql
    for start, end, replacement in reversed(replacements):
        normalized = normalized[:start] + replacement + normalized[end:]
    statements = [item for item in sqlglot.parse(normalized, read='tsql') if item is not None]
    if len(statements) != 1 or not isinstance(statements[0], exp.Select) or statements[0].args.get('into'):
        raise CatalogBindingError('grafana_declaration_single_select_required')
    statement = statements[0]
    for parameter in statement.find_all(exp.Placeholder):
        if parameter.name.startswith('dh_grafana_var_'):
            parent = parameter.parent
            if not isinstance(parent, exp.In) or parent.expressions != [parameter]:
                raise CatalogBindingError('grafana_sqlstring_context_unsupported')
    return statement, declarations


def scopes_from_native_query_catalog(native_items, scopes: Iterable[MssqlScope]):
    """Resolve datasource identifiers through observed official connector metadata.

    Native observations and scopes must come from the authenticated Host reader.
    A name/database resemblance alone is not a binding. This proves a Catalog
    association, not an endpoint, credential, live Grafana query or adoption grant.
    """
    upstreams, observations = {}, {}
    for item in native_items:
        if not item.get('urn', '').startswith('urn:li:dataset:(urn:li:dataPlatform:grafana,'):
            continue
        properties = item.get('datasetProperties', {}).get('value', {}).get('customProperties', {})
        uid = properties.get('datasource_uid')
        if properties.get('type') != 'mssql' or not isinstance(uid, str) or not uid:
            continue
        status = item.get('status', {}).get('value', {})
        lineage_value = item.get('upstreamLineage', {}).get('value', {})
        edges = lineage_value.get('upstreams')
        # pi-lens-ignore: no-identity-operator-on-literals -- Require the exact False singleton, not 0 or missing.
        if status.get('removed') is not False or not isinstance(edges, list) or not edges:
            raise CatalogBindingError('grafana_native_catalog_binding_incomplete')
        for edge in edges:
            if not isinstance(edge, dict) or not isinstance(edge.get('dataset'), str):
                raise CatalogBindingError('grafana_native_catalog_binding_incomplete')
            upstreams.setdefault(uid, set()).add(edge['dataset'])
        observations.setdefault(uid, []).append(item['urn'])
    result = {}
    for uid, datasets in upstreams.items():
        matches = [scope for scope in set(scopes) if datasets.issubset(scope.allowed_dataset_urns)]
        if len(matches) != 1:
            raise CatalogBindingError('grafana_native_scope_ambiguous_or_unapproved')
        result[uid] = matches[0]
    return result, {'method': 'native_grafana_query_dataset_upstreams', 'observations': observations,
                    'runtimeConnectionVerified': False, 'publicationAuthorized': False}


def describe_dashboard_queries(snapshot, scopes_by_datasource, reader):
    """Describe captured panels/variables; datasource identity is a Host input.

    Never infer a native source instance from a matching database/display name.
    This does not adopt existing Grafana entities or authorize their publication.
    """
    queries, blockers, dashboards, catalog_requests = [], [], [], []
    for source in snapshot.files:
        if not source.path.lower().endswith('.json'):
            continue
        try:
            document = json.loads(source.text)
        except json.JSONDecodeError:
            continue
        if not isinstance(document, dict):
            continue
        dashboard = document.get('dashboard', document)
        if not isinstance(dashboard, dict) or not isinstance(dashboard.get('panels'), list):
            continue
        uid = dashboard.get('uid')
        if not isinstance(uid, str) or not uid:
            blockers.append({'path': source.path, 'reason': 'grafana_dashboard_identity_missing'})
            continue
        variables = dashboard.get('templating', {}).get('list', [])
        names = {item['name'] for item in variables if isinstance(item, dict) and isinstance(item.get('name'), str)}
        if len(names) != len(variables):
            blockers.append({'path': source.path, 'reason': 'grafana_variable_identity_invalid'})
            continue
        dashboards.append({'uid': uid, 'path': source.path, 'fileSha256': source.sha256})
        pending = list(dashboard['panels'])
        requests = []
        panel_ids = set()
        while pending:
            panel = pending.pop(0)
            if not isinstance(panel, dict):
                blockers.append({'path': source.path, 'reason': 'grafana_panel_invalid'})
                continue
            if panel.get('type') == 'row':
                pending.extend(panel.get('panels', []))
                continue
            panel_id = panel.get('id')
            targets = panel.get('targets', [])
            if (type(panel_id) is not int or panel_id in panel_ids or len(targets) != 1
                    or panel.get('transformations') or panel.get('libraryPanel')):
                blockers.append({'path': source.path, 'reason': 'grafana_panel_structure_unsupported'})
                continue
            panel_ids.add(panel_id)
            target = targets[0]
            requests.append({'kind': 'panel', 'id': panel_id, 'refId': target.get('refId'),
                'sql': target.get('rawSql'), 'datasource': target.get('datasource', panel.get('datasource'))})
        for variable in variables:
            if variable.get('type') != 'query':
                blockers.append({'path': source.path, 'reason': 'grafana_variable_type_unsupported'})
                continue
            query = variable.get('query')
            if isinstance(query, dict):
                query = query.get('rawSql')
            requests.append({'kind': 'variable', 'id': variable['name'], 'sql': query, 'datasource': variable.get('datasource')})
        for request in requests:
            identity = {key: request[key] for key in ('kind', 'id')}
            evidence = {'path': source.path, 'fileSha256': source.sha256, 'dashboardUid': uid, **identity}
            datasource = request['datasource']
            if isinstance(datasource, dict) and datasource.get('type') == 'mssql' and isinstance(datasource.get('uid'), str):
                catalog_requests.append({'dashboardUid': uid, 'datasourceUid': datasource['uid'], **identity})
            if (not isinstance(datasource, dict) or datasource.get('type') != 'mssql'
                    or datasource.get('uid') not in scopes_by_datasource or not isinstance(request['sql'], str)):
                blockers.append({**evidence, 'reason': 'grafana_datasource_binding_required'})
                continue
            scope = scopes_by_datasource[datasource['uid']]
            try:
                query, parameters = parameterize_declared_query(request['sql'], names)
                inputs = {}
                for unit in traverse_scope(query):
                    for _, owner in unit.selected_sources.values():
                        if isinstance(owner, exp.Table):
                            table = owner.copy()
                            table.set('alias', None)
                            dataset = resolve_dataset(table.sql(dialect='tsql'), scope, reader)
                            inputs[dataset.urn] = dataset
                outputs, conditions = _projection_origins(query, scope, inputs)
                queries.append({**evidence, 'datasourceUid': datasource['uid'], 'querySha256': _digest(request['sql']),
                    'displaySqlSha256': _digest(sqlglot.parse_one(request['sql'], read='tsql').sql(dialect='tsql', comments=False)),
                    'inputs': [item.to_dict() for item in inputs.values()], 'outputs': outputs,
                    'conditions': conditions, 'parameters': parameters, 'runtimeValuesVerified': False})
            except (CatalogBindingError, SqlglotError) as error:
                blockers.append({**evidence, 'reason': str(error) if isinstance(error, CatalogBindingError) else 'grafana_query_unresolved'})
    return {'format': 'datahub-etl.dashboard-queries/1', 'dashboards': dashboards, 'queries': queries,
            'catalogRequests': catalog_requests,
            'blockers': blockers, 'liveGrafanaVerified': False, 'publicationAuthorized': False}


def bind_native_dashboard_queries(description, native_items):
    """Verify observed query datasets; declarations are not live Grafana execution."""
    bindings, blockers = [], []
    for query in description['queries']:
        if query['kind'] != 'panel':
            continue  # A variable's projections are declarations, not Dataset fields.
        matches = []
        for item in native_items:
            props = item.get('datasetProperties', {}).get('value', {}).get('customProperties', {})
            if (props.get('dashboard_uid') == query['dashboardUid'] and props.get('panel_id') == str(query['id'])
                    and props.get('datasource_uid') == query['datasourceUid'] and props.get('type') == 'mssql'):
                matches.append(item)
        evidence = {key: query[key] for key in ('path', 'dashboardUid', 'kind', 'id')}
        if len(matches) != 1:
            blockers.append({**evidence, 'reason': 'grafana_native_query_identity_unresolved'})
            continue
        item = matches[0]
        try:
            native_sql = sqlglot.parse_one(item['viewProperties']['value']['viewLogic'], read='tsql')
            if _digest(native_sql.sql(dialect='tsql', comments=False)) != query['displaySqlSha256']:
                raise CatalogBindingError('grafana_native_query_changed')
            fields = [field['fieldPath'] for field in item['schemaMetadata']['value']['fields']]
            if fields != [output['output_name'] for output in query['outputs']]:
                raise CatalogBindingError('grafana_native_projection_changed')
            expected = {make_schema_field_urn(item['urn'], output['output_name']): {
                make_schema_field_urn(origin['dataset_urn'], origin['field_path']) for origin in output['origins']}
                for output in query['outputs']}
            observed = {}
            lineage = item['upstreamLineage']['value']
            for edge in lineage.get('fineGrainedLineages', []):
                if edge.get('upstreamType') != 'FIELD_SET' or edge.get('downstreamType') != 'FIELD':
                    raise CatalogBindingError('grafana_native_field_lineage_unresolved')
                for downstream in edge.get('downstreams', []):
                    observed.setdefault(downstream, set()).update(edge.get('upstreams', []))
            if observed != expected or {edge['dataset'] for edge in lineage['upstreams']} != {value['urn'] for value in query['inputs']}:
                raise CatalogBindingError('grafana_native_lineage_changed')
            bindings.append({**evidence, 'urn': item['urn'], 'catalogDigest': _digest(item), 'fields': fields})
        except (KeyError, TypeError, SqlglotError, CatalogBindingError) as error:
            blockers.append({**evidence, 'reason': str(error) if isinstance(error, CatalogBindingError) else 'grafana_native_observation_incomplete'})
    return {'bindings': bindings, 'blockers': blockers, 'liveGrafanaVerified': False}


def _prepare_panel(panel: dict, dashboard_uid: str, scope: MssqlScope,
                   graph: DataHubGraph, env: str):
    targets = panel.get("targets")
    datasource = panel.get("datasource", {})
    uid = datasource.get("uid")
    panel_id = panel.get("id")
    if (type(panel_id) is not int or panel_id < 1
            or not isinstance(uid, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", uid)
            or datasource.get("type") != "mssql" or panel.get("transformations")
            or not isinstance(targets, list) or len(targets) != 1):
        raise CatalogBindingError("grafana_schema_unsupported_panel")
    target = targets[0]
    sql = target.get("rawSql")
    if (not isinstance(sql, str) or not sql.strip() or target.get("hide")
            or target.get("datasource", datasource) != datasource):
        raise CatalogBindingError("grafana_schema_unsupported_target")
    try:
        statements = sqlglot.parse(sql, read="tsql")
    except Exception:
        raise CatalogBindingError("grafana_schema_sql_unresolved") from None
    if len(statements) != 1 or not isinstance(statements[0], exp.Select):
        raise CatalogBindingError("grafana_schema_single_select_required")
    statement = statements[0]
    if statement.args.get("into"):
        raise CatalogBindingError("grafana_schema_single_select_required")
    if any(select.is_star for select in statement.selects):
        raise CatalogBindingError("grafana_schema_explicit_projections_required")
    # Preserve the already-demonstrated MSSQL empty-schema boundary before SDK
    # URN normalization can erase it. No new SQL grammar or macro substitution.
    for table in statement.find_all(exp.Table):
        if (table.args.get("catalog") and not table.args.get("db")
                or len(table.parts) > 3
                or any(not isinstance(part, exp.Identifier) or "." in part.name
                       for part in table.parts)):
            raise CatalogBindingError("grafana_schema_sql_identifier_unresolved")
    # Check declared physical tables through the existing Host binder BEFORE
    # letting the SDK's schema-aware parser perform any Catalog lookups. CTE
    # scopes are not physical tables. Alias text is not part of the identifier.
    bound = {}
    for query_scope in traverse_scope(statement):
        for _, source in query_scope.selected_sources.values():
            if isinstance(source, exp.Table):
                identifier = ".".join(part.sql(dialect="tsql") for part in source.parts)
                dataset = resolve_dataset(identifier, scope, graph)
                bound[dataset.urn] = dataset
    if not bound:
        raise CatalogBindingError("grafana_schema_input_required")
    try:
        parsed = graph.parse_sql_lineage(
            sql, platform="mssql", env=scope.env, default_db=scope.database,
            default_schema=scope.default_schema,
        )
    except Exception:
        raise CatalogBindingError("grafana_schema_sql_unresolved") from None
    if (parsed.debug_info.error or parsed.debug_info.column_error or parsed.out_tables
            or not parsed.in_tables or not parsed.column_lineage
            or len(parsed.column_lineage) != len(statement.selects)):
        raise CatalogBindingError("grafana_schema_projection_unresolved")
    if set(parsed.in_tables) != set(bound):
        raise CatalogBindingError("grafana_schema_input_identity_mismatch")
    dataset_urn = str(DatasetUrn(
        platform="grafana", name=f"mssql.{uid}.{dashboard_uid}.{panel_id}", env=env,
    ))
    chart_urn = make_chart_urn("grafana", f"{dashboard_uid}.{panel_id}")
    fields, edges = [], {}
    for column in parsed.column_lineage:
        name = column.downstream.column
        field_urn = make_schema_field_urn(dataset_urn, name) if name else ""
        if not name or (field_urn,) in edges:
            raise CatalogBindingError("grafana_schema_ambiguous_projection")
        fields.append(name)
        origins = set()
        for upstream in column.upstreams:
            if upstream.table not in bound:
                raise CatalogBindingError("grafana_schema_field_owner_unresolved")
            actual = bound[upstream.table].field(upstream.column)
            origins.add(make_schema_field_urn(upstream.table, actual))
        edges[(field_urn,)] = origins
    return dataset_urn, chart_urn, statement.sql(dialect="tsql", comments=False), fields, set(bound), edges


def adapt_grafana_schema(
    records: list[MetadataChangeProposalWrapper], dashboard: dict, *,
    scopes_by_datasource: dict[str, MssqlScope], graph: DataHubGraph,
    env: str = "PROD",
) -> list[MetadataChangeProposalWrapper]:
    """Correct query schemas AND Chart inputFields, or return no batch on failure.

    Matching is against actual SQL projections, never names like time/value_none.
    Thus legitimate columns with those names survive. Unrelated aspects are copied
    unchanged; neither caller input nor already-published metadata is modified.
    """
    if (version("acryl-datahub") != SUPPORTED_SDK
            or version("sqlglot") != SUPPORTED_SQLGLOT):
        raise CatalogBindingError("grafana_schema_sdk_version_unverified")
    uid = dashboard.get("uid")
    panels = dashboard.get("panels")
    if (not isinstance(uid, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", uid)
            or not isinstance(panels, list) or not panels):
        raise CatalogBindingError("grafana_schema_invalid_dashboard")
    indexed = {}
    for record in records:
        key = (record.entityUrn, record.aspectName)
        if key in indexed:
            raise CatalogBindingError("grafana_schema_duplicate_aspect")
        indexed[key] = record.aspect
    replacements = {}
    for panel in panels:
        source_uid = panel.get("datasource", {}).get("uid")
        scope = scopes_by_datasource.get(source_uid)
        if not isinstance(scope, MssqlScope):
            raise CatalogBindingError("grafana_schema_host_scope_required")
        dataset, chart, sql, fields, inputs, edges = _prepare_panel(panel, uid, scope, graph, env)
        if (dataset, "schemaMetadata") in replacements:
            raise CatalogBindingError("grafana_schema_duplicate_panel")
        view = indexed.get((dataset, "viewProperties"))
        info = indexed.get((chart, "chartInfo"))
        schema = indexed.get((dataset, "schemaMetadata"))
        lineage = indexed.get((dataset, "upstreamLineage"))
        chart_fields = indexed.get((chart, "inputFields"))
        if (not isinstance(view, ViewPropertiesClass)
                or not isinstance(info, ChartInfoClass) or info.inputs != [dataset]
                or not isinstance(schema, SchemaMetadataClass)
                or schema.platform != "urn:li:dataPlatform:grafana"
                or not isinstance(lineage, UpstreamLineageClass)
                or not isinstance(chart_fields, InputFieldsClass)):
            raise CatalogBindingError("grafana_schema_native_binding_mismatch")
        # ViewProperties is formatted for display by the native connector. Match
        # the parsed statement, not whitespace; retain literals and identifiers.
        try:
            displayed = sqlglot.parse(view.viewLogic, read="tsql")
            matches = (len(displayed) == 1 and displayed[0] is not None
                       and displayed[0].sql(dialect="tsql", comments=False) == sql)
        except Exception:
            matches = False
        if not matches:
            raise CatalogBindingError("grafana_schema_native_query_mismatch")
        native_edges = {tuple(edge.downstreams or []): set(edge.upstreams or [])
                        for edge in lineage.fineGrainedLineages or []}
        if ({upstream.dataset for upstream in lineage.upstreams} != inputs
                or native_edges != edges):
            raise CatalogBindingError("grafana_schema_native_lineage_mismatch")
        native_fields = {field.fieldPath: field for field in schema.fields}
        if len(native_fields) != len(schema.fields) or not set(fields) <= native_fields.keys():
            raise CatalogBindingError("grafana_schema_native_projection_missing")
        native_urns = {make_schema_field_urn(dataset, field) for field in native_fields}
        chart_urns = [field.schemaFieldUrn for field in chart_fields.fields]
        if (set(chart_urns) != native_urns
                or any(field.schemaField is None
                       or make_schema_field_urn(dataset, field.schemaField.fieldPath) != field.schemaFieldUrn
                       for field in chart_fields.fields)):
            raise CatalogBindingError("grafana_schema_chart_fields_mismatch")
        corrected_schema = copy.deepcopy(schema)
        corrected_schema.fields = [copy.deepcopy(native_fields[field]) for field in fields]
        if corrected_schema.fields != schema.fields:
            corrected_schema.hash = hashlib.sha256(json.dumps(
                [field.to_obj() for field in corrected_schema.fields], sort_keys=True,
                separators=(",", ":"), ensure_ascii=False,
            ).encode()).hexdigest()
        corrected_chart = copy.deepcopy(chart_fields)
        # Native Chart inputFields also carries the heuristic fields, including
        # a second time entry for a real SQL time projection. Rebuild this public
        # aspect from the same selected schema, rather than leave dangling refs.
        corrected_chart.fields = [InputFieldClass(
            schemaFieldUrn=make_schema_field_urn(dataset, field.fieldPath),
            schemaField=copy.deepcopy(field),
        ) for field in corrected_schema.fields]
        replacements[(dataset, "schemaMetadata")] = corrected_schema
        replacements[(chart, "inputFields")] = corrected_chart
    result = copy.deepcopy(records)
    for record in result:
        key = (record.entityUrn, record.aspectName)
        if key in replacements:
            record.aspect = replacements[key]
    return result


class GrafanaSchemaTransformer(Transformer):
    """Official Pipeline hook for a bounded, file-sink-only preparation batch.

    SDK 1.7.0.9 calls transform once per WorkUnit, not once per source. Therefore
    retain envelopes until the public EndOfStream signal, then adapt everything
    before yielding any record. Metadata/WorkUnit IDs are preserved for the sink.
    Host must use report_to=None and accept the file only after raise_from_status;
    this transformer grants no publication authority or general network isolation.
    """

    MAX_RECORDS = 1024
    MAX_BYTES = 8 * 1024 * 1024

    def __init__(self, dashboard: dict, scopes: dict[str, MssqlScope], graph: DataHubGraph, env: str):
        self.dashboard = copy.deepcopy(dashboard)
        self.scopes = dict(scopes)
        self.graph = graph
        self.env = env
        self._pending: list[RecordEnvelope] = []
        self._bytes = 0
        self._closed = False

    @classmethod
    def create(cls, config_dict: dict, ctx: PipelineContext) -> "GrafanaSchemaTransformer":
        pipeline = ctx.pipeline_config
        if (pipeline is None or pipeline.sink is None or pipeline.sink.type != "file"
                or pipeline.source.type != "grafana" or ctx.preview_mode
                or (pipeline.source.config or {}).get("stateful_ingestion") is not None):
            raise CatalogBindingError("grafana_schema_preparation_pipeline_required")
        if (not isinstance(config_dict, dict)
                or set(config_dict) != {"dashboard", "scopes_by_datasource", "env"}
                or not isinstance(config_dict["dashboard"], dict)
                or not isinstance(config_dict["scopes_by_datasource"], dict)
                or not isinstance(config_dict["env"], str) or not config_dict["env"]):
            raise CatalogBindingError("grafana_schema_invalid_transformer_config")
        if version("acryl-datahub") != SUPPORTED_SDK or version("sqlglot") != SUPPORTED_SQLGLOT:
            raise CatalogBindingError("grafana_schema_sdk_version_unverified")
        scopes = {}
        try:
            for uid, value in config_dict["scopes_by_datasource"].items():
                if not isinstance(uid, str) or not isinstance(value, dict):
                    raise ValueError()
                scope = dict(value)
                scope["allowed_dataset_urns"] = tuple(scope["allowed_dataset_urns"])
                scopes[uid] = MssqlScope(**scope)
        except (TypeError, ValueError, KeyError):
            raise CatalogBindingError("grafana_schema_host_scope_required") from None
        return cls(config_dict["dashboard"], scopes,
                   ctx.require_graph("Grafana schema preparation"), config_dict["env"])

    def transform(self, record_envelopes: Iterable[RecordEnvelope]) -> Iterable[RecordEnvelope]:
        if self._closed:
            raise RuntimeError("grafana_schema_transformer_closed")
        try:
            for envelope in record_envelopes:
                if isinstance(envelope.record, EndOfStream):
                    self._closed = True
                    corrected = adapt_grafana_schema(
                        [item.record for item in self._pending], self.dashboard,
                        scopes_by_datasource=self.scopes, graph=self.graph, env=self.env)
                    output = [RecordEnvelope(record, previous.metadata)
                              for record, previous in zip(corrected, self._pending)]
                    self._pending.clear()
                    yield from output
                    yield envelope
                    return
                if not isinstance(envelope.record, MetadataChangeProposalWrapper):
                    raise CatalogBindingError("grafana_schema_unsupported_pipeline_record")
                self._bytes += len(json.dumps(envelope.record.to_obj(), ensure_ascii=False).encode("utf-8"))
                if len(self._pending) >= self.MAX_RECORDS or self._bytes > self.MAX_BYTES:
                    raise CatalogBindingError("grafana_schema_batch_too_large")
                self._pending.append(envelope)
        except Exception as error:
            self._closed = True
            self._pending.clear()
            # Ordinary transformer exceptions are logged and skipped by this SDK.
            # RuntimeError is the public Pipeline abort path; never silently emit
            # a partial batch or report a successful pipeline after validation fails.
            reason = str(error) if isinstance(error, CatalogBindingError) else "grafana_schema_batch_rejected"
            raise RuntimeError(reason) from None

"""Official connector -> artifact adapter. HTTP fixtures only; no publication."""
import copy
import unittest
from unittest.mock import patch

from datahub.ingestion.graph.client import DataHubGraph, DatahubClientConfig
from datahub.emitter.mce_builder import make_schema_field_urn
from datahub.metadata.schema_classes import InputFieldsClass, SchemaMetadataClass, UpstreamLineageClass, ViewPropertiesClass
from dataflow_discovery.catalog import CatalogBindingError, MssqlScope
from dataflow_discovery.grafana_schema import GrafanaSchemaTransformer, adapt_grafana_schema
from datahub.ingestion.api.common import EndOfStream, PipelineContext, RecordEnvelope
from datahub.ingestion.run.pipeline_config import PipelineConfig
from tests.test_sales_datamart_grafana import (
    DATASOURCE, EXPECTED_ORIGINS, VIEW_URN, catalog_fixture, ingest_fixture, template,
)


def apply_adapter(records, dashboard):
    with DataHubGraph(DatahubClientConfig(
        server="https://catalog.invalid", token="fixture-not-a-credential",
        retry_max_times=0,
    )) as graph:
        return adapt_grafana_schema(
            records, dashboard, graph=graph,
            scopes_by_datasource={DATASOURCE["uid"]: MssqlScope(
                "SalesDatamart", "reporting", "PROD", True, True, (VIEW_URN,),
            )},
        )


def encoded(records):
    return [record.to_obj() for record in records]


def pipeline_transformer(dashboard):
    return [{"type": "dataflow_discovery.grafana_schema.GrafanaSchemaTransformer", "config": {
        "dashboard": dashboard, "env": "PROD", "scopes_by_datasource": {DATASOURCE["uid"]: {
            "database": "SalesDatamart", "default_schema": "reporting", "env": "PROD",
            "lowercase_urns": True, "lowercase_fields": True, "allowed_dataset_urns": [VIEW_URN],
        }},
    }}]


class GrafanaSchemaAdapterTests(unittest.TestCase):
    def test_official_pipeline_transformer_corrects_before_file_sink(self):
        dashboard = template("dashboard.json")["dashboard"]
        observations, calls = [], []
        records = ingest_fixture(dashboard, catalog=catalog_fixture(),
                                 transformers=pipeline_transformer(dashboard), observations=observations,
                                 requests_seen=calls)
        schemas = [m.aspect for m in records if isinstance(m.aspect, SchemaMetadataClass)]
        chart_fields = [m.aspect for m in records if isinstance(m.aspect, InputFieldsClass)]
        self.assertEqual([len(schema.fields) for schema in schemas], [1, 1, 1, 2, 2, 2, 5])
        self.assertEqual(sum(len(item.fields) for item in chart_fields), 14)
        self.assertEqual(observations[0]["status"], "COMPLETED")
        self.assertEqual(len(observations[0]["records"]), len(records))
        self.assertTrue(all(method == "GET" or url.endswith("/dataset/batchGet") for method, url in calls))

    def test_pipeline_late_panel_failure_aborts_without_sink_records(self):
        dashboard = template("dashboard.json")["dashboard"]
        captured = copy.deepcopy(dashboard)
        captured["panels"][-1]["targets"][0]["rawSql"] = captured["panels"][-1]["targets"][0]["rawSql"].replace("line_count", "different_count")
        observations = []
        with self.assertRaises(Exception):
            ingest_fixture(dashboard, catalog=catalog_fixture(),
                           transformers=pipeline_transformer(captured), observations=observations)
        self.assertEqual(observations, [{"status": "ERROR", "records": []}])

    def test_workunit_buffer_preserves_metadata_and_never_yields_before_end(self):
        dashboard = template("dashboard.json")["dashboard"]

        def inspect(records):
            with DataHubGraph(DatahubClientConfig(server="https://catalog.invalid", token="fixture-not-a-credential", retry_max_times=0)) as graph:
                scopes = {DATASOURCE["uid"]: MssqlScope("SalesDatamart", "reporting", "PROD", True, True, (VIEW_URN,))}
                transformer = GrafanaSchemaTransformer(dashboard, scopes, graph, "PROD")
                before = encoded(records)
                envelopes = [RecordEnvelope(record, {"workunit_id": str(i)}) for i, record in enumerate(records)]
                for envelope in envelopes:
                    self.assertEqual(list(transformer.transform([envelope])), [])
                end = RecordEnvelope(EndOfStream(), {"workunit_id": "end-of-stream"})
                output = list(transformer.transform([end]))
                self.assertIs(output[-1], end)
                self.assertEqual(len(output), len(envelopes) + 1)
                for old, new in zip(envelopes, output):
                    self.assertIs(old.metadata, new.metadata)
                    if old.record.aspectName not in {"schemaMetadata", "inputFields"}:
                        self.assertEqual(old.record.to_obj(), new.record.to_obj())
                self.assertEqual(encoded(records), before)
                with self.assertRaisesRegex(RuntimeError, "transformer_closed"):
                    list(transformer.transform([end]))
                for attribute in ("MAX_RECORDS", "MAX_BYTES"):
                    limited = GrafanaSchemaTransformer(dashboard, scopes, graph, "PROD")
                    setattr(limited, attribute, 0)
                    with self.assertRaisesRegex(RuntimeError, "batch_too_large"):
                        list(limited.transform(envelopes[:1]))
                    self.assertEqual(limited._pending, [])
                unknown = GrafanaSchemaTransformer(dashboard, scopes, graph, "PROD")
                with self.assertRaisesRegex(RuntimeError, "unsupported_pipeline_record"):
                    list(unknown.transform([RecordEnvelope(object(), {})]))
            return records

        ingest_fixture(dashboard, catalog=catalog_fixture(), transform=inspect)

    def test_transformer_requires_file_preparation_not_rest_preview_or_stateful(self):
        config = pipeline_transformer(template("dashboard.json")["dashboard"])[0]["config"]
        for source_type, sink_type, preview, source_config in [
            ("grafana", "datahub-rest", False, {}), ("grafana", "file", True, {}),
            ("file", "file", False, {}), ("grafana", "file", False, {"stateful_ingestion": {"enabled": True}}),
        ]:
            with self.subTest(source=source_type, sink=sink_type, preview=preview):
                pipeline = PipelineConfig.model_validate({"source": {"type": source_type, "config": source_config}, "sink": {"type": sink_type}})
                ctx = PipelineContext("fixture", preview_mode=preview, pipeline_config=pipeline)
                with self.assertRaisesRegex(CatalogBindingError, "preparation_pipeline_required"):
                    GrafanaSchemaTransformer.create(config, ctx)
        pipeline = PipelineConfig.model_validate({"source": {"type": "grafana"}, "sink": {"type": "file"}})
        ctx = PipelineContext("fixture", pipeline_config=pipeline)
        with self.assertRaisesRegex(CatalogBindingError, "invalid_transformer_config"):
            GrafanaSchemaTransformer.create({**config, "endpoint": "not-allowed"}, ctx)

    def test_real_connector_artifacts_recover_schema_and_chart_fields_atomically(self):
        dashboard = template("dashboard.json")["dashboard"]

        def transform(original):
            before = encoded(original)
            corrected = apply_adapter(original, dashboard)
            self.assertEqual(encoded(original), before)
            self.assertEqual(encoded(apply_adapter(corrected, dashboard)), encoded(corrected))
            schemas = {m.entityUrn: m.aspect for m in corrected
                       if m.entityUrn is not None and isinstance(m.aspect, SchemaMetadataClass)}
            self.assertEqual(len(schemas), 7)
            for urn, schema in schemas.items():
                panel_id = int(urn.rsplit(".", 1)[1].split(",", 1)[0])
                self.assertEqual([f.fieldPath for f in schema.fields], list(EXPECTED_ORIGINS[panel_id]))
            for mcp in corrected:
                if isinstance(mcp.aspect, InputFieldsClass):
                    assert mcp.entityUrn is not None
                    panel_id = int(mcp.entityUrn.rsplit(".", 1)[1].split(")", 1)[0])
                    dataset = next(urn for urn in schemas if urn.endswith(f".{panel_id},PROD)"))
                    self.assertEqual([f.schemaFieldUrn for f in mcp.aspect.fields],
                                     [make_schema_field_urn(dataset, f.fieldPath) for f in schemas[dataset].fields])
                    self.assertEqual([f.schemaField.to_obj() for f in mcp.aspect.fields if f.schemaField is not None],
                                     [f.to_obj() for f in schemas[dataset].fields])
            for old, new in zip(original, corrected):
                if old.aspectName not in {"schemaMetadata", "inputFields"}:
                    self.assertEqual(old.to_obj(), new.to_obj())
            return corrected

        ingest_fixture(dashboard, catalog=catalog_fixture(), transform=transform)

    def test_legitimate_time_and_value_none_columns_are_not_name_filtered(self):
        dashboard = template("dashboard.json")["dashboard"]
        dashboard["panels"] = [dashboard["panels"][0]]
        dashboard["panels"][0]["id"] = 41
        dashboard["panels"][0]["targets"][0]["rawSql"] = (
            "SELECT OrderDate AS time, SalesOrderID AS value_none FROM reporting.v_sales_order_line"
        )
        result = ingest_fixture(dashboard, catalog=catalog_fixture(),
                                transform=lambda records: apply_adapter(records, dashboard))
        schema = next(m.aspect for m in result if isinstance(m.aspect, SchemaMetadataClass))
        inputs = next(m.aspect for m in result if isinstance(m.aspect, InputFieldsClass))
        self.assertEqual([f.fieldPath for f in schema.fields], ["time", "value_none"])
        self.assertEqual(len(inputs.fields), 2)
        self.assertEqual([f.schemaField.to_obj() for f in inputs.fields if f.schemaField is not None], [f.to_obj() for f in schema.fields])

    def test_unsupported_shapes_and_cross_scope_fail_before_adapter_catalog_io(self):
        original = template("dashboard.json")["dashboard"]
        cases = []
        for sql, reason in [
            ("SELECT * FROM reporting.v_sales_order_line", "explicit_projections_required"),
            ("SELECT 1; SELECT 2", "single_select_required"),
            ("DELETE FROM reporting.v_sales_order_line", "single_select_required"),
            ("SELECT SalesOrderID INTO OtherDB.dbo.NewTable FROM reporting.v_sales_order_line", "single_select_required"),
            ("SELECT SalesOrderID FROM OtherDB.reporting.v_sales_order_line", "database_outside_host_scope"),
            ("SELECT SalesOrderID FROM SalesDatamart..v_sales_order_line", "sql_identifier_unresolved"),
        ]:
            changed = copy.deepcopy(original)
            changed["panels"][0]["targets"][0]["rawSql"] = sql
            cases.append((changed, reason))
        changed = copy.deepcopy(original)
        changed["panels"][0]["targets"] *= 2
        cases.append((changed, "unsupported_panel"))
        changed = copy.deepcopy(original)
        changed["panels"][0]["transformations"] = [{"id": "organize"}]
        cases.append((changed, "unsupported_panel"))
        for dashboard, reason in cases:
            with self.subTest(reason=reason):
                calls = []

                def transform(records):
                    before, count = encoded(records), len(calls)
                    with self.assertRaisesRegex(CatalogBindingError, reason):
                        apply_adapter(records, dashboard)
                    self.assertEqual(len(calls), count)
                    self.assertEqual(encoded(records), before)
                    return records

                ingest_fixture(original, catalog=catalog_fixture(), requests_seen=calls, transform=transform)

    def test_existing_catalog_key_status_schema_checks_are_not_bypassed(self):
        dashboard = template("dashboard.json")["dashboard"]
        reduced = copy.deepcopy(catalog_fixture()[VIEW_URN])
        reduced["fields"] = [f for f in reduced["fields"] if f["fieldPath"] != "linenetamount"]
        for overrides, reason in [
            ({"datasetKey": None}, "catalog_key_missing"),
            ({"status": {"removed": True}}, "catalog_status_missing_or_removed"),
            ({"schemaMetadata": None}, "catalog_schema_missing_or_empty"),
            ({"schemaMetadata": reduced}, "catalog_column_missing_or_ambiguous|projection_unresolved"),
        ]:
            with self.subTest(reason=reason):
                def transform(records):
                    before = encoded(records)
                    with self.assertRaisesRegex(CatalogBindingError, reason):
                        apply_adapter(records, dashboard)
                    self.assertEqual(encoded(records), before)
                    return records

                ingest_fixture(dashboard, catalog=catalog_fixture(), transform=transform,
                               catalog_aspects={VIEW_URN: overrides})

    def test_late_native_drift_leaves_entire_batch_unchanged(self):
        dashboard = template("dashboard.json")["dashboard"]
        for aspect in ("inputFields", "viewProperties", "upstreamLineage"):
            with self.subTest(aspect=aspect):
                def transform(records):
                    if aspect == "inputFields":
                        inputs = next(m.aspect for m in reversed(records) if isinstance(m.aspect, InputFieldsClass))
                        inputs.fields[0].schemaFieldUrn = make_schema_field_urn(VIEW_URN, "orderqty")
                    elif aspect == "viewProperties":
                        view = next(m.aspect for m in reversed(records) if isinstance(m.aspect, ViewPropertiesClass))
                        view.viewLogic += "; SELECT 9"
                    else:
                        lineage = next(m.aspect for m in reversed(records) if isinstance(m.aspect, UpstreamLineageClass))
                        lineage.fineGrainedLineages = []
                    before = encoded(records)
                    with self.assertRaises(CatalogBindingError):
                        apply_adapter(records, dashboard)
                    self.assertEqual(encoded(records), before)
                    return records

                ingest_fixture(dashboard, catalog=catalog_fixture(), transform=transform)

    def test_unverified_sdk_does_not_silently_enable_adapter(self):
        dashboard = template("dashboard.json")["dashboard"]
        calls = []

        def transform(records):
            count = len(calls)
            for versions in ({"acryl-datahub": "future", "sqlglot": "30.12.0"},
                             {"acryl-datahub": "1.7.0.9", "sqlglot": "future"}):
                with patch("dataflow_discovery.grafana_schema.version", side_effect=versions.__getitem__):
                    with self.assertRaisesRegex(CatalogBindingError, "sdk_version_unverified"):
                        apply_adapter(records, dashboard)
                self.assertEqual(len(calls), count)
            return records

        ingest_fixture(dashboard, catalog=catalog_fixture(), requests_seen=calls, transform=transform)


if __name__ == "__main__":
    unittest.main()

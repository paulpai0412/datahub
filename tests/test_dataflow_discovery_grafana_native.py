"""Native transformer seam; no live HTTP, publication or source execution."""
import copy
import json
import os
import re
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any
from unittest.mock import MagicMock, patch
from datahub.configuration.config_loader import load_config_file
from datahub.emitter.mcp import MetadataChangeProposalWrapper
from datahub.emitter.serialization_helper import post_json_transform, pre_json_transform
from expandvars import UnboundVariable
from datahub.ingestion.api.common import EndOfStream, PipelineContext, RecordEnvelope
from datahub.ingestion.graph.client import DataHubGraph, DatahubClientConfig
from datahub.ingestion.run.pipeline import Pipeline, PipelineInitError
from datahub.ingestion.run.pipeline_config import PipelineConfig
from datahub.metadata.schema_classes import SchemaMetadataClass
from dataflow_discovery.catalog import CatalogBindingError
from dataflow_discovery.grafana_schema import GrafanaIngestionSchemaTransformer
from tests.test_dataflow_discovery_grafana_schema import apply_adapter, pipeline_transformer
from tests.test_sales_datamart_grafana import catalog_fixture, ingest_fixture, template


def native_config():
    config = pipeline_transformer(template("dashboard.json")["dashboard"])[0]["config"]
    config["expected_versions"] = {
        **{f"urn:li:dataset:(urn:li:dataPlatform:grafana,mssql.dataflow-salesdatamart.dataflow-sales-v1.{i},PROD)": {"schemaMetadata": "3"} for i in range(1, 8)},
        **{f"urn:li:chart:(grafana,dataflow-sales-v1.{i})": {"inputFields": "3"} for i in range(1, 8)},
    }
    return config


def pipeline() -> dict[str, Any]:
    title = template("dashboard.json")["dashboard"]["title"]
    return {"source": {"type": "grafana", "config": {"dashboard_pattern": {"allow": [f"^{re.escape(title)}$"]}}},
            "sink": {"type": "datahub-rest", "config": {"mode": "SYNC", "retry_max_times": 0}}}


class NativeGrafanaTests(unittest.TestCase):
    def test_rest_readback_uses_sdk_conversion_to_preserve_union_types(self):
        dashboard = template("dashboard.json")["dashboard"]
        def check(records):
            restored = [MetadataChangeProposalWrapper(entityUrn=r.entityUrn,
                aspect=type(r.aspect).from_obj(post_json_transform(pre_json_transform(r.aspect.to_obj())))) for r in records]
            native = apply_adapter(records, dashboard)
            corrected = apply_adapter(restored, dashboard)
            self.assertEqual(len(corrected), len(native))
            for actual, expected in zip(corrected, native):
                assert actual.aspect is not None and expected.aspect is not None
                self.assertEqual(actual.aspect.to_obj(), expected.aspect.to_obj())
            schemas = [r.aspect for r in corrected if isinstance(r.aspect, SchemaMetadataClass)]
            self.assertEqual(len(schemas), 7)
            self.assertEqual({type(f.type.type).__name__ for s in schemas for f in s.fields},
                             {"NumberTypeClass", "TimeTypeClass", "StringTypeClass"})
            self.assertTrue(all(type(s.platformSchema).__name__ == "OtherSchemaClass" for s in schemas))
            return records
        ingest_fixture(dashboard, catalog=catalog_fixture(), transform=check)

    def test_complete_native_pipeline_initialization_requires_explicit_sink_server(self):
        def check(records):
            recipe = pipeline()
            recipe["source"]["config"].update(url="https://grafana.invalid", service_account_token="fixture-not-a-credential")
            recipe["transformers"] = [{"type": "dataflow_discovery.grafana_schema.GrafanaIngestionSchemaTransformer", "config": native_config()}]
            with self.assertRaisesRegex(PipelineInitError, "server"):
                Pipeline.create(recipe, report_to=None, no_progress=True)
            recipe["sink"]["config"].update(server="https://catalog.invalid", token="fixture-not-a-credential")
            candidate = Pipeline.create(recipe, report_to=None, no_progress=True)
            candidate.source.close()
            candidate.sink.close()
            return records
        # Existing HTTP guard rejects every write. This exercises actual SDK
        # sink/source/transformer construction, not only PipelineContext mocks.
        ingest_fixture(template("dashboard.json")["dashboard"], catalog=catalog_fixture(), transform=check)

    def test_cli_recipe_preserves_grafana_macros_and_resolves_only_source_secret(self):
        recipe, config = pipeline(), native_config()
        recipe["source"]["config"]["service_account_token"] = "${GRAFANA_TEST_TOKEN}"
        recipe["transformers"] = [{"type": "dataflow_discovery.grafana_schema.GrafanaIngestionSchemaTransformer", "config": config}]
        original = copy.deepcopy(config["dashboard"])
        with TemporaryDirectory() as directory, patch.dict(os.environ, {}, clear=True):
            path = Path(directory) / "recipe.json"
            path.write_text(json.dumps(recipe))
            with self.assertRaisesRegex(UnboundVariable, "__timeFilter"):
                load_config_file(path, extra_env_vars={"GRAFANA_TEST_TOKEN": "fixture"})
            # SDK recipe interpolation is not Grafana SQL interpolation. Escape
            # literal dollars in the seven SQL strings containing ${...} first.
            for panel in config["dashboard"]["panels"]:
                for target in panel["targets"]:
                    target["rawSql"] = target["rawSql"].replace("$", r"\$")
            path.write_text(json.dumps(recipe))
            loaded = load_config_file(path, extra_env_vars={"GRAFANA_TEST_TOKEN": "fixture"})
        self.assertEqual(loaded["source"]["config"]["service_account_token"], "fixture")
        self.assertEqual(loaded["transformers"][0]["config"]["dashboard"], original)
        with MagicMock(spec=DataHubGraph) as graph:
            ctx = PipelineContext("fixture", graph=graph, pipeline_config=PipelineConfig.model_validate(loaded))
            transformer = GrafanaIngestionSchemaTransformer.create(loaded["transformers"][0]["config"], ctx)
            self.assertEqual(transformer.dashboard, original)
            self.assertEqual(len(transformer.expected_versions), 14)

    def test_official_transformer_buffers_complete_batch_and_preserves_conditional_headers(self):
        def check(records):
            with DataHubGraph(DatahubClientConfig(server="https://catalog.invalid", token="fixture-not-a-credential", retry_max_times=0)) as graph:
                ctx = PipelineContext("fixture", graph=graph, pipeline_config=PipelineConfig.model_validate(pipeline()))
                transformer = GrafanaIngestionSchemaTransformer.create(native_config(), ctx)
                for record in records:
                    self.assertEqual(list(transformer.transform([RecordEnvelope(record, {"workunit_id": record.entityUrn})])), [])
                output = list(transformer.transform([RecordEnvelope(EndOfStream(), {})]))
                self.assertIsInstance(output[-1].record, EndOfStream)
                changed = [e.record for e in output[:-1] if e.record.aspectName in {"schemaMetadata", "inputFields"}]
                self.assertEqual(len(changed), 14)
                self.assertEqual(sum(len(m.aspect.fields) for m in changed if m.aspectName == "schemaMetadata"), 14)
                self.assertEqual(sum(len(m.aspect.fields) for m in changed if m.aspectName == "inputFields"), 14)
                for record in changed:
                    self.assertEqual(record.make_mcp().headers, {"If-Version-Match": "3"})
                    self.assertEqual(record.to_obj()["headers"], {"If-Version-Match": "3"})
                for before, after in zip(records, output[:-1]):
                    self.assertEqual(after.metadata, {"workunit_id": before.entityUrn})
                    if before.aspectName not in {"schemaMetadata", "inputFields"}:
                        self.assertEqual(before.to_obj(), after.record.to_obj())
                self.assertTrue(all(not r.headers for r in records))
            return records
        ingest_fixture(template("dashboard.json")["dashboard"], catalog=catalog_fixture(), transform=check)

    def test_native_entrypoint_rejects_unsafe_modes_and_unpinned_versions(self):
        with MagicMock(spec=DataHubGraph) as graph:
            mutations = [
                lambda p, c: p["sink"].update(type="file"),
                lambda p, c: p["sink"]["config"].update(mode="ASYNC"),
                lambda p, c: p["sink"]["config"].update(retry_max_times=1),
                lambda p, c: p["source"]["config"].update(stateful_ingestion={"enabled": True}),
                lambda p, c: p["source"]["config"].update(dashboard_pattern={"allow": [".*"]}),
                lambda p, c: c.pop("expected_versions"),
                lambda p, c: c["expected_versions"].pop(next(iter(c["expected_versions"]))),
                lambda p, c: c["expected_versions"].update({"urn:li:chart:(grafana,other)": {"inputFields": "3"}}),
                lambda p, c: c["expected_versions"][next(iter(c["expected_versions"]))].update(schemaMetadata="-1"),
            ]
            for index, mutate in enumerate(mutations):
                with self.subTest(index=index):
                    p, config = pipeline(), native_config()
                    mutate(p, config)
                    ctx = PipelineContext("fixture", graph=graph, pipeline_config=PipelineConfig.model_validate(p))
                    with self.assertRaises(CatalogBindingError):
                        GrafanaIngestionSchemaTransformer.create(config, ctx)
            ctx = PipelineContext("fixture", graph=graph, preview_mode=True, pipeline_config=PipelineConfig.model_validate(pipeline()))
            with self.assertRaises(CatalogBindingError):
                GrafanaIngestionSchemaTransformer.create(native_config(), ctx)

    def test_same_title_cannot_admit_an_unapproved_dataset(self):
        def check(records):
            with DataHubGraph(DatahubClientConfig(server="https://catalog.invalid", token="fixture-not-a-credential", retry_max_times=0)) as graph:
                ctx = PipelineContext("fixture", graph=graph, pipeline_config=PipelineConfig.model_validate(pipeline()))
                transformer = GrafanaIngestionSchemaTransformer.create(native_config(), ctx)
                other = copy.deepcopy(next(r for r in records if r.aspectName == "schemaMetadata"))
                other.entityUrn = "urn:li:dataset:(urn:li:dataPlatform:grafana,another-dashboard.1,PROD)"
                output = []
                with self.assertRaisesRegex(RuntimeError, "native_entity_out_of_scope"):
                    for envelope in transformer.transform([*[RecordEnvelope(r, {}) for r in [*records, other]], RecordEnvelope(EndOfStream(), {})]):
                        output.append(envelope)
                self.assertEqual(output, [])
            return records
        ingest_fixture(template("dashboard.json")["dashboard"], catalog=catalog_fixture(), transform=check)

    def test_late_mismatch_yields_no_records(self):
        def check(records):
            with DataHubGraph(DatahubClientConfig(server="https://catalog.invalid", token="fixture-not-a-credential", retry_max_times=0)) as graph:
                config = native_config()
                config["dashboard"]["panels"][-1]["targets"][0]["rawSql"] += " WHERE 1 = 0"
                ctx = PipelineContext("fixture", graph=graph, pipeline_config=PipelineConfig.model_validate(pipeline()))
                transformer = GrafanaIngestionSchemaTransformer.create(config, ctx)
                output = []
                with self.assertRaisesRegex(RuntimeError, "grafana_schema_"):
                    for envelope in transformer.transform([*[RecordEnvelope(r, {}) for r in records], RecordEnvelope(EndOfStream(), {})]):
                        output.append(envelope)
                self.assertEqual(output, [])
            return records
        ingest_fixture(template("dashboard.json")["dashboard"], catalog=catalog_fixture(), transform=check)


if __name__ == "__main__":
    unittest.main()

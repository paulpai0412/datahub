"""Local conformance, not real source / deployment / model-adherence evidence."""
from copy import deepcopy
from dataclasses import replace
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from dataflow_discovery.analyzer import analyze_snapshot
from dataflow_discovery.cli import main
from dataflow_discovery.plugin_api import (
    Plugin, PluginError, PluginRegistry, contract_digest, digest, file_evidence,
    validate_graph, validate_manifest,
)
from dataflow_discovery.plugins import openapi
from dataflow_discovery.plugins.registry import builtin_registry
from dataflow_discovery.snapshot import capture_snapshot


def specification():
    # Independent expectations below; never generated from plugin output.
    return {"openapi": "3.0.3", "info": {"title": "Orders", "version": "1"}, "paths": {
        "/orders/{id}": {
            "get": {"responses": {"200": {"description": "Order", "content": {"application/json": {
                "schema": {"type": "object", "additionalProperties": False, "properties": {
                    "total": {"type": "number", "nullable": True}, "id": {"type": "integer"}}}}}}}},
            "post": {"requestBody": {"content": {"application/json": {"schema": {
                "type": "object", "additionalProperties": False, "properties": {"amount": {"type": "number"}}}}}},
                "responses": {"204": {"description": "No content"}}}}}}


class PluginContractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.registry = builtin_registry()

    def capture(self, data=None, scope="orders-dev"):
        (self.root / "api.json").write_text(json.dumps(specification() if data is None else data), encoding="utf-8")
        return capture_snapshot(self.root, ["api.json"], source_id=scope)

    def analyze(self, snapshot):
        return self.registry.analyze("openapi-operations", snapshot, {"serviceId": "orders"})

    def test_manifest_is_closed_and_versioned(self):
        for change in ({"contractVersion": "2"}, {"command": "anything"}, {"permissions": ["publish"]}, {"suffixes": []}):
            with self.subTest(change=change), self.assertRaises(PluginError):
                validate_manifest({**openapi.MANIFEST, **change})
        bad = deepcopy(openapi.MANIFEST)
        bad["configSchema"]["properties"]["serviceId"] = {"$ref": "https://invalid.example/schema"}
        with self.assertRaisesRegex(PluginError, "reference_rejected"):
            validate_manifest(bad)

    def test_registry_is_explicit_and_does_not_import_ids(self):
        snapshot = self.capture()
        with patch("importlib.import_module", side_effect=AssertionError("no import")):
            with self.assertRaisesRegex(PluginError, "not_registered"):
                self.registry.analyze("os.system", snapshot, {})
        with self.assertRaisesRegex(PluginError, "duplicate_registration"):
            PluginRegistry((Plugin(openapi.MANIFEST, openapi.analyze), Plugin(openapi.MANIFEST, openapi.analyze)))

    def test_manifest_copies_and_config_are_not_mutable_authority(self):
        listed = self.registry.manifests()
        listed[0]["id"] = "changed"
        self.assertNotEqual(self.registry.manifests()[0]["id"], "changed")
        config = {"serviceId": "orders"}
        def mutate(snapshot, supplied):
            graph = openapi.analyze(snapshot, supplied)
            supplied["serviceId"] = "other"
            return graph
        registry = PluginRegistry((Plugin(openapi.MANIFEST, mutate),))
        result = registry.analyze("openapi-operations", self.capture(), config)
        self.assertEqual(config, {"serviceId": "orders"})
        self.assertEqual(result["configDigest"], digest(config))

    def test_get_and_post_are_distinct_and_ports_are_not_value_edges(self):
        result = self.analyze(self.capture())
        nodes = result["graph"]["nodes"]
        self.assertEqual({node["name"] for node in nodes if node["kind"] == "asset"}, {"GET /orders/{id}", "POST /orders/{id}"})
        ports = {node["name"]: node for node in nodes if node["kind"] == "port"}
        self.assertEqual(ports["request:application/json"]["direction"], "input")
        self.assertEqual(ports["response:200:application/json"]["direction"], "output")
        self.assertEqual(ports["request:application/json"]["fields"], [{"path": "/amount", "nativeType": "number"}])
        self.assertEqual(ports["response:200:application/json"]["fields"], [
            {"path": "/id", "nativeType": "integer"}, {"path": "/total", "nativeType": "number", "nullable": True}])
        self.assertEqual(result["graph"]["edges"], [])
        self.assertTrue(result["coverageComplete"])
        self.assertFalse(result["publicationAuthorized"])
        self.assertFalse(result["runtimeVerified"])

    def test_identity_scope_and_version_are_separate(self):
        first = self.analyze(self.capture())
        changed = specification()
        changed["info"]["title"] = "Renamed documentation"
        second = self.analyze(self.capture(changed))
        other = self.analyze(self.capture(changed, scope="orders-prod"))
        ids = lambda result: {node["id"] for node in result["graph"]["nodes"]}
        self.assertEqual(ids(first), ids(second))
        self.assertTrue(ids(first).isdisjoint(ids(other)))
        self.assertNotEqual(first["resultDigest"], second["resultDigest"])
        self.assertEqual(second, self.analyze(self.capture(changed)))

    def test_valid_local_reference_and_escaped_field_paths(self):
        doc = specification()
        schema = {"$ref": "#/components/schemas/Order"}
        doc["paths"]["/orders/{id}"]["get"]["responses"]["200"]["content"]["application/json"]["schema"] = schema
        doc["components"] = {"schemas": {"Order": {"type": "object", "additionalProperties": False,
            "properties": {"a/b~c": {"type": "string"}}}}}
        result = self.analyze(self.capture(doc))
        port = next(node for node in result["graph"]["nodes"] if node["name"] == "response:200:application/json")
        self.assertEqual(port["fields"], [{"path": "/a~1b~0c", "nativeType": "string"}])
        self.assertTrue(result["coverageComplete"])

    def test_remote_refs_recursive_schemas_and_arrays_stay_unresolved(self):
        for schema in ({"$ref": "https://invalid.example/private"}, {"type": "array", "items": {"type": "integer"}},
                       {"$ref": "#/components/schemas/Loop"}, {"$ref": "#/missing"}):
            doc = specification()
            doc["components"] = {"schemas": {"Loop": {"type": "object", "additionalProperties": False,
                "properties": {"child": {"$ref": "#/components/schemas/Loop"}}}}}
            doc["paths"]["/orders/{id}"]["get"]["responses"]["200"]["content"]["application/json"]["schema"] = schema
            with self.subTest(schema=schema), patch("urllib.request.urlopen", side_effect=AssertionError("no network")):
                result = self.analyze(self.capture(doc))
                self.assertFalse(result["coverageComplete"])
                self.assertTrue(result["graph"]["findings"])
                self.assertEqual(result["graph"]["edges"], [])

    def test_directional_malformed_and_global_semantics_are_not_silent_success(self):
        mutations = [
            lambda doc: doc.update(security=[{"bearer": []}]),
            lambda doc: doc.update(servers=[{"url": "https://invalid.example"}]),
            lambda doc: doc["paths"]["/orders/{id}"]["get"].update(responses={"200": None}),
            lambda doc: doc["paths"]["/orders/{id}"]["get"].update(responses={"INVALID": {"description": "bad"}}),
        ]
        for schema in ({"type": ["string", "null"]}, {"type": "string", "readOnly": True}):
            doc = specification()
            doc["paths"]["/orders/{id}"]["get"]["responses"]["200"]["content"]["application/json"]["schema"] = schema
            self.assertFalse(self.analyze(self.capture(doc))["coverageComplete"])
        for mutate in mutations:
            doc = specification()
            mutate(doc)
            self.assertFalse(self.analyze(self.capture(doc))["coverageComplete"])
        doc = specification()
        doc["x-number"] = float("nan")
        self.assertFalse(self.analyze(self.capture(doc))["coverageComplete"])

    def test_pointer_indexes_are_rfc6901_not_python_indexing(self):
        doc = specification()
        doc["x-items"] = ["first", "last"]
        doc["bad~escape"] = "value"
        snapshot = self.capture(doc)
        graph = self.analyze(snapshot)["graph"]
        for pointer in ("/x-items/-1", "/x-items/01", "/x-items/+1", "/bad~escape"):
            broken = deepcopy(graph)
            broken["nodes"][0]["evidence"][0]["pointer"] = pointer
            with self.subTest(pointer=pointer), self.assertRaisesRegex(PluginError, "pointer_invalid"):
                validate_graph(broken, snapshot)
        graph["nodes"][0]["evidence"][0]["pointer"] = "/x-items/1"
        validate_graph(graph, snapshot)

    def test_nonfinite_config_rejected_before_execution(self):
        manifest = deepcopy(openapi.MANIFEST)
        manifest["configSchema"] = {"type": "object", "additionalProperties": False,
                                    "properties": {"factor": {"type": "number"}}}
        registry = PluginRegistry((Plugin(manifest, lambda *_: self.fail("plugin called")),))
        with self.assertRaisesRegex(PluginError, "config_not_json"):
            registry.analyze("openapi-operations", self.capture(), {"factor": float("nan")})

    def test_unsupported_empty_invalid_and_duplicate_inputs_do_not_pass(self):
        for doc in ({}, {"openapi": "3.1.0", "paths": {}}, {"openapi": "3.0.3", "paths": {}}):
            self.assertFalse(self.analyze(self.capture(doc))["coverageComplete"])
        (self.root / "api.json").write_text('{"openapi":"3.0.3","paths":{},"paths":{}}')
        snapshot = capture_snapshot(self.root, ["api.json"], source_id="orders-dev")
        self.assertFalse(self.analyze(snapshot)["coverageComplete"])
        (self.root / "job.py").write_text("raise RuntimeError('must never execute')\n")
        snapshot = capture_snapshot(self.root, ["api.json", "job.py"], source_id="orders-dev")
        result = self.analyze(snapshot)
        self.assertEqual(len(result["graph"]["coverage"]), 2)
        self.assertFalse(result["coverageComplete"])

    def test_tampered_snapshot_rejected_before_plugin_runs(self):
        snapshot = self.capture()
        changed = replace(snapshot.files[0], text="{}")
        registry = PluginRegistry((Plugin(openapi.MANIFEST, lambda *_: self.fail("plugin called")),))
        with self.assertRaisesRegex(PluginError, "snapshot_invalid"):
            registry.analyze("openapi-operations", replace(snapshot, files=(changed,)), {"serviceId": "orders"})

    def test_bad_graph_evidence_ids_coverage_and_fields_are_rejected(self):
        snapshot = self.capture()
        graph = self.analyze(snapshot)["graph"]
        def check(mutator):
            broken = deepcopy(graph)
            mutator(broken)
            with self.assertRaises(PluginError):
                validate_graph(broken, snapshot)
        check(lambda g: g["coverage"].clear())
        check(lambda g: g["nodes"].append(g["nodes"][0]))
        check(lambda g: g["nodes"][0].update(id="node_" + "0" * 64))
        check(lambda g: g["nodes"][0]["evidence"][0].update(fileSha256="0" * 64))
        check(lambda g: g["nodes"][0]["evidence"][0].update(endLine=999))
        check(lambda g: g["nodes"][0]["evidence"][0].update(pointer="/missing"))
        check(lambda g: g.update(publicationAuthorized=True))
        check(lambda g: g["coverage"][0].update(state="unsupported"))
        port = next(node for node in graph["nodes"] if node["kind"] == "port")
        edge = {"kind": "value_dependency", "sources": [{"node": port["id"], "field": "/missing"}],
                "target": {"node": port["id"]}, "evidence": [file_evidence(snapshot.files[0])]}
        check(lambda g: g["edges"].append(edge))

    def test_value_and_condition_edges_are_distinct_and_require_ports(self):
        snapshot = self.capture()
        graph = self.analyze(snapshot)["graph"]
        ports = [node for node in graph["nodes"] if node["kind"] == "port"]
        graph["edges"] = [{"kind": kind, "sources": [{"node": ports[0]["id"], "field": ports[0]["fields"][0]["path"]}],
                           "target": {"node": ports[1]["id"], "field": ports[1]["fields"][0]["path"]},
                           "evidence": [file_evidence(snapshot.files[0])]} for kind in ["value_dependency", "condition_dependency"]]
        validate_graph(graph, snapshot)
        asset = next(node for node in graph["nodes"] if node["kind"] == "asset")
        graph["edges"][0]["target"] = {"node": asset["id"]}
        with self.assertRaisesRegex(PluginError, "requires_ports"):
            validate_graph(graph, snapshot)

    def test_legacy_adapter_keeps_exact_analysis_and_does_not_execute_source(self):
        (self.root / "job.py").write_text("raise RuntimeError('must never execute')\ndef run(rows):\n    return rows\n")
        (self.root / "query.sql").write_text("SELECT price * quantity AS total FROM sales.orders;\n")
        snapshot = capture_snapshot(self.root, ["job.py", "query.sql"], source_id="legacy-dev")
        expected = analyze_snapshot(snapshot).to_dict()
        result = self.registry.analyze("legacy-static", snapshot, {})
        self.assertEqual(result["graph"]["legacyAnalysis"], expected)
        self.assertFalse(result["coverageComplete"])

    def test_cli_uses_registered_plugin_without_publication(self):
        self.capture()
        stream = io.StringIO()
        with redirect_stdout(stream):
            code = main(["plugin-analyze", "--plugin", "openapi-operations", "--root", str(self.root),
                         "--source-id", "orders-dev", "--path", "api.json", "--config-json", '{"serviceId":"orders"}'])
        result = json.loads(stream.getvalue())
        self.assertEqual(code, 0)
        self.assertEqual(result["contractDigest"], contract_digest())
        self.assertFalse(result["publicationAuthorized"])
        with redirect_stdout(io.StringIO()):
            self.assertEqual(main(["plugin-analyze", "--plugin", "not-registered", "--root", "/missing", "--source-id", "x", "--path", "a.json"]), 2)


if __name__ == "__main__":
    unittest.main()

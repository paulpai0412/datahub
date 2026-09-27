"""Offline synthetic regressions, not deployment/ACL/publication acceptance."""
from copy import deepcopy
from pathlib import Path
from typing import Any
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "extensions/dataflow-discovery/src"))
from dataflow_discovery.api_native import compile_api_draft, compare_api_draft
from dataflow_discovery.candidate_protocol import snapshot_input, validate_candidate_output
from dataflow_discovery.plugin_api import PluginError, canonical, digest, node_id
from dataflow_discovery.plugins.openapi import MANIFEST
from dataflow_discovery.snapshot import capture_snapshot

HEADER = 'openapi: "3.0.0"\ninfo: {title: Fixture, version: "1"}\npaths:\n  /unit:\n'
BLOCK = '''    post:
      requestBody:
        required: false
        content:
          application/json:
            schema:
              type: string
      responses:
        "201":
          description: ok
          content:
            application/json:
              schema:
                type: integer
'''


class NativeApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.context = {"tenantId": "unit-tenant", "sourceId": "unit-source", "serviceId": "unit-service"}
        self.input, self.result = self.fixture()

    def fixture(self, text=None, source="unit-source", service="unit-service", blocks=1):
        text = HEADER + BLOCK if text is None else text
        (self.root / "api.yaml").write_text(text)
        snapshot = capture_snapshot(self.root, ["api.yaml"], source_id=source)
        manifest = deepcopy(MANIFEST)
        manifest.update(id="synthetic-yaml-ir", suffixes=[".yaml"])
        value = snapshot_input(snapshot, manifest, {"serviceId": service})
        nodes = []
        # Explicit independent fixture spans. No mapper helper or candidate code
        # generates the IR. Each block has fixed 14-line layout.
        for b in range(blocks):
            offset = b * 14
            asset_id = node_id(source, "asset", f"opaque-{b}")
            for kind, suffix, start, end, extra in (
                ("asset", "", 6 + offset, 18 + offset, {"assetType": "api"}),
                ("port", "in", 11 + offset, 11 + offset, {"owner": asset_id, "direction": "input", "fields": [{"path": "/", "nativeType": "string"}]}),
                ("port", "out", 18 + offset, 18 + offset, {"owner": asset_id, "direction": "output", "fields": [{"path": "/", "nativeType": "integer"}]}),
            ):
                local = f"opaque-{b}" + suffix
                nodes.append({"id": node_id(source, kind, local), "kind": kind, "localId": local,
                              "name": "UNTRUSTED DELETE /wrong-name", **extra,
                              "evidence": [{"path": "api.yaml", "fileSha256": snapshot.files[0].sha256, "startLine": start, "endLine": end}]})
        graph = {"nodes": nodes, "edges": [], "coverage": [{"path": "api.yaml", "state": "analyzed", "reason": "synthetic"}], "findings": []}
        return value, validate_candidate_output(value, canonical({"graph": graph}))

    def draft(self, value=None, result=None, context=None):
        return compile_api_draft(self.input if value is None else value, self.result if result is None else result,
                                 self.context if context is None else context)

    def changed_graph(self, change):
        graph = deepcopy(self.result["graph"])
        change(graph)
        return validate_candidate_output(self.input, canonical({"graph": graph}))

    def test_native_aspects_use_source_not_names_and_roundtrip_public_sdk(self):
        from datahub.metadata.schema_classes import ApiPropertiesClass, ApiSignatureClass, RestApiPropertiesClass, SubTypesClass
        from datahub.metadata.urns import ApiUrn
        draft = self.draft()
        entity = draft["entities"][0]
        self.assertEqual(str(ApiUrn.from_string(entity["urn"])), entity["urn"])
        aspects = entity["desiredAspects"]
        self.assertEqual(aspects["restApiProperties"], {"method": "POST", "path": "/unit"})
        self.assertEqual(aspects["apiProperties"], {"name": "POST /unit"})
        self.assertEqual(aspects["subTypes"], {"typeNames": ["REST_ENDPOINT"]})
        sig = ApiSignatureClass.from_obj(aspects["apiSignature"])
        self.assertEqual(sig.schemaDefinition, HEADER + BLOCK)
        assert sig.inputFields is not None and sig.outputFields is not None
        self.assertEqual(sig.inputFields[0].nativeDataType, "string")
        self.assertEqual(sig.outputFields[0].nativeDataType, "integer")
        self.assertTrue(sig.inputFields[0].nullable)  # optional body, not nullable schema
        self.assertFalse(sig.outputFields[0].nullable)
        for cls in (ApiPropertiesClass, ApiSignatureClass, RestApiPropertiesClass, SubTypesClass):
            restored = cls.from_obj(aspects[cls.ASPECT_NAME])
            self.assertTrue(restored.validate())
            self.assertEqual(restored.to_obj(), aspects[cls.ASPECT_NAME])
        self.assertFalse(draft["publicationAuthorized"])
        self.assertFalse(draft["runtimeVerified"])
        self.assertNotIn("lineage", aspects)
        self.assertEqual(draft, self.draft())

    def test_namespace_method_and_case_identity_are_separate_from_versions(self):
        first = self.draft()["entities"][0]["urn"]
        other_tenant = self.draft(context={**self.context, "tenantId": "other"})["entities"][0]["urn"]
        others = {first, other_tenant}
        for text in (HEADER + BLOCK.replace("    post:", "    get:"), HEADER.replace("/unit:", "/Unit:") + BLOCK):
            inp, res = self.fixture(text)
            others.add(self.draft(inp, res)["entities"][0]["urn"])
        for source, service in (("other-source", "unit-service"), ("unit-source", "other-service")):
            inp, res = self.fixture(source=source, service=service)
            others.add(self.draft(inp, res, {**self.context, "sourceId": source, "serviceId": service})["entities"][0]["urn"])
        self.assertEqual(len(others), 6)
        inp, res = self.fixture((HEADER + BLOCK).replace("Fixture", "Renamed documentation"))
        self.assertEqual(self.draft(inp, res)["entities"][0]["urn"], first)
        inp["manifest"]["version"] = "0.9.9"
        res = validate_candidate_output(inp, canonical({"graph": res["graph"]}))
        self.assertEqual(self.draft(inp, res)["entities"][0]["urn"], first)

    def test_same_path_multiple_methods_not_first_method_only(self):
        inp, res = self.fixture(HEADER + BLOCK + BLOCK.replace("    post:", "    put:"), blocks=2)
        entities = self.draft(inp, res)["entities"]
        self.assertEqual({e["identity"]["method"] for e in entities}, {"POST", "PUT"})
        self.assertEqual(len({e["urn"] for e in entities}), 2)
        res["graph"]["nodes"] = res["graph"]["nodes"][:3]
        res = validate_candidate_output(inp, canonical({"graph": res["graph"]}))
        with self.assertRaisesRegex(PluginError, "subject_ambiguous_or_missing"):
            self.draft(inp, res)

    def test_required_body_and_nullable_schema_are_projected_without_losing_original(self):
        inp, res = self.fixture((HEADER + BLOCK).replace("required: false", "required: true"))
        self.assertFalse(self.draft(inp, res)["entities"][0]["desiredAspects"]["apiSignature"]["inputFields"][0]["nullable"])
        # Inline schema on the same evidence line retains exact fixture spans.
        text = (HEADER + BLOCK).replace("              type: string", "              type: string\n              nullable: true")
        inp, res = self.fixture(text)
        for node in res["graph"]["nodes"]:
            ev = node["evidence"][0]
            if node["kind"] == "asset" or node.get("direction") == "input":
                ev["endLine"] += 1
            else:
                ev["startLine"] += 1; ev["endLine"] += 1
        res = validate_candidate_output(inp, canonical({"graph": res["graph"]}))
        draft = self.draft(inp, res)
        self.assertTrue(draft["entities"][0]["portBindings"][0]["schemaNullable"])
        self.assertEqual(draft["entities"][0]["desiredAspects"]["apiSignature"]["schemaDefinition"], text)

    def test_all_scalar_types_keep_native_type_in_public_sdk_projection(self):
        for native in ("string", "integer", "number", "boolean"):
            inp, res = self.fixture((HEADER + BLOCK).replace("type: string", "type: " + native))
            res["graph"]["nodes"][1]["fields"][0]["nativeType"] = native
            res = validate_candidate_output(inp, canonical({"graph": res["graph"]}))
            fields = self.draft(inp, res)["entities"][0]["desiredAspects"]["apiSignature"]["inputFields"]
            self.assertEqual(fields[0]["nativeDataType"], native)

    def test_multiple_response_statuses_are_not_collapsed_to_first(self):
        text = HEADER + BLOCK + '        "400":\n          description: error\n'
        inp, res = self.fixture(text)
        res["graph"]["nodes"][0]["evidence"][0]["endLine"] = 20
        res = validate_candidate_output(inp, canonical({"graph": res["graph"]}))
        with self.assertRaisesRegex(PluginError, "multiple_responses"):
            self.draft(inp, res)
        with patch("dataflow_discovery.api_native.MAX_RESULT_BYTES", 1), self.assertRaisesRegex(PluginError, "draft_too_large"):
            self.draft()

    def test_drift_scope_and_forged_receipt_flags_rejected(self):
        for field in ("sourceId", "serviceId"):
            with self.subTest(field=field), self.assertRaisesRegex(PluginError, "scope_mismatch"):
                self.draft(context={**self.context, field: "not-allowed"})
        for field, value in (("publicationAuthorized", True), ("runtimeVerified", True), ("resultDigest", "0" * 64)):
            with self.subTest(field=field), self.assertRaisesRegex(PluginError, "result_mismatch"):
                self.draft(result={**self.result, field: value})
        inp = deepcopy(self.input); inp["files"][0]["text"] += "# drift\n"
        with self.assertRaises(PluginError):
            self.draft(value=inp)
        invalid_contexts: list[Any] = [None, [], {**self.context, "approval": True}]
        for bad in invalid_contexts:
            with self.assertRaises(PluginError):
                compile_api_draft(self.input, self.result, bad)

    def test_typed_fields_directions_and_evidence_must_match_source(self):
        def wrong_type(g): g["nodes"][1]["fields"][0]["nativeType"] = "boolean"
        def wrong_nullable(g): g["nodes"][1]["fields"][0]["nullable"] = True
        def wrong_direction(g): g["nodes"][1]["direction"] = "output"
        def wide_evidence(g): g["nodes"][1]["evidence"][0]["startLine"] = 1
        def remove_output(g): g["nodes"].pop()
        for change in (wrong_type, wrong_nullable, wrong_direction, wide_evidence, remove_output):
            with self.subTest(change=change.__name__), self.assertRaises(PluginError):
                self.draft(result=self.changed_graph(change))

    def test_incomplete_or_duplicate_ir_not_silently_published(self):
        def finding(g): g["findings"].append({"code": "unsupported_part", "evidence": g["nodes"][0]["evidence"]})
        def extra(g):
            node = deepcopy(g["nodes"][0]); node["localId"] = "extra"; node["id"] = node_id("unit-source", "asset", "extra"); g["nodes"].append(node)
        for change in (finding, extra):
            with self.assertRaises(PluginError):
                self.draft(result=self.changed_graph(change))

    def test_unsupported_yaml_or_schema_never_executes_or_resolves(self):
        texts = [
            (HEADER + BLOCK).replace("type: string", "$ref: https://invalid.example/no-network"),
            (HEADER + BLOCK).replace("type: string", "type: array"),
            (HEADER + BLOCK).replace("type: string", "type: !!python/object/apply:os.system [never]"),
            (HEADER + BLOCK).replace("type: string", "type: &a [*a]"),
            (HEADER + BLOCK).replace("type: string", "type: string\n              type: boolean"),
            (HEADER + BLOCK).replace('"3.0.0"', '"3.1.0"'),
            (HEADER + BLOCK).replace("application/json:", "text/plain:"),
        ]
        with patch("urllib.request.urlopen", side_effect=AssertionError("network forbidden")), patch("subprocess.Popen", side_effect=AssertionError("execution forbidden")):
            for text in texts:
                with self.subTest(text=text), self.assertRaises(PluginError):
                    inp, res = self.fixture(text)
                    self.draft(inp, res)

    def test_diff_never_infers_absence_and_conflicts_preserve_existing_values(self):
        draft = self.draft(); entity = draft["entities"][0]; urn = entity["urn"]
        unknown = compare_api_draft(draft)
        self.assertEqual({c["state"] for c in unknown["changes"]}, {"CATALOG_UNOBSERVED"})
        new = compare_api_draft(draft, {urn: {"headStatus": 404, "aspects": {}}})
        self.assertEqual({c["state"] for c in new["changes"]}, {"CONDITIONAL_NEW"})
        old = deepcopy(entity["desiredAspects"])
        same = compare_api_draft(draft, {urn: {"headStatus": 204, "aspects": old}})
        self.assertEqual({c["state"] for c in same["changes"]}, {"UNCHANGED"})
        old["apiProperties"]["description"] = "human-owned documentation"
        before = deepcopy(old)
        different = compare_api_draft(draft, {urn: {"headStatus": 204, "aspects": old}})
        conflict = next(c for c in different["changes"] if c["state"] == "CONFLICT")
        self.assertEqual(conflict["before"]["description"], "human-owned documentation")
        self.assertEqual(old, before)
        self.assertEqual({c["state"] for c in compare_api_draft(draft, {urn: {"headStatus": 204, "aspects": {}}})["changes"]}, {"ASPECT_UNOBSERVED"})
        for result in (unknown, new, same, different):
            self.assertFalse(result["publicationAuthorized"])
            self.assertFalse(result["liveReadbackVerified"])

    def test_key_only_get_no_head_or_contradictory_absence_cannot_be_diff_baseline(self):
        draft = self.draft(); urn = draft["entities"][0]["urn"]
        for value in ({"getStatus": 200, "aspects": {"apiKey": {"id": "synthetic"}}},
                      {"headStatus": 404, "aspects": {"apiKey": {}}},
                      {"headStatus": 401, "aspects": {}}, {"headStatus": 500, "aspects": {}}):
            with self.assertRaises(PluginError): compare_api_draft(draft, {urn: value})
        with self.assertRaises(PluginError): compare_api_draft(draft, {"urn:li:api:other": {}})
        draft["entities"][0]["desiredAspects"]["apiProperties"]["name"] = "drift"
        with self.assertRaises(PluginError): compare_api_draft(draft)

    def test_cli_consumes_only_json_artifacts_and_remains_an_offline_draft(self):
        a, b = self.root / "input.json", self.root / "result.json"
        a.write_bytes(canonical({"status": "PASS", "result": self.input}))
        b.write_bytes(canonical({"status": "PASS", "result": self.result}))
        command = [sys.executable, "-I", "-B", str(ROOT / "scripts/draft-discovery-api.py"), "--prepared-input", str(a),
                   "--validated-result", str(b), "--tenant-id", "unit-tenant", "--source-id", "unit-source", "--service-id", "unit-service"]
        run = subprocess.run(command, capture_output=True, text=True, timeout=20)
        self.assertEqual(run.returncode, 0, run.stderr)
        import json
        output = json.loads(run.stdout)
        self.assertEqual(output["draft"], self.draft())
        a.write_text('{"status":"PASS","status":"FAIL","result":{}}')
        bad = subprocess.run(command, capture_output=True, text=True, timeout=20)
        self.assertEqual(bad.returncode, 2)
        self.assertEqual(json.loads(bad.stdout)["code"], "api_draft_input_invalid")


if __name__ == "__main__":
    unittest.main()

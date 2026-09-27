"""Adapter regressions only; real-source/Host/browser evidence is separate."""
from pathlib import Path
import json
import io
import contextlib
from unittest.mock import patch
import tempfile
import unittest

from dataflow_discovery.plugin_api import PluginError, digest
from dataflow_discovery.plugin_workspace import analyze_workspace_selection, list_workspace_plugins
from dataflow_discovery import bridge
from dataflow_discovery.workspace import analyze_workspace
from tests.test_discovery_plugin_contract import specification


class PluginWorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "api.json").write_text(json.dumps(specification()))
        self.policy = {"workspace": True, "modelContextApproved": True, "root": str(self.root),
                       "sourceId": "workspace-regression", "catalogScopes": {}}
        self.request = {"selection": ".", "pluginId": "openapi-operations", "pluginConfig": {"serviceId": "orders"}}

    def test_list_comes_from_registry_and_exposes_full_legacy_adapter(self):
        listing = list_workspace_plugins()
        plugins = {item["manifest"]["id"]: item for item in listing["plugins"]}
        self.assertEqual(plugins["legacy-static"]["previewFormat"], "datahub-etl.preview/3")
        self.assertEqual(plugins["openapi-operations"]["previewFormat"], "dataflow-discovery.plugin-preview/1")
        self.assertEqual(plugins["openapi-operations"]["manifest"]["configSchema"]["required"], ["serviceId"])
        self.assertFalse(listing["publicationAuthorized"])

    def test_source_selection_produces_source_bound_neutral_preview(self):
        preview = analyze_workspace_selection(self.policy, self.request)
        self.assertEqual(preview["format"], "dataflow-discovery.plugin-preview/1")
        self.assertEqual(preview["manifest"]["snapshot"]["sha256"], preview["result"]["snapshotSha256"])
        self.assertEqual(preview["snapshotSha256"], preview["result"]["snapshotSha256"])
        result = dict(preview["result"])
        claimed = result.pop("resultDigest")
        self.assertEqual(claimed, digest(result))
        self.assertEqual({node["name"] for node in result["graph"]["nodes"] if node["kind"] == "asset"},
                         {"GET /orders/{id}", "POST /orders/{id}"})
        self.assertFalse(preview["complete"])
        self.assertFalse(preview["publicationAuthorized"])
        self.assertFalse(result["runtimeVerified"])

    def test_internal_contract_and_source_capture_bridge_are_data_only(self):
        def call(payload):
            stream = io.TextIOWrapper(io.BytesIO(json.dumps(payload).encode()))
            output = io.StringIO()
            with patch.object(bridge.sys, "stdin", stream), contextlib.redirect_stdout(output):
                status = bridge.main()
            return status, json.loads(output.getvalue())

        status, contract = call({"operation": "plugin_development_contract"})
        self.assertEqual(status, 0)
        self.assertEqual(contract["contractDigest"], list_workspace_plugins()["contractDigest"])
        self.assertEqual({file["name"] for file in contract["files"]},
                         {"README.md", "manifest.schema.json", "graph.schema.json"})
        (self.root / "do-not-run.py").write_text('raise AssertionError("source executed")\n')
        payload = {"operation": "plugin_workspace_input", "policy": self.policy, "request": {"selection": "."}}
        status, captured = call(payload)
        self.assertEqual(status, 0)
        self.assertEqual(captured["format"], "dataflow-discovery.plugin-input/1")
        self.assertNotIn(str(self.root), json.dumps(captured["source"]))
        self.assertEqual({item["path"] for item in captured["source"]["files"]}, {"api.json", "do-not-run.py"})
        self.assertEqual(captured["snapshotSha256"], captured["manifest"]["snapshot"]["sha256"])
        status, rejected = call({**payload, "request": {"selection": ".", "snapshotSha256": "0" * 64}})
        self.assertEqual((status, rejected["error"]), (2, "workspace_source_drift"))
        status, _ = call({**payload, "policy": {**self.policy, "modelContextApproved": False}})
        self.assertEqual(status, 2)
        status, _ = call({**payload, "catalog": {}})
        self.assertEqual(status, 2)

    def test_legacy_default_and_explicit_selection_keep_original_full_adapter(self):
        (self.root / "job.py").write_text('raise AssertionError("never import source")\ndef main():\n    pass\n')
        expected = analyze_workspace(self.policy, {"selection": "."})
        self.assertEqual(expected, analyze_workspace_selection(self.policy, {"selection": "."}))
        self.assertEqual(expected, analyze_workspace_selection(self.policy, {"selection": ".", "pluginId": "legacy-static", "pluginConfig": {}}))
        self.assertEqual(expected["format"], "datahub-etl.preview/3")
        self.assertNotIn("legacyAnalysis", expected)

    def test_unknown_plugin_is_not_a_legacy_fallback(self):
        with self.assertRaisesRegex(PluginError, "plugin_not_registered"):
            analyze_workspace_selection({**self.policy, "root": "/not-a-source"}, {**self.request, "pluginId": "unknown"})

    def test_config_and_python_connection_choices_are_not_silently_ignored(self):
        with self.assertRaisesRegex(PluginError, "plugin_schema_invalid"):
            analyze_workspace_selection(self.policy, {**self.request, "pluginConfig": {}})
        with self.assertRaisesRegex(PluginError, "plugin_workspace_request_rejected"):
            analyze_workspace_selection(self.policy, {**self.request, "connections": {}})
        with self.assertRaisesRegex(PluginError, "plugin_workspace_request_rejected"):
            analyze_workspace_selection(self.policy, {"selection": ".", "pluginConfig": {"serviceId": "ignored"}})

    def test_new_plugin_remains_preview_only(self):
        with self.assertRaisesRegex(PluginError, "plugin_preview_only"):
            analyze_workspace_selection(self.policy, self.request, compile_native=True)

    def test_snapshot_drift_rejected_and_unsupported_files_remain_in_denominator(self):
        first = analyze_workspace_selection(self.policy, self.request)
        (self.root / "notes.md").write_text("Not an API declaration.")
        with self.assertRaisesRegex(ValueError, "workspace_source_drift"):
            analyze_workspace_selection(self.policy, {**self.request, "snapshotSha256": first["snapshotSha256"]})
        result = analyze_workspace_selection(self.policy, self.request)["result"]
        self.assertFalse(result["coverageComplete"])
        self.assertEqual(len(result["graph"]["coverage"]), 2)
        self.assertTrue(result["graph"]["findings"])


if __name__ == "__main__":
    unittest.main()

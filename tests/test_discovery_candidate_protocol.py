"""Protocol unit checks only; synthetic documents are NOT live/E2E evidence."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "extensions/dataflow-discovery/src"))
from dataflow_discovery.candidate_protocol import (
    MAX_OUTPUT_BYTES, decode_input, snapshot_input, validate_candidate_output,
)
from dataflow_discovery.plugin_api import PluginError, canonical
from dataflow_discovery.plugins.registry import builtin_registry
from dataflow_discovery.snapshot import capture_snapshot


class CandidateProtocolTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        (root / "api.json").write_text(json.dumps({
            "openapi": "3.0.0", "info": {"title": "protocol unit input", "version": "1"},
            "paths": {"/unit": {"get": {"responses": {"200": {
                "description": "unit", "content": {"application/json": {"schema": {"type": "string"}}},
            }}}}},
        }))
        self.snapshot = capture_snapshot(root, ["api.json"], source_id="protocol-unit")
        self.registry = builtin_registry()
        self.manifest = next(item for item in self.registry.manifests() if item["id"] == "openapi-operations")
        self.config = {"serviceId": "unit"}
        self.input = snapshot_input(self.snapshot, self.manifest, self.config)
        self.result = self.registry.analyze(self.manifest["id"], self.snapshot, self.config)

    def test_round_trip_and_separate_validation_preserve_existing_result(self):
        snapshot, manifest, config = decode_input(self.input)
        self.assertEqual(snapshot, self.snapshot)
        self.assertEqual(manifest, self.manifest)
        self.assertEqual(config, self.config)
        result = validate_candidate_output(self.input, canonical({"graph": self.result["graph"]}))
        self.assertEqual(result, self.result)
        self.assertFalse(result["publicationAuthorized"])
        self.assertFalse(result["runtimeVerified"])
        self.assertNotIn(self.directory.name.encode("utf-8"), canonical(self.input))

    def test_input_is_detached_and_unknown_paths_or_capture_authority_are_rejected(self):
        self.config["serviceId"] = "changed"
        self.assertEqual(self.input["config"], {"serviceId": "unit"})
        for change in (
            lambda value: value.update(root="/unapproved"),
            lambda value: value["files"][0].update(path="../outside.json"),
            lambda value: value["files"][0].update(text="tampered"),
            lambda value: value["files"][0].update(extra="not-a-source-field"),
        ):
            value = json.loads(canonical(self.input))
            change(value)
            with self.assertRaises(PluginError):
                decode_input(value)

    def test_worker_pass_flags_receipts_and_overlong_output_have_no_authority(self):
        for output in (
            canonical({"status": "PASS", "graph": self.result["graph"]}),
            canonical(self.result),
            canonical({"graph": self.result["graph"], "publicationAuthorized": True}),
            b" " * (MAX_OUTPUT_BYTES + 1),
            b'{"graph":{},"graph":{}}',
            b'{"graph":{"n":NaN}}',
            b"\xff",
        ):
            with self.assertRaises(PluginError):
                validate_candidate_output(self.input, output)

    def test_original_host_snapshot_not_worker_claims_controls_evidence(self):
        graph = json.loads(canonical(self.result["graph"]))
        graph["nodes"][0]["evidence"][0]["fileSha256"] = "0" * 64
        with self.assertRaises(PluginError):
            validate_candidate_output(self.input, canonical({"graph": graph}))
        graph = json.loads(canonical(self.result["graph"]))
        graph["coverage"] = []
        with self.assertRaises(PluginError):
            validate_candidate_output(self.input, canonical({"graph": graph}))

    def test_worker_refuses_ordinary_host_uid_before_profile_or_candidate_import(self):
        # Load only our reviewed ENTRYPOINT, never a candidate implementation.
        filename = ROOT / "extensions/dataflow-discovery/testing/candidate_worker.py"
        spec = importlib.util.spec_from_file_location("_trusted_worker_entrypoint", filename)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with patch.object(module.os, "getuid", return_value=1000), patch.object(
            module.importlib.util, "spec_from_file_location", side_effect=AssertionError("must not load any code")
        ):
            self.assertEqual(module.main(), 2)


if __name__ == "__main__":
    unittest.main()

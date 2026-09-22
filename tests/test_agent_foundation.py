"""Offline checks: full source baseline and shared connector schema contract.

Run: .venv/bin/python tests/test_agent_foundation.py
No ingestion pipeline, plugin installation, credentials or live endpoints.
"""

from copy import deepcopy
import hashlib
from importlib import import_module
from importlib.metadata import version
import json
from pathlib import Path
import sys
import subprocess
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
EXTENSION = ROOT / "extensions/datahub-agent"
sys.path.insert(0, str(EXTENSION / "integration"))

catalog_module = import_module("connector_catalog")
CatalogError = catalog_module.CatalogError
ConnectorCatalog = catalog_module.ConnectorCatalog


class FoundationChecks(unittest.TestCase):
    def test_complete_upstream_snapshot(self):
        lock = json.loads((EXTENSION / "pi-web-upstream.lock.json").read_text())
        source = EXTENSION / lock["source_directory"]
        for entry in lock["files"]:
            path = source / entry["path"]
            data = path.read_bytes()
            self.assertEqual(hashlib.sha256(data).hexdigest(), entry["sha256"], entry["path"])
            # Delegate Git object-format compatibility to Git; retain SHA-256 above.
            git_blob = subprocess.run(
                ["git", "hash-object", "--stdin"], input=data,
                capture_output=True, check=True,
            ).stdout.decode().strip()
            self.assertEqual(git_blob, entry["git_blob"], entry["path"])
            self.assertEqual(path.stat().st_mode & 0o777, int(entry["mode"][-3:], 8), entry["path"])
        # License, lockfile and non-UI source must not get lost during import.
        for name in ["LICENSE", "package-lock.json", "app", "lib", "hooks", "public", "bin", "e2e"]:
            self.assertTrue((source / name).exists(), name)

    def test_shared_contract_and_fail_closed_cases(self):
        entry = {
            "id": "reviewed-custom", "version": "fixture-1",
            "config_schema": {
                "type": "object", "additionalProperties": False,
                "required": ["limit"],
                "properties": {
                    "limit": {"type": "integer", "minimum": 1},
                    "nested": {"$ref": "#/$defs/nested"},
                },
                "$defs": {"nested": {"type": "array", "items": {"type": "string"}}},
            },
        }
        original = deepcopy(entry)
        catalog = ConnectorCatalog([entry])
        descriptor = catalog.get_connector_schema(entry["id"])
        fingerprint = descriptor["schema_fingerprint"]
        entry["config_schema"].clear()
        descriptor["config_schema"].clear()
        self.assertEqual(catalog.get_connector_schema(entry["id"])["config_schema"], original["config_schema"])
        self.assertNotIn("config_schema", catalog.list_connectors()[0])

        def validate(config, expected=fingerprint):
            return catalog.validate_source_config("reviewed-custom", config, schema_fingerprint=expected)

        with patch("urllib.request.urlopen", side_effect=AssertionError("network forbidden")), patch(
            "socket.create_connection", side_effect=AssertionError("network forbidden")
        ):
            result = validate({"limit": 1, "nested": ["ok"]})
            self.assertEqual(result["status"], "schema_valid")
            self.assertEqual(result["validation_level"], "json_schema_only")
            for config in [{}, {"limit": True}, {"limit": 0}, {"limit": 1, "nested": [42]}]:
                self.assertEqual(validate(config)["status"], "invalid")
            sentinel = "PRIVATE_TEST_VALUE_NOT_A_REAL_SECRET"
            invalid = validate({"limit": sentinel, sentinel: sentinel})
            self.assertEqual(invalid["status"], "invalid")
            self.assertNotIn(sentinel, json.dumps(invalid))
            many = validate({"limit": 1, "nested": [1] * 40})
            self.assertEqual(len(many["errors"]), 20)
            self.assertTrue(many["errors_truncated"])
            for config in [None, [], float("nan"), {"limit": object()}, {"limit": "a" * (1024 * 1024)}]:
                with self.assertRaisesRegex(CatalogError, "^invalid_config_document$"):
                    validate(config)
            with self.assertRaisesRegex(CatalogError, "^stale_connector_schema$"):
                validate({"limit": 1}, "stale")
            for connector in ["unknown", "os.system", "module:Class", [], None]:
                with self.assertRaisesRegex(CatalogError, "^connector_not_allowed$"):
                    catalog.get_connector_schema(connector)

        updated = deepcopy(original)
        updated["version"] = "fixture-2"
        self.assertNotEqual(ConnectorCatalog([updated]).list_connectors()[0]["schema_fingerprint"], fingerprint)
        updated = deepcopy(original)
        updated["config_schema"]["properties"]["limit"]["minimum"] = 2
        self.assertNotEqual(ConnectorCatalog([updated]).list_connectors()[0]["schema_fingerprint"], fingerprint)
        with self.assertRaisesRegex(CatalogError, "^duplicate_connector_id$"):
            ConnectorCatalog([original, original])
        for schema in [
            {"$ref": "https://example.invalid/schema"},
            {"$defs": {"x": {"$id": "https://example.invalid/schema"}}},
            {"$dynamicRef": "file:///private"},
        ]:
            with self.assertRaisesRegex(CatalogError, "^external_schema_reference_forbidden$"):
                ConnectorCatalog([{**original, "config_schema": schema}])
        with self.assertRaisesRegex(CatalogError, "^unsupported_schema_dialect$"):
            ConnectorCatalog([{**original, "config_schema": {"$schema": "unknown"}}])
        with self.assertRaisesRegex(CatalogError, "^invalid_connector_schema$"):
            ConnectorCatalog([{**original, "config_schema": {"type": "not-a-type"}}])
        broken = ConnectorCatalog([{**original, "config_schema": {"$ref": "#/$defs/missing"}}])
        with self.assertRaisesRegex(CatalogError, "^connector_schema_unavailable$"):
            broken.validate_source_config("reviewed-custom", {}, schema_fingerprint=broken.list_connectors()[0]["schema_fingerprint"])

    def test_official_mssql_schema_without_source_execution(self):
        # Installed, previously used first-party SDK: obtain its config schema only.
        sdk = import_module("datahub.ingestion.source.sql.mssql.source")
        SQLServerConfig = sdk.SQLServerConfig

        catalog = ConnectorCatalog([{
            "id": "mssql", "version": version("acryl-datahub"),
            "config_schema": SQLServerConfig.model_json_schema(),
        }])
        fingerprint = catalog.get_connector_schema("mssql")["schema_fingerprint"]
        with patch.object(SQLServerConfig, "model_validate", side_effect=AssertionError("SDK validators forbidden")):
            valid = catalog.validate_source_config("mssql", {
                "host_port": "db.example.invalid:1433", "database": "fixture",
                "include_tables": True,
            }, schema_fingerprint=fingerprint)
            invalid = catalog.validate_source_config("mssql", {
                "host_port": ["not a string"], "invented_option": True,
            }, schema_fingerprint=fingerprint)
        self.assertEqual(valid["status"], "schema_valid")
        self.assertEqual(invalid["status"], "invalid")
        self.assertEqual(valid["validation_level"], "json_schema_only")


if __name__ == "__main__":
    unittest.main(verbosity=2)

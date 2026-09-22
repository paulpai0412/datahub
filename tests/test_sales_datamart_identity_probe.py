"""Operator protocol tests: fake identities/secrets, no Docker or database calls."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("identity_probe", ROOT / "scripts/probe-sales-datamart-identity.py")
assert SPEC and SPEC.loader
probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)


class IdentityProbeTests(unittest.TestCase):
    def test_explicit_flag_required(self):
        result = subprocess.run([sys.executable, str(ROOT / "scripts/probe-sales-datamart-identity.py")], capture_output=True)
        self.assertEqual(result.returncode, 2)

    def test_private_key_selection_without_shell_evaluation(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "keys.env"
            path.write_text("UNRELATED=not-selected\nKEY='$(not-a-command)'\n")
            path.chmod(0o600)
            self.assertEqual(probe.secret(path, "KEY"), "$(not-a-command)")
            path.chmod(0o644)
            with self.assertRaisesRegex(probe.ProbeError, "secret_file_permissions"):
                probe.secret(path, "KEY")

    def test_duplicate_missing_and_symlink_secret_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "keys.env"
            path.write_text("KEY=fake-one\nKEY=fake-two\n")
            path.chmod(0o600)
            with self.assertRaisesRegex(probe.ProbeError, "duplicate_secret_key"):
                probe.secret(path, "KEY")
            with self.assertRaisesRegex(probe.ProbeError, "secret_key_missing"):
                probe.secret(path, "OTHER")
            link = Path(directory) / "link"
            link.symlink_to(path)
            with self.assertRaises(OSError):
                probe.secret(link, "KEY")

    def test_identity_requires_database_principal_and_instance(self):
        row = {"database_name": "CaseDB", "database_id": 5, "original_login": "reader", "login_name": "reader",
               "database_user": "reader", "machine_name": "sql-host", "server_name": "sql-host", "product_version": "15.0.1"}
        probe.verify_identity(row, database="CaseDB", principal="reader", hostname="SQL-HOST")
        for key, value in [("database_name", "Other"), ("database_id", True), ("login_name", "other"), ("database_user", "dbo"), ("machine_name", "other"), ("product_version", "16.0.1")]:
            with self.subTest(key=key), self.assertRaises(probe.ProbeError):
                probe.verify_identity({**row, key: value}, database="CaseDB", principal="reader", hostname="sql-host")

    def test_worker_replay_rejected_before_preflight_import_or_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            receipt = Path(directory) / "receipt.json"
            for value in [{"status": "CURRENT_CONFIGURED_CONNECTION_IDENTITIES_VERIFIED"}, {"status": "PROBE_STARTED", "attempted": {"source": True}}]:
                receipt.write_text(json.dumps(value))
                with patch.object(probe, "RECEIPT", receipt), patch.object(probe, "preflight") as check, patch.object(probe, "secret") as secret:
                    with self.assertRaisesRegex(probe.ProbeError, "probe_cannot_be_replayed"):
                        probe.worker()
                    check.assert_not_called()
                    secret.assert_not_called()

    def test_parent_timeout_keeps_receipt_and_does_not_forward_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            receipt = base / "receipt.json"
            with patch.object(probe, "BASE", base), patch.object(probe, "ROOT", base), patch.object(probe, "RECEIPT", receipt), patch.object(probe, "preflight"), patch.object(sys, "argv", ["probe", "--execute-approved-probe"]), patch.dict(os.environ, {"MODEL_PRIVATE_TOKEN": "FAKE_NOT_FORWARDABLE"}), patch.object(probe.subprocess, "run", side_effect=subprocess.TimeoutExpired("worker", 60)) as run:
                self.assertEqual(probe.main(), 1)
                env = run.call_args.kwargs["env"]
                self.assertNotIn("MODEL_PRIVATE_TOKEN", env)
                self.assertNotIn("DATAHUB_MSSQL_PASSWORD", env)
                self.assertEqual(json.loads(receipt.read_text())["status"], "INCOMPLETE_DO_NOT_REPLAY")
                self.assertEqual(receipt.stat().st_mode & 0o777, 0o600)
                with self.assertRaises(FileExistsError):
                    probe.main()
                self.assertEqual(run.call_count, 1)

    def test_malformed_approval_is_caught_by_real_cli_without_echo(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            script = root / "scripts/probe-sales-datamart-identity.py"
            script.parent.mkdir()
            script.write_bytes((ROOT / "scripts/probe-sales-datamart-identity.py").read_bytes())
            evidence = root / ".local/evidence/dataflow-discovery"
            evidence.mkdir(parents=True)
            (evidence / "identity-probe-approval-20260914.json").write_text("PRIVATE_SENTINEL invalid json")
            result = subprocess.run([sys.executable, str(script), "--preflight"], capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(json.loads(result.stderr)["failureCode"], "JSONDecodeError")
            self.assertNotIn("PRIVATE_SENTINEL", result.stdout + result.stderr)
            self.assertFalse((evidence / "identity-probe-run-20260914.json").exists())

    def test_query_scope_is_identity_only_and_targets_are_exact(self):
        self.assertEqual([item[1] for item in probe.TARGETS], ["AdventureWorks2019", "SalesDatamart"])
        self.assertEqual([item[2] for item in probe.TARGETS], ["datahub_ingest", "sales_datamart_loader"])
        self.assertNotIn(" FROM ", probe.QUERY.upper())
        for operation in ("INSERT ", "UPDATE ", "DELETE ", "CREATE ", "ALTER ", "EXEC "):
            self.assertNotIn(operation, probe.QUERY.upper())


if __name__ == "__main__":
    unittest.main()

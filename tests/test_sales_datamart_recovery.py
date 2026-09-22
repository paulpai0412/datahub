from __future__ import annotations

import hashlib
import importlib.util
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("sales_recovery", Path(__file__).resolve().parents[1] / "scripts/verify-sales-datamart-recovery.py")
assert spec and spec.loader
drill = importlib.util.module_from_spec(spec)
spec.loader.exec_module(drill)


class RecoveryProtocolTests(unittest.TestCase):
    def test_client_uses_explicit_loopback_and_does_not_put_password_in_argv(self) -> None:
        with patch.object(drill, "command", return_value="READY") as command:
            self.assertEqual(drill.query(drill.CLONE, "SELECT 'READY';"), "READY")
        shell = command.call_args.args[0][-1]
        self.assertIn("tcp:127.0.0.1,1433", shell)
        self.assertIn('SQLCMDPASSWORD="$MSSQL_SA_PASSWORD"', shell)
        self.assertNotIn("-P ", shell)

    def test_matching_partial_copy_is_reused_with_actual_image_uid_gid(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            backup = Path(directory) / "database.bak"
            backup.write_bytes(b"trusted synthetic backup fixture")
            digest = hashlib.sha256(backup.read_bytes()).hexdigest()
            calls = []
            def command(args, **kwargs):
                calls.append(args)
                if "sha256sum" in args:
                    return digest + "  backup.bak"
                if args[-2:] == ["id", "-u"]:
                    return "10001"
                if args[-2:] == ["id", "-g"]:
                    return "0"
                return ""
            with patch.object(drill.subprocess, "run", return_value=SimpleNamespace(returncode=0)), \
                 patch.object(drill, "command", side_effect=command), patch.object(drill, "query") as query:
                drill.restore_database("SalesDatamart", backup, [("SalesDatamart", "ROWS"), ("SalesDatamart_log", "LOG")])
            self.assertFalse(any(args[:2] == ["docker", "cp"] for args in calls))
            ownership = next(args for args in calls if "chown" in args)
            self.assertIn("10001:0", ownership)
            self.assertNotIn("mssql:mssql", ownership)
            statements = [call.args[1] for call in query.call_args_list]
            self.assertTrue(any("RESTORE VERIFYONLY" in sql for sql in statements))
            self.assertTrue(any("DBCC CHECKDB" in sql for sql in statements))
            self.assertFalse(any("REPLACE" in sql for sql in statements))

    def test_different_partial_copy_is_not_overwritten_or_restored(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            backup = Path(directory) / "database.bak"
            backup.write_bytes(b"expected fixture")
            with patch.object(drill.subprocess, "run", return_value=SimpleNamespace(returncode=0)), \
                 patch.object(drill, "command", return_value="0" * 64 + "  backup.bak") as command, \
                 patch.object(drill, "query") as query:
                with self.assertRaisesRegex(RuntimeError, "existing_backup_copy_mismatch"):
                    drill.restore_database("SalesDatamart", backup, [("SalesDatamart", "ROWS"), ("SalesDatamart_log", "LOG")])
            self.assertEqual(command.call_count, 1)
            self.assertEqual(query.call_count, 1)  # target-absence read only

    def test_existing_restore_target_stops_before_any_copy(self) -> None:
        with patch.object(drill, "query", side_effect=RuntimeError("restore_target_exists")), \
             patch.object(drill, "command") as command, patch.object(drill.subprocess, "run") as process:
            with self.assertRaisesRegex(RuntimeError, "restore_target_exists"):
                drill.restore_database("SalesDatamart", Path("unused.bak"), [])
        command.assert_not_called()
        process.assert_not_called()


if __name__ == "__main__":
    unittest.main()

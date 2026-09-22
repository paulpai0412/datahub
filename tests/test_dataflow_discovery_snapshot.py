"""Local filesystem checks only: no database, credentials, model or network."""

from __future__ import annotations

import hashlib
import importlib
import json
import os
import sys
import tempfile
import unittest
from contextlib import contextmanager
from dataclasses import FrozenInstanceError
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "extensions/dataflow-discovery/src"))
subject = importlib.import_module("dataflow_discovery.snapshot")
Limits = subject.Limits
SnapshotError = subject.SnapshotError
capture_snapshot = subject.capture_snapshot


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="discovery-snapshot-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "source"
        self.root.mkdir()

    def put(self, path: str, text: str = "value = 1\n") -> Path:
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")
        return target

    def capture(self, *paths: str, **kwargs):
        return capture_snapshot(self.root, paths, source_id="approved-example", **kwargs)

    def test_deterministic_capture_and_independent_manifest_hash(self):
        self.put("etl/job.py", "amount = quantity * price\n")
        self.put("sql/input.sql", 'SELECT "Amount" FROM "Sales";\n')
        first = self.capture("etl/job.py", "sql/input.sql")
        second = self.capture("sql/input.sql", "etl/job.py")
        self.assertEqual(first, second)
        manifest = first.manifest()
        digest = manifest.pop("sha256")
        raw = json.dumps(manifest, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
        self.assertEqual(hashlib.sha256(raw).hexdigest(), digest)
        self.assertEqual(manifest["revision_kind"], "content")
        self.assertNotIn(str(self.root), json.dumps(manifest))
        self.assertNotIn("amount =", json.dumps(manifest))
        self.assertFalse(any("commit" in k for k in manifest))

    def test_byte_digest_unicode_and_newlines(self):
        raw = 'SELECT "營業額" FROM "Orders";\r\n'.encode()
        self.put("query.sql").write_bytes(raw)
        file = self.capture("query.sql").files[0]
        self.assertEqual(file.text.encode(), raw)
        self.assertEqual(file.sha256, hashlib.sha256(raw).hexdigest())
        self.assertEqual(file.size_bytes, len(raw))

    def test_change_rename_and_source_identity_change_digest(self):
        file = self.put("job.py")
        original = self.capture("job.py")
        file.write_text("value = 2\n")
        changed = self.capture("job.py")
        file.rename(self.root / "renamed.py")
        renamed = self.capture("renamed.py")
        other_source = capture_snapshot(self.root, ["renamed.py"], source_id="different-source")
        self.assertEqual(len({s.sha256 for s in (original, changed, renamed, other_source)}), 4)
        self.assertEqual(original.files[0].text, "value = 1\n")
        with self.assertRaises(FrozenInstanceError):
            original.files[0].text = "changed"

    def test_only_explicit_files_and_no_source_execution_or_writes(self):
        marker = Path(self.temp.name) / "must-not-exist"
        program = f"from pathlib import Path\nPath({str(marker)!r}).touch()\n"
        file = self.put("job.py", program)
        self.put("unselected.py")
        file.chmod(0o444)
        before = file.stat()
        result = self.capture("job.py")
        after = file.stat()
        self.assertEqual(len(result.files), 1)
        self.assertEqual(file.read_text(), program)
        self.assertEqual((before.st_mode, before.st_size, before.st_mtime_ns), (after.st_mode, after.st_size, after.st_mtime_ns))
        self.assertFalse(marker.exists())
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), ["job.py", "unselected.py"])

    def test_invalid_paths_and_duplicate_scope(self):
        self.put("ok.py")
        for path in ("/ok.py", "../ok.py", "a/../ok.py", "a//ok.py", "./ok.py", "ok.py/", "a\\ok.py", "C:ok.py", "bad\x00.py"):
            with self.subTest(path=repr(path)), self.assertRaises(SnapshotError):
                self.capture(path)
        with self.assertRaisesRegex(SnapshotError, "duplicate_path"):
            self.capture("ok.py", "ok.py")
        with self.assertRaisesRegex(SnapshotError, "invalid_file_count"):
            capture_snapshot(self.root, "ok.py", source_id="approved-example")

    def test_sensitive_and_evaluation_paths_are_not_model_inputs(self):
        for path in (".env", ".local/result.json", "nested/.git/file.py", "db.credentials.json", "Secrets/config.yaml", "tests/golden.sql", "fixtures/output.json", "golden/mapping.json", "node_modules/lib.py", "query.bak"):
            self.put(path)
            with self.subTest(path=path), self.assertRaises(SnapshotError):
                self.capture(path)

    def test_secret_content_is_rejected_without_echo(self):
        cases = [
            'password = "synthetic-secret-for-test"\n',
            '{"token": "synthetic-secret-for-test"}',
            'password: synthetic-secret-for-test\n',
            'driver = "SERVER=localhost;PWD=synthetic-secret-for-test;DATABASE=x"\n',
            'url = "mssql://test:synthetic-secret-for-test@localhost/db"\n',
            '-----BEGIN PRIVATE KEY-----\nsynthetic-secret-for-test\n',
        ]
        for content in cases:
            self.put("config.yaml", content)
            with self.subTest(content_kind=cases.index(content)):
                try:
                    self.capture("config.yaml")
                except SnapshotError as error:
                    self.assertEqual(str(error), "sensitive_content")
                else:
                    self.fail("sensitive source was accepted")

    def test_empty_and_explicit_environment_references_are_not_secrets(self):
        self.put("config.json", '{"password": "${SOURCE_PASSWORD}", "token": "", "authorization": "Bearer ${READER_TOKEN}"}')
        self.put("job.py", 'password = os.environ["SOURCE_PASSWORD"]\n')
        self.put("config.yaml", 'password:\nconnection: localhost\ntoken: null\n')
        self.put("provision.sql", "CREATE LOGIN x WITH PASSWORD = '$(LOADER_PASSWORD)';\n")
        self.assertEqual(len(self.capture("config.json", "config.yaml", "job.py", "provision.sql").files), 4)

    def test_non_text_and_missing_sources_reject_without_host_path(self):
        for raw, expected in ((b"\xff", "non_utf8_source"), (b"a\x00b", "binary_source")):
            self.put("bad.py").write_bytes(raw)
            with self.assertRaisesRegex(SnapshotError, expected):
                self.capture("bad.py")
        with self.assertRaises(SnapshotError) as caught:
            self.capture("missing.py")
        self.assertEqual(str(caught.exception), "source_unavailable_or_symlink")
        self.assertNotIn(str(self.root), str(caught.exception))

    def test_limits_exact_boundary_and_multifile_total(self):
        self.put("a.py", "1234")
        self.put("b.py", "5678")
        self.assertEqual(len(self.capture("a.py", "b.py", limits=Limits(2, 4, 8)).files), 2)
        for limits, paths, expected in (
            (Limits(1, 4, 8), ("a.py", "b.py"), "invalid_file_count"),
            (Limits(2, 3, 8), ("a.py",), "file_too_large"),
            (Limits(2, 4, 7), ("a.py", "b.py"), "snapshot_too_large"),
        ):
            with self.subTest(expected=expected), self.assertRaisesRegex(SnapshotError, expected):
                self.capture(*paths, limits=limits)
        with self.assertRaises(SnapshotError):
            self.capture()
        for value in (0, -1, True, 1.5):
            with self.subTest(value=value), self.assertRaisesRegex(SnapshotError, "invalid_limits"):
                Limits(max_files=value)

    def test_final_and_intermediate_symlinks_and_root_symlink(self):
        outside = Path(self.temp.name) / "outside"
        outside.mkdir()
        (outside / "job.py").write_text("unapproved = True\n")
        (self.root / "direct.py").symlink_to(outside / "job.py")
        (self.root / "linked").symlink_to(outside, target_is_directory=True)
        for path in ("direct.py", "linked/job.py"):
            with self.subTest(path=path), self.assertRaises(SnapshotError):
                self.capture(path)
        alias = Path(self.temp.name) / "alias"
        alias.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(SnapshotError):
            capture_snapshot(alias, ["direct.py"], source_id="approved-example")

    def test_hardlink_and_fifo_and_directory_reject(self):
        outside = Path(self.temp.name) / "outside.py"
        outside.write_text("unapproved = True\n")
        os.link(outside, self.root / "linked.py")
        os.mkfifo(self.root / "pipe.py")
        (self.root / "directory.py").mkdir()
        for path in ("linked.py", "pipe.py", "directory.py"):
            with self.subTest(path=path), self.assertRaisesRegex(SnapshotError, "non_regular_or_linked_source"):
                self.capture(path)

    def test_source_modification_during_read_is_rejected(self):
        file = self.put("job.py")
        original_read = os.read
        changed = False

        def modifying_read(fd, count):
            nonlocal changed
            data = original_read(fd, count)
            if not changed:
                file.write_text("modified = 9999\n")
                changed = True
            return data

        with patch.object(subject.os, "read", side_effect=modifying_read):
            with self.assertRaisesRegex(SnapshotError, "source_changed_during_capture"):
                self.capture("job.py")

    def test_previously_read_file_change_is_rejected(self):
        first = self.put("a.py")
        self.put("b.py")
        original_capture = subject._capture

        def changing_capture(fd, path, limits, remaining):
            result = original_capture(fd, path, limits, remaining)
            if path == "b.py":
                first.write_text("modified = True\n")
            return result

        with patch.object(subject, "_capture", side_effect=changing_capture):
            with self.assertRaisesRegex(SnapshotError, "source_changed_during_capture"):
                self.capture("a.py", "b.py")

    def test_parent_symlink_swap_cannot_redirect_open(self):
        self.put("nested/job.py", "approved = True\n")
        outside = Path(self.temp.name) / "outside"
        outside.mkdir()
        (outside / "job.py").write_text("unapproved = True\n")
        original_root = subject._root_fd
        original_open = os.open
        swapped = False

        def swap_before_file_open(path, flags, *args, **kwargs):
            nonlocal swapped
            if path == "job.py" and not swapped:
                (self.root / "nested").rename(self.root / "retained")
                (self.root / "nested").symlink_to(outside, target_is_directory=True)
                swapped = True
            return original_open(path, flags, *args, **kwargs)

        @contextmanager
        def pinned_root(path):
            with original_root(path) as fd:
                with patch.object(subject.os, "open", side_effect=swap_before_file_open):
                    yield fd

        with patch.object(subject, "_root_fd", pinned_root):
            result = self.capture("nested/job.py")
        self.assertTrue(swapped)
        self.assertEqual(result.files[0].text, "approved = True\n")
        with self.assertRaises(SnapshotError):
            self.capture("nested/job.py")


if __name__ == "__main__":
    unittest.main()

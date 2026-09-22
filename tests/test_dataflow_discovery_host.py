from __future__ import annotations

import importlib
from pathlib import Path
import subprocess
import tempfile
import unittest

host = importlib.import_module("dataflow_discovery.host")


class DiscoveryHostTests(unittest.TestCase):
    def test_git_provenance_does_not_execute_repository_fsmonitor(self) -> None:
        """Only our synthetic monitor could write this temporary sentinel."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            git = ["git", "-C", str(root), "-c", "core.hooksPath=/dev/null"]
            subprocess.run([*git, "init", "-q"], check=True, capture_output=True)
            subprocess.run([*git, "-c", "user.name=Discovery Test", "-c", "user.email=test@example.invalid",
                            "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "test"],
                           check=True, capture_output=True)
            (root / "pipeline.py").write_text("def run():\n    return None\n", encoding="utf-8")
            sentinel = root / "executed"
            monitor = root / ".git" / "test-monitor"
            monitor.write_text(f"#!/bin/sh\ntouch '{sentinel}'\nprintf 'token\\0'\n", encoding="utf-8")
            monitor.chmod(0o700)
            subprocess.run([*git, "config", "core.fsmonitor", str(monitor)], check=True, capture_output=True)
            revision = host._git_revision(str(root), ["pipeline.py"])
            self.assertFalse(sentinel.exists(), "Host Git provenance executed repository-configured code")
            self.assertEqual(revision.kind, "git")
            self.assertTrue(revision.dirty)


if __name__ == "__main__":
    unittest.main()

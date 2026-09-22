#!/usr/bin/env python3
"""Public plugin directory must remain readable by the image's non-host UID."""

import contextlib
import importlib.util
import io
import os
from pathlib import Path
import tempfile
import unittest


class PluginPermissionsTest(unittest.TestCase):
    def test_existing_credentials_are_preserved_and_plugins_are_readable(self):
        old_umask = os.umask(0o077)
        self.addCleanup(os.umask, old_umask)
        script = Path(__file__).resolve().parents[1] / "scripts/init-local.py"
        spec = importlib.util.spec_from_file_location("init_local", script)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        for existing_plugins in (False, True):
            with self.subTest(existing_plugins=existing_plugins), tempfile.TemporaryDirectory() as tmp:
                local = Path(tmp) / ".local"
                local.mkdir(mode=0o700)
                for name in ("datahub.env", "user.props"):
                    path = local / name
                    path.write_text("test-only-existing-content\n")
                    path.chmod(0o600)
                if existing_plugins:
                    (local / "plugins").mkdir(mode=0o700)
                setattr(module, "LOCAL", local)
                with contextlib.redirect_stdout(io.StringIO()):
                    module.main()
                self.assertEqual((local / "plugins").stat().st_mode & 0o777, 0o755)
                self.assertEqual(local.stat().st_mode & 0o777, 0o700)
                for name in ("datahub.env", "user.props"):
                    self.assertEqual((local / name).read_text(), "test-only-existing-content\n")
                    self.assertEqual((local / name).stat().st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()

"""No Docker, network, builds, or live resource mutation."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import re
import subprocess
import tempfile
import tomllib
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("resource_check", ROOT / "scripts/check-agent-build-resources.py")
assert spec is not None and spec.loader is not None
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)
GIB = 1024**3


class BuildResourceChecks(unittest.TestCase):
    def healthy(self):
        return dict(available_bytes=6 * GIB, swap_total_bytes=4 * GIB, swap_free_bytes=GIB,
                    memory_full_avg10=0, io_some_avg10=0, linux_free_bytes=20 * GIB,
                    windows_free_bytes=25 * GIB)

    def test_floors_and_each_rejection(self):
        self.assertEqual(check.blocking_reasons(self.healthy()), [])
        for name, value in (("available_bytes", 6 * GIB - 1), ("swap_free_bytes", GIB - 1),
                            ("memory_full_avg10", 1), ("io_some_avg10", 5),
                            ("linux_free_bytes", 20 * GIB - 1), ("windows_free_bytes", 25 * GIB - 1)):
            with self.subTest(name=name):
                self.assertEqual(len(check.blocking_reasons(self.healthy() | {name: value})), 1)
        self.assertEqual(check.blocking_reasons(self.healthy() | {"swap_total_bytes": 0, "swap_free_bytes": 0, "windows_free_bytes": None}), [])

    def test_unknown_invalid_and_nonfinite_fail_closed(self):
        self.assertTrue(check.blocking_reasons({}))
        for value in (None, True, -1, float("nan"), float("inf"), "6GiB"):
            with self.subTest(value=value):
                self.assertTrue(check.blocking_reasons(self.healthy() | {"available_bytes": value}))
        self.assertTrue(check.blocking_reasons(self.healthy() | {"swap_free_bytes": 5 * GIB}))
        self.assertTrue(check.blocking_reasons(self.healthy() | {"io_some_avg10": 101}))

    def test_actual_parser_error_is_caught_by_main(self):
        for data in ("MemAvailable: broken kB", "MemAvailable: 100 unknown", "MemAvailable: 100 kB"):
            with self.subTest(data=data), patch.object(Path, "read_text", return_value=data), contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(check.main(), 1)
                self.assertEqual(json.loads(output.getvalue())["status"], "BLOCKED")

    def test_read_error_and_ready_exit(self):
        with patch.object(Path, "read_text", side_effect=OSError), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(check.main(), 1)
        with patch.object(check, "snapshot", return_value=self.healthy()), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(check.main(), 0)

    def test_documented_commands_stop_before_docker_when_preflight_fails(self):
        guide = (ROOT / "docs/verification/datahub-agent-build-resources.md").read_text()
        blocks = re.findall(r"```bash\n(.*?)```", guide, re.S)
        self.assertEqual(len(blocks), 3)
        for script in blocks[1:]:
            with self.subTest(script=script[:80]), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                binaries = root / "bin"
                binaries.mkdir()
                (root / ".local").mkdir()
                for name, body in {"python3": "exit 1", "docker": "touch docker-was-called; exit 99"}.items():
                    executable = binaries / name
                    executable.write_text("#!/bin/sh\n" + body + "\n")
                    executable.chmod(0o700)
                result = subprocess.run(["/bin/sh", "-c", script], cwd=root,
                                        env={"PATH": f"{binaries}:/usr/bin:/bin", "HOME": directory},
                                        capture_output=True, timeout=5)
                self.assertEqual(result.returncode, 1)
                self.assertFalse((root / "docker-was-called").exists())
                self.assertFalse((root / ".local/agent-build-home").exists())

    def test_cache_order_and_serial_solver(self):
        dockerfile = (ROOT / "extensions/datahub-agent/deploy/Dockerfile.pi-web").read_text()
        self.assertLess(dockerfile.index("RUN apt-get"), dockerfile.index("COPY --chown=node:node package.json"))
        self.assertLess(dockerfile.index("RUN npm ci"), dockerfile.index("COPY --chown=node:node . ."))
        self.assertIn("next build --webpack", dockerfile)
        config = tomllib.loads((ROOT / "extensions/datahub-agent/deploy/buildkitd.toml").read_text())
        self.assertEqual(config["worker"]["oci"]["max-parallelism"], 1)


if __name__ == "__main__":
    unittest.main()

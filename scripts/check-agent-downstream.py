"""Verify reviewed downstream bytes, reverse its patch, then run original baseline checks.

No baseline hashes are changed. Git operations run only in a temporary directory.
Run: .venv/bin/python scripts/check-agent-downstream.py
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
EXT = ROOT / "extensions/datahub-agent"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    if not __debug__:
        raise RuntimeError("downstream verification requires assertions; do not use Python -O")
    try:
        manifest = json.loads((EXT / "pi-web-downstream.lock.json").read_text())
    except (ValueError, OSError) as error:
        raise RuntimeError("downstream_manifest_unavailable") from error
    upstream = EXT / "pi-web-upstream.lock.json"
    patch = EXT / "pi-web-downstream.patch"
    assert digest(upstream) == manifest["upstream_lock_sha256"], "upstream lock changed"
    assert digest(patch) == manifest["patch_sha256"], "downstream patch changed"
    paths = set(manifest["files"])
    listed = subprocess.check_output([
        "git", "ls-files", "-co", "--exclude-standard", "--", "extensions/datahub-agent/pi-web/",
    ], cwd=ROOT, text=True).splitlines()
    assert {name.removeprefix("extensions/datahub-agent/pi-web/") for name in listed} <= paths, "unreviewed source files"
    with tempfile.TemporaryDirectory(prefix="datahub-baseline-") as directory:
        target = Path(directory)
        source = target / "pi-web"
        for name, expected in manifest["files"].items():
            relative = Path(name)
            assert not relative.is_absolute() and ".." not in relative.parts, "invalid patch path"
            current = EXT / "pi-web" / relative
            assert not current.is_symlink(), name
            assert digest(current) == expected["sha256"], name
            assert current.stat().st_mode & 0o777 == expected["mode"], name
            destination = source / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(current, destination)
        env = {"PATH": os.environ["PATH"], "HOME": directory, "GIT_CONFIG_NOSYSTEM": "1"}
        subprocess.run(["git", "apply", "--reverse", "--check", str(patch)], cwd=source, env=env, check=True)
        subprocess.run(["git", "apply", "--reverse", str(patch)], cwd=source, env=env, check=True)
        try:
            original = json.loads(upstream.read_text())
        except (ValueError, OSError) as error:
            raise RuntimeError("upstream_manifest_unavailable") from error
        assert {str(p.relative_to(source)) for p in source.rglob("*") if p.is_file()} == {f["path"] for f in original["files"]}, "reconstructed file set differs"
        shutil.copy2(upstream, target / upstream.name)
        spec = importlib.util.spec_from_file_location("foundation", ROOT / "tests/test_agent_foundation.py")
        assert spec is not None and spec.loader is not None, "baseline test loader unavailable"
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        setattr(module, "EXTENSION", target)  # Original tests inspect reconstructed upstream, not edited UI.
        result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromModule(module))
        assert result.wasSuccessful(), "reconstructed baseline failed"
    print(f"PASS {len(paths)} downstream files + reverse patch + original 506-file baseline and catalog checks")


if __name__ == "__main__":
    main()

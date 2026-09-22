"""Bounded negative checks for the downstream verifier; no checkout mutations."""
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("downstream", ROOT / "scripts/check-agent-downstream.py")
assert spec is not None and spec.loader is not None
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)
original = checker.EXT
manifest = json.loads((original / "pi-web-downstream.lock.json").read_text())
first = next(iter(manifest["files"]))
for case in ("patch", "source"):
    with tempfile.TemporaryDirectory(prefix="datahub-negative-") as directory:
        extension = Path(directory)
        for name in ("pi-web-upstream.lock.json", "pi-web-downstream.lock.json", "pi-web-downstream.patch"):
            shutil.copy2(original / name, extension / name)
        target = extension / ("pi-web-downstream.patch" if case == "patch" else f"pi-web/{first}")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("deliberately invalid fixture bytes")
        setattr(checker, "EXT", extension)
        try:
            checker.main()
        except AssertionError as error:
            assert str(error) == ("downstream patch changed" if case == "patch" else first)
        else:
            raise AssertionError(f"accepted corrupted {case}")
print("PASS: changed patch and changed source rejected without modifying checkout")

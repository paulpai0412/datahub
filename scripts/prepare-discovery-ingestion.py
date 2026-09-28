"""Prepare immutable-source input for the optional official ingestion executor mount.

Usage: python3 scripts/prepare-discovery-ingestion.py NEW_OUTPUT_DIRECTORY
Copies first-party Python source only. Does not read credentials, install packages,
change services, modify a Source recipe or execute ingestion.
"""
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "extensions/dataflow-discovery/src"
SDK = "1.7.0.9"
SQLGLOT = "30.12.0"


def prepare(destination: Path):
    if destination.exists():
        raise ValueError("output_already_exists")
    paths = sorted((SOURCE / "dataflow_discovery").rglob("*.py"))
    if not paths or any(path.is_symlink() for path in paths):
        raise ValueError("invalid_source_files")
    contents = {str(p.relative_to(SOURCE)): p.read_bytes() for p in paths}
    hashes = {p: hashlib.sha256(value).hexdigest() for p, value in contents.items()}
    source_digest = hashlib.sha256(json.dumps(hashes, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    destination.mkdir(parents=True)
    for name, data in contents.items():
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        target.chmod(0o644)
    for path in [destination, *[p for p in destination.rglob("*") if p.is_dir()]]:
        path.chmod(0o755)
    manifest = {"format": "dataflow-discovery.ingestion-source/1", "sourceDigest": source_digest,
                "sdk": SDK, "sqlglot": SQLGLOT, "transformer": "dataflow_discovery.grafana_schema.GrafanaIngestionSchemaTransformer", "files": hashes}
    (destination / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (destination / "manifest.json").chmod(0o644)
    for name, expected in hashes.items():
        if hashlib.sha256((destination/name).read_bytes()).hexdigest() != expected or hashlib.sha256((SOURCE/name).read_bytes()).hexdigest() != expected:
            raise ValueError("source_changed_during_preparation")
    return manifest


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("NEW_OUTPUT_DIRECTORY required")
    result = prepare(Path(sys.argv[1]).resolve())
    print(json.dumps({k: v for k, v in result.items() if k != "files"} | {"sourceFiles": len(result["files"])}))

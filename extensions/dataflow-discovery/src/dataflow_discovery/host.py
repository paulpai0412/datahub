"""Trusted-Host adapter for bounded, source-bound Discovery runs."""

from __future__ import annotations

from dataclasses import dataclass
import importlib
from pathlib import Path
import subprocess
from typing import Any, Sequence

_analyzer = importlib.import_module("dataflow_discovery.analyzer")
_snapshot = importlib.import_module("dataflow_discovery.snapshot")
AnalysisResult = _analyzer.AnalysisResult
analyze_snapshot = _analyzer.analyze_snapshot
Limits = _snapshot.Limits
Snapshot = _snapshot.Snapshot
capture_snapshot = _snapshot.capture_snapshot


class HostBoundaryError(ValueError):
    """The trusted Host did not provide a bounded approved source scope."""


@dataclass(frozen=True)
class Revision:
    kind: str
    commit: str | None
    dirty: bool | None

    def to_dict(self) -> dict[str, Any]:
        return {"kind": self.kind, "commit": self.commit, "dirty": self.dirty}


@dataclass(frozen=True)
class AnalysisReceipt:
    source_id: str
    snapshot: Snapshot
    analysis: AnalysisResult
    revision: Revision

    def to_dict(self) -> dict[str, Any]:
        return {
            "format": "dataflow-discovery.host-receipt/1",
            "source_id": self.source_id,
            "snapshot": self.snapshot.manifest(),
            "analysis": self.analysis.to_dict(),
            "revision": self.revision.to_dict(),
        }


def _git_revision(root: str, paths: Sequence[str]) -> Revision:
    root_path = Path(root)
    git_marker = root_path / ".git"
    if not git_marker.exists():
        return Revision("content", None, None)
    # Repository configuration is input, not permission to run code. In
    # particular, `git status` can invoke core.fsmonitor even without a shell.
    git = ["git", "-C", root, "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"]
    try:
        commit_result = subprocess.run(
            [*git, "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        )
        status_result = subprocess.run(
            [*git, "status", "--porcelain", "--untracked-files=all", "--", *paths],
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return Revision("content", None, None)
    commit = commit_result.stdout.strip()
    if len(commit) != 40 or any(character not in "0123456789abcdef" for character in commit.lower()):
        return Revision("content", None, None)
    return Revision("git", commit, bool(status_result.stdout.strip()))


def _validate_scope(root: str, paths: Sequence[str], source_id: str) -> None:
    if not isinstance(root, str) or not Path(root).is_absolute():
        raise HostBoundaryError("root_must_be_absolute")
    if not isinstance(paths, Sequence) or isinstance(paths, (str, bytes)) or not paths:
        raise HostBoundaryError("paths_must_be_explicit")
    if not isinstance(source_id, str) or not source_id:
        raise HostBoundaryError("source_id_required")


def capture_and_analyze(
    root: str,
    paths: Sequence[str],
    *,
    source_id: str,
    limits: Any | None = None,
) -> AnalysisReceipt:
    """Capture and analyze only a Host-approved allowlist; never executes source code."""
    _validate_scope(root, paths, source_id)
    selected_limits = limits or Limits()
    snapshot = capture_snapshot(root, paths, source_id=source_id, limits=selected_limits)
    analysis = analyze_snapshot(snapshot)
    approved_paths = tuple(source_file.path for source_file in snapshot.files)
    return AnalysisReceipt(source_id, snapshot, analysis, _git_revision(root, approved_paths))


def capture_workspace_and_analyze(
    root: str,
    selection: str,
    *,
    source_id: str,
    limits: Any | None = None,
) -> tuple[AnalysisReceipt, dict[str, Any]]:
    """Analyze an automatic bounded selection within a Host-authorized root.

    Content hashes are the workspace revision authority. This path neither
    invokes Git nor executes the selected program to discover its dependencies.
    """
    _validate_scope(root, (selection,), source_id)
    workspace = _snapshot.capture_workspace(root, selection, source_id=source_id,
                                             limits=limits if limits is not None else Limits())
    receipt = AnalysisReceipt(source_id, workspace.snapshot,
                              analyze_snapshot(workspace.snapshot), Revision("content", None, None))
    return receipt, workspace.manifest()


def revalidate_snapshot(
    root: str,
    paths: Sequence[str],
    *,
    source_id: str,
    expected_sha256: str,
    limits: Any | None = None,
) -> bool:
    """Recapture the same Host allowlist before publication and compare its digest."""
    receipt = capture_and_analyze(root, paths, source_id=source_id, limits=limits)
    return receipt.snapshot.sha256 == expected_sha256

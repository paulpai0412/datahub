"""Bounded, read-only source capture for a trusted Linux Host.

Only the Host chooses roots and paths. This module never runs source code, calls
Git, accesses credentials, or writes a snapshot store. Captured text is immutable
in memory; the caller must check authorization before sending it to a model.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Iterator, Sequence

_FORMAT = "dataflow-discovery.snapshot/1"
_SUFFIXES = frozenset({".py", ".sql", ".json", ".yaml", ".yml", ".md"})
_EXCLUDED_DIRS = frozenset({
    "node_modules", "__pycache__", "venv", "vendor", "tests", "fixtures", "golden"
})
_SENSITIVE_NAME = re.compile(
    r"(^|[_.-])(secrets?|credentials?|passwords?|tokens?|cookies?)([_.-]|$)", re.I
)
_SECRET_LITERAL = re.compile(
    r"[\"']?\b(?:password|passwd|pwd|secret|token|api[_-]?key|authorization|cookie)"
    r"[\"']?\s*[:=]\s*([\"'])([^\r\n]*?)\1", re.I
)
_YAML_SECRET = re.compile(
    r"^\s*(?:password|passwd|pwd|secret|token|api[_-]?key|authorization|cookie)"
    r"[ \t]*:[ \t]*([^\r\n#]*)", re.I | re.M
)
_ODBC_SECRET = re.compile(r"[;\"']\s*(?:PWD|PASSWORD)\s*=\s*([^;\"'\r\n]+)", re.I)
_PLACEHOLDER = re.compile(
    r"(?:Bearer |Basic )?(?:\$\{[A-Z_][A-Z0-9_]*\}|\$\([A-Z_][A-Z0-9_]*\))\Z"
)
_URL_CREDENTIAL = re.compile(r"\b[a-z][a-z0-9+.-]*://[^/\s:@]+:[^/\s@]+@", re.I)
_PRIVATE_KEY = re.compile(r"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----")


class SnapshotError(ValueError):
    """A bounded error code; never contains source text or a host absolute path."""


@dataclass(frozen=True)
class Limits:
    max_files: int = 128
    max_file_bytes: int = 512 * 1024
    max_total_bytes: int = 8 * 1024 * 1024
    max_entries: int = 4096
    max_directories: int = 256
    max_depth: int = 32

    def __post_init__(self) -> None:
        values = (self.max_files, self.max_file_bytes, self.max_total_bytes,
                  self.max_entries, self.max_directories, self.max_depth)
        if any(type(n) is not int or n <= 0 for n in values):
            raise SnapshotError("invalid_limits")


@dataclass(frozen=True)
class SourceFile:
    path: str
    text: str
    sha256: str
    size_bytes: int


@dataclass(frozen=True)
class Snapshot:
    source_id: str
    files: tuple[SourceFile, ...]
    sha256: str

    def manifest(self) -> dict:
        """Return provenance only, not source text, secrets, or an invented commit."""
        return {
            "format": _FORMAT,
            "source_id": self.source_id,
            "revision_kind": "content",
            "sha256": self.sha256,
            "files": [
                {"path": f.path, "sha256": f.sha256, "size_bytes": f.size_bytes}
                for f in self.files
            ],
        }


def _paths(paths: Sequence[str], limits: Limits) -> tuple[str, ...]:
    if isinstance(paths, (str, bytes)) or not paths or len(paths) > limits.max_files:
        raise SnapshotError("invalid_file_count")
    for path in paths:
        if not isinstance(path, str) or not path or "\\" in path or ":" in path:
            raise SnapshotError("invalid_path")
        parts = path.split("/")
        if any(
            not p or p in {".", ".."}
            or any(ord(c) < 32 or ord(c) == 127 for c in p)
            for p in parts
        ):
            raise SnapshotError("invalid_path")
        if any(
            p.startswith(".") or p.lower() in _EXCLUDED_DIRS or _SENSITIVE_NAME.search(p)
            for p in parts
        ):
            raise SnapshotError("excluded_path")
        if PurePosixPath(path).suffix.lower() not in _SUFFIXES:
            raise SnapshotError("unsupported_file_type")
    if len(set(paths)) != len(paths):
        raise SnapshotError("duplicate_path")
    return tuple(sorted(paths))


@contextmanager
def _root_fd(root: os.PathLike[str] | str) -> Iterator[int]:
    """Pin each directory without following symlinks, including root ancestors."""
    path = PurePosixPath(root)
    if not path.is_absolute() or ".." in path.parts:
        raise SnapshotError("invalid_root")
    if not hasattr(os, "O_NOFOLLOW") or os.open not in os.supports_dir_fd:
        raise SnapshotError("unsupported_host")
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    fd = os.open("/", flags)
    try:
        for part in path.parts[1:]:
            next_fd = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        yield fd
    finally:
        os.close(fd)


@contextmanager
def _file_fd(root_fd: int, path: str) -> Iterator[int]:
    """Use openat-style directory handles, not a vulnerable realpath/open pair."""
    fd = os.dup(root_fd)
    try:
        parts = path.split("/")
        for part in parts[:-1]:
            next_fd = os.open(
                part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd
            )
            os.close(fd)
            fd = next_fd
        file_fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        try:
            yield file_fd
        finally:
            os.close(file_fd)
    finally:
        os.close(fd)


def _signature(info: os.stat_result) -> tuple[int, ...]:
    return (
        info.st_dev, info.st_ino, info.st_size,
        info.st_mtime_ns, info.st_ctime_ns, info.st_nlink,
    )


def _screen_text(raw: bytes) -> str:
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise SnapshotError("non_utf8_source") from None
    if "\x00" in text:
        raise SnapshotError("binary_source")
    if _PRIVATE_KEY.search(text) or _URL_CREDENTIAL.search(text):
        raise SnapshotError("sensitive_content")
    for match in _SECRET_LITERAL.finditer(text):
        value = match.group(2)
        if value and not _PLACEHOLDER.fullmatch(value):
            raise SnapshotError("sensitive_content")
    for pattern in (_YAML_SECRET, _ODBC_SECRET):
        for match in pattern.finditer(text):
            value = match.group(1).strip()
            if pattern is _YAML_SECRET and (
                value.startswith(("'", '"')) or value in {"", "null", "Null", "NULL", "~"}
            ):
                continue  # Quoted scalars were screened above; YAML null has no secret.
            if not _PLACEHOLDER.fullmatch(value):
                raise SnapshotError("sensitive_content")
    return text


def _capture(
    fd: int, path: str, limits: Limits, remaining: int
) -> tuple[SourceFile, tuple[int, ...]]:
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise SnapshotError("non_regular_or_linked_source")
    if info.st_size > limits.max_file_bytes:
        raise SnapshotError("file_too_large")
    if info.st_size > remaining:
        raise SnapshotError("snapshot_too_large")
    budget = min(limits.max_file_bytes, remaining)
    chunks: list[bytes] = []
    size = 0
    while size <= budget:
        chunk = os.read(fd, min(64 * 1024, budget + 1 - size))
        if not chunk:
            break
        chunks.append(chunk)
        size += len(chunk)
    if size > budget:
        raise SnapshotError("source_grew_over_limit")
    signature = _signature(info)
    if signature != _signature(os.fstat(fd)):
        raise SnapshotError("source_changed_during_capture")
    raw = b"".join(chunks)
    file = SourceFile(path, _screen_text(raw), hashlib.sha256(raw).hexdigest(), len(raw))
    return file, signature


def capture_snapshot(
    root: os.PathLike[str] | str,
    paths: Sequence[str],
    *,
    source_id: str,
    limits: Limits = Limits(),
) -> Snapshot:
    """Capture explicitly approved text files; any rejection aborts the whole capture.

    Does not guarantee a transactional repository snapshot. Open handles prevent
    directory-symlink swaps from redirecting reads, and stat checks detect observed
    modifications. Evidence refers to these captured bytes; a publisher must check
    current source/version again. Content screening is deliberately not a DLP proof.
    """
    if not isinstance(source_id, str) or not re.fullmatch(
        r"[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}", source_id
    ):
        raise SnapshotError("invalid_source_id")
    approved_paths = _paths(paths, limits)
    try:
        with ExitStack() as stack:
            root_fd = stack.enter_context(_root_fd(root))
            files: list[SourceFile] = []
            opened: list[tuple[int, tuple[int, ...]]] = []
            total = 0
            for path in approved_paths:
                fd = stack.enter_context(_file_fd(root_fd, path))
                file, signature = _capture(fd, path, limits, limits.max_total_bytes - total)
                files.append(file)
                opened.append((fd, signature))
                total += file.size_bytes
            if any(_signature(os.fstat(fd)) != before for fd, before in opened):
                raise SnapshotError("source_changed_during_capture")
    except OSError:
        raise SnapshotError("source_unavailable_or_symlink") from None
    return _make_snapshot(source_id, files)


def _make_snapshot(source_id: str, files: Sequence[SourceFile]) -> Snapshot:
    ordered = tuple(sorted(files, key=lambda item: item.path))
    manifest = {
        "format": _FORMAT,
        "source_id": source_id,
        "revision_kind": "content",
        "files": [
            {"path": f.path, "sha256": f.sha256, "size_bytes": f.size_bytes}
            for f in ordered
        ],
    }
    canonical = json.dumps(manifest, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    digest = hashlib.sha256(canonical.encode()).hexdigest()
    return Snapshot(source_id, ordered, digest)


@dataclass(frozen=True)
class WorkspaceCapture:
    """Ephemeral Host input, not permission, a lineage verdict or a state store."""

    snapshot: Snapshot
    selection: str
    scan_root: str
    excluded: tuple[tuple[str, str], ...]

    def manifest(self) -> dict:
        return {
            "format": "datahub-etl.workspace/1",
            "selection": self.selection,
            "scan_root": self.scan_root,
            "snapshot": self.snapshot.manifest(),
            "excluded": [{"path": path, "reason": reason} for path, reason in self.excluded],
            "lineage_complete": False,
        }


def _selection_parts(selection: str) -> tuple[str, ...]:
    if not isinstance(selection, str) or not selection or len(selection) > 1024:
        raise SnapshotError("invalid_workspace_selection")
    if selection == ".":
        return ()
    parts = selection.split("/")
    if ("\\" in selection or ":" in selection or any(
        not part or part in {".", ".."}
        or any(ord(c) < 32 or ord(c) == 127 for c in part) for part in parts
    )):
        raise SnapshotError("invalid_workspace_selection")
    if any(_excluded_component(part) for part in parts):
        raise SnapshotError("excluded_path")
    return tuple(parts)


def _excluded_component(part: str) -> bool:
    return part.startswith(".") or part.lower() in _EXCLUDED_DIRS or bool(_SENSITIVE_NAME.search(part))


def capture_workspace(
    root: os.PathLike[str] | str,
    selection: str,
    *,
    source_id: str,
    limits: Limits = Limits(),
) -> WorkspaceCapture:
    """Automatically capture a selection *inside an already authorized WSL root*.

    Host chooses root/source_id/limits after authenticating the actor. `selection`
    is relative, never a permission to browse arbitrary absolute paths. A file
    selection captures its parent subtree too, allowing same-scope helper/SQL
    discovery without executing imports. Dependencies outside that subtree must
    remain gaps in analysis; capture alone never establishes complete lineage.

    Directory membership and file bytes are checked on pinned descriptors. A
    symlink or special file is rejected, not followed or silently counted as read.
    Excluded names/types are returned explicitly. Limits fail, never truncate.
    """
    parts = _selection_parts(selection)
    if not isinstance(source_id, str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}", source_id):
        raise SnapshotError("invalid_source_id")
    files: list[SourceFile] = []
    excluded: list[tuple[str, str]] = []
    signatures: list[tuple[int, tuple[int, ...]]] = []
    entries_seen = directories_seen = total = 0
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    try:
        with ExitStack() as stack:
            root_fd = stack.enter_context(_root_fd(root))
            selected_fd = root_fd
            scan_parts = parts
            for index, part in enumerate(parts):
                info = os.stat(part, dir_fd=selected_fd, follow_symlinks=False)
                if index == len(parts) - 1 and stat.S_ISREG(info.st_mode):
                    _paths([part], limits)
                    scan_parts = parts[:-1]
                    break
                if not stat.S_ISDIR(info.st_mode):
                    raise SnapshotError("non_regular_or_linked_source")
                # Keep ancestor identity pinned, rather than resolve/open a path.
                child_fd = os.open(part, flags, dir_fd=selected_fd)
                stack.callback(os.close, child_fd)
                selected_fd = child_fd

            def walk(directory_fd: int, prefix: str, depth: int) -> None:
                nonlocal entries_seen, directories_seen, total
                directories_seen += 1
                if depth > limits.max_depth or directories_seen > limits.max_directories:
                    raise SnapshotError("workspace_directory_limit")
                signatures.append((directory_fd, _signature(os.fstat(directory_fd))))
                # Iterate before sorting: a huge directory must not allocate an
                # unbounded list merely to discover that its budget was exceeded.
                names = []
                with os.scandir(directory_fd) as entries:
                    for entry in entries:
                        entries_seen += 1
                        if entries_seen > limits.max_entries:
                            raise SnapshotError("workspace_entry_limit")
                        names.append(entry.name)
                for name in sorted(names):
                    path = f"{prefix}/{name}" if prefix else name
                    if _excluded_component(name):
                        excluded.append((path, "excluded_path"))
                        continue
                    if any(ord(c) < 32 or ord(c) == 127 for c in name) or "\\" in name or ":" in name:
                        raise SnapshotError("invalid_path")
                    info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
                    if stat.S_ISDIR(info.st_mode):
                        child_fd = os.open(name, flags, dir_fd=directory_fd)
                        stack.callback(os.close, child_fd)
                        walk(child_fd, path, depth + 1)
                    elif not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                        raise SnapshotError("non_regular_or_linked_source")
                    elif PurePosixPath(name).suffix.lower() not in _SUFFIXES:
                        excluded.append((path, "unsupported_file_type"))
                    else:
                        if len(files) >= limits.max_files:
                            raise SnapshotError("invalid_file_count")
                        fd = stack.enter_context(_file_fd(directory_fd, name))
                        file, signature = _capture(fd, path, limits, limits.max_total_bytes - total)
                        files.append(file)
                        total += file.size_bytes
                        signatures.append((fd, signature))

            walk(selected_fd, "/".join(scan_parts), 0)
            if not files:
                raise SnapshotError("invalid_file_count")
            if parts and scan_parts != parts and selection not in {file.path for file in files}:
                raise SnapshotError("workspace_entrypoint_missing")
            if any(_signature(os.fstat(fd)) != before for fd, before in signatures):
                raise SnapshotError("source_changed_during_capture")
    except OSError:
        raise SnapshotError("source_unavailable_or_symlink") from None
    return WorkspaceCapture(_make_snapshot(source_id, files), selection,
                            "/".join(scan_parts) or ".", tuple(sorted(excluded)))

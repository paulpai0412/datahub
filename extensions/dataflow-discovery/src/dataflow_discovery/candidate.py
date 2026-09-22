"""Neutral, source-bound candidate contracts for DataFlow Discovery."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
from typing import Any, Mapping, Sequence


ANALYSIS_FORMAT = "dataflow-discovery.analysis/1"
ANALYSIS_VERSION = "1.0.3"
_CANDIDATE_KINDS = frozenset(
    {
        "asset",
        "process",
        "type",
        "relationship",
        "field_mapping",
        "governance_proposal",
        "unresolved",
    }
)
_STATUSES = frozenset({"resolved", "inferred", "unresolved"})


class CandidateError(ValueError):
    """Raised when a candidate document is malformed."""


@dataclass(frozen=True)
class Evidence:
    path: str
    start_line: int
    end_line: int
    file_sha256: str
    scope_id: str
    method: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "start_line": self.start_line,
            "end_line": self.end_line,
            "file_sha256": self.file_sha256,
            "scope_id": self.scope_id,
            "method": self.method,
        }

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "Evidence":
        try:
            result = cls(
                path=value["path"],
                start_line=int(value["start_line"]),
                end_line=int(value["end_line"]),
                file_sha256=value["file_sha256"],
                scope_id=value["scope_id"],
                method=value["method"],
            )
        except (KeyError, TypeError, ValueError):
            raise CandidateError("invalid_evidence") from None
        if not result.path or result.start_line < 1 or result.end_line < result.start_line:
            raise CandidateError("invalid_evidence")
        return result


@dataclass(frozen=True)
class Candidate:
    candidate_id: str
    kind: str
    subject: str
    object: str | None
    status: str
    method: str
    attributes: tuple[tuple[str, Any], ...]
    evidence: tuple[Evidence, ...]
    limitations: tuple[str, ...]

    @classmethod
    def create(
        cls,
        *,
        kind: str,
        subject: str,
        object: str | None = None,
        status: str = "resolved",
        method: str,
        attributes: Mapping[str, Any] | None = None,
        evidence: Sequence[Evidence] = (),
        limitations: Sequence[str] = (),
    ) -> "Candidate":
        if kind not in _CANDIDATE_KINDS or status not in _STATUSES:
            raise CandidateError("invalid_candidate_kind_or_status")
        if not isinstance(subject, str) or not subject or object is not None and not isinstance(object, str):
            raise CandidateError("invalid_candidate_subject")
        normalized_attributes = tuple(sorted((str(key), value) for key, value in (attributes or {}).items()))
        identity = {
            "kind": kind,
            "subject": subject,
            "object": object,
            "status": status,
            "method": method,
            "attributes": normalized_attributes,
            "evidence": [item.to_dict() for item in evidence],
            "limitations": tuple(limitations),
        }
        candidate_id = "cand_" + _digest(identity)[:24]
        return cls(
            candidate_id=candidate_id,
            kind=kind,
            subject=subject,
            object=object,
            status=status,
            method=method,
            attributes=normalized_attributes,
            evidence=tuple(evidence),
            limitations=tuple(limitations),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "candidate_id": self.candidate_id,
            "kind": self.kind,
            "subject": self.subject,
            "object": self.object,
            "status": self.status,
            "method": self.method,
            "attributes": dict(self.attributes),
            "evidence": [item.to_dict() for item in self.evidence],
            "limitations": list(self.limitations),
        }

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "Candidate":
        try:
            attributes = value.get("attributes", {})
            evidence = tuple(Evidence.from_dict(item) for item in value.get("evidence", ()))
            result = cls.create(
                kind=value["kind"],
                subject=value["subject"],
                object=value.get("object"),
                status=value["status"],
                method=value["method"],
                attributes=attributes,
                evidence=evidence,
                limitations=tuple(value.get("limitations", ())),
            )
        except (CandidateError, KeyError, TypeError, ValueError):
            raise CandidateError("invalid_candidate") from None
        if value.get("candidate_id") != result.candidate_id:
            raise CandidateError("candidate_digest_mismatch")
        return result


@dataclass(frozen=True)
class AnalysisResult:
    source_id: str
    snapshot_sha256: str
    analysis_version: str
    candidates: tuple[Candidate, ...]
    digest: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "format": ANALYSIS_FORMAT,
            "source_id": self.source_id,
            "snapshot_sha256": self.snapshot_sha256,
            "analysis_version": self.analysis_version,
            "candidates": [item.to_dict() for item in self.candidates],
            "candidate_digest": self.digest,
        }

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "AnalysisResult":
        try:
            if value["format"] != ANALYSIS_FORMAT:
                raise CandidateError("unsupported_analysis_format")
            candidates = tuple(Candidate.from_dict(item) for item in value["candidates"])
            result = cls(
                source_id=value["source_id"],
                snapshot_sha256=value["snapshot_sha256"],
                analysis_version=value["analysis_version"],
                candidates=candidates,
                digest=value["candidate_digest"],
            )
        except (CandidateError, KeyError, TypeError, ValueError):
            raise CandidateError("invalid_analysis") from None
        if result.digest != analysis_digest(result.snapshot_sha256, result.analysis_version, result.candidates):
            raise CandidateError("analysis_digest_mismatch")
        return result


def _digest(value: Any) -> str:
    canonical = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def analysis_digest(snapshot_sha256: str, analysis_version: str, candidates: Sequence[Candidate]) -> str:
    payload = {
        "format": ANALYSIS_FORMAT,
        "snapshot_sha256": snapshot_sha256,
        "analysis_version": analysis_version,
        "candidates": [candidate.to_dict() for candidate in candidates],
    }
    return _digest(payload)


def make_evidence(
    source_file: Any,
    start_line: int,
    end_line: int,
    method: str,
    *,
    scope_id: str,
) -> Evidence:
    """Build evidence from an in-memory snapshot file without retaining host paths."""
    return Evidence(
        path=source_file.path,
        start_line=max(1, start_line),
        end_line=max(start_line, end_line),
        file_sha256=source_file.sha256,
        scope_id=scope_id,
        method=method,
    )

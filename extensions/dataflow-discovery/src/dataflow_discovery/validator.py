"""Independent validation and publication preview for Discovery candidates."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import importlib
import json
from typing import Any, Mapping

_candidate = importlib.import_module("dataflow_discovery.candidate")
AnalysisResult = Any
Candidate = Any
CandidateError = _candidate.CandidateError
_analysis_from_dict = getattr(_candidate.AnalysisResult, "from_dict")
Snapshot = Any

_ALLOWED_RELATIONS = frozenset(
    {"reads", "writes", "calls", "contains", "consumes", "uses_datasource", "depends_on"}
)
_PUBLISHABLE_KINDS = frozenset({"asset", "process", "type", "relationship", "field_mapping"})


@dataclass(frozen=True)
class ValidationReport:
    status: str
    source_id: str
    snapshot_sha256: str
    candidate_digest: str | None
    valid_candidate_ids: tuple[str, ...]
    publishable_candidate_ids: tuple[str, ...]
    unresolved_candidate_ids: tuple[str, ...]
    findings: tuple[str, ...]

    def to_dict(self) -> dict[str, Any]:
        return {
            "format": "dataflow-discovery.validation/1",
            "status": self.status,
            "source_id": self.source_id,
            "snapshot_sha256": self.snapshot_sha256,
            "candidate_digest": self.candidate_digest,
            "valid_candidate_ids": list(self.valid_candidate_ids),
            "publishable_candidate_ids": list(self.publishable_candidate_ids),
            "unresolved_candidate_ids": list(self.unresolved_candidate_ids),
            "findings": list(self.findings),
        }


class ValidationError(ValueError):
    """Raised when a candidate payload cannot be safely previewed."""


def _snapshot_findings(snapshot: Snapshot) -> list[str]:
    """Verify every file and the manifest, including files without claims."""
    findings: list[str] = []
    paths = [file.path for file in snapshot.files]
    if not paths or paths != sorted(set(paths)):
        findings.append("invalid_snapshot_paths")
    for source_file in snapshot.files:
        raw = source_file.text.encode("utf-8")
        if hashlib.sha256(raw).hexdigest() != source_file.sha256:
            findings.append("snapshot_file_digest_invalid")
        if len(raw) != source_file.size_bytes:
            findings.append("snapshot_file_size_invalid")
    manifest = snapshot.manifest()
    manifest.pop("sha256")
    canonical = json.dumps(manifest, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    if hashlib.sha256(canonical.encode("utf-8")).hexdigest() != snapshot.sha256:
        findings.append("snapshot_manifest_digest_invalid")
    return findings


def _validate_evidence(candidate: Candidate, files: Mapping[str, Any], source_id: str) -> list[str]:
    findings: list[str] = []
    if not candidate.evidence:
        return [f"missing_evidence:{candidate.candidate_id}"]
    for evidence in candidate.evidence:
        source_file = files.get(evidence.path)
        if source_file is None:
            findings.append(f"evidence_path_not_in_snapshot:{candidate.candidate_id}")
            continue
        if evidence.scope_id != source_id:
            findings.append(f"evidence_scope_mismatch:{candidate.candidate_id}")
        if evidence.file_sha256 != source_file.sha256:
            findings.append(f"evidence_file_digest_mismatch:{candidate.candidate_id}")
        line_count = source_file.text.count("\n") + 1
        if (type(evidence.start_line) is not int or type(evidence.end_line) is not int
                or not 1 <= evidence.start_line <= evidence.end_line <= line_count):
            findings.append(f"evidence_line_out_of_range:{candidate.candidate_id}")
    return findings


def _validate_shape(candidate: Candidate) -> list[str]:
    findings: list[str] = []
    attributes = dict(candidate.attributes)
    if candidate.kind == "relationship":
        relation_type = attributes.get("relation_type")
        if relation_type not in _ALLOWED_RELATIONS:
            findings.append(f"invalid_relation_type:{candidate.candidate_id}")
        if not candidate.object:
            findings.append(f"relationship_missing_object:{candidate.candidate_id}")
    if candidate.kind == "field_mapping":
        if not attributes.get("source_field") or not attributes.get("target_field"):
            findings.append(f"field_mapping_missing_fields:{candidate.candidate_id}")
        if candidate.object is None and candidate.status == "resolved":
            findings.append(f"resolved_mapping_without_source:{candidate.candidate_id}")
    if candidate.kind == "unresolved" and candidate.status != "unresolved":
        findings.append(f"unresolved_kind_status_mismatch:{candidate.candidate_id}")
    # Governance proposals are structurally valid but deliberately excluded from
    # technical publication until a separate human approval step.
    return findings


def validate_analysis(analysis: AnalysisResult, snapshot: Snapshot) -> ValidationReport:
    """Validate provenance, shape, evidence and publishability independently of parsing."""
    findings = _snapshot_findings(snapshot)
    # Frozen dataclasses are constructible/replaceable by callers. Apply the
    # same identity checks as the JSON entrypoint, rather than trusting IDs.
    try:
        _analysis_from_dict(analysis.to_dict())
    except CandidateError as error:
        findings.append(str(error))
    files = {source_file.path: source_file for source_file in snapshot.files}
    if analysis.analysis_version != _candidate.ANALYSIS_VERSION:
        findings.append("unsupported_analysis_version")
    if analysis.source_id != snapshot.source_id:
        findings.append("source_id_mismatch")
    if analysis.snapshot_sha256 != snapshot.sha256:
        findings.append("snapshot_digest_mismatch")
    seen: set[str] = set()
    valid: list[str] = []
    publishable: list[str] = []
    unresolved: list[str] = []
    for candidate in analysis.candidates:
        if candidate.candidate_id in seen:
            findings.append(f"duplicate_candidate_id:{candidate.candidate_id}")
            continue
        seen.add(candidate.candidate_id)
        candidate_findings = [
            *_validate_evidence(candidate, files, snapshot.source_id),
            *_validate_shape(candidate),
        ]
        if candidate_findings:
            findings.extend(candidate_findings)
            continue
        valid.append(candidate.candidate_id)
        if candidate.kind == "unresolved" or candidate.status == "unresolved":
            unresolved.append(candidate.candidate_id)
        elif candidate.kind in _PUBLISHABLE_KINDS and candidate.status == "resolved":
            publishable.append(candidate.candidate_id)
    if findings:
        status = "FAIL"
    elif not analysis.candidates or unresolved or any(item.status == "inferred" for item in analysis.candidates):
        status = "INCONCLUSIVE"
    else:
        status = "PASS"
    return ValidationReport(
        status=status,
        source_id=snapshot.source_id,
        snapshot_sha256=snapshot.sha256,
        candidate_digest=analysis.digest,
        valid_candidate_ids=() if findings else tuple(valid),
        publishable_candidate_ids=() if findings else tuple(publishable),
        unresolved_candidate_ids=tuple(unresolved),
        findings=tuple(sorted(set(findings))),
    )


def validate_payload(payload: Mapping[str, Any], snapshot: Snapshot) -> ValidationReport:
    """Parse an untrusted candidate payload, then run the independent validator."""
    try:
        analysis = _analysis_from_dict(payload)
    except CandidateError as error:
        return ValidationReport(
            status="FAIL",
            source_id=snapshot.source_id,
            snapshot_sha256=snapshot.sha256,
            candidate_digest=None,
            valid_candidate_ids=(),
            publishable_candidate_ids=(),
            unresolved_candidate_ids=(),
            findings=(str(error),),
        )
    return validate_analysis(analysis, snapshot)


def publication_preview(analysis: AnalysisResult, snapshot: Snapshot) -> dict[str, Any]:
    """Return only validated resolved candidates; unresolved/governance items stay out."""
    report = validate_analysis(analysis, snapshot)
    if report.status == "FAIL":
        raise ValidationError("candidate_validation_failed")
    allowed = set(report.publishable_candidate_ids)
    candidates = [candidate.to_dict() for candidate in analysis.candidates if candidate.candidate_id in allowed]
    return {
        "format": "dataflow-discovery.publication-preview/1",
        "status": report.status,
        "source_id": analysis.source_id,
        "snapshot_sha256": analysis.snapshot_sha256,
        "candidate_digest": analysis.digest,
        "candidates": candidates,
        "excluded_unresolved": list(report.unresolved_candidate_ids),
        "findings": list(report.findings),
    }


def preview_digest(preview: Mapping[str, Any]) -> str:
    """Produce a deterministic digest for a human approval record."""
    canonical = json.dumps(preview, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

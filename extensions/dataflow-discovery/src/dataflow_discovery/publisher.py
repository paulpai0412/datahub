"""UNACCEPTED DRAFT: DataHub publication adapter, not wired to the Host.

Do not deploy this module as a publication authority. Candidate-to-declared-URN
translation and current-source recapture are checked, but authoritative Catalog
identity/schema resolution, trusted Task/Decision authorization and conditional
conflict handling are not yet implemented. See
``docs/verification/dataflow-discovery-astra-review.md`` for the open findings.

This module deliberately keeps discovery and publication separate.  The static
analyzer emits neutral candidates; a trusted Host turns a selected, validated
candidate set into an unapproved :class:`PublicationPlan` for human review.
An optional legacy approval claim is not authenticated authority. The draft
adapter uses the public DataHub SDK for entity creation and
lineage patches.  It never accepts a model-supplied server, token, SQL, path,
or credential.

The adapter is intentionally conservative for existing entities:

* new entities may receive the complete, explicitly approved initial aspects;
* existing entities only receive idempotent custom-property and relationship
  additions supported by the public SDK;
* schemas, descriptions, and existing edges are never replaced implicitly;
* an existing DataFlow with a conflicting/missing owned property is reported as
  a conflict rather than being rewritten with a full aspect.

DataHub writes are not transactional with source ETL or Grafana.  A receipt
therefore distinguishes deterministic validation failures from an emit whose
outcome needs readback reconciliation.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import importlib
import json
import re
import time
from typing import Any, Callable, Iterable, Mapping, Sequence

_candidate = importlib.import_module("dataflow_discovery.candidate")
_validator = importlib.import_module("dataflow_discovery.validator")
AnalysisResult = _candidate.AnalysisResult
Candidate = _candidate.Candidate
Snapshot = Any

PUBLICATION_FORMAT = "dataflow-discovery.publication-plan/3"
RECEIPT_FORMAT = "dataflow-discovery.publication-receipt/1"
_DIGEST = re.compile(r"^[0-9a-f]{64}$")
_CANDIDATE_ID = re.compile(r"^cand_[0-9a-f]{24}$")
_ACTOR_URN = re.compile(r"^urn:li:(?:corpuser|corpGroup):[^\s]{1,512}$")
_ENTITY_TYPES = frozenset({"dataset", "dataFlow", "dataJob", "chart", "dashboard"})
_RELATIONS = frozenset(
    {"reads", "writes", "contains", "consumes", "depends_on", "transforms"}
)


class PublicationError(ValueError):
    """Raised for a deterministic, pre-emit publication contract failure."""


@dataclass(frozen=True)
class FieldSpec:
    """A source-validated field definition used only for initial creation."""

    name: str
    native_type: str
    description: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.name, str) or not self.name or len(self.name) > 512:
            raise PublicationError("invalid_field_name")
        if not isinstance(self.native_type, str) or not self.native_type or len(self.native_type) > 256:
            raise PublicationError("invalid_field_type")
        if self.description is not None and (
            not isinstance(self.description, str) or len(self.description) > 4096
        ):
            raise PublicationError("invalid_field_description")

    def to_dict(self) -> dict[str, str]:
        value = {"name": self.name, "native_type": self.native_type}
        if self.description is not None:
            value["description"] = self.description
        return value

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "FieldSpec":
        if not isinstance(value, Mapping):
            raise PublicationError("invalid_field")
        _only(value, {"name", "native_type", "description"})
        return cls(
            name=_required_text(value.get("name"), "invalid_field_name"),
            native_type=_required_text(value.get("native_type"), "invalid_field_type"),
            description=value.get("description"),
        )


@dataclass(frozen=True)
class EntitySpec:
    """An explicit, Host-approved DataHub entity description.

    ``candidate_id`` binds the neutral source subject to the Host's declared
    Catalog identity; that identity/schema must still be independently resolved.
    ``create_if_missing=False`` is used for assets that must first be produced
    by an official connector (for example an MSSQL source dataset).  The
    publisher will never synthesize such an asset from a neutral candidate.
    """

    kind: str
    urn: str
    candidate_id: str | None = None
    platform: str | None = None
    name: str | None = None
    platform_instance: str | None = None
    env: str = "DEV"
    flow_urn: str | None = None
    display_name: str | None = None
    description: str | None = None
    external_url: str | None = None
    custom_properties: tuple[tuple[str, str], ...] = ()
    fields: tuple[FieldSpec, ...] = ()
    subtype: str | None = None
    create_if_missing: bool = True

    @classmethod
    def create(
        cls,
        *,
        kind: str,
        urn: str,
        candidate_id: str | None = None,
        platform: str | None = None,
        name: str | None = None,
        platform_instance: str | None = None,
        env: str = "DEV",
        flow_urn: str | None = None,
        display_name: str | None = None,
        description: str | None = None,
        external_url: str | None = None,
        custom_properties: Mapping[str, str] | None = None,
        fields: Sequence[FieldSpec] = (),
        subtype: str | None = None,
        create_if_missing: bool = True,
    ) -> "EntitySpec":
        if custom_properties is None:
            normalized_properties: tuple[tuple[str, str], ...] = ()
        else:
            normalized_properties = tuple(
                sorted((str(key), str(value)) for key, value in custom_properties.items())
            )
        result = cls(
            kind=kind,
            urn=urn,
            candidate_id=candidate_id,
            platform=platform,
            name=name,
            platform_instance=platform_instance,
            env=env,
            flow_urn=flow_urn,
            display_name=display_name,
            description=description,
            external_url=external_url,
            custom_properties=normalized_properties,
            fields=tuple(fields),
            subtype=subtype,
            create_if_missing=create_if_missing,
        )
        _validate_entity_spec(result)
        return result

    def __post_init__(self) -> None:
        _validate_entity_spec(self)

    def to_dict(self) -> dict[str, Any]:
        value: dict[str, Any] = {
            "kind": self.kind,
            "urn": self.urn,
            "env": self.env,
            "custom_properties": dict(self.custom_properties),
            "fields": [field.to_dict() for field in self.fields],
            "create_if_missing": self.create_if_missing,
        }
        for key in (
            "candidate_id",
            "platform",
            "name",
            "platform_instance",
            "flow_urn",
            "display_name",
            "description",
            "external_url",
            "subtype",
        ):
            item = getattr(self, key)
            if item is not None:
                value[key] = item
        return value

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "EntitySpec":
        if not isinstance(value, Mapping):
            raise PublicationError("invalid_entity_spec")
        _only(
            value,
            {
                "kind",
                "urn",
                "candidate_id",
                "platform",
                "name",
                "platform_instance",
                "env",
                "flow_urn",
                "display_name",
                "description",
                "external_url",
                "custom_properties",
                "fields",
                "subtype",
                "create_if_missing",
            },
        )
        properties = value.get("custom_properties", {})
        fields = value.get("fields", ())
        if not isinstance(properties, Mapping) or not isinstance(fields, Sequence) or isinstance(fields, (str, bytes)):
            raise PublicationError("invalid_entity_spec")
        return cls.create(
            kind=_required_text(value.get("kind"), "invalid_entity_kind"),
            urn=_required_text(value.get("urn"), "invalid_entity_urn"),
            candidate_id=value.get("candidate_id"),
            platform=value.get("platform"),
            name=value.get("name"),
            platform_instance=value.get("platform_instance"),
            env=value.get("env", "DEV"),
            flow_urn=value.get("flow_urn"),
            display_name=value.get("display_name"),
            description=value.get("description"),
            external_url=value.get("external_url"),
            custom_properties=properties,
            fields=tuple(FieldSpec.from_dict(item) for item in fields),
            subtype=value.get("subtype"),
            create_if_missing=value.get("create_if_missing", True),
        )


@dataclass(frozen=True)
class LineageSpec:
    """A typed, candidate-backed edge to add through the DataHub SDK."""

    upstream: str
    downstream: str
    relation_type: str
    candidate_ids: tuple[str, ...]
    column_mapping: tuple[tuple[str, tuple[str, ...]], ...] = ()

    @classmethod
    def create(
        cls,
        *,
        upstream: str,
        downstream: str,
        relation_type: str,
        candidate_ids: Sequence[str],
        column_mapping: Mapping[str, Sequence[str]] | None = None,
    ) -> "LineageSpec":
        mapping = tuple(
            sorted(
                (
                    str(target),
                    tuple(str(source) for source in sources),
                )
                for target, sources in (column_mapping or {}).items()
            )
        )
        result = cls(
            upstream=upstream,
            downstream=downstream,
            relation_type=relation_type,
            candidate_ids=tuple(sorted(set(candidate_ids))),
            column_mapping=mapping,
        )
        _validate_lineage_spec(result)
        return result

    def __post_init__(self) -> None:
        _validate_lineage_spec(self)

    def to_dict(self) -> dict[str, Any]:
        return {
            "upstream": self.upstream,
            "downstream": self.downstream,
            "relation_type": self.relation_type,
            "candidate_ids": list(self.candidate_ids),
            "column_mapping": {
                target: list(sources) for target, sources in self.column_mapping
            },
        }

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "LineageSpec":
        if not isinstance(value, Mapping):
            raise PublicationError("invalid_lineage_spec")
        _only(value, {"upstream", "downstream", "relation_type", "candidate_ids", "column_mapping"})
        candidate_ids = value.get("candidate_ids", ())
        mapping = value.get("column_mapping", {})
        if not isinstance(candidate_ids, Sequence) or isinstance(candidate_ids, (str, bytes)) or not isinstance(mapping, Mapping):
            raise PublicationError("invalid_lineage_spec")
        return cls.create(
            upstream=_required_text(value.get("upstream"), "invalid_lineage_upstream"),
            downstream=_required_text(value.get("downstream"), "invalid_lineage_downstream"),
            relation_type=_required_text(value.get("relation_type"), "invalid_lineage_relation"),
            candidate_ids=tuple(candidate_ids),
            column_mapping=mapping,
        )


@dataclass(frozen=True)
class PublicationApproval:
    """Serialized approval claim; not authentication or a trusted Decision readback."""

    actor_urn: str
    approved_at_ms: int
    expires_at_ms: int
    technical_lineage: bool
    candidate_ids: tuple[str, ...]
    plan_digest: str | None = None

    def __post_init__(self) -> None:
        if not _ACTOR_URN.fullmatch(self.actor_urn):
            raise PublicationError("invalid_approval_actor")
        if not isinstance(self.approved_at_ms, int) or self.approved_at_ms < 0:
            raise PublicationError("invalid_approval_time")
        if not isinstance(self.expires_at_ms, int) or self.expires_at_ms <= self.approved_at_ms:
            raise PublicationError("invalid_approval_expiry")
        if not isinstance(self.technical_lineage, bool) or not self.technical_lineage:
            raise PublicationError("technical_lineage_approval_required")
        _candidate_ids(self.candidate_ids)
        if self.plan_digest is not None and not _DIGEST.fullmatch(self.plan_digest):
            raise PublicationError("invalid_approval_plan_digest")

    def to_dict(self, *, include_plan_digest: bool = True) -> dict[str, Any]:
        value: dict[str, Any] = {
            "actor_urn": self.actor_urn,
            "approved_at_ms": self.approved_at_ms,
            "expires_at_ms": self.expires_at_ms,
            "technical_lineage": self.technical_lineage,
            "candidate_ids": list(self.candidate_ids),
        }
        if include_plan_digest and self.plan_digest is not None:
            value["plan_digest"] = self.plan_digest
        return value

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "PublicationApproval":
        if not isinstance(value, Mapping):
            raise PublicationError("invalid_approval")
        _only(value, {"actor_urn", "approved_at_ms", "expires_at_ms", "technical_lineage", "candidate_ids", "plan_digest"})
        candidate_ids = value.get("candidate_ids", ())
        if not isinstance(candidate_ids, Sequence) or isinstance(candidate_ids, (str, bytes)):
            raise PublicationError("invalid_approval")
        return cls(
            actor_urn=_required_text(value.get("actor_urn"), "invalid_approval_actor"),
            approved_at_ms=_required_int(value.get("approved_at_ms"), "invalid_approval_time"),
            expires_at_ms=_required_int(value.get("expires_at_ms"), "invalid_approval_expiry"),
            technical_lineage=_required_bool(value.get("technical_lineage"), "technical_lineage_approval_required"),
            candidate_ids=tuple(candidate_ids),
            plan_digest=value.get("plan_digest"),
        )


@dataclass(frozen=True)
class PublicationPlan:
    source_id: str
    snapshot_sha256: str
    candidate_digest: str
    analysis_version: str
    revision: str
    candidate_ids: tuple[str, ...]
    entities: tuple[EntitySpec, ...]
    lineages: tuple[LineageSpec, ...]
    approval: PublicationApproval | None
    plan_digest: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "format": PUBLICATION_FORMAT,
            "source_id": self.source_id,
            "snapshot_sha256": self.snapshot_sha256,
            "candidate_digest": self.candidate_digest,
            "analysis_version": self.analysis_version,
            "revision": self.revision,
            "candidate_ids": list(self.candidate_ids),
            "entities": [entity.to_dict() for entity in self.entities],
            "lineages": [lineage.to_dict() for lineage in self.lineages],
            "approval": self.approval.to_dict() if self.approval is not None else None,
            "plan_digest": self.plan_digest,
        }

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "PublicationPlan":
        if not isinstance(value, Mapping):
            raise PublicationError("invalid_publication_plan")
        _only(
            value,
            {
                "format",
                "source_id",
                "snapshot_sha256",
                "candidate_digest",
                "analysis_version",
                "revision",
                "candidate_ids",
                "entities",
                "lineages",
                "approval",
                "plan_digest",
            },
        )
        if value.get("format") != PUBLICATION_FORMAT:
            raise PublicationError("unsupported_publication_format")
        candidate_ids = value.get("candidate_ids", ())
        entities = value.get("entities", ())
        lineages = value.get("lineages", ())
        if (
            not isinstance(candidate_ids, Sequence)
            or isinstance(candidate_ids, (str, bytes))
            or not isinstance(entities, Sequence)
            or isinstance(entities, (str, bytes))
            or not isinstance(lineages, Sequence)
            or isinstance(lineages, (str, bytes))
        ):
            raise PublicationError("invalid_publication_plan")
        result = cls(
            source_id=_required_text(value.get("source_id"), "invalid_publication_source"),
            snapshot_sha256=_required_text(value.get("snapshot_sha256"), "invalid_snapshot_sha256"),
            candidate_digest=_required_text(value.get("candidate_digest"), "invalid_candidate_digest"),
            analysis_version=_required_text(value.get("analysis_version"), "invalid_analysis_version"),
            revision=_required_text(value.get("revision"), "invalid_source_revision"),
            candidate_ids=tuple(candidate_ids),
            entities=tuple(EntitySpec.from_dict(item) for item in entities),
            lineages=tuple(LineageSpec.from_dict(item) for item in lineages),
            approval=(PublicationApproval.from_dict(value["approval"])
                      if value.get("approval") is not None else None),
            plan_digest=_required_text(value.get("plan_digest"), "invalid_plan_digest"),
        )
        # Historical plans must remain inspectable after expiry. Execution
        # checks the current clock separately in publish_plan.
        validate_publication_plan(result, now_ms=result.approval.approved_at_ms if result.approval else None)
        return result


@dataclass(frozen=True)
class PublicationReceipt:
    status: str
    plan_digest: str
    attempted_entities: tuple[str, ...]
    created_entities: tuple[str, ...]
    existing_entities: tuple[str, ...]
    attempted_lineages: int
    published_lineages: int
    failures: tuple[str, ...]
    warnings: tuple[str, ...]
    readback: tuple[str, ...]

    def to_dict(self) -> dict[str, Any]:
        return {
            "format": RECEIPT_FORMAT,
            "status": self.status,
            "plan_digest": self.plan_digest,
            "attempted_entities": list(self.attempted_entities),
            "created_entities": list(self.created_entities),
            "existing_entities": list(self.existing_entities),
            "attempted_lineages": self.attempted_lineages,
            "published_lineages": self.published_lineages,
            "failures": list(self.failures),
            "warnings": list(self.warnings),
            "readback": list(self.readback),
            "credentials_in_receipt": False,
            "source_rows_in_receipt": False,
        }


def _only(value: Mapping[str, Any], keys: set[str]) -> None:
    if any(key not in keys for key in value):
        raise PublicationError("unknown_publication_field")


def _required_text(value: Any, code: str) -> str:
    if not isinstance(value, str) or not value:
        raise PublicationError(code)
    return value


def _required_int(value: Any, code: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise PublicationError(code)
    return value


def _required_bool(value: Any, code: str) -> bool:
    if not isinstance(value, bool):
        raise PublicationError(code)
    return value


def _candidate_ids(values: Iterable[str]) -> None:
    normalized = list(values)
    if not normalized or len(normalized) != len(set(normalized)):
        raise PublicationError("invalid_candidate_ids")
    if any(not isinstance(item, str) or not _CANDIDATE_ID.fullmatch(item) for item in normalized):
        raise PublicationError("invalid_candidate_ids")


def _safe_text(value: str | None, code: str, limit: int = 8192) -> None:
    if value is not None and (not isinstance(value, str) or not value or len(value) > limit):
        raise PublicationError(code)


def _safe_property(key: str, value: str) -> None:
    if not isinstance(key, str) or not key.startswith("dataflow.discovery.") or len(key) > 256:
        raise PublicationError("unscoped_custom_property")
    if not isinstance(value, str) or len(value) > 8192:
        raise PublicationError("invalid_custom_property")
    lowered = value.lower()
    if any(marker in lowered for marker in ("password=", "passwd=", "secret=", "authorization: bearer", "-----begin ")):
        raise PublicationError("secret_like_custom_property")


def _urn_type(urn: str) -> str:
    if not isinstance(urn, str) or len(urn) > 2048:
        raise PublicationError("invalid_entity_urn")
    try:
        parsed = importlib.import_module("datahub.metadata.urns").Urn.from_string(urn)
    except Exception:
        raise PublicationError("invalid_entity_urn") from None
    if parsed.entity_type not in _ENTITY_TYPES:
        raise PublicationError("unsupported_entity_urn")
    return parsed.entity_type


def _validate_entity_spec(spec: EntitySpec) -> None:
    if spec.candidate_id is not None:
        _candidate_ids((spec.candidate_id,))
    if spec.kind not in _ENTITY_TYPES or _urn_type(spec.urn) != spec.kind:
        raise PublicationError("entity_kind_urn_mismatch")
    _safe_text(spec.platform, "invalid_entity_platform", 256)
    _safe_text(spec.name, "invalid_entity_name", 1024)
    _safe_text(spec.platform_instance, "invalid_platform_instance", 256)
    _safe_text(spec.env, "invalid_entity_env", 64)
    _safe_text(spec.flow_urn, "invalid_flow_urn", 2048)
    _safe_text(spec.display_name, "invalid_display_name", 1024)
    _safe_text(spec.description, "invalid_entity_description")
    if spec.external_url is not None:
        _safe_text(spec.external_url, "invalid_external_url", 2048)
        if not re.fullmatch(r"https?://[^\s/@:]+(?::\d{1,5})?(?:/[^\s]*)?", spec.external_url):
            raise PublicationError("invalid_external_url")
    if not isinstance(spec.custom_properties, tuple):
        raise PublicationError("invalid_custom_properties")
    seen: set[str] = set()
    for key, value in spec.custom_properties:
        if key in seen:
            raise PublicationError("duplicate_custom_property")
        seen.add(key)
        _safe_property(key, value)
    if not isinstance(spec.fields, tuple) or len(spec.fields) > 4096:
        raise PublicationError("invalid_entity_fields")
    field_names = [field.name for field in spec.fields]
    if len(field_names) != len(set(field_names)):
        raise PublicationError("duplicate_entity_field")
    if spec.kind != "dataset" and spec.fields:
        raise PublicationError("fields_only_supported_on_dataset")
    if spec.kind == "dataJob":
        if _urn_type(spec.flow_urn or "") != "dataFlow":
            raise PublicationError("datajob_flow_required")
    elif spec.flow_urn is not None:
        raise PublicationError("flow_only_supported_on_datajob")
    if not isinstance(spec.create_if_missing, bool):
        raise PublicationError("invalid_create_if_missing")
    if spec.create_if_missing and (not spec.name or (spec.kind != "dataJob" and not spec.platform)):
        raise PublicationError("new_entity_identity_required")


def _validate_lineage_spec(spec: LineageSpec) -> None:
    upstream_type = _urn_type(spec.upstream)
    downstream_type = _urn_type(spec.downstream)
    if spec.relation_type not in _RELATIONS:
        raise PublicationError("unsupported_lineage_relation")
    _candidate_ids(spec.candidate_ids)
    if not isinstance(spec.column_mapping, tuple):
        raise PublicationError("invalid_column_mapping")
    if spec.column_mapping and (upstream_type != "dataset" or downstream_type != "dataset"):
        raise PublicationError("column_lineage_requires_dataset_pair")
    for target, sources in spec.column_mapping:
        if not target or not isinstance(target, str) or not sources:
            raise PublicationError("invalid_column_mapping")
        if any(not isinstance(source, str) or not source for source in sources):
            raise PublicationError("invalid_column_mapping")
    pairs = {"contains": ("chart", "dashboard"), "depends_on": ("dataJob", "dataJob"),
             "writes": ("dataJob", "dataset"), "reads": ("dataset", "dataJob"),
             "consumes": ("dataset", "chart"), "transforms": ("dataset", "dataset")}
    if (upstream_type, downstream_type) != pairs[spec.relation_type]:
        raise PublicationError("lineage_endpoint_type_mismatch")
    if spec.upstream == spec.downstream:
        raise PublicationError("self_lineage_requires_versioned_identity")


def _plan_payload(plan: PublicationPlan) -> dict[str, Any]:
    """Stable preparation payload, independent of a later human response.

    This logical-plan digest is not the Host's actual Aspect-mutation digest or
    trusted consent. The Host must compile and bind those separately. Format /2
    included caller-provided approval timestamps and is not accepted as /3.
    """
    return {
        "format": PUBLICATION_FORMAT,
        "source_id": plan.source_id,
        "snapshot_sha256": plan.snapshot_sha256,
        "candidate_digest": plan.candidate_digest,
        "analysis_version": plan.analysis_version,
        "revision": plan.revision,
        "candidate_ids": list(plan.candidate_ids),
        "entities": [entity.to_dict() for entity in plan.entities],
        "lineages": [lineage.to_dict() for lineage in plan.lineages],
    }


def _digest(value: Mapping[str, Any]) -> str:
    canonical = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def validate_publication_plan(
    plan: PublicationPlan, *, now_ms: int | None = None, require_approval: bool = False,
) -> None:
    """Validate structure and optional claim, never authenticated authority."""
    if not isinstance(plan.source_id, str) or not plan.source_id or len(plan.source_id) > 512:
        raise PublicationError("invalid_publication_source")
    for name in ("snapshot_sha256", "candidate_digest"):
        if not isinstance(getattr(plan, name), str) or not _DIGEST.fullmatch(getattr(plan, name)):
            raise PublicationError(f"invalid_{name}")
    if not isinstance(plan.analysis_version, str) or not plan.analysis_version or len(plan.analysis_version) > 64:
        raise PublicationError("invalid_analysis_version")
    if not isinstance(plan.revision, str) or not plan.revision or len(plan.revision) > 256:
        raise PublicationError("invalid_source_revision")
    _candidate_ids(plan.candidate_ids)
    if require_approval and plan.approval is None:
        raise PublicationError("publication_approval_required")
    if plan.approval is not None and set(plan.candidate_ids) != set(plan.approval.candidate_ids):
        raise PublicationError("approval_candidate_set_mismatch")
    if not plan.entities:
        raise PublicationError("publication_entities_required")
    for entity in plan.entities:
        _validate_entity_spec(entity)
        if entity.candidate_id not in plan.candidate_ids:
            raise PublicationError("entity_candidate_not_approved")
    entity_urns = [entity.urn for entity in plan.entities]
    if len(entity_urns) != len(set(entity_urns)):
        raise PublicationError("duplicate_publication_entity")
    entity_set = set(entity_urns)
    for lineage in plan.lineages:
        _validate_lineage_spec(lineage)
        if lineage.upstream not in entity_set or lineage.downstream not in entity_set:
            raise PublicationError("lineage_entity_not_in_plan")
        if any(candidate_id not in set(plan.candidate_ids) for candidate_id in lineage.candidate_ids):
            raise PublicationError("lineage_candidate_not_approved")
    expected = _digest(_plan_payload(plan))
    if not _DIGEST.fullmatch(plan.plan_digest) or expected != plan.plan_digest:
        raise PublicationError("publication_plan_digest_mismatch")
    if plan.approval is None:
        return
    if plan.approval.plan_digest is not None and plan.approval.plan_digest != plan.plan_digest:
        raise PublicationError("approval_plan_digest_mismatch")
    plan.approval.__post_init__()
    current = _current_time_ms() if now_ms is None else now_ms
    if isinstance(current, bool) or not isinstance(current, int) or current < plan.approval.approved_at_ms:
        raise PublicationError("publication_approval_not_yet_valid")
    if current >= plan.approval.expires_at_ms:
        raise PublicationError("publication_approval_expired")


def _python_job_sql_owners(plan: PublicationPlan, selected: Mapping[str, Candidate], snapshot: Snapshot) -> dict:
    """Prove SQL-use ownership in selected Python Jobs, not from call edges alone.

    The Flow must identify a concrete entry function. Reuse the existing bounded
    SQL execution tracer; require its connection acquisition and literal binding.
    Keep original SQL candidate identities and trace guards. This is static
    ownership, not runtime execution, Catalog identity or record-transfer proof.
    """
    ast = importlib.import_module("ast")
    sql_syntax = importlib.import_module("dataflow_discovery.python_sql")
    trace_sql = sql_syntax.analyze_sql_execution
    files = {file.path: file for file in snapshot.files}
    processes: dict[str, set[str]] = {}
    for item in selected.values():
        if item.method == "sql_ast_dependency":
            base = re.sub(r":statement-[1-9][0-9]*$", "", item.subject)
            processes.setdefault(base, set()).add(item.subject)
    owners: dict[tuple[str, str], list[dict]] = {}
    for flow in plan.entities:
        flow_candidate = selected.get(flow.candidate_id) if flow.candidate_id is not None else None
        if (flow.kind != "dataFlow" or flow_candidate is None
                or flow_candidate.method != "python_ast_function" or len(flow_candidate.evidence) != 1):
            continue
        evidence = flow_candidate.evidence[0]
        source = files[evidence.path]
        tree = ast.parse(source.text)
        definitions = {node.name: node for node in tree.body if isinstance(node, ast.FunctionDef)}
        name = dict(flow_candidate.attributes).get("name")
        if name not in definitions or definitions[name].lineno != evidence.start_line:
            continue
        jobs = {}
        for job in plan.entities:
            item = selected.get(job.candidate_id) if job.candidate_id is not None else None
            if (job.kind != "dataJob" or job.flow_urn != flow.urn or item is None
                    or item.method != "python_ast_function" or len(item.evidence) != 1):
                continue
            job_name = dict(item.attributes).get("name")
            if (job_name in definitions and item.evidence[0].path == source.path
                    and item.evidence[0].start_line == definitions[job_name].lineno):
                jobs[job_name] = job.urn
        if not jobs:
            continue
        try:
            trace = trace_sql(source, entrypoint=name)
        except ValueError:
            continue
        if any(finding["reason"] == "sql_trace_limit" for finding in trace["unresolved"]):
            continue
        # Legacy SQL IDs are line-based. Never conflate same-line literals.
        literals = {}
        for line, column in sql_syntax.python_sql_literals(tree):
            literals[line] = literals.get(line, 0) + 1
        for use in trace["uses"]:
            if use["binding_status"] != "SYNTAX_BOUND" or literals.get(use["sql"]["line"]) != 1:
                continue
            # A nested selected Job owns its SQL; its parent is not also an I/O owner.
            invoked = [step.rsplit("->", 1)[-1] for step in use["call_path"][1:]]
            owning_job = next((jobs[callee] for callee in reversed(invoked) if callee in jobs), None)
            if owning_job is not None:
                for process in processes.get(use["sql"]["process"], ()):
                    owners.setdefault((owning_job, process), []).append(use)
    return owners


def _python_job_catalog_bindings(plan, selected, analysis, snapshot, python_analysis, catalog_reader):
    """Recompute resource bindings from source and Host-scoped Catalog, not a supplied graph.

    Resource reads are not returned-value or runtime-execution claims. Unknown
    container transport remains ineligible, rather than promoting declarations.
    """
    if (not isinstance(python_analysis, Mapping)
            or set(python_analysis) != {'path', 'entrypoint', 'scopes_by_context'}
            or catalog_reader is None):
        raise PublicationError('invalid_python_catalog_context')
    flows = [entity for entity in plan.entities if entity.kind == 'dataFlow'
             and entity.candidate_id in selected
             and dict(selected[entity.candidate_id].attributes).get('name') == python_analysis['entrypoint']
             and len(selected[entity.candidate_id].evidence) == 1
             and selected[entity.candidate_id].evidence[0].path == python_analysis['path']]
    if len(flows) != 1:
        raise PublicationError('python_catalog_entrypoint_mismatch')
    binder = importlib.import_module('dataflow_discovery.python_lookup_values').bind_python_lookup_values
    try:
        report = binder(analysis, snapshot, reader=catalog_reader, **python_analysis)
    except importlib.import_module('dataflow_discovery.catalog').CatalogBindingError as error:
        raise PublicationError('python_catalog_binding_unavailable') from error
    if report['transport']['findings']:
        raise PublicationError('python_transport_incomplete')
    # The consuming SQL is evidence even when its output is not selected for
    # publication. Ownership still considers only the plan's selected Flow/Jobs.
    owners = _python_job_sql_owners(plan, {item.candidate_id:item for item in analysis.candidates}, snapshot)
    contexts = {context['context_id']:context for context in report['query_decoders']['contexts']}
    jobs = [entity.urn for entity in plan.entities if entity.kind == 'dataJob' and entity.flow_urn == flows[0].urn]
    physical = {(binding['dataset_subject'], binding['dataset']['urn'])
                for context in report['contexts'] if context['status'] == 'CATALOG_BOUND'
                for binding in context['bindings'] if binding['status'] == 'CATALOG_BOUND'}
    if any((selected[entity.candidate_id].subject, entity.urn) not in physical
           for entity in plan.entities if entity.kind == 'dataset'):
        raise PublicationError('python_resource_entity_binding_mismatch')
    bindings = set()
    read_roles = {'value', 'condition', 'lookup_key', 'lookup_values', 'evaluated_argument', 'evaluated_callee'}
    for context in report['contexts']:
        if context['status'] != 'CATALOG_BOUND':
            continue
        # The same SQL AST may run under different Jobs and connections. A
        # process-level owner union would invent cross-namespace Job inputs.
        consuming_jobs = [job for job in jobs if any(context['use'] in owners.get((job, process), ())
                                                    for process in context['processes'])]
        for job in consuming_jobs:
            for binding in context['bindings']:
                bindings.add((job, binding['candidate_id'], binding['relation_type'], binding['dataset']['urn']))
        producers = set()
        for statement in context['write_statements']:
            for slot in statement['slots']:
                for link in slot['record_consumer']['links']:
                    # Evaluated fields can be Job inputs without being output
                    # value origins. Invalidated declarations cannot prove them.
                    if (not link['chain_findings']
                            and link['consumer_role'] in read_roles
                            and link['decoder_read_role'] in read_roles):
                        producers.add(link['producer_context_id'])
                for lookup in slot['lookup_values']['declarations']:
                    reads = [*lookup['map_key_reads'], *lookup['map_value_reads']]
                    if (not lookup['chain_findings'] and reads
                            and lookup['consumer_role'] in read_roles
                            and all(not read['chain_findings'] and read['read_role'] in read_roles for read in reads)):
                        producers.update(read['producer_context_id'] for read in reads)
        for producer_id in producers:
            producer = contexts[producer_id]
            if producer['status'] != 'CATALOG_BOUND':
                continue
            # Include the consumed query's JOIN/filter table dependencies, not
            # a fabricated expansion from every Job input to every output.
            for binding in producer['bindings']:
                if binding['relation_type'] == 'reads':
                    for job in consuming_jobs:
                        bindings.add((job, binding['candidate_id'], 'reads', binding['dataset']['urn']))
    return bindings


def validate_publication_binding(plan: PublicationPlan, analysis: AnalysisResult, snapshot: Snapshot, *,
                                 python_analysis=None, catalog_reader=None) -> None:
    """Bind every proposed edge to actual candidates and a Host identity map.

    This validates the translation, not the truth of the Host's Catalog identity
    resolution or its authority. The authenticated Host must supply current
    source capture and independently resolved entity/schema identities.
    """
    report = _validator.validate_analysis(analysis, snapshot)
    if report.findings or not set(plan.candidate_ids).issubset(report.publishable_candidate_ids):
        raise PublicationError("candidate_validation_failed")
    if (plan.source_id, plan.snapshot_sha256, plan.candidate_digest, plan.analysis_version) != (
        analysis.source_id, analysis.snapshot_sha256, analysis.digest, analysis.analysis_version
    ):
        raise PublicationError("publication_source_binding_mismatch")
    # Digest-valid caller-authored claims are still not analyzer evidence.
    # Reproduce static candidates from the actual captured bytes/version.
    reproduced = importlib.import_module("dataflow_discovery.analyzer").analyze_snapshot(snapshot)
    if reproduced.digest != analysis.digest:
        raise PublicationError("analysis_not_reproducible_from_source")
    selected = {item.candidate_id: item for item in analysis.candidates if item.candidate_id in plan.candidate_ids}
    by_subject: dict[str, str] = {}
    scoped_dataset_subjects: set[str] = set()
    used: set[str] = set()
    for entity in plan.entities:
        item = selected.get(entity.candidate_id)
        if item is None:
            raise PublicationError("entity_candidate_not_approved")
        expected_kind, prefix = {
            "dataset": ("asset", "dataset:"), "chart": ("asset", "bi:chart:"),
            "dashboard": ("asset", "bi:dashboard:"), "dataFlow": ("process", "process:"),
            "dataJob": ("process", "process:"),
        }[entity.kind]
        if item.kind != expected_kind or not item.subject.startswith(prefix):
            raise PublicationError("entity_candidate_kind_mismatch")
        if item.subject in by_subject or item.subject in scoped_dataset_subjects:
            if python_analysis is None or entity.kind != 'dataset':
                raise PublicationError("ambiguous_subject_identity")
            # A source symbol is not a global Catalog identity. Do not retain an
            # arbitrary first/last URN for other relationship or column paths.
            # The scoped path below must independently prove each physical edge.
            scoped_dataset_subjects.add(item.subject)
            by_subject.pop(item.subject, None)
        else:
            by_subject[item.subject] = entity.urn
        used.add(item.candidate_id)
    python_job_sql_owners = None
    scoped_bindings = (None if python_analysis is None else
                       _python_job_catalog_bindings(plan, selected, analysis, snapshot, python_analysis, catalog_reader))
    for lineage in plan.lineages:
        relation_seen = False
        column_pairs: set[tuple[str, str]] = set()
        for candidate_id in lineage.candidate_ids:
            item = selected.get(candidate_id)
            if item is None:
                raise PublicationError("lineage_candidate_not_approved")
            attributes = dict(item.attributes)
            if item.kind == "relationship":
                relation = attributes.get("relation_type")
                subject, obj = by_subject.get(item.subject), by_subject.get(item.object)
                if scoped_bindings is not None and item.method == 'sql_ast_dependency' and relation in {'reads', 'writes'}:
                    job_urn = lineage.downstream if relation == 'reads' else lineage.upstream
                    dataset_urn = lineage.upstream if relation == 'reads' else lineage.downstream
                    if (job_urn, candidate_id, relation, dataset_urn) not in scoped_bindings:
                        raise PublicationError('python_resource_candidate_binding_mismatch')
                    subject, obj = job_urn, dataset_urn
                elif subject is None and item.method == "sql_ast_dependency" and relation in {"reads", "writes"}:
                    if python_job_sql_owners is None:
                        python_job_sql_owners = _python_job_sql_owners(plan, selected, snapshot)
                    job_urn = lineage.downstream if relation == "reads" else lineage.upstream
                    if (job_urn, item.subject) in python_job_sql_owners:
                        subject = job_urn
                endpoints = (obj, subject) if relation in {"reads", "consumes", "contains", "depends_on"} else (subject, obj)
                if relation != lineage.relation_type or endpoints != (lineage.upstream, lineage.downstream):
                    raise PublicationError("lineage_candidate_binding_mismatch")
                relation_seen = True
            elif item.kind == "field_mapping":
                # Query-local aliases and Python names are not Catalog fields.
                # A schema-resolved candidate must carry both dataset subjects.
                source_dataset = _required_text(attributes.get("source_dataset"), "unresolved_column_ownership")
                target_dataset = _required_text(attributes.get("target_dataset"), "unresolved_column_ownership")
                source_field = _required_text(attributes.get("source_field"), "unresolved_column_ownership")
                target_field = _required_text(attributes.get("target_field"), "unresolved_column_ownership")
                if (by_subject.get(source_dataset), by_subject.get(target_dataset)) != (lineage.upstream, lineage.downstream):
                    raise PublicationError("column_candidate_binding_mismatch")
                column_pairs.add((target_field, source_field))
            else:
                raise PublicationError("lineage_requires_relationship_candidate")
            used.add(candidate_id)
        if not relation_seen:
            raise PublicationError("lineage_requires_relationship_candidate")
        requested = {(target, source) for target, sources in lineage.column_mapping for source in sources}
        if requested != column_pairs:
            raise PublicationError("column_candidate_binding_mismatch")
    if used != set(plan.candidate_ids):
        raise PublicationError("unused_approved_candidate")


def make_publication_plan(
    analysis: AnalysisResult,
    snapshot: Snapshot,
    *,
    approval: PublicationApproval | None = None,
    entities: Sequence[EntitySpec],
    lineages: Sequence[LineageSpec] = (),
    revision: str = "content",
    python_analysis=None,
    catalog_reader=None,
) -> PublicationPlan:
    """Build a source-reproducible plan, not a grant of write authority.

    The caller (trusted Host) resolves the entity/URN mapping. Every mapping
    needs an entity candidate and every edge must match the actual relationship
    candidate in both direction and endpoints. This does not infer Catalog
    identity from unqualified SQL names or turn all candidates into edges.
    """
    report = _validator.validate_analysis(analysis, snapshot)
    if report.status == "FAIL":
        raise PublicationError("candidate_validation_failed")
    publishable = set(report.publishable_candidate_ids)
    if approval is not None:
        selected = set(approval.candidate_ids)
    else:
        selected = set()
        for entity in entities:
            if entity.candidate_id is None:
                raise PublicationError("entity_candidate_not_approved")
            selected.add(entity.candidate_id)
        for lineage in lineages:
            selected.update(lineage.candidate_ids)
    if not selected.issubset(publishable):
        raise PublicationError("unpublishable_candidate_approval")
    plan_without_digest = PublicationPlan(
        source_id=analysis.source_id,
        snapshot_sha256=analysis.snapshot_sha256,
        candidate_digest=analysis.digest,
        analysis_version=analysis.analysis_version,
        revision=revision,
        candidate_ids=tuple(sorted(selected)),
        entities=tuple(entities),
        lineages=tuple(lineages),
        approval=approval,
        plan_digest="0" * 64,
    )
    digest = _digest(_plan_payload(plan_without_digest))
    plan = PublicationPlan(
        **{**plan_without_digest.__dict__, "plan_digest": digest},
    )
    # A preview does not invent an approval actor or time. If a later claim is
    # attached, its structural/time checks remain distinct from trusted consent.
    validate_publication_plan(plan, now_ms=approval.approved_at_ms if approval else None)
    validate_publication_binding(plan, analysis, snapshot, python_analysis=python_analysis, catalog_reader=catalog_reader)
    return plan


def publication_preview(plan: PublicationPlan) -> dict[str, Any]:
    """Return a non-secret, deterministic preview; never contacts DataHub."""
    validate_publication_plan(plan, now_ms=plan.approval.approved_at_ms if plan.approval else None)
    return {
        "format": "dataflow-discovery.publication-preview/2",
        "status": "PLAN_ONLY_REQUIRES_TRUSTED_AUTHORIZATION",
        "plan_digest": plan.plan_digest,
        "source_id": plan.source_id,
        "snapshot_sha256": plan.snapshot_sha256,
        "candidate_digest": plan.candidate_digest,
        "candidate_ids": list(plan.candidate_ids),
        "entity_urns": [entity.urn for entity in plan.entities],
        "lineages": [lineage.to_dict() for lineage in plan.lineages],
        "approval": plan.approval.to_dict() if plan.approval is not None else None,
    }


def _current_time_ms() -> int:
    try:
        return int(time.time() * 1000)
    except (OverflowError, ValueError):
        raise PublicationError("clock_unavailable") from None


def _is_not_found(error: Exception) -> bool:
    errors = importlib.import_module("datahub.errors")
    not_found = getattr(errors, "ItemNotFoundError", None)
    return isinstance(not_found, type) and isinstance(error, not_found)


def _client_entity_exists(client: Any, urn: str) -> tuple[bool, Any | None]:
    """Use the public SDK get operation; only a typed not-found is absence."""
    try:
        current = client.entities.get(urn)
        return True, current
    except Exception as error:
        if _is_not_found(error):
            return False, None
        raise


def _entity_properties(entity: Any) -> dict[str, str]:
    value = getattr(entity, "custom_properties", {})
    if value is None:
        return {}
    if not isinstance(value, Mapping):
        raise PublicationError("existing_custom_properties_unreadable")
    return {str(key): str(item) for key, item in value.items()}


def _missing_custom_properties(spec: EntitySpec, current: Any) -> dict[str, str]:
    existing = _entity_properties(current)
    missing: dict[str, str] = {}
    for key, value in spec.custom_properties:
        if key in existing and existing[key] != value:
            raise PublicationError("existing_owned_property_conflict")
        if key not in existing:
            missing[key] = value
    return missing


def _schema_matches(spec: EntitySpec, current: Any) -> bool:
    if not spec.fields:
        return True
    try:
        fields = getattr(current, "schema")
        actual = {
            field.field_path: str(field.native_type).lower()
            for field in fields
        }
    except Exception as error:
        raise PublicationError("existing_schema_unreadable") from error
    expected = {field.name: field.native_type.lower() for field in spec.fields}
    return actual == expected


def _patch_existing_properties(client: Any, spec: EntitySpec, current: Any) -> None:
    missing = _missing_custom_properties(spec, current)
    if not missing:
        return
    builders: dict[str, tuple[str, str]] = {
        "dataset": ("datahub.specific.dataset", "DatasetPatchBuilder"),
        "dataJob": ("datahub.specific.datajob", "DataJobPatchBuilder"),
        "chart": ("datahub.specific.chart", "ChartPatchBuilder"),
        "dashboard": ("datahub.specific.dashboard", "DashboardPatchBuilder"),
    }
    builder_info = builders.get(spec.kind)
    if builder_info is None:
        # There is no public DataFlow patch builder in the pinned SDK.  Refuse
        # a full-aspect rewrite rather than risking manual metadata loss.
        raise PublicationError("existing_dataflow_property_requires_safe_patch")
    module = importlib.import_module(builder_info[0])
    builder = getattr(module, builder_info[1])(spec.urn)
    builder.add_custom_properties(missing)
    client.entities.update(builder)


def _entity_object(spec: EntitySpec) -> Any:
    """Construct a new official SDK entity from an explicit spec."""
    sdk = importlib.import_module("datahub.sdk")
    kwargs = {
        "platform": spec.platform,
        "name": spec.name,
        "platform_instance": spec.platform_instance,
        "env": spec.env,
        "display_name": spec.display_name,
        "description": spec.description,
        "external_url": spec.external_url,
        "custom_properties": dict(spec.custom_properties),
        "subtype": spec.subtype,
    }
    if spec.kind == "dataset":
        if spec.fields:
            kwargs["schema"] = [
                (field.name, field.native_type, field.description)
                if field.description is not None
                else (field.name, field.native_type)
                for field in spec.fields
            ]
        entity = sdk.Dataset(**_drop_none(kwargs))
    elif spec.kind == "dataFlow":
        entity = sdk.DataFlow(**_drop_none(kwargs))
    elif spec.kind == "dataJob":
        entity = sdk.DataJob(
            name=spec.name,
            flow_urn=spec.flow_urn,
            platform_instance=spec.platform_instance,
            display_name=spec.display_name,
            description=spec.description,
            external_url=spec.external_url,
            custom_properties=dict(spec.custom_properties),
            subtype=spec.subtype,
        )
    elif spec.kind == "chart":
        kwargs.pop("env")
        entity = sdk.Chart(**_drop_none(kwargs))
    elif spec.kind == "dashboard":
        kwargs.pop("env")
        entity = sdk.Dashboard(**_drop_none(kwargs))
    else:  # pragma: no cover - guarded by EntitySpec validation
        raise PublicationError("unsupported_entity_kind")
    if str(entity.urn) != spec.urn:
        raise PublicationError("entity_spec_urn_mismatch")
    return entity


def compile_workspace_lineage(analysis, snapshot, report, workflow, *, env):
    """Source-bound desired native Aspects for the Composer's selected entrypoint.

    Called inside the trusted workspace binder, never with a model-provided
    report. This performs no writes, adoption, schema replacement or consent.
    The Host must merge against native values and show the conditional diff.
    """
    from datahub.emitter.mcp import MetadataChangeProposalWrapper
    from datahub.metadata.urns import DataFlowUrn, DataJobUrn, SchemaFieldUrn
    from datahub.metadata.schema_classes import (
        DataFlowInfoClass, DataJobInfoClass, DataJobInputOutputClass,
        UpstreamLineageClass, UpstreamClass, FineGrainedLineageClass,
    )
    if (report['snapshot_sha256'] != snapshot.sha256 or report['candidate_digest'] != analysis.digest
            or report['source_id'] != analysis.source_id):
        raise PublicationError('workspace_compiler_source_mismatch')
    if (not report['output_partition']['complete'] or not workflow['coverage']['sqlOwnershipComplete']
            or report['trace_findings']):
        raise PublicationError('workspace_lineage_incomplete')
    if importlib.import_module('importlib.metadata').version('acryl-datahub') != '1.7.0.9':
        raise PublicationError('publication_sdk_version_unverified')
    flow = workflow['flow']
    flow_urn = str(DataFlowUrn('python', flow['id'].split(':', 1)[1], env))
    jobs = {job['id']: str(DataJobUrn(flow_urn, job['id'].split(':', 1)[1])) for job in workflow['jobs']}
    properties = {'datahub_etl.sourceId': analysis.source_id, 'datahub_etl.snapshot': snapshot.sha256,
                  'datahub_etl.entrypoint': report['path'] + '::' + report['entrypoint'],
                  'datahub_etl.analysisVersion': analysis.analysis_version,
                  'datahub_etl.evidenceScope': 'selected_python_entrypoint_static_declarations'}
    encode = lambda value: json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    catalog_bindings = {binding['dataset']['urn']: binding['dataset']['schema_sha256']
                        for context in report['contexts'] for binding in context['bindings']}
    views = report.get('declared_views', {}).get('views', [])
    bi_queries = report.get('dashboard_queries', {}).get('queries', [])
    for declaration in [*views, *bi_queries]:
        for dataset in [*declaration['inputs'], *([declaration['target']] if 'target' in declaration else [])]:
            if dataset['urn'] in catalog_bindings and catalog_bindings[dataset['urn']] != dataset['schema_sha256']:
                raise PublicationError('workspace_compiler_source_mismatch')
            catalog_bindings[dataset['urn']] = dataset['schema_sha256']
    catalog_urns = sorted(catalog_bindings)
    catalog_indexes = {urn: index for index, urn in enumerate(catalog_urns)}
    properties['datahub_etl.schemas'] = encode([{'urn': urn, 'schemaSha256': catalog_bindings[urn]} for urn in catalog_urns])
    sql_contexts = {context['context_id']: index for index, context in enumerate(report['contexts'])}
    properties['datahub_etl.sqlContexts'] = encode([{'id': context['context_id'], 'processes': context['processes'],
        'line': context['use']['sql']['line'], 'callPath': context['use']['call_path'], 'guards': context['use']['guards']}
        for context in report['contexts']])
    origin_refs = lambda values: [[catalog_indexes[item['dataset_urn']], item['field_path']] for item in values]
    def projection_proof(output):
        return {key: (origin_refs(value) if key in {'origins', 'condition_origins'} else value)
                for key, value in output.items()}
    condition_sets, condition_ids = [], {}
    def condition_refs(conditions):
        refs = []
        for condition in conditions:
            proof = {**condition, 'origins': origin_refs(condition['origins'])}
            key = _digest(proof)
            if key not in condition_ids:
                condition_ids[key] = len(condition_sets)
                condition_sets.append(proof)
            refs.append(condition_ids[key])
        return refs
    properties['datahub_etl.relatedDeclarations'] = encode({
        'format': 'datahub-etl.related-declarations/1', 'conditionSets': condition_sets,
        'views': [{'dataset': catalog_indexes[view['urn']], 'evidence': view['evidence'],
                   'outputs': [projection_proof(output) for output in view['outputs']],
                   'conditions': condition_refs(view['conditions']), 'ddlAppliedVerified': False}
                  for view in views],
        'biQueries': [{**{key: query[key] for key in ('path', 'fileSha256', 'dashboardUid', 'kind', 'id', 'querySha256', 'parameters')},
                       'outputs': [projection_proof(output) for output in query['outputs']],
                       'conditions': condition_refs(query['conditions'])}
                      for query in bi_queries],
        'nativeQueryBindingsDigest': _digest(report.get('native_dashboard_queries', {})),
        'liveGrafanaVerified': False})
    targets, field_edges = {}, {}
    for field in report['output_partition']['fields']:
        urn = field['dataset_urn']
        targets.setdefault(urn, set()).update(origin['dataset_urn'] for origin in [*field['origins'], *field['condition_origins']])
        for fact in field['generated']:
            targets[urn].update(fact.get('input_datasets', []))
        # Store generated/constant/condition distinctions with source locations,
        # not as fabricated source-field edges. Plain literals are never copied.
        proof = {key: field[key] for key in ('field_path', 'classification', 'generated', 'constants')}
        proof.update(dataset=catalog_indexes[urn], origins=origin_refs(field['origins']),
                     condition_origins=origin_refs(field['condition_origins']))
        proof['declarations'] = [{'context': sql_contexts[item['context_id']],
                                 'statement': report['contexts'][sql_contexts[item['context_id']]]['processes'].index(item['process']),
                                 'position': item['position'], 'expression_sha256': item['expression_sha256']}
                                for item in field['declarations']]
        properties['datahub_etl.field.' + _digest({'urn': urn, 'field': field['field_path']})[:24]] = encode(proof)
        if field['origins']:
            field_edges.setdefault(urn, []).append(FineGrainedLineageClass(
                upstreamType='FIELD_SET', downstreamType='FIELD',
                upstreams=[str(SchemaFieldUrn(origin['dataset_urn'], origin['field_path'])) for origin in field['origins']],
                downstreams=[str(SchemaFieldUrn(urn, field['field_path']))],
                transformOperation='STATIC_VALUE_DEPENDENCY', confidenceScore=1.0))
    # A read of the same target for incremental/update logic is evidence but must
    # not create a dataset-level cycle. Existing self-lineage is not removed here.
    for urn in targets:
        targets[urn].discard(urn)
    aspects = []
    def add(urn, aspect):
        mcp = MetadataChangeProposalWrapper(entityUrn=urn, aspect=aspect)
        if not mcp.validate():
            raise PublicationError('invalid_compiled_native_aspects')
        aspects.append({'urn': urn, 'aspect': mcp.aspectName, 'value': aspect.to_obj()})
    add(flow_urn, DataFlowInfoClass(name=flow['name'], env=env, customProperties=properties))
    contexts = {context['context_id']: context for context in report['contexts']}
    for job in workflow['jobs']:
        dependencies = sorted({jobs[item['from']] for item in workflow['dependencies'] if item['to'] == job['id']})
        evidence = {'source': job['evidence'], 'contexts': job['contexts'],
                    'invocations': job['invocations'], 'guards': [contexts[cid]['use']['guards'] for cid in job['contexts']],
                    'rowEffects': [{'contextId': cid, 'process': statement['process'], 'effect': statement['row_effect']}
                                  for cid in job['contexts'] for statement in contexts[cid]['write_statements']
                                  if 'row_effect' in statement],
                    'dependencies': [item for item in workflow['dependencies'] if item['to'] == job['id']]}
        add(jobs[job['id']], DataJobInfoClass(name=job['name'], type='COMMAND', flowUrn=flow_urn,
            customProperties={'datahub_etl.sourceId': analysis.source_id, 'datahub_etl.evidence': encode(evidence)}))
        add(jobs[job['id']], DataJobInputOutputClass(inputDatasets=[item['urn'] for item in job['reads']],
            outputDatasets=[item['urn'] for item in job['writes']], inputDatajobs=dependencies))
    for view in views:
        if view['urn'] in targets:
            raise PublicationError('workspace_view_write_conflict')
        edges = [FineGrainedLineageClass(upstreamType='FIELD_SET', downstreamType='FIELD',
                    upstreams=[str(SchemaFieldUrn(origin['dataset_urn'], origin['field_path'])) for origin in output['origins']],
                    downstreams=[str(SchemaFieldUrn(view['urn'], output['field']))],
                    transformOperation='STATIC_VALUE_DEPENDENCY', confidenceScore=1.0)
                 for output in view['outputs'] if output['origins']]
        add(view['urn'], UpstreamLineageClass(upstreams=[UpstreamClass(dataset=item['urn'], type='VIEW') for item in view['inputs']],
                                             fineGrainedLineages=edges))
    for urn, inputs in sorted(targets.items()):
        if inputs or field_edges.get(urn):
            add(urn, UpstreamLineageClass(upstreams=[UpstreamClass(dataset=item, type='TRANSFORMED') for item in sorted(inputs)],
                                        fineGrainedLineages=field_edges.get(urn, [])))
    return {'format': 'datahub-etl.desired-aspects/1', 'sourceId': analysis.source_id,
        'snapshotSha256': snapshot.sha256, 'candidateDigest': analysis.digest, 'analysisVersion': analysis.analysis_version,
        'flowUrn': flow_urn, 'jobUrns': jobs, 'aspects': aspects,
        'candidateIds': sorted({flow['candidateId'], *(job['candidateId'] for job in workflow['jobs']),
                               *(binding['candidate_id'] for context in report['contexts'] for binding in context['bindings'])}),
        'datasets': catalog_urns,
        'publicationAuthorized': False, 'nativeMergeRequired': True, 'runtimeValuesVerified': False}


def compile_publication_mcps(
    plan: PublicationPlan, *, root: str, paths: Sequence[str], source_id: str,
    python_analysis=None, catalog_reader=None,
) -> tuple[Any, ...]:
    """Compile source-bound INITIAL desired Aspects without a client or writes.

    Uses public SDK setters/as_mcps, so reviews can see all generated Aspects
    (including editable properties). These are NOT safe replacements for an
    existing entity: the Host must establish current values/versions, preserve
    manual metadata and form the final reviewed diff before conditional writes.
    Reference-only entities produce no Aspects. Unsupported relationships refuse
    the whole compilation, rather than silently dropping part of the plan.
    """
    if importlib.import_module("importlib.metadata").version("acryl-datahub") != "1.7.0.9":
        raise PublicationError("publication_sdk_version_unverified")
    validate_publication_plan(plan)
    current = importlib.import_module("dataflow_discovery.host").capture_and_analyze(
        root, paths, source_id=source_id,
    )
    validate_publication_binding(plan, current.analysis, current.snapshot,
                                 python_analysis=python_analysis, catalog_reader=catalog_reader)
    if plan.revision != "content" and (current.revision.kind != "git" or current.revision.dirty
                                       or plan.revision != current.revision.commit):
        raise PublicationError("publication_revision_mismatch")
    specs = {spec.urn: spec for spec in plan.entities}
    entities = {spec.urn: _entity_object(spec) for spec in plan.entities if spec.create_if_missing}
    job_ports: dict[tuple[str, str], set[str]] = {}
    for edge in plan.lineages:
        shape = (specs[edge.upstream].kind, specs[edge.downstream].kind, edge.relation_type)
        if edge.column_mapping:
            raise PublicationError("native_column_compilation_unverified")
        owner = edge.upstream if shape == ("dataJob", "dataset", "writes") else edge.downstream
        if owner not in entities:
            raise PublicationError("reference_entity_cannot_receive_aspects")
        entity = entities[owner]
        if shape == ("dataset", "dataJob", "reads"):
            job_ports.setdefault((owner, "inlets"), set()).add(edge.upstream)
        elif shape == ("dataJob", "dataset", "writes"):
            job_ports.setdefault((owner, "outlets"), set()).add(edge.downstream)
        elif shape == ("dataset", "chart", "consumes"):
            entity.add_input_dataset(edge.upstream)
        elif shape == ("chart", "dashboard", "contains"):
            entity.add_chart(edge.upstream)
        else:
            raise PublicationError("native_relationship_compilation_unverified")
    # In SDK 1.7.0.9 these public setters APPEND to legacy Dataset arrays.
    # Call once per direction, not repeatedly with a growing cumulative list.
    for (urn, direction), datasets in job_ports.items():
        if direction == "inlets":
            entities[urn].set_inlets(sorted(datasets))
        else:
            entities[urn].set_outlets(sorted(datasets))
    records = tuple(record for urn in sorted(entities) for record in entities[urn].as_mcps())
    keys = [(record.entityUrn, record.aspectName) for record in records]
    if len(keys) != len(set(keys)) or not all(record.validate() for record in records):
        raise PublicationError("invalid_compiled_native_aspects")
    return records


def _drop_none(value: Mapping[str, Any]) -> dict[str, Any]:
    return {key: item for key, item in value.items() if item is not None}


def _emit_entity(client: Any, spec: EntitySpec) -> str:
    exists, current = _client_entity_exists(client, spec.urn)
    if exists:
        if spec.fields and not _schema_matches(spec, current):
            raise PublicationError("existing_schema_revision_conflict")
        _patch_existing_properties(client, spec, current)
        return "existing"
    if not spec.create_if_missing:
        raise PublicationError("required_connector_entity_missing")
    entity = _entity_object(spec)
    client.entities.create(entity)
    return "created"


def _lineage_call(client: Any, spec: LineageSpec) -> None:
    mapping = {target: list(sources) for target, sources in spec.column_mapping}
    kwargs: dict[str, Any] = {
        "upstream": spec.upstream,
        "downstream": spec.downstream,
    }
    if mapping:
        kwargs["column_lineage"] = mapping
    client.lineage.add_lineage(**kwargs)


def _readback_entity(client: Any, urn: str) -> bool:
    exists, _ = _client_entity_exists(client, urn)
    return exists


def _readback_lineage(client: Any, spec: LineageSpec) -> bool:
    results = client.lineage.get_lineage(
        source_urn=spec.upstream,
        direction="downstream",
        max_hops=1,
        count=500,
    )
    return any(getattr(result, "urn", None) == spec.downstream for result in results)


def publish_plan(
    plan: PublicationPlan,
    client: Any,
    *,
    root: str,
    paths: Sequence[str],
    source_id: str,
    now_ms: int | None = None,
    readback: bool = True,
    emit: Callable[[Any, EntitySpec], str] | None = None,
) -> PublicationReceipt:
    """Publish once through the supplied trusted DataHub SDK client.

    ``client`` must be constructed by the trusted Host with an operator-owned
    server and token.  It is intentionally not constructible from an Agent
    request. ``root``, ``paths`` and ``source_id`` must independently come from
    Host policy, not plan JSON. The live allowlist is recaptured and its analysis
    reproduced before any client IO. The Host still must verify a bound human
    Decision, source/target ACL and authoritative Catalog identity/schema; a
    PublicationApproval value alone is not authority.

    No automatic retries occur: an exception from an emit is recorded as an
    outcome needing reconciliation before any replay.
    """
    validate_publication_plan(plan, now_ms=now_ms, require_approval=True)
    # These parameters come from Host policy, not from plan/model JSON. Reading
    # the live allowlist here prevents callers replaying an old in-memory snapshot.
    current = importlib.import_module("dataflow_discovery.host").capture_and_analyze(
        root, paths, source_id=source_id,
    )
    validate_publication_binding(plan, current.analysis, current.snapshot)
    if plan.revision != "content" and (current.revision.kind != "git" or current.revision.dirty or plan.revision != current.revision.commit):
        raise PublicationError("publication_revision_mismatch")
    # Capture/analysis can consume approval lifetime; check again before IO.
    validate_publication_plan(plan, now_ms=now_ms, require_approval=True)
    if client is None:
        raise PublicationError("datahub_client_required")
    emit_entity = emit or _emit_entity
    ordered_entities = tuple(
        sorted(
            plan.entities,
            key=lambda item: (
                {"dataFlow": 0, "dataset": 1, "dataJob": 2, "chart": 3, "dashboard": 4}[item.kind],
                item.urn,
            ),
        )
    )
    attempted_entities: list[str] = []
    created_entities: list[str] = []
    existing_entities: list[str] = []
    failures: list[str] = []
    warnings: list[str] = []
    published_lineages = 0
    attempted_lineages: list[LineageSpec] = []
    for spec in ordered_entities:
        attempted_entities.append(spec.urn)
        try:
            outcome = emit_entity(client, spec)
            if outcome == "created":
                created_entities.append(spec.urn)
            elif outcome == "existing":
                existing_entities.append(spec.urn)
            else:
                raise PublicationError("invalid_entity_emit_result")
        except Exception as error:
            # The SDK may have sent an MCP before raising.  Do not label this
            # as a clean rejection and do not replay automatically.
            failures.append(f"entity_emit_unknown:{spec.urn}:{type(error).__name__}")
            break
    for lineage in plan.lineages:
        if failures:
            break
        attempted_lineages.append(lineage)
        try:
            _lineage_call(client, lineage)
            published_lineages += 1
        except Exception as error:
            failures.append(
                f"lineage_emit_unknown:{lineage.upstream}->{lineage.downstream}:{type(error).__name__}"
            )
    readback_results: list[str] = []
    if readback:
        for urn in (*created_entities, *existing_entities):
            try:
                if _readback_entity(client, urn):
                    readback_results.append(f"entity:{urn}:PASS")
                else:
                    failures.append(f"entity_readback_missing:{urn}")
            except Exception as error:
                failures.append(f"entity_readback_unknown:{urn}:{type(error).__name__}")
        for lineage in attempted_lineages:
            try:
                if _readback_lineage(client, lineage):
                    readback_results.append(
                        f"lineage:{lineage.upstream}->{lineage.downstream}:PASS"
                    )
                else:
                    failures.append(
                        f"lineage_readback_missing:{lineage.upstream}->{lineage.downstream}"
                    )
            except Exception as error:
                failures.append(
                    f"lineage_readback_unknown:{lineage.upstream}->{lineage.downstream}:{type(error).__name__}"
                )
    if failures:
        status = "UNKNOWN_NEEDS_RECONCILIATION"
        warnings.append("No automatic retry or rollback was performed; reconcile DataHub readback before replay.")
    else:
        # Current readback only checks entity/table reachability. It does not
        # establish column mappings, aspect values or cross-system commitment.
        status = "ENTITY_TABLE_READBACK_ONLY" if readback else "ACKNOWLEDGED_NOT_READ_BACK"
    return PublicationReceipt(
        status=status,
        plan_digest=plan.plan_digest,
        attempted_entities=tuple(attempted_entities),
        created_entities=tuple(created_entities),
        existing_entities=tuple(existing_entities),
        attempted_lineages=len(attempted_lineages),
        published_lineages=published_lineages,
        failures=tuple(failures),
        warnings=tuple(warnings),
        readback=tuple(readback_results),
    )


def client_from_environment(*, server: str, token: str | None) -> Any:
    """Create the SDK client on a trusted Host, never in the Agent runtime."""
    if not isinstance(server, str) or not re.fullmatch(r"https?://[^\s/@:]+(?::\d{1,5})?", server):
        raise PublicationError("invalid_datahub_server")
    if token is not None and (not isinstance(token, str) or not token):
        raise PublicationError("invalid_datahub_token")
    sdk = importlib.import_module("datahub.sdk")
    return sdk.DataHubClient(server=server, token=token)
"""Read-only Catalog binding at the trusted Host boundary.

This MSSQL compatibility adapter resolves identities, not authorization, execution
or lineage semantics. Scopes and the authenticated reader MUST be supplied by the
Host after source/actor/tenant policy checks, never reconstructed from model input.
No persistence, Catalog writes, suffix search, or inferred default connection.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
from typing import Any, Protocol

import sqlglot
from sqlglot import expressions as exp
from datahub.metadata.schema_classes import DatasetKeyClass, SchemaMetadataClass, StatusClass
from datahub.metadata.urns import DatasetUrn

from .analyzer import analyze_snapshot
from .candidate import AnalysisResult
from .snapshot import Snapshot
from .validator import validate_analysis


class CatalogBindingError(ValueError):
    """Bounded reason code only; never expose a reader's exception/credentials."""


class CatalogReader(Protocol):
    def get_aspect(self, entity_urn: str, aspect_type: Any) -> Any: ...


def _digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                    ensure_ascii=False).encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class MssqlScope:
    """Host-established connection namespace and exact readable Catalog allowlist.

    Separate SQL statements in one Python file may need different scopes. A file
    name, candidate source_id, or a unique search hit is NOT connection evidence.
    Normalization must match the verified native ingestion configuration. This
    first adapter rejects platform instances and dotted physical identifiers until
    their non-colliding native URN convention is verified.
    """
    database: str
    default_schema: str | None
    env: str
    lowercase_urns: bool
    lowercase_fields: bool
    allowed_dataset_urns: tuple[str, ...]

    def __post_init__(self) -> None:
        if (not isinstance(self.database, str) or not self.database
                or self.default_schema is not None and (
                    not isinstance(self.default_schema, str) or not self.default_schema)
                or not isinstance(self.env, str) or not self.env
                or type(self.lowercase_urns) is not bool or type(self.lowercase_fields) is not bool
                or not isinstance(self.allowed_dataset_urns, tuple)
                or not 1 <= len(self.allowed_dataset_urns) <= 256
                or any(not isinstance(urn, str) for urn in self.allowed_dataset_urns)
                or len(set(self.allowed_dataset_urns)) != len(self.allowed_dataset_urns)):
            raise CatalogBindingError("invalid_host_catalog_scope")
        for urn in self.allowed_dataset_urns:
            try:
                parsed = DatasetUrn.from_string(urn)
                valid = str(parsed) == urn and str(parsed.platform) == "urn:li:dataPlatform:mssql" and parsed.env == self.env
            except Exception:
                valid = False
            if not valid:
                raise CatalogBindingError("invalid_host_catalog_scope")

    def normalize(self, name: str) -> str:
        return name.lower() if self.lowercase_urns else name


@dataclass(frozen=True)
class BoundDataset:
    urn: str
    schema_sha256: str
    key_sha256: str
    field_paths: tuple[str, ...]
    lowercase_fields: bool

    def field(self, physical_column: str) -> str:
        """Return the actual fieldPath. Caller must already know the table owner.

        No alias stripping, suffix matching, nested-field guessing or ownership
        inference. A query's output alias is not a physical input column.
        """
        if not isinstance(physical_column, str) or not physical_column:
            raise CatalogBindingError("invalid_physical_column")
        normalize = str.lower if self.lowercase_fields else str
        matches = [field for field in self.field_paths if normalize(field) == normalize(physical_column)]
        if len(matches) != 1:
            raise CatalogBindingError("catalog_column_missing_or_ambiguous")
        return matches[0]

    def to_dict(self) -> dict[str, Any]:
        return {"urn": self.urn, "schema_sha256": self.schema_sha256,
                "key_sha256": self.key_sha256, "field_paths": list(self.field_paths),
                "lowercase_fields": self.lowercase_fields}


def _dataset_urn(identifier: str, scope: MssqlScope) -> str:
    try:
        table = sqlglot.parse_one(identifier, read="tsql", into=exp.Table)
    except Exception:
        raise CatalogBindingError("unsupported_sql_identifier") from None
    if (not isinstance(table, exp.Table)
            or table.args.get("catalog") and not table.args.get("db")
            or any(value for key, value in table.args.items() if key not in {"this", "db", "catalog"})
            or not 1 <= len(table.parts) <= 3
            or any(not isinstance(part, exp.Identifier) or part.args.get("temporary")
                   or not part.name or "." in part.name for part in table.parts)):
        raise CatalogBindingError("unsupported_sql_identifier")
    parts = [part.name for part in table.parts]
    if len(parts) == 1:
        if scope.default_schema is None:
            raise CatalogBindingError("default_schema_unresolved")
        parts.insert(0, scope.default_schema)
    if len(parts) == 2:
        parts.insert(0, scope.database)
    if scope.normalize(parts[0]) != scope.normalize(scope.database):
        raise CatalogBindingError("database_outside_host_scope")
    if any("." in part for part in parts):
        raise CatalogBindingError("unsupported_sql_identifier")
    urn = str(DatasetUrn(platform="mssql", name=scope.normalize(".".join(parts)), env=scope.env))
    if urn not in scope.allowed_dataset_urns:
        raise CatalogBindingError("dataset_outside_host_allowlist")
    return urn


def resolve_dataset(identifier: str, scope: MssqlScope, reader: CatalogReader) -> BoundDataset:
    """Read current native key, status and schema through the caller's ACL reader.

    A typed GraphQL reference or SDK object alone is not existence evidence. An
    absent key, absent/removed status, empty schema, or read error fails closed.
    Aspect reads are not an atomic Catalog snapshot; publication must re-read and
    perform its own conditional writes against owned aspects.
    """
    urn = _dataset_urn(identifier, scope)
    try:
        key = reader.get_aspect(urn, DatasetKeyClass)
        status = reader.get_aspect(urn, StatusClass)
        schema = reader.get_aspect(urn, SchemaMetadataClass)
    except Exception:
        raise CatalogBindingError("catalog_read_failed") from None
    if not isinstance(key, DatasetKeyClass):
        raise CatalogBindingError("catalog_key_missing")
    parsed = DatasetUrn.from_string(urn)
    if (key.platform, key.name, key.origin) != (str(parsed.platform), parsed.name, parsed.env):
        raise CatalogBindingError("catalog_key_mismatch")
    if not isinstance(status, StatusClass) or status.removed is not False:
        raise CatalogBindingError("catalog_status_missing_or_removed")
    if not isinstance(schema, SchemaMetadataClass) or not schema.fields:
        raise CatalogBindingError("catalog_schema_missing_or_empty")
    if schema.platform != str(parsed.platform):
        raise CatalogBindingError("catalog_schema_platform_mismatch")
    fields = tuple(field.fieldPath for field in schema.fields)
    if any(not isinstance(field, str) or not field for field in fields) or len(set(fields)) != len(fields):
        raise CatalogBindingError("catalog_schema_fields_invalid")
    return BoundDataset(urn, _digest(schema.to_obj()), _digest(key.to_obj()), fields, scope.lowercase_fields)


def bind_sql_dependencies(
    analysis: AnalysisResult, snapshot: Snapshot, *,
    scopes_by_process: dict[str, MssqlScope], reader: CatalogReader,
) -> dict[str, Any]:
    """Bind reproducible SQL read/write candidates; leave their status untouched.

    This report is deliberately NOT a PublicationPlan nor new approved candidates.
    Unknown connection scopes stay unresolved even if only one Catalog hit exists.
    The same dataset label can resolve differently for two statement processes.
    """
    report = validate_analysis(analysis, snapshot)
    if report.findings or analyze_snapshot(snapshot).digest != analysis.digest:
        raise CatalogBindingError("catalog_analysis_not_source_bound")
    processes = {item.subject for item in analysis.candidates
                 if item.kind == "process" and item.method == "sql_ast_statement"}
    if (not isinstance(scopes_by_process, dict) or not set(scopes_by_process).issubset(processes)
            or any(not isinstance(scope, MssqlScope) for scope in scopes_by_process.values())):
        raise CatalogBindingError("invalid_host_process_scope")
    bindings = []
    # Reuse only within this call; never carry schemas into the next validation.
    cache: dict[tuple[MssqlScope, str], BoundDataset] = {}
    for item in analysis.candidates:
        if item.kind != "relationship" or item.method != "sql_ast_dependency":
            continue
        entry: dict[str, Any] = {"candidate_id": item.candidate_id, "process": item.subject,
                                 "dataset_subject": item.object,
                                 "relation_type": dict(item.attributes)["relation_type"]}
        scope = scopes_by_process.get(item.subject)
        try:
            if scope is None:
                raise CatalogBindingError("connection_scope_unresolved")
            if not item.object or not item.object.startswith("dataset:"):
                raise CatalogBindingError("invalid_dataset_candidate")
            identifier = item.object.removeprefix("dataset:")
            key = (scope, identifier)
            if key not in cache:
                cache[key] = resolve_dataset(identifier, scope, reader)
            entry.update(status="CATALOG_BOUND", dataset=cache[key].to_dict())
        except CatalogBindingError as error:
            entry.update(status="UNRESOLVED", reason=str(error))
        bindings.append(entry)
    return {"format": "dataflow-discovery.catalog-binding/1", "source_id": analysis.source_id,
            "snapshot_sha256": snapshot.sha256, "candidate_digest": analysis.digest,
            "status": "CATALOG_BOUND" if bindings and all(b["status"] == "CATALOG_BOUND" for b in bindings) else "INCONCLUSIVE",
            "bindings": bindings, "publication_authorized": False,
            "limitations": ["Host connection-scope provenance and ACL required",
                            "No Python call graph or query alias promoted to lineage",
                            "Catalog reads are non-atomic; revalidate before publication"]}

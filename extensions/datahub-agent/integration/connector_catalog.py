"""Offline schema contracts. No plugin imports, secrets, network or ingestion.

The deployment supplies reviewed schemas; callers select only a catalog ID.
This validates JSON Schema, NOT connector custom validators or connectivity.
"""

from copy import deepcopy
import hashlib
from itertools import islice
import json
from typing import Any

from jsonschema import Draft202012Validator
from referencing import Registry


class CatalogError(ValueError):
    """Static error codes safe to expose without input values or tracebacks."""


def _canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def _check_local_schema(value: Any) -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            if key == "$id" or (
                key in {"$ref", "$dynamicRef", "$recursiveRef"}
                and (not isinstance(child, str) or not child.startswith("#"))
            ):
                raise CatalogError("external_schema_reference_forbidden")
            _check_local_schema(child)
    elif isinstance(value, list):
        for child in value:
            _check_local_schema(child)


class ConnectorCatalog:
    """Trusted backend library shared by future UI/MCP adapters, not an API.

    Each deployment entry has id, version (reviewed package/release identity),
    and config_schema. JSON Schema cannot replace ACL or secret-binding policy.
    """

    def __init__(self, entries: list[dict[str, Any]]) -> None:
        self._entries: dict[str, dict[str, Any]] = {}
        self._validators: dict[str, Draft202012Validator] = {}
        for original in entries:
            entry = deepcopy(original)
            if set(entry) != {"id", "version", "config_schema"} or any(
                not isinstance(entry.get(key), str) or not entry[key].strip()
                for key in ("id", "version")
            ):
                raise CatalogError("invalid_catalog_entry")
            if entry["id"] in self._entries:
                raise CatalogError("duplicate_connector_id")
            schema = entry["config_schema"]
            if not isinstance(schema, dict) or schema.get("$schema") not in {
                None, "https://json-schema.org/draft/2020-12/schema"
            }:
                raise CatalogError("unsupported_schema_dialect")
            _check_local_schema(schema)
            try:
                Draft202012Validator.check_schema(schema)
                fingerprint = hashlib.sha256(_canonical(entry)).hexdigest()
            except Exception:
                # Schemas can contain deployment values; never echo an exception.
                raise CatalogError("invalid_connector_schema") from None
            entry["schema_fingerprint"] = fingerprint
            self._entries[entry["id"]] = entry
            # Empty Registry has no network retrieval; even unresolved local refs
            # fail closed rather than fetching a resource from the network.
            self._validators[entry["id"]] = Draft202012Validator(schema, registry=Registry())

    def _get(self, connector_id: str) -> dict[str, Any]:
        if not isinstance(connector_id, str) or connector_id not in self._entries:
            raise CatalogError("connector_not_allowed")
        return self._entries[connector_id]

    def list_connectors(self) -> list[dict[str, Any]]:
        return [
            {key: value for key, value in self._entries[name].items() if key != "config_schema"}
            for name in sorted(self._entries)
        ]

    def get_connector_schema(self, connector_id: str) -> dict[str, Any]:
        return deepcopy(self._get(connector_id))

    def validate_source_config(
        self, connector_id: str, config: Any, *, schema_fingerprint: str
    ) -> dict[str, Any]:
        entry = self._get(connector_id)
        if schema_fingerprint != entry["schema_fingerprint"]:
            raise CatalogError("stale_connector_schema")
        try:
            payload = _canonical(config)
            if len(payload) > 1024 * 1024 or not isinstance(config, dict):
                raise CatalogError("invalid_config_document")
            normalized = json.loads(payload)
        except (TypeError, ValueError, RecursionError):
            raise CatalogError("invalid_config_document") from None
        try:
            errors = list(islice(self._validators[connector_id].iter_errors(normalized), 21))
        except Exception:
            raise CatalogError("connector_schema_unavailable") from None
        return {
            "connector_id": connector_id,
            "schema_fingerprint": entry["schema_fingerprint"],
            "validation_level": "json_schema_only",
            "status": "invalid" if errors else "schema_valid",
            # Do not expose message, instance, instance-path (may contain user
            # dictionary keys), context or exception text. Only trusted schema paths.
            "errors": [
                {"keyword": error.validator, "schema_path": list(error.absolute_schema_path)}
                for error in errors[:20]
            ],
            "errors_truncated": len(errors) > 20,
        }

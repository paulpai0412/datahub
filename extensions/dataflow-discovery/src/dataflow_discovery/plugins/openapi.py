"""OpenAPI 3.0 JSON declarations only. Never HTTP, imports, samples or execution."""
from __future__ import annotations

import re
from typing import Any

from ..plugin_api import decode_json, file_evidence, node_id
from ..snapshot import Snapshot, SourceFile

MANIFEST = {
    "id": "openapi-operations", "version": "0.1.0", "contractVersion": "1", "kind": "asset",
    "capabilities": ["api-operations", "declared-json-ports"], "suffixes": [".json"],
    "limitations": ["OpenAPI 3.0 JSON only; no API calls or inferred example schemas",
                    "Object/scalar JSON fields only; arrays/composition/dynamic schemas remain findings",
                    "Declarations are not deployed routes, verified Catalog identities or value lineage"],
    "configSchema": {"type": "object", "additionalProperties": False, "required": ["serviceId"],
        "properties": {"serviceId": {"type": "string", "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]*$", "maxLength": 128}}},
}
_METHODS = frozenset({"get", "post", "put", "patch", "delete", "head", "options", "trace"})
_SCALARS = frozenset({"string", "integer", "number", "boolean"})


def _escape(value: str) -> str:
    return value.replace("~", "~0").replace("/", "~1")


class _Document:
    def __init__(self, snapshot: Snapshot, source: SourceFile, document: dict[str, Any], graph: dict[str, Any], service: str):
        self.scope, self.source, self.document, self.graph, self.service = snapshot.source_id, source, document, graph, service

    def evidence(self, pointer: str) -> list[dict[str, Any]]:
        return [file_evidence(self.source, pointer=pointer)]

    def finding(self, code: str, pointer: str) -> None:
        self.graph["findings"].append({"code": code, "evidence": self.evidence(pointer)})

    def resolve(self, value: Any, pointer: str, seen: tuple[str, ...] = ()) -> tuple[Any, str]:
        if not isinstance(value, dict) or "$ref" not in value:
            return value, pointer
        ref = value["$ref"]
        if not isinstance(ref, str) or not ref.startswith("#/") or set(value) != {"$ref"}:
            self.finding("openapi_reference_unsupported", pointer)
            return None, pointer
        if ref in seen or len(seen) >= 24:
            self.finding("openapi_reference_cycle", pointer)
            return None, pointer
        target: Any = self.document
        try:
            for part in ref[2:].split("/"):
                target = target[part.replace("~1", "/").replace("~0", "~")]
        except (KeyError, TypeError):
            self.finding("openapi_reference_missing", pointer)
            return None, pointer
        return self.resolve(target, ref[1:], (*seen, ref))

    def fields(self, schema: Any, pointer: str, prefix: str = "", seen: tuple[str, ...] = ()) -> list[dict[str, Any]]:
        if pointer in seen or len(seen) >= 24:
            self.finding("openapi_schema_cycle", pointer)
            return []
        schema, resolved_pointer = self.resolve(schema, pointer)
        if schema is None:
            return []
        if resolved_pointer in seen:
            self.finding("openapi_schema_cycle", pointer)
            return []
        seen = (*seen, pointer, resolved_pointer)
        if not isinstance(schema, dict) or any(key in schema for key in ("allOf", "oneOf", "anyOf", "not", "discriminator")):
            self.finding("openapi_schema_unsupported", resolved_pointer)
            return []
        if any(name in schema for name in ("readOnly", "writeOnly")):
            self.finding("openapi_directional_schema_not_projected", resolved_pointer)
            return []
        kind = schema.get("type")
        if not isinstance(kind, str):
            self.finding("openapi_schema_unsupported", resolved_pointer)
            return []
        if kind in _SCALARS:
            field: dict[str, Any] = {"path": prefix or "/", "nativeType": kind}
            if "nullable" in schema:
                if type(schema["nullable"]) is not bool:
                    self.finding("openapi_nullable_invalid", resolved_pointer)
                else:
                    field["nullable"] = schema["nullable"]
            return [field]
        if kind != "object" or not isinstance(schema.get("properties"), dict):
            self.finding("openapi_schema_unsupported", resolved_pointer)
            return []
        if schema.get("additionalProperties") is not False:
            self.finding("openapi_open_object", resolved_pointer)
        if schema.get("nullable") is True:
            self.finding("openapi_nullable_object", resolved_pointer)
        fields: list[dict[str, Any]] = []
        for name, child in sorted(schema["properties"].items()):
            fields.extend(self.fields(child, resolved_pointer + "/properties/" + _escape(name),
                                      prefix + "/" + _escape(name), seen))
        return fields

    def port(self, owner: str, local: str, name: str, direction: str, schema: Any, pointer: str) -> None:
        self.graph["nodes"].append({"id": node_id(self.scope, "port", local), "kind": "port", "localId": local,
            "name": name, "owner": owner, "direction": direction, "fields": self.fields(schema, pointer),
            "evidence": self.evidence(pointer)})

    def content(self, owner: str, local: str, container: Any, pointer: str, role: str) -> None:
        container, pointer = self.resolve(container, pointer)
        if not isinstance(container, dict):
            self.finding("openapi_content_invalid", pointer)
            return
        if "headers" in container or "links" in container:
            self.finding("openapi_response_metadata_not_projected", pointer)
        content = container.get("content", {})
        if not isinstance(content, dict):
            self.finding("openapi_content_invalid", pointer)
            return
        for media, body in sorted(content.items()):
            location = pointer + "/content/" + _escape(media)
            if media != "application/json" or not isinstance(body, dict) or "schema" not in body:
                self.finding("openapi_media_schema_unsupported", location)
                continue
            port_name = role + ":" + media
            self.port(owner, local + ":" + port_name, port_name, "input" if role == "request" else "output",
                      body["schema"], location + "/schema")

    def operation(self, route: str, method: str, operation: Any, pointer: str) -> None:
        if not isinstance(operation, dict):
            self.finding("openapi_operation_invalid", pointer)
            return
        local = f"api:{self.service}:{method.upper()}:{route}"
        identity = node_id(self.scope, "asset", local)
        self.graph["nodes"].append({"id": identity, "kind": "asset", "localId": local, "assetType": "api",
                                    "name": method.upper() + " " + route, "evidence": self.evidence(pointer)})
        for unsupported in ("callbacks", "parameters", "security", "servers"):
            if unsupported in operation:
                self.finding("openapi_" + unsupported + "_not_projected", pointer + "/" + unsupported)
        if "requestBody" in operation:
            self.content(identity, local, operation["requestBody"], pointer + "/requestBody", "request")
        responses = operation.get("responses")
        if not isinstance(responses, dict) or not responses:
            self.finding("openapi_responses_missing", pointer)
            return
        for status, response in sorted(responses.items()):
            location = pointer + "/responses/" + _escape(status)
            if status != "default" and re.fullmatch(r"[1-5](?:[0-9]{2}|XX)", status) is None:
                self.finding("openapi_response_status_unsupported", location)
                continue
            self.content(identity, local, response, location, "response:" + status)

    def analyze(self) -> None:
        for unsupported in ("servers", "security"):
            if unsupported in self.document:
                self.finding("openapi_global_" + unsupported + "_not_projected", "/" + unsupported)
        paths = self.document.get("paths")
        if not isinstance(paths, dict) or not paths:
            self.finding("openapi_paths_missing", "")
            return
        for route, item in sorted(paths.items()):
            pointer = "/paths/" + _escape(route)
            if not route.startswith("/") or not isinstance(item, dict) or "$ref" in item:
                self.finding("openapi_path_unsupported", pointer)
                continue
            for name in ("parameters", "servers"):
                if name in item:
                    self.finding("openapi_path_" + name + "_not_projected", pointer + "/" + name)
            for method, operation in sorted(item.items()):
                if method in _METHODS:
                    self.operation(route, method, operation, pointer + "/" + method)
                elif method not in {"summary", "description", "parameters", "servers"} and not method.startswith("x-"):
                    self.finding("openapi_path_member_unsupported", pointer + "/" + _escape(method))


def analyze(snapshot: Snapshot, config: dict[str, Any]) -> dict[str, Any]:
    graph: dict[str, Any] = {"nodes": [], "edges": [], "coverage": [], "findings": []}
    for source in snapshot.files:
        document: Any = None
        try:
            if source.path.endswith(".json"):
                document = decode_json(source.text)
        except (ValueError, RecursionError):
            pass
        supported = isinstance(document, dict) and isinstance(document.get("openapi"), str) and re.fullmatch(r"3\.0\.[0-9]+", document["openapi"])
        graph["coverage"].append({"path": source.path, "state": "analyzed" if supported else "unsupported",
                                  "reason": "openapi_3_0_declarations" if supported else "openapi_document_unsupported"})
        if not supported:
            graph["findings"].append({"code": "openapi_document_unsupported", "evidence": [file_evidence(source)]})
            continue
        _Document(snapshot, source, document, graph, config["serviceId"]).analyze()
    graph["nodes"].sort(key=lambda node: node["id"])
    return graph

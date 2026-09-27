"""Offline, unapproved API aspect draft. No emitter, network or candidate imports.

Compatibility seam: Contract v1 source evidence -> public DataHub SDK aspects.
Only inline scalar OpenAPI 3.0 YAML operations are supported. YAML syntax nodes
bind IR subjects to source; names/localIds never supply REST semantics. This is
NOT source authorization, a trusted approval receipt, or a publication plan.
"""
from __future__ import annotations

from typing import Any
import re

import yaml
from yaml.nodes import MappingNode, Node, ScalarNode, SequenceNode

from .candidate_protocol import decode_input, validate_candidate_output
from .plugin_api import MAX_RESULT_BYTES, PluginError, canonical, digest

FORMAT = "dataflow-discovery.api-aspect-draft/1"
METHODS = frozenset({"get", "put", "post", "delete", "options", "head", "patch", "trace"})
SCALARS = frozenset({"string", "integer", "number", "boolean"})
TAG = "tag:yaml.org,2002:"


class ApiMappingError(PluginError):
    """A bounded code; never source snippets or transport failures."""


def _map(node: Node | None) -> dict[str, Node]:
    if not isinstance(node, MappingNode):
        raise ApiMappingError("api_mapping_object_required")
    result: dict[str, Node] = {}
    for key, value in node.value:
        if not isinstance(key, ScalarNode) or key.tag not in {TAG + "str", TAG + "int"} or key.value in result:
            raise ApiMappingError("api_mapping_ambiguous_yaml_key")
        result[key.value] = value
    return result


def _text(node: Node | None) -> str:
    if not isinstance(node, ScalarNode) or node.tag != TAG + "str":
        raise ApiMappingError("api_mapping_string_required")
    return node.value


def _boolean(node: Node | None, default: bool = False) -> bool:
    if node is None:
        return default
    if not isinstance(node, ScalarNode) or node.tag != TAG + "bool":
        raise ApiMappingError("api_mapping_boolean_required")
    return node.value.lower() in {"true", "yes", "on"}


def _document(text: str) -> MappingNode:
    # compose constructs syntax nodes only, never Python objects from YAML tags.
    try:
        root = yaml.compose(text, Loader=yaml.SafeLoader)
    except (yaml.YAMLError, RecursionError):
        raise ApiMappingError("api_mapping_yaml_invalid") from None
    pending = [(root, 0)]
    seen: set[int] = set()
    while pending:
        node, depth = pending.pop()
        if node is None or depth > 64 or id(node) in seen or len(seen) >= 16000:
            raise ApiMappingError("api_mapping_yaml_alias_or_limit")
        seen.add(id(node))
        if node.tag not in {TAG + name for name in ("map", "seq", "str", "int", "float", "bool", "null")}:
            raise ApiMappingError("api_mapping_yaml_tag_unsupported")
        if isinstance(node, MappingNode):
            _map(node)  # Detect duplicates throughout the document, including examples.
            pending.extend((child, depth + 1) for pair in node.value for child in pair)
        elif isinstance(node, SequenceNode):
            pending.extend((child, depth + 1) for child in node.value)
    if not isinstance(root, MappingNode):
        raise ApiMappingError("api_mapping_object_required")
    return root


def _span(node: Node) -> tuple[int, int]:
    start = node.start_mark.line + 1
    # A block mapping's end mark can point at the next key's indentation,
    # not at included content. Contract v1 YAML evidence uses this exclusive
    # end line (with a one-line minimum), as in the approved scalar candidate.
    return start, max(start, node.end_mark.line)


def _subject(nodes: list[dict[str, Any]], source: Any, syntax: Node, **constraints: str) -> dict[str, Any]:
    start, end = _span(syntax)
    matches = [node for node in nodes if all(node.get(k) == v for k, v in constraints.items()) and
               len(node["evidence"]) == 1 and node["evidence"][0] == {
                   "path": source.path, "fileSha256": source.sha256, "startLine": start, "endLine": end}]
    if len(matches) != 1:
        raise ApiMappingError("api_mapping_subject_ambiguous_or_missing")
    return matches[0]


def _field(body: Node, *, optional: bool) -> tuple[Any, str, Node]:
    from datahub.metadata.schema_classes import (
        BooleanTypeClass, NumberTypeClass, SchemaFieldClass, SchemaFieldDataTypeClass, StringTypeClass,
    )
    values = _map(body)
    # Keep a deliberately small projection; don't silently choose the first
    # response/media type, flatten objects, or retrieve/resolve references.
    if set(values) - {"type", "nullable", "description", "title"}:
        raise ApiMappingError("api_mapping_schema_unsupported")
    native_type = _text(values.get("type"))
    if native_type not in SCALARS:
        raise ApiMappingError("api_mapping_schema_unsupported")
    types = {"string": StringTypeClass, "integer": NumberTypeClass,
             "number": NumberTypeClass, "boolean": BooleanTypeClass}
    field = SchemaFieldClass(fieldPath="/", nativeDataType=native_type,
                             type=SchemaFieldDataTypeClass(type=types[native_type]()),
                             nullable=optional or _boolean(values.get("nullable")),
                             description=_text(values["description"]) if "description" in values else None)
    return field, native_type, body


def _body_schema(body: Node) -> tuple[str, Node]:
    values = _map(body)
    if "$ref" in values or "headers" in values or "links" in values:
        raise ApiMappingError("api_mapping_body_unsupported")
    content = _map(values.get("content"))
    if len(content) != 1:
        raise ApiMappingError("api_mapping_multiple_media_types")
    media, media_node = next(iter(content.items()))
    if media != "application/json":
        raise ApiMappingError("api_mapping_media_type_unsupported")
    media_values = _map(media_node)
    if set(media_values) - {"schema", "example", "examples"}:
        raise ApiMappingError("api_mapping_body_unsupported")
    schema = media_values.get("schema")
    if schema is None:
        raise ApiMappingError("api_mapping_schema_missing")
    return media, schema


def _operation(source: Any, path: str, method: str, operation: Node,
               nodes: list[dict[str, Any]], context: dict[str, str]) -> tuple[dict[str, Any], set[str]]:
    from datahub.metadata.schema_classes import ApiPropertiesClass, ApiSignatureClass, RestApiPropertiesClass, SubTypesClass
    values = _map(operation)
    if set(values) - {"summary", "description", "operationId", "tags", "requestBody", "responses", "deprecated", "security", "servers", "externalDocs"}:
        raise ApiMappingError("api_mapping_operation_unsupported")
    asset = _subject(nodes, source, operation, kind="asset", assetType="api")
    inputs, outputs, bindings = [], [], []
    consumed = {asset["id"]}
    bodies = []
    if "requestBody" in values:
        request = values["requestBody"]
        bodies.append(("input", request, not _boolean(_map(request).get("required")), None))
    responses = _map(values.get("responses"))
    if len(responses) != 1:
        raise ApiMappingError("api_mapping_multiple_responses")
    status, response = next(iter(responses.items()))
    if re.fullmatch(r"[1-5][0-9]{2}", status) is None:
        raise ApiMappingError("api_mapping_response_status_unsupported")
    bodies.append(("output", response, False, status))
    for direction, body, optional, status_code in bodies:
        media, schema = _body_schema(body)
        field, native_type, syntax = _field(schema, optional=optional)
        port = _subject(nodes, source, syntax, kind="port", owner=asset["id"], direction=direction)
        expected = {"path": "/", "nativeType": native_type}
        fields = port["fields"]
        if len(fields) != 1 or {k: v for k, v in fields[0].items() if k != "nullable"} != expected:
            raise ApiMappingError("api_mapping_field_mismatch")
        # IR nullable (when supplied) means source schema nullability, whereas
        # DataHub SchemaField nullable means optional OR nullable.
        nullable = _boolean(_map(schema).get("nullable"))
        if "nullable" in fields[0] and fields[0]["nullable"] != nullable:
            raise ApiMappingError("api_mapping_field_mismatch")
        consumed.add(port["id"])
        (inputs if direction == "input" else outputs).append(field)
        bindings.append({"portId": port["id"], "direction": direction, "mediaType": media,
                         "responseStatus": status_code, "bodyOptional": optional,
                         "schemaNullable": nullable, "evidence": port["evidence"]})
    identity = {**context, "method": method.upper(), "path": path}
    urn = "urn:li:api:discovery-v1-" + digest(identity)
    aspects = [ApiPropertiesClass(name=method.upper() + " " + path),
               SubTypesClass(typeNames=["REST_ENDPOINT"]),
               RestApiPropertiesClass(method=method.upper(), path=path),
               # Exact original source, NOT a guessed/flattened schema. The
               # method/path aspect selects the operation in a multi-op source.
               ApiSignatureClass(schemaDefinition=source.text, inputFields=inputs, outputFields=outputs)]
    after = {}
    for aspect in aspects:
        if not aspect.validate():
            raise ApiMappingError("api_mapping_sdk_validation_failed")
        after[aspect.ASPECT_NAME] = aspect.to_obj()
    return {"urn": urn, "identity": identity, "assetNodeId": asset["id"], "sourceEvidence": asset["evidence"],
            "portBindings": bindings, "desiredAspects": after}, consumed


def compile_api_draft(trusted_input: dict[str, Any], result: dict[str, Any],
                      context: dict[str, str]) -> dict[str, Any]:
    """Pure offline draft; context MUST come from an operator/Host, not plugin data.

    Revalidation proves source/result consistency, NOT authenticity or approval.
    Callers still own source authorization and receipt provenance verification.
    """
    if (not isinstance(result, dict) or not isinstance(context, dict)
            or set(context) != {"tenantId", "sourceId", "serviceId"} or any(
            not isinstance(v, str) or not v or len(v) > 256 or any(ord(c) < 32 for c in v)
            for v in context.values())):
        raise ApiMappingError("api_mapping_context_invalid")
    snapshot, manifest, config = decode_input(trusted_input)
    if snapshot.source_id != context["sourceId"] or config != {"serviceId": context["serviceId"]}:
        raise ApiMappingError("api_mapping_scope_mismatch")
    checked = validate_candidate_output(trusted_input, canonical({"graph": result.get("graph")}))
    if canonical(checked) != canonical(result):
        raise ApiMappingError("api_mapping_result_mismatch")
    graph = checked["graph"]
    if not checked["coverageComplete"] or graph["edges"] or "legacyAnalysis" in graph:
        raise ApiMappingError("api_mapping_graph_not_supported")
    entities, consumed = [], set()
    total_bytes = 0
    for source in snapshot.files:
        root = _map(_document(source.text))
        if re.fullmatch(r"3\.0\.[0-9]+", _text(root.get("openapi"))) is None:
            raise ApiMappingError("api_mapping_openapi_version_unsupported")
        for path, path_node in _map(root.get("paths")).items():
            if not path.startswith("/") or any(ord(c) < 32 for c in path):
                raise ApiMappingError("api_mapping_path_invalid")
            methods = _map(path_node)
            if set(methods) - METHODS:
                raise ApiMappingError("api_mapping_path_item_unsupported")
            for method, operation in methods.items():
                entity, ids = _operation(source, path, method, operation, graph["nodes"], context)
                if consumed & ids:
                    raise ApiMappingError("api_mapping_subject_reused")
                consumed.update(ids)
                total_bytes += len(canonical(entity))
                if total_bytes > MAX_RESULT_BYTES:
                    raise ApiMappingError("api_mapping_draft_too_large")
                entities.append(entity)
    if not entities or consumed != {node["id"] for node in graph["nodes"]} or len({e["urn"] for e in entities}) != len(entities):
        raise ApiMappingError("api_mapping_unmapped_or_duplicate_subject")
    draft = {"format": FORMAT, "status": "DRAFT_NOT_AUTHORIZED", "aspectEncoding": "datahub-sdk-json",
             "context": dict(context), "sourceSnapshot": snapshot.sha256,
             "resultDigest": checked["resultDigest"], "contractDigest": checked["contractDigest"],
             "plugin": {"id": manifest["id"], "version": manifest["version"]},
             "entities": sorted(entities, key=lambda e: e["urn"]), "publicationAuthorized": False,
             "runtimeVerified": False, "catalogCompared": False,
             "limitations": ["inline scalar JSON request/response only; one response/media type per operation",
                             "SchemaField nullable projects optional OR nullable; exact source retained in schemaDefinition",
                             "identity proposal is not ACL enforcement or a registered namespace",
                             "no lineage, deployment, approval, write transport or live Catalog assertions"]}
    draft["draftDigest"] = digest(draft)
    return draft


def compare_api_draft(draft: dict[str, Any], observations: dict[str, Any] | None = None) -> dict[str, Any]:
    """Offline SDK-value comparison, never a writable patch or live receipt.

    Optional observations are caller-supplied data, not verified here. HEAD404
    with no stored aspects permits only a CONDITIONAL_NEW proposal; missing
    observations never imply absence. Existing differing aspects are conflicts,
    never replacements. Real ACL/version/freshness gates remain unimplemented.
    """
    if draft.get("format") != FORMAT or draft.get("publicationAuthorized") is not False or draft.get("draftDigest") != digest({k: v for k, v in draft.items() if k != "draftDigest"}):
        raise ApiMappingError("api_mapping_draft_mismatch")
    observations = {} if observations is None else observations
    urns = {e["urn"] for e in draft["entities"]}
    if not isinstance(observations, dict) or set(observations) - urns:
        raise ApiMappingError("api_mapping_observation_scope_mismatch")
    changes = []
    for entity in draft["entities"]:
        observation = observations.get(entity["urn"])
        if observation is not None:
            if (not isinstance(observation, dict) or set(observation) != {"headStatus", "aspects"}
                    or type(observation["headStatus"]) is not int or observation["headStatus"] not in {204, 404}
                    or not isinstance(observation["aspects"], dict)
                    or (observation["headStatus"] == 404 and observation["aspects"])):
                raise ApiMappingError("api_mapping_observation_inconclusive")
        for name, after in entity["desiredAspects"].items():
            before = observation["aspects"].get(name) if observation else None
            if observation is None:
                state = "CATALOG_UNOBSERVED"
            elif observation["headStatus"] == 404:
                state = "CONDITIONAL_NEW"
            elif before is None:
                state = "ASPECT_UNOBSERVED"
            else:
                state = "UNCHANGED" if canonical(before) == canonical(after) else "CONFLICT"
            changes.append({"urn": entity["urn"], "aspect": name, "state": state, "before": before, "after": after})
    comparison = {"format": "dataflow-discovery.api-aspect-diff/1", "draftDigest": draft["draftDigest"],
                  "observationDigest": digest(observations), "changes": changes,
                  "publicationAuthorized": False, "liveReadbackVerified": False,
                  "requires": ["trusted fresh HEAD and aspect readback", "namespace and ACL verification",
                               "explicit exact-diff approval", "conditional conflict/concurrency contract"]}
    comparison["diffDigest"] = digest(comparison)
    return comparison

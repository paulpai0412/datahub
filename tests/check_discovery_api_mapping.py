"""Replay REAL retained source/result DATA through the offline adapter, not a model.

Operator stages prepare.stdout, validate.stdout, current-source.yaml and the
captured public openapi.body into INPUTS. Run in the existing no-network image.
No generated plugin/tests.py is staged or imported. All output is a draft.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "extensions/dataflow-discovery/src"))
from datahub.emitter.mcp import MetadataChangeProposalWrapper
from datahub.metadata.schema_classes import ApiPropertiesClass, ApiSignatureClass, RestApiPropertiesClass, SubTypesClass
from dataflow_discovery.api_native import compile_api_draft, compare_api_draft


def main() -> None:
    inputs = Path(sys.argv[1])
    prepared = json.loads((inputs / "prepare.stdout").read_text())["result"]
    result = json.loads((inputs / "validate.stdout").read_text())["result"]
    source = (inputs / "current-source.yaml").read_bytes()
    assert hashlib.sha256(source).hexdigest() == "93cb72529313ffced744e21465206bc921b229ef726cbb3530454af0afc5e424"
    assert prepared["files"][0]["text"].encode() == source
    assert result["resultDigest"] == "5e930083a1cf536339246546a25705d505016fd91274f9b4eafd31150a9eaa10"
    context = {"tenantId": "ekop-datahub-discovery-test", "sourceId": "official-analytics-openapi-yaml", "serviceId": "datahub-analytics"}
    draft = compile_api_draft(prepared, result, context)
    assert len(draft["entities"]) == 1
    entity = draft["entities"][0]
    assert entity["identity"]["path"] == "/datahub_usage_events/_search"
    assert entity["identity"]["method"] == "POST"
    aspects = entity["desiredAspects"]
    assert aspects["restApiProperties"] == {"method": "POST", "path": "/datahub_usage_events/_search"}
    signature = ApiSignatureClass.from_obj(aspects["apiSignature"])
    assert signature.schemaDefinition is not None and signature.schemaDefinition.encode() == source
    assert signature.inputFields is not None and signature.outputFields is not None
    assert len(signature.inputFields) == len(signature.outputFields) == 1
    assert signature.inputFields[0].nativeDataType == signature.outputFields[0].nativeDataType == "string"
    assert signature.inputFields[0].nullable is True  # required omitted => optional in OpenAPI 3.0
    assert signature.outputFields[0].nullable is False
    assert entity["portBindings"][1]["responseStatus"] == "200"
    # Public SDK serializer, not emitter.emit or a REST write. Generated MCP
    # bytes are validated offline only and deliberately not used as approval.
    for cls in (ApiPropertiesClass, ApiSignatureClass, RestApiPropertiesClass, SubTypesClass):
        restored = cls.from_obj(aspects[cls.ASPECT_NAME])
        assert restored.validate() and restored.to_obj() == aspects[cls.ASPECT_NAME]
        proposal = MetadataChangeProposalWrapper(entityUrn=entity["urn"], aspect=restored).make_mcp()
        assert proposal.validate() and proposal.entityType == "api" and proposal.entityUrn == entity["urn"]
    spec_bytes = (inputs / "openapi.body").read_bytes()
    assert hashlib.sha256(spec_bytes).hexdigest() == "8eae5a5eff3ace070010342839908267be2e5848e4a5b95be0f715ac1cfb041e"
    schemas = json.loads(spec_bytes)["components"]["schemas"]
    def properties(name):
        schema = schemas[name]
        return {key: value for part in [schema, *schema.get("allOf", [])]
                for key, value in part.get("properties", {}).items()}

    for name, payload in (("ApiProperties", aspects["apiProperties"]), ("ApiSignature", aspects["apiSignature"]),
                          ("RestApiProperties", aspects["restApiProperties"]), ("SubTypes", aspects["subTypes"])):
        # Shape correspondence only: SDK JSON uses qualified Avro union names;
        # OpenAPI v2 JSON uses __type. These are NOT interchangeable transports.
        assert set(payload) <= set(properties(name))
    assert {"inputFields", "outputFields"} <= set(properties("ApiSignature"))
    comparison = compare_api_draft(draft)
    assert {c["state"] for c in comparison["changes"]} == {"CATALOG_UNOBSERVED"}
    command = [sys.executable, "-I", "-B", str(ROOT / "scripts/draft-discovery-api.py"),
               "--prepared-input", str(inputs / "prepare.stdout"), "--validated-result", str(inputs / "validate.stdout"),
               "--tenant-id", context["tenantId"], "--source-id", context["sourceId"], "--service-id", context["serviceId"]]
    run = subprocess.run(command, capture_output=True, text=True, timeout=20)
    assert run.returncode == 0, run.stderr
    assert json.loads(run.stdout) == {"draft": draft, "comparison": comparison}
    print(json.dumps({"status": "OFFLINE_REAL_RESULT_MAPPING_PASS", "draft": draft, "comparison": comparison,
                      "sourceSha256": hashlib.sha256(source).hexdigest(), "openapiSha256": hashlib.sha256(spec_bytes).hexdigest(),
                      "sdkRoundtripAndMcpValidation": True, "publicContractPropertyCorrespondence": True,
                      "restWirePayloadValidated": False, "modelRun": False, "candidateRun": False,
                      "catalogFresh": False, "metadataWritten": False, "publicationAuthorized": False}, ensure_ascii=False))


if __name__ == "__main__":
    main()

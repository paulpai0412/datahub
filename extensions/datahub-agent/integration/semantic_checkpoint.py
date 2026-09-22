"""Fixed-version official ingestion checkpoint adapter. Stdin/stdout only; no HTTP or credentials."""
import base64
import bz2
import importlib.metadata
import json
import sys

MAX_INPUT = 65536
MAX_EXPANDED = 524288
MAX_OUTPUT = 60000


class CheckpointError(ValueError):
    pass


def checkpoint_projection(request):
    if not isinstance(request, dict) or request.get("mode") not in ("identity", "decode"):
        raise CheckpointError("semantic_checkpoint_invalid")
    expected = {"mode", "pipelineName"} | ({"aspect"} if request["mode"] == "decode" else set())
    pipeline = request.get("pipelineName")
    if set(request) != expected or not isinstance(pipeline, str) or not 0 < len(pipeline) <= 2048 or any(ord(c) < 32 for c in pipeline):
        raise CheckpointError("semantic_checkpoint_invalid")
    if importlib.metadata.version("acryl-datahub") != "1.7.0.9":
        raise CheckpointError("semantic_checkpoint_sdk_unsupported")

    from datahub.emitter.mce_builder import make_data_job_urn

    # Pinned MSSQL checkpoint job identity verified through native readback.
    # Other connectors/CLI versions are not inferred from implementation classes.
    job = "mssql_stale_entity_removal"
    result = {"format": "datahub-semantic.checkpoint/1", "sdkVersion": "1.7.0.9", "pipelineName": pipeline,
              "jobName": job, "jobUrn": make_data_job_urn("datahub", pipeline, job)}
    if request["mode"] == "identity":
        return result
    raw = request["aspect"]
    state = raw.get("state") if isinstance(raw, dict) else None
    if not isinstance(state, dict) or raw.get("pipelineName") != pipeline or not isinstance(raw.get("runId"), str) or not raw["runId"]:
        raise CheckpointError("semantic_checkpoint_invalid")
    if state.get("formatVersion") != "1.0" or state.get("serde") not in ("utf-8", "base85-bz2-json"):
        # In particular, never accept the obsolete unsafe base85/pickle serializer.
        raise CheckpointError("semantic_checkpoint_format_unsupported")
    payload = state.get("payload")
    if not isinstance(payload, str):
        raise CheckpointError("semantic_checkpoint_invalid")
    if state["serde"] == "base85-bz2-json":
        decoder = bz2.BZ2Decompressor()
        expanded = decoder.decompress(base64.b85decode(payload), max_length=MAX_EXPANDED + 1)
        if len(expanded) > MAX_EXPANDED or not decoder.eof or decoder.unused_data:
            raise CheckpointError("semantic_checkpoint_too_large")
    elif len(payload.encode("utf-8")) > MAX_EXPANDED:
        raise CheckpointError("semantic_checkpoint_too_large")
    # Preflight bounds decompression; the official public SDK still owns decoding,
    # legacy state migration and the native checkpoint schema. No private decoder calls.
    from datahub.metadata.schema_classes import DatahubIngestionCheckpointClass
    from datahub.ingestion.source.state.checkpoint import Checkpoint
    from datahub.ingestion.source.state.entity_removal_state import GenericCheckpointState

    aspect = DatahubIngestionCheckpointClass.from_obj(raw, tuples=False)
    checkpoint = Checkpoint.create_from_checkpoint_aspect(job, aspect, GenericCheckpointState)
    if checkpoint is None:
        raise CheckpointError("semantic_checkpoint_invalid")
    urns = checkpoint.state.urns
    if len(urns) > 512 or any(not isinstance(u, str) or not u.startswith("urn:li:") or len(u) > 2048 or any(ord(c) < 32 for c in u) for u in urns):
        raise CheckpointError("semantic_checkpoint_invalid")
    datasets = sorted(u for u in urns if u.startswith("urn:li:dataset:"))
    if len(datasets) > 200:
        raise CheckpointError("semantic_checkpoint_too_large")
    return {**result, "runId": checkpoint.run_id, "datasetUrns": datasets, "otherEntityCount": len(urns) - len(datasets)}


def main():
    try:
        raw = sys.stdin.buffer.read(MAX_INPUT + 1)
        if len(raw) > MAX_INPUT:
            raise CheckpointError("semantic_checkpoint_too_large")
        result = checkpoint_projection(json.loads(raw))
        encoded = json.dumps(result, ensure_ascii=False, separators=(",", ":"))
        if len(encoded.encode("utf-8")) > MAX_OUTPUT:
            raise CheckpointError("semantic_checkpoint_too_large")
        print(encoded)
    except CheckpointError as error:
        print(json.dumps({"error": str(error)}))
        raise SystemExit(1) from None
    except (ImportError, importlib.metadata.PackageNotFoundError):
        print(json.dumps({"error": "semantic_checkpoint_decoder_unavailable"}))
        raise SystemExit(1) from None
    except Exception:
        # Native schema/codec errors must not expose metadata or process stderr.
        print(json.dumps({"error": "semantic_checkpoint_invalid"}))
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()

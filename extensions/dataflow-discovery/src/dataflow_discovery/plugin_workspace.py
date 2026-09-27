"""Read-only workspace adapter for deployment-registered Discovery plugins.

The legacy workspace's Catalog/lookup/field/Job binders remain its compatibility
adapter. They must not be replaced with the legacy plugin's coarse IR projection.
"""
from hashlib import sha256
from typing import Any

from .plugin_api import PluginError, contract_digest, contract_files
from .plugins.registry import builtin_registry
from .snapshot import capture_workspace

LEGACY_PLUGIN = "legacy-static"
PREVIEW_FORMAT = "dataflow-discovery.plugin-preview/1"


def list_workspace_plugins() -> dict[str, Any]:
    return {
        "format": "dataflow-discovery.plugins/1",
        "contractDigest": contract_digest(),
        "plugins": [{"manifest": manifest,
                     "previewFormat": "datahub-etl.preview/3" if manifest["id"] == LEGACY_PLUGIN else PREVIEW_FORMAT}
                    for manifest in builtin_registry().manifests()],
        "publicationAuthorized": False,
    }


def plugin_development_contract() -> dict[str, Any]:
    """Fixed first-party documents only; no caller-selected files or imports."""
    return {"format": "dataflow-discovery.authoring-contract/1", "contractVersion": "1",
            "contractDigest": contract_digest(),
            "files": [{"name": name, "content": data.decode("utf-8"), "sha256": sha256(data).hexdigest()}
                      for name, data in sorted(contract_files().items())],
            "activationAuthorized": False, "publicationAuthorized": False}


def capture_plugin_input(policy: dict[str, Any], request: dict[str, Any]) -> dict[str, Any]:
    """Internal Host capture after source authorization, never candidate execution."""
    if (policy.get("workspace") is not True or policy.get("modelContextApproved") is not True
            or set(request) - {"selection", "snapshotSha256"}):
        raise PluginError("plugin_workspace_request_rejected")
    workspace = capture_workspace(policy["root"], request["selection"], source_id=policy["sourceId"])
    if request.get("snapshotSha256", workspace.snapshot.sha256) != workspace.snapshot.sha256:
        raise ValueError("workspace_source_drift")
    return {"format": "dataflow-discovery.plugin-input/1", "snapshotSha256": workspace.snapshot.sha256,
            "manifest": workspace.manifest(), "source": {"sourceId": workspace.snapshot.source_id,
            "files": [{"path": file.path, "text": file.text} for file in workspace.snapshot.files]}}


def analyze_plugin_workspace(policy: dict[str, Any], request: dict[str, Any]) -> dict[str, Any]:
    registry = builtin_registry()
    plugin_id = request.get("pluginId")
    if not isinstance(plugin_id, str) or plugin_id not in {manifest["id"] for manifest in registry.manifests()}:
        raise PluginError("plugin_not_registered")
    if plugin_id == LEGACY_PLUGIN:
        raise PluginError("plugin_requires_workspace_adapter")
    if (policy.get("workspace") is not True or policy.get("modelContextApproved") is not True
            or any(key in request for key in ("connections", "pythonPath", "entrypoint"))):
        raise PluginError("plugin_workspace_request_rejected")
    workspace = capture_workspace(policy["root"], request["selection"], source_id=policy["sourceId"])
    if request.get("snapshotSha256", workspace.snapshot.sha256) != workspace.snapshot.sha256:
        raise ValueError("workspace_source_drift")
    result = registry.analyze(plugin_id, workspace.snapshot, request.get("pluginConfig", {}))
    return {"format": PREVIEW_FORMAT, "sourceId": policy["sourceId"],
            "snapshotSha256": workspace.snapshot.sha256, "manifest": workspace.manifest(),
            "result": result, "complete": False, "publicationAuthorized": False}


def analyze_workspace_selection(policy: dict[str, Any], request: dict[str, Any], catalog=None,
                                *, compile_native=False, related_catalog=None) -> dict[str, Any]:
    """One workspace operation; explicit compatibility, never failure fallback."""
    if request.get("pluginId", LEGACY_PLUGIN) != LEGACY_PLUGIN:
        if compile_native or catalog is not None or related_catalog is not None:
            raise PluginError("plugin_preview_only")
        return analyze_plugin_workspace(policy, request)
    if request.get("pluginConfig", {}) != {}:
        raise PluginError("plugin_workspace_request_rejected")
    from .workspace import analyze_workspace
    legacy_request = {key: value for key, value in request.items() if key not in {"pluginId", "pluginConfig"}}
    return analyze_workspace(policy, legacy_request, catalog,
                             compile_native=compile_native, related_catalog=related_catalog)

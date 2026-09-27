"""Deployment-owned registrations. Never load code by model-provided path."""
from ..plugin_api import Plugin, PluginRegistry
from . import legacy_static, openapi


def builtin_registry() -> PluginRegistry:
    return PluginRegistry((Plugin(legacy_static.MANIFEST, legacy_static.analyze),
                           Plugin(openapi.MANIFEST, openapi.analyze)))

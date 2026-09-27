export interface ToolEntry {
  name: string;
  description: string;
  active: boolean;
  parameters?: Record<string, unknown>;
  promptGuidelines?: string[];
}

export const TOOL_PRESET_VALUES = [
  "none",
  "datahub-only",
  "read-only",
  "default",
  "full",
  "plugin-dev",
] as const;
export type ToolPreset = (typeof TOOL_PRESET_VALUES)[number];
export const PLUGIN_DEVELOPMENT_TOOL = "discovery_plugin_dev";
export const PLUGIN_DEVELOPMENT_TOOLS = [PLUGIN_DEVELOPMENT_TOOL];

export function isPluginDevelopmentSelection(tools: readonly string[] | undefined): boolean {
  return tools?.includes(PLUGIN_DEVELOPMENT_TOOL) ?? false;
}

export function validatePluginDevelopmentSelection(tools: readonly string[]): void {
  if (isPluginDevelopmentSelection(tools) && (tools.length !== 1 || tools[0] !== PLUGIN_DEVELOPMENT_TOOL)) {
    throw new Error("Plugin development must use its dedicated tool selection only");
  }
}

export const PRESET_NONE: string[] = [];
export const PRESET_DATAHUB_ONLY = [
  "datahub_catalog",
  "datahub_sql",
  "datahub_grafana",
] as const;
export const PRESET_READ_ONLY: string[] = ["read", "grep", "find", "ls"];
export const PRESET_DEFAULT: string[] = ["read", "bash", "edit", "write"];
export const PRESET_FULL: string[] = [
  "bash",
  "read",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
];

const BUILTIN_TOOL_NAMES = new Set([...PRESET_FULL, "powershell"]);

export function isToolPreset(value: unknown): value is ToolPreset {
  return (
    typeof value === "string" &&
    (TOOL_PRESET_VALUES as readonly string[]).includes(value)
  );
}

export function getPresetFromTools(tools: ToolEntry[]): ToolPreset {
  const activeTools = tools.filter((t) => t.active);
  return getPresetFromToolNames(activeTools.map((tool) => tool.name));
}

export function getPresetFromToolNames(
  toolNames: readonly string[],
): ToolPreset {
  if (toolNames.length === 0) return "none";
  if (toolNames.length === 1 && toolNames[0] === PLUGIN_DEVELOPMENT_TOOL) return "plugin-dev";
  if (
    toolNames.length === PRESET_DATAHUB_ONLY.length &&
    PRESET_DATAHUB_ONLY.every((name) => toolNames.includes(name))
  )
    return "datahub-only";

  const active = toolNames
    .map((name) => (name === "powershell" ? "bash" : name))
    .filter((name) => BUILTIN_TOOL_NAMES.has(name))
    .sort()
    .join(",");

  if (active === [...PRESET_READ_ONLY].sort().join(",")) return "read-only";
  if (active === [...PRESET_DEFAULT].sort().join(",")) return "default";
  if (active === [...PRESET_FULL].sort().join(",")) return "full";
  return "default";
}

export function getToolNamesForPreset(preset: ToolPreset): string[] {
  if (preset === "plugin-dev") return [...PLUGIN_DEVELOPMENT_TOOLS];
  if (preset === "none") return [...PRESET_NONE];
  if (preset === "datahub-only") return [...PRESET_DATAHUB_ONLY];
  if (preset === "read-only") return [...PRESET_READ_ONLY];
  if (preset === "full") return [...PRESET_FULL];
  return [...PRESET_DEFAULT];
}

import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { PRESET_DATAHUB_ONLY, PRESET_FULL, PLUGIN_DEVELOPMENT_TOOL } from "./tool-presets";
import type { SessionEntry } from "./types";

export const TOOL_SELECTION_TYPE = "pi-web:tool-selection";

export interface SessionToolSelectionData {
  version: 1;
  tools: string[];
  profile?: "discovery-plugin-development";
}

const SELECTABLE_TOOL_NAMES = new Set([...PRESET_FULL, "powershell"]);

export function isDataHubOnlySelection(tools: readonly string[]): boolean {
  return (
    tools.length === PRESET_DATAHUB_ONLY.length &&
    PRESET_DATAHUB_ONLY.every((name) => tools.includes(name))
  );
}

function parseToolSelectionData(data: unknown): string[] | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  const candidate = data as { version?: unknown; tools?: unknown; profile?: unknown };
  if (candidate.profile !== undefined) {
    if (candidate.profile !== "discovery-plugin-development" || candidate.version !== 1 ||
        !Array.isArray(candidate.tools) || candidate.tools.length !== 0) {
      throw new Error("Invalid persisted Discovery development resource profile");
    }
    return [PLUGIN_DEVELOPMENT_TOOL];
  }
  // Never downgrade a malformed persisted development selection to legacy/full.
  if (Array.isArray(candidate.tools) && candidate.tools.includes(PLUGIN_DEVELOPMENT_TOOL)) {
    if (candidate.version !== 1 || candidate.tools.length !== 1 || candidate.tools[0] !== PLUGIN_DEVELOPMENT_TOOL)
      throw new Error("Invalid persisted Discovery development tool selection");
    return [PLUGIN_DEVELOPMENT_TOOL];
  }
  if (candidate.version !== 1 || !Array.isArray(candidate.tools)) return undefined;
  const tools = candidate.tools;
  if (!isDataHubOnlySelection(tools) &&
      tools.some((tool) => typeof tool !== "string" || !SELECTABLE_TOOL_NAMES.has(tool)))
    return undefined;
  return [...new Set(tools as string[])];
}

/** Return the newest valid persisted selection. Undefined identifies legacy sessions. */
export function readSessionToolSelection(
  entries: readonly SessionEntry[],
): string[] | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== TOOL_SELECTION_TYPE)
      continue;
    const tools = parseToolSelectionData(entry.data);
    if (tools !== undefined) return tools;
  }
  return undefined;
}

export function validateSessionToolSelection(tools: unknown): string[] {
  const parsed = parseToolSelectionData({ version: 1, tools });
  if (parsed === undefined) {
    throw new Error("toolNames must contain only built-in tool names, the DataHub-only preset, or the exclusive Discovery development tool");
  }
  return parsed;
}

export function appendSessionToolSelection(
  sessionManager: SessionManager,
  tools: readonly string[],
): void {
  sessionManager.appendCustomEntry(TOOL_SELECTION_TYPE, {
    version: 1,
    // A previous pi-web version understands [] as Chat only. On rollback it
    // must not misread an unknown tool name as legacy/full permission.
    ...(tools.includes(PLUGIN_DEVELOPMENT_TOOL)
      ? { tools: [], profile: "discovery-plugin-development" }
      : { tools: [...tools] }),
  } satisfies SessionToolSelectionData);
}

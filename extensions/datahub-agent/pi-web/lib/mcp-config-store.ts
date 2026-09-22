import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";

export const MCP_CONFIG_MAX_BYTES = 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Preserve the adapter's options. This is a JSON boundary, not another MCP schema.
function validateConfig(
  value: unknown,
): asserts value is Record<string, unknown> {
  if (
    !isRecord(value) ||
    !isRecord(value.mcpServers) ||
    Object.values(value.mcpServers).some((server) => !isRecord(server)) ||
    (value.settings !== undefined && !isRecord(value.settings))
  ) {
    throw new Error("invalid_mcp_config");
  }
}

export function readMcpConfig(configPath = join(getAgentDir(), "mcp.json")) {
  try {
    let raw = "";
    let config: unknown = {
      settings: { hostConfigDiscovery: "off" },
      mcpServers: {},
    };
    if (existsSync(configPath)) {
      const stat = statSync(configPath);
      if (!stat.isFile() || stat.size > MCP_CONFIG_MAX_BYTES) throw new Error();
      raw = readFileSync(configPath, "utf8");
      if (Buffer.byteLength(raw) > MCP_CONFIG_MAX_BYTES) throw new Error();
      config = JSON.parse(raw);
    }
    validateConfig(config);
    return { config, revision: createHash("sha256").update(raw).digest("hex") };
  } catch {
    throw new Error("mcp_config_unavailable");
  }
}

export function writeMcpConfig(
  config: unknown,
  revision: unknown,
  configPath = join(getAgentDir(), "mcp.json"),
) {
  validateConfig(config);
  const raw = JSON.stringify(config, null, 2) + "\n";
  if (Buffer.byteLength(raw) > MCP_CONFIG_MAX_BYTES)
    throw new Error("invalid_mcp_config");
  // ponytail: synchronous writes serialize this runtime's API saves, not external editors.
  if (
    typeof revision !== "string" ||
    readMcpConfig(configPath).revision !== revision
  ) {
    throw new Error("mcp_config_conflict");
  }
  try {
    mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
    writePrivateFileAtomicSync(configPath, raw);
  } catch {
    throw new Error("mcp_config_unavailable");
  }
  return readMcpConfig(configPath);
}

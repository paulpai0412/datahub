import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerPluginAuthoring } from "./discovery-plugin-authoring-extension";

const CONTRACT_FILES = ["README.md", "graph.schema.json", "manifest.schema.json"];
const MAX_FILE_BYTES = 24_000;
const MAX_TOTAL_BYTES = 48_000;
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

/** Operator-owned read-only contract mount. No candidate execution or approval. */
export type PluginDevelopmentConfig = {
  contractRoot: string;
  contractDigest: string;
};

export async function readPluginContract(config: PluginDevelopmentConfig) {
  if (!isAbsolute(config.contractRoot) || !/^[a-f0-9]{64}$/.test(config.contractDigest)) {
    throw new Error("discovery_plugin_contract_config_invalid");
  }
  const files: { name: string; content: string; sha256: string }[] = [];
  let size = 0;
  try {
    for (const name of CONTRACT_FILES) {
      const handle = await open(join(config.contractRoot, name), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error("size");
        // Bounded read even if an incorrectly writable development mount grows.
        const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
          if (bytesRead === 0) break;
          offset += bytesRead;
        }
        size += offset;
        if (offset > MAX_FILE_BYTES || size > MAX_TOTAL_BYTES) throw new Error("size");
        const content = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset));
        files.push({ name, content, sha256: hash(content) });
      } finally {
        await handle.close();
      }
    }
  } catch {
    throw new Error("discovery_plugin_contract_unavailable");
  }
  const actual = hash(JSON.stringify(Object.fromEntries(files.map((file) => [file.name, file.sha256]))));
  if (actual !== config.contractDigest) throw new Error("discovery_plugin_contract_drift");
  return {
    format: "dataflow-discovery.authoring-contract/1",
    contractVersion: "1",
    contractDigest: actual,
    files,
    authority: "REFERENCE_ONLY",
    candidateExecutionAvailable: false,
    activationAuthorized: false,
  };
}

/** Separate developer opt-in; never enabled merely by choosing the ETL skill. */
export async function registerPluginDevelopment(pi: ExtensionAPI, config: PluginDevelopmentConfig) {
  // Freeze trusted configuration; reject stale/missing mounts before discovery.
  const pinned = Object.freeze({ ...config });
  await readPluginContract(pinned);
  pi.on("resources_discover", () => ({
    skillPaths: [join(dirname(fileURLToPath(import.meta.url)), "../skills/discovery-plugin-dev/SKILL.md")],
  }));
  pi.registerTool({
    name: "discovery_plugin_contract",
    label: "Discovery plugin contract",
    description: "Read the operator-pinned Discovery plugin development contract (at most 48KB). " +
      "Reference only: no candidate execution, source access, deployment, approval or publication authority. " +
      "Read this before plugin work. Report missing isolated verification as a blocker; do not use ordinary shell as a substitute.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_id, _params, signal) {
      signal?.throwIfAborted();
      const details = await readPluginContract(pinned);
      signal?.throwIfAborted();
      const text = JSON.stringify(details);
      if (Buffer.byteLength(text, "utf8") > MAX_TOTAL_BYTES) throw new Error("discovery_plugin_contract_too_large");
      return { content: [{ type: "text", text }], details };
    },
  });
}

export default async function discoveryPluginDevelopment(pi: ExtensionAPI) {
  if (process.env.DATAHUB_DISCOVERY_PLUGIN_DEVELOPMENT === "true") registerPluginAuthoring(pi);
  const contractRoot = process.env.DATAHUB_DISCOVERY_PLUGIN_CONTRACT_ROOT;
  const contractDigest = process.env.DATAHUB_DISCOVERY_PLUGIN_CONTRACT_DIGEST;
  if (contractRoot === undefined && contractDigest === undefined) return;
  if (!contractRoot || !contractDigest) throw new Error("discovery_plugin_development_config_incomplete");
  await registerPluginDevelopment(pi, { contractRoot, contractDigest });
}

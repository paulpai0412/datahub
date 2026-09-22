import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import ingestion from "./datahub-ingestion-extension";
import decision from "./datahub-decision-extension";
import discovery from "./datahub-discovery-extension";
import etl from "./datahub-etl-extension";

/** Fixed first-party entry; the pinned MCP adapter implementation is unchanged. */
export default async function datahubExtensions(pi: ExtensionAPI) {
  // The adapter is a Pi/Jiti runtime extension, not a Next application module.
  // Keep its fixed package behind the same runtime loading boundary as Pi.
  const packageName: string = "pi-mcp-adapter";
  const loaded: unknown = await import(packageName);
  if (
    !loaded ||
    typeof loaded !== "object" ||
    !("default" in loaded) ||
    typeof loaded.default !== "function"
  ) {
    throw new Error("invalid_datahub_mcp_extension");
  }
  await loaded.default(pi);
  ingestion(pi);
  decision(pi);
  discovery(pi);
  etl(pi);
}

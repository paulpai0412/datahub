import { NextResponse } from "next/server";
import {
  MCP_CONFIG_MAX_BYTES,
  readMcpConfig,
  writeMcpConfig,
} from "@/lib/mcp-config-store";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

// Authentication/Origin checks are shared with other Pi APIs in proxy.ts.
// Paths and ownership come from this isolated runtime, never the request body.
export async function GET() {
  try {
    return NextResponse.json(readMcpConfig(), { headers });
  } catch {
    return NextResponse.json(
      { error: "mcp_config_unavailable" },
      { status: 500, headers },
    );
  }
}

export async function PUT(request: Request) {
  const reader = request.body?.getReader();
  if (!reader)
    return NextResponse.json(
      { error: "invalid_mcp_config" },
      { status: 400, headers },
    );
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MCP_CONFIG_MAX_BYTES) {
        await reader.cancel();
        return NextResponse.json(
          { error: "mcp_config_too_large" },
          { status: 413, headers },
        );
      }
      chunks.push(value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const saved = writeMcpConfig(body?.config, body?.revision);
    return NextResponse.json(saved, { headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const status =
      message === "mcp_config_conflict"
        ? 409
        : message === "mcp_config_unavailable"
          ? 500
          : 400;
    return NextResponse.json(
      { error: status === 400 ? "invalid_mcp_config" : message },
      { status, headers },
    );
  } finally {
    reader.releaseLock();
  }
}

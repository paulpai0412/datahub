import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";
const root = fileURLToPath(new URL("../../..", import.meta.url));
const { GET, PUT } = await createJiti(import.meta.url, {
  alias: { "@": root },
}).import("./route.ts");

test("MCP config API bounds input and never echoes secrets on failures (route unit, not auth E2E)", async () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const home = mkdtempSync(join(tmpdir(), "pi-mcp-api-"));
  process.env.PI_CODING_AGENT_DIR = home;
  const put = (text) =>
    PUT(
      new Request("http://localhost/api/mcp-config", {
        method: "PUT",
        body: text,
      }),
    );
  try {
    const response = await GET();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const before = await response.json();
    const body = JSON.stringify({
      revision: before.revision,
      config: { mcpServers: {} },
    });
    assert.equal((await put(body)).status, 200);
    assert.equal((await put(body)).status, 409);
    for (const input of [
      "secret-invalid-json",
      "null",
      '{"config":"synthetic-secret"}',
    ]) {
      const denied = await put(input);
      assert.equal(denied.status, 400);
      assert.equal(await denied.text(), '{"error":"invalid_mcp_config"}');
    }
    const oversized = await put("x".repeat(1024 * 1024 + 1));
    assert.equal(oversized.status, 413);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

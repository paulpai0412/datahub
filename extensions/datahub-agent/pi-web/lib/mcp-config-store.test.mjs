import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
const { readMcpConfig, writeMcpConfig } = await createJiti(
  import.meta.url,
).import("./mcp-config-store.ts");

test("MCP config stays private, preserves adapter options and rejects stale/invalid writes", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-mcp-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const alice = join(root, "alice", "mcp.json");
  const bob = join(root, "bob", "mcp.json");
  const before = readMcpConfig(alice);
  const config = {
    settings: { hostConfigDiscovery: "off" },
    mcpServers: {
      docs: {
        url: "https://mcp.example.com/mcp",
        headers: { Authorization: "Bearer synthetic-secret" },
        disabled: true,
      },
      local: {
        command: "node",
        args: ["server.mjs"],
        env: { TEST: "synthetic" },
      },
    },
  };
  const saved = writeMcpConfig(config, before.revision, alice);
  assert.deepEqual(saved.config, config);
  assert.equal(statSync(alice).mode & 0o777, 0o600);
  assert.deepEqual(readMcpConfig(bob).config.mcpServers, {});
  assert.throws(
    () => writeMcpConfig(config, before.revision, alice),
    /mcp_config_conflict/,
  );
  for (const invalid of [
    null,
    [],
    {},
    { mcpServers: [] },
    { mcpServers: { bad: "secret" } },
  ]) {
    assert.throws(
      () => writeMcpConfig(invalid, saved.revision, alice),
      /invalid_mcp_config/,
    );
  }
  assert.deepEqual(JSON.parse(readFileSync(alice, "utf8")), config);
  writeFileSync(alice, "broken-private-config");
  assert.throws(() => readMcpConfig(alice), /mcp_config_unavailable/);
  assert.throws(
    () => writeMcpConfig(config, saved.revision, alice),
    /mcp_config_unavailable/,
  );
  assert.equal(readFileSync(alice, "utf8"), "broken-private-config");
});

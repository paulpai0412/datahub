// Real Pi SDK + unmodified MCP adapter + real stdio transport. No model or DataHub call.
// Run in a fresh HOME/PI_CODING_AGENT_DIR; never use development credentials.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
  SettingsManager,
} from "../extensions/datahub-agent/pi-web/node_modules/@earendil-works/pi-coding-agent/dist/index.js";

assert.equal(process.env.PI_OFFLINE, "1");
assert.ok(process.env.HOME?.startsWith("/tmp/datahub-mcp-"));
assert.equal(
  process.env.PI_CODING_AGENT_DIR,
  join(process.env.HOME, ".pi/agent"),
);
const agentDir = process.env.PI_CODING_AGENT_DIR;
const cwd = join(process.env.HOME, "workspace");
mkdirSync(agentDir, { recursive: true });
mkdirSync(cwd, { recursive: true });
const require = createRequire(
  new URL("../extensions/datahub-agent/pi-web/package.json", import.meta.url),
);
const adapter = require.resolve("pi-mcp-adapter");
assert.equal(
  JSON.parse(readFileSync(join(resolve(adapter, ".."), "package.json")))
    .version,
  "2.33.0",
);
const datahubEntry = process.argv.includes("--datahub-entry");
const extensionPath = datahubEntry
  ? fileURLToPath(
      new URL(
        "../extensions/datahub-agent/pi-web/lib/datahub-extension-entry.ts",
        import.meta.url,
      ),
    )
  : adapter;
const configPath = join(agentDir, "mcp.json");
const config = {
  settings: {
    hostConfigDiscovery: "off",
    scriptMode: false,
    sampling: false,
    elicitation: false,
  },
  mcpServers: {
    fixture: {
      command: process.execPath,
      args: [
        fileURLToPath(new URL("./fixtures/mcp-echo.mjs", import.meta.url)),
      ],
      requestTimeoutMs: 5000,
    },
  },
};
writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
process.chdir(cwd);
const services = await createAgentSessionServices({
  cwd,
  agentDir,
  settingsManager: SettingsManager.inMemory({}),
  resourceLoaderOptions: {
    additionalExtensionPaths: [extensionPath],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  },
});
assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
const { session } = await createAgentSessionFromServices({
  services,
  sessionManager: SessionManager.inMemory(cwd),
});
try {
  const errors = [];
  // Match Pi Web's real error binding; SDK reload emits session_start only with bindings.
  await session.bindExtensions({
    mode: "rpc",
    onError: (error) => errors.push(error),
  });
  const call = async (args) => {
    const tool = session.agent.state.tools.find((item) => item.name === "mcp");
    assert.ok(tool, "MCP tool must be registered in the real SDK");
    return await tool.execute(
      "adapter-check",
      args,
      AbortSignal.timeout(15000),
    );
  };
  if (datahubEntry)
    for (const name of ["datahub_ingestion", "datahub_decision"])
      assert.equal(
        session.agent.state.tools.filter((tool) => tool.name === name).length,
        1,
        `${name} must load through the real SDK`,
      );
  const connected = await call({ connect: "fixture" });
  assert.match(JSON.stringify(connected), /echo/);
  const discovered = await call({ search: "echo", server: "fixture" });
  assert.match(JSON.stringify(discovered), /echo/);
  const result = await call({
    tool: "fixture_echo",
    args: { value: "real-adapter-stdio-ok" },
  });
  assert.match(JSON.stringify(result), /real-adapter-stdio-ok/);
  config.mcpServers.fixture.disabled = true;
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  await session.reload();
  if (datahubEntry)
    for (const name of ["datahub_ingestion", "datahub_decision"])
      assert.equal(
        session.agent.state.tools.filter((tool) => tool.name === name).length,
        1,
        `Reload preserves exactly one ${name} tool`,
      );
  const denied = await call({
    tool: "fixture_echo",
    args: { value: "must-not-run" },
  });
  assert.doesNotMatch(JSON.stringify(denied), /"text":"must-not-run"/);
  assert.match(
    JSON.stringify(denied),
    /disabled|not found|not available|no matching|unknown/i,
  );
  assert.deepEqual(errors, []);
  console.log(
    `Pi 0.85.1 + adapter 2.33.0${datahubEntry ? " + DataHub intent entry" : ""}: load, discovery, stdio call, reload/disable PASS; no model/DataHub/OAuth claim`,
  );
} finally {
  await session.extensionRunner.emit({
    type: "session_shutdown",
    reason: "quit",
  });
  session.dispose();
}

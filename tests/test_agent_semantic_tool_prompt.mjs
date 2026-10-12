// Real pinned SDK and actual first-party tool factories. No model/Host requests.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const app = new URL("../extensions/datahub-agent/pi-web/", import.meta.url);
const require = createRequire(new URL("package.json", app));
const { createJiti } = require("jiti");
const jiti = createJiti(new URL("package.json", app).href);
const sdk = await jiti.import("@earendil-works/pi-coding-agent");
const { default: semantic } = await jiti.import(new URL("lib/datahub-semantic-extension.ts", app).pathname);
const { default: catalog } = await jiti.import(new URL("lib/datahub-catalog-extension.ts", app).pathname);
const selected = ["datahub_catalog", "datahub_semantic"];
const visibleTools = (prompt) => {
  const section = prompt.split("Available tools:\n")[1]?.split("\n\nIn addition")[0] ?? "";
  return [...section.matchAll(/^- ([\w-]+): /gm)].map((match) => match[1]).sort();
};

async function fixture(t, tools) {
  const root = await mkdtemp(join(tmpdir(), "semantic-tool-prompt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  const services = await sdk.createAgentSessionServices({
    cwd: root, agentDir, settingsManager: sdk.SettingsManager.inMemory({}),
    resourceLoaderOptions: {
      noExtensions: true, noSkills: true, noContextFiles: true,
      noPromptTemplates: true, noThemes: true,
      extensionFactories: [catalog, semantic],
    },
  });
  const model = services.modelRuntime.getModel("openai", "gpt-4o-mini");
  assert(model, "only the SDK's local model catalog is read; no model request");
  const { session } = await sdk.createAgentSessionFromServices({
    services, sessionManager: sdk.SessionManager.inMemory(root), model, tools,
  });
  t.after(() => session.dispose());
  session.agent.streamFn = () => { throw new Error("test must never request a model"); };
  await session.bindExtensions({ mode: "rpc" });
  session.setActiveToolsByName(tools);
  return session;
}

test("semantic governance exposes the actual active tool in the model system prompt, including after reload", async (t) => {
  const session = await fixture(t, selected);
  const verify = () => {
    assert.deepEqual(session.getActiveToolNames().sort(), [...selected].sort());
    assert.deepEqual(session.agent.state.tools.map((tool) => tool.name).sort(), [...selected].sort());
    assert.deepEqual(visibleTools(session.agent.state.systemPrompt), [...selected].sort(),
      "active semantic schema must not be omitted from the authoritative Available tools list");
    assert.match(session.agent.state.systemPrompt, /human.*confirm/i);
    assert.equal(session.messages.length, 0, "no prompt, tool execution, or metadata write");
  };
  verify();
  await session.reload();
  verify();
});

test("an inactive semantic tool is not advertised, and tool selection cannot widen through its prompt snippet", async (t) => {
  const session = await fixture(t, ["datahub_catalog"]);
  assert.deepEqual(session.getActiveToolNames(), ["datahub_catalog"]);
  assert.deepEqual(visibleTools(session.agent.state.systemPrompt), ["datahub_catalog"]);
  assert.doesNotMatch(session.agent.state.systemPrompt, /datahub_semantic/);
  assert.equal(session.messages.length, 0);
});

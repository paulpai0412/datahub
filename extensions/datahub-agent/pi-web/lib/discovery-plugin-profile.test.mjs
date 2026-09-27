// SDK/resource and tool-contract checks only; no model, login or live Host.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createJiti } from "jiti";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { pluginDevelopmentResources } = await jiti.import("./discovery-plugin-profile.ts");
const presets = await jiti.import("./tool-presets.ts");
const { validateSessionToolSelection, readSessionToolSelection, appendSessionToolSelection, TOOL_SELECTION_TYPE } = await jiti.import("./session-tool-selection.ts");
const { registerPluginAuthoring } = await jiti.import("./discovery-plugin-authoring-extension.ts");
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const DEV = presets.PLUGIN_DEVELOPMENT_TOOL;

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), "discovery-profile-unit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("exclusive development selection persists; malformed saved profile never becomes full", () => {
  assert.deepEqual(presets.getToolNamesForPreset("plugin-dev"), [DEV]);
  assert.equal(presets.getPresetFromToolNames([DEV]), "plugin-dev");
  assert.deepEqual(validateSessionToolSelection([DEV]), [DEV]);
  assert.throws(() => validateSessionToolSelection([DEV, "bash"]));
  assert.throws(() => validateSessionToolSelection(["arbitrary_extension"]));
  const entry = tools => ({ type: "custom", customType: TOOL_SELECTION_TYPE, data: { version: 1, tools } });
  assert.deepEqual(readSessionToolSelection([entry([DEV])]), [DEV]);
  let encoded;
  appendSessionToolSelection({ appendCustomEntry(_type, data) { encoded = data; } }, [DEV]);
  assert.deepEqual(encoded, { version: 1, tools: [], profile: "discovery-plugin-development" });
  assert.deepEqual(readSessionToolSelection([{ ...entry([]), data: encoded }]), [DEV]);
  assert.throws(() => readSessionToolSelection([{ ...entry([]), data: { ...encoded, tools: ["bash"] } }]));
  assert.throws(() => readSessionToolSelection([entry(["bash"]), entry([DEV, "write"])]));
  assert.deepEqual(validateSessionToolSelection([]), []);
  assert.deepEqual(presets.getToolNamesForPreset("full"), ["bash", "read", "edit", "write", "grep", "find", "ls"]);
});

test("wrapper does not auto-enable authoring in normal sessions or allow a development shell", async () => {
  let active = [];
  const inner = () => ({ sessionId: randomUUID(), agent: { state: {} }, extensionRunner: {}, dispose() {},
    settingsManager: { getDefaultTools: () => ["read", "bash"] },
    getAllTools: () => ["read", "bash", "datahub_etl", DEV].map(name => ({ name })),
    setActiveToolsByName(names) { active = names; },
    executeBash() { throw new Error("SHELL MUST NOT BE INVOKED"); } });
  const normal = new AgentSessionWrapper(inner());
  const development = new AgentSessionWrapper(inner(), { pluginDevelopment: true });
  try {
    normal.setActiveToolSelection(["read"]);
    assert.deepEqual(active, ["read", "datahub_etl"]);
    assert.throws(() => normal.setActiveToolSelection([DEV]), /requires session recreation/);
    development.setActiveToolSelection([DEV]);
    assert.deepEqual(active, [DEV]);
    assert.throws(() => development.setActiveToolSelection(["bash"]), /requires session recreation/);
    assert.throws(() => development.setActiveToolSelection([DEV, "bash"]), /dedicated tool selection/);
    await assert.rejects(development.send({ type: "bash", command: "NOT EXECUTABLE" }), /Shell execution is unavailable/);
  } finally { normal.destroy(); development.destroy(); }
});

test("native SDK loader admits only fixed inline tool/skill, not project resources", async t => {
  const root = await temporary(t);
  const agentDir = join(root, "agent");
  await mkdir(join(root, ".pi", "extensions"), { recursive: true });
  await mkdir(agentDir);
  // Trusted harmless negative fixture. Loading it is an explicit test failure.
  await writeFile(join(root, ".pi", "extensions", "not-allowed.ts"), "throw new Error('project extension must not load');\n");
  await writeFile(join(root, "AGENTS.md"), "PROJECT CONTEXT MUST NOT ENTER THE AUTHORING PROFILE");
  const factory = pi => pi.registerTool({ name: DEV, label: "unit", description: "unit", parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: "not called" }], details: {} }) });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager: SettingsManager.inMemory({}), ...pluginDevelopmentResources(factory) });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  assert.deepEqual(loaded.extensions.flatMap(extension => [...extension.tools.keys()]), [DEV]);
  assert.deepEqual(loader.getSkills().skills.map(skill => skill.name), ["discovery-plugin-dev"]);
  assert.deepEqual(loader.getPrompts().prompts, []);
  assert.deepEqual(loader.getThemes().themes, []);
  assert.deepEqual(loader.getAgentsFiles().agentsFiles, []);
});

async function registered(t, reply) {
  const root = await temporary(t);
  let tool; let aborted = false; const requests = []; const notifications = [];
  registerPluginAuthoring({ on() {}, registerTool(value) { tool = value; } }, join(root, "candidates"));
  const ctx = { mode: "rpc", sessionManager: { getSessionId: () => "11111111-1111-4111-8111-111111111111" },
    abort() { aborted = true; }, ui: { notify(...args) { notifications.push(args); },
      async input(title, text) { assert.equal(title, "DataHub discovery request"); const request = JSON.parse(text); requests.push(request); return reply?.(request); } } };
  return { call: params => tool.execute(randomUUID(), params, undefined, undefined, ctx), ctx, requests, notifications, aborted: () => aborted };
}

const validReply = request => JSON.stringify({ requestId: request.requestId, format: "dataflow-discovery.candidate-verification/1", status: "PASS",
  candidateDigest: request.candidate.candidateDigest, activationAuthorized: false, publicationAuthorized: false });

test("authoring extension submits exact saved source, not commands or claimed approval", async t => {
  const api = await registered(t, validReply);
  const files = { "plugin.py": "raise Exception('source only')", "manifest.json": "{}" };
  const saved = (await api.call({ action: "save", files })).details;
  assert.equal(saved.verified, false);
  assert.equal(api.requests.length, 0);
  const read = (await api.call({ action: "read", candidateId: saved.candidateId })).details;
  assert.deepEqual(read.files, files);
  await assert.rejects(api.call({ action: "verify", candidateId: saved.candidateId, candidateDigest: "0".repeat(64), referenceId: "public-unit-reference" }), /candidate_revision_drift/);
  assert.equal(api.requests.length, 0);
  const result = (await api.call({ action: "verify", candidateId: saved.candidateId, candidateDigest: saved.candidateDigest, referenceId: "public-unit-reference" })).details;
  assert.equal(result.activationAuthorized, false);
  assert.deepEqual(api.requests[0].candidate.files, files);
  assert.equal(api.requests[0].action, "plugin_development_verify");
  await assert.rejects(api.call({ action: "contract", candidateId: saved.candidateId }), /development_parameters_invalid/);
  api.ctx.mode = "interactive";
  await assert.rejects(api.call({ action: "save", files }), /datahub_host_required/);
});

test("unavailable/malformed Host responses abort; candidate flags cannot activate", async t => {
  for (const reply of [
    () => undefined,
    () => "not JSON",
    request => JSON.stringify({ requestId: request.requestId, format: "dataflow-discovery.authoring-contract/1", activationAuthorized: true, publicationAuthorized: false }),
  ]) {
    const api = await registered(t, reply);
    await assert.rejects(api.call({ action: "contract" }));
    assert.equal(api.aborted(), true);
    assert.equal(api.notifications.length, 1);
  }
});

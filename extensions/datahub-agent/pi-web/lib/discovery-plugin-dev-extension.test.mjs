import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, copyFile, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { loadSkillsFromDir, formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { default: registerDefault, registerPluginDevelopment, readPluginContract } =
  await jiti.import("./discovery-plugin-dev-extension.ts");
const root = fileURLToPath(new URL("../../../dataflow-discovery/contracts/v1/", import.meta.url));
const names = ["README.md", "graph.schema.json", "manifest.schema.json"];
const hash = (data) => createHash("sha256").update(data).digest("hex");
const hashes = Object.fromEntries(await Promise.all(names.map(async (name) => [name, hash(await readFile(join(root, name)))])));
const config = { contractRoot: root, contractDigest: hash(JSON.stringify(hashes)) };

function api() {
  const tools = [], events = new Map();
  return { tools, events, registerTool(tool) { tools.push(tool); }, on(event, handler) { events.set(event, handler); } };
}

test("opt-in entry registers a read-only tool and skill; no execution/activation authority", async () => {
  const pi = api();
  await registerPluginDevelopment(pi, config);
  assert.equal(pi.tools.length, 1);
  assert.equal(pi.tools[0].name, "discovery_plugin_contract");
  const result = await pi.tools[0].execute("test", {}, undefined);
  assert.equal(result.details.contractDigest, config.contractDigest);
  assert.equal(result.details.authority, "REFERENCE_ONLY");
  assert.equal(result.details.candidateExecutionAvailable, false);
  assert.equal(result.details.activationAuthorized, false);
  assert.deepEqual(result.details.files.map((file) => file.name), names);
  assert.equal(pi.tools[0].parameters.additionalProperties, false);
  assert.ok(pi.events.get("resources_discover")().skillPaths[0].endsWith("/discovery-plugin-dev/SKILL.md"));
});

test("actual Pi SDK discovers the skill and model trigger without malformed frontmatter", async () => {
  const pi = api();
  await registerPluginDevelopment(pi, config);
  const path = pi.events.get("resources_discover")().skillPaths[0];
  const loaded = loadSkillsFromDir({ dir: fileURLToPath(new URL("../skills/discovery-plugin-dev/", import.meta.url)), source: "development-test" });
  assert.deepEqual(loaded.diagnostics, []);
  assert.equal(loaded.skills.length, 1);
  assert.equal(loaded.skills[0].name, "discovery-plugin-dev");
  assert.equal(loaded.skills[0].filePath, path);
  assert.match(formatSkillsForPrompt(loaded.skills), /discovery-plugin-dev/);
  const text = await readFile(path, "utf8");
  for (const reference of ["asset-plugin", "language-plugin"]) {
    assert.match(text, new RegExp(`references/${reference}\\.md`));
    assert.ok((await readFile(new URL(`../skills/discovery-plugin-dev/references/${reference}.md`, import.meta.url), "utf8")).length > 0);
  }
});

test("missing mount, bad digest, source drift and symlinked contract are rejected", async () => {
  await assert.rejects(readPluginContract({ ...config, contractRoot: "/nonexistent/discovery-contract" }), /unavailable/);
  await assert.rejects(readPluginContract({ ...config, contractDigest: "0".repeat(64) }), /drift/);
  await assert.rejects(readPluginContract({ ...config, contractRoot: "relative" }), /config_invalid/);
  const dir = await mkdtemp(join(tmpdir(), "discovery-contract-"));
  try {
    for (const name of names) await copyFile(join(root, name), join(dir, name));
    const temporary = { ...config, contractRoot: dir };
    await readPluginContract(temporary);
    await writeFile(join(dir, "README.md"), "Changed contract");
    await assert.rejects(readPluginContract(temporary), /drift/);
    await rm(join(dir, "README.md"));
    await symlink(join(root, "README.md"), join(dir, "README.md"));
    await assert.rejects(readPluginContract(temporary), /unavailable/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("contract checked again at call time, not only at startup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "discovery-contract-drift-"));
  try {
    for (const name of names) await copyFile(join(root, name), join(dir, name));
    const pi = api();
    await registerPluginDevelopment(pi, { ...config, contractRoot: dir });
    await writeFile(join(dir, "README.md"), "Changed after registration");
    await assert.rejects(pi.tools[0].execute("test", {}, undefined), /drift/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ordinary runtime without operator config exposes no developer skill or tool", async () => {
  const keys = ["DATAHUB_DISCOVERY_PLUGIN_CONTRACT_ROOT", "DATAHUB_DISCOVERY_PLUGIN_CONTRACT_DIGEST"];
  const before = keys.map((key) => process.env[key]);
  try {
    for (const key of keys) delete process.env[key];
    const pi = api();
    await registerDefault(pi);
    assert.equal(pi.tools.length, 0);
    assert.equal(pi.events.size, 0);
    process.env[keys[0]] = root;
    await assert.rejects(registerDefault(pi), /config_incomplete/);
  } finally {
    keys.forEach((key, index) => {
      if (before[index] === undefined) delete process.env[key]; else process.env[key] = before[index];
    });
  }
});

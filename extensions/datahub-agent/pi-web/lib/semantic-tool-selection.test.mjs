import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  validateSessionToolSelection,
  appendSessionToolSelection,
  readSessionToolSelection,
  TOOL_SELECTION_TYPE,
} = await jiti.import("./session-tool-selection.ts");
const { getToolNamesForPreset, getPresetFromToolNames } =
  await jiti.import("./tool-presets.ts");
const { withExtensionTools, AgentSessionWrapper } =
  await jiti.import("./rpc-manager.ts");
const approved = ["datahub_catalog", "datahub_semantic"];

test("semantic governance is an exact selectable and durable profile, never legacy/full", () => {
  assert.deepEqual(validateSessionToolSelection(approved), approved);
  assert.deepEqual(getToolNamesForPreset("semantic-governance"), approved);
  assert.equal(getPresetFromToolNames(approved), "semantic-governance");
  for (const extra of [
    "read",
    "bash",
    "datahub_sql",
    "Agent",
    "datahub_ingestion",
  ]) {
    assert.throws(() => validateSessionToolSelection([...approved, extra]));
    assert.notEqual(
      getPresetFromToolNames([...approved, extra]),
      "semantic-governance",
    );
  }
  assert.throws(() => validateSessionToolSelection(["datahub_semantic"]));
  const calls = [];
  appendSessionToolSelection(
    { appendCustomEntry: (...args) => calls.push(args) },
    approved,
  );
  assert.deepEqual(calls, [
    [
      TOOL_SELECTION_TYPE,
      { version: 1, tools: [], profile: "semantic-governance" },
    ],
  ]);
  const entry = {
    type: "custom",
    customType: TOOL_SELECTION_TYPE,
    data: calls[0][1],
  };
  assert.deepEqual(readSessionToolSelection([entry]), approved);
  for (const data of [
    { ...entry.data, tools: ["read"] },
    { ...entry.data, version: 2 },
    { ...entry.data, profile: "future-profile" },
  ]) {
    assert.throws(() => readSessionToolSelection([entry, { ...entry, data }]));
  }
});

test("semantic selection excludes coding, SQL, ETL, MCP and delegation extensions", () => {
  const names = [
    ...approved,
    "read",
    "bash",
    "datahub_sql",
    "datahub_etl",
    "mcp",
    "Agent",
  ];
  const inner = {
    getAllTools: () => names.map((name) => ({ name })),
    settingsManager: { getDefaultTools: () => ["read", "bash"] },
  };
  assert.deepEqual(withExtensionTools(inner, approved), approved);
  assert.deepEqual(
    withExtensionTools(
      { ...inner, getAllTools: () => [{ name: "datahub_catalog" }] },
      approved,
    ),
    ["datahub_catalog"],
  );
});

test("extension binding cannot widen a restored semantic-governance profile", async () => {
  const tools = [...approved];
  let active = [...approved];
  const inner = {
    sessionId: "semantic-binding-test",
    isBashRunning: false,
    agent: { state: {} },
    sessionManager: { getCwd: () => "/tmp" },
    getAllTools: () => tools.map((name) => ({ name })),
    getActiveToolNames: () => active,
    setActiveToolsByName: (names) => {
      active = [...names];
    },
    async bindExtensions() {
      tools.push("read", "datahub_sql", "Agent");
      active.push("read", "datahub_sql", "Agent");
    },
    dispose() {},
    extensionRunner: {},
  };
  const wrapper = new AgentSessionWrapper(inner, {
    selectedToolNames: approved,
  });
  try {
    wrapper.beginExtensionBinding();
    const observed = await wrapper.send({ type: "get_tools" });
    assert.deepEqual(
      observed
        .filter((tool) => tool.active)
        .map((tool) => tool.name)
        .sort(),
      [...approved].sort(),
    );
    assert.equal(wrapper.getDataHubToolProfile(), "semantic-governance");
    for (const selection of [
      ["read"],
      ["datahub_catalog", "datahub_sql", "datahub_grafana"],
      [],
    ]) {
      assert.throws(
        () => wrapper.setActiveToolSelection(selection),
        /requires session recreation/,
      );
      assert.deepEqual(active.sort(), [...approved].sort());
    }
  } finally {
    wrapper.destroy();
  }
});

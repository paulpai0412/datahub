import assert from "node:assert/strict";
import test from "node:test";
import { startAgentServer } from "../extensions/datahub-agent/integration/server.mjs";

// All failures must occur before any Docker operation, listener or identity call.
const config = {
  scope: "server-test",
  runtimeImageId: `sha256:${"0".repeat(64)}`,
  gatewayOrigin: "http://localhost:9041",
  datahubOrigin: "http://localhost:9002",
  tenant: "fixture",
  browserAssetsDirectory: "/not-used",
};

test("server entrypoint rejects browser identity, unsafe origins and missing static release", async () => {
  for (const input of [
    null,
    [],
    { ...config, actor: "forged" },
    { ...config, browserAssetsDirectory: "" },
    { ...config, egressOriginsByActor: null },
    { ...config, egressOriginsByActor: [] },
    { ...config, egressOriginsByActor: { alice: [] } },
  ]) {
    await assert.rejects(
      startAgentServer(input),
      /invalid_agent_server_configuration/,
    );
  }
  for (const origin of [
    "http://evil.example:9041",
    "http://localhost",
    "https://localhost:9041",
    "http://u:p@localhost:9041",
    "http://localhost:9041/path",
  ]) {
    await assert.rejects(
      startAgentServer({ ...config, gatewayOrigin: origin }),
      /local_agent_origin_required/,
    );
  }
});

test("operator egress policy rejects unsafe destinations before Docker", async () => {
  for (const origins of [
    null,
    "https://auth.openai.com",
    ["http://auth.openai.com"],
    ["https://127.0.0.1"],
    ["https://169.254.169.254"],
    ["https://u:p@auth.openai.com"],
    ["https://auth.openai.com/oauth/token"],
    ["https://auth.openai.com:8443"],
    Array(65).fill("https://auth.openai.com"),
  ]) {
    await assert.rejects(
      startAgentServer({
        ...config,
        egressOriginsByActor: { ["a".repeat(48)]: origins },
      }),
      /invalid_egress_policy/,
    );
  }
});

test("Discovery cannot enable a model-selected path or unapproved snapshot before Docker", async () => {
  for (const policies of [
    null,
    { alice: [] },
    {
      ["a".repeat(48)]: [
        {
          sourceId: "fixture",
          root: "/approved",
          paths: ["pipeline.py"],
          snapshotSha256: "a".repeat(64),
          modelContextApproved: false,
        },
      ],
    },
  ]) {
    await assert.rejects(
      startAgentServer({ ...config, discoverySourcesByActor: policies }),
      /invalid_discovery_policy/,
    );
  }
});

test("control-plane human cookies cannot accidentally use a developer proxy", async () => {
  const before = process.env.HTTP_PROXY;
  process.env.HTTP_PROXY = "http://unused.invalid:80";
  try {
    await assert.rejects(startAgentServer(config), /clean_proxy_environment/);
    await assert.rejects(
      startAgentServer({
        ...config,
        egressOriginsByActor: {
          ["a".repeat(48)]: ["https://auth.openai.com", "https://chatgpt.com"],
          ["b".repeat(48)]: [],
        },
      }),
      /clean_proxy_environment/,
    );
  } finally {
    if (before === undefined) delete process.env.HTTP_PROXY;
    else process.env.HTTP_PROXY = before;
  }
});

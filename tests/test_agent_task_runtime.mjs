import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { connect } from "node:net";
import { once } from "node:events";
import { taskRuntime } from "../extensions/datahub-agent/integration/task-runtime.mjs";
import { isValidWebSessionToken } from "../extensions/datahub-agent/pi-web/lib/web-auth.ts";
import decisionExtension from "../extensions/datahub-agent/pi-web/lib/datahub-decision-extension.ts";
import { ingestionPolicies } from "../extensions/datahub-agent/integration/ingestion-policy.mjs";
import {
  PRESET_FULL,
  PRESET_READ_ONLY,
} from "../extensions/datahub-agent/pi-web/lib/tool-presets.ts";

const sessionId = "00000000-0000-4000-8000-000000000020";
const password = "fixture-only-runtime-password-not-a-secret";
test("native runtime HTTP seam uses private auth/socket, ensure_session, queue clear, abort and state readback", async (t) => {
  const calls = [];
  let stopped = false,
    present = true;
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.host, "runtime.fixture:3000");
    assert.equal(request.headers.origin, "http://runtime.fixture:3000");
    assert(!request.headers.cookie.includes("PLAY_SESSION"));
    assert(
      isValidWebSessionToken(
        request.headers.cookie.replace(/^pi_web_session=/, ""),
        password,
      ),
    );
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = text ? JSON.parse(text) : undefined;
    calls.push({ path: request.url, method: request.method, body });
    let result;
    if (request.url === "/api/default-cwd") result = { cwd: "/fixture/cwd" };
    else if (request.url === "/api/agent/new") {
      // Match native session-tool-selection: this field selects built-ins, not extensions.
      if (
        !Array.isArray(body.toolNames) ||
        body.toolNames.some((name) => !PRESET_FULL.includes(name))
      ) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: "toolNames must contain only built-in tool names",
          }),
        );
        return;
      }
      assert.deepEqual(body, {
        cwd: "/fixture/cwd",
        type: "ensure_session",
        toolNames: PRESET_READ_ONLY,
      });
      result = { success: true, sessionId };
    } else if (request.method === "GET")
      result = present
        ? {
            running: true,
            state: {
              sessionId,
              isStreaming: !stopped,
              isPromptRunning: !stopped,
              isBashRunning: false,
              isCompacting: false,
              pendingMessageCount: 0,
            },
          }
        : { running: false };
    else {
      if (!present) {
        response.writeHead(404);
        response.end();
        return;
      }
      if (body.type === "abort") stopped = true;
      result = { success: true, data: null };
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(result));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  let active = true,
    sockets = 0;
  const runtime = taskRuntime(
    {
      origin: "http://runtime.fixture:3000",
      password,
      async openSocket(signal) {
        sockets++;
        const socket = connect({
          host: "127.0.0.1",
          port: server.address().port,
          signal,
        });
        await once(socket, "connect");
        return socket;
      },
    },
    () => {
      if (!active) throw new Error("revoked");
    },
  );
  assert.equal(await runtime.createSession(), sessionId);
  await runtime.name(sessionId, "Fixture task");
  await runtime.prompt(sessionId, "Fixture prompt, no LLM");
  assert.equal((await runtime.state(sessionId)).state.isStreaming, true);
  assert.equal((await runtime.stop(sessionId)).stopObserved, true);
  assert.deepEqual(
    calls.slice(-3).map((c) => c.body?.type ?? c.method),
    ["clear_queue", "abort", "GET"],
  );
  assert.equal(sockets, calls.length);
  assert.throws(() => runtime.state("../../other"), /invalid_task_session/);
  present = false;
  const beforeIdleStop = calls.length;
  assert.equal((await runtime.stop(sessionId)).stopObserved, true);
  assert.deepEqual(
    calls.slice(beforeIdleStop).map((c) => c.method),
    ["GET"],
  );
  active = false;
  const count = calls.length;
  await assert.rejects(runtime.prompt(sessionId, "must not send"), /revoked/);
  assert.equal(calls.length, count);
});

test("decision tool uses native blocking UI and preserves correlation without claiming authority", async () => {
  let tool;
  decisionExtension({
    registerTool(value) {
      tool = value;
    },
  });
  assert.equal(tool.name, "datahub_decision");
  assert.equal(tool.executionMode, "sequential");
  const params = {
    runUrn: "urn:li:dataProcessInstance:fixture",
    question: "Continue?",
    choices: ["A"],
  };
  let request;
  const result = await tool.execute(
    "fixture-call",
    params,
    undefined,
    undefined,
    {
      mode: "rpc",
      ui: {
        async input(title, body, options) {
          assert.equal(title, "DataHub task decision");
          assert.equal(options.timeout, undefined);
          request = JSON.parse(body);
          return JSON.stringify({
            response: { action: "RESPOND", text: "A" },
            runVersion: "2",
          });
        },
      },
    },
  );
  assert.equal(request.runUrn, params.runUrn);
  assert(request.requestId);
  assert.equal(result.details.requestId, request.requestId);
  assert.equal(result.details.response.text, "A");
  const aborted = await tool.execute(
    "fixture-call",
    params,
    undefined,
    undefined,
    { mode: "rpc", ui: { input: async () => undefined } },
  );
  assert.equal(aborted.details.state, "unconfirmed");
  const outside = await tool.execute(
    "fixture-call",
    params,
    undefined,
    undefined,
    { mode: "tui" },
  );
  assert.equal(outside.details.error, "datahub_host_required");
});

test("existing Source policy can opt into exact Task datasets; existing ingestion policy stays valid", () => {
  const key = "a".repeat(48);
  const source = {
    urn: "urn:li:dataHubIngestionSource:00000000-0000-4000-8000-000000000001",
    cliVersion: "1.7.0.9",
    recipeSha256: "b".repeat(64),
  };
  assert.equal(
    ingestionPolicies({ [key]: [source] }).get(key)[0].taskDatasets,
    undefined,
  );
  const dataset =
    "urn:li:dataset:(urn:li:dataPlatform:mssql,fixture.person,DEV)";
  const input = { ...source, taskDatasets: [dataset] };
  const approved = ingestionPolicies({ [key]: [input] }).get(key)[0];
  input.taskDatasets.push("not-approved");
  assert.deepEqual(approved.taskDatasets, [dataset]);
  assert(Object.isFrozen(approved.taskDatasets));
  for (const taskDatasets of [
    [],
    [dataset, dataset],
    ["urn:li:corpuser:other"],
    "all",
    [dataset, null],
  ])
    assert.throws(
      () => ingestionPolicies({ [key]: [{ ...source, taskDatasets }] }),
      /invalid_ingestion_policy/,
    );
});

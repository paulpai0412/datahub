import assert from "node:assert/strict";
import { MessageChannel } from "node:worker_threads";
import test from "node:test";
import { installSqlBridge } from "./sql.js";

const originalWindow = globalThis.window;

test("SQL bridge keeps model receipts and numerical card responses on separate channels", async (t) => {
  const listeners = new Set();
  globalThis.window = {
    addEventListener: (_name, listener) => listeners.add(listener),
    removeEventListener: (_name, listener) => listeners.delete(listener),
  };
  const frame = { contentWindow: {} };
  let execution = 0;
  let reads = 0;
  let sourceOnly = false;
  const stop = installSqlBridge({
    frame,
    origin: "https://example.test",
    execute: async () => {
      execution++;
      return {
        format: sourceOnly
          ? "datahub-sql.source-receipt/1"
          : "datahub-sql.receipt/1",
        resultRef: "11111111-1111-4111-8111-111111111111",
      };
    },
    readResult: async () => {
      reads++;
      return {
        format: sourceOnly ? "datahub-sql.source-card/1" : "datahub-sql.card/1",
        points: [{ salesAmount: "120.500000" }],
      };
    },
  });
  t.after(() => {
    stop();
    globalThis.window = originalWindow;
  });
  async function request(type, body, origin = "https://example.test") {
    const channel = new MessageChannel();
    const response = new Promise((resolve) =>
      channel.port1.once("message", resolve),
    );
    const event = {
      source: frame.contentWindow,
      origin,
      data: { type, body: JSON.stringify(body) },
      ports: [channel.port2],
    };
    for (const listener of listeners) await listener(event);
    if (origin !== "https://example.test") {
      channel.port1.close();
      channel.port2.close();
      return undefined;
    }
    const value = JSON.parse(await response);
    channel.port1.close();
    channel.port2.close();
    return value;
  }
  assert.equal(
    (await request("datahub-sql", { action: "execute" })).format,
    "datahub-sql.receipt/1",
  );
  assert.equal(
    (await request("datahub-sql-card", { action: "read_result" })).points[0]
      .salesAmount,
    "120.500000",
  );
  assert.deepEqual(await request("datahub-sql", { action: "read_result" }), {
    error: "sql_request_rejected",
  });
  assert.equal(
    await request(
      "datahub-sql",
      { action: "execute" },
      "https://attacker.test",
    ),
    undefined,
  );
  sourceOnly = true;
  assert.equal(
    (await request("datahub-sql", { action: "execute" })).format,
    "datahub-sql.source-receipt/1",
  );
  assert.equal(
    (await request("datahub-sql-card", { action: "read_result" })).format,
    "datahub-sql.source-card/1",
  );
  assert.equal(execution, 2);
  assert.equal(reads, 2);
});

test("SQL bridge refuses accidental numbers on the model channel", async (t) => {
  const listeners = new Set();
  globalThis.window = {
    addEventListener: (_name, listener) => listeners.add(listener),
    removeEventListener: (_name, listener) => listeners.delete(listener),
  };
  const frame = { contentWindow: {} };
  const stop = installSqlBridge({
    frame,
    origin: "https://example.test",
    execute: async () => ({
      format: "datahub-sql.receipt/1",
      points: [{ salesAmount: "SECRET_VALUE" }],
    }),
    readResult: async () => ({ format: "datahub-sql.card/1" }),
  });
  t.after(() => {
    stop();
    globalThis.window = originalWindow;
  });
  const channel = new MessageChannel();
  const message = new Promise((resolve) =>
    channel.port1.once("message", resolve),
  );
  for (const listener of listeners)
    await listener({
      source: frame.contentWindow,
      origin: "https://example.test",
      data: {
        type: "datahub-sql",
        body: JSON.stringify({ action: "execute" }),
      },
      ports: [channel.port2],
    });
  assert.deepEqual(JSON.parse(await message), { error: "sql_request_failed" });
  channel.port1.close();
  channel.port2.close();
});

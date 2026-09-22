// Live local DataHub denial + real server wiring; never a successful-login claim.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { startAgentServer } from "../extensions/datahub-agent/integration/server.mjs";

assert.match(process.env.AGENT_RUNTIME_IMAGE ?? "", /^sha256:[a-f0-9]{64}$/);
assert.ok(process.env.AGENT_BROWSER_ASSETS);
const running = await startAgentServer({
  scope: `entry-test-${randomBytes(5).toString("hex")}`,
  runtimeImageId: process.env.AGENT_RUNTIME_IMAGE,
  gatewayOrigin: "http://localhost:0",
  datahubOrigin: "http://localhost:9002",
  tenant: "local-datahub",
  browserAssetsDirectory: process.env.AGENT_BROWSER_ASSETS,
});
try {
  const base = `http://localhost:${running.server.address().port}`;
  assert.equal((await fetch(`${base}/mfe/remoteEntry.js`)).status, 200);
  for (const cookie of [
    undefined,
    "PLAY_SESSION=invalid-source-only-fixture",
    "PLAY_SESSION=invalid-source-only-fixture; actor=urn:li:corpuser:fixture",
  ]) {
    const response = await fetch(`${base}/agent/bootstrap`, {
      method: "POST",
      headers: {
        origin: "http://localhost:9002",
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: "{}",
    });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
      error: "authentication_required",
    });
  }
  const forged = await fetch(`${base}/agent/bootstrap`, {
    method: "POST",
    headers: {
      origin: "http://localhost:9002",
      "content-type": "application/json",
    },
    body: '{"actor":"forged"}',
  });
  assert.equal(forged.status, 400);
  console.log(
    "Real entrypoint/MFE + live DataHub missing/invalid-session denial: PASS; successful SSO, model and ingestion untested",
  );
} finally {
  await running.close();
}

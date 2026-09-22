// Explicit real-container acceptance. Requires an already built, reviewed fixture
// image ID. No image pulling, real credentials, source DB/GMS calls or Pi/model runs.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { request } from "node:http";
import { createRuntimeManager } from "../extensions/datahub-agent/integration/runtime-manager.mjs";
import { createWebSessionToken } from "../extensions/datahub-agent/pi-web/lib/web-auth.ts";

const exec = promisify(execFile);
const imageId = process.env.AGENT_FIXTURE_IMAGE;
assert.match(imageId ?? "", /^sha256:[a-f0-9]{64}$/);
const scope = `test-${randomBytes(6).toString("hex")}`;
function actor(name) {
  const tenant = "isolation-fixture";
  const urn = `urn:li:corpuser:${name}`;
  const key = createHash("sha256")
    .update(JSON.stringify([tenant, urn]))
    .digest("hex")
    .slice(0, 48);
  return { tenant, urn, key };
}
const alice = actor("alice"),
  bob = actor("bob");
async function get(runtime, path) {
  const socket = await runtime.openSocket(AbortSignal.timeout(5000));
  return new Promise((resolve, reject) => {
    // This intentionally cannot resolve. Success proves the acquired Unix-backed
    // socket, not a fallback host TCP connection, carried the HTTP request.
    const req = request(
      {
        hostname: "must-not-resolve.invalid",
        port: 9,
        path,
        createConnection: () => socket,
        headers: {
          host: "localhost",
          cookie: `pi_web_session=${createWebSessionToken(runtime.password)}`,
        },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("error", reject);
        res.on("end", () => {
          try {
            assert.equal(res.statusCode, 200);
            resolve(JSON.parse(text));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(15000, () =>
      req.destroy(new Error("fixture_request_timeout")),
    );
    req.end();
  });
}
async function docker(args) {
  try {
    return (
      await exec("docker", args, { timeout: 30000, maxBuffer: 1024 * 1024 })
    ).stdout.trim();
  } catch {
    throw new Error("fixture_docker_operation_failed");
  }
}
let manager;
try {
  console.log(
    JSON.stringify({
      scope,
      imageId,
      stage: "start",
      limitation:
        "Synthetic HTTP app in real containers, not pi-web product or model acceptance",
    }),
  );
  manager = await createRuntimeManager({
    scope,
    imageId,
    memoryMiB: 128,
    cpus: 0.5,
  });
  const pending = manager.forActor(alice);
  assert.equal(manager.forActor(alice), pending);
  const a = await pending;
  const b = await manager.forActor(bob);
  await get(a, "/write-alice");
  assert.deepEqual(await get(b, "/marker"), { marker: null });
  await get(b, "/write-bob");
  assert.deepEqual(await get(a, "/marker"), { marker: "alice" });
  assert.deepEqual(await get(b, "/marker"), { marker: "bob" });
  for (const runtime of [a, b]) {
    const probe = await get(runtime, "/probe");
    assert.deepEqual(probe, {
      uid: 1000,
      interfaces: ["lo"],
      hostSocketAbsent: true,
      rootWriteDenied: true,
      socketReplacementDenied: true,
      directPublicTcpDenied: "ENETUNREACH",
      directMetadataTcpDenied: "ENETUNREACH",
      developerCredentialsAbsent: true,
    });
  }
  console.log(
    "network-none / read-only IPC and image / no inherited credentials / separate homes: PASS",
  );
  assert.throws(
    () => manager.forActor({ ...bob, key: alice.key }),
    /invalid_runtime_actor/,
  );
  await assert.rejects(
    manager.forActor(actor("third")),
    /runtime_capacity_exhausted/,
  );
  assert.throws(
    () => manager.setAllowedOrigins(alice, ["https://127.0.0.1"]),
    /invalid_egress_policy/,
  );
  assert.equal((await get(a, "/public-egress")).blocked, true);
  manager.setAllowedOrigins(alice, ["https://registry.npmjs.org"]);
  const egress = await get(a, "/public-egress");
  assert.equal(egress.status, 200, JSON.stringify(egress));
  assert.equal((await get(b, "/public-egress")).blocked, true);
  manager.setAllowedOrigins(alice, []);
  assert.equal((await get(a, "/public-egress")).blocked, true);
  console.log(
    "Node native proxy env / scoped HTTPS HEAD / policy removal / other user deny: PASS",
  );
  await manager.close();
  manager = await createRuntimeManager({
    scope,
    imageId,
    memoryMiB: 128,
    cpus: 0.5,
  });
  const resumed = await manager.forActor(alice);
  assert.deepEqual(await get(resumed, "/marker"), { marker: "alice" });
  assert.equal((await get(resumed, "/public-egress")).blocked, true);
  console.log("owned volume persistence / restart-deny egress: PASS");
} finally {
  // Never remove a home until this manager confirmed all of its containers stopped.
  await manager?.close();
  const remaining = await docker([
    "ps",
    "-aq",
    "--filter",
    `label=datahub.agent.scope=${scope}`,
  ]);
  assert.equal(remaining, "", "fixture containers require cleanup");
  for (const identity of [alice, bob]) {
    const volume = `dha-${scope}-${identity.key}`;
    if (
      !(await docker([
        "volume",
        "ls",
        "--filter",
        `name=^${volume}$`,
        "--format",
        "{{.Name}}",
      ]))
    )
      continue;
    const actualScope = await docker([
      "volume",
      "inspect",
      volume,
      "--format",
      '{{index .Labels "datahub.agent.scope"}}',
    ]);
    assert.equal(actualScope, scope);
    await docker(["volume", "rm", volume]);
  }
  console.log("fixture-only cleanup: PASS");
}

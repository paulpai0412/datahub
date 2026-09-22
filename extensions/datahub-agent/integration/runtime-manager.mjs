import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { request } from "node:http";
import { createReverseHttpPool } from "./reverse-http.mjs";
import { createEgressProxy } from "./egress-proxy.mjs";
import { createWebSessionToken } from "../pi-web/lib/web-auth.ts";

const exec = promisify(execFile);
const SCOPE = "datahub.agent.scope";
const OWNER = "datahub.agent.owner";

function ownerOf(actor) {
  if (
    !actor ||
    typeof actor.tenant !== "string" ||
    !actor.tenant ||
    actor.tenant.length > 128 ||
    typeof actor.urn !== "string" ||
    !/^urn:li:corpuser:[^\x00-\x1f\x7f]+$/.test(actor.urn) ||
    actor.urn.length > 1024
  )
    throw new Error("invalid_runtime_actor");
  const owner = createHash("sha256")
    .update(JSON.stringify([actor.tenant, actor.urn]))
    .digest("hex");
  if (actor.key !== owner.slice(0, 48))
    throw new Error("invalid_runtime_actor");
  return owner;
}

/** Local Linux/Docker deployment only. Operator supplies a reviewed local image ID.
 * No pulling, existing-container adoption, host firewall changes, or volume deletion. */
export async function createRuntimeManager({
  scope,
  imageId,
  memoryMiB = 1024,
  cpus = 1,
  maxRuntimes = 2,
}) {
  if (
    process.getuid?.() !== 1000 ||
    !/^[a-z][a-z0-9-]{2,30}$/.test(scope) ||
    !/^sha256:[a-f0-9]{64}$/.test(imageId) ||
    !Number.isInteger(memoryMiB) ||
    memoryMiB < 128 ||
    memoryMiB > 8192 ||
    !Number.isFinite(cpus) ||
    cpus < 0.25 ||
    cpus > 4 ||
    !Number.isInteger(maxRuntimes) ||
    maxRuntimes < 1 ||
    maxRuntimes > 8
  ) {
    throw new Error("invalid_runtime_configuration");
  }
  const root = await mkdtemp("/tmp/dha-");
  const records = new Map();
  let closed = false;
  async function docker(args) {
    try {
      const result = await exec("docker", args, {
        timeout: 30000,
        maxBuffer: 1024 * 1024,
        env: { PATH: process.env.PATH, HOME: root },
      });
      return result.stdout.trim();
    } catch {
      // exec errors include argv (including PI_WEB_PASSWORD). Never propagate them.
      throw new Error("runtime_docker_command_failed");
    }
  }
  try {
    if (
      (await docker(["image", "inspect", imageId, "--format", "{{.Id}}"])) !==
      imageId
    )
      throw new Error("runtime_image_mismatch");
    if (await docker(["ps", "-aq", "--filter", `label=${SCOPE}=${scope}`]))
      throw new Error("runtime_recovery_required");
  } catch (error) {
    await rm(root, { recursive: true });
    throw error;
  }

  async function inspectJson(args) {
    try {
      return JSON.parse(await docker(args));
    } catch {
      throw new Error("runtime_inspection_failed");
    }
  }

  async function inspectOwned(record) {
    const entries = await inspectJson(["container", "inspect", record.name]);
    const value = entries[0];
    if (
      value?.Config?.Labels?.[SCOPE] !== scope ||
      value.Config.Labels[OWNER] !== record.owner ||
      value.Image !== imageId
    )
      throw new Error("runtime_ownership_mismatch");
    return value;
  }

  async function start(record) {
    await mkdir(record.directory, { mode: 0o755 });
    record.pool = await createReverseHttpPool(
      join(record.directory, "runtime.sock"),
    );
    record.egress = await createEgressProxy(
      join(record.directory, "egress.sock"),
    );
    // Named volumes preserve per-user sessions/workspaces. Validate existing ownership.
    const exists = await docker([
      "volume",
      "ls",
      "--filter",
      `name=^${record.volume}$`,
      "--format",
      "{{.Name}}",
    ]);
    if (!exists)
      await docker([
        "volume",
        "create",
        "--label",
        `${SCOPE}=${scope}`,
        "--label",
        `${OWNER}=${record.owner}`,
        record.volume,
      ]);
    const volume = (await inspectJson(["volume", "inspect", record.volume]))[0];
    if (
      volume?.Labels?.[SCOPE] !== scope ||
      volume.Labels[OWNER] !== record.owner
    )
      throw new Error("runtime_volume_ownership_mismatch");
    await docker([
      "create",
      "--name",
      record.name,
      "--init",
      "--network",
      "none",
      "--read-only",
      "--user",
      "1000:1000",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "128",
      "--memory",
      `${memoryMiB}m`,
      "--memory-swap",
      `${memoryMiB}m`,
      "--cpus",
      String(cpus),
      "--label",
      `${SCOPE}=${scope}`,
      "--label",
      `${OWNER}=${record.owner}`,
      "--mount",
      `type=volume,src=${record.volume},dst=/home/node`,
      "--mount",
      `type=bind,src=${record.directory},dst=/run/datahub-agent,readonly`,
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=256m,uid=1000,gid=1000",
      "--workdir",
      "/home/node",
      "--env",
      "HOME=/home/node",
      "--env",
      "PI_CODING_AGENT_DIR=/home/node/.pi/agent",
      "--env",
      `PI_WEB_PASSWORD=${record.password}`,
      "--env",
      "PI_WEB_SKIP_VERSION_CHECK=1",
      "--env",
      "NEXT_TELEMETRY_DISABLED=1",
      "--env",
      "NODE_USE_ENV_PROXY=1",
      "--env",
      "HTTP_PROXY=http://127.0.0.1:3128",
      "--env",
      "HTTPS_PROXY=http://127.0.0.1:3128",
      "--env",
      "NO_PROXY=localhost,127.0.0.1",
      imageId,
    ]);
    const actual = await inspectOwned(record);
    const mounts = actual.Mounts;
    if (
      actual.HostConfig.NetworkMode !== "none" ||
      actual.HostConfig.Privileged ||
      !actual.HostConfig.ReadonlyRootfs ||
      actual.Config.User !== "1000:1000" ||
      !actual.HostConfig.CapDrop?.includes("ALL") ||
      !actual.HostConfig.SecurityOpt?.includes("no-new-privileges") ||
      actual.HostConfig.Memory !== memoryMiB * 1024 * 1024 ||
      actual.HostConfig.MemorySwap !== actual.HostConfig.Memory ||
      actual.HostConfig.NanoCpus !== cpus * 1000000000 ||
      actual.HostConfig.PidsLimit !== 128 ||
      actual.HostConfig.Devices?.length ||
      actual.HostConfig.DeviceRequests?.length ||
      mounts.length !== 2 ||
      !mounts.some(
        (m) =>
          m.Type === "volume" &&
          m.Name === record.volume &&
          m.Destination === "/home/node" &&
          m.RW,
      ) ||
      !mounts.some(
        (m) =>
          m.Type === "bind" &&
          m.Source === record.directory &&
          m.Destination === "/run/datahub-agent" &&
          !m.RW,
      )
    ) {
      throw new Error("runtime_isolation_mismatch");
    }
    await docker(["start", record.name]);
    const socket = await record.pool.acquire(AbortSignal.timeout(20000));
    await new Promise((resolve, reject) => {
      const check = request(
        {
          host: "localhost",
          port: 30141,
          path: "/api/web-auth",
          createConnection: () => socket,
          headers: {
            cookie: `pi_web_session=${createWebSessionToken(record.password)}`,
          },
        },
        (response) => {
          response.resume();
          response.on("end", () =>
            response.statusCode === 200
              ? resolve()
              : reject(new Error("runtime_not_ready")),
          );
          response.on("error", () => reject(new Error("runtime_not_ready")));
        },
      );
      check.setTimeout(10000, () => check.destroy());
      check.on("error", () => reject(new Error("runtime_not_ready")));
      check.end();
    });
    return Object.freeze({
      origin: "http://localhost:30141",
      password: record.password,
      openSocket: (signal) => record.pool.acquire(signal),
    });
  }

  return {
    forActor(actor) {
      const owner = ownerOf(actor);
      if (closed) return Promise.reject(new Error("runtime_manager_closed"));
      const existing = records.get(actor.key);
      if (existing) {
        if (existing.owner !== owner)
          return Promise.reject(new Error("runtime_ownership_mismatch"));
        return existing.started;
      }
      if (records.size >= maxRuntimes)
        return Promise.reject(new Error("runtime_capacity_exhausted"));
      const record = {
        owner,
        name: `dha-${scope}-${randomUUID()}`,
        volume: `dha-${scope}-${actor.key}`,
        directory: join(root, actor.key),
        password: randomBytes(32).toString("base64url"),
        pool: null,
        egress: null,
        started: null,
      };
      records.set(actor.key, record);
      // Keep rejected starts. Ambiguous Docker failures require inspect/cleanup,
      // not automatic retries that might create a second writer for the volume.
      record.started = start(record);
      return record.started;
    },
    setAllowedOrigins(actor, origins) {
      const record = records.get(actor.key);
      if (!record || record.owner !== ownerOf(actor) || !record.egress)
        throw new Error("runtime_not_ready");
      record.egress.setAllowedOrigins(origins);
    },
    async close() {
      closed = true;
      const failures = [];
      for (const record of records.values()) {
        await record.started.catch(() => {});
        try {
          const names = await docker([
            "ps",
            "-aq",
            "--filter",
            `name=^/${record.name}$`,
          ]);
          if (names) {
            await inspectOwned(record);
            await docker(["stop", "--time", "10", record.name]);
            await inspectOwned(record);
            await docker(["rm", record.name]);
          }
          await record.pool?.close();
          await record.egress?.close();
        } catch {
          failures.push(record.name);
        }
      }
      if (failures.length)
        throw new Error(`runtime_cleanup_required:${failures.join(",")}`);
      await rm(root, { recursive: true, force: true });
    },
  };
}

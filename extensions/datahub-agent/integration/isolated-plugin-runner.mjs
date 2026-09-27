import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, writeFile, lstat } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { candidateFiles, candidateDigest } from "../pi-web/lib/discovery-plugin-candidates.ts";

// Node 24.18.0 is the pinned Host/runtime baseline; native TS stripping is used
// only for this reviewed shared capsule validator, NEVER for candidate source.
const DISCOVERY = fileURLToPath(new URL("../../dataflow-discovery/", import.meta.url));
const HASH = value => createHash("sha256").update(value).digest("hex");
const INPUT_LIMIT = 131_072;
const OUTPUT_LIMIT = 60_000;
const CLI_ENV = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/nonexistent" };
const HOST_SOURCES = [import.meta.url, new URL("../pi-web/lib/discovery-plugin-candidates.ts", import.meta.url).href];
const HOST_DIGESTS = await Promise.all(HOST_SOURCES.map(async url => HASH(await readFile(fileURLToPath(url)))));
async function verifyHostSources() {
  for (let index = 0; index < HOST_SOURCES.length; index++) {
    if (HASH(await readFile(fileURLToPath(HOST_SOURCES[index]))) !== HOST_DIGESTS[index]) {
      throw new ExecutionFailure("isolated_host_source_drift", "admission");
    }
  }
}

class ExecutionFailure extends Error {
  constructor(code, phase, details = {}) { super(code); this.code = code; this.phase = phase; this.details = details; }
}

function command(clientRoot, args, { input, limit = 262_144, timeout = 10_000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile("docker", ["--config", clientRoot, "--host", "unix:///var/run/docker.sock", ...args],
      { env: CLI_ENV, timeout, maxBuffer: limit, encoding: "buffer", ...(signal ? { signal } : {}) },
      (error, stdout, stderr) => {
        const result = { stdout, stderr, exitCode: typeof error?.code === "number" ? error.code : error ? null : 0,
          interrupted: Boolean(child.killed || signal?.aborted || error?.killed || error?.name === "AbortError" || error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") };
        if (result.interrupted || result.exitCode === null) reject(Object.assign(new Error("docker_command_incomplete"), { result }));
        else resolve(result);
      });
    // EPIPE is reflected in the command outcome; never replay a partial request.
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

async function jsonFile(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}

async function copyReviewedTree(source, target, digests, prefix) {
  await mkdir(target, { recursive: true, mode: 0o755 }); await chmod(target, 0o755);
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error("framework_symlink_rejected");
    if (entry.isDirectory() && entry.name !== "__pycache__") {
      await copyReviewedTree(join(source, entry.name), join(target, entry.name), digests, `${prefix}${entry.name}/`);
    } else if (entry.isFile() && entry.name.endsWith(".py")) {
      const bytes = await readFile(join(source, entry.name));
      await writeFile(join(target, entry.name), bytes, { flag: "wx", mode: 0o644 });
      digests[`${prefix}${entry.name}`] = HASH(bytes);
    }
  }
}

async function normalizeStageModes(path) {
  await chmod(path, 0o755);
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await normalizeStageModes(child);
    else if (entry.isFile()) await chmod(child, 0o644);
    else throw new Error("isolated_stage_special_file");
  }
}

function runtimeProjection(container) {
  return { Id: container.Id, Image: container.Image, State: container.State,
    User: container.Config.User, Labels: container.Config.Labels,
    environmentNames: (container.Config.Env ?? []).map(item => item.split("=", 1)[0]),
    HostConfig: container.HostConfig, Mounts: container.Mounts };
}

function attested(container, expected, imageEnvironment) {
  const host = container.HostConfig;
  return container.Image === expected.image && container.Config.User === "10001:10001" &&
    container.Config.Labels?.["com.ekop.discovery.execution"] === expected.id &&
    host.NetworkMode === "none" && host.ReadonlyRootfs === true && !host.Privileged && !host.PidMode &&
    !(host.CapAdd?.length) && !(host.Devices?.length) && host.Memory === 536_870_912 &&
    host.MemorySwap === 536_870_912 && host.PidsLimit === 64 && host.NanoCpus === 1_000_000_000 &&
    host.CapDrop?.length === 1 && host.CapDrop[0] === "ALL" && host.SecurityOpt?.includes("no-new-privileges") &&
    container.Mounts.length === 1 && container.Mounts[0].Source === expected.stage && container.Mounts[0].Destination === "/work" && !container.Mounts[0].RW &&
    JSON.stringify([...(container.Config.Env ?? [])].sort()) === JSON.stringify([...imageEnvironment].sort());
}

/** A bounded code-execution primitive, not an agent/controller, registry or
 * acceptance service. Public callers authorize sources and check semantics.
 * No automatic retries, target writes, network, credentials, or activation.
 */
export function createIsolatedPluginRunner({ image, evidenceRoot }) {
  if (!/^sha256:[a-f0-9]{64}$/.test(image) || !isAbsolute(evidenceRoot)) throw new Error("isolated_runner_configuration_invalid");
  const hostScope = HASH(evidenceRoot);
  let active = false;
  let blocked = false;
  return {
    async run({ files: submitted, source, config, signal }) {
      if (blocked) throw new Error("isolated_runner_requires_reconciliation");
      if (active) throw new Error("isolated_runner_busy");
      const files = candidateFiles(submitted);
      const digest = candidateDigest(files);
      signal?.throwIfAborted();
      active = true;
      const id = randomUUID();
      const directory = join(evidenceRoot, id);
      const stage = join(directory, "stage");
      const clientRoot = join(directory, "docker-client");
      const containers = [];
      const phases = [];
      const stageDigests = {};
      let outcome;
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await mkdir(stage, { mode: 0o755 }); await chmod(stage, 0o755);
        await mkdir(clientRoot, { mode: 0o700 });
        await verifyHostSources();
        for (const entry of await readdir(evidenceRoot, { withFileTypes: true })) {
          if (entry.name === id || !entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
          const prior = join(evidenceRoot, entry.name);
          const intent = await lstat(join(prior, "intent.json")).catch(error => { if (error.code === "ENOENT") return null; throw error; });
          if (!intent) continue; // No state-changing engine command was admitted.
          const result = await readFile(join(prior, "result.json"), "utf8").then(JSON.parse).catch(() => null);
          if (!result || !Array.isArray(result.containers) || result.containers.some(item => !item.removed)) {
            throw new ExecutionFailure("isolated_runner_requires_reconciliation", "admission");
          }
        }
        await jsonFile(join(clientRoot, "config.json"), {});
        // Empty Docker CLI config prevents implicit registry/proxy credential
        // propagation; the only endpoint is this machine's local engine.
        // Native engine state survives a Host restart; never ignore an older
        // unresolved owned container merely because the in-memory lock is new.
        const previous = await command(clientRoot, ["ps", "--all", "--filter", `label=com.ekop.discovery.host=${hostScope}`, "--format", "{{.ID}}"]);
        if (previous.exitCode !== 0 || previous.stdout.toString("utf8").trim()) {
          throw new ExecutionFailure("isolated_runner_requires_reconciliation", "admission");
        }
        const inspectImage = await command(clientRoot, ["image", "inspect", image]);
        if (inspectImage.exitCode !== 0) throw new ExecutionFailure("isolated_image_unavailable", "admission");
        const imageInfo = JSON.parse(inspectImage.stdout.toString("utf8"))[0];
        if (imageInfo.Id !== image) throw new ExecutionFailure("isolated_image_mismatch", "admission");
        await copyReviewedTree(join(DISCOVERY, "src/dataflow_discovery"), join(stage, "framework/dataflow_discovery"), stageDigests, "framework/dataflow_discovery/");
        await mkdir(join(stage, "contracts/v1"), { recursive: true, mode: 0o755 });
        for (const name of ["README.md", "manifest.schema.json", "graph.schema.json"]) {
          if (!(await lstat(join(DISCOVERY, "contracts/v1", name))).isFile()) throw new Error("framework_file_rejected");
          const bytes = await readFile(join(DISCOVERY, "contracts/v1", name));
          await writeFile(join(stage, "contracts/v1", name), bytes, { flag: "wx", mode: 0o644 });
          stageDigests[`contracts/v1/${name}`] = HASH(bytes);
        }
        for (const name of ["candidate_worker.py", "candidate_boundary.py"]) {
          if (!(await lstat(join(DISCOVERY, "testing", name))).isFile()) throw new Error("framework_file_rejected");
          const bytes = await readFile(join(DISCOVERY, "testing", name));
          await writeFile(join(stage, name), bytes, { flag: "wx", mode: 0o644 });
          stageDigests[name] = HASH(bytes);
        }
        await mkdir(join(stage, "candidate"), { mode: 0o755 });
        for (const [name, content] of Object.entries(files)) {
          await writeFile(join(stage, "candidate", name), content, { flag: "wx", mode: 0o644 });
          stageDigests[`candidate/${name}`] = HASH(content);
        }
        await normalizeStageModes(stage);
        const request = Buffer.from(JSON.stringify({ ...source, manifestText: files["manifest.json"], config }));
        if (request.length > INPUT_LIMIT) throw new ExecutionFailure("candidate_input_too_large", "input");
        await jsonFile(join(directory, "intent.json"), { id, image, candidateDigest: digest, stageDigests });

        async function phase(name, script, args, input, limit) {
          const containerName = `datahub-discovery-${name}-${id}`;
          const expected = { id, image, stage };
          // Save launch intent BEFORE invoking the engine; incomplete calls are
          // reconciled, never retried under another name or execution mode.
          containers.push({ name: containerName, owned: false, removed: false });
          const tracked = containers.at(-1);
          await jsonFile(join(directory, `${name}-intent.json`), { containerName, image, id, inputSha256: HASH(input), script, args });
          const created = await command(clientRoot, ["create", "--name", containerName, "--pull=never", "-i",
            "--label", `com.ekop.discovery.execution=${id}`, "--label", `com.ekop.discovery.host=${hostScope}`,
            "--network", "none", "--read-only", "--user", "10001:10001",
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "64", "--memory", "512m", "--memory-swap", "512m",
            "--cpus", "1", "--ipc", "none", "--ulimit", "nofile=256:256", "--stop-timeout", "2", "--log-driver", "local",
            "--log-opt", "max-size=1m", "--log-opt", "max-file=1", "--log-opt", "compress=false",
            "--mount", `type=bind,src=${stage},dst=/work,readonly,bind-propagation=rprivate`,
            "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m,mode=1777", "--entrypoint", "python", image, "-I", "-B", `/work/${script}`, ...args], { signal });
          if (created.exitCode !== 0) throw new ExecutionFailure("isolated_create_failed", name);
          const inspected = await command(clientRoot, ["inspect", containerName]);
          if (inspected.exitCode !== 0) throw new ExecutionFailure("isolated_inspection_failed", name);
          let container = JSON.parse(inspected.stdout.toString("utf8"))[0];
          tracked.owned = container.Config.Labels?.["com.ekop.discovery.execution"] === id;
          await jsonFile(join(directory, `${name}-created.json`), runtimeProjection(container));
          if (!attested(container, expected, imageInfo.Config.Env ?? [])) throw new ExecutionFailure("isolated_profile_rejected", name);
          let result;
          try {
            result = await command(clientRoot, ["start", "--attach", "--interactive", containerName], { input, limit, timeout: 15_000, signal });
          } catch (error) {
            if (error.result) {
              await writeFile(join(directory, `${name}-interrupted.stdout`), error.result.stdout, { flag: "wx", mode: 0o600 });
              await writeFile(join(directory, `${name}-interrupted.stderr`), error.result.stderr, { flag: "wx", mode: 0o600 });
            }
            throw new ExecutionFailure("isolated_execution_interrupted", name);
          }
          const after = await command(clientRoot, ["inspect", containerName]);
          if (after.exitCode !== 0) throw new ExecutionFailure("isolated_readback_failed", name);
          container = JSON.parse(after.stdout.toString("utf8"))[0];
          await jsonFile(join(directory, `${name}-readback.json`), runtimeProjection(container));
          if (!attested(container, expected, imageInfo.Config.Env ?? []) || container.State.Status !== "exited" || container.State.Pid !== 0) {
            throw new ExecutionFailure("isolated_state_unknown", name);
          }
          const receipt = { name, containerId: container.Id, image, exitCode: container.State.ExitCode,
            oomKilled: container.State.OOMKilled, profileVerified: true, stdoutSha256: HASH(result.stdout), stderrSha256: HASH(result.stderr) };
          phases.push(receipt);
          await jsonFile(join(directory, `${name}.json`), receipt);
          // Private bounded diagnostics; no candidate stdout is a trusted receipt.
          await writeFile(join(directory, `${name}.stdout`), result.stdout, { flag: "wx", mode: 0o600 });
          await writeFile(join(directory, `${name}.stderr`), result.stderr, { flag: "wx", mode: 0o600 });
          return { ...result, receipt };
        }

        const prepared = await phase("prepare", "candidate_boundary.py", ["prepare"], request, INPUT_LIMIT + 4096);
        const preparedValue = JSON.parse(prepared.stdout.toString("utf8"));
        if (preparedValue.status !== "PASS") {
          outcome = { status: "FAIL", code: preparedValue.code ?? "candidate_input_invalid" };
        } else {
          if (prepared.receipt.exitCode !== 0 || prepared.receipt.oomKilled) throw new ExecutionFailure("isolated_prepare_failed", "prepare");
          const input = preparedValue.result;
          const executed = await phase("candidate", "candidate_worker.py", [], Buffer.from(JSON.stringify(input)), OUTPUT_LIMIT);
          if (executed.receipt.exitCode !== 0 || executed.receipt.oomKilled) {
            outcome = { status: "FAIL", code: "candidate_execution_failed" };
          } else {
            const checked = await phase("validate", "candidate_boundary.py", ["validate"], Buffer.from(JSON.stringify({ input, outputBase64: executed.stdout.toString("base64") })), OUTPUT_LIMIT);
            const value = JSON.parse(checked.stdout.toString("utf8"));
            if (value.status === "PASS" && checked.receipt.exitCode === 0 && !checked.receipt.oomKilled) {
              outcome = { status: "PASS", result: value.result };
            } else if (value.status === "FAIL") outcome = { status: "FAIL", code: value.code };
            else throw new ExecutionFailure("isolated_validation_failed", "validate");
          }
        }
        for (const [name, hash] of Object.entries(stageDigests)) {
          if (HASH(await readFile(join(stage, name))) !== hash) throw new ExecutionFailure("isolated_stage_drift", "readback");
          if (!name.startsWith("candidate/")) {
            const original = name.startsWith("framework/") ? join(DISCOVERY, "src", name.slice("framework/".length)) :
              name.startsWith("contracts/") ? join(DISCOVERY, name) : join(DISCOVERY, "testing", name);
            if (HASH(await readFile(original)) !== hash) throw new ExecutionFailure("isolated_framework_drift", "readback");
          }
        }
        await verifyHostSources();
      } catch (error) {
        blocked = true;
        await jsonFile(join(directory, "failure.json"), { name: error?.name, message: String(error?.message ?? error).slice(0, 1024),
          phase: error instanceof ExecutionFailure ? error.phase : "unknown" }).catch(() => {});
        outcome = { status: "BLOCKED", code: error instanceof ExecutionFailure ? error.code : "isolated_runtime_failed",
          phase: error instanceof ExecutionFailure ? error.phase : "unknown" };
      } finally {
        for (const tracked of containers) {
          try {
            const probe = await command(clientRoot, ["inspect", tracked.name]);
            if (probe.exitCode !== 0) { blocked = true; continue; }
            let container = JSON.parse(probe.stdout.toString("utf8"))[0];
            if (container.Config.Labels?.["com.ekop.discovery.execution"] !== id) { blocked = true; continue; }
            if (container.State.Running) {
              const stopped = await command(clientRoot, ["stop", "--time", "2", container.Id]);
              if (stopped.exitCode !== 0) { blocked = true; continue; }
              const readback = await command(clientRoot, ["inspect", container.Id]);
              if (readback.exitCode !== 0) { blocked = true; continue; }
              container = JSON.parse(readback.stdout.toString("utf8"))[0];
            }
            tracked.finalState = { id: container.Id, status: container.State.Status, pid: container.State.Pid,
              exitCode: container.State.ExitCode, oomKilled: container.State.OOMKilled, startedAt: container.State.StartedAt, finishedAt: container.State.FinishedAt };
            if (container.State.Pid !== 0 || container.State.Running) { blocked = true; continue; }
            const removed = await command(clientRoot, ["rm", container.Id]);
            tracked.removalExitCode = removed.exitCode;
            tracked.removed = removed.exitCode === 0;
            if (!tracked.removed) blocked = true;
          } catch { blocked = true; }
        }
        active = false;
      }
      if (blocked) outcome = { ...outcome, status: "BLOCKED", code: outcome?.code ?? "isolated_cleanup_incomplete" };
      const receipt = { ...outcome, executionId: id, candidateDigest: digest, image, phases, containers,
        hostSourceDigests: HOST_DIGESTS, nodeVersion: process.version, sourceSnapshotOnly: true,
        stageDigest: HASH(JSON.stringify(Object.fromEntries(Object.entries(stageDigests).sort()))),
        activationAuthorized: false, publicationAuthorized: false };
      await jsonFile(join(directory, "result.json"), receipt);
      return receipt;
    },
  };
}

import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { createAgentGateway } from "./gateway.mjs";
import { createIdentityVerifier } from "./datahub-identity.mjs";
import { createRuntimeManager } from "./runtime-manager.mjs";
import { validateEgressOrigins } from "./egress-proxy.mjs";
import { ingestionPolicies } from "./ingestion-policy.mjs";
import { nativeIngestion } from "./native-ingestion.mjs";
import { SemanticError } from "./native-semantic.mjs";
import { semanticHost } from "./native-semantic-tasks.mjs";
import { nativeTasks } from "./native-tasks.mjs";
import { fixedEtlPolicies } from "./native-fixed-etl.mjs";
import {
  discoveryPolicies,
  nativeDiscovery,
  prepareWorkspaceImport,
  workspaceImportCompiler,
  DiscoveryError,
} from "./native-discovery.mjs";
import { taskRuntime } from "./task-runtime.mjs";

const fields = new Set([
  "scope",
  "runtimeImageId",
  "gatewayOrigin",
  "datahubOrigin",
  "tenant",
  "browserAssetsDirectory",
  "memoryMiB",
  "cpus",
  "maxRuntimes",
  "egressOriginsByActor",
  "ingestionSourcesByActor",
  "discoverySourcesByActor",
  "fixedEtlGrantsByActor",
]);

/** Local-only entrypoint. Config is operator-owned, never supplied by a browser.
 * The standalone manager has no simulated identity or credential-discovery path. */
export async function startAgentServer(config) {
  if (
    !config ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    Object.keys(config).some((key) => !fields.has(key)) ||
    typeof config.browserAssetsDirectory !== "string" ||
    !config.browserAssetsDirectory
  ) {
    throw new Error("invalid_agent_server_configuration");
  }
  const policies =
    config.egressOriginsByActor === undefined
      ? {}
      : config.egressOriginsByActor;
  if (!policies || typeof policies !== "object" || Array.isArray(policies))
    throw new Error("invalid_agent_server_configuration");
  const actorOrigins = new Map();
  for (const [key, origins] of Object.entries(policies)) {
    if (!/^[a-f0-9]{48}$/.test(key))
      throw new Error("invalid_agent_server_configuration");
    validateEgressOrigins(origins);
    actorOrigins.set(key, [...origins]);
  }
  const sourcePolicies = ingestionPolicies(config.ingestionSourcesByActor);
  const executionPolicies = fixedEtlPolicies(
    config.fixedEtlGrantsByActor,
    sourcePolicies,
  );
  const discoveryScopes = discoveryPolicies(config.discoverySourcesByActor);
  const analysisActive = new Set();
  async function analyzeBounded(actor, exhausted, operation) {
    if (analysisActive.has(actor.key) || analysisActive.size >= 2) throw exhausted;
    analysisActive.add(actor.key);
    try { return await operation(); } finally { analysisActive.delete(actor.key); }
  }
  let gatewayOrigin;
  try {
    gatewayOrigin = new URL(config.gatewayOrigin);
  } catch {
    throw new Error("local_agent_origin_required");
  }
  if (
    gatewayOrigin.protocol !== "http:" ||
    gatewayOrigin.hostname !== "localhost" ||
    !gatewayOrigin.port ||
    gatewayOrigin.username ||
    gatewayOrigin.password ||
    gatewayOrigin.pathname !== "/" ||
    gatewayOrigin.search ||
    gatewayOrigin.hash
  ) {
    throw new Error("local_agent_origin_required");
  }
  // Prevent accidental proxying of DataHub's human session cookie through a
  // developer proxy environment. Runtime model traffic uses its separate proxy.
  if (
    [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
    ].some((key) => process.env[key])
  ) {
    throw new Error("agent_control_plane_requires_clean_proxy_environment");
  }
  const verifyIdentity = createIdentityVerifier({
    frontendOrigin: config.datahubOrigin,
    tenant: config.tenant,
  });
  let manager, server;
  let closing;
  const close = () => {
    if (!closing)
      closing = (async () => {
        if (server) {
          server.closeAllConnections();
          await new Promise((done) => server.close(done));
        }
        await manager?.close();
      })();
    return closing;
  };
  try {
    manager = await createRuntimeManager({
      scope: config.scope,
      imageId: config.runtimeImageId,
      memoryMiB: config.memoryMiB,
      cpus: config.cpus,
      maxRuntimes: config.maxRuntimes,
    });
    server = await createAgentGateway({
      gatewayOrigin: config.gatewayOrigin,
      datahubOrigin: config.datahubOrigin,
      verifyIdentity,
      runtimeForActor: async (actor) => {
        const runtime = await manager.forActor(actor);
        manager.setAllowedOrigins(actor, actorOrigins.get(actor.key) ?? []);
        return runtime;
      },
      ingestionRequest: (text, context) =>
        nativeIngestion(text, {
          ...context,
          sources: sourcePolicies.get(context.actor.key) ?? [],
          frontendOrigin: config.datahubOrigin,
        }),
      semanticRequest: (text, context) =>
        analyzeBounded(context.actor, new SemanticError("semantic_capacity_exhausted", 429), () => semanticHost(text, {
          ...context,
          runtime: { state: async (sessionId) => taskRuntime(await context.getRuntime(), context.assertActive).state(sessionId) },
          sources: sourcePolicies.get(context.actor.key) ?? [],
          frontendOrigin: config.datahubOrigin,
        })),
      discoveryRequest: (text, context) =>
        // One shared parser pool covers Discovery, Semantic and workspace import.
        // Runtime and SQL concurrency remain independently controlled.
        analyzeBounded(context.actor, new DiscoveryError("discovery_capacity_exhausted", 429), () => nativeDiscovery(text, {
          actor: context.actor,
          assertActive: context.assertActive,
          sources: discoveryScopes.get(context.actor.key) ?? [],
          frontendOrigin: config.datahubOrigin,
          cookieHeader: context.cookieHeader,
        })),
      taskRequest: async (text, context) => {
        const compiling = [
          "prepare_workspace_import",
          "respond_workspace_import",
        ].includes(JSON.parse(text)?.action);
        if (compiling) {
          if (
            analysisActive.has(context.actor.key) ||
            analysisActive.size >= 2
          )
            throw new DiscoveryError("discovery_capacity_exhausted", 429);
          analysisActive.add(context.actor.key);
        }
        try {
          const host = {
            ...context,
            ...executionPolicies.get(context.actor.key),
            sources: sourcePolicies.get(context.actor.key) ?? [],
            discoverySources: discoveryScopes.get(context.actor.key) ?? [],
            frontendOrigin: config.datahubOrigin,
            runtime: taskRuntime(context.runtime, context.assertActive),
          };
          return await nativeTasks(text, {
            ...host,
            prepareWorkspaceImport: (input) =>
              prepareWorkspaceImport(input, host),
            workspaceImportCompiler: (input, source) =>
              workspaceImportCompiler(input, source, host),
          });
        } finally {
          if (compiling) analysisActive.delete(context.actor.key);
        }
      },
      browserAssetsDirectory: config.browserAssetsDirectory,
      mfeDirectory: fileURLToPath(new URL("../mfe/dist/", import.meta.url)),
    });
    server.listen(Number(gatewayOrigin.port), "127.0.0.1");
    await once(server, "listening");
    return { server, close };
  } catch (error) {
    await close();
    throw error;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv.length !== 3)
      throw new Error("agent_configuration_file_required");
    const path = resolve(process.argv[2]);
    const config = JSON.parse(await readFile(path, "utf8"));
    if (typeof config.browserAssetsDirectory === "string")
      config.browserAssetsDirectory = resolve(
        dirname(path),
        config.browserAssetsDirectory,
      );
    const running = await startAgentServer(config);
    console.log(
      `DataHub Agent gateway ready on localhost:${running.server.address().port}`,
    );
    for (const signal of ["SIGINT", "SIGTERM"])
      process.once(signal, () => {
        running.close().catch(() => {
          console.error("agent_cleanup_required");
          process.exitCode = 1;
        });
      });
  } catch {
    // Do not echo malformed configuration, Docker argv or human credentials.
    console.error(
      "agent_start_failed; check configuration, image and owned runtime recovery state",
    );
    process.exitCode = 1;
  }
}

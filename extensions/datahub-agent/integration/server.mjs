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
import {
  nativeCatalog,
  CatalogError,
  catalogPolicies,
} from "./native-catalog.mjs";
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
import { createSqlHost, sqlPolicies } from "./native-sql.mjs";
import { createGrafanaHost, grafanaPolicies } from "./native-grafana.mjs";
import { sqlAssetAuthorizer } from "./native-sql-assets.mjs";
import {
  createSalesSourceExecutor,
  protectedSalesPassword,
} from "./sales-sql-runner.mjs";

const fields = new Set([
  "scope",
  "readOnlyCore",
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
  "pluginDevelopmentByActor",
  "pluginActivationsByActor",
  "fixedEtlGrantsByActor",
  "catalogReadByActor",
  "sqlSourceOnlyGrantsByActor",
  "sqlPasswordPath",
  "grafanaDisplaysByActor",
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
  if (config.readOnlyCore !== undefined && typeof config.readOnlyCore !== "boolean")
    throw new Error("invalid_read_only_core_configuration");
  if (config.readOnlyCore && [
    "ingestionSourcesByActor", "fixedEtlGrantsByActor", "sqlSourceOnlyGrantsByActor",
    "sqlPasswordPath", "grafanaDisplaysByActor", "grafanaServiceKeyPath",
    "queryConnections", "queryGrafana",
  ].some(name => config[name] !== undefined))
    throw new Error("read_only_core_configuration_conflict");
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
  const catalogScopes = catalogPolicies(config.catalogReadByActor);
  const sourcePolicies = ingestionPolicies(config.ingestionSourcesByActor);
  const executionPolicies = fixedEtlPolicies(
    config.fixedEtlGrantsByActor,
    sourcePolicies,
  );
  const discoveryScopes = discoveryPolicies(config.discoverySourcesByActor);
  const pluginScopes = new Map();
  const development = config.pluginDevelopmentByActor === undefined ? {} : config.pluginDevelopmentByActor;
  if (!development || typeof development !== "object" || Array.isArray(development)) throw new Error("invalid_plugin_development_configuration");
  if (Object.keys(development).length) {
    const { createPluginDevelopment } = await import("./plugin-development.mjs");
    for (const [key, policy] of Object.entries(development)) {
      if (!/^[a-f0-9]{48}$/.test(key) || !policy || typeof policy !== "object" || Array.isArray(policy) ||
          Object.keys(policy).some(name => !["referenceSourceId", "image", "evidenceRoot"].includes(name)) ||
          !(discoveryScopes.get(key) ?? []).some(source => source.sourceId === policy.referenceSourceId && source.workspace && source.modelContextApproved)) {
        throw new Error("invalid_plugin_development_configuration");
      }
      pluginScopes.set(key, createPluginDevelopment({ ...policy, actors: [{ tenant: config.tenant, key }] }));
    }
  }
  const activationScopes = new Map();
  if (config.pluginActivationsByActor !== undefined) {
    const { pluginActivationPolicies, createPluginActivations } = await import("./plugin-activation.mjs");
    for (const [key, entries] of pluginActivationPolicies(config.pluginActivationsByActor, development, discoveryScopes)) {
      const policy = development[key];
      activationScopes.set(key, createPluginActivations({ actor: { tenant: config.tenant, key }, entries,
        development: pluginScopes.get(key), evidenceRoot: policy.evidenceRoot, image: policy.image }));
    }
  }
  const sqlScopes = sqlPolicies(config.sqlSourceOnlyGrantsByActor, {
    sourceOnly: true,
  });
  if (sqlScopes.size > 0 !== (config.sqlPasswordPath !== undefined))
    throw new Error("invalid_agent_server_configuration");
  const sqlHost =
    sqlScopes.size > 0
      ? createSqlHost({
          policies: sqlScopes,
          sourceOnly: true,
          authorizeAssets: sqlAssetAuthorizer({
            frontendOrigin: config.datahubOrigin,
          }),
          executeSource: createSalesSourceExecutor({
            getPassword: protectedSalesPassword(config.sqlPasswordPath),
          }),
        })
      : null;
  const analysisActive = new Set();
  async function analyzeBounded(actor, exhausted, operation) {
    if (analysisActive.has(actor.key) || analysisActive.size >= 2)
      throw exhausted;
    analysisActive.add(actor.key);
    try {
      return await operation();
    } finally {
      analysisActive.delete(actor.key);
    }
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
  const grafanaScopes = grafanaPolicies(config.grafanaDisplaysByActor, {
    datahubOrigin: config.datahubOrigin,
  });
  for (const [actorKey, display] of grafanaScopes) {
    const source = sqlScopes.get(actorKey);
    if (
      !sqlHost ||
      !source ||
      source.datasetUrn !== display.datasetUrn ||
      source.expiresAt < display.expiresAt ||
      source.maxExecutions !== 1 ||
      !catalogScopes.has(actorKey)
    )
      throw new Error("invalid_grafana_policy");
  }
  const grafanaHost = grafanaScopes.size
    ? createGrafanaHost({
        policies: grafanaScopes,
        readSqlResult: (text, context) =>
          sqlHost.readResult(text, context, { includeInternalExpiry: true }),
        verifyIdentity,
      })
    : null;
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
      pluginDevelopmentActors: [...pluginScopes.keys()],
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
      grafanaRequest: grafanaHost ? grafanaHost.request : undefined,
      grafanaData: grafanaHost ? grafanaHost.read : undefined,
      grafanaOriginByActor: new Map(
        [...grafanaScopes].map(([actorKey, display]) => [
          actorKey,
          display.grafanaOrigin,
        ]),
      ),
      sqlRequest: sqlHost
        ? (text, context) => sqlHost.execute(text, context)
        : undefined,
      sqlResultRequest: sqlHost
        ? (text, context) => sqlHost.readResult(text, context)
        : undefined,
      catalogRequest: (text, context) => {
        const policy = catalogScopes.get(context.actor.key);
        if (!policy) throw new CatalogError("catalog_not_configured", 403);
        return nativeCatalog(text, {
          ...context,
          propertyNames: policy.propertyNames,
          frontendOrigin: config.datahubOrigin,
        });
      },
      ingestionRequest: config.readOnlyCore ? undefined : (text, context) =>
        nativeIngestion(text, {
          ...context,
          sources: sourcePolicies.get(context.actor.key) ?? [],
          frontendOrigin: config.datahubOrigin,
        }),
      semanticRequest: config.readOnlyCore ? undefined : (text, context) =>
        analyzeBounded(
          context.actor,
          new SemanticError("semantic_capacity_exhausted", 429),
          () =>
            semanticHost(text, {
              ...context,
              runtime: {
                state: async (sessionId) =>
                  taskRuntime(
                    await context.getRuntime(),
                    context.assertActive,
                  ).state(sessionId),
              },
              sources: sourcePolicies.get(context.actor.key) ?? [],
              frontendOrigin: config.datahubOrigin,
            }),
        ),
      discoveryRequest: (text, context) =>
        // One shared parser pool covers Discovery, Semantic and workspace import.
        // Runtime and SQL concurrency remain independently controlled.
        analyzeBounded(
          context.actor,
          new DiscoveryError("discovery_capacity_exhausted", 429),
          () =>
            nativeDiscovery(text, {
              actor: context.actor,
              assertActive: context.assertActive,
              signal: context.signal,
              pluginDevelopment: pluginScopes.get(context.actor.key),
              pluginActivations: activationScopes.get(context.actor.key),
              sources: discoveryScopes.get(context.actor.key) ?? [],
              frontendOrigin: config.datahubOrigin,
              cookieHeader: context.cookieHeader,
            }),
        ),
      taskRequest: config.readOnlyCore ? undefined : async (text, context) => {
        const compiling = [
          "prepare_workspace_import",
          "respond_workspace_import",
        ].includes(JSON.parse(text)?.action);
        if (compiling) {
          if (analysisActive.has(context.actor.key) || analysisActive.size >= 2)
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

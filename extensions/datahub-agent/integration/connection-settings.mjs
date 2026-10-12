import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isIP } from "node:net";
import { queryBindings, readQuerySecret, runQueryChild } from "./query-source.mjs";
import { queryMetadataReader, exactKeys, rejectQuery } from "./query-metadata.mjs";
import { semanticNativeClient } from "./semantic-native-client.mjs";
const systemCa = "/etc/ssl/certs/ca-certificates.crt";
const requireValue = (ok, code, status = 409) => { if (!ok) rejectQuery(`query_settings_${code}`, status); };
const validId = (id) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id);
const locator = (b) => JSON.stringify([b.tenant, b.platform, b.platformInstanceUrn, b.environment, b.database, b.datasetPrefix]);
function publicBinding(b) {
  return { id: b.id, platform: b.platform, database: b.database, environment: b.environment,
    platformInstanceUrn: b.platformInstanceUrn, datasetPrefix: b.datasetPrefix, enabled: b.enabled !== false };
}
function safeConnection(c) {
  return { host: c.host, port: c.port, username: c.username, database: c.database,
    tls: c.cafile ? "verified" : "plaintext", passwordConfigured: true };
}
function validateConnection(input, prior, database) {
  requireValue(exactKeys(input, ["host", "port", "username", "database", "tls"], ["password"]), "invalid_connection", 400);
  requireValue(typeof input.host === "string" && input.host.length <= 253 &&
    (isIP(input.host) || /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(input.host)) &&
    Number.isSafeInteger(input.port) && input.port >= 1 && input.port <= 65535 &&
    ["username", "database"].every((k) => typeof input[k] === "string" && input[k].length > 0 && input[k].length <= 128 && !/[\x00-\x1f]/.test(input[k])) &&
    typeof database === "string" && input.database.toLowerCase() === database.toLowerCase() &&
    ["system", "plaintext", "retain"].includes(input.tls), "invalid_connection", 400);
  const password = input.password === undefined || input.password === "" ? prior?.password : input.password;
  requireValue(typeof password === "string" && password.length > 0 && password.length <= 2048 && !password.includes("\0"), "password_required", 400);
  requireValue(input.tls !== "retain" || !!prior, "invalid_connection", 400);
  const cafile = input.tls === "system" ? systemCa : input.tls === "retain" ? prior?.cafile : undefined;
  return { host: input.host, port: input.port, username: input.username, password, database: input.database,
    ...(cafile ? { cafile } : {}) };
}

/** Admin-only query infrastructure, not an agent tool or per-user SQL grant.
 * Passwords reach only this Host from the trusted parent dialog, never Pi. */
export function createConnectionSettingsHost({ store, frontendOrigin, tenant, fetchImpl = fetch,
  readMetadata = queryMetadataReader({ frontendOrigin, fetchImpl }), run = runQueryChild }) {
  let testing = false;
  async function secretFile(connection) {
    const directory = join(dirname(store.path), "query-credentials");
    await mkdir(directory, { mode: 0o700 }).catch((e) => { if (e.code !== "EEXIST") throw e; });
    const info = await lstat(directory);
    requireValue(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid() && !(info.mode & 0o077), "secret_directory_unprotected");
    const path = join(directory, `${randomUUID()}.json`), file = await open(path, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(connection) + "\n"); await file.sync(); } finally { await file.close(); }
    const dir = await open(directory, constants.O_RDONLY);
    try { await dir.sync(); } finally { await dir.close(); }
    return path;
  }
  return async (text, context) => {
    let input;
    try { requireValue(typeof text === "string" && Buffer.byteLength(text) <= 16384, "invalid_request", 400); input = JSON.parse(text); }
    catch { rejectQuery("query_settings_invalid_request", 400); }
    const keys = {
      list: ["action"], search: ["action", "query"], inspect: ["action", "id"],
      test: ["action", "revision", "id", "existing", "datasetUrn", "connection"],
      save: ["action", "revision", "id", "existing", "datasetUrn", "connection"],
      set_enabled: ["action", "revision", "id", "enabled"],
    };
    requireValue(input && Object.hasOwn(keys, input.action) && exactKeys(input, keys[input.action]), "invalid_request", 400);
    const client = semanticNativeClient({ ...context, frontendOrigin, fetchImpl });
    const authorize = async () => {
      context.assertActive();
      const authClient = semanticNativeClient({ ...context, frontendOrigin, fetchImpl });
      const me = (await authClient.call("/api/v2/graphql", { query: "query { me { corpUser { urn } platformPrivileges { manageIngestion managePolicies } } }" })).data?.me;
      requireValue(me?.corpUser?.urn === context.actor.urn && context.actor.tenant === tenant &&
        me.platformPrivileges?.manageIngestion === true && me.platformPrivileges?.managePolicies === true, "admin_required", 403);
      context.assertActive();
    };
    await authorize();
    const state = await store.current();
    requireValue(state.config.connectionSettingsEnabled === true && state.config.queryGrafana && !state.config.readOnlyCore, "not_enabled", 403);
    const entries = state.config.queryConnections ?? [];
    const base = { format: "datahub-connection-settings/1", revision: state.revision };
    if (input.action === "list") {
      await authorize();
      return { ...base, connections: entries.filter((b) => b.tenant === tenant).map(publicBinding) };
    }
    if (input.action === "search") {
      requireValue(typeof input.query === "string" && input.query.trim().length > 0 && input.query.length <= 100, "invalid_request", 400);
      const page = (await client.call("/api/v2/graphql", {
        query: "query($input:SearchInput!){search(input:$input){total searchResults{entity{urn ... on Dataset { name }}}}}",
        variables: { input: { type: "DATASET", query: input.query, start: 0, count: 20 } },
      })).data?.search;
      requireValue(Array.isArray(page?.searchResults), "metadata_unavailable");
      await authorize();
      return { ...base, datasets: page.searchResults.filter((hit) => /^urn:li:dataset:\(urn:li:dataPlatform:mssql,/.test(hit.entity?.urn ?? "")).map((hit) => ({ urn: hit.entity.urn, name: hit.entity.name ?? hit.entity.urn })), more: page.total > 20 };
    }
    requireValue(validId(input.id), "invalid_id", 400);
    const old = entries.find((b) => b.id === input.id);
    requireValue(!old || (old.tenant === tenant && old.platform === "mssql"), "connection_not_editable", 403);
    if (input.action === "inspect") {
      requireValue(old, "connection_not_found", 404);
      const connection = await readQuerySecret(old.connectionPath);
      await authorize();
      return { ...base, binding: publicBinding(old), connection: safeConnection(connection) };
    }
    requireValue(input.revision === state.revision, "version_conflict");
    if (input.action === "set_enabled") {
      requireValue(old && typeof input.enabled === "boolean", "invalid_request", 400);
      requireValue(!input.enabled || !entries.some((b) => b.id !== old.id && b.enabled !== false && locator(b) === locator(old)), "duplicate_binding");
      const saved = await store.save(state.revision, (config) => ({ ...config,
        queryConnections: config.queryConnections.map((b) => b.id === old.id ? { ...b, enabled: input.enabled } : b) }), authorize);
      return { ...base, ...saved, status: "SAVED_AND_ACTIVE", binding: { ...publicBinding(old), enabled: input.enabled } };
    }
    requireValue(typeof input.existing === "boolean" && input.existing === !!old, "connection_identity_conflict");
    requireValue(typeof input.datasetUrn === "string" && (old || input.datasetUrn.length > 0), "dataset_required", 400);
    let binding;
    if (input.datasetUrn) {
      const { snapshots } = await readMetadata([input.datasetUrn], context), s = snapshots[0];
      requireValue(s?.platform === "mssql" && s.platformInstanceUrn === null && s.qualifiedName.split(".").length >= 3, "metadata_unsupported", 422);
      binding = { id: input.id, tenant, platform: "mssql", platformInstanceUrn: null,
        environment: s.environment, database: s.qualifiedName.split(".")[0], datasetPrefix: "" };
    } else {
      binding = { ...old }; delete binding.connectionPath; delete binding.enabled;
    }
    requireValue(!entries.some((b) => b.id !== binding.id && b.enabled !== false && locator(b) === locator(binding)), "duplicate_binding");
    const priorSecret = old ? await readQuerySecret(old.connectionPath) : undefined;
    const connection = validateConnection(input.connection, priorSecret, binding.database);
    if (input.action === "test") {
      requireValue(!testing, "test_busy", 429); testing = true;
      try {
        await authorize();
        const result = await run({ operation: "test_connection", connection }, context);
        await authorize();
        requireValue((await store.current()).revision === state.revision, "version_conflict");
        requireValue(result?.status === "CONNECTED" && result.selectPermissionsVerified === false, "test_unconfirmed");
        return { ...base, status: "CONNECTED", selectPermissionsVerified: false };
      } finally { testing = false; }
    }
    // Immutable secret then atomic config pointer: old/in-flight queries never read
    // partially replaced credentials. Unreferenced protected files are retained on
    // uncertain save, not deleted in a way that could break a committed pointer.
    const saved = await store.save(state.revision, async (config) => {
      const entry = { ...binding, enabled: old?.enabled !== false, connectionPath: await secretFile(connection) };
      queryBindings([entry]);
      return { ...config, queryConnections: old ? config.queryConnections.map((b) => b.id === old.id ? entry : b) : [...(config.queryConnections ?? []), entry] };
    }, authorize);
    return { ...base, ...saved, status: "SAVED_AND_ACTIVE", binding: { ...binding, enabled: old?.enabled !== false } };
  };
}

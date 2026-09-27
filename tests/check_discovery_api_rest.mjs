/** Operator-run read-only compatibility probe through an ALREADY authenticated
 * browser. No credential extraction, model prompt, candidate execution, service
 * changes, metadata writes, broad scan, or generated API client.
 * node tests/check_discovery_api_rest.mjs CDP_CONTROL_JSON NEW_EVIDENCE_DIRECTORY
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const origin = "http://localhost:9002";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const ref = name => `#/components/schemas/${name}`;
const properties = schema => Object.assign({}, schema?.properties,
  ...(schema?.allOf ?? []).map(part => part.properties ?? {}));

/** Selected public contract checks, NOT a general OpenAPI/JSON-Schema validator. */
export function checkApiContract(spec) {
  assert.match(spec.openapi, /^3\./);
  const schemas = spec.components.schemas;
  const read = spec.paths["/openapi/v2/entity/api/{urn}"].get;
  const scroll = spec.paths["/openapi/v2/entity/api"].get;
  const head = spec.paths["/openapi/v2/entity/api/{urn}"].head;
  assert(head.responses["204"] && head.responses["404"]);
  assert.equal(read.responses["200"].content["application/json"].schema.$ref, ref("ApiEntityResponseV2"));
  assert(read.responses["404"]);
  assert.equal(scroll.responses["200"].content["application/json"].schema.$ref, ref("ScrollApiEntityResponseV2"));
  for (const name of ["apiProperties", "apiSignature", "restApiProperties"]) {
    assert(read.parameters.find(p => p.name === "aspects").schema.enum.includes(name));
  }
  const entity = properties(schemas.ApiEntityResponseV2);
  assert.equal(entity.apiSignature.$ref, ref("ApiSignatureAspectResponseV2"));
  assert.equal(properties(schemas.ApiSignatureAspectResponseV2).value.$ref, ref("ApiSignature"));
  const signature = properties(schemas.ApiSignature);
  for (const side of ["inputFields", "outputFields"]) {
    assert.equal(signature[side].type, "array");
    assert.equal(signature[side].items.$ref, ref("SchemaField"));
  }
  assert.equal(signature.schemaDefinition.type, "string");
  const rest = properties(schemas.RestApiProperties);
  assert.equal(rest.path.type, "string");
  assert(rest.method.enum.includes("POST") && rest.method.enum.includes("PUT"));
  assert.equal(properties(schemas.ApiKey).id.type, "string");
  return { nativeEntity: "api", readPath: "/openapi/v2/entity/api/{urn}",
    keyField: "id", separateInputOutputFields: true, methodAndPath: true,
    originalSchemaDefinition: true, contractOnly: true, publicationAuthorized: false };
}

export function summarizeApiReads(observations) {
  const denied = observations.some(v => [401, 403].includes(v.status));
  const runtimeFailure = observations.some(v => v.status >= 500 || v.error);
  if (denied || runtimeFailure) return { status: "BLOCKED", reason: denied ? "read_denied" : "read_unavailable", entityReadbackVerified: false, publicationVerified: false };
  const missing = observations.find(v => v.key === "missing-api");
  const head = observations.find(v => v.key === "missing-api-head");
  const search = observations.find(v => v.key === "exact-reference-search");
  // v2 GET asks EntityService for alwaysIncludeKeyAspect=true; a missing URN
  // can return a synthesized key with 200. Only the dedicated HEAD tests
  // existence. Never treat a synthesized key as stored metadata/readback.
  const expectedUrn = missing?.expectedUrn;
  const keyOnly = typeof expectedUrn === "string" && expectedUrn.startsWith("urn:li:api:") &&
    missing?.status === 200 && missing.body?.urn === expectedUrn &&
    Object.keys(missing.body).sort().join(",") === "apiKey,urn" &&
    missing.body.apiKey?.value?.__type === "ApiKey" &&
    missing.body.apiKey.value.id === expectedUrn.slice("urn:li:api:".length);
  if (typeof expectedUrn !== "string" || !expectedUrn.startsWith("urn:li:api:") ||
      head?.status !== 404 || head.expectedUrn !== expectedUrn ||
      !(missing?.status === 404 || keyOnly) || search?.status !== 200 || !Array.isArray(search.body?.entities)) {
    return { status: "INCONCLUSIVE", reason: "unexpected_read_response", entityReadbackVerified: false, publicationVerified: false };
  }
  // Search hits alone never count as an exact entity/aspect GET readback.
  return { status: "READ_ONLY_ROUTE_PROBES_PASS", missingEntityStatus: head.status,
    missingGetBehavior: keyOnly ? "200_synthesized_key_not_existence" : "404_not_found",
    visibleSearchResults: search.body.entities.length, paginationFollowed: false,
    globalAbsenceProven: false, entityReadbackVerified: false,
    publicationVerified: false, publicationAuthorized: false };
}

async function main() {
  const [controlArg, outputArg] = process.argv.slice(2);
  assert(controlArg && outputArg, "CDP_CONTROL_JSON NEW_EVIDENCE_DIRECTORY required");
  const directory = resolve(outputArg);
  await mkdir(directory, { mode: 0o700 }); // Exclusive run directory: never replay unknown intents.
  const save = (name, value) => writeFile(resolve(directory, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  const control = JSON.parse(await readFile(resolve(controlArg), "utf8"));
  assert(Number.isInteger(control.port) && control.port > 0 && control.port <= 65535);
  const require = createRequire(new URL("../extensions/datahub-agent/pi-web/package.json", import.meta.url));
  const { chromium } = require("playwright");
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${control.port}`);
  const observations = [];
  try {
    const page = browser.contexts()[0].pages().find(p => p.url().startsWith(origin + "/"));
    assert(page, "existing_authenticated_datahub_page_required");
    // The browser supplies its own session; no headers/cookies/storage are read.
    const identity = await page.evaluate(async () => {
      const r = await fetch("/api/v2/graphql", { method: "POST", redirect: "error", signal: AbortSignal.timeout(20000),
        headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "query DiscoveryRestIdentity { me { corpUser { urn } } }" }) });
      return { status: r.status, body: await r.json() };
    });
    await save("identity.json", identity);
    assert.equal(identity.status, 200); assert(!identity.body.errors);
    assert.equal(identity.body.data.me.corpUser.urn, "urn:li:corpuser:datahub");
    const missingUrn = "urn:li:api:discovery-readonly-probe-" + randomUUID();
    const search = new URLSearchParams({ query: '"datahub_usage_events"', count: "1", aspects: "apiProperties,apiSignature,restApiProperties" });
    const probes = [
      { key: "openapi", path: "/openapi/v3/api-docs", maximum: 4 * 1024 * 1024 },
      { key: "api-registry", path: "/openapi/v1/registry/models/entity/specifications/api", maximum: 2 * 1024 * 1024 },
      { key: "exact-reference-search", path: "/openapi/v2/entity/api?" + search, maximum: 262144 },
      { key: "missing-api", path: "/openapi/v2/entity/api/" + encodeURIComponent(missingUrn) + "?aspects=apiProperties,apiSignature,restApiProperties", maximum: 65536, expectedUrn: missingUrn },
      { key: "missing-api-head", path: "/openapi/v2/entity/api/" + encodeURIComponent(missingUrn), method: "HEAD", maximum: 0, expectedUrn: missingUrn },
    ];
    let contract;
    for (const probe of probes) {
      const method = probe.method ?? "GET";
      await save(probe.key + "-intent.json", { ...probe, method, observedAt: new Date().toISOString() });
      const response = await page.evaluate(async ({ path, maximum, method }) => {
        const r = await fetch(path, { method, redirect: "error", signal: AbortSignal.timeout(20000) });
        if (method === "HEAD") return { status: r.status, contentType: null, text: "" };
        const reader = r.body.getReader(); const chunks = []; let length = 0;
        try { while (true) { const { done, value } = await reader.read(); if (done) break; length += value.length;
          if (length > maximum) throw new Error("response_too_large"); chunks.push(value); } }
        finally { await reader.cancel(); }
        const bytes = new Uint8Array(length); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        return { status: r.status, contentType: r.headers.get("content-type"), text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
      }, { ...probe, method });
      await writeFile(resolve(directory, probe.key + ".body"), response.text, { flag: "wx", mode: 0o600 });
      const value = { key: probe.key, expectedUrn: probe.expectedUrn, status: response.status, contentType: response.contentType, sha256: hash(response.text), observedAt: new Date().toISOString() };
      let body; try { body = JSON.parse(response.text); } catch { /* classify without changing raw response */ }
      observations.push({ ...value, body }); await save(probe.key + ".json", value);
      if ([401, 403].includes(response.status) || response.status >= 500) break;
      if (probe.key === "openapi") { assert.equal(response.status, 200); contract = checkApiContract(body); }
      if (probe.key === "api-registry") {
        assert.equal(response.status, 200); assert.equal(body.name, "api");
        const aspects = body.aspectSpecs.map(a => a.aspectAnnotation.name);
        for (const name of ["apiKey", "apiProperties", "apiSignature", "restApiProperties"]) assert(aspects.includes(name));
      }
    }
    const report = { ...summarizeApiReads(observations), contract, observedAt: new Date().toISOString(),
      sourceSha256: hash(await readFile(fileURLToPath(import.meta.url))),
      observations: observations.map(({ body, ...metadata }) => metadata),
      modelRun: false, candidateRun: false, metadataWritten: false, credentialsExtracted: false,
      scope: "Authenticated public REST contract/registry + bounded exact-reference search and random non-existent entity GET/HEAD. No positive entity read/write/ACL matrix acceptance." };
    await save("report.json", report); console.log(JSON.stringify(report));
    if (report.status !== "READ_ONLY_ROUTE_PROBES_PASS") process.exitCode = 1;
  } catch (error) {
    await save("error.json", { error: String(error?.stack ?? error), observedKeys: observations.map(o => o.key), effectReconciliationRequired: true });
    throw error;
  } finally { await browser.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();

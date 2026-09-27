// Synthetic contract/status unit tests. These are not live REST/ACL evidence.
import assert from "node:assert/strict";
import test from "node:test";
import { checkApiContract, summarizeApiReads } from "./check_discovery_api_rest.mjs";

function specification() {
  const ref = name => ({ $ref: "#/components/schemas/" + name });
  return { openapi: "3.0.1", paths: {
    "/openapi/v2/entity/api/{urn}": { head: { responses: { "204": {}, "404": {} } }, get: { parameters: [{ name: "aspects", schema: { enum: ["apiProperties", "apiSignature", "restApiProperties"] } }],
      responses: { "200": { content: { "application/json": { schema: ref("ApiEntityResponseV2") } } }, "404": {} } } },
    "/openapi/v2/entity/api": { get: { responses: { "200": { content: { "application/json": { schema: ref("ScrollApiEntityResponseV2") } } } } } },
  }, components: { schemas: {
    ApiEntityResponseV2: { properties: { apiSignature: ref("ApiSignatureAspectResponseV2") } },
    ApiSignatureAspectResponseV2: { properties: { value: ref("ApiSignature") } },
    ApiSignature: { allOf: [{ properties: { inputFields: { type: "array", items: ref("SchemaField") },
      outputFields: { type: "array", items: ref("SchemaField") }, schemaDefinition: { type: "string" } } }] },
    RestApiProperties: { properties: { path: { type: "string" }, method: { enum: ["POST", "PUT"] } } },
    ApiKey: { properties: { id: { type: "string" } } },
  } } };
}

test("selected native model preserves separate directions and method/path declarations", () => {
  const result = checkApiContract(specification());
  assert.equal(result.separateInputOutputFields, true);
  assert.equal(result.methodAndPath, true);
  assert.equal(result.contractOnly, true);
  assert.equal(result.publicationAuthorized, false);
});
test("missing REST route or direction cannot be accepted from datamodel names alone", () => {
  const noRoute = specification(); delete noRoute.paths["/openapi/v2/entity/api/{urn}"].get;
  assert.throws(() => checkApiContract(noRoute));
  const noOutput = specification(); delete noOutput.components.schemas.ApiSignature.allOf[0].properties.outputFields;
  assert.throws(() => checkApiContract(noOutput));
});
test("unsupported references are rejected, never fetched", () => {
  const remote = specification();
  remote.components.schemas.ApiSignature.allOf[0].properties.inputFields.items.$ref = "https://example.invalid/schema";
  assert.throws(() => checkApiContract(remote));
});
const expectedUrn = "urn:li:api:fixture-missing";
const missingReads = () => [{ key: "missing-api", status: 404, expectedUrn }, { key: "missing-api-head", status: 404, expectedUrn }];

test("empty search plus expected missing-entity 404 proves routes, not data/ACL/publication", () => {
  const result = summarizeApiReads([{ key: "exact-reference-search", status: 200, body: { entities: [] } }, ...missingReads()]);
  assert.equal(result.status, "READ_ONLY_ROUTE_PROBES_PASS");
  assert.equal(result.entityReadbackVerified, false);
  assert.equal(result.publicationVerified, false);
  assert.equal(result.globalAbsenceProven, false);
});
test("search matches alone are not exact entity/aspect readback", () => {
  const result = summarizeApiReads([{ key: "exact-reference-search", status: 200, body: { entities: [{ urn: "urn:li:api:fixture" }] } }, ...missingReads()]);
  assert.equal(result.visibleSearchResults, 1); assert.equal(result.entityReadbackVerified, false);
});
test("real observed v2 behavior: synthesized key plus independent HEAD404 is not stored metadata", () => {
  const observations = [{ key: "exact-reference-search", status: 200, body: { entities: [] } }, ...missingReads()];
  observations[1] = { key: "missing-api", status: 200, expectedUrn, body: { urn: expectedUrn, apiKey: { value: { __type: "ApiKey", id: "fixture-missing" } } } };
  const result = summarizeApiReads(observations);
  assert.equal(result.status, "READ_ONLY_ROUTE_PROBES_PASS");
  assert.equal(result.missingGetBehavior, "200_synthesized_key_not_existence");
  assert.equal(result.entityReadbackVerified, false);
  assert.equal(summarizeApiReads(observations.slice(0, 2)).status, "INCONCLUSIVE");
  observations[2].expectedUrn = "urn:li:api:different";
  assert.equal(summarizeApiReads(observations).status, "INCONCLUSIVE");
  observations[2].expectedUrn = expectedUrn; observations[2].status = 204;
  assert.equal(summarizeApiReads(observations).status, "INCONCLUSIVE");
  observations[2].status = 404;
  observations[1].body.apiSignature = { value: {} };
  assert.equal(summarizeApiReads(observations).status, "INCONCLUSIVE");
});

test("denial and runtime failure stay blocked; malformed/missing evidence stays inconclusive", () => {
  for (const status of [401, 403, 500, 502]) assert.equal(summarizeApiReads([{ key: "exact-reference-search", status }]).status, "BLOCKED");
  for (const observations of [[], [{ key: "exact-reference-search", status: 200, body: {} }], [{ key: "missing-api", status: 200 }]]) {
    assert.equal(summarizeApiReads(observations).status, "INCONCLUSIVE");
  }
});

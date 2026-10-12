/** Synthetic public API boundary for Catalog tests; never connects to a service. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { semanticPublicationFixture } from "./semantic-publication-fixture.mjs";
import { datasetUrn, sourceUrn, envelope } from "./semantic-fixture.mjs";
import { nativeSemantic } from "../../extensions/datahub-agent/integration/native-semantic.mjs";
import { catalogTypes, catalogContract } from "../../extensions/datahub-agent/integration/semantic-catalog-contract.mjs";

export const catalogEvidence = { reason: "Synthetic Catalog evidence; exact human review required", evidenceIds: ["asset:identity"] };
export function semanticCatalogFixture() {
  const f = semanticPublicationFixture();
  Object.assign(f.policy, { semanticCatalogUpdatesApproved: true, semanticDefinitionCreationApproved: true, semanticDefinitionUpdatesApproved: true, semanticCatalogAssets: [] });
  const assets = { dataset: datasetUrn };
  for (const [kind, type] of Object.entries(catalogTypes)) if (kind !== "dataset") {
    const urn = kind === "dataJob" ? "urn:li:dataJob:(urn:li:dataFlow:(fixture,flow,DEV),job)" : kind === "dataFlow" ? "urn:li:dataFlow:(fixture,flow,DEV)" : `urn:li:${kind}:fixture-asset`;
    assets[kind] = urn;
    f.policy.semanticCatalogAssets.push(urn);
    f.state.definitions[urn] = {
      [type.key]: envelope({ id: `fixture-${kind}` }), [type.info]: envelope({ name: `Fixture ${kind}`, description: "Source-owned description", unknown: "PRESERVE_NOT_FOR_MODEL" }),
      [type.editable]: envelope({ description: "Existing human description", unknown: { preserve: true } }),
      globalTags: envelope({ tags: [{ tag: "urn:li:tag:Existing", context: "keep this annotation" }], unknown: [1, 2] }),
      glossaryTerms: envelope({ terms: [{ urn: "urn:li:glossaryTerm:Order", context: "keep term annotation" }] }),
      domains: envelope({ domains: ["urn:li:domain:Sales"] }),
      structuredProperties: envelope({ properties: [] }), status: envelope({ removed: false }),
    };
  }
  f.state.definitions["urn:li:structuredProperty:priority"].propertyDefinition.value.entityTypes = [...Object.keys(catalogTypes), "schemaField"].map((kind) => `urn:li:entityType:datahub.${kind}`);
  const underlying = f.context.fetchImpl;
  f.context.fetchImpl = async (url, options) => {
    const input = options.body ? JSON.parse(options.body) : undefined;
    if (url.pathname === "/api/v2/graphql" && input.query.includes("getGrantedPrivileges") && Object.values(assets).includes(input.variables.input.resourceSpec.resourceUrn)) {
      const spec = input.variables.input.resourceSpec, kind = Object.keys(assets).find((k) => assets[k] === spec.resourceUrn);
      assert.equal(spec.resourceType, catalogTypes[kind].privilege);
      return Response.json({ data: { getGrantedPrivileges: { privileges: f.state.denied.has(spec.resourceUrn) ? [] : ["GET_ENTITY", "EDIT_ENTITY"] } } });
    }
    return underlying(url, options);
  };
  const inspect = (assetUrn = datasetUrn, extra = {}) => nativeSemantic(JSON.stringify({ contract: catalogContract, action: "inspect_asset", requestId: randomUUID(), sourceUrn, assetUrn, ...extra }), f.context);
  async function request(candidates, assetUrn = datasetUrn, extra = {}) {
    const inspected = await inspect(assetUrn, extra);
    return { contract: catalogContract, action: "preview", requestId: randomUUID(), sourceUrn, assetUrn, snapshotDigest: inspected.snapshotDigest, candidates, ...extra };
  }
  async function prepare(request) {
    const { action: _action, ...body } = request;
    f.writes.pending = { ...body, action: "prepare_review", sessionId: f.sessionId };
    return f.call({ ...f.writes.pending, uiRequestId: "fixture-ui" });
  }
  async function definitionRequest(definition, assetUrn = datasetUrn) {
    const inspected = await inspect(assetUrn);
    return { contract: catalogContract, action: "preview_definition", requestId: randomUUID(), sourceUrn, assetUrn, snapshotDigest: inspected.snapshotDigest, definition, ...catalogEvidence };
  }
  return { ...f, assets, inspect, request, prepare, definitionRequest };
}

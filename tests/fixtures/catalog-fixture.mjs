/** Synthetic public-API seam fixture only; never a live Catalog acceptance claim. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  nativeCatalog,
  CATALOG_QUERIES,
} from "../../extensions/datahub-agent/integration/native-catalog.mjs";
export const datasetUrn =
  "urn:li:dataset:(urn:li:dataPlatform:mssql,synthetic.sales.orders,TEST)";
export const downstreamUrn =
  "urn:li:dataset:(urn:li:dataPlatform:mssql,synthetic.sales.summary,TEST)";
export const fieldUrn = `urn:li:schemaField:(${datasetUrn},order_id)`;
export const actor = {
  urn: "urn:li:corpuser:catalog-test",
  key: "a".repeat(48),
  tenant: "synthetic",
};
export function catalogFixture() {
  const records = new Map([
    [
      datasetUrn,
      {
        urn: datasetUrn,
        type: "DATASET",
        name: "synthetic.sales.orders",
        lastIngested: 1700000000000,
        platform: { name: "mssql" },
        properties: {
          name: "Orders",
          description: "Source description",
          customProperties: [
            { key: "approved", value: '{"unit":"USD","optional":null}' },
            { key: "private", value: "DO_NOT_EXPOSE" },
          ],
        },
        editableProperties: { description: "Reviewed description" },
        schemaMetadata: {
          version: 3,
          createdAt: 1700000000000,
          fields: [
            {
              fieldPath: "order_id",
              type: "NUMBER",
              nativeDataType: "int",
              description: "Identifier",
              nullable: false,
              isPartOfKey: true,
              schemaFieldEntity: { urn: fieldUrn, type: "SCHEMA_FIELD" },
            },
            {
              fieldPath: "amount",
              type: "NUMBER",
              nativeDataType: "decimal",
              description: null,
              nullable: true,
              isPartOfKey: null,
            },
          ],
        },
        editableSchemaMetadata: {
          editableSchemaFieldInfo: [
            { fieldPath: "order_id", description: "Reviewed field" },
          ],
        },
        tags: { tags: [{ tag: { urn: "urn:li:tag:Finance", type: "TAG" } }] },
      },
    ],
    [
      downstreamUrn,
      {
        urn: downstreamUrn,
        type: "DATASET",
        name: "synthetic.sales.summary",
        platform: { name: "mssql" },
        properties: { name: "Summary", description: "Synthetic target" },
      },
    ],
    [
      "urn:li:tag:Finance",
      {
        urn: "urn:li:tag:Finance",
        type: "TAG",
        properties: { name: "Finance", description: "Synthetic term" },
      },
    ],
    [
      fieldUrn,
      {
        urn: fieldUrn,
        type: "SCHEMA_FIELD",
        fieldPath: "order_id",
        parent: { urn: datasetUrn, type: "DATASET" },
      },
    ],
  ]);
  const state = {
    actorUrn: actor.urn,
    records,
    denied: new Set(),
    calls: [],
    closed: false,
    searchTotal: 2,
    searchUrns: [datasetUrn, downstreamUrn],
    failQuery: null,
    edges: [
      {
        type: "DownstreamOf",
        degree: 1,
        createdOn: 1700000000000,
        entity: { urn: downstreamUrn, type: "DATASET" },
      },
    ],
  };
  const fetchImpl = async (url, options) => {
    assert.equal(url.href, "http://localhost:9002/api/v2/graphql");
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "manual");
    assert.equal(
      options.headers.cookie,
      "PLAY_SESSION=synthetic; actor=synthetic",
    );
    assert.equal(options.headers.Authorization, undefined);
    const { query, variables } = JSON.parse(options.body);
    assert.match(query, /^query /);
    assert.ok(
      Object.values(CATALOG_QUERIES).includes(query),
      "only fixed documents",
    );
    state.calls.push({ query, variables });
    if (state.failQuery === query)
      return Response.json({
        errors: [{ message: "private failure details" }],
        data: null,
      });
    let data;
    if (query === CATALOG_QUERIES.identity)
      data = { me: { corpUser: { urn: state.actorUrn } } };
    else if (query === CATALOG_QUERIES.privileges) {
      assert.equal(variables.input.actorUrn, actor.urn);
      data = {
        getGrantedPrivileges: {
          privileges: state.denied.has(variables.input.resourceSpec.resourceUrn)
            ? ["EDIT_ENTITY"]
            : ["VIEW_ENTITY_PAGE"],
        },
      };
    } else if (query === CATALOG_QUERIES.search) {
      const input = variables.input;
      const rows = state.searchUrns.slice(
        input.start,
        input.start + input.count,
      );
      data = {
        searchAcrossEntities: {
          start: input.start,
          count: rows.length,
          total: state.searchTotal,
          searchResults: rows.map((urn) => ({
            entity: { urn, type: records.get(urn)?.type },
          })),
        },
      };
    } else if (query === CATALOG_QUERIES.lineage)
      data = {
        entity: {
          urn: variables.urn,
          type: records.get(variables.urn)?.type,
          lineage: {
            start: variables.input.start,
            count: state.edges.length,
            total: state.edges.length,
            relationships: state.edges,
          },
        },
      };
    else data = { entity: structuredClone(records.get(variables.urn) ?? null) };
    return Response.json({ data });
  };
  return {
    state,
    run: (request = {}, context = {}) =>
      nativeCatalog(
        JSON.stringify({
          action: "entity",
          urn: datasetUrn,
          requestId: randomUUID(),
          ...request,
        }),
        {
          actor,
          frontendOrigin: "http://localhost:9002",
          cookieHeader: "PLAY_SESSION=synthetic; actor=synthetic",
          assertActive: () => {
            if (state.closed) throw Error("closed");
          },
          propertyNames: ["approved"],
          fetchImpl,
          ...context,
        },
      ),
  };
}

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  nativeCatalog,
  catalogPolicies,
  CATALOG_QUERIES,
} from "../extensions/datahub-agent/integration/native-catalog.mjs";
import {
  isCatalogResult,
  catalogNativeUrl,
} from "../extensions/datahub-agent/pi-web/lib/catalog-contract.ts";
import {
  catalogFixture,
  datasetUrn,
  downstreamUrn,
  fieldUrn,
  actor,
} from "./fixtures/catalog-fixture.mjs";

test("native actor entity read preserves edited text, exact fields, version and reviewed property allowlist", async () => {
  const f = catalogFixture();
  const value = await f.run();
  assert.ok(isCatalogResult(value));
  assert.equal(value.readOnly, true);
  assert.equal(value.entity.description, "Reviewed description");
  assert.equal(value.fields[0].description, "Reviewed field");
  assert.equal(value.fields[0].nullable, false);
  assert.equal(value.fields[1].nullable, true);
  assert.equal(value.schemaVersion, 3);
  assert.equal(value.fields[0].urn, fieldUrn);
  assert.equal(value.references[0].entity.name, "Finance");
  assert.ok(!JSON.stringify(value).includes("DO_NOT_EXPOSE"));
  const firstRead = f.state.calls.findIndex(
    (c) => c.query === CATALOG_QUERIES.entity,
  );
  assert.ok(
    f.state.calls
      .slice(0, firstRead)
      .some((c) => c.variables.input?.resourceSpec.resourceUrn === datasetUrn),
  );
});
test("pipeline and task links use the pinned DataHub public UI routes, not entity type names", async () => {
  const f = catalogFixture();
  for (const [type, urn, route] of [
    ["DATA_FLOW", "urn:li:dataFlow:(fixture,flow,PROD)", "pipelines"],
    [
      "DATA_JOB",
      "urn:li:dataJob:(urn:li:dataFlow:(fixture,flow,PROD),job)",
      "tasks",
    ],
  ]) {
    f.state.records.set(urn, {
      urn,
      type,
      properties: { name: "Fixture native link" },
    });
    const value = await f.run({ urn });
    assert.ok(isCatalogResult(value));
    const expected = `http://localhost:9002/${route}/${encodeURIComponent(urn)}`;
    assert.equal(value.entity.url, expected);
    const historical = structuredClone(value);
    historical.entity.url = `http://localhost:9002/${urn.split(":")[2]}/${encodeURIComponent(urn)}`;
    assert.ok(isCatalogResult(historical));
    assert.equal(catalogNativeUrl(historical.entity), expected);
    assert.equal(
      catalogNativeUrl(historical.entity, "lineage"),
      `${expected}/Lineage`,
    );
    historical.entity.url = `http://localhost:9002/settings/${encodeURIComponent(urn)}`;
    assert.equal(isCatalogResult(historical), false);
    assert.equal(catalogNativeUrl(historical.entity), null);
  }
});

test("all Catalog asset readers request and display editable descriptions with source fallback", async () => {
  for (const [type, graphType, urn] of [
    ["CONTAINER", "Container", "urn:li:container:fixture"],
    ["DATA_FLOW", "DataFlow", "urn:li:dataFlow:(fixture,flow,PROD)"],
    [
      "DATA_JOB",
      "DataJob",
      "urn:li:dataJob:(urn:li:dataFlow:(fixture,flow,PROD),job)",
    ],
    ["CHART", "Chart", "urn:li:chart:(fixture,chart)"],
    ["DASHBOARD", "Dashboard", "urn:li:dashboard:(fixture,dashboard)"],
  ]) {
    const f = catalogFixture();
    const record = {
      urn,
      type,
      properties: { name: "Fixture", description: "Source text" },
      editableProperties: { description: "Reviewed text" },
    };
    // A GraphQL server does not return fields omitted from the query. Model that
    // projection at the external boundary instead of returning the entire fixture.
    const fetchImpl = async (_url, options) => {
      const { query } = JSON.parse(options.body);
      if (query === CATALOG_QUERIES.identity)
        return Response.json({
          data: { me: { corpUser: { urn: actor.urn } } },
        });
      if (query === CATALOG_QUERIES.privileges)
        return Response.json({
          data: { getGrantedPrivileges: { privileges: ["VIEW_ENTITY_PAGE"] } },
        });
      const fragments = query
        .split(`... on ${graphType} {`)
        .slice(1)
        .map((fragment) => fragment.split("... on ")[0]);
      const entity = structuredClone(record);
      if (
        !fragments.some((fragment) =>
          /editableProperties\s*\{\s*description\s*\}/.test(fragment),
        )
      )
        delete entity.editableProperties;
      return Response.json({ data: { entity } });
    };
    const value = await f.run({ urn }, { fetchImpl });
    assert.equal(value.entity.description, "Reviewed text", type);
    record.editableProperties.description = null;
    assert.equal(
      (await f.run({ urn }, { fetchImpl })).entity.description,
      "Source text",
      type,
    );
  }
});

test("search resolves only readable entities and never publishes unfiltered totals", async () => {
  const f = catalogFixture();
  f.state.denied.add(downstreamUrn);
  f.state.searchTotal = 100;
  const value = await f.run({
    action: "search",
    urn: undefined,
    query: "sales",
  });
  assert.ok(isCatalogResult(value));
  assert.equal(value.entities.length, 1);
  assert.equal(value.pagination.total, null);
  assert.equal(value.pagination.completeness, "VISIBLE_PAGE_ONLY");
  assert.ok(!JSON.stringify(value).includes(downstreamUrn));
  assert.ok(
    !f.state.calls.some(
      (c) =>
        c.query === CATALOG_QUERIES.summary &&
        c.variables.urn === downstreamUrn,
    ),
  );
});
test("both lineage directions retain actual edge orientation; neighbor privileges are checked", async () => {
  for (const direction of ["UPSTREAM", "DOWNSTREAM"]) {
    const f = catalogFixture();
    const v = await f.run({ action: "lineage", direction });
    assert.ok(isCatalogResult(v));
    assert.equal(
      v.edges[0].from,
      direction === "UPSTREAM" ? downstreamUrn : datasetUrn,
    );
    assert.equal(
      v.edges[0].to,
      direction === "UPSTREAM" ? datasetUrn : downstreamUrn,
    );
    f.state.denied.add(downstreamUrn);
    const filtered = await f.run({ action: "lineage", direction });
    assert.equal(filtered.edges.length, 0);
    assert.equal(filtered.pagination.total, null);
  }
});
test("identity and fresh permission failures deny direct reads, not just hidden buttons", async () => {
  const f = catalogFixture();
  f.state.actorUrn = "urn:li:corpuser:other";
  await assert.rejects(f.run(), /catalog_identity_required/);
  assert.equal(f.state.calls.length, 1);
  f.state.actorUrn = actor.urn;
  f.state.denied.add(datasetUrn);
  await assert.rejects(f.run(), /catalog_read_denied/);
  assert.ok(!f.state.calls.some((c) => c.query === CATALOG_QUERIES.entity));
});
test("schema-field permission never bypasses its parent dataset permission", async () => {
  const f = catalogFixture();
  f.state.denied.add(datasetUrn);
  await assert.rejects(f.run({ urn: fieldUrn }), /catalog_read_denied/);
  await assert.rejects(
    f.run({ urn: fieldUrn, action: "lineage", direction: "UPSTREAM" }),
    /catalog_read_denied/,
  );
});
test("rejects mutations, arbitrary endpoint/query/actor, malformed identifiers and pagination before network", async () => {
  for (const request of [
    { action: "publish" },
    { action: "constructor" },
    { action: "delete" },
    { endpoint: "http://private" },
    { query: "mutation{}" },
    { actor: "admin" },
    { urn: "urn:li:constructor:x" },
    { urn: "urn:li:__proto__:x" },
    { limit: 21 },
    { offset: -1 },
    { requestId: "wrong" },
    { action: "lineage", direction: "OTHER" },
  ]) {
    const f = catalogFixture();
    await assert.rejects(f.run(request), /invalid_catalog/);
    assert.equal(f.state.calls.length, 0);
  }
});
test("schema pagination is bounded and does not infer absent optional metadata", async () => {
  const f = catalogFixture();
  const v = await f.run({ limit: 1 });
  assert.equal(v.fields.length, 1);
  assert.equal(v.pagination.total, 2);
  assert.equal(v.pagination.nextOffset, 1);
  const next = await f.run({ limit: 1, offset: 1 });
  assert.equal(next.fields[0].path, "amount");
  assert.equal(next.fields[0].key, null);
  const noSchema = await f.run({ urn: downstreamUrn });
  assert.equal(noSchema.pagination.completeness, "NOT_RECORDED");
  assert.equal(noSchema.pagination.total, null);
});
test("upstream failures are bounded safe errors; no partial GraphQL data or error body leaks", async () => {
  const f = catalogFixture();
  f.state.failQuery = CATALOG_QUERIES.entity;
  await assert.rejects(
    f.run(),
    (e) =>
      e.message === "catalog_read_unavailable" &&
      !e.message.includes("private"),
  );
  await assert.rejects(
    f.run(
      {},
      { fetchImpl: async () => new Response("private error", { status: 403 }) },
    ),
    /catalog_read_denied/,
  );
  await assert.rejects(
    f.run(
      {},
      {
        fetchImpl: async () => {
          throw new Error("sensitive connection string");
        },
      },
    ),
    /catalog_unavailable/,
  );
});
test("operator activation is explicit per actor; property names require deliberate configuration", () => {
  assert.equal(catalogPolicies().size, 0);
  assert.deepEqual(
    catalogPolicies({
      [actor.key]: { modelContextApproved: true, propertyNames: [] },
    }).get(actor.key),
    { propertyNames: [] },
  );
  for (const value of [
    null,
    [],
    { other: {} },
    { [actor.key]: { modelContextApproved: false, propertyNames: [] } },
    {
      [actor.key]: {
        modelContextApproved: true,
        propertyNames: [],
        endpoint: "x",
      },
    },
  ])
    assert.throws(
      () => catalogPolicies(value),
      /catalog_configuration_invalid/,
    );
});
test("unknown format / malformed results fail presentation validation instead of exposing raw payloads", async () => {
  const f = catalogFixture();
  const v = await f.run();
  for (const bad of [
    null,
    { ...v, format: "datahub-catalog/2" },
    { ...v, readOnly: false },
    { ...v, fields: [null] },
    { ...v, pagination: { ...v.pagination, nextOffset: -1 } },
  ])
    assert.equal(isCatalogResult(bad), false);
});
test("configuration and cancellation errors do not start network calls", async () => {
  const f = catalogFixture();
  await assert.rejects(
    f.run({}, { frontendOrigin: "garbage" }),
    /catalog_configuration_invalid/,
  );
  f.state.closed = true;
  await assert.rejects(f.run(), /closed/);
  assert.equal(f.state.calls.length, 0);
  await assert.rejects(
    nativeCatalog(
      JSON.stringify({ action: "search", query: "x", requestId: randomUUID() }),
      { actor: null },
    ),
    /catalog_identity_required/,
  );
});

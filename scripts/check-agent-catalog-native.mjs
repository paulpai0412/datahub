/** Authorized real-read check. No fixtures, replacement fetch, model, metadata writes or deployment.
 * Run only with owner approval for the supplied origin, credentials and metadata query.
 * Identity is scoped to the requested origin for this direct adapter check. This does NOT
 * exercise production Gateway grants, actor activation policy, or the Agent entrypoint. */
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import {
  CATALOG_QUERIES,
  managedCatalogImageUrl,
  nativeCatalog,
} from "../extensions/datahub-agent/integration/native-catalog.mjs";
import { createIdentityVerifier } from "../extensions/datahub-agent/integration/datahub-identity.mjs";
import { isCatalogResult } from "../extensions/datahub-agent/pi-web/lib/catalog-contract.ts";
const { values } = parseArgs({
  options: {
    origin: { type: "string" },
    credentials: { type: "string" },
    query: { type: "string" },
    output: { type: "string" },
  },
  strict: true,
});
for (const key of ["origin", "credentials", "query", "output"])
  assert.ok(values[key], `Required --${key}`);
let origin;
try {
  origin = new URL(values.origin);
} catch {
  throw new Error("Invalid --origin");
}
assert.ok(
  ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname),
  "This check is restricted to an authorized loopback DataHub",
);
assert.equal(origin.origin, values.origin);
const require = createRequire(
  new URL("../extensions/datahub-agent/pi-web/package.json", import.meta.url),
);
const { request } = require("playwright");
const output = resolve(values.output);
await mkdir(output, { recursive: true, mode: 0o700 });
const api = await request.newContext({ baseURL: origin.origin });
const receipt = {
  scope: "REAL_NATIVE_ADAPTER_READS_ONLY_NOT_AGENT_OR_GATEWAY_ACCEPTANCE",
  startedAt: new Date().toISOString(),
  query: values.query,
  checks: [],
  completed: false,
};
async function save(name, value) {
  await writeFile(
    resolve(output, name + ".json"),
    JSON.stringify(value, null, 2),
    { mode: 0o600 },
  );
}
try {
  const credential = (await readFile(values.credentials, "utf8")).trim(),
    separator = credential.indexOf(":");
  assert.ok(separator > 0, "Credential format invalid");
  const login = await api.post("/logIn", {
    data: {
      username: credential.slice(0, separator),
      password: credential.slice(separator + 1),
    },
    maxRedirects: 0,
  });
  // Record only status for diagnosis; never persist the response, cookies or credentials.
  receipt.loginStatus = login.status();
  assert.ok(login.ok(), "Native login failed");
  const cookies = (await api.storageState()).cookies
    .filter((cookie) => ["PLAY_SESSION", "actor"].includes(cookie.name))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
  const actor = await createIdentityVerifier({
    frontendOrigin: origin.origin,
    tenant: origin.origin,
  })(cookies);
  const deadline = Date.now() + 120000;
  async function read(name, intent) {
    const result = await nativeCatalog(
      JSON.stringify({ ...intent, requestId: randomUUID() }),
      {
        actor,
        frontendOrigin: origin.origin,
        cookieHeader: cookies,
        assertActive() {
          assert.ok(Date.now() < deadline, "Authorized read window elapsed");
        },
      },
    );
    await save(name, result);
    assert.ok(
      isCatalogResult(result),
      `${name}: product renderer contract rejected real response`,
    );
    receipt.checks.push({
      name,
      queriedAt: result.queriedAt,
      action: result.action,
    });
    return result;
  }
  const search = await read("search", {
    action: "search",
    query: values.query,
    types: ["DATASET"],
  });
  assert.ok(
    search.entities.length,
    "No readable dataset matched the authorized query",
  );
  // Select a returned identity for coverage, not an inferred / hardcoded asset.
  const urn = search.entities[0].urn;
  receipt.entity = urn;
  receipt.unexercised = [];
  const withBrowseInstance = search.entities.filter((asset) =>
    asset.browsePath?.some((entry) =>
      entry.urn?.startsWith("urn:li:dataPlatformInstance:"),
    ),
  );
  receipt.browseInstanceCoverage = {
    visibleDatasetsWithInstance: withBrowseInstance.length,
  };
  if (withBrowseInstance.length) {
    const asset = withBrowseInstance[0];
    const instance = asset.browsePath.find((entry) =>
      entry.urn?.startsWith("urn:li:dataPlatformInstance:"),
    );
    assert.ok(
      instance.id && instance.name,
      "Browse instance has no native identity",
    );
    const checked = await read("browse-instance-dataset", {
      action: "entity",
      urn: asset.urn,
    });
    assert.equal(checked.entity.urn, asset.urn);
    assert.ok(
      checked.entity.browsePath?.some((entry) => entry.urn === instance.urn),
      "Entity view lost its ACL-checked Browse instance",
    );
  } else
    receipt.unexercised.push(
      "Browse V2: no linked DataPlatformInstance among visible search assets",
    );
  for (const [field, property] of [
    ["platform", "platformUrn"],
    ["platformInstance", "platformInstanceUrn"],
    ["origin", "environment"],
  ]) {
    const value = search.entities[0][property];
    if (!value) {
      receipt.unexercised.push(`${field}: selected real asset has no value`);
      continue;
    }
    const filtered = await read(`filter-${field}`, {
      action: "search",
      query: values.query,
      types: ["DATASET"],
      filters: { [field]: value },
    });
    assert.ok(
      filtered.entities.length,
      `${field}: filter unexpectedly lost all authorized matches`,
    );
    assert.ok(
      filtered.entities.every((entity) => entity[property] === value),
      `${field}: native filter did not match projected metadata`,
    );
  }
  const location = search.entities[0].browsePath;
  receipt.browseCoverage = [];
  if (location?.length) {
    for (let index = 0; index < location.length; index++) {
      const ids = location.slice(0, index + 1).map((entry) => entry.id);
      const filtered = await read(`browse-prefix-${index}`, {
        action: "search",
        query: values.query,
        types: ["DATASET"],
        browsePath: ids,
        ...(search.entities[0].platformUrn
          ? { filters: { platform: search.entities[0].platformUrn } }
          : {}),
      });
      assert.ok(
        filtered.entities.length,
        "Native browse prefix lost all matching real assets",
      );
      assert.ok(
        filtered.entities.every((asset) =>
          ids.every((id, index) => asset.browsePath?.[index]?.id === id),
        ),
        "Returned source location does not match the native prefix",
      );
      const entry = location[index];
      if (entry.urn?.startsWith("urn:li:container:")) {
        const container = await read(`browse-container-${index}`, {
          action: "entity",
          urn: entry.urn,
        });
        assert.equal(container.entity.urn, entry.urn);
      } else if (entry.urn?.startsWith("urn:li:dataPlatformInstance:")) {
        const response = await api.post("/api/v2/graphql", {
          data: {
            query: CATALOG_QUERIES.summary,
            variables: { urn: entry.urn },
          },
        });
        const nativeInstance = await response.json();
        assert.ok(
          response.ok() &&
            !nativeInstance.errors?.length &&
            nativeInstance.data?.entity?.urn === entry.urn &&
            nativeInstance.data.entity.type === "DATA_PLATFORM_INSTANCE",
          "Browse instance is not a DataHub DataPlatformInstance",
        );
      } else if (entry.urn) {
        assert.fail("Unexpected Browse V2 linked entity type");
      }
      receipt.browseCoverage.push({
        subTypes: entry.subTypes,
        visibleAssets: filtered.entities.length,
      });
    }
  } else
    receipt.unexercised.push(
      "Browse V2: no readable path on selected real dataset",
    );
  const native = await api.post("/api/v2/graphql", {
    data: { query: CATALOG_QUERIES.entity, variables: { urn } },
  });
  const body = await native.json();
  await save("native-entity", body);
  assert.ok(
    native.ok() && !body.errors?.length && body.data?.entity?.urn === urn,
    "Native entity document failed",
  );
  const entity = await read("entity", { action: "entity", urn });
  const governanceKinds = (raw) =>
    Object.entries({
      ownership: "Owner",
      tags: "Tag",
      glossaryTerms: "Term",
      domain: "Domain",
    })
      .filter(([field]) => Object.hasOwn(raw, field))
      .map(([, kind]) => kind)
      .sort();
  assert.deepEqual(
    [...entity.referenceKinds].sort(),
    governanceKinds(body.data.entity),
  );
  receipt.governanceDefinitionCoverage = [
    { type: entity.entity.type, kinds: entity.referenceKinds },
  ];
  assert.equal(
    entity.entity.platformDisplayName,
    body.data.entity.platform?.properties?.displayName ?? null,
  );
  assert.equal(
    entity.entity.imageUrl,
    managedCatalogImageUrl(
      body.data.entity.platform?.properties?.logoUrl,
      origin,
    ),
  );
  assert.equal(
    entity.entity.platformInstance,
    (body.data.entity.dataPlatformInstance?.properties?.name ||
      body.data.entity.dataPlatformInstance?.instanceId) ??
      null,
  );
  receipt.identityPresentationCoverage = {
    platformDisplayNamePresent: Boolean(entity.entity.platformDisplayName),
    managedPlatformImagePresent: Boolean(entity.entity.imageUrl),
    profiles: [],
  };
  if (!entity.entity.platformDisplayName)
    receipt.unexercised.push("Selected platform has no nonempty displayName");
  assert.deepEqual(
    entity.entity.subTypes,
    body.data.entity.subTypes?.typeNames ?? [],
  );
  assert.equal(
    entity.schemaFieldCount,
    body.data.entity.schemaMetadata?.fields?.length ?? null,
  );
  assert.equal(
    entity.schemaCreatedAt,
    body.data.entity.schemaMetadata?.createdAt ?? null,
  );
  receipt.fieldMetadataCoverage = { fieldsChecked: 0, projectedReferences: 0 };
  for (const field of entity.fields) {
    const actual = body.data.entity.schemaMetadata.fields.find(
      (item) => item.fieldPath === field.path,
    );
    assert.ok(actual, "Projected field absent from native schema");
    assert.equal(field.nativeType, actual.nativeDataType ?? null);
    assert.equal(field.type, actual.type ?? null);
    assert.equal(field.label, actual.label ?? null);
    assert.equal(field.jsonPath, actual.jsonPath ?? null);
    assert.equal(field.partitionKey, actual.isPartitioningKey ?? null);
    assert.equal(field.recursive, actual.recursive ?? null);
    const edited =
      body.data.entity.editableSchemaMetadata?.editableSchemaFieldInfo?.find(
        (entry) => entry.fieldPath === field.path,
      );
    assert.equal(field.sourceDescription, actual.description ?? null);
    assert.equal(field.editedDescription, edited?.description ?? null);
    assert.equal(
      field.description,
      edited?.description ?? actual.description ?? null,
    );
    let direct;
    if (field.urn) {
      const response = await api.post("/api/v2/graphql", {
        data: {
          query: CATALOG_QUERIES.fieldMetadata,
          variables: { urn: field.urn },
        },
      });
      const metadata = await response.json();
      await save(
        `field-sources-${receipt.fieldMetadataCoverage.fieldsChecked}`,
        metadata,
      );
      assert.ok(
        response.ok() &&
          !metadata.errors?.length &&
          metadata.data?.entity?.urn === field.urn,
        "Native field metadata read failed",
      );
      direct = metadata.data.entity;
      assert.equal(direct.parent.urn, urn);
    }
    const sources = {
      SCHEMA_METADATA: actual,
      EDITABLE_SCHEMA: edited,
      SCHEMA_FIELD_ENTITY: direct,
    };
    for (const ref of field.references)
      for (const source of ref.sources) {
        const raw = sources[source];
        const refs =
          ref.kind === "Tag"
            ? raw?.tags?.tags?.map((item) => item.tag.urn)
            : raw?.glossaryTerms?.terms?.map((item) => item.term.urn);
        assert.ok(
          refs?.includes(ref.entity.urn),
          "Projected governance provenance does not exist in native field metadata",
        );
      }
    receipt.fieldMetadataCoverage.fieldsChecked++;
    receipt.fieldMetadataCoverage.projectedReferences +=
      field.references.length;
  }
  if (!receipt.fieldMetadataCoverage.projectedReferences)
    receipt.unexercised.push(
      "Selected real fields have no returned governance references; direct/editable/source nonempty chips remain unverified",
    );
  // Association anchors come from these real source assets or the signed-in
  // actor's own identity. Do not create tags/terms/owners to manufacture coverage.
  const anchors = new Map(
    entity.references.map((reference) => [
      reference.entity.type,
      reference.entity,
    ]),
  );
  for (const candidate of search.entities.slice(1)) {
    const detail = await read(
      `governance-${anchors.size}-${search.entities.indexOf(candidate)}`,
      { action: "entity", urn: candidate.urn, limit: 1 },
    );
    for (const reference of detail.references)
      if (!anchors.has(reference.entity.type))
        anchors.set(reference.entity.type, reference.entity);
  }
  const indexes = {
    TAG: ["tags", "fieldTags"],
    GLOSSARY_TERM: ["glossaryTerms", "fieldGlossaryTerms"],
    DOMAIN: ["domains"],
    CORP_USER: ["owners"],
    CORP_GROUP: ["owners"],
  };
  receipt.associationCoverage = [];
  const targets = [
    { urn: actor.urn, type: "CORP_USER", checkName: "current-actor" },
    ...[...anchors.values()].map((anchor) => ({
      ...anchor,
      checkName: anchor.type,
    })),
  ];
  for (const anchor of targets) {
    const type = anchor.type;
    if (!indexes[type]) continue;
    const definition = await read(`definition-${anchor.checkName}`, {
      action: "entity",
      urn: anchor.urn,
    });
    const definitionResponse = await api.post("/api/v2/graphql", {
      data: { query: CATALOG_QUERIES.entity, variables: { urn: anchor.urn } },
    });
    const nativeDefinition = await definitionResponse.json();
    await save(`native-definition-${anchor.checkName}`, nativeDefinition);
    assert.ok(
      definitionResponse.ok() &&
        !nativeDefinition.errors?.length &&
        nativeDefinition.data?.entity?.urn === anchor.urn,
    );
    assert.deepEqual(
      [...definition.referenceKinds].sort(),
      governanceKinds(nativeDefinition.data.entity),
    );
    receipt.governanceDefinitionCoverage.push({
      type,
      kinds: definition.referenceKinds,
    });
    const profile = nativeDefinition.data.entity;
    if (type === "CORP_USER") {
      assert.equal(
        definition.entity.name,
        profile.editableProperties?.displayName ||
          profile.properties?.displayName ||
          profile.properties?.fullName ||
          profile.username ||
          profile.urn,
      );
      assert.equal(definition.entity.qualifiedName, profile.username ?? null);
      assert.equal(
        definition.entity.profileTitle,
        (profile.editableProperties?.title || profile.properties?.title) ??
          null,
      );
      assert.equal(
        definition.entity.description,
        profile.editableProperties?.aboutMe ?? null,
      );
      const coverage = {
        type,
        editableDisplayNamePresent: Boolean(
          profile.editableProperties?.displayName,
        ),
        fullNamePresent: Boolean(profile.properties?.fullName),
        titlePresent: Boolean(definition.entity.profileTitle),
        aboutMePresent: Boolean(definition.entity.description),
      };
      receipt.identityPresentationCoverage.profiles.push(coverage);
      for (const [field, present] of Object.entries(coverage))
        if (present === false)
          receipt.unexercised.push(`${type}: no nonempty ${field} example`);
    } else if (type === "CORP_GROUP") {
      assert.equal(
        definition.entity.description,
        profile.editableProperties?.description ??
          profile.properties?.description ??
          null,
      );
      receipt.identityPresentationCoverage.profiles.push({
        type,
        editableDescriptionPresent: Boolean(
          profile.editableProperties?.description,
        ),
      });
      if (!profile.editableProperties?.description)
        receipt.unexercised.push(
          "CORP_GROUP: no nonempty editable description example",
        );
    }
    const related = await read(`associated-${anchor.checkName}`, {
      action: "search",
      query: values.query,
      types: ["DATASET"],
      relatedTo: anchor.urn,
    });
    const nativeResponse = await api.post("/api/v2/graphql", {
      data: {
        query: CATALOG_QUERIES.search,
        variables: {
          input: {
            query: values.query,
            types: ["DATASET"],
            start: 0,
            count: 10,
            orFilters: indexes[type].map((field) => ({
              and: [{ field, values: [anchor.urn], condition: "EQUAL" }],
            })),
          },
        },
      },
    });
    const nativeResult = await nativeResponse.json();
    await save(`native-associated-${anchor.checkName}`, nativeResult);
    assert.ok(
      nativeResponse.ok() &&
        !nativeResult.errors?.length &&
        nativeResult.data?.searchAcrossEntities,
    );
    assert.equal(related.relatedTo.urn, anchor.urn);
    const nativeUrns = new Set(
      nativeResult.data.searchAcrossEntities.searchResults.map(
        (row) => row.entity.urn,
      ),
    );
    assert.ok(related.entities.every((asset) => nativeUrns.has(asset.urn)));
    receipt.associationCoverage.push({
      type,
      visibleAssets: related.entities.length,
      anchorBasis:
        anchor.checkName === "current-actor"
          ? "signed-in actor"
          : "native asset reference",
    });
    if (!related.entities.length)
      receipt.unexercised.push(
        `${type}: real association query has no visible result; not a nonempty association proof`,
      );
    if (related.pagination.nextOffset !== null)
      await read(`associated-next-${anchor.checkName}`, {
        ...related.request,
        offset: related.pagination.nextOffset,
      });
  }
  for (const type of Object.keys(indexes))
    if (!anchors.has(type))
      receipt.unexercised.push(
        `${type}: no readable anchor in sampled real assets`,
      );
  if (entity.fields.length) {
    const path = entity.fields[0].path;
    const focused = await read("field", {
      action: "entity",
      urn,
      fieldPath: path,
    });
    assert.equal(focused.fields.length, 1);
    assert.equal(focused.fields[0].path, path);
    // Real metadata feeds the existing draft implementation, not a mocked API
    // or a claim that Composer/RPC failure recovery ran in the browser.
    const drafts = await require("jiti")
      .createJiti(import.meta.url)
      .import("../extensions/datahub-agent/pi-web/lib/draft-store.ts");
    const reference = {
      urn: focused.entity.urn,
      name: focused.entity.name,
      fieldPath: path,
    };
    const before = randomUUID(),
      after = randomUUID();
    drafts.setDraft(before, {
      value: "",
      images: [],
      catalogReferences: [reference],
    });
    assert.deepEqual(drafts.getDraft(before).catalogReferences, [reference]);
    const copy = drafts.getDraft(before);
    copy.catalogReferences.pop();
    assert.equal(drafts.getDraft(before).catalogReferences.length, 1);
    drafts.rekeyDraft(before, after);
    assert.equal(drafts.getDraft(before), null);
    assert.deepEqual(drafts.getDraft(after).catalogReferences, [reference]);
    drafts.clearDraft(after);
    drafts.restoreDraftSubmission(after, "", undefined, [reference]);
    assert.equal(drafts.getDraft(after).value, "");
    assert.deepEqual(drafts.getDraft(after).catalogReferences, [reference]);
    drafts.restoreDraftSubmission(after, reference.name, undefined, [
      reference,
    ]);
    assert.equal(drafts.getDraft(after).catalogReferences.length, 1);
    assert.equal(drafts.getDraft(after).value, reference.name);
    drafts.clearDraft(after);
    assert.equal(drafts.getDraft(after), null);
    receipt.draftChecks = [
      "chip-only saved",
      "clone isolated",
      "rekey preserved",
      "post-clear chip-only restoration",
      "reference merge deduplicated",
      "clear removed",
    ];
    await save("draft-reference-consumer", {
      scope: "FRESH_NATIVE_METADATA_TO_DRAFT_HELPERS_NOT_BROWSER_OR_RPC",
      checks: receipt.draftChecks,
      passed: true,
    });
    const filtered = await read("field-search", {
      action: "entity",
      urn,
      fieldQuery: path,
      fieldSort: "path",
    });
    assert.ok(filtered.fields.some((field) => field.path === path));
    await read("field-type-sort", { action: "entity", urn, fieldSort: "type" });
    const nativeField = focused.fields[0];
    if (nativeField.urn) {
      for (const direction of ["UPSTREAM", "DOWNSTREAM"])
        await read(`field-${direction.toLowerCase()}`, {
          action: "lineage",
          urn: nativeField.urn,
          direction,
        });
    } else
      receipt.unexercised.push(
        "field lineage: no readable native field identity returned",
      );
  }
  if (entity.pagination.nextOffset !== null) {
    const next = await read("schema-next", {
      action: "entity",
      urn,
      offset: entity.pagination.nextOffset,
    });
    assert.ok(
      next.fields.every(
        (field) => !entity.fields.some((first) => first.path === field.path),
      ),
    );
  }
  const graphReaders = await import(
    "../extensions/datahub-agent/pi-web/lib/catalog-lineage.ts"
  );
  const graphReads = [];
  const graphRoots = [];
  for (const direction of ["UPSTREAM", "DOWNSTREAM"]) {
    const lineage = await read(direction.toLowerCase(), {
      action: "lineage",
      urn,
      direction,
    });
    assert.ok(lineage.edges.every((edge) => edge.degree === 1));
    graphRoots.push(lineage);
    graphReads.push(lineage);
    if (lineage.pagination.nextOffset !== null)
      graphReads.push(
        await read(direction.toLowerCase() + "-next", {
          action: "lineage",
          urn,
          direction,
          offset: lineage.pagination.nextOffset,
        }),
      );
  }
  // One real same-database neighbor, not a synthetic graph or unbounded traversal.
  const neighbor = graphReads
    .flatMap((page) => page.edges)
    .map((edge) => edge.related)
    .find(
      (asset) =>
        asset.urn !== urn &&
        asset.type === "DATASET" &&
        location?.length &&
        asset.platformUrn === entity.entity.platformUrn &&
        asset.browsePath?.[0]?.id === location[0].id,
    );
  if (neighbor) {
    for (const direction of ["UPSTREAM", "DOWNSTREAM"]) {
      const expanded = await read(`graph-neighbor-${direction.toLowerCase()}`, {
        action: "lineage",
        urn: neighbor.urn,
        direction,
      });
      graphReads.push(expanded);
      graphRoots.push(expanded);
    }
  } else
    receipt.unexercised.push(
      "Graph expansion: no same-database readable neighbor in sampled real pages",
    );
  receipt.graphConsumerCoverage = [];
  for (const root of graphRoots) {
    const model = graphReaders.observedCatalogLineage(root, graphReads);
    const rawEdges = graphReads
      .filter((page) => page.direction === root.direction)
      .flatMap((page) => page.edges);
    const triples = new Set(
      rawEdges.map((edge) =>
        JSON.stringify([edge.from, edge.to, edge.relationship]),
      ),
    );
    assert.equal(model.edges.size, triples.size);
    assert.ok([...model.edges].every(([id]) => triples.has(id)));
    let pathsChecked = 0,
      multiHopPaths = 0;
    for (const endpoint of model.distance.keys()) {
      const path = graphReaders.observedCatalogPath(model, endpoint);
      assert.equal(new Set(path).size, path.length);
      assert.equal(
        root.direction === "UPSTREAM" ? path.at(-1) : path[0],
        root.entity.urn,
      );
      assert.equal(
        root.direction === "UPSTREAM" ? path[0] : path.at(-1),
        endpoint,
      );
      for (let i = 1; i < path.length; i++)
        assert.ok(
          rawEdges.some(
            (edge) => edge.from === path[i - 1] && edge.to === path[i],
          ),
          "Path segment must have a real returned edge",
        );
      pathsChecked++;
      if (path.length > 2) multiHopPaths++;
    }
    const repeated = graphReaders.observedCatalogLineage(root, [
      ...graphReads,
      ...graphReads,
    ]);
    assert.equal(repeated.edges.size, model.edges.size);
    assert.deepEqual([...repeated.distance], [...model.distance]);
    receipt.graphConsumerCoverage.push({
      direction: root.direction,
      root: root.entity.urn,
      edges: model.edges.size,
      reachableNodes: model.distance.size,
      pathsChecked,
      multiHopPaths,
    });
  }
  if (!receipt.graphConsumerCoverage.some((c) => c.multiHopPaths))
    receipt.unexercised.push(
      "Graph consumer: no real multi-hop path in bounded expansion",
    );
  receipt.unexercised.push(
    "Graph cycles and browser scroll/refresh races not exercised by the data-consumer check",
  );
  await save("lineage-consumer", {
    scope: "FRESH_NATIVE_LINEAGE_TO_PRODUCT_GRAPH_HELPERS_NOT_BROWSER_OR_MODEL",
    coverage: receipt.graphConsumerCoverage,
    passed: true,
  });
  if (location?.length) {
    const query =
      "query CatalogRecordedMappings($input:SearchAcrossEntitiesInput!){searchAcrossEntities(input:$input){start count total searchResults{entity{urn type ... on Dataset{fineGrainedLineages{upstreams{urn path} downstreams{urn path}}}}}}}";
    let candidate,
      start = 0,
      more = true;
    receipt.fieldMappingDiscovery = { pages: 0, matchedMultiInput: false };
    for (let page = 0; page < 6 && more && !candidate; page++) {
      const input = {
        query: values.query,
        types: ["DATASET"],
        start,
        count: 20,
        orFilters: [
          {
            and: [
              {
                field: "browsePathV2",
                values: ["\u241f" + location[0].id],
                condition: "EQUAL",
              },
            ],
          },
        ],
      };
      const response = await api.post("/api/v2/graphql", {
        data: { query, variables: { input } },
      });
      const body = await response.json();
      await save(`mapping-discovery-${page}`, { input, body });
      assert.ok(
        response.ok() &&
          !body.errors?.length &&
          body.data?.searchAcrossEntities,
        "Native mapping discovery failed",
      );
      const result = body.data.searchAcrossEntities;
      assert.equal(result.start, start);
      assert.ok(Number.isSafeInteger(result.count) && result.count > 0);
      receipt.fieldMappingDiscovery.pages++;
      for (const row of result.searchResults) {
        const group = row.entity.fineGrainedLineages?.find(
          (group) =>
            group.upstreams?.length > 1 &&
            group.downstreams?.some((field) => field.urn === row.entity.urn),
        );
        if (group) {
          candidate = { owner: row.entity.urn, group };
          break;
        }
      }
      start += result.count;
      more = start < result.total;
    }
    receipt.fieldMappingDiscovery.windowHasMore = more;
    if (candidate) {
      receipt.fieldMappingDiscovery.matchedMultiInput = true;
      const selected = candidate.group.downstreams.find(
        (field) => field.urn === candidate.owner,
      );
      const mapped = await read("mapping-upstream", {
        action: "fieldLineage",
        urn: candidate.owner,
        fieldPath: selected.path,
        direction: "UPSTREAM",
        limit: 20,
      });
      const identities = (group, projected) =>
        JSON.stringify(
          ["upstreams", "downstreams"].map((side) =>
            group[side].map((field) => [
              projected ? field.dataset.urn : field.urn,
              field.path,
            ]),
          ),
        );
      const expected = identities(candidate.group, false);
      const actual = mapped.groups.find(
        (group) => identities(group, true) === expected,
      );
      assert.ok(
        actual,
        "Real multi-input group was lost, altered or could not be authorized/schema-verified",
      );
      const input = actual.upstreams[0];
      let reverseFound = false,
        offset = 0;
      for (let page = 0; page < 6 && offset !== null; page++) {
        const reverse = await read(`mapping-downstream-${page}`, {
          action: "fieldLineage",
          urn: input.dataset.urn,
          fieldPath: input.path,
          direction: "DOWNSTREAM",
          limit: 20,
          offset,
        });
        reverseFound ||= reverse.groups.some(
          (group) => identities(group, true) === expected,
        );
        offset = reverse.pagination.nextOffset;
      }
      assert.ok(
        reverseFound,
        "The known real group was not returned in the bounded downstream window",
      );
      receipt.fieldMappingCoverage = {
        multiInputPreserved: true,
        downstreamReadback: true,
        inputs: actual.upstreams.length,
        outputs: actual.downstreams.length,
      };
    } else
      receipt.unexercised.push(
        "No multi-input mapping found in the bounded real browse/query scope; no substitute group created",
      );
  }
  receipt.completed = true;
  console.log(
    JSON.stringify({
      scope: receipt.scope,
      readChecks: receipt.checks.length,
      entity: urn,
      schemaFieldCount: entity.schemaFieldCount,
    }),
  );
} catch (error) {
  receipt.failure =
    error instanceof Error ? error.message : "native_read_failed";
  // Known product/Assertion errors only; never serialize requests, cookies or HTTP bodies to stdout.
  console.error("Native Catalog verification stopped; private receipt saved.");
  process.exitCode = 1;
} finally {
  receipt.finishedAt = new Date().toISOString();
  await save("receipt", receipt);
  await api.dispose();
}

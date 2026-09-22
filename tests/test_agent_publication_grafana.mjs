import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  compileGrafanaArtifact,
  grafanaPublicationCompiler,
  grafanaPublicationSnapshot,
} from "../extensions/datahub-agent/integration/native-grafana-publication.mjs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  canonicalPublicationJson,
  makePublicationReview,
  validatePublicationReview,
} from "../extensions/datahub-agent/integration/publication-review.mjs";

// Synthetic Host binding/versions only. No stored approval, Source or mutation.
const binding = {
  purpose: "LINEAGE",
  source: "urn:li:dataHubIngestionSource:00000000-0000-4000-8000-000000000001",
  sourceId: "grafana-review-fixture",
  snapshotSha256: "a".repeat(64),
  candidateDigest: "b".repeat(64),
  analysisVersion: "1.0.2",
  candidateIds: ["cand_" + "c".repeat(24)],
  expiresAt: 2000,
};

function compileFixture(ingestTags) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  // Installed official connector/parser and plugin Transformer. The existing
  // fail-closed HTTP fixture intercepts every request; no live Grafana/GMS.
  const script = [
    "import sys, json, logging",
    "sys.path[:0] = [sys.argv[1], sys.argv[1] + '/extensions/dataflow-discovery/src']",
    "from tests.test_sales_datamart_grafana import ingest_fixture, template, catalog_fixture, VIEW_URN",
    "from tests.test_dataflow_discovery_grafana_schema import pipeline_transformer",
    "logging.disable(logging.CRITICAL)",
    "dashboard = template('dashboard.json')['dashboard']",
    "records = ingest_fixture(dashboard, catalog=catalog_fixture(), transformers=pipeline_transformer(dashboard), ingest_tags=sys.argv[2] == 'true')",
    "print(json.dumps({'datasets': sorted({VIEW_URN} | {r.entityUrn for r in records if r.entityType == 'dataset'}), 'mcps': [r.to_obj(simplified_structure=True) for r in records], 'aspects': [{'urn': r.entityUrn, 'aspect': r.aspectName, 'value': json.loads(r.to_obj()['aspect']['value'])} for r in records]}))",
  ].join("\n");
  return JSON.parse(
    execFileSync(
      root + ".venv/bin/python",
      ["-I", "-B", "-c", script, root, String(ingestTags)],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 90000,
        maxBuffer: 2 * 1024 * 1024,
        env: {
          PATH: "/usr/bin:/bin",
          HOME: "/dev/null",
          LANG: "C.UTF-8",
          DATAHUB_TELEMETRY_ENABLED: "false",
        },
      },
    ),
  );
}

const changesFrom = (compiled) =>
  compiled.aspects.map(({ urn, aspect, value }) => ({
    urn,
    aspect,
    expectedVersion: "-1",
    valueJson: canonicalPublicationJson(value),
  }));

test("native ingest_tags=false prepares complete Grafana structure for existing LINEAGE review", {
  timeout: 120000,
}, () => {
  const compiled = compileFixture(false);
  const changes = changesFrom(compiled);
  assert.equal(changes.length, 121);
  assert.equal(compiled.datasets.length, 8);
  assert.equal(new Set(changes.map((c) => c.urn)).size, 17);
  assert.ok(
    changes.every(
      (c) =>
        !["globalTags", "tagKey", "ownership", "glossaryTerms"].includes(
          c.aspect,
        ),
    ),
  );
  const review = makePublicationReview({
    ...binding,
    datasets: compiled.datasets,
    changes,
  });
  validatePublicationReview(review, 1000);
  assert.deepEqual(review.changes, changes); // no application-side filtering
  assert.throws(
    () => validatePublicationReview(review, 2000),
    /publication_review_expired/,
  );
  assert.throws(
    () =>
      makePublicationReview({
        ...binding,
        datasets: compiled.datasets.slice(1),
        changes,
      }),
    /publication_dataset_outside_scope/,
  );
  const byAspect = (aspect) =>
    changes
      .filter((c) => c.aspect === aspect)
      .map((c) => JSON.parse(c.valueJson));
  const schemas = byAspect("schemaMetadata"),
    fields = byAspect("inputFields");
  assert.equal(schemas.length, 7);
  assert.equal(fields.length, 7);
  assert.equal(
    schemas.reduce((n, c) => n + c.fields.length, 0),
    14,
  );
  assert.equal(
    fields.reduce((n, c) => n + c.fields.length, 0),
    14,
  );
  assert.equal(byAspect("upstreamLineage").length, 7);
  assert.equal(byAspect("chartInfo").length, 7);
  assert.equal(byAspect("dashboardInfo").length, 1);
  assert.equal(byAspect("dashboardInfo")[0].charts.length, 7);
  assert.equal(byAspect("containerProperties").length, 2);
  // Real Grafana metadata includes numeric folderId, not only folderUid.
  // Without it the native connector omits the dashboard-container parent edge.
  const containers = compiled.aspects.filter(
    (item) => item.aspect === "containerProperties",
  );
  const folder = containers.find(
    (item) => !item.value.customProperties.dashboard_id,
  );
  const dashboardContainer = containers.find(
    (item) => item.value.customProperties.dashboard_id,
  );
  assert.ok(folder && dashboardContainer);
  assert.equal(folder.value.customProperties.folder_id, "1");
  assert.equal(dashboardContainer.value.customProperties.folder_id, "1");
  const parents = new Map(
    compiled.aspects
      .filter((item) => item.aspect === "container")
      .map((item) => [item.urn, item.value.container]),
  );
  assert.equal(parents.size, 16);
  assert.equal(parents.get(dashboardContainer.urn), folder.urn);
  for (const urn of new Set(changes.map((change) => change.urn))) {
    if (urn !== folder.urn && urn !== dashboardContainer.urn)
      assert.equal(parents.get(urn), dashboardContainer.urn);
  }
});

test("sealed native artifact is reconstructed, with fresh source/Catalog binding and no ingestion replay", async () => {
  const compiled = compileFixture(false);
  const bytes = Buffer.from(JSON.stringify(compiled.mcps));
  const source = { dashboard: { uid: "fixture", version: 2 } };
  const catalog = { view: { schemaMetadata: { value: {}, version: "1" } } };
  const fixed = {
    ...binding,
    candidateDigest: createHash("sha256").update(bytes).digest("hex"),
    snapshotSha256: grafanaPublicationSnapshot(source, catalog),
    datasets: compiled.datasets,
  };
  const draft = compileGrafanaArtifact(bytes, fixed);
  assert.deepEqual(draft.changes, changesFrom(compiled));
  // MCPWrapper.make_mcp applies the official native wire conversion. Raw
  // aspect.to_obj() still has pegasus2avro schema names and is not this payload.
  const schema = JSON.parse(
    draft.changes.find((c) => c.aspect === "schemaMetadata").valueJson,
  );
  assert.ok(
    Object.hasOwn(schema.fields[0].type.type, "com.linkedin.schema.NumberType"),
  );
  assert.equal(JSON.stringify(schema).includes("pegasus2avro"), false);
  const chart = JSON.parse(
    draft.changes.find((c) => c.aspect === "chartInfo").valueJson,
  );
  assert.equal(typeof chart.inputs[0].string, "string"); // native PDL union, not flattened
  assert.ok(
    draft.changes.every((c) => c.expectedVersion === "-1" && !c.systemMetadata),
  );
  let sourceReads = 0,
    catalogReads = 0,
    active = true;
  const compiler = grafanaPublicationCompiler(bytes, fixed, {
    readSource: async () => {
      sourceReads++;
      return source;
    },
    readCatalog: async () => {
      catalogReads++;
      return catalog;
    },
    assertActive() {
      assert.ok(active, "revoked");
    },
  });
  const poisoned = structuredClone(draft);
  poisoned.changes[0].valueJson = "{}";
  assert.deepEqual(await compiler(poisoned), draft); // caller proposal is not the source
  assert.equal(sourceReads, 1);
  assert.equal(catalogReads, 1);
  const badBytes = Buffer.from(bytes);
  badBytes[0] = 0;
  assert.throws(
    () => compileGrafanaArtifact(badBytes, fixed),
    /grafana_artifact_changed/,
  );
  const malformed = Buffer.from("DO_NOT_ECHO_PRIVATE_FRAGMENT");
  assert.throws(
    () =>
      compileGrafanaArtifact(malformed, {
        ...fixed,
        candidateDigest: createHash("sha256").update(malformed).digest("hex"),
      }),
    (error) => error.message === "grafana_artifact_invalid_json",
  );
  bytes.fill(0);
  fixed.datasets.length = 0;
  assert.deepEqual(await compiler(draft), draft); // sealed input, not mutable caller state
  source.dashboard.version++;
  await assert.rejects(compiler(draft), /grafana_publication_snapshot_changed/);
  source.dashboard.version--;
  catalog.view.schemaMetadata.version = "2";
  await assert.rejects(compiler(draft), /grafana_publication_snapshot_changed/);
  catalog.view.schemaMetadata.version = "1";
  active = false;
  const reads = sourceReads;
  await assert.rejects(compiler(draft), /revoked/);
  assert.equal(sourceReads, reads);
});

test("default tags cannot enter LINEAGE even when batch count is below its limit", {
  timeout: 120000,
}, () => {
  const compiled = compileFixture(true);
  const changes = changesFrom(compiled);
  assert.equal(changes.length, 138);
  assert.throws(
    () =>
      makePublicationReview({
        ...binding,
        datasets: compiled.datasets,
        changes,
      }),
    /invalid_publication_changes/,
  );
  const tags = changes.filter((c) =>
    ["globalTags", "tagKey"].includes(c.aspect),
  );
  assert.equal(tags.length, 17);
  assert.deepEqual(
    tags.reduce((counts, c) => {
      counts[c.aspect] = (counts[c.aspect] ?? 0) + 1;
      return counts;
    }, {}),
    { globalTags: 15, tagKey: 2 },
  );
  assert.throws(
    () =>
      makePublicationReview({
        ...binding,
        datasets: compiled.datasets,
        changes: tags,
      }),
    /publication_change_outside_purpose/,
  );
  // Separate SEMANTIC preparation remains possible, not approved or published.
  validatePublicationReview(
    makePublicationReview({
      ...binding,
      purpose: "SEMANTIC",
      datasets: compiled.datasets,
      changes: tags,
    }),
    1000,
  );
});

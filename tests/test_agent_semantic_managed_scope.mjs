import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  exactMssqlInventory,
  readManagedIngestionScope,
} from "../extensions/datahub-agent/integration/semantic-managed-scope.mjs";
import {
  nativeSemanticCatalog,
  parseCatalogRequest,
} from "../extensions/datahub-agent/integration/native-semantic-catalog.mjs";
import { projectManagedContractEvidence } from "../extensions/datahub-agent/integration/semantic-managed-evidence.mjs";

const recipe = JSON.parse(
  readFileSync(
    new URL(
      "../extensions/sales-datamart/metadata/target-ingestion.json",
      import.meta.url,
    ),
  ),
);
const clone = () => structuredClone(recipe);

test("closed SalesDatamart recipe enumerates six tables and one view, not a catalog search", () => {
  const urns = exactMssqlInventory(recipe);
  assert.equal(urns.length, 7);
  assert(
    urns.includes(
      "urn:li:dataset:(urn:li:dataPlatform:mssql,salesdatamart.dm.monthly_category_summary,PROD)",
    ),
  );
  assert(
    urns.includes(
      "urn:li:dataset:(urn:li:dataPlatform:mssql,salesdatamart.reporting.v_sales_order_line,PROD)",
    ),
  );
  assert.equal(new Set(urns).size, 7);
});

test("only pinned legacy contract lines whose subject is an exact scoped field become evidence", () => {
  // Test the legacy projection independently of the operator's active revision.
  // Fixed-file reads and scoped source pins are covered by contract-evidence tests.
  const bytes = Buffer.from("# Legacy fixture\n- `LineNetAmount = OrderQty * UnitPrice * (1 - UnitPriceDiscount)`\n");
  const policy = {
    urn: "urn:li:dataHubIngestionSource:c382a4fe-48a9-4a0b-893a-95029a74b25f",
    semanticEvidenceSha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const asset =
    "urn:li:dataset:(urn:li:dataPlatform:mssql,salesdatamart.dm.fact_sales_order_line,PROD)";
  const evidence = projectManagedContractEvidence(policy, asset, [
    { fieldPath: "linenetamount" },
    { fieldPath: "orderqty" },
    { fieldPath: "arbitrary" },
  ], bytes);
  assert.equal(evidence.length, 1);
  assert.equal(
    evidence[0].text,
    "LineNetAmount = OrderQty * UnitPrice * (1 - UnitPriceDiscount)",
  );
  assert.equal(evidence[0].provenance.sha256, policy.semanticEvidenceSha256);
  assert.throws(() =>
    projectManagedContractEvidence(
      { ...policy, semanticEvidenceSha256: "0".repeat(64) },
      asset,
      [{ fieldPath: "linenetamount" }],
      bytes,
    ),
  );
  assert.throws(() =>
    projectManagedContractEvidence(
      { ...policy, urn: "urn:li:dataHubIngestionSource:other" },
      asset,
      [{ fieldPath: "linenetamount" }],
      bytes,
    ),
  );
});

test("managed scope intent accepts only its fixed read-only selectors", () => {
  const r = {
    action: "inspect_managed_scope",
    contract: "catalog/1",
    requestId: "00000000-0000-0000-0000-000000000001",
    sourceUrn:
      "urn:li:dataHubIngestionSource:00000000-0000-0000-0000-000000000001",
  };
  assert.deepEqual(parseCatalogRequest(r), r);
  assert.throws(() =>
    parseCatalogRequest({ ...r, assetUrn: "urn:li:dataset:forged" }),
  );
  assert.throws(() =>
    parseCatalogRequest({ ...r, snapshotDigest: "0".repeat(64) }),
  );
  assert.throws(() => parseCatalogRequest({ ...r, contract: undefined }));
});

function fixture() {
  const sourceUrn =
    "urn:li:dataHubIngestionSource:00000000-0000-0000-0000-000000000001";
  const executionUrn =
    "urn:li:dataHubExecutionRequest:00000000-0000-0000-0000-000000000002";
  const recipeText = JSON.stringify(recipe),
    members = exactMssqlInventory(recipe);
  const state = {
    status: "SUCCESS",
    recipeText,
    members,
    denied: new Set(),
    rows: new Map(),
  };
  state.rows.set(sourceUrn, {
    urn: sourceUrn,
    dataHubIngestionSourceInfo: {
      value: {
        name: "SalesDatamart",
        config: {
          recipe: recipeText,
          version: "1.7.0.9",
          executorId: "default",
        },
      },
      systemMetadata: { version: "1" },
    },
  });
  state.rows.set(executionUrn, {
    urn: executionUrn,
    dataHubExecutionRequestInput: {
      value: {
        task: "RUN_INGEST",
        source: { ingestionSource: sourceUrn },
        executorId: "default",
        args: {
          version: "1.7.0.9",
          recipe: JSON.stringify({
            ...recipe,
            run_id: executionUrn,
            pipeline_name: sourceUrn,
          }),
        },
      },
      systemMetadata: { version: "1" },
    },
    dataHubExecutionRequestResult: {
      value: { status: "SUCCESS" },
      systemMetadata: { version: "1" },
    },
  });
  for (const urn of members)
    state.rows.set(urn, {
      urn,
      datasetKey: { value: { name: urn } },
      schemaMetadata: {
        value: { fields: [{ fieldPath: "id" }, { fieldPath: "value" }] },
        systemMetadata: {
          version: "1",
          runId: executionUrn.split(":").at(-1),
          pipelineName: sourceUrn,
        },
      },
      status: { value: { removed: false } },
    });
  const actor = {
    urn: "urn:li:corpuser:datahub",
    key: "0".repeat(48),
    tenant: "ekop",
  };
  const policy = {
    urn: sourceUrn,
    cliVersion: "1.7.0.9",
    recipeSha256: createHash("sha256").update(recipeText).digest("hex"),
    semanticModelContextApproved: true,
    taskDatasets: members,
  };
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls++;
    assert.equal(options.method, "POST");
    assert.equal(url.origin, "http://localhost:9002");
    assert(!options.headers.Authorization);
    const body = JSON.parse(options.body);
    if (url.pathname === "/api/v2/graphql") {
      if (body.query.includes("query { me"))
        return Response.json({
          data: {
            me: {
              corpUser: { urn: actor.urn },
              platformPrivileges: { manageIngestion: true },
            },
          },
        });
      if (body.query.includes("getGrantedPrivileges"))
        return Response.json({
          data: {
            getGrantedPrivileges: {
              privileges: state.denied.has(
                body.variables.input.resourceSpec.resourceUrn,
              )
                ? []
                : ["VIEW_ENTITY_PAGE"],
            },
          },
        });
      if (body.query.includes("latestSuccessfulExecution"))
        return Response.json({
          data: {
            ingestionSource: {
              urn: sourceUrn,
              latestSuccessfulExecution: { urn: executionUrn },
            },
          },
        });
    }
    if (url.pathname.endsWith("/batchGet"))
      return Response.json([state.rows.get(body[0].urn)].filter(Boolean));
    throw Error("unexpected native request");
  };
  const context = {
    actor,
    sources: [policy],
    frontendOrigin: "http://localhost:9002",
    cookieHeader: "PLAY_SESSION=synthetic; actor=synthetic",
    assertActive() {},
    fetchImpl,
  };
  return {
    state,
    policy,
    context,
    sourceUrn,
    executionUrn,
    get calls() {
      return calls;
    },
  };
}

test("success Run, exact recipe and every current schema bind one seven-Dataset scope", async () => {
  const f = fixture();
  const value = await readManagedIngestionScope(f.context, f.sourceUrn);
  assert.equal(value.datasetCount, 7);
  assert.equal(value.fieldCount, 14);
  assert.equal(
    value.scopeBasis,
    "successful_run_exact_recipe_and_current_schema",
  );
  assert.equal(value.checkpointVerified, false);
  assert.equal(value.fullDatabaseInventory, false);
  assert.match(value.fingerprint, /^[a-f0-9]{64}$/);
  assert(f.calls > 10);
});

test("native Catalog Host returns a read-only managed scope projection", async () => {
  const f = fixture();
  const value = await nativeSemanticCatalog(
    {
      action: "inspect_managed_scope",
      contract: "catalog/1",
      requestId: "00000000-0000-0000-0000-000000000003",
      sourceUrn: f.sourceUrn,
    },
    f.context,
  );
  assert.equal(value.format, "datahub-semantic.preview/1");
  assert.equal(value.publicationAuthorized, false);
  assert.equal(
    value.managedCycle,
    null,
    "without an explicit write policy, the same source remains read-only",
  );
  assert.equal(value.scope.datasetCount, 7);
  assert.equal(value.scope.fieldCount, 14);
});

test("source pin, ACL, Run outcome, incomplete ceiling and current schema drift fail closed", async () => {
  for (const change of [
    (f) => {
      f.policy.recipeSha256 = "f".repeat(64);
    },
    (f) => {
      f.state.denied.add(f.state.members[0]);
    },
    (f) => {
      f.state.rows.get(
        f.executionUrn,
      ).dataHubExecutionRequestResult.value.status = "FAILED";
    },
    (f) => {
      f.policy.taskDatasets = f.policy.taskDatasets.slice(1);
    },
    (f) => {
      f.state.rows.get(f.state.members[0]).schemaMetadata.systemMetadata.runId =
        "old";
    },
    (f) => {
      f.state.rows
        .get(f.state.members[0])
        .schemaMetadata.value.fields.push({ fieldPath: "id" });
    },
  ]) {
    const f = fixture();
    change(f);
    await assert.rejects(readManagedIngestionScope(f.context, f.sourceUrn));
  }
});

test("wildcards, loose regex, excludes, broad database and ambiguous normalization are not complete scopes", () => {
  const cases = [
    (x) => {
      x.source.config.table_pattern.allow = ["^salesdatamart\\.dm\\..*$"];
    },
    (x) => {
      x.source.config.table_pattern.allow = [
        "^salesdatamart\\.dm\\.(fact|dim_.*)$",
      ];
    },
    (x) => {
      x.source.config.table_pattern.deny = ["bad"];
    },
    (x) => {
      x.source.config.database_pattern.allow = [".*"];
    },
    (x) => {
      x.source.config.convert_urns_to_lowercase = false;
    },
    (x) => {
      x.source.config.schema_pattern.allow = ["^dm$", "^dm$"];
    },
    (x) => {
      x.source.config.table_pattern.allow.push(
        x.source.config.table_pattern.allow[0],
      );
    },
    (x) => {
      x.source.config.env = "DEV";
    },
    (x) => {
      x.source.type = "oracle";
    },
    (x) => {
      x.source.config.stateful_ingestion = { enabled: true };
    },
  ];
  for (const mutate of cases) {
    const value = clone();
    mutate(value);
    assert.throws(() => exactMssqlInventory(value), {
      message: "semantic_managed_scope_unverified",
    });
  }
});

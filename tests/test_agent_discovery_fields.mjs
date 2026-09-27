import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  discoveryPolicies,
  assertWorkspaceAdoption,
  prepareWorkspacePublication,
  nativeDiscovery,
  analyzeDiscovery,
  compileDiscoveryPublication,
  discoveryPublicationCompiler,
  preserveDiscoveryJobIO,
  readDiscoveryCatalog,
  readWorkspaceBiCatalog,
} from "../extensions/datahub-agent/integration/native-discovery.mjs";
import {
  makePublicationReview,
  canonicalPublicationJson,
} from "../extensions/datahub-agent/integration/publication-review.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const python = join(repo, ".venv/bin/python");
const actor = {
  tenant: "fixture",
  urn: "urn:li:corpuser:fixture",
  key: "a".repeat(48),
};
const requestId = "00000000-0000-4000-8000-000000000001";
const request = (extra = {}) =>
  JSON.stringify({
    requestId,
    action: "analyze",
    sourceId: "field-fixture",
    ...extra,
  });

async function fixture(t, changes = []) {
  const root = await mkdtemp("/tmp/discovery-fields-");
  t.after(() => rm(root, { recursive: true }));
  const script = [
    "import sys,json,dataclasses",
    "from pathlib import Path",
    "sys.path.insert(0,sys.argv[1]);sys.path.insert(0,sys.argv[1]+'/extensions/dataflow-discovery/src')",
    "from tests.test_dataflow_discovery_python_record_consumers import PROGRAM",
    "from tests.test_dataflow_discovery_catalog import Reader,scope,urn",
    "from datahub.metadata.schema_classes import DatasetKeyClass,StatusClass,SchemaMetadataClass",
    "from dataflow_discovery.host import capture_and_analyze",
    "from dataflow_discovery.python_catalog import bind_python_sql_dependencies",
    "root=Path(sys.argv[2])",
    "for old,new in json.loads(sys.argv[3]): PROGRAM=PROGRAM.replace(old,new)",
    "(root/'case.py').write_text(PROGRAM+'\\nraise RuntimeError(\"captured source must not execute\")\\n')",
    "c=capture_and_analyze(str(root),['case.py'],source_id='field-fixture')",
    "r=Reader()",
    "d=bind_python_sql_dependencies(c.analysis,c.snapshot,path='case.py',entrypoint='run',scopes_by_context={},reader=r)",
    "p={'sourceId':'field-fixture','root':str(root),'paths':['case.py'],'snapshotSha256':c.snapshot.sha256,'modelContextApproved':True,'pythonAnalysis':{'path':'case.py','entrypoint':'run','modelContextApproved':True,'scopesByContext':{x['context_id']:dataclasses.asdict(scope()) for x in d['contexts']}}}",
    "catalog={urn():{kind.ASPECT_NAME:{'value':r.get_aspect(urn(),kind).to_obj(),'version':'1'} for kind in (DatasetKeyClass,StatusClass,SchemaMetadataClass)}}",
    "print(json.dumps({'policy':p,'catalog':catalog}))",
  ].join("\n");
  const data = JSON.parse(
    execFileSync(
      python,
      ["-I", "-B", "-c", script, repo, root, JSON.stringify(changes)],
      {
        encoding: "utf8",
        env: {
          PATH: "/usr/bin:/bin",
          HOME: "/dev/null",
          DATAHUB_TELEMETRY_ENABLED: "false",
        },
      },
    ),
  );
  const sources = discoveryPolicies({ [actor.key]: [data.policy] }).get(
    actor.key,
  );
  const calls = [];
  const options = {
    actor,
    sources,
    frontendOrigin: "http://fixture.invalid",
    cookieHeader: "PLAY_SESSION=fixture; actor=urn:li:corpuser:fixture",
    assertActive() {},
    async fetchImpl(url, init) {
      assert.equal(url.origin, "http://fixture.invalid");
      assert.equal(init.method, "POST");
      assert.equal(init.redirect, "manual");
      assert.equal(
        init.headers.cookie,
        "PLAY_SESSION=fixture; actor=urn:li:corpuser:fixture",
      );
      const body = JSON.parse(init.body);
      calls.push({ path: url.pathname, body });
      if (url.pathname === "/api/v2/graphql") {
        if (body.query.includes("getGrantedPrivileges")) {
          assert.equal(body.variables.input.actorUrn, actor.urn);
          assert.ok(
            data.catalog[body.variables.input.resourceSpec.resourceUrn],
          );
          return Response.json({
            data: { getGrantedPrivileges: { privileges: ["GET_ENTITY"] } },
          });
        }
        return Response.json({
          data: { me: { corpUser: { urn: actor.urn } } },
        });
      }
      assert.equal(url.pathname, "/openapi/v3/entity/dataset/batchGet");
      assert.equal(url.search, "?systemMetadata=true");
      assert.deepEqual(
        body.map((item) => item.urn).sort(),
        Object.keys(data.catalog).sort(),
      );
      for (const item of body)
        assert.deepEqual(Object.keys(item).sort(), [
          "datasetKey",
          "schemaMetadata",
          "status",
          "urn",
        ]);
      return Response.json(
        Object.entries(data.catalog).map(([urn, aspects]) => ({
          urn,
          ...Object.fromEntries(
            Object.entries(aspects).map(([name, value]) => [
              name,
              {
                value: value.value,
                systemMetadata: { version: value.version },
              },
            ]),
          ),
        })),
      );
    },
  };
  return { ...data, root, calls, options };
}

test("scoped source-to-Job compilation crosses the real bridge and rechecks Host Catalog", async (t) => {
  const f = await fixture(t);
  const code = [
    "import sys,json,shutil,dataclasses",
    "from pathlib import Path",
    "sys.path.insert(0,sys.argv[1]);sys.path.insert(0,sys.argv[1]+'/extensions/dataflow-discovery/src')",
    "from tests.test_dataflow_discovery_publisher import PythonResourcePublicationTests",
    "f=PythonResourcePublicationTests();f.setUp()",
    "try:",
    " plan=f.plan()",
    " shutil.copyfile(f.root/'job.py',Path(sys.argv[2])/'job.py')",
    " scopes={key:dataclasses.asdict(value) for key,value in f.context['scopes_by_context'].items()}",
    " policy={'sourceId':plan.source_id,'root':sys.argv[2],'paths':['job.py'],'snapshotSha256':plan.snapshot_sha256,'modelContextApproved':True,'pythonAnalysis':{'path':'job.py','entrypoint':'run','modelContextApproved':True,'scopesByContext':scopes}}",
    " catalog={}",
    " for (urn,kind),value in f.reader.aspects.items(): catalog.setdefault(urn,{})[kind.ASPECT_NAME]={'value':value.to_obj(),'version':'1'}",
    " print(json.dumps({'policy':policy,'plan':plan.to_dict(),'catalog':catalog}))",
    "finally: f.doCleanups()",
  ].join("\n");
  const data = JSON.parse(
    execFileSync(python, ["-I", "-B", "-c", code, repo, f.root], {
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 131072,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: "/dev/null",
        DATAHUB_TELEMETRY_ENABLED: "false",
      },
    }),
  );
  const [policy] = discoveryPolicies({ [actor.key]: [data.policy] }).get(
    actor.key,
  );
  for (const urn of Object.keys(f.catalog)) delete f.catalog[urn];
  Object.assign(f.catalog, data.catalog);
  await assert.rejects(
    compileDiscoveryPublication(policy, data.plan),
    /discovery_publication_rejected/,
  );
  const compiled = await compileDiscoveryPublication(
    policy,
    data.plan,
    f.catalog,
  );
  const io = compiled.aspects.find(
    (item) => item.aspect === "dataJobInputOutput",
  ).value;
  assert.deepEqual(io.inputDatasets, [
    "urn:li:dataset:(urn:li:dataPlatform:mssql,lab.dbo.orders,PROD)",
  ]);
  assert.deepEqual(io.outputDatasets, [
    "urn:li:dataset:(urn:li:dataPlatform:mssql,target.dbo.receivedevents,PROD)",
  ]);
  assert.equal(compiled.publicationAuthorized, false);
  const { format, aspects, publicationAuthorized, ...binding } = compiled;
  assert.equal(format, "dataflow-discovery.compiled-aspects/1");
  assert.equal(publicationAuthorized, false);
  const sourceUrn = `urn:li:dataHubIngestionSource:${requestId}`;
  const review = makePublicationReview({
    ...binding,
    source: sourceUrn,
    purpose: "LINEAGE",
    expiresAt: 10000,
    changes: aspects.map(({ urn, aspect, value }) => ({
      urn,
      aspect,
      expectedVersion: "-1",
      valueJson: canonicalPublicationJson(value),
    })),
  });
  const recompile = discoveryPublicationCompiler(
    policy,
    data.plan,
    sourceUrn,
    f.options,
  );
  assert.deepEqual(await recompile(review), review);
  assert.equal(f.calls.length, 5); // fresh actor, two grants, Catalog, actor
  assert.deepEqual(await recompile(review), review);
  assert.equal(f.calls.length, 10); // no stale Catalog reuse at admission/write
  const ioAspect = aspects.find((item) => item.aspect === "dataJobInputOutput");
  const before = {
    inputDatasets: [],
    inputDatasetEdges: [],
    outputDatasets: [],
    outputDatasetEdges: [
      {
        destinationUrn: io.outputDatasets[0],
        properties: { "discovery.evidenceKind": "STATIC_DIRECT_SQL" },
      },
    ],
    fineGrainedLineages: [],
  };
  const targets = new Map([
    [
      ioAspect.urn,
      {
        dataJobInputOutput: {
          value: before,
          systemMetadata: { version: "1" },
        },
      },
    ],
  ]);
  const preserved = preserveDiscoveryJobIO(io, before);
  assert.deepEqual(preserved.outputDatasetEdges, before.outputDatasetEdges);
  assert.deepEqual(preserved.inputDatasetEdges, [
    { destinationUrn: io.inputDatasets[0] },
  ]);
  assert.deepEqual(before.inputDatasetEdges, []); // preparation never mutates the observation
  const { planDigest: _oldDigest, ...reviewBinding } = review;
  const update = makePublicationReview({
    ...reviewBinding,
    changes: [
      {
        urn: ioAspect.urn,
        aspect: ioAspect.aspect,
        expectedVersion: "1",
        valueJson: canonicalPublicationJson(preserved),
      },
    ],
  });
  assert.deepEqual(await recompile(update, targets), update);
  // Initial SDK replacement would erase native output edge evidence.
  const replacement = makePublicationReview({
    ...reviewBinding,
    changes: [
      {
        ...update.changes[0],
        valueJson: canonicalPublicationJson(io),
      },
    ],
  });
  await assert.rejects(
    recompile(replacement, targets),
    /discovery_publication_rejected/,
  );
  before.outputDatasetEdges[0].properties["discovery.evidenceKind"] =
    "manual revision";
  await assert.rejects(
    recompile(update, targets),
    /discovery_publication_rejected/,
  );
  assert.equal(f.calls.length, 25);
  const source = f.catalog[io.inputDatasets[0]];
  source.status.value.removed = true;
  source.status.version = "2";
  await assert.rejects(recompile(review), /discovery_publication_rejected/);
  assert.equal(f.calls.length, 30);
  source.status.value.removed = false;
  f.options.assertActive = () => {
    throw Error("grant revoked");
  };
  await assert.rejects(recompile(review), /grant revoked/);
  assert.equal(f.calls.length, 30);
  assert.ok(!JSON.stringify(compiled).includes("PLAY_SESSION"));
});

test("table I/O preparation preserves native representations and rejects unsupported removals", () => {
  const a = "urn:li:dataset:a",
    b = "urn:li:dataset:b";
  const desired = { inputDatasets: [a, b], outputDatasets: [b] };
  const legacy = {
    inputDatasets: [a],
    outputDatasets: [b],
    fineGrainedLineages: [],
  };
  assert.deepEqual(preserveDiscoveryJobIO(desired, legacy), {
    ...legacy,
    inputDatasets: [a, b],
  });
  assert.deepEqual(legacy.inputDatasets, [a]);
  const mixed = {
    ...legacy,
    inputDatasetEdges: [{ destinationUrn: a, properties: { note: "keep" } }],
  };
  assert.deepEqual(preserveDiscoveryJobIO(desired, mixed), {
    ...mixed,
    inputDatasetEdges: [...mixed.inputDatasetEdges, { destinationUrn: b }],
  });
  for (const value of [
    { inputDatasets: [], outputDatasets: [b] },
    { ...desired, fineGrainedLineages: [] },
    { ...desired, inputDatasets: null },
  ])
    assert.throws(
      () => preserveDiscoveryJobIO(value, legacy),
      /preservation_conflict/,
    );
  for (const current of [
    { ...legacy, inputDatasetEdges: null },
    { ...legacy, inputDatasetEdges: [{}] },
  ])
    assert.throws(
      () => preserveDiscoveryJobIO(desired, current),
      /preservation_conflict/,
    );
});

test("existing analyze intent invokes fresh Host Catalog and real isolated field analysis", async (t) => {
  const f = await fixture(t);
  const page = await nativeDiscovery(request({ limit: 1 }), f.options);
  assert.equal(page.format, "dataflow-discovery.agent-python-fields/2");
  assert.equal(page.counts.fieldDeclarations, 1);
  const slot = page.candidates[0].declaration;
  assert.equal(slot.field_path, "amount");
  const [link] = slot.record_consumer.links;
  assert.equal(link.origins[0].field_path, "amount");
  assert.equal(link.consumer_role, "value");
  assert.equal(link.runtime_value_verified, false);
  assert.equal(page.validation.status, "INCONCLUSIVE");
  assert.equal(page.publicationAuthorized, false);
  assert.notEqual(page.candidateDigest, page.baseCandidateDigest);
  assert.equal(page.requestId, requestId);
  assert.equal(f.calls.length, 4); // actor / exact grant / three aspects / actor
  assert.ok(!JSON.stringify(page).includes(f.root));
  assert.ok(!JSON.stringify(page).includes("PLAY_SESSION"));
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 44000);
  const next = await nativeDiscovery(
    request({
      offset: page.nextOffset,
      limit: 1,
      candidateDigest: page.candidateDigest,
    }),
    f.options,
  );
  assert.equal(next.candidateDigest, page.candidateDigest);
  assert.equal(next.candidates[0].kind, "sql_context");
  assert.equal(f.calls.length, 8); // no cross-page Catalog cache
});

test("workspace publication refuses an unbound identity before native reads", async () => {
  let calls = 0;
  await assert.rejects(
    prepareWorkspacePublication(
      { sourceId: "case", workspace: true, catalogScopes: {} },
      { connections: {} },
      undefined,
      {
        fetchImpl() {
          calls++;
          throw Error("unexpected native request");
        },
      },
    ),
    /workspace_identity_policy_required/,
  );
  assert.equal(calls, 0);
});

test("adoption requires every existing native key, info, I/O and matching source ownership", () => {
  const flow = "urn:li:dataFlow:(python,existing_etl,PROD)";
  const job = `urn:li:dataJob:(${flow},load)`;
  const policy = {
    sourceId: "case",
    adoption: {
      snapshotSha256: "a".repeat(64),
      flowUrn: flow,
      jobs: { load: job },
      nativeVersions: {
        [flow]: { dataFlowKey: "1", dataFlowInfo: "1" },
        [job]: { dataJobKey: "1", dataJobInfo: "1", dataJobInputOutput: "1" },
      },
      relatedCatalogUrns: [],
    },
  };
  const compiled = {
    flowUrn: flow,
    snapshotSha256: "a".repeat(64),
    jobUrns: { load: job },
    aspects: [
      { urn: flow, aspect: "dataFlowInfo" },
      { urn: job, aspect: "dataJobInfo" },
      { urn: job, aspect: "dataJobInputOutput" },
    ],
  };
  const aspect = (value) => ({ value, systemMetadata: { version: "1" } });
  const observed = new Map([
    [
      flow,
      {
        dataFlowKey: aspect({}),
        dataFlowInfo: aspect({
          customProperties: { "discovery.sourceId": "case" },
        }),
      },
    ],
    [
      job,
      {
        dataJobKey: aspect({}),
        dataJobInfo: aspect({
          customProperties: { "discovery.sourceId": "case" },
        }),
        dataJobInputOutput: aspect({ inputDatasets: [] }),
      },
    ],
  ]);
  assert.doesNotThrow(() =>
    assertWorkspaceAdoption(policy, compiled, observed),
  );
  const rejects = (candidate, native = observed) =>
    assert.throws(
      () => assertWorkspaceAdoption(policy, candidate, native),
      /workspace_adoption_conflict/,
    );
  rejects({ ...compiled, snapshotSha256: "b".repeat(64) });
  rejects({
    ...compiled,
    jobUrns: {
      extra: "urn:li:dataJob:(urn:li:dataFlow:(python,other,PROD),extra)",
    },
  });
  rejects({
    ...compiled,
    aspects: [
      ...compiled.aspects,
      {
        urn: "urn:li:dataJob:(urn:li:dataFlow:(python,other,PROD),extra)",
        aspect: "dataJobInfo",
      },
    ],
  });
  rejects(compiled, new Map([[flow, observed.get(flow)]]));
  rejects(
    compiled,
    new Map([
      [flow, observed.get(flow)],
      [
        job,
        {
          ...observed.get(job),
          dataJobInfo: aspect({ customProperties: {} }),
        },
      ],
    ]),
  );
  rejects(
    compiled,
    new Map([
      [flow, observed.get(flow)],
      [job, { ...observed.get(job), dataJobInputOutput: undefined }],
    ]),
  );
  rejects(
    compiled,
    new Map([
      [flow, observed.get(flow)],
      [
        job,
        {
          ...observed.get(job),
          dataJobInfo: aspect({
            customProperties: { "discovery.sourceId": "another" },
          }),
        },
      ],
    ]),
  );
  rejects(
    compiled,
    new Map([
      [flow, observed.get(flow)],
      [
        job,
        {
          ...observed.get(job),
          dataJobKey: { value: {}, systemMetadata: { version: "0" } },
        },
      ],
    ]),
  );
});

test("workspace adoption is operator-owned, exact-source and same-flow only", () => {
  const flow = "urn:li:dataFlow:(python,existing_etl,PROD)";
  const base = {
    sourceId: "case",
    root: "/tmp/dataflow-workspace",
    workspace: true,
    modelContextApproved: true,
    catalogScopes: {
      target: {
        database: "SalesDatamart",
        default_schema: "dm",
        env: "PROD",
        lowercase_urns: true,
        lowercase_fields: true,
        allowed_dataset_urns: [
          "urn:li:dataset:(urn:li:dataPlatform:mssql,SalesDatamart.dm.fact,PROD)",
        ],
      },
    },
    adoption: {
      snapshotSha256: "a".repeat(64),
      flowUrn: flow,
      jobs: { load: `urn:li:dataJob:(${flow},load)` },
      nativeVersions: {
        [flow]: { dataFlowKey: "1", dataFlowInfo: "1" },
        [`urn:li:dataJob:(${flow},load)`]: {
          dataJobKey: "1",
          dataJobInfo: "1",
          dataJobInputOutput: "2",
        },
      },
      evidenceOnly: ["extract"],
      relatedCatalogUrns: [
        "urn:li:dataset:(urn:li:dataPlatform:grafana,case.panel.1,PROD)",
      ],
    },
  };
  const [accepted] = discoveryPolicies({ [actor.key]: [base] }).get(actor.key);
  assert.equal(accepted.adoption.jobs.load, base.adoption.jobs.load);
  assert.equal(Object.isFrozen(accepted.adoption.jobs), true);
  for (const bad of [
    { ...base.adoption, snapshotSha256: "invalid" },
    { ...base.adoption, flowUrn: "urn:li:dataFlow:(python,other,DEV)" },
    {
      ...base.adoption,
      jobs: {
        load: `urn:li:dataJob:(urn:li:dataFlow:(python,other,PROD),load)`,
      },
    },
    { ...base.adoption, evidenceOnly: ["load"] },
    { ...base.adoption, evidenceOnly: ["extract", "extract"] },
    { ...base.adoption, relatedCatalogUrns: ["urn:li:dataset:unrelated"] },
    {
      ...base.adoption,
      relatedCatalogUrns: [
        base.adoption.relatedCatalogUrns[0],
        base.adoption.relatedCatalogUrns[0],
      ],
    },
    { ...base.adoption, jobs: { load: "urn:li:dataJob:(other,load)" } },
    {
      ...base.adoption,
      nativeVersions: { [flow]: { dataFlowKey: "1", dataFlowInfo: "1" } },
    },
    {
      ...base.adoption,
      nativeVersions: {
        ...base.adoption.nativeVersions,
        [flow]: { dataFlowKey: "0", dataFlowInfo: "1" },
      },
    },
  ]) {
    assert.throws(
      () => discoveryPolicies({ [actor.key]: [{ ...base, adoption: bad }] }),
      /invalid_discovery_policy/,
    );
  }
});

test("fresh Catalog checks do not share an expired request timeout", async (t) => {
  const f = await fixture(t);
  const originalTimeout = AbortSignal.timeout;
  let firstController;
  let signalCount = 0;
  AbortSignal.timeout = () => {
    const controller = new AbortController();
    if (++signalCount === 1) firstController = controller;
    return controller.signal;
  };
  try {
    const fetchImpl = f.options.fetchImpl;
    const catalog = await readDiscoveryCatalog(f.policy, {
      ...f.options,
      async fetchImpl(url, init) {
        // The first response has completed, but its request budget has expired
        // by the time the next sequential ACL request begins.
        if (f.calls.length === 1) firstController.abort();
        if (init.signal.aborted) throw Error("expired previous request");
        return fetchImpl(url, init);
      },
    });
    assert.deepEqual(Object.keys(catalog), Object.keys(f.catalog));
    assert.equal(f.calls.length, 4); // actor / grant / batch / actor
    assert.equal(signalCount, f.calls.length);
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
});

test("malformed native BI response is a bounded Catalog rejection", async () => {
  await assert.rejects(
    readWorkspaceBiCatalog(
      [{ kind: "panel", dashboardUid: "one", datasourceUid: "two", id: 1 }],
      {
        actor,
        frontendOrigin: "http://fixture.invalid",
        cookieHeader: "PLAY_SESSION=fixture; actor=urn:li:corpuser:fixture",
        assertActive() {},
        async fetchImpl() {
          return new Response("malformed body");
        },
      },
    ),
    /workspace_bi_catalog_rejected/,
  );
});

test("operator-pinned BI URNs read only exact assets and reject unrelated native values", async () => {
  const urn = "urn:li:dataset:(urn:li:dataPlatform:grafana,case.panel.1,PROD)";
  const requests = [
    { kind: "panel", dashboardUid: "d", datasourceUid: "s", id: 1 },
  ];
  const calls = [];
  let changed = false;
  const context = {
    actor,
    frontendOrigin: "http://fixture.invalid",
    cookieHeader: "PLAY_SESSION=fixture; actor=urn:li:corpuser:fixture",
    assertActive() {},
    async fetchImpl(url, init) {
      calls.push(url.pathname);
      const body = JSON.parse(init.body);
      if (url.pathname === "/api/v2/graphql") {
        assert.ok(body.query.includes("getGrantedPrivileges"));
        assert.equal(body.variables.input.resourceSpec.resourceUrn, urn);
        return Response.json({
          data: { getGrantedPrivileges: { privileges: ["GET_ENTITY"] } },
        });
      }
      assert.equal(url.pathname, "/openapi/v3/entity/dataset/batchGet");
      assert.deepEqual(
        body.map((item) => item.urn),
        [urn],
      );
      const names = [
        "datasetProperties",
        "schemaMetadata",
        "upstreamLineage",
        "viewProperties",
        "status",
      ];
      assert.deepEqual(Object.keys(body[0]).sort(), ["urn", ...names].sort());
      return Response.json([
        {
          urn,
          ...Object.fromEntries(
            names.map((name) => [
              name,
              {
                value:
                  name === "datasetProperties"
                    ? {
                        customProperties: {
                          type: "mssql",
                          dashboard_uid: "d",
                          datasource_uid: changed ? "other" : "s",
                          panel_id: "1",
                        },
                      }
                    : {},
                systemMetadata: { version: "1" },
              },
            ]),
          ),
        },
      ]);
    },
  };
  const result = await readWorkspaceBiCatalog(requests, context, [urn]);
  assert.equal(result.length, 1);
  assert.deepEqual(calls, [
    "/api/v2/graphql",
    "/openapi/v3/entity/dataset/batchGet",
  ]);
  changed = true;
  await assert.rejects(
    readWorkspaceBiCatalog(requests, context, [urn]),
    /workspace_bi_catalog_incomplete/,
  );
  await assert.rejects(
    readWorkspaceBiCatalog(requests, context, [urn, urn]),
    /workspace_bi_catalog_rejected/,
  );
});

test("invalidated payload declarations survive the real bridge as prior-only evidence", async (t) => {
  const f = await fixture(t, [
    [
      '    conn.execute("UPDATE',
      '    opaque(payload)\n    conn.execute("UPDATE',
    ],
  ]);
  const first = await nativeDiscovery(request({ limit: 1 }), f.options);
  const slot = first.candidates[0].declaration;
  assert.equal(slot.parameter_declaration_status, "PRIOR_DECLARATIONS_ONLY");
  assert.ok(slot.python_declarations.length);
  assert.ok(
    slot.python_declarations.every((d) =>
      d.collection_findings.includes("object_escape_effects_unverified"),
    ),
  );
  assert.ok(slot.record_consumer.links.length);
  assert.ok(
    slot.record_consumer.links.every(
      (link) =>
        link.consumer_role === "prior_declaration" &&
        link.chain_findings.includes("object_escape_effects_unverified"),
    ),
  );
  assert.equal(first.validation.status, "INCONCLUSIVE");
  assert.equal(first.publicationAuthorized, false);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) < 44000);
  const next = await nativeDiscovery(
    request({
      offset: first.nextOffset,
      limit: 1,
      candidateDigest: first.candidateDigest,
    }),
    f.options,
  );
  assert.equal(next.candidateDigest, first.candidateDigest);
  assert.equal(f.calls.length, 8);
  assert.ok(!JSON.stringify(first).includes("PLAY_SESSION"));
});

test("Catalog versions bind pages even when source and Aspect values are unchanged", async (t) => {
  const f = await fixture(t);
  const first = await nativeDiscovery(request({ limit: 1 }), f.options);
  Object.values(f.catalog)[0].schemaMetadata.version = "2";
  await assert.rejects(
    nativeDiscovery(
      request({ offset: 1, candidateDigest: first.candidateDigest }),
      f.options,
    ),
    /analysis_drift/,
  );
  const fresh = await nativeDiscovery(request({ limit: 1 }), f.options);
  assert.notEqual(first.candidateDigest, fresh.candidateDigest);
  assert.equal(first.baseCandidateDigest, fresh.baseCandidateDigest);
});

test("actor mismatch, denied Catalog grant, missing envelopes and duplicate entities fail closed", async (t) => {
  const f = await fixture(t);
  for (const mode of ["identity", "denied", "missing", "duplicate", "http"]) {
    let analysis = 0;
    const original = f.options.fetchImpl;
    const options = {
      ...f.options,
      async analyze() {
        analysis++;
        throw Error("must not run");
      },
      async fetchImpl(url, init) {
        const body = JSON.parse(init.body);
        if (mode === "identity")
          return Response.json({
            data: { me: { corpUser: { urn: "urn:li:corpuser:other" } } },
          });
        if (mode === "denied" && body.query?.includes("getGrantedPrivileges"))
          return Response.json({
            data: { getGrantedPrivileges: { privileges: [] } },
          });
        if (url.pathname.includes("batchGet")) {
          if (mode === "http")
            return new Response("private exception not returned", {
              status: 403,
            });
          const response = await original(url, init);
          const entries = await response.json();
          if (mode === "missing") delete entries[0].status;
          if (mode === "duplicate") entries.push(entries[0]);
          return Response.json(entries);
        }
        return original(url, init);
      },
    };
    await assert.rejects(
      nativeDiscovery(request(), options),
      /discovery_(identity_required|catalog_rejected)/,
    );
    assert.equal(analysis, 0);
  }
});

test("Host-only scopes/privacy/entrypoint; model cannot supply Catalog or source policy", async (t) => {
  const f = await fixture(t);
  for (const update of [
    { modelContextApproved: false },
    { path: "other.py" },
    { entrypoint: "run()" },
    { scopesByContext: {} },
    {
      scopesByContext: {
        forged: Object.values(f.policy.pythonAnalysis.scopesByContext)[0],
      },
    },
    { endpoint: "http://other" },
  ])
    assert.throws(
      () =>
        discoveryPolicies({
          [actor.key]: [
            {
              ...f.policy,
              pythonAnalysis: { ...f.policy.pythonAnalysis, ...update },
            },
          ],
        }),
      /invalid_discovery_policy/,
    );
  for (const extra of [
    { catalog: f.catalog },
    { pythonAnalysis: f.policy.pythonAnalysis },
    { entrypoint: "run" },
  ])
    await assert.rejects(
      nativeDiscovery(request(extra), f.options),
      /invalid_discovery_request/,
    );
  assert.equal(f.calls.length, 0);
  const config = f.options.sources[0].pythonAnalysis;
  assert.ok(Object.isFrozen(config.scopesByContext));
  assert.ok(
    Object.isFrozen(
      Object.values(config.scopesByContext)[0].allowed_dataset_urns,
    ),
  );
  await assert.rejects(
    analyzeDiscovery(f.policy, { offset: 0 }),
    /catalog_rejected/,
  );
});

test("source mutation rejects old approval; newly approved bytes still reject stale context IDs", async (t) => {
  const f = await fixture(t);
  const file = join(f.root, "case.py");
  await writeFile(
    file,
    (await readFile(file, "utf8")).replace("row.decoded}", "row.decoded * 2}"),
  );
  await assert.rejects(nativeDiscovery(request(), f.options), /source_drift/);
  const sha = execFileSync(
    python,
    [
      "-I",
      "-B",
      "-c",
      "import sys;sys.path.insert(0,sys.argv[1]);from dataflow_discovery.snapshot import capture_snapshot;print(capture_snapshot(sys.argv[2],['case.py'],source_id='field-fixture').sha256)",
      join(repo, "extensions/dataflow-discovery/src"),
      f.root,
    ],
    { encoding: "utf8" },
  ).trim();
  assert.notEqual(sha, f.policy.snapshotSha256);
  await assert.rejects(
    analyzeDiscovery({ ...f.policy, snapshotSha256: sha }, {}, f.catalog),
    /analysis_failed/,
  );
});

test("renamed helpers/records and changed transforms analyze from newly approved inputs", async (t) => {
  const original = await fixture(t);
  const first = await nativeDiscovery(request({ limit: 1 }), original.options);
  const changed = await fixture(t, [
    ["decoded", "renamed"],
    ["produce", "collect_rows"],
    ["row.renamed}", "row.renamed * 2}"],
  ]);
  const result = await nativeDiscovery(request({ limit: 1 }), changed.options);
  assert.notEqual(result.snapshotSha256, first.snapshotSha256);
  assert.notEqual(result.candidateDigest, first.candidateDigest);
  const [link] = result.candidates[0].declaration.record_consumer.links;
  assert.equal(link.record_field, "renamed");
  assert.equal(link.origins[0].field_path, "amount");
  assert.equal(link.runtime_value_verified, false);
  const nodes = [];
  for (
    let offset = result.sections.values;
    offset !== null && offset < result.sections.decoders;
  ) {
    const page = await nativeDiscovery(
      request({ offset, limit: 10, candidateDigest: result.candidateDigest }),
      changed.options,
    );
    nodes.push(
      ...page.candidates
        .filter((row) => row.graphId === "transport")
        .map((row) => row.node),
    );
    offset = page.nextOffset;
  }
  assert.ok(
    nodes.some(
      (node) =>
        node.kind === "binary_expression" &&
        node.operator === "Mult" &&
        node.semantics_verified === false,
    ),
  );
});

test("missing/removed Catalog does not invent fields; restored values recover valid analysis", async (t) => {
  const f = await fixture(t);
  const data = Object.values(f.catalog)[0];
  data.status.value.removed = true;
  const invalid = await nativeDiscovery(request(), f.options);
  assert.equal(invalid.counts.fieldDeclarations, 0);
  assert.equal(invalid.validation.status, "INCONCLUSIVE");
  assert.ok(
    invalid.candidates.some((row) =>
      row.context?.bindings?.some(
        (b) => b.reason === "catalog_status_missing_or_removed",
      ),
    ),
  );
  data.status.value.removed = false;
  const recovered = await nativeDiscovery(request(), f.options);
  assert.equal(recovered.counts.fieldDeclarations, 1);
  assert.notEqual(invalid.candidateDigest, recovered.candidateDigest);
  assert.equal(recovered.publicationAuthorized, false);
});

test("v1 declaration cursor is rejected on unchanged source and Catalog after the graph-scoped projection upgrade", async (t) => {
  const f = await fixture(t);
  const script = [
    "import sys,json",
    "sys.path.insert(0,sys.argv[1])",
    "from dataflow_discovery.host import capture_and_analyze",
    "from dataflow_discovery.catalog import MssqlScope,_digest",
    "from dataflow_discovery.python_lookup_values import bind_python_lookup_values",
    "d=json.load(sys.stdin);p=d['policy'];cat=d['catalog'];cfg=p['pythonAnalysis']",
    "c=capture_and_analyze(p['root'],p['paths'],source_id=p['sourceId'])",
    "class Reader:",
    " def get_aspect(self,urn,kind):return kind.from_obj(cat[urn][kind.ASPECT_NAME]['value'])",
    "scopes={k:MssqlScope(**{**v,'allowed_dataset_urns':tuple(v['allowed_dataset_urns'])}) for k,v in cfg['scopesByContext'].items()}",
    "r=bind_python_lookup_values(c.analysis,c.snapshot,path=cfg['path'],entrypoint=cfg['entrypoint'],scopes_by_context=scopes,reader=Reader())",
    "print(_digest({'report':r,'catalog':cat,'config':cfg}))",
  ].join("\n");
  const legacyDigest = execFileSync(
    python,
    ["-I", "-B", "-c", script, join(repo, "extensions/dataflow-discovery/src")],
    {
      input: JSON.stringify({ policy: f.policy, catalog: f.catalog }),
      encoding: "utf8",
      env: {
        PATH: "/usr/bin:/bin",
        HOME: "/dev/null",
        DATAHUB_TELEMETRY_ENABLED: "false",
      },
    },
  ).trim();
  await assert.rejects(
    nativeDiscovery(
      request({ offset: 1, candidateDigest: legacyDigest }),
      f.options,
    ),
    /analysis_drift/,
  );
  const fresh = await nativeDiscovery(request(), f.options);
  assert.equal(fresh.snapshotSha256, f.policy.snapshotSha256);
  assert.notEqual(fresh.candidateDigest, legacyDigest);
});

test("decoder helper exits and value refs remain accessible in their own graph, never the transport graph", async (t) => {
  const f = await fixture(t, [
    [
      "def decode(rows):",
      'def convert(value):\n    if value < 0:\n        raise ValueError("invalid")\n    return value * 2\ndef decode(rows):',
    ],
    ['Item(row["raw"])', 'Item(convert(row["raw"]))'],
  ]);
  const first = await nativeDiscovery(request({ limit: 1 }), f.options);
  assert.ok(
    first.decoderSections?.decode,
    "existing decoder evidence must survive Host pagination",
  );
  assert.equal(first.format, "dataflow-discovery.agent-python-fields/2");
  assert.equal(first.candidates[0].graphId, "transport");
  const pageAt = (offset, limit = 1) =>
    nativeDiscovery(
      request({ offset, limit, candidateDigest: first.candidateDigest }),
      f.options,
    );
  const query = (await pageAt(first.sections.contexts)).candidates[0];
  assert.equal(query.decoderGraphId, "decoder:decode");
  const section = first.decoderSections.decode;
  assert.equal(section.graphId, query.decoderGraphId);
  const summary = (await pageAt(section.report)).candidates[0];
  assert.equal(summary.kind, "decoder_report");
  assert.equal(summary.graphId, "decoder:decode");
  assert.ok(
    summary.report.helpers.some(
      (helper) =>
        helper.function === "convert" &&
        helper.raises.length === 1 &&
        helper.conditions.length === 1,
    ),
  );
  assert.equal(summary.report.transformation_semantics_verified, false);
  const reference = query.context.query_decoder.links[0].read_ref;
  const read = (await pageAt(section.values + Number(reference.split(":")[1])))
    .candidates[0];
  assert.equal(read.graphId, "decoder:decode");
  assert.equal(read.node.id, reference);
  assert.equal(read.node.kind, "mapping_field");
  const decoderZero = (await pageAt(section.values)).candidates[0];
  const transportZero = (await pageAt(first.sections.values)).candidates[0];
  assert.equal(decoderZero.node.id, transportZero.node.id);
  assert.notEqual(decoderZero.graphId, transportZero.graphId);
  assert.notEqual(decoderZero.node.kind, transportZero.node.kind);
  assert.equal(first.publicationAuthorized, false);
});

test("Host exposes normal-continuation assignment but never promotes a swallowed failure to that assignment", async (t) => {
  const digests = [];
  for (const [handler, kind] of [
    ["raise", "assignment"],
    ["pass", "unresolved"],
  ]) {
    const f = await fixture(t, [
      [
        "def decode(rows):",
        `def convert(value):\n    try:\n        result = value * 2\n    except TypeError:\n        ${handler}\n    return result\ndef decode(rows):`,
      ],
      ['Item(row["raw"])', 'Item(convert(row["raw"]))'],
    ]);
    const first = await nativeDiscovery(request({ limit: 1 }), f.options);
    const section = first.decoderSections.decode;
    const pageAt = (offset) =>
      nativeDiscovery(
        request({ offset, limit: 1, candidateDigest: first.candidateDigest }),
        f.options,
      );
    const summary = (await pageAt(section.report)).candidates[0];
    const returned = summary.report.helpers.find(
      (helper) => helper.function === "convert",
    ).returns[0];
    const row = (
      await pageAt(section.values + Number(returned.value_ref.split(":")[1]))
    ).candidates[0];
    assert.equal(row.graphId, "decoder:decode");
    assert.equal(row.node.id, returned.value_ref);
    assert.equal(row.node.kind, kind);
    if (handler === "pass")
      assert.equal(row.node.reason, "assignment_not_dominating");
    const expressionRef =
      row.node.value_ref ?? row.node.initial_declaration_ref;
    const expression = (
      await pageAt(section.values + Number(expressionRef.split(":")[1]))
    ).candidates[0];
    assert.equal(expression.node.operator, "Mult");
    assert.equal(summary.report.transformation_semantics_verified, false);
    assert.equal(first.validation.status, "INCONCLUSIVE");
    assert.equal(first.publicationAuthorized, false);
    digests.push(first.candidateDigest);
  }
  assert.notEqual(digests[0], digests[1]);
});

test("revocation during read or after analysis cannot return field results", async (t) => {
  const f = await fixture(t);
  let active = true;
  const original = f.options.fetchImpl;
  const options = {
    ...f.options,
    assertActive() {
      assert.ok(active, "revoked");
    },
    async fetchImpl(url, init) {
      const result = await original(url, init);
      if (url.pathname.includes("batchGet")) active = false;
      return result;
    },
  };
  await assert.rejects(
    nativeDiscovery(request(), options),
    /catalog_rejected|revoked/,
  );
  active = true;
  await assert.rejects(
    nativeDiscovery(request(), {
      ...f.options,
      assertActive() {
        assert.ok(active, "revoked");
      },
      async analyze() {
        active = false;
        return { candidates: ["not returned"] };
      },
    }),
    /revoked/,
  );
});

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  appendFileSync,
  rmSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  compileDiscoveryPublication,
  discoveryPublicationCompiler,
  nativeDiscovery,
  preserveDiscoveryJobIO,
} from "../extensions/datahub-agent/integration/native-discovery.mjs";
import {
  taskRecords,
  TaskRecordError,
} from "../extensions/datahub-agent/integration/task-records.mjs";
import { nativeTasks } from "../extensions/datahub-agent/integration/native-tasks.mjs";
import {
  compileGrafanaArtifact,
  grafanaPublicationCompiler,
  grafanaPublicationSnapshot,
} from "../extensions/datahub-agent/integration/native-grafana-publication.mjs";
import {
  makePublicationReview,
  validatePublicationReview,
  canonicalPublicationJson,
  PublicationReviewError,
} from "../extensions/datahub-agent/integration/publication-review.mjs";

import {
  makeFixedEtlReview,
  FIXED_ETL_DEFINITION_JSON,
} from "../extensions/datahub-agent/integration/fixed-etl-review.mjs";

test("fixed ETL operator grant is deny-by-default and actor/Run/code/expiry/exact-scope bound", async () => {
  const { fixedEtlPolicies } = await import(
    "../extensions/datahub-agent/integration/native-fixed-etl.mjs"
  );
  const key = "a".repeat(48),
    codeSha256 = "b".repeat(64),
    now = Date.now();
  const source = "urn:li:dataHubIngestionSource:case";
  const runUrn = `urn:li:dataProcessInstance:ekop-agent-${key}-00000000-0000-4000-8000-000000000001`;
  const datasets = [
    "adventureworks2019.production.product",
    "adventureworks2019.production.productcategory",
    "adventureworks2019.production.productsubcategory",
    "adventureworks2019.sales.customer",
    "adventureworks2019.sales.salesorderdetail",
    "adventureworks2019.sales.salesorderheader",
    "adventureworks2019.sales.salesterritory",
    "salesdatamart.dm.dim_customer",
    "salesdatamart.dm.dim_date",
    "salesdatamart.dm.dim_product",
    "salesdatamart.dm.dim_territory",
    "salesdatamart.dm.fact_sales_order_line",
    "salesdatamart.reporting.v_sales_order_line",
  ].map((name) => `urn:li:dataset:(urn:li:dataPlatform:mssql,${name},PROD)`);
  const sources = new Map([[key, [{ urn: source, taskDatasets: datasets }]]]);
  const grant = { source, runUrn, codeSha256, expiresAt: now + 600000 };
  assert.equal(fixedEtlPolicies({}, sources).size, 0);
  const policy = fixedEtlPolicies({ [key]: grant }, sources).get(key);
  const review = makeFixedEtlReview({
    purpose: "FIXED_ETL",
    source,
    datasets,
    codeSha256,
    expiresAt: now + 300000,
    definitionJson: FIXED_ETL_DEFINITION_JSON,
  });
  const input = { actor: { key }, run: { urn: runUrn }, review };
  assert.equal(await policy.authorizeFixedEtl(input), true);
  for (const other of [
    { ...input, actor: { key: "c".repeat(48) } },
    { ...input, run: { urn: runUrn + "-other" } },
    { ...input, review: { ...review, source: source + "-other" } },
    { ...input, review: { ...review, codeSha256: "d".repeat(64) } },
    { ...input, review: { ...review, expiresAt: grant.expiresAt + 1 } },
  ])
    assert.equal(await policy.authorizeFixedEtl(other), false);
  assert.equal(
    await fixedEtlPolicies({ [key]: { ...grant, expiresAt: now - 1 } }, sources)
      .get(key)
      .authorizeFixedEtl(input),
    false,
  );
  assert.throws(
    () => fixedEtlPolicies({ [key]: { ...grant, argv: [] } }, sources),
    /invalid_fixed_etl_policy/,
  );
  assert.throws(
    () =>
      fixedEtlPolicies(
        { [key]: grant },
        new Map([[key, [{ urn: source, taskDatasets: datasets.slice(1) }]]]),
      ),
    /invalid_fixed_etl_policy/,
  );
  const { planDigest: _planDigest, ...proposal } = review;
  await assert.rejects(
    () =>
      policy.recompileFixedEtl(
        makeFixedEtlReview({ ...proposal, datasets: datasets.slice(1) }),
      ),
    /fixed_etl_binding_mismatch/,
  );
});

function fixedEtlProposal(now) {
  return makeFixedEtlReview({
    purpose: "FIXED_ETL",
    source,
    datasets: [dataset],
    definitionJson: FIXED_ETL_DEFINITION_JSON,
    codeSha256: "a".repeat(64),
    expiresAt: now + 600000,
  });
}
async function fixedEtlFixture() {
  const f = fixture();
  const { run } = await f.setup();
  const plain = await f.store.appendDecision(
    runUrn,
    run.version,
    session,
    question,
  );
  const review = fixedEtlProposal(f.state.now);
  const context = {
    ...f.context,
    authorizeFixedEtl: async () => true,
    recompileFixedEtl: async (expected) => structuredClone(expected),
  };
  const store = taskRecords(context);
  const reviewed = await store.appendExecutionReview(
    runUrn,
    plain.version,
    session,
    question,
    review,
  );
  return { ...f, context, store, review, reviewed };
}

test("fixed ETL uses typed consent and one Run CAS; commit admission cannot be replayed", async () => {
  const f = await fixedEtlFixture();
  await assert.rejects(
    f.store.respondDecision(runUrn, f.reviewed.version, session, question.id, {
      action: "RESPOND",
      text: "APPROVE",
    }),
    denied("typed_execution_response_required"),
  );
  await assert.rejects(
    f.store.appendPublicationReview(
      runUrn,
      f.reviewed.version,
      session,
      question,
      publicationProposal(),
    ),
    denied("task_decision_exists"),
  );
  const approved = await f.store.respondExecutionReview(
    runUrn,
    f.reviewed.version,
    session,
    question.id,
    { verdict: "APPROVE", planDigest: f.review.planDigest },
  );
  const claims = await Promise.allSettled(
    [0, 1].map(() =>
      f.store.claimExecutionConsent(
        runUrn,
        approved.version,
        session,
        question.id,
        f.review,
      ),
    ),
  );
  assert.equal(claims.filter((x) => x.status === "fulfilled").length, 1);
  const admission = claims.find((x) => x.status === "fulfilled").value;
  const commit = await f.store.authorizeExecutionCommit(
    runUrn,
    admission.runVersion,
    session,
    question.id,
    admission.attemptId,
    f.review,
  );
  assert.equal(commit.state, "COMMIT_AUTHORIZED");
  await assert.rejects(
    f.store.authorizeExecutionCommit(
      runUrn,
      commit.runVersion,
      session,
      question.id,
      admission.attemptId,
      f.review,
    ),
    denied("fixed_etl_attempt_mismatch"),
  );
  assert.equal(f.state.targetSubmissions, 0); // Record tests never execute SQL.
});

test("fixed ETL rechecks explicit execution rights, code and deadline without admission writes", async () => {
  const f = await fixedEtlFixture();
  const approved = await f.store.respondExecutionReview(
    runUrn,
    f.reviewed.version,
    session,
    question.id,
    { verdict: "APPROVE", planDigest: f.review.planDigest },
  );
  const writes = f.state.writes;
  const deniedStore = taskRecords({
    ...f.context,
    authorizeFixedEtl: async () => false,
  });
  await assert.rejects(
    deniedStore.claimExecutionConsent(
      runUrn,
      approved.version,
      session,
      question.id,
      f.review,
    ),
    denied("fixed_etl_forbidden"),
  );
  const drift = taskRecords({
    ...f.context,
    recompileFixedEtl: async (review) => {
      const { planDigest: _planDigest, ...proposal } = review;
      return makeFixedEtlReview({ ...proposal, codeSha256: "b".repeat(64) });
    },
  });
  await assert.rejects(
    drift.claimExecutionConsent(
      runUrn,
      approved.version,
      session,
      question.id,
      f.review,
    ),
    denied("fixed_etl_source_changed"),
  );
  f.state.now = f.review.expiresAt - 1;
  await assert.rejects(
    f.store.claimExecutionConsent(
      runUrn,
      approved.version,
      session,
      question.id,
      f.review,
    ),
    denied("fixed_etl_window_too_short"),
  );
  assert.equal(f.state.writes, writes);
  assert.throws(() =>
    makeFixedEtlReview({
      purpose: "FIXED_ETL",
      source,
      datasets: [dataset],
      definitionJson: '{"command":"arbitrary"}',
      codeSha256: "a".repeat(64),
      expiresAt: 10000,
    }),
  );
});

test("fixed ETL lost admission ACK stays consumed and a closed Run cannot authorize commit", async () => {
  const f = await fixedEtlFixture();
  const approved = await f.store.respondExecutionReview(
    runUrn,
    f.reviewed.version,
    session,
    question.id,
    { verdict: "APPROVE", planDigest: f.review.planDigest },
  );
  f.state.failAfterWrite = true;
  await assert.rejects(
    f.store.claimExecutionConsent(
      runUrn,
      approved.version,
      session,
      question.id,
      f.review,
    ),
    (error) =>
      error.message === "task_write_unconfirmed" &&
      error.reconciliation.retryAllowed === false,
  );
  f.state.failAfterWrite = false;
  const current = await f.store.getRun(runUrn);
  await assert.rejects(
    f.store.claimExecutionConsent(
      runUrn,
      current.version,
      session,
      question.id,
      f.review,
    ),
    denied("fixed_etl_already_attempted"),
  );
  const closed = await f.store.closeRun(runUrn, current.version, session);
  await assert.rejects(
    f.store.authorizeExecutionCommit(
      runUrn,
      closed.version,
      session,
      question.id,
      current.value.decisions[0].executionAttempt.attemptId,
      f.review,
    ),
    denied("task_run_closed"),
  );
  assert.equal(f.state.targetSubmissions, 0);
});

test("fixed ETL real CLI pipe crosses the Host CAS gate and records terminal results (NO SQL fixture)", async (t) => {
  for (const permit of [true, false])
    await t.test(permit ? "commit permitted" : "commit refused", async () => {
      const root = mkdtempSync(join(tmpdir(), "fixed-etl-protocol-"));
      try {
        const integration = join(root, "extensions/datahub-agent/integration");
        const pkg = join(root, "extensions/sales-datamart/src/sales_datamart");
        mkdirSync(integration, { recursive: true });
        mkdirSync(pkg, { recursive: true });
        symlinkSync(resolve(".venv"), join(root, ".venv"), "dir");
        for (const name of [
          "native-fixed-etl.mjs",
          "fixed-etl-review.mjs",
          "publication-review.mjs",
        ])
          copyFileSync(
            new URL(
              `../extensions/datahub-agent/integration/${name}`,
              import.meta.url,
            ),
            join(integration, name),
          );
        for (const name of ["__init__.py", "config.py", "cli.py"])
          copyFileSync(
            new URL(
              `../extensions/sales-datamart/src/sales_datamart/${name}`,
              import.meta.url,
            ),
            join(pkg, name),
          );
        const sample = {
          format: "sales-datamart.etl.receipt/1",
          status: "VALIDATED",
          etl_version: "1.0.1",
          scope: JSON.parse(FIXED_ETL_DEFINITION_JSON).scope,
          source: {
            database: "AdventureWorks2019",
            mode: "read_only",
            tables: 7,
          },
          target: { database: "SalesDatamart", schemas: ["dm", "reporting"] },
          counts: {
            source_products: 1,
            source_customers: 1,
            source_territories: 1,
            source_fact_rows: 1,
            target_fact_rows: 1,
            reporting_view_rows: 1,
            quantity: 1,
            orders: 1,
          },
          reconciliation: {
            line_net_amount: "1.000000",
            source_line_total: "1.000000",
            aov: "1.000000",
          },
          elapsed_ms: 0,
          credentials_in_receipt: false,
          rows_in_receipt: false,
        };
        // Only the test's ETL body is synthetic; real CLI, private pipe, resource
        // ceilings, immutable bundle, actor/CAS/receipt logic are exercised.
        writeFileSync(
          join(pkg, "etl.py"),
          `import json,hashlib\nfrom datetime import datetime,timezone\nclass ETLError(Exception): pass\ndef receipt_digest(value):\n return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()\ndef run_etl(*,dry_run=False,before_commit=None):\n value=json.loads(${JSON.stringify(JSON.stringify(sample))})\n now=datetime.now(timezone.utc).isoformat()\n value['source_observation']={'started_at':now,'ended_at':now,'consistent_snapshot':False,'isolation':'driver/database default; not verified as snapshot'}\n before_commit(value)\n value['status']='COMMITTED'\n value['committed_at']=datetime.now(timezone.utc).isoformat()\n value['readback_at']=datetime.now(timezone.utc).isoformat()\n return value\n`,
        );
        const native = await import(
          new URL(`file://${integration}/native-fixed-etl.mjs`)
        );
        const f = fixture();
        await f.setup();
        const compiler = native.fixedEtlReviewCompiler({
          source,
          datasets: [dataset],
        });
        const store = taskRecords({
          ...f.context,
          now: Date.now,
          authorizeFixedEtl: async () => true,
          recompileFixedEtl: compiler,
        });
        const plain = await store.appendDecision(
          runUrn,
          "1",
          session,
          question,
        );
        const review = await compiler(fixedEtlProposal(Date.now()));
        const reviewed = await store.appendExecutionReview(
          runUrn,
          plain.version,
          session,
          question,
          review,
        );
        const approved = await store.respondExecutionReview(
          runUrn,
          reviewed.version,
          session,
          question.id,
          { verdict: "APPROVE", planDigest: review.planDigest },
        );
        const records = permit
          ? store
          : {
              ...store,
              authorizeExecutionCommit: async () => {
                throw new Error("fixture_revoked");
              },
            };
        const result = await native.executeFixedEtl({
          records,
          runUrn,
          runVersion: approved.version,
          sessionId: session,
          decisionId: question.id,
          review,
          getSecrets: async () => ({
            sourcePassword: "fixture-not-a-secret",
            targetPassword: "fixture-not-a-secret",
          }),
        });
        assert.equal(result.state, permit ? "COMMITTED" : "FAILED");
        assert.equal(result.retryAllowed, false);
        const observed = (await store.getRun(runUrn)).value.decisions[0]
          .executionAttempt;
        assert.equal(observed.state, result.state);
        assert.ok(observed.resultJson);
        assert.equal(
          observed.resultJson.includes("fixture-not-a-secret"),
          false,
        );
        assert.equal(f.state.targetSubmissions, 0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
});

const actor = { urn: "urn:li:corpuser:fixture", key: "a".repeat(48) };
const source =
  "urn:li:dataHubIngestionSource:00000000-0000-4000-8000-000000000001";
const dataset = "urn:li:dataset:(urn:li:dataPlatform:mssql,fixture.person,DEV)";
const taskUrn = "urn:li:dataJob:(urn:li:dataFlow:(pi,fixture,DEV),task)";
const runUrn = "urn:li:dataProcessInstance:fixture-task";
const session = "native-session-fixture";
const taskInput = {
  agent: "urn:li:aiAgent:fixture",
  source,
  datasets: [dataset],
  instructions: "Inspect metadata, ask before lineage.",
  allowDecisions: true,
};
const question = {
  id: "decision-1",
  question: "Read lineage?",
  choices: ["Continue", "End"],
};
const denied = (message) => (error) =>
  error instanceof TaskRecordError && error.message === message;

// Simulated public DataHub versioned HTTP semantics only; not live GMS/Pi proof.
function fixture(datasets = [dataset]) {
  const rows = new Map(),
    metadata = new Map();
  const state = {
    actor: actor.urn,
    now: 1234,
    active: true,
    writes: 0,
    failAfterWrite: false,
    writeStatus: 200,
    revokeAfterMe: false,
    afterWrite: undefined,
    publicationReads: [],
    privileges: ["GET_ENTITY", "EDIT_ENTITY"],
    targetSubmissions: 0,
    targetWrites: 0,
    sources: [{ urn: source, taskDatasets: datasets }],
  };
  const put = (urn, aspect, value, systemMetadata = {}) => {
    const key = `${urn}/${aspect}`;
    const versions = rows.get(key) ?? [];
    versions.push(structuredClone(value));
    rows.set(key, versions);
    const history = metadata.get(key) ?? [];
    history.push({
      ...structuredClone(systemMetadata),
      version: String(versions.length),
    });
    metadata.set(key, history);
    return {
      urn,
      [aspect]: {
        value: structuredClone(value),
        systemMetadata: structuredClone(history.at(-1)),
      },
    };
  };
  const context = {
    actor,
    sources: state.sources,
    frontendOrigin: "http://datahub.example",
    cookieHeader: "OTHER=excluded; PLAY_SESSION=fixture-only; actor=fixture",
    now: () => state.now,
    assertActive() {
      if (!state.active) throw new Error("revoked_fixture_grant");
    },
    async fetchImpl(url, options) {
      assert.equal(url.origin, "http://datahub.example");
      assert.equal(options.redirect, "manual");
      assert.equal(
        options.headers.cookie,
        "PLAY_SESSION=fixture-only; actor=fixture",
      );
      const input = JSON.parse(options.body);
      if (url.pathname === "/api/v2/graphql") {
        if (input.query.includes("getGrantedPrivileges"))
          return Response.json({
            data: { getGrantedPrivileges: { privileges: state.privileges } },
          });
        if (state.revokeAfterMe) state.active = false;
        state.onMe?.();
        return Response.json({
          data: { me: { corpUser: { urn: state.actor } } },
        });
      }
      if (url.pathname.endsWith("/batchGet")) {
        const result = [];
        for (const { urn, ...aspects } of input) {
          const item = { urn };
          for (const [aspect, headers] of Object.entries(aspects)) {
            if (!["ekopAgentTask", "ekopAgentRun"].includes(aspect))
              state.publicationReads.push({ urn, aspect });
            const versions = rows.get(`${urn}/${aspect}`);
            if (!versions) continue;
            const version =
              headers.headers?.["If-Version-Match"] ?? String(versions.length);
            if (!versions[Number(version) - 1])
              return Response.json({}, { status: 404 });
            item[aspect] = {
              value: versions[Number(version) - 1],
              systemMetadata: metadata.get(`${urn}/${aspect}`)[
                Number(version) - 1
              ],
            };
          }
          if (Object.keys(item).length > 1) result.push(item);
        }
        return Response.json(result);
      }
      assert.equal(url.pathname, "/openapi/v3/entity/generic");
      state.writes++;
      if (state.writeStatus !== 200)
        return Response.json(
          { secret: "DO_NOT_ECHO" },
          { status: state.writeStatus },
        );
      const isTarget = Object.values(input).some((items) =>
        items.some((item) =>
          Object.keys(item).some(
            (key) => !["urn", "ekopAgentTask", "ekopAgentRun"].includes(key),
          ),
        ),
      );
      if (isTarget) {
        state.targetSubmissions++;
        state.beforeTarget?.(input, put);
      }
      const result = {};
      for (const [entity, items] of Object.entries(input)) {
        result[entity] = [];
        for (const { urn, ...aspects } of items) {
          const ack = { urn };
          for (const [
            aspect,
            { value, headers, systemMetadata },
          ] of Object.entries(aspects)) {
            const current = rows.get(`${urn}/${aspect}`)?.length;
            if (
              headers["If-Version-Match"] !== (current ? String(current) : "-1")
            )
              return Response.json({}, { status: 412 });
            // Match the observed v1.7.0.1 update boundary: native persistence
            // keeps OLD properties, although the ACK carries incoming metadata.
            const previousMetadata = metadata.get(`${urn}/${aspect}`)?.at(-1);
            const persistedMetadata = {
              ...previousMetadata,
              ...systemMetadata,
              properties: current
                ? previousMetadata?.properties
                : systemMetadata?.properties,
              aspectCreated: previousMetadata?.aspectCreated ?? {
                actor: state.actor,
                time: state.now,
              },
              aspectModified: { actor: state.actor, time: state.now },
            };
            const stored = put(urn, aspect, value, persistedMetadata);
            ack[aspect] = {
              ...stored[aspect],
              systemMetadata: {
                ...persistedMetadata,
                ...systemMetadata,
                version: stored[aspect].systemMetadata.version,
              },
            };
            state.afterWrite?.(urn, aspect, value, put);
            if (isTarget) state.targetWrites++;
            if (
              state.failAfterWrite ||
              (isTarget && state.failTargetAfter === state.targetWrites)
            )
              throw new Error("DO_NOT_ECHO_UPSTREAM_SECRET");
          }
          result[entity].push(ack);
        }
      }
      return Response.json(result);
    },
  };
  put(dataset, "upstreamLineage", { upstreams: [] });
  put(dataset, "globalTags", { tags: [] });
  const store = taskRecords(context);
  const setup = async () => {
    const task = await store.createTask(taskUrn, { ...taskInput, datasets });
    const run = await store.bindRun(runUrn, taskUrn, task.version, session);
    return { task, run };
  };
  return { store, state, put, setup, context, rows, metadata };
}

test("trusted Host attaches a review to the same unanswered native question without rewriting history", async () => {
  const { store, setup, context } = fixture();
  const { run } = await setup();
  const q = { ...question, id: "00000000-0000-4000-8000-000000000002" };
  const plain = await store.appendDecision(runUrn, run.version, session, q);
  const proposal = publicationProposal();
  const reviewed = await store.appendPublicationReview(
    runUrn,
    plain.version,
    session,
    q,
    proposal,
  );
  assert.deepEqual(reviewed.value.decisions[0], {
    ...plain.value.decisions[0],
    publicationReview: proposal,
  });
  assert.equal(
    (await store.getRun(runUrn, plain.version)).value.decisions[0]
      .publicationReview,
    undefined,
  );
  const replay = await nativeTasks(
    JSON.stringify({
      action: "prepare_decision",
      runUrn,
      requestId: q.id,
      uiRequestId: "native-ui",
      question: q.question,
      choices: q.choices,
    }),
    {
      ...context,
      runtime: {
        state: async () => ({
          running: true,
          state: {
            sessionId: session,
            extensionUiRequests: [
              {
                id: "native-ui",
                method: "input",
                title: "DataHub task decision",
                placeholder: JSON.stringify({
                  runUrn,
                  requestId: q.id,
                  question: q.question,
                  choices: q.choices,
                }),
              },
            ],
          },
        }),
      },
    },
  );
  assert.equal(
    replay.decision.publicationReview.planDigest,
    proposal.planDigest,
  );
  await store.respondPublicationReview(
    runUrn,
    reviewed.version,
    session,
    q.id,
    { verdict: "APPROVE", planDigest: proposal.planDigest },
  );
});

for (const scenario of [
  "answered",
  "reviewed",
  "question-changed",
  "choices-changed",
  "stale-run",
  "target-drift",
]) {
  test(`Host cannot attach review to invalid existing decision: ${scenario}`, async () => {
    const { store, setup, state, put } = fixture();
    const { run } = await setup();
    let pending = await store.appendDecision(
      runUrn,
      run.version,
      session,
      question,
    );
    const proposal = publicationProposal();
    if (scenario === "answered")
      pending = await store.respondDecision(
        runUrn,
        pending.version,
        session,
        question.id,
        { action: "RESPOND", text: "approve" },
      );
    if (scenario === "reviewed")
      pending = await store.appendPublicationReview(
        runUrn,
        pending.version,
        session,
        question,
        proposal,
      );
    if (scenario === "target-drift")
      put(dataset, "upstreamLineage", { upstreams: [] });
    const before = state.writes;
    const changed = {
      ...question,
      ...(scenario === "question-changed"
        ? { question: "Different question" }
        : {}),
      ...(scenario === "choices-changed" ? { choices: ["Other"] } : {}),
    };
    await assert.rejects(
      store.appendPublicationReview(
        runUrn,
        scenario === "stale-run" ? run.version : pending.version,
        session,
        changed,
        proposal,
      ),
      denied(
        scenario === "stale-run"
          ? "task_run_revision_conflict"
          : scenario === "target-drift"
            ? "publication_target_version_conflict"
            : "task_decision_exists",
      ),
    );
    assert.equal(state.writes, before);
  });
}

test("publication target drift rejects approval and previously recorded consent without writes", async () => {
  const { store, setup, put, state } = fixture();
  const { run } = await setup();
  const proposal = publicationProposal();
  const pending = await store.appendPublicationReview(
    runUrn,
    run.version,
    session,
    question,
    proposal,
  );
  put(dataset, "upstreamLineage", {
    upstreams: [{ dataset, type: "TRANSFORMED" }],
  });
  const before = state.writes;
  await assert.rejects(
    store.respondPublicationReview(
      runUrn,
      pending.version,
      session,
      question.id,
      { verdict: "APPROVE", planDigest: proposal.planDigest },
    ),
    denied("publication_target_version_conflict"),
  );
  assert.equal(state.writes, before);
  assert.equal(
    (await store.getRun(runUrn)).value.decisions[0].response,
    undefined,
  );
});

test("target versions are checked at preparation and after stored approval; reject stays available", async () => {
  const { store, setup, put, state, context } = fixture();
  const { run } = await setup();
  const proposal = publicationProposal();
  const { planDigest: _digest, ...raw } = proposal;
  const absentClaim = makePublicationReview({
    ...raw,
    changes: [{ ...raw.changes[0], expectedVersion: "-1" }],
  });
  const before = state.writes;
  await assert.rejects(
    store.appendPublicationReview(
      runUrn,
      run.version,
      session,
      question,
      absentClaim,
    ),
    denied("publication_target_version_conflict"),
  );
  assert.equal(state.writes, before);
  const pending = await store.appendPublicationReview(
    runUrn,
    run.version,
    session,
    question,
    proposal,
  );
  const approved = await store.respondPublicationReview(
    runUrn,
    pending.version,
    session,
    question.id,
    { verdict: "APPROVE", planDigest: proposal.planDigest },
  );
  const expiresWhileReading = taskRecords({
    ...context,
    fetchImpl: async (url, options) => {
      const response = await context.fetchImpl(url, options);
      if (url.pathname === "/openapi/v3/entity/dataset/batchGet")
        state.now = proposal.expiresAt;
      return response;
    },
  });
  const beforeExpiredRead = state.writes;
  await assert.rejects(
    expiresWhileReading.requirePublicationConsent(
      runUrn,
      approved.version,
      session,
      question.id,
      proposal,
    ),
    denied("publication_review_expired"),
  );
  assert.equal(state.writes, beforeExpiredRead);
  state.now = 1234;
  put(dataset, "upstreamLineage", {
    upstreams: [{ dataset, type: "TRANSFORMED" }],
  });
  await assert.rejects(
    store.requirePublicationConsent(
      runUrn,
      approved.version,
      session,
      question.id,
      proposal,
    ),
    denied("publication_target_version_conflict"),
  );
  const refreshed = makePublicationReview({
    ...raw,
    changes: [{ ...raw.changes[0], expectedVersion: "2" }],
  });
  const next = await store.appendPublicationReview(
    runUrn,
    approved.version,
    session,
    { ...question, id: "next" },
    refreshed,
  );
  put(dataset, "upstreamLineage", { upstreams: [] });
  const rejected = await store.respondPublicationReview(
    runUrn,
    next.version,
    session,
    "next",
    { verdict: "REJECT", planDigest: refreshed.planDigest },
  );
  assert.equal(
    rejected.value.decisions[1].response.publicationVerdict.verdict,
    "REJECT",
  );
});

test("publication baseline groups Aspects, distinguishes explicit absence, rejects malformed/denied reads", async () => {
  const { store, setup, state, context } = fixture();
  const { run } = await setup();
  const { planDigest: _digest, ...raw } = publicationProposal();
  const proposal = makePublicationReview({
    ...raw,
    changes: [
      ...raw.changes,
      {
        urn: dataset,
        aspect: "status",
        expectedVersion: "-1",
        valueJson: '{"removed":false}',
      },
    ],
  });
  const pending = await store.appendPublicationReview(
    runUrn,
    run.version,
    session,
    question,
    proposal,
  );
  assert.deepEqual(state.publicationReads, [
    { urn: dataset, aspect: "upstreamLineage" },
    { urn: dataset, aspect: "status" },
  ]);
  for (const [body, status, message] of [
    [
      [{ urn: "urn:li:dataset:foreign" }],
      200,
      "invalid_publication_target_response",
    ],
    [
      [{ urn: dataset }, { urn: dataset }],
      200,
      "invalid_publication_target_response",
    ],
    [
      [{ urn: dataset, upstreamLineage: { value: {}, systemMetadata: {} } }],
      200,
      "invalid_publication_target_response",
    ],
    [{}, 200, "invalid_publication_target_response"],
    [[], 200, "publication_target_version_conflict"],
    [{ secret: "DO_NOT_ECHO" }, 403, "datahub_task_request_denied"],
  ]) {
    let targetReads = 0;
    const checked = taskRecords({
      ...context,
      fetchImpl: async (url, options) => {
        if (url.pathname === "/openapi/v3/entity/dataset/batchGet") {
          targetReads++;
          return Response.json(body, { status });
        }
        return context.fetchImpl(url, options);
      },
    });
    const before = state.writes;
    await assert.rejects(
      checked.respondPublicationReview(
        runUrn,
        pending.version,
        session,
        question.id,
        { verdict: "APPROVE", planDigest: proposal.planDigest },
      ),
      denied(message),
    );
    assert.equal(state.writes, before);
    assert.equal(targetReads, 1);
  }
});

test("real source capture/SDK subprocess feeds the Host writer and detects post-admission source drift", async () => {
  const root = mkdtempSync(join(tmpdir(), "discovery-native-compiler-"));
  try {
    // Reuse trusted test declarations. Captured job.py is copied/read, never imported or executed.
    const code = `import sys,json,runpy,shutil
from pathlib import Path
sys.path.insert(0,str(Path.cwd()/'extensions/dataflow-discovery/src'))
f=runpy.run_path('tests/test_dataflow_discovery_publisher.py')['PublisherTests']()
f.setUp()
try:
 shutil.copyfile(f.root/'job.py',Path(sys.argv[1])/'job.py')
 plan=f.plan(approval=None)
 print(json.dumps({'policy':{'sourceId':plan.source_id,'root':sys.argv[1],'paths':['job.py'],'snapshotSha256':plan.snapshot_sha256,'modelContextApproved':True},'plan':plan.to_dict()}))
finally: f.doCleanups()
`;
    const { policy, plan } = JSON.parse(
      execFileSync(
        resolve(".venv/bin/python"),
        ["-I", "-B", "-c", code, root],
        {
          encoding: "utf8",
          timeout: 30000,
          maxBuffer: 131072,
          env: {
            PATH: "/usr/bin:/bin",
            LANG: "C.UTF-8",
            HOME: root,
            DATAHUB_TELEMETRY_ENABLED: "false",
          },
        },
      ),
    );
    const compiled = await compileDiscoveryPublication(policy, plan);
    const { format, aspects, publicationAuthorized, ...binding } = compiled;
    assert.equal(publicationAuthorized, false);
    assert.equal(format, "dataflow-discovery.compiled-aspects/1");
    const review = makePublicationReview({
      ...binding,
      source,
      purpose: "LINEAGE",
      expiresAt: 10000,
      changes: aspects.map((item) => ({
        urn: item.urn,
        aspect: item.aspect,
        expectedVersion: "-1",
        valueJson: canonicalPublicationJson(item.value),
      })),
    });
    const recompile = discoveryPublicationCompiler(policy, plan, source);
    for (const approval of [false, 1, "true"]) {
      await assert.rejects(
        compileDiscoveryPublication(
          { ...policy, modelContextApproved: approval },
          plan,
        ),
        { message: "discovery_publication_rejected" },
      );
    }
    // Caller mutations cannot alter the retained Host plan.
    plan.entities[0].description = "must not change the retained plan";
    const changed = {
      ...review,
      changes: review.changes.map((c, i) =>
        i ? c : { ...c, valueJson: canonicalPublicationJson({ forged: true }) },
      ),
    };
    delete changed.planDigest;
    await assert.rejects(recompile(makePublicationReview(changed)), {
      message: "discovery_publication_rejected",
    });
    await assert.rejects(
      nativeDiscovery(
        JSON.stringify({
          requestId: "00000000-0000-4000-8000-000000000001",
          action: "compile_publication",
        }),
        {},
      ),
      { message: "invalid_discovery_request" },
    );
    for (const drift of [false, true]) {
      const f = fixture(compiled.datasets),
        { run } = await f.setup();
      const pending = await f.store.appendPublicationReview(
        runUrn,
        run.version,
        session,
        question,
        review,
      );
      const approved = await f.store.respondPublicationReview(
        runUrn,
        pending.version,
        session,
        question.id,
        { verdict: "APPROVE", planDigest: review.planDigest },
      );
      const store = taskRecords({
        ...f.context,
        recompilePublication: recompile,
      });
      if (drift)
        f.state.afterWrite = (_urn, aspect, value) => {
          if (
            aspect === "ekopAgentRun" &&
            value.decisions.some((d) => d.publicationAttempt)
          )
            appendFileSync(
              join(root, "job.py"),
              "\n# changed after admission\n",
            );
        };
      const request = store.publishPublication(
        runUrn,
        approved.version,
        session,
        question.id,
        review,
      );
      if (drift) {
        await assert.rejects(request, (error) => {
          assert.equal(error.message, "publication_not_dispatched");
          assert.equal(
            error.reconciliation.reason,
            "publication_source_not_verified",
          );
          return true;
        });
        assert.equal(f.state.targetSubmissions, 0);
        assert.ok(
          (await f.store.getRun(runUrn)).value.decisions[0].publicationAttempt,
        );
      } else {
        const result = await request;
        assert.equal(result.status, "VERIFIED_CURRENT_VALUES");
        assert.equal(result.observations.length, aspects.length);
        assert.equal(f.state.targetSubmissions, 1);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function writerFixture(changes) {
  const f = fixture();
  const { run } = await f.setup();
  f.compilations = 0;
  f.recompiledTargets = [];
  // Synthetic compiler seam only; this is not a real-source compiler receipt.
  f.publisher = taskRecords({
    ...f.context,
    recompilePublication: async (review, targets) => {
      assert.ok(targets instanceof Map);
      f.recompiledTargets.push(structuredClone(targets));
      f.compilations++;
      return f.driftAt === f.compilations
        ? { ...review, snapshotSha256: "9".repeat(64) }
        : review;
    },
  });
  const base = publicationProposal();
  delete base.planDigest;
  f.review = makePublicationReview({
    ...base,
    changes: changes ?? [
      {
        urn: dataset,
        aspect: "datasetProperties",
        expectedVersion: "-1",
        valueJson: '{"name":"generated"}',
      },
      {
        urn: dataset,
        aspect: "status",
        expectedVersion: "-1",
        valueJson: '{"removed":false}',
      },
    ],
  });
  const pending = await f.store.appendPublicationReview(
    runUrn,
    run.version,
    session,
    question,
    f.review,
  );
  f.approved = await f.store.respondPublicationReview(
    runUrn,
    pending.version,
    session,
    question.id,
    { verdict: "APPROVE", planDigest: f.review.planDigest },
  );
  f.publish = () =>
    f.publisher.publishPublication(
      runUrn,
      f.approved.version,
      session,
      question.id,
      f.review,
    );
  return f;
}

async function approveOwnedUpdate(f, version, name = "updated") {
  const run = await f.store.getRun(runUrn);
  const base = structuredClone(f.review);
  delete base.planDigest;
  f.updateReview = makePublicationReview({
    ...base,
    snapshotSha256: "6".repeat(64),
    changes: [
      {
        urn: dataset,
        aspect: "datasetProperties",
        expectedVersion: version,
        valueJson: canonicalPublicationJson({ name }),
      },
    ],
  });
  const pending = await f.store.appendPublicationReview(
    runUrn,
    run.version,
    session,
    { ...question, id: "update-owned" },
    f.updateReview,
  );
  f.updateApproved = await f.store.respondPublicationReview(
    runUrn,
    pending.version,
    session,
    "update-owned",
    { verdict: "APPROVE", planDigest: f.updateReview.planDigest },
  );
  return () =>
    f.publisher.publishPublication(
      runUrn,
      f.updateApproved.version,
      session,
      "update-owned",
      f.updateReview,
    );
}

test("native artifact compiler uses Host admission; source drift before/after admission never writes targets", async () => {
  // Synthetic public-GMS seam; the actual121-Aspect SDK fixture is tested separately.
  const query =
    "urn:li:dataset:(urn:li:dataPlatform:grafana,mssql.ds.dashboard.1,PROD)";
  for (const drift of ["none", "before", "after"]) {
    const f = fixture([query]);
    const { run } = await f.setup();
    const observedSource = { dashboardVersion: 2 };
    const observedCatalog = { schemaVersion: "1" };
    const bytes = Buffer.from(
      JSON.stringify([
        {
          entityType: "dataset",
          entityUrn: query,
          changeType: "UPSERT",
          aspectName: "status",
          aspect: {
            json: { removed: false },
          },
        },
      ]),
    );
    const {
      changes: _changes,
      planDigest: _digest,
      ...binding
    } = publicationProposal();
    const fixed = {
      ...binding,
      datasets: [query],
      candidateDigest: createHash("sha256").update(bytes).digest("hex"),
      snapshotSha256: grafanaPublicationSnapshot(
        observedSource,
        observedCatalog,
      ),
    };
    const review = compileGrafanaArtifact(bytes, fixed);
    const pending = await f.store.appendPublicationReview(
      runUrn,
      run.version,
      session,
      question,
      review,
    );
    const approved = await f.store.respondPublicationReview(
      runUrn,
      pending.version,
      session,
      question.id,
      {
        verdict: "APPROVE",
        planDigest: review.planDigest,
      },
    );
    const publisher = taskRecords({
      ...f.context,
      recompilePublication: grafanaPublicationCompiler(bytes, fixed, {
        readSource: async () => observedSource,
        readCatalog: async () => observedCatalog,
        assertActive: f.context.assertActive,
      }),
    });
    if (drift === "before") observedSource.dashboardVersion++;
    f.state.afterWrite = (_urn, aspect, value) => {
      if (
        drift === "after" &&
        aspect === "ekopAgentRun" &&
        value.decisions[0]?.publicationAttempt
      )
        observedSource.dashboardVersion++;
    };
    const publish = () =>
      publisher.publishPublication(
        runUrn,
        approved.version,
        session,
        question.id,
        review,
      );
    if (drift === "none") {
      assert.equal((await publish()).status, "VERIFIED_CURRENT_VALUES");
      assert.equal(f.state.targetSubmissions, 1);
    } else {
      await assert.rejects(publish());
      assert.equal(f.state.targetSubmissions, 0);
      assert.equal(
        Boolean(
          (await f.store.getRun(runUrn)).value.decisions[0].publicationAttempt,
        ),
        drift === "after",
      );
    }
  }
});

test("conditional publisher creates exact native values with provenance; closed/expired reconciliation is read-only", async () => {
  const f = await writerFixture();
  await assert.rejects(
    nativeTasks(JSON.stringify({ action: "publish_publication" }), f.context),
    denied("invalid_task_request"),
  );
  const result = await f.publish();
  assert.equal(result.status, "VERIFIED_CURRENT_VALUES");
  assert.equal(f.compilations, 2);
  assert.equal(f.state.targetSubmissions, 1);
  assert.equal(f.state.targetWrites, 2);
  assert.deepEqual(
    result.observations.map((item) => item.state),
    ["MATCHED", "MATCHED"],
  );
  const provenance = f.metadata.get(`${dataset}/datasetProperties`).at(-1);
  assert.equal(
    provenance.runId,
    "dataflow-discovery/1:" +
      JSON.stringify([runUrn, question.id, result.attemptId]),
  );
  assert.equal(provenance.properties.dataflowDiscoveryRunUrn, undefined);
  await f.store.closeRun(runUrn, result.runVersion, session);
  f.state.now = f.review.expiresAt + 1;
  const writes = f.state.writes;
  const observed = await f.publisher.reconcilePublication(runUrn, question.id);
  assert.equal(observed.status, "MATCHED_CLAIMED_ATTEMPT");
  assert.equal(observed.retryAllowed, false);
  assert.equal(f.state.writes, writes);
});

test("owned whole-Aspect update follows prior Run evidence; unrelated existing Aspects remain unchanged", async () => {
  const f = await writerFixture();
  await f.publish();
  const unchanged = structuredClone(f.rows.get(`${dataset}/upstreamLineage`));
  const update = await approveOwnedUpdate(f, "1");
  const result = await update();
  assert.equal(result.status, "VERIFIED_CURRENT_VALUES");
  assert.equal(result.observations[0].version, "2");
  for (const targets of f.recompiledTargets.slice(-2)) {
    assert.deepEqual(targets.get(dataset).datasetProperties.value, {
      name: "generated",
    });
    assert.equal(
      targets.get(dataset).datasetProperties.systemMetadata.version,
      "1",
    );
  }
  assert.deepEqual(f.rows.get(`${dataset}/upstreamLineage`), unchanged);
  assert.equal(
    f.metadata.get(`${dataset}/datasetProperties`).at(-1).runId,
    "dataflow-discovery/1:" +
      JSON.stringify([runUrn, "update-owned", result.attemptId]),
  );
});

test("unowned metadata and manual changes are never adopted or overwritten", async () => {
  const f = await writerFixture([
    {
      urn: dataset,
      aspect: "upstreamLineage",
      expectedVersion: "1",
      valueJson: canonicalPublicationJson({
        upstreams: [{ dataset, type: "TRANSFORMED" }],
      }),
    },
  ]);
  await assert.rejects(f.publish(), denied("publication_target_not_owned"));
  assert.equal(f.state.targetSubmissions, 0);
  assert.equal(
    (await f.store.getRun(runUrn)).value.decisions[0].publicationAttempt,
    undefined,
  );
  const g = await writerFixture();
  await g.publish();
  const prior = g.metadata.get(`${dataset}/datasetProperties`).at(-1);
  g.put(
    dataset,
    "datasetProperties",
    { name: "human edit", customProperties: { manual: "keep" } },
    prior,
  );
  const update = await approveOwnedUpdate(g, "2");
  const writes = g.state.writes;
  await assert.rejects(
    update(),
    denied("publication_manual_metadata_conflict"),
  );
  assert.equal(g.state.writes, writes);
  assert.equal(
    g.rows.get(`${dataset}/datasetProperties`).at(-1).customProperties.manual,
    "keep",
  );
});

async function adoptionFixture() {
  const f = fixture();
  const { run } = await f.setup();
  const job = "urn:li:dataJob:(urn:li:dataFlow:(python,fixture,DEV),transform)";
  const aspect = "dataJobInputOutput";
  const before = {
    inputDatasets: [],
    inputDatasetEdges: [],
    outputDatasets: [],
    outputDatasetEdges: [
      {
        destinationUrn: dataset,
        properties: { note: "human evidence retained" },
      },
    ],
  };
  const created = { actor: actor.urn, time: 1000 };
  f.put(job, aspect, before, { aspectCreated: created });
  const after = preserveDiscoveryJobIO(
    { inputDatasets: [dataset], outputDatasets: [dataset] },
    before,
  );
  const { planDigest: _digest, ...binding } = publicationProposal();
  const review = makePublicationReview({
    ...binding,
    changes: [
      {
        urn: job,
        aspect,
        expectedVersion: "1",
        valueJson: canonicalPublicationJson(after),
      },
    ],
  });
  const pending = await f.store.appendPublicationReview(
    runUrn,
    run.version,
    session,
    {
      ...question,
      question:
        "Publish the exact source-bound additions and adopt this original canary I/O?",
    },
    review,
  );
  const approved = await f.store.respondPublicationReview(
    runUrn,
    pending.version,
    session,
    question.id,
    { verdict: "APPROVE", planDigest: review.planDigest },
  );
  const authorization = {
    actor: actor.urn,
    planDigest: review.planDigest,
    targets: [
      {
        urn: job,
        aspect,
        aspectCreated: created,
        beforeValueSha256: createHash("sha256")
          .update(canonicalPublicationJson(before))
          .digest("hex"),
      },
    ],
  };
  const publisher = (grant) =>
    taskRecords({
      ...f.context,
      publicationAdoption: grant,
      recompilePublication: async (checked) => checked,
    }); // fixture seam, not source proof
  const publish = (store) =>
    store.publishPublication(
      runUrn,
      approved.version,
      session,
      question.id,
      review,
    );
  return {
    ...f,
    job,
    aspect,
    before,
    after,
    authorization,
    publisher,
    publish,
  };
}

test("operator-scoped canary adoption needs exact digest/actor/native baseline plus typed consent", async () => {
  const f = await adoptionFixture();
  const variants = [
    undefined,
    { ...f.authorization, actor: "urn:li:corpuser:other" },
    { ...f.authorization, planDigest: "0".repeat(64) },
    { ...f.authorization, targets: [] },
    {
      ...f.authorization,
      targets: [
        { ...f.authorization.targets[0], beforeValueSha256: "0".repeat(64) },
      ],
    },
    {
      ...f.authorization,
      targets: [
        {
          ...f.authorization.targets[0],
          aspectCreated: { actor: actor.urn, time: 1001 },
        },
      ],
    },
  ];
  for (const grant of variants) {
    await assert.rejects(
      f.publish(f.publisher(grant)),
      denied("publication_target_not_owned"),
    );
    assert.equal(f.state.targetSubmissions, 0);
    assert.equal(
      (await f.store.getRun(runUrn)).value.decisions[0].publicationAttempt,
      undefined,
    );
  }
  const store = f.publisher(f.authorization);
  const result = await f.publish(store);
  assert.equal(result.status, "VERIFIED_CURRENT_VALUES");
  assert.deepEqual(f.rows.get(`${f.job}/${f.aspect}`).at(-1), f.after);
  assert.deepEqual(f.after.outputDatasetEdges, f.before.outputDatasetEdges);
  assert.equal(
    f.metadata.get(`${f.job}/${f.aspect}`).at(-1).runId,
    "dataflow-discovery/1:" +
      JSON.stringify([runUrn, question.id, result.attemptId]),
  );
  await assert.rejects(f.publish(store), denied("task_run_revision_conflict"));
  assert.equal(f.state.targetSubmissions, 1);
});

test("adoption cannot overwrite a recreated or changed baseline, borrow provenance, or inject an HTTP capability", async () => {
  for (const mutate of [
    (f) => {
      f.metadata.get(`${f.job}/${f.aspect}`)[0].aspectCreated.time++;
    },
    (f) => {
      f.rows.get(
        `${f.job}/${f.aspect}`,
      )[0].outputDatasetEdges[0].properties.note = "manual change";
    },
    (f) => {
      f.metadata.get(`${f.job}/${f.aspect}`)[0].runId = "some other publisher";
    },
    (f) => {
      f.metadata.get(`${f.job}/${f.aspect}`)[0].aspectCreated.actor =
        "urn:li:corpuser:other";
      f.authorization.targets[0].aspectCreated.actor = "urn:li:corpuser:other";
    },
  ]) {
    const f = await adoptionFixture();
    mutate(f);
    await assert.rejects(
      f.publish(f.publisher(f.authorization)),
      denied("publication_target_not_owned"),
    );
    assert.equal(f.state.targetSubmissions, 0);
  }
  const f = await adoptionFixture();
  await assert.rejects(
    nativeTasks(
      JSON.stringify({
        action: "get_run",
        runUrn,
        publicationAdoption: f.authorization,
      }),
      f.context,
    ),
    denied("invalid_task_request"),
  );
  // Authorization is captured by value, not upgraded by a mutated caller object.
  const wrong = { ...f.authorization, actor: "urn:li:corpuser:other" };
  const store = f.publisher(wrong);
  wrong.actor = actor.urn;
  await assert.rejects(
    f.publish(store),
    denied("publication_target_not_owned"),
  );
  f.put(f.job, f.aspect, f.before, {
    aspectCreated: f.authorization.targets[0].aspectCreated,
  });
  await assert.rejects(
    f.publish(f.publisher(f.authorization)),
    denied("publication_target_version_conflict"),
  );
  assert.equal(f.state.targetSubmissions, 0);
});

test("ambient provenance and no-op proposals cannot adopt existing metadata", async () => {
  const f = await writerFixture();
  await f.publish();
  const meta = f.metadata.get(`${dataset}/datasetProperties`).at(-1);
  f.put(
    dataset,
    "datasetProperties",
    { name: "generated" },
    { ...meta, runId: "unrelated-attempt" },
  );
  const update = await approveOwnedUpdate(f, "2");
  const writes = f.state.writes;
  await assert.rejects(update(), denied("publication_target_not_owned"));
  assert.equal(f.state.writes, writes);
  const g = await writerFixture();
  await g.publish();
  const unchanged = await approveOwnedUpdate(g, "1", "generated");
  await assert.rejects(
    unchanged(),
    denied("publication_noop_requires_recompile"),
  );
  assert.equal(g.state.targetSubmissions, 1);
});

test("an ACK alone does not pass: concurrent readback change remains visible and unconfirmed", async () => {
  const f = await writerFixture();
  f.state.afterWrite = (urn, aspect, _value, put) => {
    if (aspect === "datasetProperties")
      put(urn, aspect, { name: "human after-write" });
  };
  await assert.rejects(f.publish(), (error) => {
    assert.equal(error.message, "publication_write_unconfirmed");
    assert.equal(error.reconciliation.reason, "publication_readback_mismatch");
    assert.equal(error.reconciliation.observations[0].state, "DIFFERENT");
    return true;
  });
  assert.equal(f.state.targetSubmissions, 1);
  assert.equal(
    f.rows.get(`${dataset}/datasetProperties`).at(-1).name,
    "human after-write",
  );
});

test("UUID-only legacy result can match its known admission read-only, but cannot grant future ownership or replay", async () => {
  const f = await writerFixture();
  // Reproduce the actual old writer result; new writes require the full locator.
  f.state.afterWrite = (urn, aspect) => {
    if (["datasetProperties", "status"].includes(aspect)) {
      const metadata = f.metadata.get(`${urn}/${aspect}`).at(-1);
      metadata.runId = JSON.parse(
        metadata.runId.slice("dataflow-discovery/1:".length),
      )[2];
      metadata.properties = { eventSource: "OPENAPI" };
    }
  };
  await assert.rejects(f.publish(), (error) => {
    assert.equal(error.message, "publication_write_unconfirmed");
    assert.equal(error.reconciliation.reason, "publication_readback_mismatch");
    assert.ok(
      error.reconciliation.observations.every((x) => x.state === "DIFFERENT"),
    );
    return true;
  });
  const latest = await f.store.getRun(runUrn);
  const attempt = latest.value.decisions[0].publicationAttempt.attemptId;
  for (const change of f.review.changes) {
    assert.deepEqual(
      f.rows.get(`${change.urn}/${change.aspect}`).at(-1),
      JSON.parse(change.valueJson),
    );
    assert.equal(
      f.metadata.get(`${change.urn}/${change.aspect}`).at(-1).runId,
      attempt,
    );
  }
  const reconciled = await f.publisher.reconcilePublication(
    runUrn,
    question.id,
  );
  assert.equal(reconciled.status, "MATCHED_KNOWN_LEGACY_ATTEMPT");
  assert.equal(reconciled.retryAllowed, false);
  assert.equal(reconciled.legacyTargetsRequireOwnershipReview, true);
  await assert.rejects(
    f.publisher.publishPublication(
      runUrn,
      latest.version,
      session,
      question.id,
      f.review,
    ),
    denied("publication_already_attempted"),
  );
  assert.equal(f.state.targetSubmissions, 1);
  const update = await approveOwnedUpdate(f, "1");
  await assert.rejects(update(), denied("publication_target_not_owned"));
  assert.equal(f.state.targetSubmissions, 1);
});

test("legacy created locator upgrades through native runId even when old properties survive", async () => {
  const f = await writerFixture();
  const first = await f.publish();
  const metadata = f.metadata.get(`${dataset}/datasetProperties`).at(-1);
  metadata.runId = first.attemptId;
  metadata.properties = {
    dataflowDiscoveryRunUrn: runUrn,
    dataflowDiscoveryDecisionId: question.id,
    humanNote: "preserve",
  };
  const oldProperties = structuredClone(metadata.properties);
  const update = await approveOwnedUpdate(f, "1");
  const second = await update();
  assert.equal(second.status, "VERIFIED_CURRENT_VALUES");
  assert.deepEqual(
    f.metadata.get(`${dataset}/datasetProperties`).at(-1).properties,
    oldProperties,
  );
  assert.equal(
    (await f.publisher.reconcilePublication(runUrn, "update-owned")).status,
    "MATCHED_CLAIMED_ATTEMPT",
  );
});

test("malformed or forged native locators cannot authorize an owned update", async () => {
  for (const corrupt of [
    () => "dataflow-discovery/1:{",
    () => "dataflow-discovery/2:[]",
    () =>
      "dataflow-discovery/1:" + JSON.stringify([dataset, question.id, "wrong"]),
    () =>
      "dataflow-discovery/1:" + JSON.stringify([runUrn, question.id, "wrong"]),
    () =>
      "dataflow-discovery/1:" +
      JSON.stringify([runUrn, "unknown-decision", "wrong"]),
    (raw) => raw + " ",
    (raw) => raw.slice(0, -1) + ',"extra"]',
  ]) {
    const f = await writerFixture();
    await f.publish();
    const metadata = f.metadata.get(`${dataset}/datasetProperties`).at(-1);
    metadata.runId = corrupt(metadata.runId);
    const update = await approveOwnedUpdate(f, "1");
    const writes = f.state.writes;
    await assert.rejects(update());
    assert.equal(f.state.writes, writes);
    assert.equal(f.state.targetSubmissions, 1);
  }
});

test("legacy read-only matching rejects bad audit, version, locator hints and value drift", async () => {
  for (const corrupt of [
    (metadata) => {
      metadata.aspectModified.actor = "urn:li:corpuser:other";
    },
    (metadata) => {
      metadata.aspectModified.time = -1;
    },
    (metadata) => {
      delete metadata.aspectModified;
    },
    (metadata) => {
      metadata.runId = "unrelated-attempt";
    },
    (metadata) => {
      metadata.properties.dataflowDiscoveryRunUrn = runUrn;
    },
    (metadata) => {
      metadata.version = "2";
    },
    (_metadata, change, f) => {
      if (change.aspect === "datasetProperties")
        f.rows.get(`${change.urn}/${change.aspect}`).at(-1).name =
          "manual change";
    },
  ]) {
    const f = await writerFixture();
    const published = await f.publish();
    for (const change of f.review.changes) {
      const metadata = f.metadata.get(`${change.urn}/${change.aspect}`).at(-1);
      metadata.runId = published.attemptId;
      metadata.properties = {};
      corrupt(metadata, change, f);
    }
    const writes = f.state.writes;
    assert.equal(
      (await f.publisher.reconcilePublication(runUrn, question.id)).status,
      "INCOMPLETE_OR_CHANGED",
    );
    assert.equal(f.state.writes, writes);
    await assert.rejects(async () => {
      const update = await approveOwnedUpdate(f, "1");
      await update();
    });
    assert.equal(f.state.targetSubmissions, 1);
  }
});

test("partial target failure preserves admission; reconciliation reports per-Aspect observations without retry", async () => {
  const f = await writerFixture();
  f.state.failTargetAfter = 1;
  await assert.rejects(f.publish(), (error) => {
    assert.equal(error.message, "publication_write_unconfirmed");
    assert.equal(error.reconciliation.targetRequestInvoked, true);
    return true;
  });
  assert.equal(f.state.targetSubmissions, 1);
  const result = await f.publisher.reconcilePublication(runUrn, question.id);
  assert.equal(result.status, "INCOMPLETE_OR_CHANGED");
  assert.deepEqual(
    result.observations.map((item) => item.state),
    ["MATCHED", "ABSENT"],
  );
  const latest = await f.store.getRun(runUrn);
  await assert.rejects(
    f.publisher.publishPublication(
      runUrn,
      latest.version,
      session,
      question.id,
      f.review,
    ),
    denied("publication_already_attempted"),
  );
  assert.equal(f.state.targetSubmissions, 1);
});

test("compiler/ACL/source preflights refuse before target writes, including after consumed admission", async () => {
  const f = await writerFixture();
  await assert.rejects(
    f.store.publishPublication(
      runUrn,
      f.approved.version,
      session,
      question.id,
      f.review,
    ),
    denied("publication_compiler_not_configured"),
  );
  const failedCompiler = taskRecords({
    ...f.context,
    recompilePublication: async () => {
      throw new Error("DO_NOT_ECHO_SOURCE_OR_SQL");
    },
  });
  await assert.rejects(
    failedCompiler.publishPublication(
      runUrn,
      f.approved.version,
      session,
      question.id,
      f.review,
    ),
    denied("publication_source_not_verified"),
  );
  f.state.privileges = ["GET_ENTITY"];
  await assert.rejects(f.publish(), denied("publication_privilege_denied"));
  assert.equal(f.state.targetSubmissions, 0);
  for (const failure of ["source", "acl"]) {
    const g = await writerFixture();
    if (failure === "source") g.driftAt = 2;
    else
      g.state.afterWrite = (_urn, aspect, value) => {
        if (
          aspect === "ekopAgentRun" &&
          value.decisions.some((d) => d.publicationAttempt)
        )
          g.state.privileges = ["GET_ENTITY"];
      };
    await assert.rejects(g.publish(), (error) => {
      assert.equal(error.message, "publication_not_dispatched");
      assert.equal(error.reconciliation.targetRequestInvoked, false);
      return true;
    });
    assert.equal(g.state.targetSubmissions, 0);
    assert.ok(
      (await g.store.getRun(runUrn)).value.decisions[0].publicationAttempt,
    );
  }
});

test("target CAS race preserves competing metadata and remains unconfirmed, not a clean batch rollback", async () => {
  const f = await writerFixture();
  f.state.beforeTarget = (_body, put) =>
    put(dataset, "datasetProperties", { name: "competing manual write" });
  await assert.rejects(f.publish(), denied("publication_write_unconfirmed"));
  assert.equal(f.state.targetSubmissions, 1);
  assert.equal(f.state.targetWrites, 0);
  assert.equal(
    f.rows.get(`${dataset}/datasetProperties`).at(-1).name,
    "competing manual write",
  );
  assert.equal(
    (await f.publisher.reconcilePublication(runUrn, question.id))
      .observations[0].state,
    "DIFFERENT",
  );
});

async function approvedPublicationFixture() {
  const f = fixture();
  const { run } = await f.setup();
  const proposal = publicationProposal();
  const pending = await f.store.appendPublicationReview(
    runUrn,
    run.version,
    session,
    question,
    proposal,
  );
  const approved = await f.store.respondPublicationReview(
    runUrn,
    pending.version,
    session,
    question.id,
    { verdict: "APPROVE", planDigest: proposal.planDigest },
  );
  return { ...f, proposal, approved };
}

test("one Run CAS admits one publication attempt, preserving review and human response", async () => {
  const f = await approvedPublicationFixture();
  const results = await Promise.allSettled(
    [0, 1].map(() =>
      f.store.claimPublicationConsent(
        runUrn,
        f.approved.version,
        session,
        question.id,
        f.proposal,
      ),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  const winner = results.find((r) => r.status === "fulfilled").value;
  assert.match(
    winner.attemptId,
    /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/,
  );
  const latest = await f.store.getRun(runUrn);
  const before = f.approved.value.decisions[0],
    after = latest.value.decisions[0];
  assert.deepEqual(after.publicationReview, before.publicationReview);
  assert.deepEqual(after.response, before.response);
  assert.deepEqual(after.publicationAttempt, {
    attemptId: winner.attemptId,
    claimedAt: 1234,
  });
  const writes = f.state.writes;
  await assert.rejects(
    f.store.requirePublicationConsent(
      runUrn,
      latest.version,
      session,
      question.id,
      f.proposal,
    ),
    denied("publication_already_attempted"),
  );
  await assert.rejects(
    f.store.claimPublicationConsent(
      runUrn,
      latest.version,
      session,
      question.id,
      f.proposal,
    ),
    denied("publication_already_attempted"),
  );
  assert.equal(f.state.writes, writes);
});

test("lost admission ACK carries exact reconciliation identity; fresh Host never claims it again", async () => {
  const f = await approvedPublicationFixture();
  const writes = f.state.writes;
  f.state.failAfterWrite = true;
  let error;
  try {
    await f.store.claimPublicationConsent(
      runUrn,
      f.approved.version,
      session,
      question.id,
      f.proposal,
    );
  } catch (caught) {
    error = caught;
  }
  assert.equal(error.message, "task_write_unconfirmed");
  assert.equal(error.reconciliation.decisionId, question.id);
  assert.equal(error.reconciliation.planDigest, f.proposal.planDigest);
  assert.equal(f.state.writes, writes + 1);
  f.state.failAfterWrite = false;
  const restarted = taskRecords(f.context),
    latest = await restarted.getRun(runUrn);
  assert.equal(
    latest.value.decisions[0].publicationAttempt.attemptId,
    error.reconciliation.attemptId,
  );
  await assert.rejects(
    restarted.claimPublicationConsent(
      runUrn,
      latest.version,
      session,
      question.id,
      f.proposal,
    ),
    denied("publication_already_attempted"),
  );
  assert.equal(f.state.writes, writes + 1);
  const closed = await restarted.closeRun(runUrn, latest.version, session);
  assert.deepEqual(
    closed.value.decisions[0].publicationAttempt,
    latest.value.decisions[0].publicationAttempt,
  );
});

test("unconfirmed admission need not have persisted: no success, no implicit retry", async () => {
  const f = await approvedPublicationFixture();
  let submissions = 0;
  const failed = taskRecords({
    ...f.context,
    fetchImpl: async (url, options) => {
      if (url.pathname === "/openapi/v3/entity/generic") {
        submissions++;
        throw new Error("DO_NOT_ECHO_TRANSPORT_DETAILS");
      }
      return f.context.fetchImpl(url, options);
    },
  });
  await assert.rejects(
    failed.claimPublicationConsent(
      runUrn,
      f.approved.version,
      session,
      question.id,
      f.proposal,
    ),
    (error) => {
      assert.equal(error.message, "task_write_unconfirmed");
      assert.equal(error.reconciliation.expectedVersion, f.approved.version);
      assert.match(error.reconciliation.attemptId, /^[a-f0-9-]{36}$/);
      return true;
    },
  );
  assert.equal(submissions, 1);
  const observed = await f.store.getRun(runUrn);
  assert.equal(observed.version, f.approved.version);
  assert.equal(observed.value.decisions[0].publicationAttempt, undefined);
  // Absence is not an execution receipt or permission to retry the unknown call.
});

test("admission preserves separate purposes and later ordinary questions in the same Run", async () => {
  const f = await approvedPublicationFixture();
  const first = await f.store.claimPublicationConsent(
    runUrn,
    f.approved.version,
    session,
    question.id,
    f.proposal,
  );
  const semantic = publicationProposal("SEMANTIC"),
    nextQuestion = { ...question, id: "semantic-review" };
  const pending = await f.store.appendPublicationReview(
    runUrn,
    first.runVersion,
    session,
    nextQuestion,
    semantic,
  );
  const approved = await f.store.respondPublicationReview(
    runUrn,
    pending.version,
    session,
    nextQuestion.id,
    { verdict: "APPROVE", planDigest: semantic.planDigest },
  );
  const second = await f.store.claimPublicationConsent(
    runUrn,
    approved.version,
    session,
    nextQuestion.id,
    semantic,
  );
  assert.notEqual(second.attemptId, first.attemptId);
  assert.equal(second.purpose, "SEMANTIC");
  const later = await f.store.appendDecision(
    runUrn,
    second.runVersion,
    session,
    { ...question, id: "ordinary-later" },
  );
  assert.equal(later.value.decisions.length, 3);
  assert.equal(later.value.closedAt, undefined);
  assert.equal(later.value.decisions[2].publicationAttempt, undefined);
});

test("admission rechecks identity, scope, target versions and expiry before its CAS", async () => {
  for (const [mutate, message] of [
    [
      (f) => {
        let calls = 0;
        f.state.onMe = () => {
          if (++calls === 2) f.state.now = f.proposal.expiresAt;
        };
      },
      "publication_review_expired",
    ],
    [
      (f) => {
        f.state.actor = "urn:li:corpuser:other";
      },
      "task_identity_denied",
    ],
    [
      (f) => {
        f.state.sources[0].taskDatasets.length = 0;
      },
      "task_scope_not_approved",
    ],
    [
      (f) => {
        f.put(dataset, "upstreamLineage", { upstreams: [] });
      },
      "publication_target_version_conflict",
    ],
  ]) {
    const f = await approvedPublicationFixture();
    const writes = f.state.writes;
    mutate(f);
    await assert.rejects(
      f.store.claimPublicationConsent(
        runUrn,
        f.approved.version,
        session,
        question.id,
        f.proposal,
      ),
      denied(message),
    );
    assert.equal(f.state.writes, writes);
  }
});

function publicationProposal(purpose = "LINEAGE") {
  return makePublicationReview({
    purpose,
    source,
    sourceId: "fixture-code",
    snapshotSha256: "1".repeat(64),
    candidateDigest: "2".repeat(64),
    analysisVersion: "1.0.2",
    candidateIds: [`cand_${"4".repeat(24)}`],
    datasets: [dataset],
    expiresAt: 10000,
    changes: [
      {
        urn: dataset,
        aspect: purpose === "LINEAGE" ? "upstreamLineage" : "globalTags",
        expectedVersion: "1",
        valueJson: canonicalPublicationJson(
          purpose === "LINEAGE" ? { upstreams: [] } : { tags: [] },
        ),
      },
    ],
  });
}

test("typed proposal digest covers actual values/version/purpose, excludes a future response", () => {
  const proposal = publicationProposal();
  assert.deepEqual(validatePublicationReview(proposal, 1234), proposal);
  for (const mutate of [
    (p) => {
      p.changes[0].expectedVersion = "2";
    },
    (p) => {
      p.changes[0].valueJson = '{"upstreams":["changed"]}';
    },
    (p) => {
      p.snapshotSha256 = "3".repeat(64);
    },
    (p) => {
      p.expiresAt++;
    },
    (p) => {
      p.actor = actor.urn;
    },
  ]) {
    const changed = structuredClone(proposal);
    mutate(changed);
    assert.throws(
      () => validatePublicationReview(changed, 1234),
      PublicationReviewError,
    );
  }
  assert.notEqual(
    publicationProposal("SEMANTIC").planDigest,
    proposal.planDigest,
  );
  const { planDigest: _digest, ...input } = proposal;
  input.changes[0].valueJson = canonicalPublicationJson({
    fields: [{ globalTags: { tags: [] } }],
  });
  input.changes[0].aspect = "schemaMetadata";
  assert.throws(
    () => makePublicationReview(input),
    /semantic_content_requires_separate_review/,
  );
  input.changes[0].valueJson = '{"fields": [], "fields": []}';
  assert.throws(
    () => makePublicationReview(input),
    /noncanonical_publication_value/,
  );
});

test("Host-only typed review uses same Run CAS/history; ordinary RESPOND cannot approve", async () => {
  const { store, setup, state } = fixture();
  const { run } = await setup();
  const proposal = publicationProposal();
  await assert.rejects(
    store.appendDecision(runUrn, run.version, session, {
      ...question,
      publicationReview: proposal,
    }),
    denied("invalid_task_request"),
  );
  const pending = await store.appendPublicationReview(
    runUrn,
    run.version,
    session,
    question,
    proposal,
  );
  const writes = state.writes;
  await assert.rejects(
    store.respondDecision(runUrn, pending.version, session, question.id, {
      action: "RESPOND",
      text: "APPROVE",
    }),
    denied("typed_publication_response_required"),
  );
  assert.equal(state.writes, writes);
  const approved = await store.respondPublicationReview(
    runUrn,
    pending.version,
    session,
    question.id,
    { verdict: "APPROVE", planDigest: proposal.planDigest },
  );
  const consent = await store.requirePublicationConsent(
    runUrn,
    approved.version,
    session,
    question.id,
    proposal,
  );
  assert.equal(consent.actor, actor.urn);
  assert.equal(consent.planDigest, proposal.planDigest);
  assert.equal(consent.runVersion, approved.version);
  assert.deepEqual(
    (await store.getRun(runUrn, pending.version)).value,
    pending.value,
  );
  await assert.rejects(
    store.respondPublicationReview(
      runUrn,
      approved.version,
      session,
      question.id,
      { verdict: "REJECT", planDigest: proposal.planDigest },
    ),
    denied("task_decision_already_answered"),
  );
  await assert.rejects(
    store.requirePublicationConsent(
      runUrn,
      approved.version,
      session,
      question.id,
      publicationProposal("SEMANTIC"),
    ),
    denied("trusted_publication_consent_required"),
  );
  state.now = 10000;
  await assert.rejects(
    store.requirePublicationConsent(
      runUrn,
      approved.version,
      session,
      question.id,
      proposal,
    ),
    denied("publication_review_expired"),
  );
});

test("typed reject, closed run, stale version and missing proposal cannot become consent", async () => {
  const { store, setup } = fixture();
  const { run } = await setup();
  const proposal = publicationProposal();
  const pending = await store.appendPublicationReview(
    runUrn,
    run.version,
    session,
    question,
    proposal,
  );
  await assert.rejects(
    store.respondPublicationReview(runUrn, run.version, session, question.id, {
      verdict: "APPROVE",
      planDigest: proposal.planDigest,
    }),
    denied("task_run_revision_conflict"),
  );
  await assert.rejects(
    store.respondPublicationReview(
      runUrn,
      pending.version,
      session,
      question.id,
      { verdict: "APPROVE", planDigest: "0".repeat(64) },
    ),
    denied("publication_review_digest_mismatch"),
  );
  const rejected = await store.respondPublicationReview(
    runUrn,
    pending.version,
    session,
    question.id,
    { verdict: "REJECT", planDigest: proposal.planDigest },
  );
  await assert.rejects(
    store.requirePublicationConsent(
      runUrn,
      rejected.version,
      session,
      question.id,
      proposal,
    ),
    denied("trusted_publication_consent_required"),
  );
  const closed = await store.closeRun(runUrn, rejected.version, session);
  await assert.rejects(
    store.requirePublicationConsent(
      runUrn,
      closed.version,
      session,
      question.id,
      proposal,
    ),
    denied("task_run_closed"),
  );
});

test("typed review expiry during final identity read prevents the response write", async () => {
  const { store, setup, state } = fixture();
  const { run } = await setup();
  const proposal = publicationProposal();
  const pending = await store.appendPublicationReview(
    runUrn,
    run.version,
    session,
    question,
    proposal,
  );
  let identityReads = 0;
  state.onMe = () => {
    if (++identityReads === 2) state.now = proposal.expiresAt;
  };
  const before = state.writes;
  await assert.rejects(
    store.respondPublicationReview(
      runUrn,
      pending.version,
      session,
      question.id,
      { verdict: "APPROVE", planDigest: proposal.planDigest },
    ),
    denied("publication_review_expired"),
  );
  assert.equal(state.writes, before);
});

test("typed review binds source and Dataset references, and rejects altered response identity/time", async () => {
  const { store, setup, put } = fixture();
  const { run } = await setup();
  const proposal = publicationProposal();
  const { planDigest: _digest, ...input } = proposal;
  await assert.rejects(
    store.appendPublicationReview(
      runUrn,
      run.version,
      session,
      question,
      makePublicationReview({
        ...input,
        source: "urn:li:dataHubIngestionSource:other",
      }),
    ),
    denied("publication_task_scope_mismatch"),
  );
  for (const upstream of [
    "urn:li:dataset:(urn:li:dataPlatform:mssql,other.person,DEV)",
    "urn:li:schemaField:(urn:li:dataset:(urn:li:dataPlatform:mssql,other.person,DEV),id)",
  ]) {
    assert.throws(
      () =>
        makePublicationReview({
          ...input,
          changes: [
            {
              ...input.changes[0],
              valueJson: canonicalPublicationJson({ upstreams: [upstream] }),
            },
          ],
        }),
      /publication_dataset_outside_scope/,
    );
  }
  const pending = await store.appendPublicationReview(
    runUrn,
    run.version,
    session,
    question,
    proposal,
  );
  const approved = await store.respondPublicationReview(
    runUrn,
    pending.version,
    session,
    question.id,
    { verdict: "APPROVE", planDigest: proposal.planDigest },
  );
  for (const mutate of [
    (d) => {
      d.response.actor = "urn:li:corpuser:other";
    },
    (d) => {
      d.response.respondedAt = 1235;
    },
    (d) => {
      delete d.response.publicationVerdict;
    },
    (d) => {
      delete d.requestedAt;
    },
  ]) {
    const value = structuredClone(approved.value);
    mutate(value.decisions[0]);
    const altered = put(runUrn, "ekopAgentRun", value);
    await assert.rejects(
      store.requirePublicationConsent(
        runUrn,
        altered.ekopAgentRun.systemMetadata.version,
        session,
        question.id,
        proposal,
      ),
      denied("trusted_publication_consent_required"),
    );
  }
});

test("typed human response route is bound to the same pending native UI request", async () => {
  const { store, setup, context, state } = fixture();
  const { run } = await setup();
  const proposal = publicationProposal();
  const requestId = "00000000-0000-4000-8000-000000000021";
  const pending = await store.appendPublicationReview(
    runUrn,
    run.version,
    session,
    { ...question, id: requestId },
    proposal,
  );
  context.runtime = {
    state: async () => ({
      running: true,
      state: {
        sessionId: session,
        extensionUiRequests: [
          {
            id: "ui-review",
            method: "input",
            title: "DataHub task decision",
            placeholder: JSON.stringify({
              runUrn,
              requestId,
              question: question.question,
              choices: question.choices,
            }),
          },
        ],
      },
    }),
  };
  const request = {
    action: "respond_publication_review",
    runUrn,
    requestId,
    uiRequestId: "ui-review",
    version: pending.version,
    verdict: "APPROVE",
    planDigest: proposal.planDigest,
  };
  const writes = state.writes;
  await assert.rejects(
    nativeTasks(JSON.stringify({ ...request, uiRequestId: "other" }), context),
    denied("task_native_request_not_pending"),
  );
  assert.equal(state.writes, writes);
  const result = await nativeTasks(JSON.stringify(request), context);
  assert.equal(result.decision.response.publicationVerdict.verdict, "APPROVE");
  assert.equal(result.decision.response.actor, actor.urn);
  // No route accepts a model's raw proposal; appendPublicationReview is internal.
  await assert.rejects(
    nativeTasks(
      JSON.stringify({ action: "prepare_publication_review", proposal }),
      context,
    ),
    denied("invalid_task_request"),
  );
});

test("Task/Run/Decision public API seam: create, bind, ask, respond, second question, dismiss, history", async () => {
  const { store, setup } = fixture();
  const { run } = await setup();
  const pending = await store.appendDecision(
    runUrn,
    run.version,
    session,
    question,
  );
  const answered = await store.respondDecision(
    runUrn,
    pending.version,
    session,
    question.id,
    { action: "RESPOND", text: "Continue" },
  );
  assert.equal(answered.value.decisions[0].response.actor, actor.urn);
  assert.equal(answered.value.closedAt, undefined);
  const second = await store.appendDecision(runUrn, answered.version, session, {
    ...question,
    id: "decision-2",
  });
  const dismissed = await store.respondDecision(
    runUrn,
    second.version,
    session,
    "decision-2",
    { action: "DISMISS" },
  );
  assert.equal(dismissed.value.closedAt, 1234);
  assert.deepEqual(dismissed.value.decisions[0], answered.value.decisions[0]);
  assert.equal(dismissed.value.decisions[1].response.text, undefined);
  assert.deepEqual(
    (await store.getRun(runUrn, pending.version)).value,
    pending.value,
  );
});

test("latest-version closed run rejects both a late answer and new questions", async () => {
  const { store, setup, state } = fixture();
  const { run } = await setup();
  const pending = await store.appendDecision(
    runUrn,
    run.version,
    session,
    question,
  );
  const closed = await store.closeRun(runUrn, pending.version, session);
  const writes = state.writes;
  await assert.rejects(
    store.respondDecision(runUrn, closed.version, session, question.id, {
      action: "RESPOND",
      text: "Continue",
    }),
    denied("task_run_closed"),
  );
  await assert.rejects(
    store.appendDecision(runUrn, closed.version, session, {
      ...question,
      id: "late",
    }),
    denied("task_run_closed"),
  );
  assert.deepEqual(
    await store.closeRun(runUrn, closed.version, session),
    closed,
  );
  assert.equal(state.writes, writes);
  assert.deepEqual((await store.getRun(runUrn)).value, closed.value);
});

test("latest-version historical answer cannot be rewritten; pending questions cannot overlap", async () => {
  const { store, setup } = fixture();
  const { run } = await setup();
  const pending = await store.appendDecision(
    runUrn,
    run.version,
    session,
    question,
  );
  await assert.rejects(
    store.appendDecision(runUrn, pending.version, session, question),
    denied("task_decision_exists"),
  );
  await assert.rejects(
    store.appendDecision(runUrn, pending.version, session, {
      ...question,
      id: "other",
    }),
    denied("task_decision_pending"),
  );
  const answered = await store.respondDecision(
    runUrn,
    pending.version,
    session,
    question.id,
    { action: "RESPOND", text: "Continue" },
  );
  await assert.rejects(
    store.respondDecision(runUrn, answered.version, session, question.id, {
      action: "RESPOND",
      text: "Replace",
    }),
    denied("task_decision_already_answered"),
  );
});

test("owner, native session, scope and revision are checked before any write", async () => {
  const { store, state, setup, put } = fixture();
  const { run, task } = await setup();
  const writes = state.writes;
  await assert.rejects(
    store.appendDecision(runUrn, run.version, "other-session", question),
    denied("task_session_mismatch"),
  );
  await assert.rejects(
    store.appendDecision(runUrn, "99", session, question),
    denied("task_run_revision_conflict"),
  );
  state.sources[0].taskDatasets = [];
  await assert.rejects(
    store.appendDecision(runUrn, run.version, session, question),
    denied("task_scope_not_approved"),
  );
  state.sources[0].taskDatasets = [dataset];
  put(taskUrn, "ekopAgentTask", {
    ...task.value,
    instructions: "Revised task",
  });
  await assert.rejects(
    store.appendDecision(runUrn, run.version, session, question),
    denied("task_revision_conflict"),
  );
  put(runUrn, "ekopAgentRun", { ...run.value, actor: "urn:li:corpuser:other" });
  await assert.rejects(
    store.getRun(runUrn),
    denied("task_run_binding_mismatch"),
  );
  assert.equal(state.writes, writes);
});

test("Catalog-visible foreign metadata stays readable, but ownership guards every mutation", async () => {
  const { store, state, setup, put, context } = fixture();
  const { run, task } = await setup();
  put(taskUrn, "ekopAgentTask", {
    ...task.value,
    actor: "urn:li:corpuser:other",
  });
  put(runUrn, "ekopAgentRun", {
    ...run.value,
    actor: "urn:li:corpuser:other",
    taskVersion: "2",
  });
  assert.equal(
    (await store.getTask(taskUrn)).value.actor,
    "urn:li:corpuser:other",
  );
  assert.equal(
    (await store.getRun(runUrn)).value.actor,
    "urn:li:corpuser:other",
  );
  const before = state.writes;
  await assert.rejects(
    store.appendDecision(runUrn, "2", session, question),
    denied("task_owner_mismatch"),
  );
  await assert.rejects(
    store.closeRun(runUrn, "2", session),
    denied("task_owner_mismatch"),
  );
  await assert.rejects(
    store.bindRun(runUrn + "-other", taskUrn, "2", session),
    denied("task_owner_mismatch"),
  );
  const runtime = {
    state() {
      throw new Error("must not inspect a foreign actor's Pi session");
    },
    createSession() {
      throw new Error("must not start");
    },
  };
  const visible = await nativeTasks(
    JSON.stringify({ action: "get_run", runUrn }),
    { ...context, runtime },
  );
  assert.equal(visible.pi, undefined);
  assert.equal(visible.run.value.actor, "urn:li:corpuser:other");
  await assert.rejects(
    nativeTasks(
      JSON.stringify({
        action: "start_task",
        taskUrn,
        taskVersion: "2",
        requestId: "00000000-0000-4000-8000-000000000099",
      }),
      { ...context, runtime },
    ),
    denied("task_owner_mismatch"),
  );
  assert.equal(state.writes, before);
});

test("revoking source scope still allows owner closure, but cannot redirect it to another session", async () => {
  const { store, state, setup } = fixture();
  const { run } = await setup();
  state.sources.length = 0;
  await assert.rejects(
    store.closeRun(runUrn, run.version, "other-session"),
    denied("task_session_mismatch"),
  );
  const closed = await store.closeRun(runUrn, run.version, session);
  assert.equal(closed.value.closedAt, 1234);
});

test("changed identity / revoked grant fails before submission; errors do not echo upstream secrets", async () => {
  const { store, state } = fixture();
  state.actor = "urn:li:corpuser:other";
  await assert.rejects(
    store.createTask(taskUrn, taskInput),
    denied("task_identity_denied"),
  );
  assert.equal(state.writes, 0);
  state.actor = actor.urn;
  state.revokeAfterMe = true;
  await assert.rejects(
    store.createTask(taskUrn, taskInput),
    denied("datahub_task_unavailable"),
  );
  assert.equal(state.writes, 0);
});

test("two concurrent answers have one CAS winner and preserve the pending version", async () => {
  const { store, setup } = fixture();
  const { run } = await setup();
  const pending = await store.appendDecision(
    runUrn,
    run.version,
    session,
    question,
  );
  const answers = await Promise.allSettled(
    ["A", "B"].map((text) =>
      store.respondDecision(runUrn, pending.version, session, question.id, {
        action: "RESPOND",
        text,
      }),
    ),
  );
  const winners = answers.filter((result) => result.status === "fulfilled");
  const losers = answers.filter((result) => result.status === "rejected");
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assert.equal(losers[0].reason.status, 412);
  assert.deepEqual((await store.getRun(runUrn)).value, winners[0].value.value);
  assert.deepEqual(
    (await store.getRun(runUrn, pending.version)).value,
    pending.value,
  );
});

test("answer/close race cannot reopen the winner's closure with a fresh version", async () => {
  const { store, setup } = fixture();
  const { run } = await setup();
  const pending = await store.appendDecision(
    runUrn,
    run.version,
    session,
    question,
  );
  const results = await Promise.allSettled([
    store.closeRun(runUrn, pending.version, session),
    store.respondDecision(runUrn, pending.version, session, question.id, {
      action: "RESPOND",
      text: "Continue",
    }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const latest = await store.getRun(runUrn);
  const closed = await store.closeRun(runUrn, latest.version, session);
  await assert.rejects(
    store.appendDecision(runUrn, closed.version, session, {
      ...question,
      id: "late",
    }),
    denied("task_run_closed"),
  );
});

test("a write with unknown delivery is never retried; explicit read reconciles the committed record", async () => {
  const { store, state } = fixture();
  state.failAfterWrite = true;
  await assert.rejects(store.createTask(taskUrn, taskInput), (error) => {
    assert.equal(error.message, "task_write_unconfirmed");
    assert.deepEqual(error.reconciliation, {
      urn: taskUrn,
      expectedVersion: "-1",
    });
    assert(!JSON.stringify(error).includes("SECRET"));
    return true;
  });
  assert.equal(state.writes, 1);
  state.failAfterWrite = false;
  assert.equal(
    (await store.getTask(taskUrn)).value.instructions,
    taskInput.instructions,
  );
  assert.equal(state.writes, 1);
});

test("only an empty read batch is absent; malformed or mismatched batches remain errors", async () => {
  const f = fixture();
  for (const [body, status, message] of [
    [[], 404, "task_record_not_found"],
    [null, 502, "datahub_task_unavailable"],
    [{}, 502, "invalid_datahub_task_response"],
    [[{ urn: taskUrn + "-other" }], 502, "invalid_datahub_task_response"],
    [
      [{ urn: taskUrn }, { urn: taskUrn }],
      502,
      "invalid_datahub_task_response",
    ],
  ]) {
    const store = taskRecords({
      ...f.context,
      fetchImpl: (url, options) =>
        url.pathname.endsWith("/batchGet")
          ? Response.json(body)
          : f.context.fetchImpl(url, options),
    });
    await assert.rejects(
      store.getTask(taskUrn),
      (error) => error.status === status && error.message === message,
    );
  }
  assert.equal(f.state.writes, 0);
});

test("an empty write acknowledgement remains unconfirmed and does not replay the write", async () => {
  const f = fixture();
  const store = taskRecords({
    ...f.context,
    async fetchImpl(url, options) {
      const response = await f.context.fetchImpl(url, options);
      return url.pathname === "/openapi/v3/entity/generic"
        ? Response.json({ dataJob: [] })
        : response;
    },
  });
  await assert.rejects(
    store.createTask(taskUrn, taskInput),
    denied("task_write_unconfirmed"),
  );
  assert.equal(f.state.writes, 1);
  assert.equal(
    (await store.getTask(taskUrn)).value.instructions,
    taskInput.instructions,
  );
  assert.equal(f.state.writes, 1);
});

test("ACK-version readback succeeds when another writer already produced a later revision", async () => {
  const { store, state, setup } = fixture();
  const { run } = await setup();
  state.afterWrite = (id, aspect, value, put) =>
    put(id, aspect, { ...value, closedAt: 9999 });
  const pending = await store.appendDecision(
    runUrn,
    run.version,
    session,
    question,
  );
  assert.equal(pending.value.closedAt, undefined);
  assert.equal((await store.getRun(runUrn)).value.closedAt, 9999);
});

test("creation is create-only and rejects forged actor, off-scope datasets and response actions", async () => {
  const { store, setup, state } = fixture();
  await assert.rejects(
    store.createTask(taskUrn, { ...taskInput, actor: "urn:li:corpuser:other" }),
    denied("invalid_task_request"),
  );
  await assert.rejects(
    store.createTask(taskUrn, { ...taskInput, datasets: [dataset + "-other"] }),
    denied("task_scope_not_approved"),
  );
  assert.equal(state.writes, 0);
  const { run } = await setup();
  await assert.rejects(
    store.createTask(taskUrn, taskInput),
    (e) => e.status === 412,
  );
  const pending = await store.appendDecision(
    runUrn,
    run.version,
    session,
    question,
  );
  for (const response of [
    { action: "APPROVE_SQL" },
    { action: "RESPOND", text: "" },
    { action: "DISMISS", text: "continue" },
    { action: "RESPOND", text: "OK", actor: actor.urn },
  ])
    await assert.rejects(
      store.respondDecision(
        runUrn,
        pending.version,
        session,
        question.id,
        response,
      ),
      denied("invalid_task_request"),
    );
});

test("disabled decisions and altered Task/Run source bindings are rejected", async () => {
  const { store, setup, put } = fixture();
  const { task, run } = await setup();
  put(runUrn, "ekopAgentRun", { ...run.value, source: source + "-other" });
  await assert.rejects(
    store.getRun(runUrn),
    denied("task_run_binding_mismatch"),
  );
  put(taskUrn, "ekopAgentTask", { ...task.value, allowDecisions: false });
  put(runUrn, "ekopAgentRun", { ...run.value, taskVersion: "2" });
  await assert.rejects(
    store.appendDecision(runUrn, "3", session, question),
    denied("task_decisions_disabled"),
  );
});

const requestId = "00000000-0000-4000-8000-000000000010";
const nativeSessionId = "00000000-0000-4000-8000-000000000011";
const nativeRunUrn = `urn:li:dataProcessInstance:ekop-agent-${actor.key}-${requestId}`;
function runtimeFixture(f) {
  const calls = [];
  let ui = [];
  return {
    calls,
    setUi(value) {
      ui = value;
    },
    async createSession() {
      calls.push("ensure_session");
      return nativeSessionId;
    },
    async name() {
      calls.push("set_session_name");
    },
    async prompt(id, message) {
      const run = await f.store.getRun(nativeRunUrn);
      assert.equal(run.value.sessionId, id);
      assert(message.includes(nativeRunUrn));
      assert(message.includes(taskInput.instructions));
      calls.push("prompt");
    },
    async state(id) {
      return {
        running: true,
        state: { sessionId: id, extensionUiRequests: ui },
      };
    },
    async stop() {
      assert.equal((await f.store.getRun(nativeRunUrn)).value.closedAt, 1234);
      calls.push("stop");
      return { stopObserved: true };
    },
  };
}
async function nativeFixture() {
  const f = fixture();
  await f.store.createTask(taskUrn, taskInput);
  const runtime = runtimeFixture(f);
  const call = (input) =>
    nativeTasks(JSON.stringify(input), { ...f.context, runtime });
  const start = { action: "start_task", requestId, taskUrn, taskVersion: "1" };
  const questionRequest = {
    runUrn: nativeRunUrn,
    requestId: "00000000-0000-4000-8000-000000000012",
    question: question.question,
    choices: question.choices,
  };
  const prepare = {
    ...questionRequest,
    uiRequestId: "native-ui-id",
    action: "prepare_decision",
  };
  const setPending = () =>
    runtime.setUi([
      {
        id: prepare.uiRequestId,
        method: "input",
        title: "DataHub task decision",
        placeholder: JSON.stringify(questionRequest),
      },
    ]);
  return { ...f, runtime, call, start, prepare, setPending };
}

test("Host caller binds a native session before the only prompt and reconciles a repeated start key", async () => {
  const f = await nativeFixture();
  const result = await f.call(f.start);
  assert.equal(result.submission, "accepted");
  assert.deepEqual(f.runtime.calls, [
    "ensure_session",
    "set_session_name",
    "prompt",
  ]);
  const replay = await f.call(f.start);
  assert.equal(replay.submission, "existing_do_not_resend");
  assert.equal(replay.run.urn, result.run.urn);
  assert.deepEqual(f.runtime.calls, [
    "ensure_session",
    "set_session_name",
    "prompt",
  ]);
});

test("a concurrent cancellation cannot finish before a prepared run submits its sole native prompt", async () => {
  const f = await nativeFixture();
  let releaseName, enteredName;
  const entered = new Promise((resolve) => {
    enteredName = resolve;
  });
  const blocked = new Promise((resolve) => {
    releaseName = resolve;
  });
  f.runtime.name = async () => {
    enteredName();
    await blocked;
  };
  const starting = f.call(f.start);
  await entered;
  const run = await f.store.getRun(nativeRunUrn);
  const cancelling = f.call({
    action: "cancel_run",
    runUrn: nativeRunUrn,
    version: run.version,
  });
  await new Promise((resolve) => setImmediate(resolve));
  releaseName();
  const [started, cancelled] = await Promise.all([starting, cancelling]);
  assert.equal(started.submission, "accepted");
  assert.equal(cancelled.stopObserved, true);
  assert(
    f.runtime.calls.indexOf("prompt") < f.runtime.calls.indexOf("stop"),
    "late start revived a cancelled Task",
  );
});

test("uncertain Run creation never sends a prompt, including same-key reconciliation", async () => {
  const f = await nativeFixture();
  f.state.failAfterWrite = true;
  await assert.rejects(f.call(f.start), denied("task_write_unconfirmed"));
  assert.deepEqual(f.runtime.calls, ["ensure_session"]);
  f.state.failAfterWrite = false;
  const recovered = await f.call(f.start);
  assert.equal(recovered.submission, "existing_do_not_resend");
  assert.deepEqual(f.runtime.calls, ["ensure_session"]);
});

test("Host verifies exact pending native UI, persists an answer and replays only that pending request", async () => {
  const f = await nativeFixture();
  await f.call(f.start);
  await assert.rejects(
    f.call(f.prepare),
    denied("task_native_request_not_pending"),
  );
  f.setPending();
  await assert.rejects(
    f.call({ ...f.prepare, question: "forged" }),
    denied("task_native_request_mismatch"),
  );
  const pending = await f.call(f.prepare);
  const writes = f.state.writes;
  assert.deepEqual(await f.call(f.prepare), pending);
  assert.equal(f.state.writes, writes);
  const answered = await f.call({
    action: "respond_decision",
    runUrn: nativeRunUrn,
    requestId: f.prepare.requestId,
    uiRequestId: f.prepare.uiRequestId,
    version: pending.run.version,
    actionValue: "RESPOND",
    text: "Continue",
  });
  assert.equal(answered.decision.response.actor, actor.urn);
  assert.equal((await f.call(f.prepare)).decision.response.text, "Continue");
  f.runtime.setUi([]);
  await assert.rejects(
    f.call(f.prepare),
    denied("task_native_request_not_pending"),
  );
});

test("lost question/answer ACKs reconcile against the still-pending native request without replaying writes", async () => {
  const f = await nativeFixture();
  await f.call(f.start);
  f.setPending();
  f.state.failAfterWrite = true;
  await assert.rejects(f.call(f.prepare), denied("task_write_unconfirmed"));
  f.state.failAfterWrite = false;
  const afterQuestion = f.state.writes;
  const pending = await f.call(f.prepare);
  assert.equal(f.state.writes, afterQuestion);
  f.state.failAfterWrite = true;
  await assert.rejects(
    f.call({
      action: "respond_decision",
      runUrn: nativeRunUrn,
      requestId: f.prepare.requestId,
      uiRequestId: f.prepare.uiRequestId,
      version: pending.run.version,
      actionValue: "RESPOND",
      text: "Continue",
    }),
    denied("task_write_unconfirmed"),
  );
  f.state.failAfterWrite = false;
  const afterAnswer = f.state.writes;
  const recovered = await f.call(f.prepare);
  assert.equal(recovered.decision.response.text, "Continue");
  assert.equal(f.state.writes, afterAnswer);
});

test("Host closes admission before native stop; a fresh request cannot revive dismissal", async () => {
  const f = await nativeFixture();
  await f.call(f.start);
  f.setPending();
  const pending = await f.call(f.prepare);
  const closed = await f.call({
    action: "respond_decision",
    runUrn: nativeRunUrn,
    requestId: f.prepare.requestId,
    uiRequestId: f.prepare.uiRequestId,
    version: pending.run.version,
    actionValue: "DISMISS",
  });
  assert.equal(closed.stopObserved, true);
  assert.equal(f.runtime.calls.at(-1), "stop");
  await assert.rejects(f.call(f.prepare), denied("task_run_closed"));
});

test("Host reports uncertain stop without reopening the record or claiming Pi stopped", async () => {
  const f = await nativeFixture();
  const started = await f.call(f.start);
  f.runtime.stop = async () => {
    throw new Error("transport lost");
  };
  const result = await f.call({
    action: "cancel_run",
    runUrn: nativeRunUrn,
    version: started.run.version,
  });
  assert.equal(result.state, "stop_unconfirmed");
  assert.equal(result.stopObserved, false);
  assert.equal((await f.store.getRun(nativeRunUrn)).value.closedAt, 1234);
});

test("stale Task revision prevents replay of an already persisted human answer", async () => {
  const f = await nativeFixture();
  await f.call(f.start);
  f.setPending();
  const pending = await f.call(f.prepare);
  await f.call({
    action: "respond_decision",
    runUrn: nativeRunUrn,
    requestId: f.prepare.requestId,
    uiRequestId: f.prepare.uiRequestId,
    version: pending.run.version,
    actionValue: "RESPOND",
    text: "Continue",
  });
  const task = await f.store.getTask(taskUrn);
  f.put(taskUrn, "ekopAgentTask", { ...task.value, instructions: "Changed" });
  await assert.rejects(f.call(f.prepare), denied("task_revision_conflict"));
});

test("caller cannot inject actor/session/endpoint or start an unapproved Task scope", async () => {
  const f = await nativeFixture();
  for (const field of ["actor", "sessionId", "endpoint"])
    await assert.rejects(
      f.call({ ...f.start, [field]: "forged" }),
      denied("invalid_task_request"),
    );
  f.state.sources[0].taskDatasets = [];
  await assert.rejects(f.call(f.start), denied("task_scope_not_approved"));
  assert.deepEqual(f.runtime.calls, []);
});

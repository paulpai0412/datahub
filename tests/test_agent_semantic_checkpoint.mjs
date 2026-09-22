import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { semanticCheckpointFixture as fixture, sourceUrn, datasetUrn, executionUrn } from "./fixtures/semantic-fixture.mjs";
import { semanticCheckpoint } from "../extensions/datahub-agent/integration/semantic-checkpoint.mjs";

const python = fileURLToPath(new URL("../.venv/bin/python", import.meta.url));
const pipeline = sourceUrn;
const compressed = (value) => execFileSync(python, ["-I", "-B", "-c", "import sys,bz2,base64; print(base64.b85encode(bz2.compress(sys.stdin.buffer.read())).decode())"], {
  input: JSON.stringify(value), encoding: "utf8", timeout: 10000,
  env: { PATH: "/usr/bin:/bin", HOME: "/dev/null", LANG: "C.UTF-8" },
}).trim();
const aspect = (urns = [datasetUrn], serde = "utf-8") => ({
  timestampMillis: 1790056000000, pipelineName: pipeline, runId: executionUrn.split(":").at(-1),
  platformInstanceId: "", config: "", partitionSpec: { partition: "FULL_TABLE_SNAPSHOT", type: "FULL_TABLE" },
  state: { formatVersion: "1.0", serde, payload: serde === "utf-8" ? JSON.stringify({ urns }) : compressed({ urns }) },
});


test("official fixed SDK projects native UTF-8 and bounded bz2 checkpoints without a custom state decoder", async () => {
  const identity = await semanticCheckpoint({ mode: "identity", pipelineName: pipeline });
  assert.equal(identity.jobName, "mssql_stale_entity_removal");
  assert.match(identity.jobUrn, /^urn:li:dataJob:/);
  for (const serde of ["utf-8", "base85-bz2-json"]) {
    const decoded = await semanticCheckpoint({ mode: "decode", pipelineName: pipeline, aspect: aspect([datasetUrn, "urn:li:container:fixture"], serde) });
    assert.deepEqual(decoded.datasetUrns, [datasetUrn]);
    assert.equal(decoded.otherEntityCount, 1);
    assert.equal(decoded.sdkVersion, "1.7.0.9");
  }
});

test("unsafe/unknown serializers, invalid state, expansion bombs and script selectors fail closed", async () => {
  const bad = [
    { ...aspect(), state: { ...aspect().state, serde: "base85", payload: "PICKLE_MUST_NOT_RUN" } },
    { ...aspect(), state: { ...aspect().state, formatVersion: "future" } },
    { ...aspect(), state: { ...aspect().state, payload: "not-json" } },
    { ...aspect(), state: { formatVersion: "1.0", serde: "base85-bz2-json", payload: compressed({ urns: ["x".repeat(600000)] }) } },
  ];
  const codes = ["semantic_checkpoint_format_unsupported", "semantic_checkpoint_format_unsupported", "semantic_checkpoint_invalid", "semantic_checkpoint_too_large"];
  for (const [index, value] of bad.entries()) await assert.rejects(semanticCheckpoint({ mode: "decode", pipelineName: pipeline, aspect: value }), { code: codes[index] });
  await assert.rejects(semanticCheckpoint({ mode: "identity", pipelineName: pipeline, script: "other.py" }), /semantic_checkpoint_invalid/);
  await assert.rejects(semanticCheckpoint({ mode: "decode", pipelineName: pipeline, aspect: aspect(["x".repeat(70000)]) }), /semantic_checkpoint_too_large/);
});

test("successful checkpoint reconciles exactly the approved Run dataset set, not every DB or historical asset", async () => {
  const f = fixture();
  const result = await f.run();
  assert.equal(result.scope.basis, "native_checkpoint_reconciled_operator_scope");
  assert.equal(result.scope.completeSourceInventory, true);
  assert.equal(result.scope.ingestionMembershipVerified, true);
  assert.equal(result.scope.inventory.datasetCount, 1);
  assert.equal(result.scope.inventory.executionUrn, executionUrn);
  assert.match(result.scope.inventory.digest, /^[a-f0-9]{64}$/);
  assert.equal(result.membership.completeSourceInventory, false, "per-asset provenance alone is not full inventory proof");
  assert.equal(result.membership.status, "NATIVE_RUN_MATCH");
  assert.ok(!result.blockers.includes("source_inventory_incomplete"));
  assert.equal(result.publicationAuthorized, false);
  assert.ok(result.blockers.includes("trusted_semantic_review_required"));
  assert.doesNotMatch(JSON.stringify(result), /SOURCE_PASSWORD|DATAHUB_TOKEN|base85|payload/);
});

test("Task authorization superset is not mistaken for ingestion membership or narrowed for other Task users", async () => {
  const f = fixture();
  const downstream = "urn:li:dataset:(urn:li:dataPlatform:mssql,downstream_task_target,DEV)";
  f.policy.taskDatasets.push(downstream);
  const result = await f.run();
  assert.equal(result.scope.completeSourceInventory, true);
  assert.deepEqual(result.scope.datasetUrns, [datasetUrn]);
  assert.ok(!JSON.stringify(result).includes(downstream));
  assert.deepEqual(f.policy.taskDatasets, [datasetUrn, downstream]);
  await assert.rejects(f.run({ datasetUrn: downstream }), /semantic_dataset_not_authorized/);
});

test("named-Run inventory does not override a dataset's newer conflicting provenance", async () => {
  const f = fixture();
  f.state.dataset.schemaMetadata.systemMetadata.lastRunId = f.state.checkpoint.runId;
  f.state.dataset.schemaMetadata.systemMetadata.runId = "other-current-writer";
  const result = await f.run();
  assert.equal(result.scope.completeSourceInventory, true);
  assert.equal(result.membership.status, "UNVERIFIED");
  assert.ok(result.blockers.includes("source_membership_not_verified"));
  assert.equal(result.publicationAuthorized, false);
});

test("empty, absent, stale and additional unapproved checkpoint assets never become complete or expand model scope", async () => {
  for (const mutate of [
    f => { f.state.checkpoint = null; },
    f => { f.state.checkpoint = aspect([]); },
    f => { f.state.checkpoint.runId = "old-run"; },
    f => { f.state.checkpoint = aspect([datasetUrn, "urn:li:dataset:(urn:li:dataPlatform:mssql,PRIVATE_NOT_APPROVED,PROD)"]); },
  ]) {
    const f = fixture(); mutate(f);
    const result = await f.run({ action: "inspect_source", datasetUrn: undefined });
    assert.equal(result.scope.completeSourceInventory, false);
    assert.equal(result.scope.ingestionMembershipVerified, false);
    assert.ok(result.blockers.includes("source_inventory_incomplete"));
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_NOT_APPROVED/);
    assert.ok(result.scope.datasetUrns.every(u => u === datasetUrn));
  }
});

test("checkpoint native ACL, source/run binding and pagination freshness are enforced", async () => {
  const f = fixture();
  const before = await f.run();
  f.state.checkpoint.timestampMillis++;
  await assert.rejects(f.run({ snapshotDigest: before.snapshotDigest }), /semantic_snapshot_conflict/);
  const jobUrn = before.scope.inventory.jobUrn;
  f.state.denied.add(jobUrn);
  await assert.rejects(f.run(), /semantic_read_forbidden/);
  f.state.denied.delete(jobUrn);
  f.state.checkpoint.pipelineName = "other-source";
  await assert.rejects(f.run(), /semantic_checkpoint_invalid/);
});

test("scope listing does not disclose an approved member after its native ACL is revoked", async () => {
  const f = fixture();
  const hidden = "urn:li:dataset:(urn:li:dataPlatform:mssql,hidden,DEV)";
  f.policy.taskDatasets.push(hidden); f.state.denied.add(hidden);
  f.state.checkpoint = aspect([datasetUrn, hidden]);
  const result = await f.run({ action: "inspect_source", datasetUrn: undefined });
  assert.equal(result.scope.completeSourceInventory, false);
  assert.deepEqual(result.scope.datasetUrns, [datasetUrn]);
  assert.ok(!JSON.stringify(result).includes(hidden));
});

test("checkpoint producer configuration and unsupported connector do not fabricate native inventory", async () => {
  for (const enabled of [false, true]) {
    const f = fixture();
    const recipe = JSON.parse(f.state.recipe);
    recipe.source.config.stateful_ingestion = { enabled, remove_stale_metadata: false };
    f.state.recipe = JSON.stringify(recipe);
    f.policy.recipeSha256 = createHash("sha256").update(f.state.recipe).digest("hex");
    f.state.execution.dataHubExecutionRequestInput.value.args.recipe = JSON.stringify({ ...recipe, run_id: executionUrn, pipeline_name: sourceUrn });
    const result = await f.run();
    assert.equal(result.scope.inventory.status, "CHECKPOINT_NOT_ENABLED");
    assert.equal(result.scope.completeSourceInventory, false);
    assert.ok(f.state.calls.every(c => c.path !== "/api/gms/aspects"));
  }
  const f = fixture();
  const recipe = JSON.parse(f.state.recipe); recipe.source.type = "oracle"; f.state.sourceType = "oracle";
  f.state.recipe = JSON.stringify(recipe); f.policy.recipeSha256 = createHash("sha256").update(f.state.recipe).digest("hex");
  f.state.execution.dataHubExecutionRequestInput.value.args.recipe = JSON.stringify({ ...recipe, run_id: executionUrn, pipeline_name: sourceUrn });
  assert.equal((await f.run({ action: "inspect_source", datasetUrn: undefined })).scope.inventory.status, "CONNECTOR_CHECKPOINT_UNVERIFIED");
  assert.ok(f.state.calls.every(c => c.path !== "/api/gms/aspects"));
});

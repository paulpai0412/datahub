import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { semanticPublicationFixture } from "./fixtures/semantic-publication-fixture.mjs";
import { actor, sourceUrn, datasetUrn, executionUrn } from "./fixtures/semantic-fixture.mjs";
import { taskRecords } from "../extensions/datahub-agent/integration/task-records.mjs";
import { semanticNativeClient } from "../extensions/datahub-agent/integration/semantic-native-client.mjs";

const require = createRequire(new URL("../extensions/datahub-agent/pi-web/package.json", import.meta.url));
const { parse } = require("yaml"); // Existing locked dependency; no install or live service.
const candidate = parse(readFileSync(new URL("../extensions/datahub-agent/deploy/retention/ekop-agent-history.yaml", import.meta.url), "utf8"));
const defaults = parse(readFileSync(new URL("../upstream/datahub/datahub-upgrade/src/main/resources/boot/retention.yaml", import.meta.url), "utf8"));
function effective(entity, aspect, extra = []) {
  const entries = new Map([...defaults, ...extra].map((row) => [JSON.stringify([row.entity, row.aspect]), row.config]));
  for (const pair of [[entity, aspect], [entity, "*"], ["*", aspect], ["*", "*"]]) {
    const config = entries.get(JSON.stringify(pair));
    if (config) return config;
  }
}
const configuredLimits = Object.fromEntries(candidate.map((row) => [row.aspect, effective(row.entity, row.aspect, candidate).retention.version.maxVersions]));

test("official plugin candidate changes only the two private audit Aspects and never forces an operator overwrite", () => {
  assert.deepEqual(candidate, [
    { entity: "dataJob", aspect: "ekopAgentTask", config: { retention: { version: { maxVersions: 2147483647 } } } },
    { entity: "dataProcessInstance", aspect: "ekopAgentRun", config: { retention: { version: { maxVersions: 2147483647 } } } },
  ]);
  for (const [entity, aspect] of [["dataset", "schemaMetadata"], ["dataJob", "dataJobInfo"], ["dataProcessInstance", "dataProcessInstanceProperties"], ["dataHubExecutionRequest", "dataHubExecutionRequestResult"]])
    assert.deepEqual(effective(entity, aspect, candidate), effective(entity, aspect), `${entity}/${aspect} stays unchanged`);
  assert.equal(effective("dataJob", "ekopAgentTask").retention.version.maxVersions, 20);
  const registry = parse(readFileSync(new URL("../extensions/datahub-agent/models/registry/entity-registry.yml", import.meta.url), "utf8"));
  for (const entry of candidate)
    assert(registry.entities.find((entity) => entity.name === entry.entity)?.aspects.includes(entry.aspect), "upgrade loader requires the registered entity/aspect pair");
});

async function recordHistory(configured = false) {
  const f = semanticPublicationFixture();
  if (configured) f.writes.recordHistoryLimits = { ...configuredLimits };
  const records = taskRecords(f.context), client = semanticNativeClient(f.context);
  const taskUrn = `urn:li:dataJob:(urn:li:dataFlow:(pi,retention-fixture,DEV),${randomUUID()})`;
  const runUrn = `urn:li:dataProcessInstance:semantic-${actor.key}-${randomUUID()}`;
  const round = { scopeFingerprint: "f".repeat(64), executionUrn, policyId: "synthetic-retention-only", policyDigest: "a".repeat(64),
    datasetCount: 1, fieldCount: 2, createdAt: f.writes.now, expiresAt: f.writes.now + 7200000, generation: 1, currentCycleRunUrn: runUrn };
  const instructions = (value) => `semantic-managed-cycle/1:${JSON.stringify(value)}`;
  const firstTask = await records.createTask(taskUrn, { agent: f.policy.semanticAgentUrn, source: sourceUrn, datasets: [datasetUrn], instructions: instructions(round), allowDecisions: true });
  let run = await records.bindRun(runUrn, taskUrn, firstTask.version, f.sessionId);
  const firstRun = structuredClone(run.value);
  // Native record caller seam: a cumulative audit record advances beyond the observed 20-version default.
  // No metadata publication, model, live ingestion or claim of business maintenance.
  for (let index = 0; index < 26; index++) {
    const id = randomUUID();
    run = await records.appendDecision(runUrn, run.version, f.sessionId, { id, question: `Synthetic observation ${index}`, choices: [] });
    run = await records.respondDecision(runUrn, run.version, f.sessionId, id, { action: "RESPOND", text: "Synthetic only" });
  }
  let task = firstTask;
  for (let generation = 2; generation <= 24; generation++) {
    const next = { ...round, generation, previousCycleRunUrn: round.currentCycleRunUrn,
      currentCycleRunUrn: `urn:li:dataProcessInstance:semantic-${actor.key}-${randomUUID()}` };
    task = await records.advanceSemanticTask(taskUrn, task.version, instructions(next), () => {});
    Object.assign(round, next);
  }
  const history = () => client.call("/openapi/v3/entity/dataprocessinstance/batchGet?systemMetadata=true",
    [{ urn: runUrn, ekopAgentRun: { headers: { "If-Version-Match": "1" } } }]);
  const latestRun = () => client.call("/openapi/v3/entity/dataprocessinstance/batchGet?systemMetadata=true",
    [{ urn: runUrn, ekopAgentRun: {} }]);
  return { f, records, firstTask, firstRun, run, task, runUrn, taskUrn, round, instructions, history, latestRun };
}

test("20-version native default reproduces missing fixed history while preserving current cumulative Decisions", async () => {
  const x = await recordHistory();
  assert.equal(x.run.version, "53"); assert.equal(x.task.version, "24");
  assert.deepEqual(await x.history(), []);
  await assert.rejects(x.records.getTask(x.taskUrn, "1"), /task_record_not_found/);
  await assert.rejects(x.records.getRun(x.runUrn), /task_record_not_found/, "Host cannot substitute current Task for the missing pinned version");
  assert.equal((await x.latestRun())[0].ekopAgentRun.value.decisions.length, 26);
  assert.equal(x.f.writes.targetWrites, 0);
});

test("candidate retention preserves exact old Task and Run versions beyond 20 with native caller/CAS behavior unchanged", async () => {
  const x = await recordHistory(true), before = x.f.writes.recordWrites;
  const task = await x.records.getTask(x.taskUrn, "1"), old = await x.history();
  assert.equal(task.version, "1"); assert.deepEqual(task.value, x.firstTask.value);
  assert.equal(old.length, 1); assert.equal(old[0].ekopAgentRun.systemMetadata.version, "1");
  assert.deepEqual(old[0].ekopAgentRun.value, x.firstRun);
  assert.equal((await x.records.getRun(x.runUrn)).value.decisions.length, 26);
  await assert.rejects(x.records.advanceSemanticTask(x.taskUrn, "1", x.instructions(x.round), () => {}), /task_revision_conflict/);
  assert.equal(x.f.writes.recordWrites, before, "reads and stale CAS never write");
  assert.equal(x.f.writes.targetWrites, 0);
});

test("applying higher limits later cannot resurrect already-unavailable revisions or replace them with current", async () => {
  const x = await recordHistory();
  x.f.writes.recordHistoryLimits = { ...configuredLimits };
  const next = { ...x.round, generation: 25, previousCycleRunUrn: x.round.currentCycleRunUrn,
    currentCycleRunUrn: `urn:li:dataProcessInstance:semantic-${actor.key}-${randomUUID()}` };
  await x.records.advanceSemanticTask(x.taskUrn, x.task.version, x.instructions(next), () => {});
  await assert.rejects(x.records.getTask(x.taskUrn, "1"), /task_record_not_found/);
  assert.deepEqual(await x.history(), []);
  assert.equal((await x.records.getTask(x.taskUrn, "24")).version, "24");
  await assert.rejects(x.records.getRun(x.runUrn), /task_record_not_found/);
  assert.equal((await x.latestRun())[0].ekopAgentRun.value.decisions.length, 26);
  assert.equal(x.f.writes.targetWrites, 0);
});

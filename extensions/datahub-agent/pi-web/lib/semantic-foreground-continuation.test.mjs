// Actual pinned SDK prompt/agent_end/followUp lifecycle. Synthetic provider and
// Host, isolated HOME, no network, native publication, credentials or config writes.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createJiti } from "jiti";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { default: register } = await jiti.import("./datahub-semantic-extension.ts");
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const sdkPackage = JSON.parse(await readFile(new URL("../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url)));
const rootUrn = "urn:li:dataProcessInstance:semantic-fixture-root";

for (const scenario of ["ready", "no-progress", "revoked", "unknown", "cancel", "runtime-error", "reload", "read-only", "resume", "queued-cancel", "transport-stop", "bad-ack-stop", "native-uncertain-stop", "read-input-correction", "root-input-correction", "wrong-root-ack-stop", "source-input-correction", "inspection-input-correction", "draft-revision", "revision-uncertain-stop", "unbound-root-input-correction", "duplicate-revision-input-correction", "review-detail-input-correction", "review-detail-drift-stop", "gap-schema-correction", "host-input-correction", "host-bare-rejection-stop", "host-mismatched-rejection-stop"])      {
  test(`pinned ${sdkPackage.version} foreground preparation: ${scenario}`, async (t) => {
    assert.equal(sdkPackage.version, "0.85.1", "exercise product pin, not parent CLI");
    const root = await mkdtemp(join(tmpdir(), "semantic-foreground-sdk-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const agentDir = join(root, "agent"); await mkdir(agentDir);
    const calls = [], events = [], notes = [], lifecycle = [], requests = [];
    const uncertainty = ["transport-stop", "bad-ack-stop", "native-uncertain-stop", "wrong-root-ack-stop"].includes(scenario);
    const revising = ["draft-revision", "revision-uncertain-stop", "duplicate-revision-input-correction"].includes(scenario);
    const readingDetail = ["review-detail-input-correction", "review-detail-drift-stop"].includes(scenario);
    const correctingGap = ["gap-schema-correction", "host-input-correction", "host-bare-rejection-stop", "host-mismatched-rejection-stop"].includes(scenario);
    const reviewRef = { runUrn: rootUrn + "-review", decisionId: "00000000-0000-4000-8000-000000000002" };
    const detailProof = { version: "2", planDigest: "b".repeat(64), detailDigest: "c".repeat(64), offset: 0 };
    let recorded = revising ? 1 : 0;
    let count = revising ? 1 : scenario === "resume" ? 29 : 0, state = "DRAFT", round = 0, modelCalls = 0, sourceCorrected = false, session, aborted, wrapper;
    const services = await createAgentSessionServices({ cwd: root, agentDir,
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
        extensionFactories: [(pi) => {
          register(pi);
          pi.on("agent_end", (_event, ctx) => {
            lifecycle.push({ type: "end", idle: ctx.isIdle() });
            if (scenario === "queued-cancel" && state === "DRAFT" && count > 0) aborted = wrapper.send({ type: "abort" });
          });
          pi.on("agent_settled", (_event, ctx) => { lifecycle.push({ type: "settled", idle: ctx.isIdle() }); });
          pi.registerProvider("semantic-offline-fixture", { baseUrl: "http://invalid.invalid", apiKey: "offline-fixture-only",
            api: "semantic-offline-fixture-api", models: [{ id: "fixture", name: "Offline", reasoning: false, input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
            streamSimple(model, context, options) {
              modelCalls++;
              const stream = createAssistantMessageEventStream();
              queueMicrotask(() => {
                const previous = context.messages.at(-1);
                let content, stopReason = "stop";
                const continuation = previous?.content?.some((entry) => entry.type === "text" && entry.text.startsWith("同一前景準備尚未完成"));
                if (continuation) {
                  round++;
                  content = [{ type: "toolCall", id: `fixture-${modelCalls}`, name: "datahub_semantic", arguments:
                    { action: "seal_maintenance", ...(scenario === "root-input-correction" ? {} : { maintenanceRunUrn: rootUrn }) } }];
                  stopReason = "toolUse";
                } else if (correctingGap && previous?.role === "toolResult" && !previous.isError && JSON.parse(previous.content[0].text).action === "start_maintenance") {
                  content = [{ type: "toolCall", id: `fixture-${modelCalls}-bad-gap`, name: "datahub_semantic", arguments: {
                    action: "prepare_maintenance", contract: "catalog/1", assetUrn: "urn:li:dataset:(urn:li:dataPlatform:mssql,fixture,PROD)", snapshotDigest: "a".repeat(64),
                    gap: { code: "INSUFFICIENT_EVIDENCE", reason: "Undetermined fixture meaning", ...(scenario === "gap-schema-correction" ? {
                      operation: { action: "prepare_maintenance", maintenanceRunUrn: rootUrn } } : {}) },
                    ...(scenario === "gap-schema-correction" ? {} : { offset: 20 }),
                  } }]; stopReason = "toolUse";
                } else if (correctingGap && previous?.role === "toolResult" && (previous.isError || JSON.parse(previous.content[0].text).correctionAllowed === true)) {
                  if (previous.isError) assert.match(previous.content[0].text, /Validation failed|semantic_maintenance_gap_input/);
                  else assert.equal(JSON.parse(previous.content[0].text).retryAllowed, false);
                  content = [{ type: "toolCall", id: `fixture-${modelCalls}-fixed-gap`, name: "datahub_semantic", arguments: {
                    action: "prepare_maintenance", contract: "catalog/1", assetUrn: "urn:li:dataset:(urn:li:dataPlatform:mssql,fixture,PROD)", snapshotDigest: "a".repeat(64),
                    gap: { code: "INSUFFICIENT_EVIDENCE", reason: "Undetermined fixture meaning" },
                  } }]; stopReason = "toolUse";
                } else if (readingDetail && previous?.role === "toolResult" && !previous.isError && JSON.parse(previous.content[0].text).action === "start_maintenance") {
                  content = [{ type: "toolCall", id: `fixture-${modelCalls}-save`, name: "datahub_semantic", arguments: { action: "prepare_maintenance", maintenanceRunUrn: rootUrn } }];
                  stopReason = "toolUse";
                } else if (readingDetail && previous?.role === "toolResult" && !previous.isError && JSON.parse(previous.content[0].text).action === "prepare_maintenance") {
                  content = [{ type: "toolCall", id: `fixture-${modelCalls}-receipt`, name: "datahub_semantic", arguments: { action: "read_review", ...reviewRef } }];
                  stopReason = "toolUse";
                } else if (readingDetail && previous?.role === "toolResult" && !previous.isError && JSON.parse(previous.content[0].text).action === "read_review") {
                  const header = JSON.parse(previous.content[0].text);
                  assert.equal(header.runVersion, detailProof.version); assert.equal(header.planDigest, detailProof.planDigest); assert.equal(header.details.digest, detailProof.detailDigest);
                  content = [{ type: "toolCall", id: `fixture-${modelCalls}-detail`, name: "datahub_semantic", arguments: scenario === "review-detail-input-correction"
                    ? { action: "read_review_detail", ...reviewRef, detailDigest: header.details.digest }
                    : { action: "read_review_detail", ...reviewRef, ...detailProof, detailDigest: "d".repeat(64) } }];
                  stopReason = "toolUse";
                } else if (scenario === "review-detail-input-correction" && previous?.role === "toolResult" && previous.isError) {
                  assert.match(previous.content[0].text, /semantic_review_detail_input_required|semantic_review_detail_changed/);
                  content = [{ type: "toolCall", id: `fixture-${modelCalls}-corrected-detail`, name: "datahub_semantic", arguments: { action: "read_review_detail", ...reviewRef, ...detailProof } }];
                  stopReason = "toolUse";
                } else if (scenario === "unbound-root-input-correction" && previous?.role === "user") {
                  content = [{ type: "toolCall", id: `fixture-${modelCalls}-unbound-read`, name: "datahub_semantic", arguments: { action: "read_maintenance", offset: 0 } }];
                  stopReason = "toolUse";
                } else if (scenario === "unbound-root-input-correction" && previous?.role === "toolResult" && previous.isError) {
                  assert.match(previous.content[0].text, /semantic_maintenance_root_required|semantic_maintenance_actor_mismatch/);
                  content = [{ type: "toolCall", id: `fixture-${modelCalls}-bind`, name: "datahub_semantic", arguments: { action: "continue_maintenance", maintenanceRunUrn: rootUrn } }];
                  stopReason = "toolUse";
                } else if (scenario === "unbound-root-input-correction" && previous?.role === "toolResult" && JSON.parse(previous.content[0].text).action === "continue_maintenance") {
                  content = [{ type: "toolCall", id: `fixture-${modelCalls}-inspect`, name: "datahub_semantic", arguments: { action: "inspect_asset", contract: "catalog/1", assetUrn: "urn:li:dataset:(urn:li:dataPlatform:mssql,fixture,PROD)" } }];
                  stopReason = "toolUse";
                } else if (scenario === "duplicate-revision-input-correction" && previous?.role === "toolResult" &&
                    (previous.isError || JSON.parse(previous.content[0].text).correctionAllowed === true)) {
                  if (previous.isError) assert.match(previous.content[0].text, /semantic_duplicate_candidate/);
                  else assert.equal(JSON.parse(previous.content[0].text).inputRejection.issue, "semantic_duplicate_candidate");
                  content = [{ type: "toolCall", id: `fixture-${modelCalls}-corrected-revise`, name: "datahub_semantic", arguments: {
                    action: "revise_maintenance", contract: "catalog/1", assetUrn: "urn:li:dataset:(urn:li:dataPlatform:mssql,fixture,PROD)",
                    itemId: "00000000-0000-4000-8000-000000000001", version: "3", childVersion: "2", planDigest: "b".repeat(64),
                    candidates: [{ kind: "term", operation: "set", values: ["urn:li:glossaryTerm:fixture-a", "urn:li:glossaryTerm:fixture-b"], reason: "Complete merged associations", evidenceIds: ["fixture"] },
                      { kind: "description", fieldPath: "fixture_field", operation: "set", value: "Retained evidenced field", reason: "Whole item preserved", evidenceIds: ["fixture"] }],
                  } }];
                  stopReason = "toolUse";
                } else if (revising && previous?.role === "user") {
                  content = [{ type: "toolCall", id: `fixture-${modelCalls}-continue`, name: "datahub_semantic",
                    arguments: { action: "continue_maintenance", maintenanceRunUrn: rootUrn } }];
                  stopReason = "toolUse";
                } else if (revising && previous?.role === "toolResult" && JSON.parse(previous.content[0].text).action === "continue_maintenance") {
                  content = [{ type: "toolCall", id: `fixture-${modelCalls}-inspect`, name: "datahub_semantic", arguments:
                    { action: "inspect_asset", contract: "catalog/1", assetUrn: "urn:li:dataset:(urn:li:dataPlatform:mssql,fixture,PROD)" } },
                    { type: "toolCall", id: `fixture-${modelCalls}-revise`, name: "datahub_semantic", arguments:
                      { action: "revise_maintenance", contract: "catalog/1", assetUrn: "urn:li:dataset:(urn:li:dataPlatform:mssql,fixture,PROD)",
                        itemId: "00000000-0000-4000-8000-000000000001", version: "3", childVersion: "2", planDigest: "b".repeat(64),
                        candidates: scenario === "duplicate-revision-input-correction" ? [
                          { kind: "term", operation: "add", value: "urn:li:glossaryTerm:fixture-a", reason: "Evidenced association", evidenceIds: ["fixture"] },
                          { kind: "term", operation: "add", value: "urn:li:glossaryTerm:fixture-a", reason: "Duplicate fixture member", evidenceIds: ["fixture"] },
                          { kind: "description", fieldPath: "fixture_field", operation: "set", value: "Retained evidenced field", reason: "Whole item preserved", evidenceIds: ["fixture"] },
                        ] : [{ kind: "description", operation: "set", value: "Refined fixture subject", reason: "Whole-scheme review", evidenceIds: ["fixture"] }] } },
                    ...(scenario === "revision-uncertain-stop" ? [{ type: "toolCall", id: `fixture-${modelCalls}-must-not-seal`, name: "datahub_semantic", arguments: { action: "seal_maintenance" } }] : [])];
                  stopReason = "toolUse";
                } else if (previous?.role === "user" && scenario === "root-input-correction") {
                  content = [{ type: "toolCall", id: `fixture-${modelCalls}-start`, name: "datahub_semantic", arguments: { action: "start_maintenance", sourceUrn: "fixture-source" } },
                    { type: "toolCall", id: `fixture-${modelCalls}-inspect`, name: "datahub_semantic", arguments: { action: "inspect_asset", contract: "catalog/1", sourceUrn: "fixture-source", assetUrn: "urn:li:dataset:(urn:li:dataPlatform:mssql,fixture,PROD)" } },
                    { type: "toolCall", id: `fixture-${modelCalls}-bad-root`, name: "datahub_semantic", arguments: { action: "prepare_maintenance", contract: "catalog/1", sourceUrn: "fixture-source", assetUrn: "urn:li:dataset:(urn:li:dataPlatform:mssql,fixture,PROD)", maintenanceRunUrn: rootUrn + "-wrong" } }];
                  stopReason = "toolUse";
                } else if (scenario === "root-input-correction" && previous?.role === "toolResult" && previous.isError) {
                  assert.match(previous.content[0].text, /semantic_maintenance_root_binding_mismatch/);
                  content = [{ type: "toolCall", id: `fixture-${modelCalls}-correct-root`, name: "datahub_semantic", arguments: { action: "prepare_maintenance", contract: "catalog/1", sourceUrn: "fixture-source", assetUrn: "urn:li:dataset:(urn:li:dataPlatform:mssql,fixture,PROD)" } }];
                  stopReason = "toolUse";
                } else if (previous?.role === "user" && scenario === "inspection-input-correction") {
                  content = [{ type: "toolCall", id: `fixture-${modelCalls}-start`, name: "datahub_semantic", arguments: { action: "start_maintenance", sourceUrn: "fixture-source" } },
                    { type: "toolCall", id: `fixture-${modelCalls}-missing-inspect`, name: "datahub_semantic", arguments: { action: "prepare_maintenance", contract: "catalog/1", assetUrn: "urn:li:dataset:(urn:li:dataPlatform:mssql,fixture,PROD)" } }];
                  stopReason = "toolUse";
                } else if (scenario === "inspection-input-correction" && previous?.role === "toolResult" && previous.isError) {
                  content = [{ type: "toolCall", id: `fixture-${modelCalls}-required-inspect`, name: "datahub_semantic", arguments: { action: "inspect_asset", contract: "catalog/1", assetUrn: "urn:li:dataset:(urn:li:dataPlatform:mssql,fixture,PROD)" } }];
                  stopReason = "toolUse";
                } else if (previous?.role === "user" && scenario === "source-input-correction") {
                  content = [{ type: "toolCall", id: `fixture-${modelCalls}-start`, name: "datahub_semantic", arguments: { action: "start_maintenance", sourceUrn: "fixture-source" } },
                    { type: "toolCall", id: `fixture-${modelCalls}-bad-source`, name: "datahub_semantic", arguments: { action: "inspect_asset", contract: "catalog/1", sourceUrn: "urn:li:dataset:(fixture-source", assetUrn: "urn:li:dataset:(urn:li:dataPlatform:mssql,fixture,PROD)" } }];
                  stopReason = "toolUse";
                } else if (scenario === "source-input-correction" && previous?.role === "toolResult" && previous.isError) {
                  sourceCorrected = true;
                  content = [{ type: "toolCall", id: `fixture-${modelCalls}-correct-source`, name: "datahub_semantic", arguments: { action: "inspect_asset", contract: "catalog/1", assetUrn: "urn:li:dataset:(urn:li:dataPlatform:mssql,fixture,PROD)" } }];
                  stopReason = "toolUse";
                } else if (previous?.role === "user" && scenario === "read-input-correction") {
                  content = [{ type: "toolCall", id: `fixture-${modelCalls}-start`, name: "datahub_semantic", arguments: { action: "start_maintenance", sourceUrn: "fixture-source" } },
                    { type: "toolCall", id: `fixture-${modelCalls}-bad-read`, name: "datahub_semantic", arguments: { action: "inspect_asset", contract: "catalog/1", sourceUrn: "fixture-source", assetUrn: "urn:li:dataPlatform:mssql,fixture,PROD)" } }];
                  stopReason = "toolUse";
                } else if (scenario === "read-input-correction" && previous?.role === "toolResult" && previous.isError) {
                  content = [{ type: "toolCall", id: `fixture-${modelCalls}-correct-read`, name: "datahub_semantic", arguments: { action: "inspect_asset", contract: "catalog/1", sourceUrn: "fixture-source", assetUrn: "urn:li:dataset:(urn:li:dataPlatform:mssql,fixture,PROD)" } }];
                  stopReason = "toolUse";
                } else if ((["read-input-correction", "inspection-input-correction", "unbound-root-input-correction"].includes(scenario) || scenario === "source-input-correction" && sourceCorrected) && previous?.role === "toolResult" && JSON.parse(previous.content[0].text).action === "inspect_asset") {
                  content = [{ type: "toolCall", id: `fixture-${modelCalls}-prepare`, name: "datahub_semantic", arguments: { action: "prepare_maintenance", contract: "catalog/1", ...(["source-input-correction", "inspection-input-correction", "unbound-root-input-correction"].includes(scenario) ? {} : { sourceUrn: "fixture-source", maintenanceRunUrn: rootUrn }), assetUrn: "urn:li:dataset:(urn:li:dataPlatform:mssql,fixture,PROD)" } }];
                  stopReason = "toolUse";
                } else if (previous?.role === "user" && uncertainty) {
                  content = ["start_maintenance", "prepare_maintenance", "seal_maintenance"].map((action, index) => ({
                    type: "toolCall", id: `fixture-${modelCalls}-${index}`, name: "datahub_semantic", arguments:
                    action === "start_maintenance" ? { action, sourceUrn: "fixture-source" } : { action, maintenanceRunUrn: rootUrn },
                  }));
                  stopReason = "toolUse";
                } else if (previous?.role === "user") {
                  content = [{ type: "toolCall", id: `fixture-${modelCalls}`, name: "datahub_semantic", arguments:
                    scenario === "read-only" ? { action: "read_maintenance", maintenanceRunUrn: rootUrn } :
                    scenario === "resume" ? { action: "continue_maintenance", maintenanceRunUrn: rootUrn } :
                    { action: "start_maintenance", sourceUrn: "fixture-source" } }];
                  stopReason = "toolUse";
                } else {
                  // Reproduce the original defect: normal model finish despite
                  // an unfinished native draft. First segment saves one item.
                  if (state === "DRAFT" && !revising && !readingDetail && !correctingGap && !["no-progress", "read-only", "reload", "read-input-correction", "root-input-correction", "source-input-correction", "inspection-input-correction", "unbound-root-input-correction"].includes(scenario)) count++;
                  content = [{ type: "text", text: "Normal early model finish." }];
                  if (scenario === "runtime-error") stopReason = "error";
                }
                const message = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
                  timestamp: Date.now(), stopReason, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
                stream.push({ type: "start", partial: message });
                if (stopReason === "error" || options?.signal?.aborted) {
                  message.stopReason = options?.signal?.aborted ? "aborted" : "error";
                  message.errorMessage = "offline deterministic failure";
                  stream.push({ type: "error", reason: message.stopReason, error: message });
                } else stream.push({ type: "done", reason: stopReason, message });
                stream.end();
              });
              return stream;
            },
          });
        }] },
    });
    const model = services.modelRuntime.getModel("semantic-offline-fixture", "fixture"); assert(model);
    ({ session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(root), model, tools: ["datahub_semantic"] }));
    wrapper = new AgentSessionWrapper(session);
    t.after(() => { wrapper.destroy(); session.dispose(); });
    await session.bindExtensions({ mode: "rpc", uiContext: {
      notify(message) { notes.push(message); },
      async input(_title, raw, options) {
        const request = JSON.parse(raw); calls.push(request.action); requests.push(request);
        if (correctingGap && request.action === "prepare_maintenance") {
          if (request.offset !== undefined) {
            const inputRejection = { format: "datahub-semantic.input-rejection/1", phase: "INPUT_VALIDATION",
              nativeWriteStarted: false, correction: "NEW_INTENT_ONLY", action: request.action,
              requestId: request.requestId, maintenanceRunUrn: request.maintenanceRunUrn,
              requestDigest: createHash("sha256").update(JSON.stringify(request)).digest("hex") };
            if (scenario === "host-bare-rejection-stop") return JSON.stringify({ error: "invalid_semantic_maintenance_request" });
            if (scenario === "host-mismatched-rejection-stop") inputRejection.requestId = "wrong-request";
            return JSON.stringify({ error: "invalid_semantic_maintenance_request", inputRejection });
          }
          assert.equal(request.gap.operation, undefined); count++;
        }
        if (readingDetail && request.action === "prepare_maintenance") count++;
        if (readingDetail && request.action === "read_review") return JSON.stringify({ format: "datahub-semantic.review/1", action: request.action, requestId: request.requestId, publicationAuthorized: false,
          reviewRef, runVersion: detailProof.version, planDigest: detailProof.planDigest, details: { digest: detailProof.detailDigest, length: 2 } });
        if (readingDetail && request.action === "read_review_detail") {
          if (request.version !== detailProof.version || request.planDigest !== detailProof.planDigest || request.detailDigest !== detailProof.detailDigest || request.offset !== 0)
            return JSON.stringify({ error: "semantic_review_detail_changed" });
          return JSON.stringify({ format: "datahub-semantic.review-detail/1", action: request.action, requestId: request.requestId, publicationAuthorized: false,
            reviewRef, runVersion: detailProof.version, planDigest: detailProof.planDigest, detailDigest: detailProof.detailDigest, offset: 0, nextOffset: null, chunk: "{}" });
        }
        if (scenario === "unbound-root-input-correction" && request.action === "read_maintenance" && !request.maintenanceRunUrn) return JSON.stringify({ error: "semantic_maintenance_actor_mismatch" });
        if ((revising || ["read-input-correction", "root-input-correction", "source-input-correction", "inspection-input-correction", "unbound-root-input-correction"].includes(scenario)) && request.action === "inspect_asset") {
          if (request.assetUrn.startsWith("urn:li:dataPlatform:")) return JSON.stringify({ error: "semantic_asset_type_unsupported" });
          return JSON.stringify({ format: "datahub-semantic.preview/1", publicationAuthorized: false, action: request.action,
            requestId: request.requestId, assetUrn: request.assetUrn, offset: 0, nextOffset: null, snapshotDigest: "a".repeat(64) });
        }
        if (["read-input-correction", "root-input-correction", "source-input-correction", "inspection-input-correction", "unbound-root-input-correction"].includes(scenario) && request.action === "prepare_maintenance") {
          assert.equal(request.snapshotDigest, "a".repeat(64)); count++;
        }
        if (revising && request.action === "revise_maintenance") {
          assert.equal(request.snapshotDigest, "a".repeat(64)); assert.equal(request.sourceUrn, "fixture-source");
          assert.equal(request.maintenanceRunUrn, rootUrn);
          if (scenario === "duplicate-revision-input-correction") {
            if (request.candidates.filter(c => c.kind === "term" && !c.fieldPath).length > 1) return JSON.stringify({
              error: "invalid_semantic_maintenance_request", inputRejection: {
                format: "datahub-semantic.input-rejection/1", phase: "INPUT_VALIDATION", nativeWriteStarted: false,
                correction: "NEW_INTENT_ONLY", action: request.action, requestId: request.requestId,
                maintenanceRunUrn: request.maintenanceRunUrn, issue: "semantic_duplicate_candidate",
                requestDigest: createHash("sha256").update(JSON.stringify(request)).digest("hex"),
              },
            });
            assert.deepEqual(request.candidates[0].values, ["urn:li:glossaryTerm:fixture-a", "urn:li:glossaryTerm:fixture-b"]);
            assert.equal(request.candidates[0].operation, "set");
            assert.equal(request.candidates[1].fieldPath, "fixture_field");
            assert.equal(request.candidates[1].value, "Retained evidenced field");
          }
          recorded++;
          if (scenario === "revision-uncertain-stop") return JSON.stringify({ error: "task_write_unconfirmed",
            reconciliation: { requestId: request.requestId, maintenanceRunUrn: rootUrn, retryAllowed: false } });
        }
        if (uncertainty && request.action === "prepare_maintenance") {
          count++; // A native save may have happened: never equate lost ACK with zero effects.
          if (scenario === "transport-stop") return undefined;
          if (scenario === "bad-ack-stop") return JSON.stringify({ format: "datahub-semantic.maintenance/1",
            action: request.action, requestId: "wrong-request", publicationAuthorized: false });
          if (scenario === "wrong-root-ack-stop") return JSON.stringify({ format: "datahub-semantic.maintenance/1", action: request.action, requestId: request.requestId, publicationAuthorized: false, maintenanceRunUrn: rootUrn + "-wrong", state, readOnly: false });
          return JSON.stringify({ error: "task_write_unconfirmed", reconciliation:
            { requestId: request.requestId, maintenanceRunUrn: rootUrn, retryAllowed: false } });
        }
        assert(session.isStreaming, "Host eligibility check stays inside original busy prompt");
        assert(!session.isIdle);
        if (request.action === "continue_maintenance") {
          assert.equal(request.sessionId, session.sessionId);
          if (scenario === "revoked") return JSON.stringify({ error: "semantic_publication_not_authorized" });
          if (scenario === "unknown") return undefined;
          if (scenario === "cancel") { aborted = wrapper.send({ type: "abort" }); return undefined; }
          options?.signal?.throwIfAborted();
        }
        if (request.action === "seal_maintenance") state = "READY";
        return JSON.stringify({ format: "datahub-semantic.maintenance/1", publicationAuthorized: false,
          action: request.action, requestId: request.requestId, maintenanceRunUrn: rootUrn, sourceUrn: "fixture-source", state, readOnly: false,
          totalItems: count, ...(revising ? { totalRecordedItems: recorded } : {}), assetCount: 1, accountedAssetCount: count ? 1 : 0,
          ...(request.action === "continue_maintenance" ? { foregroundPreparation: state === "DRAFT" } : {}) });
      },
    } });
    session.setActiveToolsByName(["datahub_semantic"]);
    session.subscribe((event) => events.push({ type: event.type, idle: session.isIdle, streaming: session.isStreaming }));
    // Reload must not revive an earlier DRAFT from transcript history.
    if (scenario === "reload") {
      await session.prompt("Prepare original draft");
      const before = modelCalls;
      await session.reload();
      await session.waitForIdle();
      assert.equal(modelCalls, before);
      assert.equal(session.pendingMessageCount, 0);
    } else {
      await session.prompt("Prepare original draft");
      if (aborted) await aborted;
    }
    assert(session.isIdle);
    assert.equal(session.pendingMessageCount, 0);
    assert(!calls.some((action) => /approve|publish/.test(action)));
    const diagnostics = session.sessionManager.getEntries().filter(x => x.type === "custom" && x.customType === "datahub-semantic.foreground-lifecycle/1").map(x => x.data);
    for (const entry of diagnostics) {
      assert.equal(entry.diagnosticOnly, true); assert.equal(entry.retryAllowed, false);
      assert(!["candidates", "definition", "reason", "snapshotDigest", "sourceUrn", "assetUrn", "content"].some(k => k in entry));
    }
    if (["unbound-root-input-correction", "duplicate-revision-input-correction", "inspection-input-correction"].includes(scenario)) {
      assert(diagnostics.some(x => x.phase === "known-input-correction"));
      assert(diagnostics.some(x => x.phase === "queue-followup"));
      assert(!diagnostics.some(x => x.phase === "execute-error-stop" || x.phase === "tool-error-stop"));
    }
    if (scenario === "no-progress") assert(diagnostics.some(x => x.phase === "progress-limit-stop"));
    if (scenario === "runtime-error") {
      assert(diagnostics.some(x => x.phase === "agent-end" && x.lastStopReason === "error"));
      assert(diagnostics.some(x => x.phase === "agent-end-condition-stop"));
    }
    if (["transport-stop", "bad-ack-stop", "wrong-root-ack-stop"].includes(scenario)) assert(diagnostics.some(x => x.phase === "execute-error-stop" && x.dispatched && !x.replyConfirmed));
    if (uncertainty) {
      assert.equal(state, "DRAFT", "unconfirmed preparation must abort the SAME prompt before the next batched write");
      assert.deepEqual(calls, ["start_maintenance", "prepare_maintenance"]);
      assert.equal(modelCalls, 1, "no model retry after runtime/ACK uncertainty");
      const entries = session.sessionManager.getEntries();
      const intent = entries.filter(entry => entry.type === "custom" && entry.customType === "datahub-semantic.intent/1");
      const failed = entries.filter(entry => entry.type === "custom" && entry.customType === "datahub-semantic.unconfirmed/1");
      assert.equal(intent.length, 2);
      assert.equal(intent[1].data.requestId, requests[1].requestId);
      assert.equal(failed.length, 1);
      assert.equal(failed[0].data.requestId, requests[1].requestId);
      assert.equal(failed[0].data.reconciliation.maintenanceRunUrn, rootUrn);
      assert.equal(failed[0].data.retryAllowed, false);
    } else if (scenario === "revision-uncertain-stop") {
      assert.equal(state, "DRAFT"); assert.equal(modelCalls, 2);
      assert.deepEqual(calls, ["continue_maintenance", "inspect_asset", "revise_maintenance"]);
      const failed = session.sessionManager.getEntries().filter(entry => entry.type === "custom" && entry.customType === "datahub-semantic.unconfirmed/1");
      assert.equal(failed.length, 1); assert.equal(failed[0].data.action, "revise_maintenance");
      assert.equal(failed[0].data.retryAllowed, false);
    } else if (["ready", "resume", "read-input-correction", "root-input-correction", "source-input-correction", "inspection-input-correction", "draft-revision", "unbound-root-input-correction", "duplicate-revision-input-correction", "review-detail-input-correction", "gap-schema-correction", "host-input-correction"].includes(scenario)) {
      assert.equal(state, "READY"); assert.equal(round, 1);
      assert.equal(events.filter((event) => event.type === "agent_end").length, 2);
      assert.equal(events.filter((event) => event.type === "agent_settled").length, 1);
      assert(lifecycle.filter((event) => event.type === "end").every((event) => !event.idle));
      assert.deepEqual(lifecycle.at(-1), { type: "settled", idle: true });
      assert.equal(calls.filter((action) => action === "start_maintenance").length, scenario === "resume" || revising || scenario === "unbound-root-input-correction" ? 0 : 1);
      if (revising) {
        assert.equal(count, 1); assert.equal(recorded, 2);
        assert.deepEqual(calls, ["continue_maintenance", "inspect_asset",
          ...(scenario === "duplicate-revision-input-correction" ? ["revise_maintenance"] : []),
          "revise_maintenance", "continue_maintenance", "seal_maintenance"]);
      }
      if (["gap-schema-correction", "host-input-correction"].includes(scenario)) {
        assert(diagnostics.some(x => x.phase === "known-input-correction"));
        assert(!diagnostics.some(x => x.phase === "host-error-stop" || x.phase === "tool-error-stop"));
        assert.equal(count, 1); assert.equal(modelCalls, 6);
        const prepared = requests.filter(q => q.action === "prepare_maintenance");
        assert.equal(prepared.length, scenario === "gap-schema-correction" ? 1 : 2);
        if (prepared.length === 2) assert.notEqual(prepared[0].requestId, prepared[1].requestId);
      }
      if (scenario === "review-detail-input-correction") {
        assert.deepEqual(calls, ["start_maintenance", "prepare_maintenance", "read_review", "read_review_detail", "continue_maintenance", "seal_maintenance"]);
        assert.deepEqual(Object.fromEntries(Object.keys(detailProof).map(k => [k, requests[3][k]])), detailProof);
        assert(diagnostics.some(x => x.phase === "known-input-correction"));
        assert(!diagnostics.some(x => x.phase === "host-error-stop"));
        assert.equal(count, 1, "original save was not repeated after local read-input rejection");
      }
      if (scenario === "unbound-root-input-correction") {
        assert.deepEqual(calls, ["continue_maintenance", "inspect_asset", "prepare_maintenance", "continue_maintenance", "seal_maintenance"]);
        assert(!requests.some(q => q.action === "read_maintenance" && !q.maintenanceRunUrn));
      }
      if (scenario === "inspection-input-correction") {
        assert.deepEqual(calls, ["start_maintenance", "inspect_asset", "prepare_maintenance", "continue_maintenance", "seal_maintenance"]);
        assert.equal(requests[2].snapshotDigest, "a".repeat(64));
      }
      if (scenario === "source-input-correction") {
        assert.deepEqual(calls, ["start_maintenance", "inspect_asset", "prepare_maintenance", "continue_maintenance", "seal_maintenance"]);
        assert.equal(requests[1].sourceUrn, "fixture-source");
        assert(!requests.some(q => q.sourceUrn === "urn:li:dataset:(fixture-source"));
      }
      if (scenario === "root-input-correction") {
        assert.deepEqual(calls, ["start_maintenance", "inspect_asset", "prepare_maintenance", "continue_maintenance", "seal_maintenance"]);
        assert.equal(requests[2].maintenanceRunUrn, rootUrn);
        assert.equal(requests[2].snapshotDigest, "a".repeat(64));
        assert.equal(requests.at(-1).maintenanceRunUrn, rootUrn);
      }
      if (scenario === "read-input-correction") {
        assert.deepEqual(calls, ["start_maintenance", "inspect_asset", "inspect_asset", "prepare_maintenance", "continue_maintenance", "seal_maintenance"]);
        assert.equal(requests[2].assetUrn, "urn:li:dataset:(urn:li:dataPlatform:mssql,fixture,PROD)");
      }
    } else {
      assert.equal(state, "DRAFT"); assert.equal(round, 0);
      assert.equal(calls.filter((action) => action === "seal_maintenance").length, 0);
      if (["host-bare-rejection-stop", "host-mismatched-rejection-stop"].includes(scenario)) {
        assert.equal(modelCalls, 2); assert.equal(count, 0);
        assert.deepEqual(calls, ["start_maintenance", "prepare_maintenance"]);
        const unconfirmed = session.sessionManager.getEntries().filter(x => x.type === "custom" && x.customType === "datahub-semantic.unconfirmed/1");
        assert.equal(unconfirmed.length, 1); assert.equal(unconfirmed[0].data.retryAllowed, false);
      }
      if (scenario === "review-detail-drift-stop") {
        assert.deepEqual(calls, ["start_maintenance", "prepare_maintenance", "read_review", "read_review_detail"]);
        assert(diagnostics.some(x => x.phase === "host-error-stop" && x.error === "semantic_review_detail_changed"));
        assert(!diagnostics.some(x => x.phase === "known-input-correction"));
      }
      if (scenario === "no-progress") assert(notes.some((note) => note.includes("沒有原生準備進展")));
      if (["revoked", "unknown", "cancel"].includes(scenario)) assert(notes.some((note) => note.includes("已停止續作")));
      if (["runtime-error", "read-only"].includes(scenario)) assert(!calls.includes("continue_maintenance"));
    }
  });
}

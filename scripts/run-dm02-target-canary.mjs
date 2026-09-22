#!/usr/bin/env node
// Trusted operator for the explicitly approved six-object native canary; not an Agent tool.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { nativeIngestion } from "../extensions/datahub-agent/integration/native-ingestion.mjs";

const base = new URL("../.local/evidence/dataflow-discovery/", import.meta.url);
const origin = "http://127.0.0.1:9002";
const sourceUrn =
  "urn:li:dataHubIngestionSource:c382a4fe-48a9-4a0b-893a-95029a74b25f";
const requestId = "f2ce4ab4-1892-4936-9ac5-f2bd0370f3cb";
const recipeHash =
  "57d0a19e3e8b92b0bbe7c4497c043ae0abb11d7bc3226650ccd55eb1e935e674";
const sha = (text) => createHash("sha256").update(text).digest("hex");
const endpoint = (type, urn, aspect) =>
  `/openapi/v3/entity/${type}/${encodeURIComponent(urn)}/${aspect}?systemMetadata=true`;
const terminal = new Set([
  "SUCCESS",
  "SUCCEEDED",
  "FAILED",
  "FAILURE",
  "CANCELLED",
  "CANCELED",
  "TIMED_OUT",
  "TIMEOUT",
]);

async function main() {
  const resume = process.argv[2] === "--resume-reconciled-absence-check";
  assert.ok(process.argv[2] === "--execute-approved-target-canary" || resume);
  if (resume) {
    const prior = JSON.parse(
      await readFile(
        new URL("dm02-target-native-run-20260914.json", base),
        "utf8",
      ),
    );
    assert.equal(prior.sourceMutationAttempted, false);
    assert.equal(prior.executionMutationAttempted, false);
    assert.equal(prior.phase, "absence_and_scope_preflight");
  }
  const receiptPath = new URL(
    resume
      ? "dm02-target-native-reconciled-run-20260914.json"
      : "dm02-target-native-run-20260914.json",
    base,
  );
  const receipt = {
    sourceUrn,
    requestId,
    startedAt: Date.now(),
    status: "PREPARING",
    sourceMutationAttempted: false,
    executionMutationAttempted: false,
  };
  await writeFile(receiptPath, JSON.stringify(receipt), {
    flag: "wx",
    mode: 0o600,
  });
  const save = () =>
    writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n", {
      mode: 0o600,
    });
  let cookie = "";
  async function call(path, options = {}, absent = false) {
    const response = await fetch(new URL(path, origin), {
      ...options,
      headers: {
        "content-type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
    if (absent && response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`http_${response.status}`);
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 2_000_000) throw new Error("response_limit");
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    return text ? JSON.parse(text) : {};
  }
  async function graphql(query, variables = {}) {
    const body = await call("/api/v2/graphql", {
      method: "POST",
      body: JSON.stringify({ query, variables }),
    });
    if (body.errors?.length) throw new Error("graphql_error");
    return body.data;
  }
  try {
    const recipe = JSON.parse(
      await readFile(
        new URL(
          "../extensions/sales-datamart/metadata/target-ingestion.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const wire = JSON.stringify(recipe);
    assert.equal(sha(wire), recipeHash);
    const verified = JSON.parse(
      await readFile(
        new URL("dm02-target-native-verified-20260914.json", base),
        "utf8",
      ),
    );
    assert.equal(verified.status, "SIX_SCHEMAS_AND_24_VIEW_COLUMN_EDGES_PASS");
    const expected = JSON.parse(
      await readFile(
        new URL("dm02-target-expected-aspects-20260914.json", base),
        "utf8",
      ),
    );
    assert.equal(Object.keys(expected).length, 10);
    receipt.phase = "official_login";
    await save();
    const entry = (
      await readFile(new URL("../.local/user.props", import.meta.url), "utf8")
    )
      .split(/\r?\n/)
      .find((line) => line.startsWith("datahub:"));
    assert.ok(entry);
    const login = await fetch(origin + "/logIn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "datahub",
        password: entry.slice("datahub:".length).trim(),
      }),
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
    if (!login.ok) {
      await login.body?.cancel();
      throw new Error("official_login_failed");
    }
    cookie = login.headers
      .getSetCookie()
      .map((v) => v.split(";", 1)[0])
      .join("; ");
    await login.body?.cancel();
    const me = (
      await graphql(
        "query{me{corpUser{urn} platformPrivileges{manageIngestion}}}",
      )
    ).me;
    assert.equal(me?.corpUser?.urn, "urn:li:corpuser:datahub");
    assert.equal(me?.platformPrivileges?.manageIngestion, true);
    receipt.actor = me.corpUser.urn;
    receipt.phase = "absence_and_scope_preflight";
    await save();
    const sourcePath = endpoint(
      "datahubingestionsource",
      sourceUrn,
      "datahubingestionsourceinfo",
    );
    assert.equal(
      await call(sourcePath, {}, true),
      null,
      "source already exists; reconcile",
    );
    const oldSource = await call(
      endpoint(
        "datahubingestionsource",
        "urn:li:dataHubIngestionSource:a513e611-5631-4cf2-8b96-3fa9fd1fee51",
        "datahubingestionsourceinfo",
      ),
    );
    assert.equal(String(oldSource.systemMetadata.version), "4");
    assert.equal(
      sha(oldSource.value.config.recipe),
      "37002133b89a16959e7360e7caeb5041f73077b5ef61010d598d915e8b58be86",
    );
    receipt.preflight = [];
    // GraphQL entity(urn) returns typed references even for absent entities.
    // Follow the public SDK exists() contract: read the registered key aspect.
    const knownDataset =
      "urn:li:dataset:(urn:li:dataPlatform:mssql,adventureworks2019.sales.salesorderheader,PROD)";
    assert.ok(await call(endpoint("dataset", knownDataset, "datasetkey")));
    for (const urn of Object.keys(expected)) {
      const type = urn.split(":")[2];
      assert.ok(["dataset", "container", "query"].includes(type));
      const result = await call(endpoint(type, urn, `${type}key`), {}, true);
      receipt.preflight.push({ urn, absent: result === null });
      await save();
      assert.equal(result, null, "existing target; reconcile ownership");
    }
    receipt.phase = "create_native_source";
    receipt.sourceMutationAttempted = true;
    await save();
    await call(sourcePath + "&async=false", {
      method: "POST",
      body: JSON.stringify({
        value: {
          name: "SalesDatamart - metadata and view lineage (6 objects)",
          type: "mssql",
          platform: "urn:li:dataPlatform:mssql",
          config: {
            recipe: wire,
            version: "1.7.0.9",
            executorId: "default",
            debugMode: false,
            extraArgs: {},
          },
        },
      }),
    }); // Default CREATE semantics: no overwrite / UPSERT.
    const source = await call(sourcePath);
    assert.equal(sha(source.value.config.recipe), recipeHash);
    assert.equal(source.value.config.version, "1.7.0.9");
    assert.ok(!source.value.schedule);
    receipt.sourceVersion = String(source.systemMetadata.version);
    receipt.recipeSha256 = recipeHash;
    await save();
    const context = {
      actor: { urn: receipt.actor },
      sources: [
        { urn: sourceUrn, cliVersion: "1.7.0.9", recipeSha256: recipeHash },
      ],
      frontendOrigin: origin,
      cookieHeader: cookie,
      assertActive() {
        if (Date.now() - receipt.startedAt > 600000)
          throw new Error("operator_batch_timeout");
      },
    };
    receipt.executionUrn = `urn:li:dataHubExecutionRequest:${requestId}`;
    receipt.phase = "submit_once";
    receipt.executionMutationAttempted = true;
    await save();
    receipt.submission = await nativeIngestion(
      JSON.stringify({
        action: "run",
        sourceUrn,
        requestId,
        expectedSourceVersion: receipt.sourceVersion,
      }),
      context,
    );
    await save();
    assert.ok(
      ["submitted", "already_submitted"].includes(receipt.submission.state),
      "unknown submission; do not resend",
    );
    console.log(
      JSON.stringify({
        phase: "submitted",
        executionUrn: receipt.executionUrn,
      }),
    );
    receipt.phase = "observe";
    for (let i = 0; i < 100; i++) {
      receipt.execution = await nativeIngestion(
        JSON.stringify({
          action: "get_execution",
          requestId,
          sourceUrn,
          executionUrn: receipt.executionUrn,
        }),
        context,
      );
      await save();
      if (terminal.has(receipt.execution.state)) break;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    assert.ok(
      ["SUCCESS", "SUCCEEDED"].includes(receipt.execution.state),
      "execution not successful; reconcile",
    );
    receipt.phase = "readback";
    receipt.readback = {};
    for (const [urn, aspects] of Object.entries(expected)) {
      const type = urn.split(":")[2];
      receipt.readback[urn] = {};
      for (const name of Object.keys(aspects)) {
        receipt.readback[urn][name] = await call(
          endpoint(type, urn, name.toLowerCase()),
        );
      }
    }
    receipt.status =
      "NATIVE_RUN_SUCCESS_READBACK_CAPTURED_REQUIRES_SEMANTIC_CHECK";
  } catch (error) {
    receipt.status = "INCOMPLETE_RECONCILE_DO_NOT_REPLAY";
    receipt.errorType = error.name;
    receipt.error = /^[a-z_0-9]+$/.test(error.message)
      ? error.message
      : "see phase; no automatic retry";
    receipt.errorLocation = error.stack
      ?.split("\n")
      .find((line) => line.includes("run-dm02-target-canary.mjs"))
      ?.trim();
    process.exitCode = 1;
  } finally {
    await save();
    console.log(
      JSON.stringify({
        receipt: receiptPath.pathname,
        status: receipt.status,
        phase: receipt.phase,
        error: receipt.error,
      }),
    );
  }
}
main().catch((error) => {
  console.error(JSON.stringify({ status: "REFUSED", errorType: error.name }));
  process.exitCode = 1;
});

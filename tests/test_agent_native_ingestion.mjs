import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { nativeIngestion } from "../extensions/datahub-agent/integration/native-ingestion.mjs";
import { ingestionPolicies } from "../extensions/datahub-agent/integration/ingestion-policy.mjs";
import ingestionExtension from "../extensions/datahub-agent/pi-web/lib/datahub-ingestion-extension.ts";

const sourceUrn =
    "urn:li:dataHubIngestionSource:00000000-0000-4000-8000-000000000001";
const requestId = "00000000-0000-4000-8000-000000000002";
const actor = { urn: "urn:li:corpuser:fixture", key: "a".repeat(48) };
const recipe = JSON.stringify({
    source: {
        type: "mssql",
        config: {
            password: "${SOURCE_PASSWORD}",
            database: "Fixture",
            table_pattern: { allow: ["^Fixture.Person$"] },
            profiling: { enabled: false },
        },
    },
    sink: {
        type: "datahub-rest",
        config: {
            server: "http://datahub-gms:8080",
            token: "${DATAHUB_TOKEN}",
        },
    },
});
const policy = {
    urn: sourceUrn,
    recipeSha256: createHash("sha256").update(recipe).digest("hex"),
    cliVersion: "1.7.0.9",
};
function fixture() {
    const state = {
        permitted: true,
        active: true,
        sourceVersion: "3",
        recipe,
        input: null,
        posts: [],
        failPost: false,
        meUrn: actor.urn,
    };
    const context = {
        actor,
        sources: [policy],
        frontendOrigin: "http://datahub.example",
        cookieHeader:
            "OTHER=excluded; PLAY_SESSION=fixture-only; actor=fixture",
        assertActive() {
            assert.equal(state.active, true, "grant revoked");
        },
        async fetchImpl(url, options) {
            assert.equal(url.origin, "http://datahub.example");
            assert.equal(
                options.headers.cookie,
                "PLAY_SESSION=fixture-only; actor=fixture",
            );
            assert.equal(options.redirect, "manual");
            const body = options.body ? JSON.parse(options.body) : undefined;
            if (url.pathname === "/api/v2/graphql") {
                if (body.query.includes("platformPrivileges"))
                    return Response.json({
                        data: {
                            me: {
                                corpUser: { urn: state.meUrn },
                                platformPrivileges: {
                                    manageIngestion: state.permitted,
                                },
                            },
                        },
                    });
                if (body.query.includes("cancelIngestion"))
                    return Response.json({
                        data: { cancelIngestionExecutionRequest: true },
                    });
                return Response.json({
                    data: {
                        executionRequest: {
                            result: {
                                status: "SUCCESS",
                                durationMs: 100,
                                structuredReport: {
                                    contentType: "application/json",
                                    serializedValue: JSON.stringify({
                                        basic_connectivity: { capable: false },
                                        secret: "DO_NOT_RETURN",
                                    }),
                                },
                            },
                        },
                    },
                });
            }
            if (url.pathname.endsWith("/datahubingestionsourceinfo"))
                return Response.json({
                    value: {
                        name: "Fixture only",
                        config: {
                            recipe: state.recipe,
                            version: "1.7.0.9",
                            executorId: "default",
                            debugMode: false,
                        },
                    },
                    systemMetadata: { version: state.sourceVersion },
                });
            assert.ok(url.pathname.endsWith("/datahubexecutionrequestinput"));
            if (options.method === "POST") {
                state.posts.push(body);
                assert.equal(url.searchParams.get("createIfNotExists"), "true");
                assert.equal(body.headers["If-Version-Match"], "-1");
                if (state.failPost) throw Error("sensitive upstream detail");
                state.input = body.value;
                return Response.json({ value: state.input });
            }
            return state.input
                ? Response.json({ value: state.input })
                : new Response("", { status: 404 });
        },
    };
    return {
        state,
        context,
        run: (overrides) =>
            nativeIngestion(
                JSON.stringify({
                    requestId,
                    action: "run",
                    sourceUrn,
                    expectedSourceVersion: "3",
                    ...overrides,
                }),
                context,
            ),
    };
}

test("native tool emits an intent, preserves a reconciliation ID and requires the host UI", async () => {
    let tool;
    ingestionExtension({
        registerTool(value) {
            tool = value;
        },
    });
    assert.equal(tool.parameters.additionalProperties, false);
    const noUI = { mode: "rpc", ui: { input() { assert.fail("invalid arguments must not reach the host"); } } };
    await assert.rejects(tool.execute("fixture", { action: "get_execution", executionUrn: `urn:li:dataHubExecutionRequest:${requestId}` }, undefined, undefined, noUI), /sourceUrn is required/);
    await assert.rejects(tool.execute("fixture", { action: "cancel", sourceUrn }, undefined, undefined, noUI), /executionUrn together with sourceUrn/);
    const denied = await tool.execute(
        "fixture",
        { action: "list_sources" },
        undefined,
        undefined,
        { mode: "tui" },
    );
    assert.equal(denied.details.error, "datahub_host_required");
    let proposed;
    const result = await tool.execute(
        "fixture",
        { action: "run", sourceUrn },
        undefined,
        (update) => {
            proposed = update.details.proposedExecutionUrn;
        },
        {
            mode: "rpc",
            ui: {
                async input(title, text) {
                    assert.equal(title, "DataHub ingestion request");
                    const intent = JSON.parse(text);
                    assert.equal(
                        `urn:li:dataHubExecutionRequest:${intent.requestId}`,
                        proposed,
                    );
                    assert.equal(intent.sourceUrn, sourceUrn);
                    assert.deepEqual(Object.keys(intent).sort(), [
                        "action",
                        "requestId",
                        "sourceUrn",
                    ]);
                    return JSON.stringify({
                        state: "declined",
                        submitted: false,
                    });
                },
            },
        },
    );
    assert.equal(result.details.state, "declined");
    assert.equal(result.details.proposedExecutionUrn, proposed);
    let intent;
    const failedUI = { mode: "rpc", ui: { async input(_title, text) { intent = JSON.parse(text); return JSON.stringify({ state: "unconfirmed", error: "ingestion_request_failed" }); } } };
    const uncertain = await tool.execute("fixture", { action: "run", sourceUrn }, undefined, undefined, failedUI);
    assert.equal(uncertain.details.proposedExecutionUrn, `urn:li:dataHubExecutionRequest:${intent.requestId}`);
    assert.equal(uncertain.details.requestId, intent.requestId);
    assert.deepEqual(JSON.parse(uncertain.content[0].text), uncertain.details);
    const target = `urn:li:dataHubExecutionRequest:${requestId}`;
    const lookup = await tool.execute("fixture", { action: "get_execution", sourceUrn, executionUrn: target }, undefined, undefined, failedUI);
    assert.equal(lookup.details.executionUrn, target);
    assert.equal(Object.hasOwn(lookup.details, "proposedExecutionUrn"), false);
});

test("operator policy is deny-by-default and pins only reviewed source/CLI/recipe", () => {
    assert.equal(ingestionPolicies().size, 0);
    assert.deepEqual(
        ingestionPolicies({ [actor.key]: [policy] }).get(actor.key),
        [policy],
    );
    for (const bad of [
        null,
        [],
        { bad: [] },
        { [actor.key]: [{ ...policy, cliVersion: "latest" }] },
        { [actor.key]: [policy, policy] },
        { [actor.key]: [{ ...policy, password: "not allowed" }] },
    ])
        assert.throws(() => ingestionPolicies(bad));
});

test("native immutable snapshot, repeat acknowledgement, cancellation and safe status projection", async () => {
    const f = fixture();
    const result = await f.run();
    assert.equal(result.state, "submitted");
    assert.equal(f.state.posts.length, 1);
    assert.equal(f.state.input.actorUrn, actor.urn);
    assert.equal(f.state.input.source.ingestionSource, sourceUrn);
    const snapshot = JSON.parse(f.state.input.args.recipe);
    assert.deepEqual(snapshot.source, JSON.parse(recipe).source);
    assert.equal(snapshot.run_id, result.executionUrn);
    assert.equal(snapshot.pipeline_name, sourceUrn);
    assert.equal((await f.run()).state, "already_submitted");
    assert.equal(f.state.posts.length, 1);
    const status = await f.run({
        action: "get_execution",
        executionUrn: result.executionUrn,
    });
    assert.equal(status.state, "SUCCESS");
    assert.equal(status.basicConnectivityCapable, false);
    assert.ok(!JSON.stringify(status).includes("DO_NOT_RETURN"));
    assert.equal(
        (await f.run({ action: "cancel", executionUrn: result.executionUrn }))
            .state,
        "cancel_requested",
    );
});

test("scope, fresh identity/permission, recipe and source version conflicts prevent submission", async () => {
    for (const mutate of [
        (f) => {
            f.state.permitted = false;
        },
        (f) => {
            f.state.meUrn = "urn:li:corpuser:other";
        },
        (f) => {
            f.state.sourceVersion = "4";
        },
        (f) => {
            f.state.recipe += " ";
        },
        (f) => {
            f.state.active = false;
        },
    ]) {
        const f = fixture();
        mutate(f);
        await assert.rejects(f.run());
        assert.equal(f.state.posts.length, 0);
    }
    const f = fixture();
    for (const overrides of [
        { sourceUrn: sourceUrn + "other" },
        { action: "delete" },
        { recipe: "untrusted" },
        { requestId: "../anything" },
        { expectedSourceVersion: undefined },
    ])
        await assert.rejects(f.run(overrides));
    assert.equal(f.state.posts.length, 0);
});

test("unknown mutation outcome is not retried; another actor execution cannot be read or cancelled", async () => {
    const f = fixture();
    f.state.failPost = true;
    const result = await f.run();
    assert.equal(result.state, "unknown");
    assert.equal(f.state.posts.length, 1);
    assert.ok(!JSON.stringify(result).includes("sensitive upstream detail"));
    f.state.input = {
        actorUrn: "urn:li:corpuser:other",
        source: { ingestionSource: sourceUrn },
    };
    await assert.rejects(
        f.run({ action: "get_execution", executionUrn: result.executionUrn }),
        /execution_scope_mismatch/,
    );
    await assert.rejects(
        f.run({ action: "cancel", executionUrn: result.executionUrn }),
        /execution_scope_mismatch/,
    );
});

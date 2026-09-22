import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createIdentityVerifier } from "../extensions/datahub-agent/integration/datahub-identity.mjs";

const cookiePair =
  "PLAY_SESSION=synthetic-session; actor=urn:li:corpuser:alice";

// Real loopback HTTP contract; the identity provider here is a synthetic fixture,
// not evidence of an authenticated live DataHub session or a deployed gateway.
test("DataHub identity boundary", async (t) => {
  let status = 200;
  let body = JSON.stringify({
    data: { me: { corpUser: { urn: "urn:li:corpuser:alice" } } },
  });
  const requests = [];
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    requests.push({
      path: request.url,
      headers: request.headers,
      body: JSON.parse(text),
    });
    // Fixture models AuthUtils.hasValidSessionCookie's required matching pair.
    if (request.headers.cookie !== cookiePair) {
      response.writeHead(401);
      response.end();
      return;
    }
    response.writeHead(status, { "content-type": "application/json" });
    response.end(body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const frontendOrigin = `http://127.0.0.1:${server.address().port}`;
  const verify = createIdentityVerifier({ frontendOrigin, tenant: "test" });
  try {
    await t.test(
      "official identity requires the session pair, never unrelated cookies",
      async () => {
        const actor = await verify(
          "actor=urn:li:corpuser:alice; PLAY_SESSION=synthetic-session; pi_web_session=ignored",
        );
        assert.equal(actor.urn, "urn:li:corpuser:alice");
        assert.equal(actor.tenant, "test");
        assert.match(actor.key, /^[a-f0-9]{48}$/);
        assert.equal(requests[0].headers.cookie, cookiePair);
        assert.equal(requests[0].headers.authorization, undefined);
        assert.equal(requests[0].path, "/api/v2/graphql");
        assert.deepEqual(requests[0].body, {
          query: "query AgentIdentity { me { corpUser { urn } } }",
        });
        assert.equal(Object.isFrozen(actor), true);
        const other = await createIdentityVerifier({
          frontendOrigin,
          tenant: "other",
        })(cookiePair);
        assert.notEqual(actor.key, other.key);
        await assert.rejects(
          verify(
            "PLAY_SESSION=synthetic-session; actor=urn:li:corpuser:mallory",
          ),
          {
            message: "authentication_required",
          },
        );
      },
    );
    await t.test(
      "missing, ambiguous and malformed session cookies fail before network",
      async () => {
        const before = requests.length;
        for (const cookie of [
          undefined,
          "",
          "actor=alice",
          "PLAY_SESSION=",
          "PLAY_SESSION=a",
          "PLAY_SESSION=a; actor=",
          "PLAY_SESSION=a; PLAY_SESSION=b; actor=alice",
          "PLAY_SESSION=a; actor=alice; actor=bob",
          "PLAY_SESSION=a\r\nadmin=yes",
          "x".repeat(16385),
        ]) {
          await assert.rejects(verify(cookie), {
            message: "authentication_required",
          });
        }
        assert.equal(requests.length, before);
      },
    );
    await t.test(
      "server denial, redirects and unavailable identity fail closed",
      async () => {
        for (status of [401, 403, 302, 500]) {
          await assert.rejects(verify(cookiePair), {
            message: [401, 403].includes(status)
              ? "authentication_required"
              : "identity_unavailable",
          });
        }
        status = 200;
      },
    );
    await t.test(
      "GraphQL errors and invalid principals never authorize",
      async () => {
        for (const value of [
          null,
          {},
          {
            errors: [{ message: "secret" }],
            data: { me: { corpUser: { urn: "urn:li:corpuser:alice" } } },
          },
          ...[
            "urn:li:dataset:x",
            "urn:li:corpuser:",
            "urn:li:corpuser:alice\n",
            123,
          ].map((urn) => ({ data: { me: { corpUser: { urn } } } })),
        ]) {
          body = JSON.stringify(value);
          await assert.rejects(verify(cookiePair), {
            message: "authentication_required",
          });
        }
      },
    );
    await t.test(
      "malformed and oversized response details are not echoed",
      async () => {
        for (body of [
          "synthetic-secret",
          JSON.stringify({ secret: "x".repeat(17000) }),
        ]) {
          await assert.rejects(verify(cookiePair), {
            message: "identity_unavailable",
          });
        }
      },
    );
    await t.test(
      "configuration rejects credentials, non-HTTP, paths and invalid URLs",
      () => {
        assert.throws(
          () =>
            createIdentityVerifier({
              frontendOrigin,
              tenant: "test",
              cookieName: "actor",
            }),
          {
            message: "invalid_identity_configuration",
          },
        );
        for (const origin of [
          "invalid secret",
          "file:///tmp/x",
          "http://user:secret@localhost",
          `${frontendOrigin}/api`,
          `${frontendOrigin}/?key=secret`,
        ]) {
          assert.throws(
            () =>
              createIdentityVerifier({
                frontendOrigin: origin,
                tenant: "test",
              }),
            { message: "invalid_identity_configuration" },
          );
        }
      },
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

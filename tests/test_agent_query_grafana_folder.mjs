import assert from "node:assert/strict";
import test from "node:test";
import { createQueryFolderResolver } from "../extensions/datahub-agent/integration/query-grafana-folder.mjs";

function fixture({ profile = {}, accounts, orgId = 2 } = {}) {
  const writer = {
    id: 0,
    uid: "opaque-service-identity",
    name: "Query writer",
    login: "sa-2-query-writer",
    orgId: 2,
    ...profile,
  };
  const account = {
    id: 8,
    name: writer.name,
    login: writer.login,
    orgId: 2,
    isDisabled: false,
  };
  const calls = [];
  let folder, acl;
  const resolve = createQueryFolderResolver(
    { orgId: 2, folderNamespace: "query-test" },
    async (path, token, options) => {
      assert.equal(token, "fixture-token");
      calls.push({ path, method: options.method });
      if (path === "/api/org") return { id: orgId };
      if (path === "/api/user") return writer;
      if (path === "/api/org/users/lookup")
        return [{ userId: 3, login: "alice" }];
      if (path.startsWith("/api/serviceaccounts/search?")) {
        assert.equal(
          new URL(path, "http://fixture.invalid").searchParams.get("query"),
          writer.name,
        );
        return { serviceAccounts: accounts ?? [account], totalCount: 1 };
      }
      if (path === "/api/folders" && options.method === "POST") {
        folder = JSON.parse(options.body);
        return folder;
      }
      if (path.endsWith("/permissions")) {
        if (options.method === "POST") {
          acl = JSON.parse(options.body).items;
          return { message: "updated" };
        }
        return acl;
      }
      if (path.startsWith("/api/folders/")) return folder ?? null;
      throw Error("unexpected_native_route");
    },
  );
  return {
    resolve: (login = "alice") =>
      resolve(login, "fixture-token", { assertActive() {} }),
    calls,
    acl: () => acl,
  };
}

test("Grafana 13 id=0 service writer is resolved through native account name/login/org, not opaque uid", async () => {
  const h = fixture();
  const uid = await h.resolve();
  assert.match(uid, /^dqf-[a-f0-9]{32}$/);
  assert.deepEqual(h.acl(), [
    { userId: 3, permission: 1 },
    { userId: 8, permission: 4 },
  ]);
  assert.equal(await h.resolve(), uid);
  assert.equal(
    h.calls.filter((c) => c.path === "/api/folders" && c.method === "POST")
      .length,
    1,
  );
});

test("older native positive writer IDs preserve private ACL behavior without account search", async () => {
  const h = fixture({ profile: { id: 8 } });
  await h.resolve();
  assert.equal(
    h.calls.filter((c) => c.path.includes("/serviceaccounts/")).length,
    0,
  );
  assert.deepEqual(h.acl(), [
    { userId: 3, permission: 1 },
    { userId: 8, permission: 4 },
  ]);
});

const valid = {
  id: 8,
  name: "Query writer",
  login: "sa-2-query-writer",
  orgId: 2,
  isDisabled: false,
};
for (const [label, options] of [
  ["missing account", { accounts: [] }],
  ["wrong login", { accounts: [{ ...valid, login: "someone-else" }] }],
  ["wrong name", { accounts: [{ ...valid, name: "another writer" }] }],
  ["wrong account org", { accounts: [{ ...valid, orgId: 1 }] }],
  ["disabled account", { accounts: [{ ...valid, isDisabled: true }] }],
  ["ambiguous accounts", { accounts: [valid, { ...valid, id: 9 }] }],
  ["zero account ID", { accounts: [{ ...valid, id: 0 }] }],
  ["writer equals reader", { accounts: [{ ...valid, id: 3 }] }],
  ["wrong current org", { orgId: 1 }],
  ["wrong profile org", { profile: { orgId: 1 } }],
  ["missing native name", { profile: { name: undefined } }],
])
  test(`service writer ${label} is refused before folder writes`, async () => {
    const h = fixture(options);
    await assert.rejects(h.resolve(), /query_grafana_identity_unavailable/);
    assert.equal(h.calls.filter((c) => c.method === "POST").length, 0);
  });

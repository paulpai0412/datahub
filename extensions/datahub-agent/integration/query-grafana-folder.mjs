import { createHash } from "node:crypto";
import { rejectQuery } from "./query-metadata.mjs";

/** Native folder ACLs isolate dashboard metadata as well as result values.
 * Org administrators retain Grafana's native administrative access. */
export function createQueryFolderResolver(config, call) {
  const pending = new Map();
  async function writerUserId(writer, token, context) {
    if (Number.isSafeInteger(writer.id) && writer.id > 0) return writer.id;
    // Grafana 13 /api/user returns id=0 for service accounts. Resolve the
    // native ACL principal through the public service-account API instead of
    // interpreting its opaque uid or treating zero as a real user ID.
    if (
      writer.id !== 0 ||
      typeof writer.name !== "string" ||
      !writer.name ||
      writer.name.length > 256 ||
      typeof writer.login !== "string" ||
      !writer.login ||
      writer.login.length > 256
    )
      rejectQuery("query_grafana_identity_unavailable", 403);
    const result = await call(
      `/api/serviceaccounts/search?perpage=1000&page=1&query=${encodeURIComponent(writer.name)}`,
      token,
      { method: "GET" },
      context.signal,
    );
    const matches = Array.isArray(result?.serviceAccounts)
      ? result.serviceAccounts.filter(
          (account) =>
            account.name === writer.name &&
            account.login === writer.login &&
            account.orgId === config.orgId &&
            account.isDisabled === false,
        )
      : [];
    if (
      matches.length !== 1 ||
      !Number.isSafeInteger(matches[0].id) ||
      matches[0].id < 1
    )
      rejectQuery("query_grafana_identity_unavailable", 403);
    context.assertActive();
    return matches[0].id;
  }
  async function permissions(uid, readerId, writerId, token, context) {
    const rows = await call(
      `/api/folders/${uid}/permissions`,
      token,
      { method: "GET" },
      context.signal,
    );
    const expected = new Map([
      [readerId, 1],
      [writerId, 4],
    ]);
    if (
      !Array.isArray(rows) ||
      rows.length !== 2 ||
      rows.some(
        (r) =>
          r.role ||
          r.teamId ||
          r.isInherited ||
          expected.get(r.userId) !== r.permission,
      ) ||
      new Set(rows.map((r) => r.userId)).size !== 2
    )
      rejectQuery("query_grafana_folder_not_private", 403);
    context.assertActive();
  }
  return async (viewerLogin, token, context) => {
    if (
      typeof viewerLogin !== "string" ||
      !/^[A-Za-z0-9_.@-]{1,100}$/.test(viewerLogin)
    )
      rejectQuery("query_grafana_identity_unavailable", 403);
    const org = await call(
      "/api/org",
      token,
      { method: "GET" },
      context.signal,
    );
    const writer = await call(
      "/api/user",
      token,
      { method: "GET" },
      context.signal,
    );
    const users = await call(
      "/api/org/users/lookup",
      token,
      { method: "GET" },
      context.signal,
    );
    const matching = Array.isArray(users)
      ? users.filter((u) => u.login === viewerLogin)
      : [];
    if (
      org.id !== config.orgId ||
      writer.orgId !== config.orgId ||
      matching.length !== 1 ||
      !Number.isSafeInteger(matching[0].userId) ||
      matching[0].userId < 1
    )
      rejectQuery("query_grafana_identity_unavailable", 403);
    const writerId = await writerUserId(writer, token, context);
    const readerId = matching[0].userId;
    if (readerId === writerId)
      rejectQuery("query_grafana_identity_unavailable", 403);
    const uid =
      "dqf-" +
      createHash("sha256")
        .update(
          JSON.stringify([config.orgId, config.folderNamespace, readerId]),
        )
        .digest("hex")
        .slice(0, 32);
    const title = `DataHub queries · ${viewerLogin}`;
    if (!pending.has(uid)) {
      const task = (async () => {
        let folder = await call(
          `/api/folders/${uid}`,
          token,
          { method: "GET" },
          context.signal,
          true,
        );
        if (!folder) {
          context.assertActive();
          folder = await call(
            "/api/folders",
            token,
            { method: "POST", body: JSON.stringify({ uid, title }) },
            context.signal,
          );
          if (folder.uid !== uid || folder.title !== title)
            rejectQuery("query_grafana_readback_mismatch", 502);
          // Never place dashboard metadata in the initial default-shared folder.
          await call(
            `/api/folders/${uid}/permissions`,
            token,
            {
              method: "POST",
              body: JSON.stringify({
                items: [
                  { userId: readerId, permission: 1 },
                  { userId: writerId, permission: 4 },
                ],
              }),
            },
            context.signal,
          );
        } else if (folder.uid !== uid || folder.title !== title)
          rejectQuery("query_grafana_folder_conflict", 409);
        await permissions(uid, readerId, writerId, token, context);
      })();
      // Serialize first creation; unknown writes stay recorded, not retried.
      pending.set(uid, task);
      task.then(
        () => pending.delete(uid),
        () => {},
      );
    }
    await pending.get(uid);
    // Existing folders may have been shared since the previous publication.
    await permissions(uid, readerId, writerId, token, context);
    return uid;
  };
}

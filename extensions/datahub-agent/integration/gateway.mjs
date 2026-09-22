import { createServer, request as httpRequest } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { Transform } from "node:stream";
import { BrowserGrants, GrantError } from "./browser-grants.mjs";
import { IngestionError } from "./native-ingestion.mjs";
import { DiscoveryError } from "./native-discovery.mjs";
import { SemanticError } from "./native-semantic.mjs";
import { TaskRecordError } from "./task-records.mjs";
import manifest from "../pi-web/app/manifest.ts";
import {
  createWebSessionToken,
  PI_WEB_SESSION_COOKIE,
} from "../pi-web/lib/web-auth.ts";

const COOKIE = "datahub_agent_session";
// Parent navigation enters through bootstrap, then redirects within this origin.
// A UUID-only query forces document navigation (a fragment could leave an old
// bootstrap error page intact). The destination still requires its cookie/grant;
// selecting a session neither exchanges nor creates authority.
const BOOTSTRAP_SCRIPT = `const ticket=location.hash.slice(1),session=new URLSearchParams(location.search).get('session');history.replaceState(null,'','/bootstrap');(async()=>{if(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(session??'')){location.replace('/?session='+encodeURIComponent(session));return}if(!navigator.locks){document.querySelector('p').textContent='This browser needs Web Locks support to open Agent safely.';return}const signal=AbortSignal.timeout(25000);await navigator.locks.request('datahub-agent-exchange',{signal},async()=>{const r=await fetch('/agent/exchange',{method:'POST',signal,headers:{'content-type':'application/json'},body:JSON.stringify({ticket})});if(!r.ok)throw Error();await r.arrayBuffer()});location.replace('/')})().catch(()=>{document.querySelector('p').textContent='Agent login expired. Reopen Agent from DataHub.'});`;
const FORWARDED_HEADERS = [
  "accept",
  "accept-language",
  "content-type",
  "range",
  "if-range",
  "if-none-match",
  "last-event-id",
  "rsc",
  "next-router-state-tree",
  "next-router-prefetch",
  "next-url",
  "next-action",
];

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
  }
}

function originUrl(value) {
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url;
  } catch {
    throw new Error("invalid_gateway_configuration");
  }
}

function json(response, status, data) {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(data));
}

async function body(request, expectedKeys, maxBytes = 4096) {
  if (request.headers["content-type"]?.split(";", 1)[0] !== "application/json")
    throw new HttpError(415, "json_required");
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, "request_too_large");
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !== expectedKeys.length ||
      !expectedKeys.every((key) => typeof value[key] === "string")
    )
      throw new Error();
    return value;
  } catch {
    throw new HttpError(400, "invalid_request");
  }
}

function cookieValue(header, optional = false) {
  const cookies = (header ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${COOKIE}=`));
  if (optional && cookies.length === 0) return undefined;
  if (cookies.length !== 1) throw new GrantError();
  return cookies[0].slice(COOKIE.length + 1);
}

function exactOrigin(request, expected) {
  if (request.headers.origin !== expected)
    throw new HttpError(403, "untrusted_origin");
}

async function proxy(
  request,
  response,
  runtime,
  grants,
  session,
  key,
  maxBytes,
) {
  const target = originUrl(runtime.origin);
  // Only deployment-owned private HTTP runtimes; never a browser-supplied URL.
  if (
    target.protocol !== "http:" ||
    typeof runtime.password !== "string" ||
    runtime.password.length < 32
  ) {
    throw new HttpError(503, "runtime_unavailable");
  }
  if (Number(request.headers["content-length"] ?? 0) > maxBytes)
    throw new HttpError(413, "request_too_large");
  const headers = Object.fromEntries(
    FORWARDED_HEADERS.filter((name) => request.headers[name] !== undefined).map(
      (name) => [name, request.headers[name]],
    ),
  );
  headers.host = target.host;
  headers.origin = target.origin;
  // This is a fresh PRIVATE pi-web credential, never the browser/DataHub cookie.
  // Reuse the pinned upstream algorithm: its page routes do not accept Basic Auth.
  headers.cookie = `${PI_WEB_SESSION_COOKIE}=${createWebSessionToken(runtime.password)}`;
  let transport;
  if (runtime.openSocket) {
    const abort = new AbortController();
    const disconnected = () => abort.abort();
    response.once("close", disconnected);
    try {
      transport = await runtime.openSocket(
        AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
      );
    } finally {
      response.off("close", disconnected);
    }
    if (response.destroyed) {
      transport.destroy();
      return;
    }
    try {
      grants.authorize(session, key);
    } catch (error) {
      transport.destroy();
      throw error;
    }
  }
  let upstream;
  let unwatch;
  try {
    unwatch = grants.onRevoke(session, key, () => {
      upstream?.destroy();
      transport?.destroy();
      response.destroy();
    });
  } catch (error) {
    transport?.destroy();
    throw error;
  }
  response.on("close", () => {
    unwatch();
    upstream?.destroy();
    transport?.destroy();
  });
  upstream = httpRequest({
    ...(transport ? { createConnection: () => transport } : {}),
    hostname: target.hostname,
    port: target.port || 80,
    method: request.method,
    path: request.url,
    headers,
  });
  request.on("aborted", () => upstream.destroy());
  upstream.on("error", () =>
    json(response, 502, { error: "runtime_unavailable" }),
  );
  upstream.on("response", (incoming) => {
    if (response.destroyed) {
      incoming.destroy();
      return;
    }
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (
        value !== undefined &&
        ![
          "set-cookie",
          "connection",
          "transfer-encoding",
          "keep-alive",
          "x-frame-options",
          "content-security-policy",
          "cache-control",
        ].includes(name) &&
        !name.startsWith("access-control-")
      )
        response.setHeader(name, value);
    }
    if (incoming.headers.location?.startsWith(target.origin + "/")) {
      response.setHeader(
        "location",
        incoming.headers.location.slice(target.origin.length),
      );
    }
    response.setHeader("cache-control", "no-store");
    response.writeHead(incoming.statusCode ?? 502);
    incoming.on("error", () => response.destroy());
    incoming.pipe(response);
  });
  let size = 0;
  const bounded = new Transform({
    transform(chunk, _encoding, done) {
      size += chunk.length;
      done(
        size > maxBytes ? new Error("request_too_large") : null,
        size > maxBytes ? undefined : chunk,
      );
    },
  });
  bounded.on("error", () => {
    request.unpipe(bounded);
    upstream.destroy();
    if (response.headersSent) response.destroy();
    else {
      response.setHeader("connection", "close");
      json(response, 413, { error: "request_too_large" });
    }
    request.resume();
  });
  request.pipe(bounded).pipe(upstream);
}

async function addBrowserAssets(directory, assets) {
  if (!directory) return;
  const root = join(directory, "_next/static");
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  if (entries.length > 4096) throw new Error("browser_assets_too_large");
  let remaining = 64 * 1024 * 1024;
  const types = {
    ".js": "application/javascript",
    ".css": "text/css",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ttf": "font/ttf",
    ".svg": "image/svg+xml",
    ".png": "image/png",
  };
  const files = [["/", join(directory, "index.html"), "text/html"]];
  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    if (!entry.isFile()) throw new Error("invalid_browser_asset");
    const path = join(entry.parentPath, entry.name);
    files.push([
      `/_next/static/${relative(root, path)}`,
      path,
      types[extname(path)] ?? "application/octet-stream",
    ]);
  }
  for (const [url, path, type] of files) {
    remaining -= (await stat(path)).size;
    if (remaining < 0) throw new Error("browser_assets_too_large");
    assets.set(url, { type, bytes: await readFile(path) });
  }
}

/** Create only; callers explicitly choose when/where to listen. No Docker or credential discovery. */
export async function createAgentGateway({
  gatewayOrigin,
  datahubOrigin,
  verifyIdentity,
  runtimeForActor,
  ingestionRequest,
  taskRequest,
  discoveryRequest,
  semanticRequest,
  mfeDirectory,
  publicDirectory = fileURLToPath(
    new URL("../pi-web/public/", import.meta.url),
  ),
  browserAssetsDirectory,
  grants = new BrowserGrants(),
  // Match pi-web's 100 MiB multipart total plus its 1 MiB envelope allowance.
  maxRequestBytes = 101 * 1024 * 1024,
}) {
  const gateway = originUrl(gatewayOrigin);
  const datahub = originUrl(datahubOrigin);
  if (
    typeof verifyIdentity !== "function" ||
    typeof runtimeForActor !== "function" ||
    !Number.isSafeInteger(maxRequestBytes) ||
    maxRequestBytes <= 0
  )
    throw new Error("invalid_gateway_configuration");
  const operations = new Map([
    ["/agent/ingestion", { handler: ingestionRequest, name: "ingestion" }],
    ["/agent/tasks", { handler: taskRequest, name: "tasks" }],
    ["/agent/discovery", { handler: discoveryRequest, name: "discovery" }],
    ["/agent/semantic", { handler: semanticRequest, name: "semantic" }],
  ]);
  const staticFiles = new Map();
  for (const name of await readdir(mfeDirectory)) {
    if (name === "remoteEntry.js" || /^\d+\.js$/.test(name))
      staticFiles.set(`/mfe/${name}`, await readFile(join(mfeDirectory, name)));
  }
  if (!staticFiles.has("/mfe/remoteEntry.js"))
    throw new Error("mfe_build_required");
  // Browser SW installation may omit the partitioned session cookie. Serve ONLY
  // these deployment-owned immutable assets, never anonymous requests to a runtime.
  const pwaFiles = new Map([
    [
      "/manifest.webmanifest",
      {
        type: "application/manifest+json",
        bytes: Buffer.from(JSON.stringify(manifest())),
      },
    ],
  ]);
  for (const [name, type] of [
    ["sw.js", "application/javascript"],
    ["offline.html", "text/html"],
    ["icons/icon-192.png", "image/png"],
    ["icons/icon-512.png", "image/png"],
    ["icons/apple-touch-icon.png", "image/png"],
  ])
    pwaFiles.set(`/${name}`, {
      type,
      bytes: await readFile(join(publicDirectory, name)),
    });
  // SW network requests can lose a partitioned cookie even when the page has it.
  // Only a build-time static shell/assets may bypass that cookie, never runtime
  // SSR or API responses. Authenticated navigations retain the upstream behavior.
  await addBrowserAssets(browserAssetsDirectory, pwaFiles);
  const server = createServer(async (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader(
      "content-security-policy",
      `frame-ancestors ${datahub.origin}; object-src 'none'; base-uri 'self'`,
    );
    try {
      if (
        request.headersDistinct.host?.length !== 1 ||
        !request.url?.startsWith("/") ||
        request.url.startsWith("//")
      ) {
        throw new HttpError(400, "invalid_request");
      }
      const host = request.headers.host;
      const suffix = `.${gateway.host}`;
      const key = host.endsWith(suffix) ? host.slice(0, -suffix.length) : "";
      const rootHost = host === gateway.host;
      if (!rootHost && !/^[a-f0-9]{48}$/.test(key))
        throw new HttpError(403, "untrusted_host");
      const ownOrigin = `${gateway.protocol}//${host}`;
      const publicAsset = pwaFiles.get(request.url.split("?", 1)[0]);
      const pathname = request.url.split("?", 1)[0];
      const staticShell =
        pathname === "/" &&
        !request.headers.rsc &&
        !request.headers.cookie?.includes(`${COOKIE}=`);
      if (
        !rootHost &&
        ["GET", "HEAD"].includes(request.method) &&
        publicAsset &&
        (pathname !== "/" || staticShell)
      ) {
        response.setHeader("service-worker-allowed", "/");
        response.writeHead(200, {
          "content-type": publicAsset.type,
          "content-length": publicAsset.bytes.length,
        });
        response.end(request.method === "HEAD" ? undefined : publicAsset.bytes);
        return;
      }
      if (rootHost) {
        if (request.method === "GET" && staticFiles.has(request.url)) {
          response.writeHead(200, { "content-type": "application/javascript" });
          response.end(staticFiles.get(request.url));
          return;
        }
        exactOrigin(request, datahub.origin);
        response.setHeader("access-control-allow-origin", datahub.origin);
        response.setHeader("access-control-allow-credentials", "true");
        response.setHeader("vary", "Origin");
        if (
          request.method === "OPTIONS" &&
          [
            "/agent/bootstrap",
            "/agent/heartbeat",
            "/agent/revoke",
            ...operations.keys(),
          ].includes(request.url)
        ) {
          response.writeHead(204, {
            "access-control-allow-methods": "POST",
            "access-control-allow-headers": "content-type",
          });
          response.end();
          return;
        }
        if (request.method !== "POST")
          throw new HttpError(405, "method_not_allowed");
        if (
          ![
            "/agent/bootstrap",
            "/agent/heartbeat",
            "/agent/revoke",
            ...operations.keys(),
          ].includes(request.url)
        )
          throw new HttpError(404, "not_found");
        const input = await body(
          request,
          request.url === "/agent/bootstrap"
            ? []
            : operations.has(request.url)
              ? ["grantId", "revokeToken", "request"]
              : ["grantId", "revokeToken"],
          request.url === "/agent/semantic"
            ? 49152 // JSON-escaped 24KB intent plus parent-only proof envelope.
            : ["/agent/tasks", "/agent/discovery"].includes(request.url)
              ? 16384
              : 4096,
        );
        if (request.url === "/agent/bootstrap") {
          const actor = await verifyIdentity(request.headers.cookie);
          const {
            grantId,
            ticket,
            key: actorKey,
            revokeToken,
          } = grants.issue(actor);
          json(response, 200, {
            grantId,
            revokeToken,
            launchUrl: `${gateway.protocol}//${actorKey}.${gateway.host}/bootstrap#${ticket}`,
          });
        } else if (operations.has(request.url)) {
          const { handler, name } = operations.get(request.url);
          if (!handler) throw new HttpError(403, `${name}_not_configured`);
          const actor = await verifyIdentity(request.headers.cookie);
          const assertActive = () => {
            if (response.destroyed)
              throw new HttpError(409, "ingestion_request_closed");
            grants.renew(input.grantId, actor, input.revokeToken);
          };
          assertActive();
          const result = await handler(input.request, {
            actor,
            cookieHeader: request.headers.cookie,
            assertActive,
            ...(request.url === "/agent/tasks"
              ? { runtime: await runtimeForActor(actor) }
              : request.url === "/agent/semantic"
                ? { getRuntime: () => runtimeForActor(actor) }
                : {}),
          });
          assertActive();
          json(response, 200, result);
        } else {
          if (request.url === "/agent/heartbeat") {
            try {
              const actor = await verifyIdentity(request.headers.cookie);
              grants.renew(input.grantId, actor, input.revokeToken);
            } catch (error) {
              // A proven parent detecting lost/changed identity revokes its entire
              // browser session. A guessed grant ID cannot cancel another user.
              grants.release(input.grantId, input.revokeToken, true);
              throw error;
            }
          } else grants.release(input.grantId, input.revokeToken);
          json(response, 200, { ok: true });
        }
        return;
      }
      if (request.method === "GET" && pathname === "/bootstrap") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(
          '<!doctype html><meta charset="utf-8"><title>DataHub Agent</title><p role="status">Opening your isolated workspace…</p><script src="/agent-bootstrap.js"></script>',
        );
        return;
      }
      if (request.method === "GET" && request.url === "/agent-bootstrap.js") {
        response.writeHead(200, { "content-type": "application/javascript" });
        response.end(BOOTSTRAP_SCRIPT);
        return;
      }
      if (request.url === "/agent/exchange" && request.method === "POST") {
        exactOrigin(request, ownOrigin);
        const { ticket } = await body(request, ["ticket"]);
        const result = grants.exchange(
          ticket,
          key,
          cookieValue(request.headers.cookie, true),
        );
        await runtimeForActor(result.actor);
        grants.authorize(result.session, key, result.grantId);
        response.setHeader(
          "set-cookie",
          `${COOKIE}=${result.session}; HttpOnly; SameSite=None; Secure; Partitioned; Path=/`,
        );
        json(response, 200, { ok: true });
        return;
      }
      // Runtime origin grants never authorize control-plane /agent/* operations.
      if (request.url.startsWith("/agent/"))
        throw new HttpError(403, "control_plane_forbidden");
      if (
        !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(
          request.method,
        )
      )
        throw new HttpError(405, "method_not_allowed");
      if (request.headers.origin || !["GET", "HEAD"].includes(request.method))
        exactOrigin(request, ownOrigin);
      if (request.headers["sec-fetch-site"] === "cross-site")
        throw new HttpError(403, "untrusted_origin");
      const session = cookieValue(request.headers.cookie);
      const { actor } = grants.authorize(session, key);
      const runtime = await runtimeForActor(actor);
      // Provisioning may take time: recheck the grant before forwarding any bytes.
      grants.authorize(session, key);
      await proxy(
        request,
        response,
        runtime,
        grants,
        session,
        key,
        maxRequestBytes,
      );
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "";
      const knownError =
        error instanceof HttpError ||
        error instanceof IngestionError ||
        error instanceof DiscoveryError ||
        error instanceof SemanticError ||
        error instanceof TaskRecordError;
      const status = knownError
        ? error.status
        : code === "authentication_required"
          ? 401
          : code.endsWith("capacity_exhausted")
            ? 429
            : 503;
      json(response, status, {
        error: knownError
          ? error.message
          : status === 401
            ? "authentication_required"
            : status === 429
              ? "capacity_exhausted"
              : "service_unavailable",
        ...(error instanceof TaskRecordError && error.reconciliation
          ? { reconciliation: error.reconciliation }
          : {}),
      });
    }
  });
  server.once("listening", () => {
    if (gateway.port === "0") gateway.port = String(server.address().port);
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  const sweeper = setInterval(() => grants.sweep(), 1000);
  sweeper.unref();
  server.on("close", () => clearInterval(sweeper));
  return server;
}

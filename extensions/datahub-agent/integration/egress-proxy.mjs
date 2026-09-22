import { createServer, request as httpRequest } from "node:http";
import { BlockList, connect, isIP } from "node:net";
import { Resolver } from "node:dns/promises";
import { networkInterfaces } from "node:os";
import { chmod } from "node:fs/promises";
import { bridgeSockets } from "./runtime-relay.mjs";

// Conservative IPv4-only policy. IPv6 and special-use ranges fail closed.
const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
])
  blocked.addSubnet(address, prefix, "ipv4");

export function isPublicIPv4(address) {
  return (
    isIP(address) === 4 &&
    !blocked.check(address, "ipv4") &&
    !Object.values(networkInterfaces())
      .flat()
      .some((entry) => entry?.address === address)
  );
}

// One operator-owned local service, not a general private-network allowlist.
const localMcpAuthority = "datahub-mcp:8042";

function destinations(values) {
  if (!Array.isArray(values) || values.length > 64)
    throw new Error("invalid_egress_policy");
  const result = new Set();
  for (const value of values) {
    try {
      if (value === `http://${localMcpAuthority}`) {
        result.add(localMcpAuthority);
        continue;
      }
      if (typeof value !== "string") throw new Error();
      const url = new URL(value);
      if (
        url.hostname.includes(":") ||
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash ||
        (url.port && url.port !== "443") ||
        (isIP(url.hostname) && !isPublicIPv4(url.hostname))
      )
        throw new Error();
      result.add(`${url.hostname}:443`);
    } catch {
      throw new Error("invalid_egress_policy");
    }
  }
  return result;
}

export { destinations as validateEgressOrigins };

/** Host-only CONNECT egress: public HTTPS or the explicitly allowed local MCP.
 * Scoped by a per-user read-only Unix socket.
 * No TLS interception: this enforces network destinations, not HTTP path policy.
 * Model/MCP approvals must remain in the separate trusted control plane. */
export async function createEgressProxy(
  socketPath,
  { allowedOrigins = [], capacity = 32, idleMs = 300000 } = {},
) {
  if (
    Buffer.byteLength(socketPath) > 100 ||
    ![capacity, idleMs].every((n) => Number.isSafeInteger(n) && n > 0)
  ) {
    throw new Error("invalid_egress_configuration");
  }
  let allowed = destinations(allowedOrigins);
  const clients = new Set();
  const tunnels = new Map();
  let closed = false;
  const server = createServer((request, response) => {
    // Native HTTP clients use absolute-form proxy requests rather than CONNECT.
    // Only the same fixed, per-actor MCP destination is permitted in this form.
    let url;
    try {
      url = new URL(request.url);
    } catch {
      /* Reject non-absolute requests. */
    }
    if (
      closed ||
      !clients.has(request.socket) ||
      tunnels.size >= capacity ||
      !allowed.has(localMcpAuthority) ||
      !request.url.startsWith(`http://${localMcpAuthority}/`) ||
      url?.origin !== `http://${localMcpAuthority}` ||
      url.username ||
      url.password ||
      url.hash ||
      request.headers.host !== localMcpAuthority
    ) {
      response.writeHead(405, { connection: "close", "content-length": "0" });
      response.end();
      return;
    }
    const headers = { ...request.headers, host: localMcpAuthority };
    for (const name of [
      "proxy-authorization",
      "proxy-connection",
      "connection",
      "keep-alive",
      "upgrade",
    ])
      delete headers[name];
    const upstream = httpRequest(
      {
        hostname: "127.0.0.1",
        port: 8042,
        path: url.pathname + url.search,
        method: request.method,
        headers,
        agent: false,
      },
      (incoming) => {
        response.writeHead(incoming.statusCode, incoming.headers);
        incoming.on("error", () => response.destroy());
        incoming.pipe(response);
      },
    );
    tunnels.set(request, { upstream, authority: localMcpAuthority });
    response.once("close", () => {
      tunnels.delete(request);
      upstream.destroy();
    });
    request.once("aborted", () => upstream.destroy());
    upstream.on("error", () => {
      if (response.headersSent) response.destroy();
      else {
        response.writeHead(502, { connection: "close", "content-length": "0" });
        response.end();
      }
    });
    upstream.setTimeout(idleMs, () => upstream.destroy());
    request.pipe(upstream);
  });
  server.maxHeadersCount = 20;
  server.headersTimeout = 10000;
  server.requestTimeout = 10000;
  server.on("connection", (client) => {
    if (closed || clients.size >= capacity || tunnels.size >= capacity) {
      client.destroy();
      return;
    }
    clients.add(client);
    client.on("error", () => client.destroy());
    client.on("close", () => clients.delete(client));
    client.setTimeout(idleMs, () => client.destroy());
  });
  server.on("connect", async (request, client, head) => {
    const authority = request.url;
    // Require canonical CONNECT authority; no credentials, paths, ports or aliases.
    if (closed || !clients.has(client) || !allowed.has(authority)) {
      client.end(
        "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
      );
      return;
    }
    const localMcp = authority === localMcpAuthority;
    const hostname = authority.split(":")[0];
    const resolver = new Resolver({ timeout: 2000, tries: 1 });
    const tunnel = { upstream: null, authority };
    let linked = false;
    tunnels.set(client, tunnel);
    const stop = () => {
      resolver.cancel();
      if (!linked) {
        tunnel.upstream?.destroy();
        tunnels.delete(client);
      }
    };
    client.once("close", stop);
    try {
      const addresses = localMcp
        ? ["127.0.0.1"]
        : isIP(hostname)
          ? [hostname]
          : await resolver.resolve4(hostname);
      if (closed || client.destroyed || !allowed.has(authority)) {
        client.destroy();
        return;
      }
      if (!addresses.length || (!localMcp && !addresses.every(isPublicIPv4)))
        throw new Error();
      // Dial a checked numeric IP: no second DNS lookup / rebinding window.
      const upstream = connect({
        host: addresses[0],
        port: localMcp ? 8042 : 443,
      });
      tunnel.upstream = upstream;
      const connecting = setTimeout(() => upstream.destroy(), 5000);
      upstream.once("connect", () => {
        clearTimeout(connecting);
        if (client.destroyed || !allowed.has(authority)) {
          upstream.destroy();
          return;
        }
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        linked = true;
        bridgeSockets(client, upstream, () => tunnels.delete(client));
      });
      upstream.on("error", () => client.destroy());
      upstream.on("close", () => {
        clearTimeout(connecting);
        if (!linked) client.destroy();
      });
      upstream.setTimeout(idleMs, () => upstream.destroy());
    } catch {
      if (!client.destroyed)
        client.end(
          "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  try {
    await chmod(socketPath, 0o600);
  } catch (error) {
    await new Promise((resolve) => server.close(resolve));
    throw error;
  }
  return {
    setAllowedOrigins(origins) {
      const next = destinations(origins);
      allowed = next;
      for (const [client, tunnel] of tunnels)
        if (!next.has(tunnel.authority)) {
          client.destroy();
          tunnel.upstream?.destroy();
        }
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const client of clients) client.destroy();
      for (const tunnel of tunnels.values()) tunnel.upstream?.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

import assert from "node:assert/strict";
import { request } from "node:http";

// Node fetch ignores an overridden Host header. These isolated HTTP tests need
// the real actor-origin exchange, without relying on wildcard localhost DNS.
export function exchangeFixtureTicket(base, launchUrl) {
  const endpoint = new URL(base),
    launch = new URL(launchUrl);
  assert.equal(endpoint.hostname, "localhost");
  assert.match(launch.hostname, /^[a-f0-9]{48}\.localhost$/);
  assert.equal(launch.port, endpoint.port);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: endpoint.port,
        path: "/agent/exchange",
        method: "POST",
        headers: {
          host: launch.host,
          origin: launch.origin,
          "content-type": "application/json",
        },
        signal: AbortSignal.timeout(10000),
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => {
          try {
            resolve({
              status: response.statusCode,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
            });
          } catch {
            reject(Error("fixture_exchange_invalid_response"));
          }
        });
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify({ ticket: launch.hash.slice(1) }));
  });
}

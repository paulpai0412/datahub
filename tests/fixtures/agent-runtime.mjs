// TEST IMAGE ONLY: not pi-web, a model, DataHub identity, or an ingestion worker.
import { createServer } from "node:http";
import { connect } from "node:net";
import { access, readFile, symlink, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import {
  startRuntimeRelay,
  startLocalEgressRelay,
} from "../../extensions/datahub-agent/integration/runtime-relay.mjs";
import { isValidWebSessionToken } from "../../extensions/datahub-agent/pi-web/lib/web-auth.ts";

async function denied(operation, codes) {
  try {
    await operation();
    return false;
  } catch (error) {
    return codes.includes(error.code);
  }
}
function tcpDenied(host, port) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    socket.setTimeout(1500);
    socket.once("connect", () => {
      socket.destroy();
      resolve("connected");
    });
    socket.once("error", (error) => {
      socket.destroy();
      resolve(error.code);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve("inconclusive_timeout");
    });
  });
}
const server = createServer(async (request, response) => {
  const token = request.headers.cookie?.replace(/^pi_web_session=/, "");
  if (!isValidWebSessionToken(token, process.env.PI_WEB_PASSWORD)) {
    response.writeHead(401);
    response.end();
    return;
  }
  let data;
  if (request.url === "/api/web-auth")
    data = { authenticated: true, fixture: true };
  else if (request.url === "/write-alice" || request.url === "/write-bob") {
    await writeFile("/home/node/marker", request.url.slice(7));
    data = { written: true };
  } else if (request.url === "/marker") {
    data = {
      marker: await readFile("/home/node/marker", "utf8").catch(() => null),
    };
  } else if (request.url === "/probe") {
    data = {
      uid: process.getuid(),
      interfaces: Object.keys(networkInterfaces()),
      hostSocketAbsent: await denied(
        () => access("/var/run/docker.sock"),
        ["ENOENT"],
      ),
      rootWriteDenied: await denied(
        () => writeFile("/operator-write-probe", "test"),
        ["EROFS", "EACCES"],
      ),
      socketReplacementDenied: await denied(
        () => symlink("/var/run/docker.sock", "/run/datahub-agent/escape.sock"),
        ["EROFS"],
      ),
      directPublicTcpDenied: await tcpDenied("1.1.1.1", 443),
      directMetadataTcpDenied: await tcpDenied("169.254.169.254", 80),
      developerCredentialsAbsent: [
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "DATAHUB_TOKEN",
        "DATAHUB_GMS_TOKEN",
        "MSSQL_PASSWORD",
      ].every((key) => !(key in process.env)),
    };
  } else if (request.url === "/public-egress") {
    try {
      const result = await fetch("https://registry.npmjs.org/", {
        method: "HEAD",
        signal: AbortSignal.timeout(10000),
      });
      data = { status: result.status };
    } catch (error) {
      data = { blocked: true, code: error.cause?.code ?? error.name };
    }
  } else if (request.url === "/stream") {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: fixture-ready\n\n");
    const timer = setInterval(
      () => response.write("data: fixture-alive\n\n"),
      100,
    );
    response.on("close", () => clearInterval(timer));
    return;
  } else {
    response.writeHead(404);
    response.end();
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(data));
});
server.listen(30141, "127.0.0.1");
const stopProxy = await startLocalEgressRelay("/run/datahub-agent/egress.sock");
const stopRelay = startRuntimeRelay({
  socketPath: "/run/datahub-agent/runtime.sock",
  capacity: 8,
});
process.on("SIGTERM", async () => {
  stopRelay();
  await stopProxy();
  server.closeAllConnections();
  server.close();
});

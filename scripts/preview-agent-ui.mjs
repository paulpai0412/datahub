import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// A review artifact, not the Agent gateway. Never serve the repository root.
export async function createAgentUiPreview() {
  const root = new URL("../extensions/datahub-agent/design/", import.meta.url);
  const files = new Map();
  for (const [name, type] of [
    ["index.html", "text/html; charset=utf-8"],
    ["agent-ui.css", "text/css; charset=utf-8"],
    ["agent-ui.mjs", "text/javascript; charset=utf-8"],
    ["assets/datahub-core.svg", "image/svg+xml"],
    ["assets/Mulish-Regular.ttf", "font/ttf"],
    ["assets/Mulish-SemiBold.ttf", "font/ttf"],
  ])
    files.set(`/${name}`, { body: await readFile(new URL(name, root)), type });
  files.set("/", files.get("/index.html"));
  return createServer((request, response) => {
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "no-store");
    const file = files.get(request.url);
    if (!["GET", "HEAD"].includes(request.method) || !file) {
      response.writeHead(404).end("Not found");
      return;
    }
    response.writeHead(200, {
      "Content-Type": file.type,
      "Content-Length": file.body.length,
    });
    response.end(request.method === "HEAD" ? undefined : file.body);
  });
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const port = process.argv[2] ?? "9141";
  if (!/^\d{1,5}$/.test(port) || Number(port) > 65535)
    throw new Error("invalid_preview_port");
  const server = await createAgentUiPreview();
  server.listen(Number(port), "127.0.0.1", () => {
    console.log(
      `UI v0 preview only: http://127.0.0.1:${server.address().port}`,
    );
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      server.closeAllConnections();
      server.close();
    });
}

// Explicit live check; never creates credentials or writes DataHub metadata.
// DATAHUB_MCP_READ_TOKEN_FILE=<operator-provided 0600 file> node tests/check_agent_datahub_mcp.mjs --live
import assert from "node:assert/strict";
import { readFile, lstat } from "node:fs/promises";
import { Client } from "../extensions/datahub-agent/pi-web/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StreamableHTTPClientTransport } from "../extensions/datahub-agent/pi-web/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js";

assert(process.argv.includes("--live"), "explicit --live required");
const path = process.env.DATAHUB_MCP_READ_TOKEN_FILE;
assert(path, "explicit read-only token file required; no credential discovery");
const info = await lstat(path);
assert(
  info.isFile() && !(info.mode & 0o077) && info.size < 16384,
  "private regular token file required",
);
const token = (await readFile(path, "utf8")).trim();
assert(token && !/[\r\n]/.test(token), "invalid token file");
const client = new Client({ name: "datahub-agent-live-check", version: "1" });
const urn =
  "urn:li:dataset:(urn:li:dataPlatform:mssql,adventureworks2019.person.person,PROD)";
function jsonResult(result) {
  assert(!result.isError, "MCP tool returned an error");
  return JSON.parse(
    result.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n"),
  );
}
try {
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8042/mcp"), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  const { tools } = await client.listTools();
  assert.equal(tools.length, 7);
  assert(tools.every((tool) => tool.annotations?.readOnlyHint === true));
  const entities = jsonResult(
    await client.callTool({ name: "get_entities", arguments: { urns: [urn] } }),
  );
  assert.equal(entities[0].urn, urn);
  const fields = entities[0].schemaMetadata.fields;
  assert.equal(fields.length, 13);
  for (const [name, type] of [
    ["businessentityid", "INTEGER"],
    ["additionalcontactinfo", "XML"],
    ["demographics", "XML"],
  ])
    assert(
      fields.some(
        (field) => field.fieldPath === name && field.nativeDataType === type,
      ),
    );
  const lineage = jsonResult(
    await client.callTool({
      name: "get_lineage",
      arguments: {
        urn,
        column: null,
        query: "*",
        filter: null,
        upstream: false,
        max_hops: 1,
        max_results: 3,
        offset: 0,
      },
    }),
  );
  assert.equal(lineage.downstreams.searchResults.length, 3);
  assert(lineage.downstreams.total >= 3); // A limited page is not complete lineage coverage.
  console.log(
    "PASS: real MCP discovery, 13 schema fields, downstream lineage page (not browser acceptance).",
  );
} catch {
  console.error("DataHub MCP live check failed; token values are not logged.");
  process.exitCode = 1;
} finally {
  await client.close();
}

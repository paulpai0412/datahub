// A real MCP SDK stdio server for adapter compatibility checks; not DataHub.
import { McpServer } from "../../extensions/datahub-agent/pi-web/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js";
import { StdioServerTransport } from "../../extensions/datahub-agent/pi-web/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js";
import { z } from "../../extensions/datahub-agent/pi-web/node_modules/zod/index.js";
const server = new McpServer({
  name: "agent-mcp-echo-fixture",
  version: "1.0.0",
});
server.registerTool(
  "echo",
  {
    description: "Return the synthetic test value.",
    inputSchema: { value: z.string() },
  },
  async ({ value }) => ({ content: [{ type: "text", text: value }] }),
);
await server.connect(new StdioServerTransport());

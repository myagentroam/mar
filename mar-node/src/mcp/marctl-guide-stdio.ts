import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { marctlDescription, marctlInstructions } from '../marctl-guidance.js';
import { NODE_MCP, NODE_MCP_VERSION } from './naming.js';

const description =
  marctlDescription +
  ' This tool only returns guidance; use your native shell tool to run marctl. Reuse loaded guidance while it remains in context.';
const server = new McpServer(
  { name: NODE_MCP.cli.name, version: NODE_MCP_VERSION },
  { instructions: description }
);
server.registerTool(
  NODE_MCP.cli.tools.load,
  {
    description,
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async () => ({ content: [{ type: 'text', text: marctlInstructions }] })
);
await server.connect(new StdioServerTransport());

import { NODE_MCP, NODE_MCP_VERSION } from '../mcp/naming.js';
import { connect } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const endpoint = process.env['MAR_GOAL_MCP_ENDPOINT'];
const token = process.env['MAR_GOAL_MCP_TOKEN'];
if (endpoint === undefined || token === undefined) throw new Error('GOAL_CAPABILITY_INVALID');

const server = new McpServer({ name: NODE_MCP.goal.name, version: NODE_MCP_VERSION });
server.registerTool(
  NODE_MCP.goal.tools.get,
  { description: 'Get the authoritative current Goal, status, and objective.' },
  async () => result(await request(NODE_MCP.goal.tools.get, {}))
);
server.registerTool(
  NODE_MCP.goal.tools.update,
  {
    description: 'Explicitly mark the current Goal completed or blocked.',
    inputSchema: { status: z.enum(['completed', 'blocked']) }
  },
  async ({ status }) => result(await request(NODE_MCP.goal.tools.update, { status }))
);

await server.connect(new StdioServerTransport());

function request(tool: string, args: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint!);
    let body = '';
    socket.setEncoding('utf8');
    socket.once('connect', () =>
      socket.end(`${JSON.stringify({ token, tool, arguments: args })}\n`)
    );
    socket.on('data', (chunk) => (body += chunk));
    socket.once('error', reject);
    socket.once('end', () => {
      try {
        const payload = JSON.parse(body) as { readonly result?: unknown; readonly error?: string };
        if (payload.error !== undefined) reject(new Error(payload.error));
        else resolve(payload.result);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function result(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

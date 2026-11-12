import { NODE_MCP, NODE_MCP_VERSION } from '../mcp/naming.js';
import { connect } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const endpoint = process.env['MAR_SCHEDULE_MCP_ENDPOINT'];
let token = process.env['MAR_SCHEDULE_MCP_TOKEN'];
if (endpoint === undefined || token === undefined) throw new Error('SCHEDULE_CAPABILITY_INVALID');
// This client owns one rotating credential; consume renewals before dispatching later calls.
let previousRequest: Promise<unknown> = Promise.resolve();

const server = new McpServer({ name: NODE_MCP.schedule.name, version: NODE_MCP_VERSION });
const scopeNote =
  'Scope is limited to the MAR scheduled task managed by Node for this conversation; ' +
  'it does not cover repository, CI, system cron, or other timers.';
const objectiveDescription =
  'Task body for one scheduled run in this conversation. State what that run should do with enough task context. ' +
  'Do not phrase it as a request to create or change a schedule or repeat cron/time-zone settings; MAR handles scheduling and skipped triggers.';
server.registerTool(
  NODE_MCP.schedule.tools.get,
  {
    description:
      'Read the MAR scheduled task bound to this MAR-managed Workspace conversation, or null if none exists. ' +
      scopeNote
  },
  async (extra) => result(await request(NODE_MCP.schedule.tools.get, {}, extra.signal))
);
server.registerTool(
  NODE_MCP.schedule.tools.create,
  {
    description:
      'Create the MAR scheduled task for this MAR-managed Workspace conversation. MAR runs it in this conversation for each admitted trigger using the connected Node time zone. ' +
      scopeNote,
    inputSchema: {
      objective: z.string().min(1).max(20_000).describe(objectiveDescription),
      cron: z
        .string()
        .min(9)
        .max(64)
        .describe(
          'Five-field cron expression interpreted in the connected MAR Node time zone. It defines the schedule separately from the per-run task body.'
        )
    }
  },
  async (args, extra) => result(await request(NODE_MCP.schedule.tools.create, args, extra.signal))
);
server.registerTool(
  NODE_MCP.schedule.tools.update,
  {
    description:
      'Update the MAR scheduled task for this MAR-managed Workspace conversation. MAR runs the saved objective in this conversation for each admitted trigger using the connected Node time zone. ' +
      scopeNote,
    inputSchema: {
      objective: z.string().min(1).max(20_000).describe(objectiveDescription).optional(),
      cron: z
        .string()
        .min(9)
        .max(64)
        .describe('Replacement five-field cron expression in the connected MAR Node time zone.')
        .optional()
    }
  },
  async (args, extra) => result(await request(NODE_MCP.schedule.tools.update, args, extra.signal))
);

await server.connect(new StdioServerTransport());

function request(tool: string, args: unknown, signal: AbortSignal): Promise<unknown> {
  const operation = previousRequest.then(() => exchange(tool, args, signal));
  previousRequest = operation.catch(() => undefined);
  return operation;
}

function exchange(tool: string, args: unknown, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted)
    return Promise.reject(
      new Error('SCHEDULE_CALL_CANCELLED: The schedule call was cancelled before dispatch.')
    );
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint!);
    const abort = () =>
      socket.destroy(
        new Error(
          'SCHEDULE_DELIVERY_UNCERTAIN: The schedule call was cancelled after dispatch; its result is uncertain.'
        )
      );
    signal.addEventListener('abort', abort, { once: true });
    socket.once('close', () => signal.removeEventListener('abort', abort));
    let body = '';
    socket.setEncoding('utf8');
    socket.once('connect', () =>
      socket.write(`${JSON.stringify({ token, tool, arguments: args })}\n`)
    );
    socket.on('data', (chunk) => (body += chunk));
    socket.once('error', reject);
    socket.once('end', () => {
      try {
        const payload = JSON.parse(body) as {
          readonly result?: unknown;
          readonly error?: string;
          readonly token?: string;
        };
        if (payload.error !== undefined) reject(new Error(payload.error));
        else {
          // Credential renewal stays inside IPC; model-visible results never contain tokens.
          if (typeof payload.token === 'string') token = payload.token;
          resolve(payload.result);
        }
      } catch {
        // JSON diagnostics may include a partially received private renewal credential.
        reject(
          new Error(
            'SCHEDULE_IPC_RESPONSE_INVALID: The schedule service returned an invalid response.'
          )
        );
      }
    });
  });
}

function result(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

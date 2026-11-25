import { NODE_MCP, NODE_MCP_VERSION } from '../mcp/naming.js';
import { connect } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { ZodTypeAny } from 'zod/v3';
import { scheduleToolInputs } from '@myagentroam/protocol';
import { scheduleIpcFrameLimit } from './schedule-mcp-contract.js';

const endpoint = process.env['MAR_SCHEDULE_MCP_ENDPOINT'];
const token = process.env['MAR_SCHEDULE_MCP_TOKEN'];
if (endpoint === undefined || token === undefined) throw new Error('SCHEDULE_CAPABILITY_INVALID');
// Serialize requests from this client so later reads can observe earlier writes.
let previousRequest: Promise<unknown> = Promise.resolve();
const server = new McpServer({ name: NODE_MCP.schedule.name, version: NODE_MCP_VERSION });
const scope =
  'In this MAR-managed Workspace conversation, this tool only manages its MAR scheduled tasks, not system cron, CI, or other projects. ';
const descriptions: Record<keyof typeof scheduleToolInputs, string> = {
  list: 'List MAR tasks scheduled for this conversation. Each task has its own instructions and time combinations.',
  get: 'Read one scheduled task in this conversation, including its instructions and time combinations.',
  create:
    'Create a new task in the Node time zone. Write the task objective as the instructions for one admitted trigger, not as a request to set up a schedule. If the outcome is uncertain, list tasks before trying again.',
  update:
    'Change the selected task using the revision from get or list. Write the objective as instructions for one admitted trigger. On a revision conflict, read the task again before editing.',
  runs: 'List execution records for this task in this conversation, newest first.'
};
for (const key of Object.keys(scheduleToolInputs) as (keyof typeof scheduleToolInputs)[]) {
  const tool = NODE_MCP.schedule.tools[key];
  const inputSchema = scheduleToolInputs[key] as unknown as ZodTypeAny;
  server.registerTool<ZodTypeAny, ZodTypeAny>(
    tool,
    { description: scope + descriptions[key], inputSchema },
    async (args, extra) => result(await request(tool, args, extra.signal))
  );
}

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
  const frame = `${JSON.stringify({ token, tool, arguments: args })}\n`;
  if (frame.length > scheduleIpcFrameLimit)
    return Promise.reject(new Error('SCHEDULE_INPUT_TOO_LARGE: The call was not sent.'));
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
    socket.once('connect', () => socket.write(frame));
    socket.on('data', (chunk) => (body += chunk));
    socket.once('error', reject);
    socket.once('end', () => {
      try {
        const payload = JSON.parse(body) as {
          readonly result?: unknown;
          readonly error?: string;
        };
        if (typeof payload?.error === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/u.test(payload.error))
          reject(new Error(payload.error));
        else if (
          payload !== null &&
          typeof payload === 'object' &&
          Object.hasOwn(payload, 'result')
        )
          resolve(payload.result);
        else throw new Error();
      } catch {
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

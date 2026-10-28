import { createRequire } from 'node:module';
import type { ResolvedMcpServer } from './model.js';

export const NODE_MCP = {
  cli: { name: 'mar_cli', tools: { load: 'load_guide' } },
  goal: { name: 'mar_goal', tools: { get: 'get_goal', update: 'update_goal' } },
  schedule: {
    name: 'mar_schedule',
    tools: {
      get: 'get_scheduled_task',
      create: 'create_scheduled_task',
      update: 'update_scheduled_task'
    }
  },
  notification: {
    name: 'mar_notification',
    tools: { send: 'send_notification', email: 'send_email_notification' }
  },
  computer: { name: 'mar_computer', tools: { exec: 'exec', wait: 'wait' } },
  channel: { name: 'mar_channel', tools: { reply: 'reply' } }
} as const;

const { version } = createRequire(import.meta.url)('../../package.json') as { version: string };
export const NODE_MCP_VERSION = version;
export const NODE_MCP_CLIENT_INFO = { name: 'mar-node', version };
export const NODE_COMPUTER_TOOL_NAME = [
  'mcp',
  NODE_MCP.computer.name,
  NODE_MCP.computer.tools.exec
].join('__');
export const NODE_COMPUTER_WAIT_TOOL_NAME = [
  'mcp',
  NODE_MCP.computer.name,
  NODE_MCP.computer.tools.wait
].join('__');
const reservedNames = new Set<string>(Object.values(NODE_MCP).map(({ name }) => name));

export function mcpNameAlias(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/gu, '_').slice(0, 64);
}

/** Validate the final effective set, including trusted execution-only servers. */
export function assertMcpServerNames(
  servers: readonly Pick<ResolvedMcpServer, 'name' | 'origin'>[]
): void {
  const seen = new Set<string>();
  for (const server of servers) {
    const alias = mcpNameAlias(server.name);
    if (server.origin !== 'BUILTIN' && reservedNames.has(alias))
      throw Object.assign(
        new Error('MCP_RESERVED_NAMESPACE: The MCP server name is reserved for Node.'),
        { code: 'MCP_RESERVED_NAMESPACE' }
      );
    if (seen.has(alias))
      throw Object.assign(
        new Error('MCP_SERVER_NAME_CONFLICT: Multiple MCP servers have the same exposed name.'),
        { code: 'MCP_SERVER_NAME_CONFLICT' }
      );
    seen.add(alias);
  }
}

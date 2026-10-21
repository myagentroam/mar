import { describe, expect, it } from 'vitest';
import { resolveMcpServers } from '../../src/mcp/configuration.js';
import { NODE_MCP, assertMcpServerNames } from '../../src/mcp/naming.js';
import type { ResolvedMcpServer } from '../../src/mcp/model.js';

const installation = (serverName: string) => ({
  serverName,
  enabled: true,
  runtime: { transport: 'STDIO', command: 'node', args: [], environment: {} },
  configuration: {}
});

describe('Node MCP configuration boundaries', () => {
  it('keeps user names and does not reserve the entire product prefix', () => {
    expect(resolveMcpServers([installation('mar_external')], {})[0]).toMatchObject({
      name: 'mar_external',
      origin: 'USER',
      transport: 'STDIO'
    });
  });

  it.each(Object.values(NODE_MCP))('rejects a user installation claiming $name', ({ name }) => {
    expect(() => resolveMcpServers([installation(name)], {})).toThrow('MCP_RESERVED_NAMESPACE');
  });

  it('does not accept user markers or declared origins as built-in authorization', () => {
    expect(() =>
      resolveMcpServers(
        [{ ...installation(NODE_MCP.goal.name), __marGoal: true, origin: 'BUILTIN' }],
        {}
      )
    ).toThrow('MCP_RESERVED_NAMESPACE');
  });

  it('merges trusted execution descriptions without pretending they are installations', () => {
    const execution: ResolvedMcpServer = {
      name: NODE_MCP.goal.name,
      origin: 'BUILTIN',
      lifecycle: 'EXECUTION',
      transport: 'STDIO',
      command: 'node',
      args: [],
      environment: { MAR_GOAL_MCP_TOKEN: 'execution-only' },
      allowedToolCallers: { [NODE_MCP.goal.tools.get]: ['direct', 'programmatic'] }
    };
    const servers = resolveMcpServers([installation('external')], {}, [execution]);
    expect(servers).toHaveLength(2);
    expect(servers[1]).toMatchObject(execution);
    expect(servers[0]?.environment).not.toHaveProperty('MAR_GOAL_MCP_TOKEN');
    expect(servers[1]).not.toHaveProperty('installedAt');
  });

  it('rejects collisions after alias normalization rather than overwriting a server', () => {
    expect(() => assertMcpServerNames([{ name: 'org/server' }, { name: 'org.server' }])).toThrow(
      'MCP_SERVER_NAME_CONFLICT'
    );
  });
});

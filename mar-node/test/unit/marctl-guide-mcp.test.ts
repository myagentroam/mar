import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { marctlDescription, marctlInstructions } from '../../src/marctl-guidance.js';
import { withMarctlGuide } from '../../src/mcp/marctl-guide.js';
import { NODE_MCP } from '../../src/mcp/naming.js';
import { CodexRunner } from '../../src/runner/codex-runner.js';
import { ClaudeCodeRunner } from '../../src/runner/claude-code-runner.js';
import { OpenCodeRunner } from '../../src/runner/opencode-runner.js';
import { MarAgentRunner } from '../../src/runner/mar-agent-runner.js';
import { marctlHostSkill } from '../../src/runner/mar-agent/marctl-skill.js';

const environment = {
  MAR_CTL_CONTEXT_REQUIRED: '1',
  MAR_CTL_SERVER_URL: 'https://fixture.invalid',
  MAR_CTL_USER_TOKEN: 'private-fixture-token',
  MAR_CTL_NODE_ID: 'node',
  MAR_CTL_WORKSPACE_ID: 'workspace'
};

it('publishes the same lazy guide as the Host Skill through real MCP without credentials', async () => {
  const [server] = withMarctlGuide([], environment);
  expect(server).toMatchObject({ name: 'mar_cli', origin: 'BUILTIN', lifecycle: 'EXECUTION' });
  expect(server).not.toHaveProperty('environment');
  expect(JSON.stringify(server)).not.toContain(environment.MAR_CTL_USER_TOKEN);
  const client = new Client({ name: 'marctl-guide-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: server!.command!,
    args: [...server!.args!],
    env: {}
  });
  try {
    await client.connect(transport);
    const skill = marctlHostSkill(environment)!;
    expect(skill.description).toBe(marctlDescription);
    expect(skill.description).toContain('prefer --runner mar-agent');
    expect(skill.description).toContain('user or applicable workflow specifies another Runner');
    expect(client.getServerVersion()?.name).toBe('mar_cli');
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(1);
    const tool = tools[0]!;
    expect(tool.name).toBe('load_guide');
    expect(tool.inputSchema.properties).toEqual({});
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true });
    expect(tool.description).toContain(skill.description);
    expect(tool.description).toContain('native shell tool');
    expect(client.getInstructions()).toBe(tool.description);
    expect(tool.description).not.toContain(marctlInstructions);
    const result = await client.callTool({ name: 'load_guide', arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: await skill.load() }]);
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('marctl sessions start --runner mar-agent')
    });
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('user or applicable workflow specifies another Runner')
    });
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('not a reason to silently switch')
    });
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('An omitted model uses the target Runner configuration')
    });
    expect((await client.callTool({ name: 'load_guide', arguments: {} })).content).toEqual(
      result.content
    );
    expect(JSON.stringify(result)).not.toContain(environment.MAR_CTL_USER_TOKEN);
    expect((await client.callTool({ name: 'execute', arguments: {} })).isError).toBe(true);
  } finally {
    await client.close();
    await transport.close();
  }
});

it.each(['MAR_CTL_USER_TOKEN', 'MAR_CTL_SERVER_URL', 'MAR_CTL_NODE_ID', 'MAR_CTL_WORKSPACE_ID'])(
  'does not advertise unavailable CLI context without %s',
  (key) => {
    const incomplete: Record<string, string> = { ...environment };
    delete incomplete[key];
    expect(withMarctlGuide([], incomplete)).toEqual([]);
  }
);

it('rejects conflicting execution names instead of shadowing them', () => {
  expect(() => withMarctlGuide(withMarctlGuide([], environment), environment)).toThrow(
    'MCP_SERVER_NAME_CONFLICT'
  );
});

it('keeps MAR Agent on its Host Skill without publishing duplicate MCP guidance', () => {
  expect(new MarAgentRunner().mcpConfiguration([], environment)).toEqual([]);
  expect(marctlHostSkill(environment)).toBeDefined();
});

it.each([
  ['codex', () => new CodexRunner(), 'env'],
  ['claude-code', () => new ClaudeCodeRunner(), 'env'],
  ['opencode', () => new OpenCodeRunner(), 'environment']
] as const)(
  'injects only read-only guidance into the %s native configuration',
  (_name, create, envKey) => {
    const runner = create();
    expect(runner.mcpConfiguration([], {})).toEqual({});
    const native = runner.mcpConfiguration([], environment, [
      {
        name: NODE_MCP.schedule.name,
        origin: 'BUILTIN',
        lifecycle: 'EXECUTION',
        transport: 'STDIO',
        command: 'node',
        args: ['schedule-fixture.js']
      }
    ]) as Record<string, Record<string, unknown>>;
    expect(Object.keys(native)).toEqual(['mar_schedule', 'mar_cli']);
    expect(native['mar_cli']![envKey]).toEqual({});
    const [guide] = withMarctlGuide([], environment);
    if (_name === 'opencode') {
      expect(native['mar_cli']!['command']).toEqual([guide!.command, ...guide!.args!]);
    } else {
      expect(native['mar_cli']!['command']).toBe(guide!.command);
      expect(native['mar_cli']!['args']).toEqual(guide!.args);
    }
    expect(() =>
      runner.mcpConfiguration(
        [
          {
            serverName: 'mar_cli',
            enabled: true,
            runtime: { transport: 'STDIO', command: 'node', args: [], environment: {} },
            configuration: {}
          }
        ],
        environment
      )
    ).toThrow('MCP_RESERVED_NAMESPACE');
  }
);

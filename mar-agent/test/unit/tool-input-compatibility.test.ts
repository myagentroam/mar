import {
  directLocalProcessExecutor,
  signalProcessTree
} from '../../src/host/local-process-executor.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalAgentHost } from '../../src/host/local-agent-host.js';
import { CodeModeTool } from '../../src/tools/code-mode/index.js';
import {
  codeModeToolDefinition,
  codeExecWaitToolDefinition
} from '../../src/tools/code-mode/index.js';
import type { ToolExecutionContext } from '../../src/tools/contracts.js';
import type { AgentExtension, SessionExtensionContext } from '../../src/extensions/contracts.js';
import { normalizeToolInput } from '../../src/tools/input.js';
import {
  answer,
  call,
  fixture as coreFixture,
  cleanupCoreFixtures
} from './support/core-extension-fixture.js';

const hosts: LocalAgentHost[] = [];
const roots: string[] = [];
afterEach(async () => {
  await cleanupCoreFixtures();
  await Promise.all(hosts.splice(0).map((host) => host.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const context = (): ToolExecutionContext => ({
  sessionId: 'compatibility',
  executionId: 'execution',
  mode: 'run',
  signal: new AbortController().signal,
  codeMode: { tools: [], invoke: async () => ({ content: '' }) }
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'mar-tool-input-'));
  roots.push(home);
  const workspace = join(home, 'workspace');
  await mkdir(workspace);
  const host = new LocalAgentHost({ homeDirectory: home, workspace });
  hosts.push(host);
  return { host, workspace };
}

describe('Tool input compatibility', () => {
  it('preserves open dictionaries and conservative schema branches while pruning explicitly closed objects', () => {
    const input = {
      amount: 3,
      missing: undefined,
      unknown: 'PRIVATE_VALUE',
      settings: { arbitrary: true },
      items: [{ declared: false, unknown: 2 }]
    };
    const schema = {
      additionalProperties: false,
      properties: {
        amount: {},
        settings: { type: 'object' },
        items: { items: { additionalProperties: false, properties: { declared: {} } } }
      }
    };
    expect(normalizeToolInput(input, schema)).toEqual({
      amount: 3,
      settings: { arbitrary: true },
      items: [{ declared: false }]
    });
    expect(input).toHaveProperty('unknown', 'PRIVATE_VALUE');
    expect(
      normalizeToolInput(input, {
        additionalProperties: false,
        anyOf: [{ properties: { amount: {} } }]
      })
    ).toHaveProperty('unknown', 'PRIVATE_VALUE');
    expect(
      normalizeToolInput(
        { prefix_key: 1 },
        { additionalProperties: false, patternProperties: { '^prefix': {} } }
      )
    ).toEqual({ prefix_key: 1 });
    const adversarial = JSON.parse('{"__proto__":{"polluted":true},"declared":1}');
    expect(
      normalizeToolInput(adversarial, { additionalProperties: false, properties: { declared: {} } })
    ).toEqual({ declared: 1 });
    expect({}).not.toHaveProperty('polluted');
    const many = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => ['private_' + index, 'PRIVATE_VALUE'])
    );
    expect(normalizeToolInput(many, { additionalProperties: false })).toEqual({});
  });

  it('ignores unsupported exec fields without changing command results or program data', async () => {
    const { host } = await fixture();
    const input = {
      command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('compatible')"`,
      maxOutputTokens: 1,
      yieldMs: 10000
    };
    const result = await host.executeTool({ name: 'exec', arguments: input }, context());
    expect(result.data).toMatchObject({ stdout: 'compatible', exitCode: 0 });
    expect(JSON.parse(result.content)).toMatchObject({ stdout: 'compatible', exitCode: 0 });
    expect(input.maxOutputTokens).toBe(1);
  });

  it('retains validation of missing required fields and invalid declared values', async () => {
    const { host } = await fixture();
    for (const arguments_ of [
      { maxOutputTokens: 100 },
      { command: 7, extra: true },
      { command: 'unused', yieldMs: -1, extra: true }
    ])
      await expect(
        host.executeTool({ name: 'exec', arguments: arguments_ }, context())
      ).rejects.toMatchObject({ code: 'MAR_AGENT_TOOL_INPUT_INVALID' });
  });

  it('ignores unknown read item fields without discarding valid item fields', async () => {
    const { host } = await fixture();
    const result = await host.executeTool(
      {
        name: 'read',
        arguments: {
          reads: [{ path: 'missing.txt', offset: 1, unrelated: 'PRIVATE_VALUE' }],
          extra: true
        }
      },
      context()
    );
    expect(result.content).not.toContain('PRIVATE_VALUE');
    expect(result.data).toMatchObject({ results: [{ path: 'missing.txt' }] });
  });

  it('omits undefined object properties at the Code Mode input bridge only', async () => {
    const { workspace } = await fixture();
    const invoke = vi.fn(async () => ({ content: 'original' }));
    const tool = new CodeModeTool(
      new (await import('../../src/tools/shared/path-resolver.js')).WorkspacePathResolver(
        workspace
      ),
      undefined,
      directLocalProcessExecutor,
      signalProcessTree
    );
    try {
      const result = await tool.execute(
        `const r = await tools.sample({ required: 1, optional: undefined, nested: { omitted: undefined } }); observe.result(r);`,
        {
          ...context(),
          codeMode: {
            tools: [
              {
                name: 'sample',
                description: 'Fixture',
                inputSchema: { type: 'object' },
                allowedCallers: ['programmatic']
              }
            ],
            invoke
          }
        }
      );
      expect(invoke).toHaveBeenCalledWith(
        expect.objectContaining({ arguments: { required: 1, nested: {} } }),
        expect.anything()
      );
      expect(result.observations?.[0]).toMatchObject({
        type: 'tool_result',
        result: { content: 'original' }
      });
      await expect(
        tool.execute('await tools.sample({ values: [undefined] });', {
          ...context(),
          codeMode: {
            tools: [
              {
                name: 'sample',
                description: 'Fixture',
                inputSchema: { type: 'object' },
                allowedCallers: ['programmatic']
              }
            ],
            invoke
          }
        })
      ).rejects.toMatchObject({ code: 'MAR_AGENT_TOOL_INPUT_INVALID' });
      await expect(
        tool.execute('state.set("undefined", { invalid: undefined });', context())
      ).rejects.toMatchObject({ code: 'MAR_AGENT_TOOL_INPUT_INVALID' });
    } finally {
      await tool.dispose();
    }
  });

  it('does not expose a model-adjustable cell output token budget', () => {
    expect(codeModeToolDefinition.description).not.toContain('maxOutputTokens');
    expect(codeExecWaitToolDefinition.inputSchema.properties).not.toHaveProperty('maxOutputTokens');
  });

  it('ignores removed cell options without prematurely clipping initial or cached observations', async () => {
    const { host } = await fixture();
    const result = await host.executeTool(
      {
        name: 'code_exec',
        arguments: '// @options: {"maxOutputTokens":1}\nobserve.text("preserved output");'
      },
      context()
    );
    expect(result.observations?.[0]).toMatchObject({ value: 'preserved output' });
    const replay = await host.executeTool(
      {
        name: 'code_exec_wait',
        arguments: { cellId: (result.data as { cellId: string }).cellId, maxOutputTokens: 0 }
      },
      context()
    );
    expect(replay.observations?.[0]).toMatchObject({ value: 'preserved output' });
    expect(replay.truncated).not.toBe(true);
  });

  it.each([
    ['OPENAI_RESPONSES', false],
    ['OPENAI_RESPONSES', true],
    ['ANTHROPIC_MESSAGES', false],
    ['ANTHROPIC_MESSAGES', true]
  ] as const)(
    'normalizes actual SDK %s tools in codeMode=%s without contaminating raw evidence',
    async (protocol, codeMode) => {
      let actual: unknown;
      let sessionContext!: SessionExtensionContext;
      const extension: AgentExtension = {
        id: 'compatibility',
        apiVersion: '1.0',
        attachSession(context) {
          sessionContext = context;
          context.tools.register({
            name: 'probe',
            description: 'Fixture',
            inputSchema: {
              type: 'object',
              additionalProperties: false,
              required: ['amount'],
              properties: { amount: { type: 'number' } }
            },
            execute(input) {
              actual = input;
              return { content: '{"result":2}', data: { result: 2 } };
            }
          });
        }
      };
      const { session, adapter } = await coreFixture(
        [extension],
        (_request, index) =>
          index
            ? answer()
            : codeMode
              ? call(
                  'code_exec',
                  protocol === 'ANTHROPIC_MESSAGES'
                    ? {
                        code: 'observe.result(await tools.probe({ amount: 2, extra: true, optional: undefined }));'
                      }
                    : 'observe.result(await tools.probe({ amount: 2, extra: true, optional: undefined }));'
                )
              : call('probe', { amount: 2, extra: true }),
        codeMode,
        false,
        {},
        protocol
      );
      await session.run({ prompt: 'Check compatibility.' }).result();
      expect(actual).toEqual({ amount: 2 });
      const result = adapter.requests[1]!.messages.find((message) => message.role === 'tool')!;
      if (codeMode) {
        expect(result.contentParts).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: 'text', text: expect.stringContaining('{"result":2}') })
          ])
        );
        const stored = (await sessionContext.session!.messages()).messages.find(
          (message) => message.role === 'tool' && message.observations?.length
        );
        expect(stored?.observations?.[0]).toMatchObject({
          type: 'tool_result',
          result: { content: '{"result":2}' }
        });
      } else {
        expect(result.content).toBe('{"result":2}');
      }
    }
  );
});

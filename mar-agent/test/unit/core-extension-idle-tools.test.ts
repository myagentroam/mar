import { afterEach, describe, expect, it } from 'vitest';
import type { SessionExtensionContext } from '../../src/extensions/contracts.js';
import type { ExtensionOperationContext } from '../../src/extensions/operation.js';
import { answer, call, cleanupCoreFixtures, fixture } from './support/core-extension-fixture.js';

afterEach(cleanupCoreFixtures);

function extension(save: (value: SessionExtensionContext) => void) {
  return { id: 'idle', apiVersion: '1.0' as const, attachSession: save };
}

describe('Idle Core tool sources', () => {
  it.each([false, true])(
    'selects idle Local sources for a timer while its model creator is still active (codeMode=%s)',
    async (codeMode) => {
      let timerCall: ExtensionOperationContext | undefined;
      let timerError: unknown;
      let text: string | undefined;
      const readFacts: Array<{ parentAttemptId?: string }> = [];
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const { session } = await fixture(
        [
          extension((value) => {
            value.hooks.observe('tool.completed', (fact) => {
              if (fact.name === 'read') readFacts.push(fact);
            });
            value.tools.register({
              name: 'creator',
              description: 'Creator',
              inputSchema: { type: 'object' },
              parallelSafety: 'safe',
              async execute() {
                value.clock.after(0, async (call) => {
                  timerCall = call;
                  try {
                    text = (
                      await value.tools.invoke({
                        name: 'read',
                        arguments: { reads: [{ path: 'input.txt' }] }
                      })
                    ).content;
                  } catch (error) {
                    timerError = error;
                  } finally {
                    finish();
                  }
                });
                await finished;
                return { content: 'creator complete' };
              }
            });
          })
        ],
        (_request, index) =>
          index
            ? answer()
            : codeMode
              ? call('code_exec', { code: 'observe.result(await tools.creator({}))' })
              : call('creator', {}),
        codeMode
      );
      try {
        expect(await session.run({ prompt: 'run creator' }).result()).toMatchObject({
          status: 'completed'
        });
        expect(timerError).toBeUndefined();
        expect(text).toContain('extension-data');
        expect(timerCall).toMatchObject({ actor: 'extension', entry: 'native-api' });
        expect(timerCall!.executionId).toBeUndefined();
        expect(timerCall!.parentOperationId).toBeUndefined();
        expect(readFacts).toHaveLength(1);
        expect(readFacts[0]!.parentAttemptId).toBeUndefined();
      } finally {
        finish();
      }
    }
  );

  it('shares the existing serial scheduler for sibling idle tool calls', async () => {
    let context!: SessionExtensionContext;
    let begin!: () => void;
    let finish!: () => void;
    const started = new Promise<void>((resolve) => {
      begin = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let entered = 0;
    const { session } = await fixture(
      [
        extension((value) => {
          context = value;
        })
      ],
      answer,
      false,
      false,
      {
        operationTools: {
          catalog: () => [
            {
              definition: {
                name: 'probe',
                description: 'Probe',
                inputSchema: { type: 'object' },
                parallelSafety: 'serial'
              },
              source: { kind: 'host', id: 'probe', revision: '1' },
              execute: async () => {
                entered++;
                begin();
                await gate;
                return { content: 'done' };
              }
            }
          ]
        }
      }
    );
    await session.run({ prompt: 'initialize' }).result();
    const first = context.tools.invoke({ name: 'probe', arguments: {} });
    const second = context.tools.invoke({ name: 'probe', arguments: {} });
    await started;
    await new Promise((resolve) => setImmediate(resolve));
    const enteredEarly = entered;
    finish();
    await Promise.all([first, second]);
    expect(enteredEarly).toBe(1);
    expect(entered).toBe(2);
  });
  it.each([false, true])(
    'projects neutral Host sources through the same model registry (codeMode=%s)',
    async (codeMode) => {
      const calls: ExtensionOperationContext[] = [];
      const { session, adapter } = await fixture(
        [],
        (_request, index) =>
          !index
            ? codeMode
              ? call('code_exec', { code: 'observe.result(await tools.host_probe({}))' })
              : call('host_probe', {})
            : answer(),
        codeMode,
        false,
        {
          operationTools: {
            catalog: () => [
              {
                definition: {
                  name: 'host_probe',
                  description: 'Host probe',
                  inputSchema: { type: 'object' },
                  allowedCallers: ['direct', 'programmatic']
                },
                source: { kind: 'host', id: 'host-probe', revision: '1' },
                execute: async (_input, call) => {
                  calls.push(call);
                  return { content: 'probe', data: { native: true } };
                }
              }
            ]
          }
        }
      );
      expect((await session.run({ prompt: 'probe' }).result()).status).toBe('completed');
      expect(calls).toHaveLength(1);
      expect(calls[0]?.entry).toBe(codeMode ? 'programmatic' : 'direct');
      expect(calls[0]?.executionId).toBeDefined();
      expect(adapter.requests).toHaveLength(2);
    }
  );
  it('uses real Local Host bindings at idle without borrowing an execution or writing model history', async () => {
    let context!: SessionExtensionContext;
    const calls: ExtensionOperationContext[] = [];
    const { session, adapter } = await fixture(
      [
        extension((value) => {
          context = value;
        })
      ],
      answer,
      false,
      false,
      {
        beforeOperationToolExecute: (_input, call) => {
          calls.push(call);
        }
      }
    );
    await session.run({ prompt: 'initialize' }).result();
    const ref = context.tools.catalog().find((value) => value.definition.name === 'read');
    if (!ref) throw new Error('Idle read source is missing.');
    expect(ref.source.kind).toBe('builtin');
    expect(await context.tools.check({ name: 'read', arguments: {}, ref })).toMatchObject({
      available: true
    });
    const result = await context.tools.invoke({
      name: 'read',
      arguments: { reads: [{ path: 'input.txt' }] },
      ref
    });
    expect(result.data).toMatchObject({ results: [{ text: 'extension-data' }] });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      actor: 'extension',
      entry: 'native-api',
      sessionId: session.id
    });
    expect(calls[0]?.executionId).toBeUndefined();
    expect(calls[0]?.operationId).toBeDefined();
    expect(adapter.requests).toHaveLength(1);
    expect(await context.tools.check({ name: 'code_exec', arguments: {} })).toMatchObject({
      available: false
    });
  });

  it('starts a real idle exec with the Session/operation owner and shared environment', async () => {
    let context!: SessionExtensionContext;
    const { session } = await fixture(
      [
        extension((value) => {
          context = value;
        })
      ],
      answer
    );
    await session.run({ prompt: 'initialize' }).result();
    await context.environment!.set({ key: 'MAR_IDLE_TOOL', value: 'idle-source' });
    const result = await context.tools.invoke({
      name: 'exec',
      arguments: {
        command: `${JSON.stringify(process.execPath)} -e "process.stdout.write(process.env.MAR_IDLE_TOOL)"`
      }
    });
    expect(result.data).toMatchObject({ status: 'completed', stdout: 'idle-source', exitCode: 0 });
  });

  it('captures ordinary Host handlers rather than dispatching a later implementation by name', async () => {
    let context!: SessionExtensionContext;
    let current = 'a';
    const refSource = (value: string) => ({
      definition: {
        name: 'host_probe',
        description: 'Host probe',
        inputSchema: { type: 'object' }
      },
      source: { kind: 'host' as const, id: 'host-probe', revision: value },
      available: () => current === value,
      execute: async (_input: unknown, call: ExtensionOperationContext) => ({
        content: value,
        data: { executionId: call.executionId }
      })
    });
    const { session, host } = await fixture(
      [
        extension((value) => {
          context = value;
        })
      ],
      answer,
      false,
      false,
      { operationTools: { catalog: () => [refSource(current)] } }
    );
    await session.run({ prompt: 'initialize' }).result();
    const old = context.tools.catalog().find((value) => value.definition.name === 'host_probe')!;
    expect(
      (await context.tools.invoke({ name: 'host_probe', arguments: {}, ref: old })).content
    ).toBe('a');
    current = 'b';
    expect(
      await context.tools.check({ name: 'host_probe', arguments: {}, ref: old })
    ).toMatchObject({ available: false });
    await expect(
      context.tools.invoke({ name: 'host_probe', arguments: {}, ref: old })
    ).rejects.toThrow(/NOT_AVAILABLE/);
    expect((await context.tools.invoke({ name: 'host_probe', arguments: {} })).content).toBe('b');
    expect(host.extensionPorts.tools).toBeDefined();
  });

  it('does not reread a captured Host handler after an asynchronous policy callback', async () => {
    let context!: SessionExtensionContext;
    let began!: () => void;
    let finish!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const source = {
      definition: { name: 'host_probe', description: 'Probe', inputSchema: { type: 'object' } },
      source: { kind: 'host' as const, id: 'probe', revision: 'a' },
      execute: async () => ({ content: 'a' })
    };
    const { session } = await fixture(
      [
        extension((value) => {
          context = value;
        })
      ],
      answer,
      false,
      false,
      {
        operationTools: { catalog: () => [source] },
        beforeOperationToolExecute: async () => {
          began();
          await gate;
        }
      }
    );
    await session.run({ prompt: 'initialize' }).result();
    const ref = context.tools.catalog().find((value) => value.definition.name === 'host_probe')!;
    const result = context.tools.invoke({ name: 'host_probe', arguments: {}, ref });
    await started;
    source.execute = async () => ({ content: 'b' });
    source.source.revision = 'b';
    finish();
    expect((await result).content).toBe('a');
    expect(ref.source.revision).toBe('a');
  });

  it('calls shared static MCP with actual operation identity and a captured source guard', async () => {
    let context!: SessionExtensionContext;
    const calls: Array<{ operation: ExtensionOperationContext; expected: unknown }> = [];
    const { session } = await fixture(
      [
        extension((value) => {
          context = value;
        })
      ],
      answer,
      false,
      false,
      {
        mcpTools: [
          { name: 'mcp__shared__probe', description: 'MCP probe', inputSchema: { type: 'object' } }
        ],
        callMcpOperation: async (_input, operation, expected) => {
          calls.push({ operation, expected });
          return { content: 'mcp', data: { native: true } };
        }
      }
    );
    await session.run({ prompt: 'initialize' }).result();
    const ref = context.tools
      .catalog()
      .find((value) => value.definition.name === 'mcp__shared__probe')!;
    expect(ref?.source.kind).toBe('mcp');
    await expect(
      context.tools.invoke({ name: ref.definition.name, arguments: {}, ref })
    ).resolves.toMatchObject({ content: 'mcp', data: { native: true } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.operation.executionId).toBeUndefined();
    expect(calls[0]?.expected).toEqual({
      sourceIdentity: ref.source.id,
      definitionRevision: ref.source.revision
    });
  });

  it('does not bypass a legacy Execution-only Host policy at idle', async () => {
    let context!: SessionExtensionContext;
    let checks = 0;
    const { session } = await fixture(
      [
        extension((value) => {
          context = value;
        })
      ],
      answer,
      false,
      false,
      {
        beforeToolExecute: () => {
          checks++;
        }
      }
    );
    await session.run({ prompt: 'initialize' }).result();
    expect(await context.tools.check({ name: 'read', arguments: {} })).toMatchObject({
      available: false
    });
    await expect(
      context.tools.invoke({ name: 'read', arguments: { reads: [{ path: 'input.txt' }] } })
    ).rejects.toThrow(/NOT_AVAILABLE/);
    expect(checks).toBe(0);
  });
});

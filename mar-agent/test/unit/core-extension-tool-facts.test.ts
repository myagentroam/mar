import { afterEach, describe, expect, it } from 'vitest';
import type {
  ExtensionDomainFacts,
  AgentExtension,
  SessionExtensionContext
} from '../../src/extensions/contracts.js';
import type { ExtensionOperationContext } from '../../src/extensions/operation.js';
import { AgentError } from '../../src/error.js';
import { answer, call, cleanupCoreFixtures, fixture } from './support/core-extension-fixture.js';

afterEach(cleanupCoreFixtures);

type Recorded = {
  key: keyof ExtensionDomainFacts;
  fact: Record<string, unknown>;
  call: ExtensionOperationContext;
};

function record(context: SessionExtensionContext, records: Recorded[]) {
  for (const key of [
    'tool.completed',
    'tool.failed',
    'tool.attempt.completed',
    'tool.attempt.failed'
  ] as const) {
    context.hooks.observe(key, (fact, call) => {
      records.push({ key, fact: fact as unknown as Record<string, unknown>, call });
    });
  }
}

describe('Core tool invocation facts', () => {
  it('keeps each full leaf outcome separate from a wrapper and the final result', async () => {
    let context!: SessionExtensionContext;
    let effects = 0;
    const records: Recorded[] = [];
    const large = 'x'.repeat(3 * 1024 * 1024);
    const extension: AgentExtension = {
      id: 'facts',
      apiVersion: '1.0',
      attachSession(value) {
        context = value;
        record(value, records);
        value.tools.register({
          name: 'probe',
          description: 'Probe',
          inputSchema: { type: 'object' },
          execute: () => ({ content: large, data: { effect: ++effects } })
        });
      }
    };
    const wrapper: AgentExtension = {
      id: 'wrapper',
      apiVersion: '1.0',
      attachSession(value) {
        value.tools.register({
          name: 'probe',
          description: 'Wrapped',
          inputSchema: { type: 'object' },
          override: 'wrap',
          async execute(input, _call, next) {
            await next(input);
            await next(input);
            return { content: 'wrapped', data: { effects } };
          }
        });
      }
    };
    const { session } = await fixture([extension, wrapper], answer);
    await session.run({ prompt: 'initialize' }).result();
    await expect(
      context.tools.invoke({ name: 'probe', arguments: {}, callId: 'native' })
    ).resolves.toEqual({ content: 'wrapped', data: { effects: 2 } });
    const leaves = records.filter(
      (r) => r.key === 'tool.attempt.completed' && r.fact.stage === 'leaf'
    );
    expect(leaves).toHaveLength(2);
    expect(leaves.map((r) => r.fact.result)).toEqual([
      { content: large, data: { effect: 1 } },
      { content: large, data: { effect: 2 } }
    ]);
    const wrapped = records.find((r) => r.fact.stage === 'wrapper')!;
    const result = records.find((r) => r.key === 'tool.completed')!;
    expect(leaves.map((r) => r.fact.parentAttemptId)).toEqual([
      wrapped.fact.attemptId,
      wrapped.fact.attemptId
    ]);
    expect(wrapped.fact.parentAttemptId).toBe(result.fact.attemptId);
    expect(new Set(records.map((r) => r.fact.attemptId)).size).toBe(4);
    expect(records.every((r) => r.fact.callId === 'native' && !r.call.executionId)).toBe(true);
    expect(result.fact.result).toEqual({ content: 'wrapped', data: { effects: 2 } });
  });

  it('retains successful leaf facts when a wrapper subsequently fails and never retries', async () => {
    let context!: SessionExtensionContext;
    let effects = 0;
    const records: Recorded[] = [];
    const error = new AgentError('TEST_WRAPPER_FAILED', 'Wrapper failed.');
    const { session } = await fixture(
      [
        {
          id: 'facts',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
            record(value, records);
            value.tools.register({
              name: 'probe',
              description: 'Probe',
              inputSchema: { type: 'object' },
              execute: () => ({ content: 'effect', data: ++effects })
            });
          }
        },
        {
          id: 'wrapper',
          apiVersion: '1.0',
          attachSession(value) {
            value.tools.register({
              name: 'probe',
              description: 'Wrapped',
              inputSchema: { type: 'object' },
              override: 'wrap',
              async execute(input, _call, next) {
                await next(input);
                throw error;
              }
            });
          }
        }
      ],
      answer
    );
    await session.run({ prompt: 'initialize' }).result();
    await expect(context.tools.invoke({ name: 'probe', arguments: {} })).rejects.toBe(error);
    expect(effects).toBe(1);
    expect(records.map((r) => [r.key, r.fact.stage])).toEqual([
      ['tool.attempt.completed', 'leaf'],
      ['tool.attempt.failed', 'wrapper'],
      ['tool.failed', 'result']
    ]);
    expect(records.at(-1)?.fact).toMatchObject({
      status: 'failed',
      errorCode: 'TEST_WRAPPER_FAILED'
    });
  });

  it('records a short circuit as a result without fabricating a leaf', async () => {
    let context!: SessionExtensionContext;
    const records: Recorded[] = [];
    const { session } = await fixture(
      [
        {
          id: 'facts',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
            record(value, records);
            value.hooks.intercept('tool.invoke', () => ({ content: 'handled' }));
          }
        }
      ],
      answer
    );
    await session.run({ prompt: 'initialize' }).result();
    await expect(context.tools.invoke({ name: 'virtual', arguments: {} })).resolves.toEqual({
      content: 'handled'
    });
    expect(records).toHaveLength(1);
    expect(records[0]?.fact).toMatchObject({
      name: 'virtual',
      stage: 'result',
      result: { content: 'handled' }
    });
  });

  it('observes cancellation without reopening the cancelled operation or changing its error', async () => {
    let context!: SessionExtensionContext;
    let observedCancelled = false;
    let deniedWrite = false;
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const records: Recorded[] = [];
    const { session } = await fixture(
      [
        {
          id: 'facts',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
            record(value, records);
            value.hooks.observe('tool.failed', async (_fact, call) => {
              observedCancelled = call.signal.aborted;
              await value.data.state.write('late', true).catch(() => {
                deniedWrite = true;
              });
            });
            value.tools.register({
              name: 'probe',
              description: 'Probe',
              inputSchema: { type: 'object' },
              execute(_input, call) {
                began();
                return new Promise((_resolve, reject) => {
                  call.signal.addEventListener('abort', () => reject(call.signal.reason), {
                    once: true
                  });
                });
              }
            });
          }
        }
      ],
      (_request, index) => (!index ? call('probe', {}) : answer())
    );
    const handle = session.run({ prompt: 'probe' });
    const result = handle.result();
    await started;
    handle.cancel();
    expect((await result).status).toBe('cancelled');
    expect(records.map((r) => [r.key, r.fact.status])).toEqual([
      ['tool.attempt.failed', 'cancelled'],
      ['tool.failed', 'cancelled']
    ]);
    expect(observedCancelled).toBe(true);
    expect(deniedWrite).toBe(true);
    expect(await context.data.state.read('late')).toBeUndefined();
  });

  it('joins unawaited wrapper continuations before recording the wrapper result', async () => {
    let context!: SessionExtensionContext;
    let begin!: () => void;
    let finish!: () => void;
    const started = new Promise<void>((resolve) => {
      begin = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const records: Recorded[] = [];
    const { session } = await fixture(
      [
        {
          id: 'facts',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
            record(value, records);
            value.tools.register({
              name: 'probe',
              description: 'Probe',
              inputSchema: { type: 'object' },
              async execute() {
                begin();
                await gate;
                return { content: 'leaf' };
              }
            });
          }
        },
        {
          id: 'wrapper',
          apiVersion: '1.0',
          attachSession(value) {
            value.tools.register({
              name: 'probe',
              description: 'Wrapped',
              inputSchema: { type: 'object' },
              override: 'wrap',
              execute(input, _call, next) {
                void next(input);
                return { content: 'wrapper' };
              }
            });
          }
        }
      ],
      answer
    );
    await session.run({ prompt: 'initialize' }).result();
    let completed = false;
    const result = context.tools.invoke({ name: 'probe', arguments: {} }).then((value) => {
      completed = true;
      return value;
    });
    await started;
    await new Promise((resolve) => setImmediate(resolve));
    const completedEarly = completed;
    const earlyRecords = records.length;
    finish();
    await expect(result).resolves.toEqual({ content: 'wrapper' });
    expect(completedEarly).toBe(false);
    expect(earlyRecords).toBe(0);
    expect(records.map((r) => r.fact.stage)).toEqual(['leaf', 'wrapper', 'result']);
  });

  it('does not allow a programmatic wrapper to upgrade a direct-only lower source', async () => {
    let effects = 0;
    const records: Recorded[] = [];
    const { session } = await fixture(
      [
        {
          id: 'facts',
          apiVersion: '1.0',
          attachSession(value) {
            record(value, records);
            value.tools.register({
              name: 'probe',
              description: 'Probe',
              inputSchema: { type: 'object' },
              allowedCallers: ['direct'],
              execute() {
                effects++;
                return { content: 'leaf' };
              }
            });
          }
        },
        {
          id: 'wrapper',
          apiVersion: '1.0',
          attachSession(value) {
            value.tools.register({
              name: 'probe',
              description: 'Wrapped',
              inputSchema: { type: 'object' },
              override: 'wrap',
              allowedCallers: ['direct', 'programmatic'],
              execute(input, _call, next) {
                return next(input);
              }
            });
          }
        }
      ],
      (_request, index) =>
        !index ? call('code_exec', { code: 'observe.result(await tools.probe({}))' }) : answer(),
      true
    );
    expect((await session.run({ prompt: 'probe' }).result()).status).toBe('completed');
    expect(effects).toBe(0);
    expect(
      records.find((r) => r.key === 'tool.attempt.failed' && r.fact.stage === 'leaf')?.fact
    ).toMatchObject({ errorCode: 'MAR_AGENT_TOOL_NOT_AVAILABLE' });
  });

  it.each([false, true])(
    'records builtin full outcomes for model and Code Mode (codeMode=%s)',
    async (codeMode) => {
      const records: Recorded[] = [];
      const { session, adapter } = await fixture(
        [
          {
            id: 'facts',
            apiVersion: '1.0',
            attachSession(value) {
              record(value, records);
            }
          }
        ],
        (_request, index) =>
          !index
            ? codeMode
              ? call('code_exec', {
                  code: "observe.result(await tools.read({reads:[{path:'input.txt'}]}))"
                })
              : call('read', { reads: [{ path: 'input.txt' }] })
            : answer(),
        codeMode
      );
      expect((await session.run({ prompt: 'read' }).result()).status).toBe('completed');
      const leaf = records.find(
        (r) => r.key === 'tool.attempt.completed' && r.fact.name === 'read'
      )!;
      expect(leaf?.fact).toMatchObject({ stage: 'leaf', source: { kind: 'builtin' } });
      expect(leaf?.call.entry).toBe(codeMode ? 'programmatic' : 'direct');
      expect(leaf?.call.executionId).toBeDefined();
      expect(leaf?.fact.result).toMatchObject({ data: { results: [{ text: 'extension-data' }] } });
      expect(adapter.requests).toHaveLength(2);
      const history = adapter.requests[1]!.messages;
      expect(history.filter((m) => m.role === 'tool')).toHaveLength(1);
    }
  );
});

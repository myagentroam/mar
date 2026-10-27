import { describe, expect, it, vi } from 'vitest';
import { SessionInputCoordinator } from '../../src/extensions/session-input.js';
import type { SessionModelMessage } from '../../src/session/model-request.js';
import type { SessionRecord } from '../../src/session/record-contract.js';
import { createExecutionInput } from '../../src/sdk/execution-input.js';

const unused = (): never => {
  throw new Error('not used');
};
const record: SessionRecord = {
  recordId: 'record',
  sessionId: 'session',
  sequence: 1,
  timestamp: 'now',
  type: 'turn.user',
  payload: {}
};
const host = { describe: async () => ({ homeDirectory: '/tmp' }) };
const storage = {
  persistInputImages: unused,
  readInputImages: unused,
  persistResource: unused,
  setResourceUrl: unused
};

describe('execution input commit', () => {
  it('records physical commit evidence before a live input projection failure', async () => {
    const order: string[] = [];
    const error = new Error('projection');
    const input = createExecutionInput({
      host,
      store: {
        ...storage,
        append: async () => {
          order.push('commit');
          return record;
        }
      },
      sessionId: 'session',
      executionId: 'execution',
      turnId: 'turn',
      mode: 'run',
      source: 'user',
      controller: new AbortController(),
      inputs: new SessionInputCoordinator(),
      messages: [],
      pendingInputs: new Map(),
      messageSources: new WeakMap(),
      modelContext: {
        recordEnvironment: async () => {},
        rememberInput: () => order.push('projection')
      },
      model: () => ({ inputCapabilities: ['TEXT'], contextWindowTokens: 1000 }),
      tokens: () => undefined,
      setSmartInput: () => {},
      withRecordProjection: (run) => run(),
      appendExtensionMessage: async () => ({ changed: false }),
      startCompact: () => {
        throw new Error('not used');
      },
      compactContext: () => {
        throw new Error('not used');
      }
    });
    await expect(
      input.startInitialInput({
        input: { prompt: 'hello' },
        internal: { promptAdmitted: true, inputCommitted: (id) => order.push(id) },
        restoredImages: false,
        operation: (action) =>
          action({
            operationId: 'op',
            sessionId: 'session',
            sessionEpoch: 0,
            actor: 'sdk',
            entry: 'direct',
            signal: new AbortController().signal
          }),
        admit: async () => {
          throw new Error('not used');
        },
        enqueue: async () => {
          throw new Error('not used');
        },
        project: () => {
          throw error;
        }
      })
    ).rejects.toBe(error);
    expect(order).toEqual(['commit', 'record', 'projection']);
  });

  it('acknowledges subagent updates only after append and projection', async () => {
    const error = new Error('append failed');
    const messages: SessionModelMessage[] = [];
    const sources = new WeakMap<SessionModelMessage, SessionRecord>();
    const acknowledge = vi.fn(() => {
      expect(messages).toHaveLength(1);
      expect(sources.get(messages[0]!)?.recordId).toBe('record');
    });
    const append = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(record);
    const input = createExecutionInput({
      host,
      store: { ...storage, append },
      sessionId: 'session',
      executionId: 'execution',
      turnId: 'turn',
      mode: 'run',
      source: 'user',
      controller: new AbortController(),
      inputs: new SessionInputCoordinator(),
      messages,
      pendingInputs: new Map(),
      messageSources: sources,
      modelContext: { recordEnvironment: unused, rememberInput: unused },
      model: () => ({ inputCapabilities: ['TEXT'], contextWindowTokens: 1000 }),
      tokens: () => undefined,
      setSmartInput: () => {},
      withRecordProjection: (run) => run(),
      appendExtensionMessage: async () => ({ changed: false }),
      startCompact: unused,
      compactContext: unused
    });
    const subagents = {
      collectModelUpdates: () => [
        {
          snapshot: { agentId: 'child', status: 'completed' as const, description: 'task' },
          truncated: false,
          acknowledge
        }
      ]
    };
    await expect(input.appendSubagentUpdates(subagents)).rejects.toBe(error);
    expect(acknowledge).not.toHaveBeenCalled();
    expect(messages).toHaveLength(0);
    await input.appendSubagentUpdates(subagents);
    expect(acknowledge).toHaveBeenCalledOnce();
  });
});

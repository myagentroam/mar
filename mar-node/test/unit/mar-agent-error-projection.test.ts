import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalAgentHost } from '../../../mar-agent/src/host.js';
import { AgentError, SecretValue } from '../../../mar-agent/src/index.js';
import { createAgentWithAdapter } from '../../../mar-agent/src/sdk/agent.js';
import type { ModelEvent } from '../../../mar-agent/src/model/contracts.js';
import { openAgentSessionCatalog } from '../../../mar-agent/src/index.js';
import { MarAgentConversationNormalizer } from '../../src/runner/mar-agent/conversation-normalizer.js';
import { projectMarAgentHistory } from '../../src/runner/mar-agent/history-projection.js';
import type { NodeAgentSession } from '../../src/database.js';
import { conversationItemSchema } from '../../../packages/protocol/src/index.js';
import type { AgentEvent, AgentModelConfiguration } from '../../../mar-agent/src/index.js';

const homes: string[] = [];
afterEach(async () =>
  Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
);

const base = {
  eventId: 'event',
  sequence: 1,
  timestamp: '2026-01-01T00:00:00.000Z',
  sessionId: 'session',
  executionId: 'execution',
  turnId: 'turn'
};

describe('MAR Agent error projection', () => {
  it('preserves a real SDK model failure through live, protocol and restored history projections', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mar-node-model-error-'));
    homes.push(home);
    const configuration: AgentModelConfiguration = {
      id: 'fixture',
      name: 'Fixture',
      protocol: 'OPENAI_RESPONSES' as const,
      baseUrl: 'https://example.test',
      apiKey: new SecretValue('fixture-secret'),
      modelId: 'fixture',
      contextWindowTokens: 200_000,
      maxOutputTokens: 4096,
      inputCapabilities: ['TEXT'] as const,
      outputCapabilities: ['TEXT'] as const,
      reasoningEfforts: [],
      titleGeneration: false,
      codeMode: false,
      hostedWebSearch: false,
      responsesPreviousResponseId: false,
      enabled: true
    };
    const agent = await createAgentWithAdapter(
      {
        mode: 'node',
        host: new LocalAgentHost({ mode: 'node', homeDirectory: home, workspace: home }),
        models: [configuration]
      },
      () => ({
        configuration,
        async *start(): AsyncIterable<ModelEvent> {
          yield { type: 'text.completed', itemId: 'answer', text: 'Partial result.' };
          throw new AgentError(
            'MAR_AGENT_MODEL_PROTOCOL_ERROR',
            'Model stream ended unexpectedly.'
          );
        }
      })
    );
    try {
      const session = await agent.createSession({ workspace: home });
      const handle = session.run({ prompt: 'Work until the model stream fails.' });
      const normalizer = new MarAgentConversationNormalizer();
      const items = [];
      for await (const event of handle) items.push(...normalizer.normalize(event));
      const result = await handle.result();
      expect(result).toMatchObject({
        status: 'failed',
        errorCode: 'MAR_AGENT_MODEL_PROTOCOL_ERROR'
      });
      const errors = items.filter((item) => item.kind === 'error');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        status: 'FAILED',
        payload: { code: result.errorCode, message: result.errorMessage }
      });
      expectNormalizedItemsValid(errors);
      const catalog = await openAgentSessionCatalog({ homeDirectory: home });
      try {
        const history = await catalog.history(session.id, { limit: 200 });
        const turns = projectMarAgentHistory(
          { id: 'node-session', runner: 'mar-agent' } as NodeAgentSession,
          history.entries
        );
        expect(turns).toHaveLength(1);
        expect(turns[0]?.status).toBe('FAILED');
        const restoredErrors = turns[0]!.items.filter((item) => item.kind === 'error');
        expect(restoredErrors).toHaveLength(1);
        expect(restoredErrors[0]?.payload).toEqual(errors[0]?.payload);
      } finally {
        await catalog.close();
      }
    } finally {
      await agent.dispose();
    }
  });

  it('projects a detailed SDK tool failure reason onto the tool card', () => {
    const event: AgentEvent = {
      ...base,
      type: 'tool.failed',
      toolName: 'read',
      callId: 'read-1',
      code: 'EACCES',
      message: 'EACCES: Failed to open AGENTS.md: access denied.'
    };
    const [item] = new MarAgentConversationNormalizer().normalize(event);

    expect(item).toEqual(
      expect.objectContaining({
        kind: 'tool_call',
        status: 'FAILED',
        payload: expect.objectContaining({
          toolName: 'read',
          errorCode: 'EACCES',
          outputSummary: 'EACCES: Failed to open AGENTS.md: access denied.'
        })
      })
    );
    expectNormalizedItemsValid(item === undefined ? [] : [item]);
  });

  it('projects subagent failure details on the status control without rewriting the start receipt', () => {
    const normalizer = new MarAgentConversationNormalizer();
    normalizer.normalize({
      ...base,
      type: 'tool.started',
      toolName: 'agent_start',
      callId: 'start-1',
      input: { description: 'Inspect AGENTS', prompt: 'Inspect AGENTS', role: 'explore' }
    });
    const [startReceipt] = normalizer.normalize({
      ...base,
      eventId: 'start-completed',
      type: 'tool.completed',
      toolName: 'agent_start',
      callId: 'start-1',
      summary: 'started',
      data: { agentId: 'task-1', description: 'Inspect AGENTS', status: 'running' }
    });
    const failure = {
      agentId: 'task-1',
      description: 'Inspect AGENTS',
      status: 'failed' as const,
      errorCode: 'EACCES',
      errorMessage: 'EACCES: Failed to open AGENTS.md: access denied.'
    };
    const event: AgentEvent = {
      ...base,
      type: 'subagent.completed',
      ...failure
    };
    expect(normalizer.normalize(event)).toEqual([]);
    expect(startReceipt).toMatchObject({
      itemId: 'mar-agent-tool:start-1',
      status: 'COMPLETED',
      payload: { toolName: 'agent_start', subagentOperation: 'START', errorCode: null }
    });
    normalizer.normalize({
      ...base,
      eventId: 'wait-started',
      type: 'tool.started',
      toolName: 'agent_wait',
      callId: 'wait-1',
      input: { agentId: 'task-1' }
    });
    const [item] = normalizer.normalize({
      ...base,
      eventId: 'wait-completed',
      type: 'tool.completed',
      toolName: 'agent_wait',
      callId: 'wait-1',
      summary: 'failed',
      data: failure
    });

    expect(item).toEqual(
      expect.objectContaining({
        itemId: 'mar-agent-tool:wait-1',
        kind: 'tool_call',
        status: 'COMPLETED',
        payload: expect.objectContaining({
          toolName: 'agent_wait',
          subagentOperation: 'STATUS',
          errorCode: 'EACCES',
          outputSummary: 'EACCES: Failed to open AGENTS.md: access denied.'
        })
      })
    );
    expectNormalizedItemsValid([
      ...(startReceipt === undefined ? [] : [startReceipt]),
      ...(item === undefined ? [] : [item])
    ]);
  });
});

function expectNormalizedItemsValid(
  items: readonly ReturnType<MarAgentConversationNormalizer['normalize']>[number][]
): void {
  for (const item of items)
    expect(
      conversationItemSchema.safeParse({
        id: item.itemId,
        sessionId: 'session',
        turnId: 'turn',
        runId: 'run',
        parentItemId: null,
        sourceSequence: 1,
        revision: 0,
        kind: item.kind,
        status: item.status,
        startedAt: 1,
        completedAt: item.status === 'IN_PROGRESS' ? null : 2,
        payload: item.payload
      }).success
    ).toBe(true);
}

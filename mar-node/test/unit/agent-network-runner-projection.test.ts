import { expect, it, vi } from 'vitest';
import type { NodeEnvelope } from '@myagentroam/protocol';
import type { ClaudeQueryInput } from '../../src/runner/claude/claude-agent-sdk.js';
import type { ClaudeCodeRunner } from '../../src/runner/claude-code-runner.js';
import { ClaudeManagedRunController } from '../../src/runner/claude/managed-run-controller.js';
import { codexLiveConversationItem } from '../../src/runner/codex/conversation-parser.js';
import type { OpenCodeServerClient } from '../../src/runner/opencode/opencode-server.js';
import { OpenCodeRunner } from '../../src/runner/opencode-runner.js';
import { OpenCodeManagedRunController } from '../../src/runner/opencode/managed-run-controller.js';
import { ResponseLatencyTracker } from '../../src/service/response-latency-tracker.js';
import { GenerationTimingTracker } from '../../src/service/generation-timing-tracker.js';
import {
  AgentNetworkObservations,
  agentObservationFromRunEvent
} from '../../src/service/agent-network-observations.js';
import { waitForAgentTargets } from '../../src/service/agent-network-wait.js';
import { executionActivity } from './support/execution-activity.js';

async function checkPublicMessage(item: unknown) {
  const observation = agentObservationFromRunEvent({
    eventType: 'conversation.item',
    payload: item,
    terminalStatus: undefined
  });
  expect(observation).toEqual({ kind: 'message', value: 'public reply' });
  if (!observation) throw new Error('Runner did not publish a completed public message');
  const network = new AgentNetworkObservations();
  const parent = network.attach('parent');
  const identity = { parentId: 'parent', childId: 'child', runId: 'run', executionId: 'execution' };
  network.publish({ ...identity, ...observation });
  const result = await waitForAgentTargets({
    targets: [
      {
        agentId: 'child',
        runId: 'run',
        executionId: 'execution',
        read: () => ({ status: 'RUNNING' })
      }
    ],
    observations: parent,
    waitFor: 'message',
    waitMs: 1,
    single: true
  });
  expect(result).toMatchObject({
    waitOutcome: 'message',
    updates: [{ kind: 'message', value: 'public reply' }]
  });
  expect(result).not.toHaveProperty('summary');
  parent.close();
}

it('preserves an unclassified Codex native message through normalization and wait', async () => {
  const item = codexLiveConversationItem(
    { id: 'message', type: 'agentMessage', text: 'public reply' },
    true
  );
  await checkPublicMessage(item);
});

it('preserves an unclassified OpenCode native message through normalization and wait', async () => {
  const runner = new OpenCodeRunner({} as OpenCodeServerClient);
  runner.execution.set('run', {
    runId: 'run',
    sessionId: 'session',
    nativeSessionId: 'native',
    cwd: '/workspace',
    client: {} as OpenCodeServerClient,
    abort: new AbortController(),
    access: 'default',
    agent: 'build',
    responseLatency: new ResponseLatencyTracker(),
    generationTiming: new GenerationTimingTracker(),
    responsePartKinds: new Map(),
    responseStartedAt: 1_000,
    responseMessages: new Set()
  });
  const items: unknown[] = [];
  const controller = new OpenCodeManagedRunController(runner, {
    emit: vi.fn(),
    emitItem: (_run: string, item: unknown) => items.push(item)
  } as unknown as ConstructorParameters<typeof OpenCodeManagedRunController>[1]);
  const internal = controller as unknown as {
    event(runId: string, sessionId: string, event: unknown): void;
  };
  internal.event('run', 'native', {
    type: 'message.updated',
    properties: {
      info: {
        id: 'assistant',
        role: 'assistant',
        parentID: 'user',
        time: { created: 1000 },
        sessionID: 'native'
      }
    }
  });
  internal.event('run', 'native', {
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'answer',
        type: 'text',
        messageID: 'assistant',
        sessionID: 'native',
        text: 'public reply',
        time: { end: 1001 }
      }
    }
  });
  await checkPublicMessage(
    items.find((item) => (item as { kind?: string }).kind === 'assistant_message')
  );
});

it('preserves an unclassified Claude native message through normalization and wait', async () => {
  let query: ClaudeQueryInput | undefined;
  const items: unknown[] = [];
  const runner = {
    execution: { runs: new Map(), managedNativeIds: new Set() },
    mcpConfiguration: () => ({}),
    startChannel: (value: ClaudeQueryInput) => {
      query = value;
      return { cancel: vi.fn(), completed: new Promise<void>(() => undefined) };
    }
  } as unknown as ClaudeCodeRunner;
  const controller = new ClaudeManagedRunController(runner, {
    ...executionActivity(),
    intercepted: () => false,
    parseAttachments: () => [],
    adopt: vi.fn(),
    run: () => undefined,
    completeCancelled: () => false,
    emit: vi.fn(),
    emitItem: (_run: string, item: unknown) => items.push(item),
    setChannelToken: vi.fn(),
    send: vi.fn(),
    session: () => undefined,
    promote: vi.fn(),
    syncTitle: async () => undefined
  } as unknown as ConstructorParameters<typeof ClaudeManagedRunController>[1]);
  controller.start({
    type: 'run.start',
    payload: {
      runner: 'claude-code',
      runId: 'run',
      sessionId: 'session',
      input: 'Hello',
      cwd: '/workspace'
    }
  } as NodeEnvelope);
  query?.onMessage({
    type: 'assistant',
    message: { id: 'answer', content: [{ type: 'text', text: 'public reply' }] }
  } as never);
  await checkPublicMessage(
    items.find((item) => (item as { kind?: string }).kind === 'assistant_message')
  );
});

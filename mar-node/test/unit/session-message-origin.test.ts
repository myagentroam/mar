import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { parseComposerTags, composerVisibleText } from '@myagentroam/protocol';
import { NodeConnector } from '../../src/connector.js';
import { NodeDatabase } from '../../src/database.js';
import type { NodeRuntimeState } from '../../src/runtime-state.js';
import type { CodexAppServerClient } from '../../src/codex-app-server.js';
import { capabilities, codexProfileClientFactory, eventually } from './support/codex-connector.js';

it('preserves marctl origin across Session start, FIFO delivery, steering, history and replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'marctl-origin-'));
  const database = new NodeDatabase(':memory:', 'node-marctl-origin');
  const workspace = database.saveWorkspace({ path: root, kind: 'DIRECTORY', gitSummary: null });
  let turn = 0;
  const startTurn = vi.fn<CodexAppServerClient['startTurn']>(async () => ({
    turn: { id: 'turn-' + ++turn }
  }));
  const client = {
    onNotification: () => () => undefined,
    start: async () => undefined,
    stop: () => undefined,
    configureEnvironment: () => undefined,
    clearEnvironment: () => undefined,
    startThread: async () => ({ thread: { id: 'thread-origin' } }),
    resumeThread: async (id: string) => ({ thread: { id } }),
    startTurn,
    interruptTurn: async (threadId: string, turnId: string) => {
      node.codexRunController.handleNotification({
        method: 'turn/completed',
        params: { threadId, turn: { id: turnId, status: 'interrupted' } }
      });
      return {};
    }
  } as unknown as CodexAppServerClient;
  const connector = new NodeConnector({
    reconnect: false,
    database,
    capabilities: capabilities(),
    codexClient: client,
    codexRunClientFactory: () => client,
    codexProfileClientFactory
  });
  const node = connector as unknown as {
    runtime: NodeRuntimeState;
    executeNodeOperation(operation: string, data: unknown): Promise<unknown>;
    codexRunController: { handleNotification(input: { method: string; params: unknown }): void };
    continuousRunCoordinator: {
      pending(id: string): { restartMessage?: { content: string } } | undefined;
    };
  };
  const origin = { sessionId: 'coordinator', name: 'Coordinator#42 A & <B>' };
  const readOrigin = (input: string) =>
    parseComposerTags(input)
      .filter((part) => part.kind === 'mar_session_origin')
      .map((part) => part.payload);
  try {
    await node.executeNodeOperation('runner.profiles.list', {});
    const started = (await node.executeNodeOperation('session.start', {
      workspaceId: workspace.id,
      runner: 'codex',
      cwd: root,
      clientMessageId: 'first',
      content: 'Build feature',
      __marctlOrigin: origin
    })) as { session: { id: string }; run: { id: string } };
    await eventually(() => startTurn.mock.calls.length === 1);
    expect(readOrigin(startTurn.mock.calls[0]![1])).toEqual([origin]);
    expect(composerVisibleText(startTurn.mock.calls[0]![1])).toBe('Build feature');
    const firstMessage = node.runtime
      .conversationTurnForRun(started.run.id)!
      .items.find((item) => item.kind === 'user_message');
    expect(readOrigin((firstMessage!.payload as { text: string }).text)).toEqual([origin]);
    const queued = (await node.executeNodeOperation('session.message', {
      sessionId: started.session.id,
      clientMessageId: 'queued',
      content: 'Review after completion',
      deliveryIntent: 'QUEUE',
      __marctlOrigin: origin
    })) as { queueItemId: string; delivery: string };
    expect(queued.delivery).toBe('QUEUED');
    const queuedContent = node.runtime.getQueueItem(queued.queueItemId)!.content;
    expect(readOrigin(queuedContent)).toEqual([origin]);
    const replay = (await node.executeNodeOperation('session.message', {
      sessionId: started.session.id,
      clientMessageId: 'queued',
      content: 'changed retry',
      deliveryIntent: 'QUEUE',
      __marctlOrigin: { ...origin, name: 'Renamed after acceptance' }
    })) as { idempotent: boolean };
    expect(replay.idempotent).toBe(true);
    expect(node.runtime.getQueueItem(queued.queueItemId)!.content).toBe(queuedContent);
    expect(node.continuousRunCoordinator.pending(queued.queueItemId)?.restartMessage?.content).toBe(
      queuedContent
    );
    node.codexRunController.handleNotification({
      method: 'turn/completed',
      params: { threadId: 'thread-origin', turn: { id: 'turn-1', status: 'completed' } }
    });
    await eventually(() => startTurn.mock.calls.length === 2);
    expect(readOrigin(startTurn.mock.calls[1]![1])).toEqual([origin]);
    const steered = (await node.executeNodeOperation('session.message', {
      sessionId: started.session.id,
      clientMessageId: 'steered',
      content: 'Urgent context',
      deliveryIntent: 'REPLACE_CURRENT',
      __marctlOrigin: { ...origin, name: 'Fixer#42' }
    })) as { delivery: string };
    expect(steered.delivery).toBe('ACCEPTED');
    await eventually(() => startTurn.mock.calls.length === 3);
    const input = startTurn.mock.calls[2]![1];
    expect(readOrigin(input)).toEqual([{ ...origin, name: 'Fixer#42' }]);
    expect(parseComposerTags(input).some((part) => part.kind === 'mar_steer')).toBe(true);
    expect(composerVisibleText(input)).toBe('Urgent context');
  } finally {
    await connector.stop();
    await rm(root, { recursive: true, force: true });
  }
});

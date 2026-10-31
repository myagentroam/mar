import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Pool } from 'mysql2/promise';
import { describe, expect, it, vi } from 'vitest';
import { NodeConnector } from '../../mar-node/src/connector.js';
import { NodeDatabase } from '../../mar-node/src/database.js';
import type { NodeRuntimeState } from '../../mar-node/src/runtime-state.js';
import type { CodexAppServerClient } from '../../mar-node/src/codex-app-server.js';
import {
  capabilities,
  codexProfileClientFactory
} from '../../mar-node/test/unit/support/codex-connector.js';
import { registerMarctlSessionRoutes } from '../../packages/server-core/src/marctl-session-routes.js';
import { MarctlUserCredentials } from '../../packages/server-core/src/marctl-user-credentials.js';

// Each package resolves its own transport dependency; no shared dev services are used.
const Fastify = createRequire(join(__dirname, '../../packages/server-core/package.json'))(
  'fastify'
) as typeof import('../../packages/server-core/node_modules/fastify/fastify.js').default;
const { WebSocketServer } = createRequire(join(__dirname, '../../marctl/package.json'))(
  'ws'
) as typeof import('../../mar-node/node_modules/@types/ws/index.js');
const cliPath = join(__dirname, '../../marctl/bin/marctl.mjs');

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'marctl-agent-network-'));
  vi.stubEnv('HOME', directory);
  vi.stubEnv('USERPROFILE', directory);
  vi.stubEnv('CODEX_HOME', directory);
  const database = new NodeDatabase(':memory:', 'network-fixture');
  const workspace = database.saveWorkspace({
    path: directory,
    kind: 'DIRECTORY',
    gitSummary: null
  });
  let sequence = 0;
  const startTurn = vi.fn<CodexAppServerClient['startTurn']>(async () => ({
    turn: { id: `turn-${++sequence}` }
  }));
  const respond = vi.fn();
  let settleCancellation!: () => void;
  const cancellation = new Promise<void>((resolve) => {
    settleCancellation = resolve;
  });
  const interruptTurn = vi.fn(async () => cancellation);
  const client = {
    onNotification: () => () => undefined,
    start: async () => undefined,
    stop: () => undefined,
    configureEnvironment: () => undefined,
    clearEnvironment: () => undefined,
    startThread: async () => ({ thread: { id: 'thread-new' } }),
    resumeThread: async (threadId: string) => ({ thread: { id: threadId } }),
    startTurn,
    respond,
    interruptTurn
  } as unknown as CodexAppServerClient;
  const connector = new NodeConnector({
    reconnect: false,
    capabilities: capabilities(),
    database,
    codexClient: client,
    codexRunClientFactory: () => client,
    codexProfileClientFactory
  });
  const node = connector as unknown as {
    runtime: NodeRuntimeState;
    send(type: string, payload: unknown): void;
    executeNodeOperation(operation: string, input: unknown): Promise<unknown>;
    codexRunController: {
      handleNotification(notification: {
        method: string;
        requestId?: string;
        params: unknown;
      }): void;
    };
  };
  await node.executeNodeOperation('runner.profiles.list', { workspaceId: workspace.id });
  const coordinator = node.runtime.createAgentSession({
    workspaceId: workspace.id,
    runner: 'codex',
    externalSessionId: 'coordinator-thread',
    nativeControl: 'MAR_MANAGED',
    cwd: directory
  });
  const session = node.runtime.createAgentSession({
    workspaceId: workspace.id,
    runner: 'codex',
    externalSessionId: 'network-thread',
    nativeControl: 'MAR_MANAGED',
    parentSessionId: coordinator.id,
    cwd: directory
  });
  const credentials = new MarctlUserCredentials({
    execute: async () => [[{ id: 7, username: 'owner' }]]
  } as unknown as Pool);
  const token = credentials.issue(
    { userId: 7, sessionHash: 'a'.repeat(43) },
    { nodeId: 'node', workspaceId: workspace.id }
  );
  const app = Fastify();
  const sockets = new WebSocketServer({ server: app.server });
  sockets.on('connection', (socket) =>
    socket.on('message', () => {
      socket.send(
        JSON.stringify({ type: 'workbench.ready', workbenchConnectionId: 'network-connection' })
      );
    })
  );
  const send = vi.spyOn(node, 'send').mockImplementation((type, event) => {
    if (type !== 'watch.event') return;
    for (const socket of sockets.clients)
      if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'watch.event', event }));
  });
  registerMarctlSessionRoutes({
    app,
    credentials,
    publicOrigin: undefined,
    authorizedNode: async () => true,
    ownsWorkbenchConnection: (_hash, connectionId) => connectionId === 'network-connection',
    requestNode: async (_node, operation, data, user) =>
      node.executeNodeOperation(operation, {
        ...data,
        __requestUserId: user.userId,
        __marctlCaller: user.marctlCaller
      }),
    secrets: { resolve: async () => ({}) }
  });
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const command = async (...args: string[]) => {
    const result = await promisify(execFile)(
      process.execPath,
      [cliPath, 'agents', ...args, '--json'],
      {
        timeout: 10_000,
        env: {
          ...process.env,
          MAR_CTL_CONTEXT_REQUIRED: '1',
          MAR_CTL_SERVER_URL: origin,
          MAR_CTL_USER_TOKEN: token,
          MAR_CTL_SESSION_ID: coordinator.id
        }
      }
    ).catch((error: Error & { stdout?: string }) => {
      const output = error.stdout ? JSON.parse(error.stdout) : undefined;
      throw new Error(`CLI command failed: ${output?.error?.code ?? error.message}`);
    });
    expect(result.stderr).toBe('');
    return JSON.parse(result.stdout);
  };
  const finish = (turnId: string, status = 'completed') =>
    node.codexRunController.handleNotification({
      method: 'turn/completed',
      params: { threadId: 'network-thread', turn: { id: turnId, status } }
    });
  return {
    node,
    session,
    startTurn,
    respond,
    interruptTurn,
    settleCancellation,
    command,
    finish,
    send,
    close: async () => {
      settleCancellation();
      send.mockRestore();
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await app.close();
      await connector.stop();
      await rm(directory, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  };
}

describe('marctl Agent network over isolated CLI, HTTP and Node', () => {
  it('sets persistent instructions and reads their latest value when queued input executes', async () => {
    const h = await fixture();
    try {
      expect(await h.command('prompt', 'set', h.session.id, '-m', 'Initial rule')).toEqual({
        sessionId: h.session.id,
        sessionPrompt: 'Initial rule'
      });
      const first = await h.command('send', h.session.id, '--queue', '-m', 'First input');
      expect(first.message.status).toBe('accepted');
      const firstRunId = first.message.result.run.id;
      await vi.waitFor(() => expect(h.startTurn).toHaveBeenCalledTimes(1));
      expect(h.startTurn.mock.calls[0]?.[3]).toMatchObject({
        developerInstructions: 'Initial rule'
      });
      const second = await h.command('send', h.session.id, '--queue', '-m', 'Queued input');
      expect(second.message).toMatchObject({ status: 'accepted', result: { delivery: 'QUEUED' } });
      await h.command('prompt', 'set', h.session.id, '-m', 'Updated rule');
      expect(h.interruptTurn).not.toHaveBeenCalled();
      h.finish('turn-1');
      await vi.waitFor(() => expect(h.startTurn).toHaveBeenCalledTimes(2));
      expect(h.startTurn.mock.calls[1]?.[1]).toBe('Queued input');
      expect(h.startTurn.mock.calls[1]?.[1]).not.toContain('<mar_session_origin');
      expect(h.startTurn.mock.calls[1]?.[3]).toMatchObject({
        developerInstructions: 'Updated rule'
      });
      h.finish('turn-2');
      expect(
        (await h.command('wait', h.session.id, '--run', firstRunId, '--timeout', '2s')).run.status
      ).toBe('SUCCEEDED');
      expect(await h.command('prompt', 'clear', h.session.id)).toEqual({
        sessionId: h.session.id,
        sessionPrompt: null
      });
    } finally {
      await h.close();
    }
  });

  it('observes and decides one native approval with public Run identity, then waits for completion', async () => {
    const h = await fixture();
    try {
      const sent = await h.command('send', h.session.id, '--queue', '-m', 'Review request');
      expect(sent.message.status).toBe('accepted');
      const sentRunId = sent.message.result.run.id;
      await vi.waitFor(() => expect(h.startTurn).toHaveBeenCalledOnce());
      const waiting = h.command(
        'wait',
        h.session.id,
        '--run',
        sentRunId,
        '--until',
        'approval',
        '--timeout',
        '3s'
      );
      await vi.waitFor(() =>
        expect(h.send.mock.calls.some((call) => call[0] === 'watch.event')).toBe(true)
      );
      h.node.codexRunController.handleNotification({
        method: 'item/commandExecution/requestApproval',
        requestId: 'native-request',
        params: { threadId: 'network-thread', turnId: 'turn-1', command: 'private raw command' }
      });
      const blocked = await waiting;
      expect(blocked.stopReason).toBe('APPROVAL_REQUIRED');
      expect(blocked.pendingApprovals).toHaveLength(1);
      const approval = blocked.pendingApprovals[0];
      expect(approval.runId).toBe(sentRunId);
      expect(approval.approvalId).toContain('native-request');
      expect(JSON.stringify(blocked)).not.toContain('private raw command');
      expect((await h.command('show', h.session.id)).session.pendingApprovals).toEqual(
        blocked.pendingApprovals
      );
      expect(
        await h.command(
          'approval',
          'decide',
          h.session.id,
          '--run',
          sentRunId,
          '--approval',
          approval.approvalId,
          '--decision',
          'approve'
        )
      ).toMatchObject({ runId: sentRunId, decision: 'APPROVED' });
      expect(h.respond).toHaveBeenCalledExactlyOnceWith('native-request', { decision: 'accept' });
      expect((await h.command('show', h.session.id)).session.pendingApprovals).toEqual([]);
      const completed = h.command('wait', h.session.id, '--run', sentRunId, '--timeout', '3s');
      await vi.waitFor(() =>
        expect(
          h.send.mock.calls.filter((call) => call[0] === 'watch.event').length
        ).toBeGreaterThan(2)
      );
      h.finish('turn-1');
      expect((await completed).run.status).toBe('SUCCEEDED');
    } finally {
      await h.close();
    }
  });

  it.each([false, true])(
    'resumes queued work after cancellation (explicit resume: %s) without duplicates',
    async (explicitResume) => {
      const h = await fixture();
      try {
        const initial = await h.command('send', h.session.id, '--queue', '-m', 'Running input');
        expect(initial.message.status).toBe('accepted');
        const initialRunId = initial.message.result.run.id;
        await vi.waitFor(() => expect(h.startTurn).toHaveBeenCalledOnce());
        await h.command('send', h.session.id, '--queue', '-m', 'Old first');
        await h.command('send', h.session.id, '--queue', '-m', 'Old second');
        const executionId = h.node.runtime.currentExecutionId(initialRunId);
        expect(executionId).toBeDefined();
        await h.command('stop', h.session.id);
        expect(h.node.runtime.activeSessionRun(h.session.id)?.status).toBe('CANCELLING');
        if (explicitResume)
          await h.node.executeNodeOperation('workspace.queue.resume', {
            sessionId: h.session.id,
            workspaceId: h.session.workspaceId,
            __requestUserId: 7
          });
        const receipt = await h.command(
          'send',
          h.session.id,
          '--queue',
          '-m',
          'Recover now',
          '--client-message-id',
          'recovery'
        );
        expect(receipt.message).toMatchObject({
          status: 'accepted',
          result: { delivery: 'QUEUED' }
        });
        const duplicate = await h.command(
          'send',
          h.session.id,
          '--queue',
          '-m',
          'Recover now',
          '--client-message-id',
          'recovery'
        );
        expect(duplicate.message.result.queueItemId).toBe(receipt.message.result.queueItemId);
        expect(h.startTurn).toHaveBeenCalledOnce();
        h.settleCancellation();
        const expected = explicitResume
          ? ['Old first', 'Old second', 'Recover now']
          : ['Recover now', 'Old first', 'Old second'];
        for (const [index, content] of expected.entries()) {
          await vi.waitFor(() => expect(h.startTurn).toHaveBeenCalledTimes(index + 2));
          if (index === 0)
            expect(h.node.runtime.activeSessionRun(h.session.id)?.id).not.toBe(initialRunId);
          expect(h.startTurn.mock.calls[index + 1]?.[1]).toBe(content);
          h.finish('turn-' + (index + 2));
        }
        expect(h.node.runtime.sessionQueue(h.session.id).itemIds).toEqual([]);
      } finally {
        await h.close();
      }
    }
  );
});

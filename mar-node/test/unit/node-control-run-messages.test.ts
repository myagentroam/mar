import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEnvelope, type NodeEnvelope } from '@myagentroam/protocol';
import { describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { NodeConnector } from '../../src/connector.js';
import { NodeDatabase } from '../../src/database.js';
import { FakeRunner } from '../../src/fake-runner.js';
import type { NodeRuntimeState } from '../../src/runtime-state.js';
import type { NodeControlChannel } from '../../src/service/node-control-channel.js';

describe('Node control Run message lifecycle', () => {
  it('rejects retired messages without changing active Runs, including after reconnect', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mar-control-runs-'));
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('ADDRESS_INVALID');
    const controls: WebSocket[] = [];
    const sent: NodeEnvelope[] = [];
    server.on('connection', (socket, request) => {
      if (request.url !== '/api/node/connect') return;
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as NodeEnvelope;
        sent.push(message);
        if (message.type === 'authenticate') {
          controls.push(socket);
          socket.send(JSON.stringify(createEnvelope('authenticated', {})));
        }
      });
    });
    const database = new NodeDatabase(':memory:', 'node-control-runs');
    const workspace = database.saveWorkspace({
      path: directory,
      kind: 'DIRECTORY',
      gitSummary: null
    });
    const connector = new NodeConnector({
      reconnect: true,
      database,
      config: {
        serverUrl: `http://127.0.0.1:${address.port}`,
        allowedRoots: [directory],
        nodeId: 'node-control-runs',
        credential: 'fixture'
      },
      fakeRunner: new FakeRunner(),
      fakeScript: (input) =>
        input === 'finish' ? [{ type: 'success' }] : [{ type: 'long-running' }]
    });
    const internal = connector as unknown as {
      runtime: NodeRuntimeState;
      controlChannel: NodeControlChannel;
      handleMessage(raw: string): void;
    };
    const receive = async (type: string, payload: unknown) => {
      const envelope = createEnvelope(type, payload);
      controls.at(-1)!.send(JSON.stringify(envelope));
      await vi.waitFor(() =>
        expect(sent.some((message) => message.replyTo === envelope.id)).toBe(true)
      );
      return envelope.id;
    };
    try {
      internal.controlChannel.connect();
      await vi.waitFor(() => expect(controls).toHaveLength(1));
      const startId = await receive('run.start', {
        runId: 'active-run',
        sessionId: 'session-control',
        workspaceId: workspace.id,
        runner: 'codex',
        cwd: directory,
        input: 'wait'
      });
      await vi.waitFor(() => expect(internal.runtime.getRun('active-run')?.status).toBe('RUNNING'));
      expect(sent.filter((message) => message.replyTo === startId)).toMatchObject([
        { type: 'ack', payload: { type: 'run.start' } }
      ]);
      const before = structuredClone(internal.runtime.getRun('active-run'));
      const session = structuredClone(internal.runtime.getAgentSession('session-control'));
      for (const connected of [false, true]) {
        if (connected) {
          const closed = once(controls[0]!, 'close');
          controls[0]!.close(1001, 'fixture disconnect');
          await closed;
          expect(internal.runtime.getRun('active-run')).toEqual(before);
          await vi.waitFor(() => expect(controls).toHaveLength(2), { timeout: 5000 });
        }
        for (const [type, payload] of [
          ['runs.reconcile', { runIds: ['active-run', 'unknown-run'] }],
          ['runs.reconcile', { runIds: [123] }],
          ['lease.reconcile', { runId: 'active-run', known: false }],
          ['lease.reconcile', { runId: 'unknown-run', known: true }],
          ['lease.reconcile', {}],
          ['unknown.control.message', {}]
        ] as const) {
          const id = await receive(type, payload);
          expect(sent.filter((message) => message.replyTo === id)).toMatchObject([
            { type: 'error', payload: { code: 'MESSAGE_TYPE_UNKNOWN' } }
          ]);
          expect(internal.runtime.getRun('active-run')).toEqual(before);
          expect(internal.runtime.getRun('unknown-run')).toBeUndefined();
          expect(internal.runtime.getAgentSession('session-control')).toEqual(session);
          expect(internal.runtime.activeSessionRun('session-control')).toEqual(before);
          expect(internal.runtime.activeWorkspaceLeaseCount()).toBe(1);
        }
      }
      expect(sent.some((message) => message.type === 'lease.reconcile')).toBe(false);
      const interruptId = await receive('run.interrupt', { runId: 'active-run' });
      expect(sent.filter((message) => message.replyTo === interruptId)).toMatchObject([
        { type: 'ack', payload: { type: 'run.interrupt' } }
      ]);
      await vi.waitFor(() =>
        expect(internal.runtime.hasActiveSessionLease('session-control')).toBe(false)
      );
      expect(
        internal.runtime.listRunsForSession('session-control', { includeTerminal: true })[0]?.status
      ).toBe('INTERRUPTED');
      await receive('run.start', {
        runId: 'next-run',
        sessionId: 'session-control',
        workspaceId: workspace.id,
        runner: 'codex',
        cwd: directory,
        input: 'finish'
      });
      await vi.waitFor(() =>
        expect(
          internal.runtime
            .listRunsForSession('session-control', { includeTerminal: true })
            .some((run) => run.id === 'next-run' && run.status === 'SUCCEEDED')
        ).toBe(true)
      );
      expect(internal.runtime.activeWorkspaceLeaseCount()).toBe(0);
      const closed = once(controls.at(-1)!, 'close');
      controls.at(-1)!.send('{');
      const [code, reason] = await closed;
      expect(code).toBe(4002);
      expect(reason.toString()).toBe('MESSAGE_INVALID');
    } finally {
      internal.handleMessage(JSON.stringify(createEnvelope('run.cancel', { runId: 'active-run' })));
      await connector.stop();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
      await rm(directory, { recursive: true, force: true });
    }
  });
});

import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEnvelope, type NodeEnvelope } from '@myagentroam/protocol';
import { describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { NodeConnector } from '../../src/connector.js';
import { NodeDatabase } from '../../src/database.js';
import { NodeRuntimeState } from '../../src/runtime-state.js';
import type { NodeControlChannel } from '../../src/service/node-control-channel.js';
import type { NotificationMcpBridge } from '../../src/service/notification-mcp-bridge.js';

function invoke(endpoint: string, token: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint);
    let body = '';
    socket.setEncoding('utf8');
    socket.once('connect', () =>
      socket.write(
        `${JSON.stringify({
          token,
          tool: 'send_email_notification',
          arguments: { message: 'Isolated fixture, never real email', callId: randomUUID() }
        })}\n`
      )
    );
    socket.on('data', (chunk) => {
      body += chunk;
    });
    socket.once('error', reject);
    socket.once('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
  });
}

describe('notification capability across control reconnection', () => {
  it('keeps the same credential usable without replaying uncertain sends or reviving released authorization', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mar-notification-reconnect-'));
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('ADDRESS_INVALID');
    const controls: WebSocket[] = [];
    const sends: NodeEnvelope[] = [];
    let resume = false;
    let holdResponse = false;
    server.on('connection', (socket, request) => {
      if (request.url !== '/api/node/connect') return;
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as NodeEnvelope;
        if (message.type === 'authenticate') {
          controls.push(socket);
          if (controls.length === 1 || resume)
            socket.send(JSON.stringify(createEnvelope('authenticated', {})));
        }
        if (message.type === 'mail.notification.send') {
          sends.push(message);
          if (!holdResponse)
            socket.send(
              JSON.stringify(
                createEnvelope(
                  'mail.notification.response',
                  { accepted: true },
                  { replyTo: message.id }
                )
              )
            );
        }
      });
    });
    const database = new NodeDatabase(':memory:', 'node-notification-reconnect');
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
        nodeId: 'node-notification-reconnect',
        credential: 'fixture'
      }
    });
    const internal = connector as unknown as {
      runtime: NodeRuntimeState;
      controlChannel: NodeControlChannel;
      notificationMcpBridge: NotificationMcpBridge;
    };
    const session = internal.runtime.createAgentSession({
      workspaceId: workspace.id,
      runner: 'mar-agent',
      cwd: directory
    });
    const run = internal.runtime.createMessageRun({
      sessionId: session.id,
      clientMessageId: 'fixture',
      content: 'Work',
      initiatedByUserId: 7
    }).run;
    const execution = internal.runtime.createExecution(run.id);
    try {
      internal.controlChannel.connect();
      await vi.waitFor(() => expect(internal.controlChannel.connected()).toBe(true));
      const descriptor = await internal.notificationMcpBridge.prepare({
        executionId: execution.id,
        sessionId: session.id,
        workspaceId: workspace.id,
        userId: 7,
        source: 'MANUAL'
      });
      const endpoint = descriptor.environment!.MAR_NOTIFICATION_MCP_ENDPOINT!;
      const token = descriptor.environment!.MAR_NOTIFICATION_MCP_TOKEN!;
      expect(await invoke(endpoint, token)).toEqual({ result: { accepted: true } });
      expect(sends).toHaveLength(1);

      controls[0]!.close(1001, 'fixture Server restart');
      await vi.waitFor(() => expect(internal.controlChannel.connected()).toBe(false));
      expect(await invoke(endpoint, token)).toEqual({ error: 'MAIL_SERVER_UNAVAILABLE' });
      expect(sends).toHaveLength(1);
      await vi.waitFor(() => expect(controls).toHaveLength(2), { timeout: 5000 });
      resume = true;
      controls[1]!.send(JSON.stringify(createEnvelope('authenticated', {})));
      await vi.waitFor(() => expect(internal.controlChannel.connected()).toBe(true));
      expect(await invoke(endpoint, token)).toEqual({ result: { accepted: true } });
      expect(sends).toHaveLength(2);

      holdResponse = true;
      const uncertain = invoke(endpoint, token);
      await vi.waitFor(() => expect(sends).toHaveLength(3));
      controls[1]!.close(1001, 'fixture in-flight disconnect');
      expect(await uncertain).toEqual({ error: 'MAIL_DELIVERY_UNCERTAIN' });
      await vi.waitFor(() => expect(controls).toHaveLength(3), { timeout: 5000 });
      await vi.waitFor(() => expect(internal.controlChannel.connected()).toBe(true));
      expect(sends).toHaveLength(3);

      internal.runtime.revokeExecutionMcps(execution.id);
      expect(await invoke(endpoint, token)).toEqual({ error: 'MAIL_CAPABILITY_STALE' });
      expect(sends).toHaveLength(3);
    } finally {
      internal.runtime.finishRun(run.id, 'INTERRUPTED');
      await connector.stop();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
      await rm(directory, { recursive: true, force: true });
    }
  });
});

import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it, vi } from 'vitest';
import { ScheduleMcpBridge } from '../../src/service/schedule-mcp-bridge.js';

async function usingIpcClient(
  handle: (socket: Socket) => void,
  verify: (client: Client) => Promise<void>
) {
  const directory = await mkdtemp(join(tmpdir(), 'mar-schedule-response-'));
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\mar-schedule-response-${randomUUID()}`
      : join(directory, 'response.sock');
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    handle(socket);
  });
  server.listen(endpoint);
  await once(server, 'listening');
  const bridge = new ScheduleMcpBridge(
    () => {
      throw new Error('UNEXPECTED_STORE_ACCESS');
    },
    () => undefined,
    () => undefined,
    (scope) => scope.sessionId
  );
  const client = new Client({ name: 'schedule-response-fixture', version: '1' });
  try {
    const descriptor = await bridge.prepare({
      executionId: 'fixture',
      sessionId: 'fixture',
      actorUserId: 7
    });
    await client.connect(
      new StdioClientTransport({
        command: descriptor.command!,
        args: [...(descriptor.args ?? [])],
        env: { ...descriptor.environment, MAR_SCHEDULE_MCP_ENDPOINT: endpoint }
      })
    );
    await verify(client);
  } finally {
    await client.close();
    await bridge.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    await rm(directory, { recursive: true, force: true });
  }
}

interface IpcRequest {
  token: string;
  tool: string;
  arguments: Record<string, unknown>;
}

function receive(socket: Socket, handle: (request: IpcRequest) => void): void {
  let body = '';
  socket.setEncoding('utf8');
  const listener = (chunk: string) => {
    body += chunk;
    if (!body.includes('\n')) return;
    socket.off('data', listener);
    handle(JSON.parse(body.slice(0, body.indexOf('\n'))) as IpcRequest);
  };
  socket.on('data', listener);
}

it('does not expose a renewal credential in malformed IPC response diagnostics', async () => {
  const secret = 'private-renewal-fixture-never-model-visible';
  await usingIpcClient(
    (socket) => receive(socket, () => socket.end(`{"token":"${secret}",`)),
    async (client) => {
      const result = await client.callTool({ name: 'get_scheduled_task', arguments: {} });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain('SCHEDULE_IPC_RESPONSE_INVALID');
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain('"token"');
    }
  );
});

it('skips cancelled queued calls and dispatches the next call with the renewed credential', async () => {
  const requests: IpcRequest[] = [];
  let firstSocket!: Socket;
  let arrived!: () => void;
  const firstArrived = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  await usingIpcClient(
    (socket) =>
      receive(socket, (request) => {
        requests.push(request);
        if (requests.length === 1) {
          firstSocket = socket;
          arrived();
        } else socket.end(`${JSON.stringify({ result: { ready: true } })}\n`);
      }),
    async (client) => {
      const first = client.callTool({
        name: 'update_scheduled_task',
        arguments: { objective: 'first' }
      });
      await firstArrived;
      const abort = new AbortController();
      const cancelled = client
        .callTool(
          { name: 'update_scheduled_task', arguments: { objective: 'cancelled' } },
          undefined,
          { signal: abort.signal }
        )
        .catch((error: unknown) => error);
      await client.ping();
      abort.abort();
      await cancelled;
      await client.ping();
      expect(requests).toHaveLength(1);
      firstSocket.end(`${JSON.stringify({ result: { revision: 2 }, token: 'renewed-fixture' })}\n`);
      expect((await first).isError).not.toBe(true);
      const result = await client.callTool({ name: 'get_scheduled_task', arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(requests).toHaveLength(2);
      expect(requests[1]!.token).toBe('renewed-fixture');
      expect(requests[1]!.tool).toBe('get_scheduled_task');
      expect(JSON.stringify(result)).not.toContain('renewed-fixture');
    }
  );
});

it('releases the client queue after a failed call without replaying it', async () => {
  const requests: IpcRequest[] = [];
  let firstSocket!: Socket;
  let arrived!: () => void;
  const firstArrived = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  await usingIpcClient(
    (socket) =>
      receive(socket, (request) => {
        requests.push(request);
        if (requests.length === 1) {
          firstSocket = socket;
          arrived();
        } else socket.end(`${JSON.stringify({ result: null })}\n`);
      }),
    async (client) => {
      const first = client.callTool({
        name: 'update_scheduled_task',
        arguments: { objective: 'missing' }
      });
      await firstArrived;
      const next = client.callTool({ name: 'get_scheduled_task', arguments: {} });
      await client.ping();
      expect(requests).toHaveLength(1);
      firstSocket.end(`${JSON.stringify({ error: 'SCHEDULE_NOT_FOUND' })}\n`);
      const results = await Promise.all([first, next]);
      expect(results[0]!.isError).toBe(true);
      expect(results[1]!.isError).not.toBe(true);
      expect(requests.map((request) => request.tool)).toEqual([
        'update_scheduled_task',
        'get_scheduled_task'
      ]);
    }
  );
});

it('aborts in-flight IPC without replaying the write or blocking later calls', async () => {
  const requests: IpcRequest[] = [];
  let arrived!: () => void;
  const firstArrived = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  await usingIpcClient(
    (socket) =>
      receive(socket, (request) => {
        requests.push(request);
        if (requests.length === 1) arrived();
        else socket.end(`${JSON.stringify({ result: null })}\n`);
      }),
    async (client) => {
      const abort = new AbortController();
      const first = client
        .callTool(
          { name: 'update_scheduled_task', arguments: { objective: 'uncertain' } },
          undefined,
          { signal: abort.signal }
        )
        .catch((error: unknown) => error);
      await firstArrived;
      abort.abort();
      await first;
      await client.ping();
      const next = client
        .callTool({ name: 'get_scheduled_task', arguments: {} })
        .catch((error: unknown) => ({ isError: true, error }));
      // A state assertion bounds a missing abort handoff; it does not release the held reply.
      await vi.waitFor(() => expect(requests).toHaveLength(2));
      expect((await next).isError).not.toBe(true);
      expect(requests.map((request) => request.tool)).toEqual([
        'update_scheduled_task',
        'get_scheduled_task'
      ]);
    }
  );
});

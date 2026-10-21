import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  MCP_CATALOG_LIMITS,
  MarAgentMcpClientPool
} from '../../src/runner/mar-agent/mcp-client-pool.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function fixture(
  options: {
    readonly initialNotification?: boolean;
    readonly heldLists?: readonly number[];
    readonly failedLists?: readonly number[];
  } = {}
) {
  const sseReady = deferred<void>();
  const listStarted = Array.from({ length: 16 }, () => deferred<void>());
  const listFinished = Array.from({ length: 16 }, () => deferred<void>());
  const abortedList = deferred<void>();
  const gates = new Map((options.heldLists ?? []).map((count) => [count, deferred<void>()]));
  const held = new Set(options.heldLists ?? []);
  const failed = new Set(options.failedLists ?? []);
  let sseResponse: ServerResponse | undefined;
  let listCount = 0;

  const notify = async () => {
    if (!sseResponse) throw new Error('MCP SSE stream is not connected.');
    await new Promise<void>((resolve, reject) => {
      sseResponse!.write(
        `event: message\ndata: ${JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/tools/list_changed',
          params: {}
        })}\n\n`,
        (error) => (error ? reject(error) : resolve())
      );
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
  };

  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === 'GET') {
        response.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        });
        response.write(': connected\n\n');
        sseResponse = response;
        sseReady.resolve();
        response.on('close', () => {
          if (sseResponse === response) sseResponse = undefined;
        });
        return;
      }
      if (request.method !== 'POST') {
        response.writeHead(405).end();
        return;
      }
      let body = '';
      for await (const chunk of request) body += String(chunk);
      const message = JSON.parse(body) as {
        id?: number | string;
        method: string;
        params?: { protocolVersion?: string };
      };
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      if (message.method === 'initialize') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: message.params?.protocolVersion,
              capabilities: { tools: { listChanged: true } },
              serverInfo: { name: 'notification-fixture', version: '1' }
            }
          })
        );
        return;
      }
      if (message.method !== 'tools/list') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
        return;
      }

      const count = ++listCount;
      listStarted[count - 1]?.resolve();
      response.on('close', () => {
        if (!response.writableEnded) abortedList.resolve();
      });
      if (count === 1 && options.initialNotification) {
        await sseReady.promise;
        await notify();
      }
      if (held.has(count)) await gates.get(count)!.promise;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      if (failed.has(count)) {
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32000, message: 'Fixture catalog refresh failed.' }
          }),
          () => listFinished[count - 1]?.resolve()
        );
        return;
      }
      response.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            tools: [
              {
                name: 'lookup',
                description: `Catalog generation ${count}`,
                inputSchema: { type: 'object', properties: {} }
              }
            ]
          }
        }),
        () => listFinished[count - 1]?.resolve()
      );
    })().catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(500);
      response.end(error instanceof Error ? error.message : 'Fixture failed.');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture address unavailable.');

  return {
    server: {
      name: 'notification',
      transport: 'HTTP' as const,
      url: `http://127.0.0.1:${address.port}/mcp`
    },
    listCount: () => listCount,
    waitForList: (count: number) => listStarted[count - 1]!.promise,
    waitForListResponse: (count: number) => listFinished[count - 1]!.promise,
    waitForAbortedList: () => abortedList.promise,
    notify,
    releaseList: (count: number) => gates.get(count)?.resolve(),
    close: async () => {
      for (const gate of gates.values()) gate.resolve();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

async function temporaryDirectory() {
  return mkdtemp(join(tmpdir(), 'mar-mcp-notification-'));
}

describe('MCP catalog notifications', () => {
  it('waits for initial notification convergence at the first execution boundary', async () => {
    const cwd = await temporaryDirectory();
    const f = await fixture({ initialNotification: true, heldLists: [2] });
    let pool: MarAgentMcpClientPool | undefined;
    try {
      pool = await MarAgentMcpClientPool.connect([f.server], cwd);
      await f.waitForList(2);
      let settled = false;
      const boundary = pool.refreshForExecution().then(() => {
        settled = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      f.releaseList(2);
      await boundary;
      expect(pool.catalog().tools[0]?.definition.description).toBe('Catalog generation 2');
    } finally {
      await pool?.close();
      await f.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('catches initial and follow-up notifications, merges an in-flight burst, and converges', async () => {
    const cwd = await temporaryDirectory();
    const f = await fixture({ initialNotification: true, heldLists: [2, 3] });
    let pool: MarAgentMcpClientPool | undefined;
    try {
      pool = await MarAgentMcpClientPool.connect([f.server], cwd);
      await f.waitForList(2);
      await f.notify();
      await f.notify();
      f.releaseList(2);

      await f.waitForList(3);
      await f.notify();
      f.releaseList(3);

      await f.waitForList(4);
      await vi.waitFor(() =>
        expect(pool!.catalog().tools[0]?.definition.description).toBe('Catalog generation 4')
      );
      expect(f.listCount()).toBe(4);
    } finally {
      await pool?.close();
      await f.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('retains the last good catalog during retry backoff and refreshes after it expires', async () => {
    const cwd = await temporaryDirectory();
    const f = await fixture({ heldLists: [2], failedLists: [2] });
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    let pool: MarAgentMcpClientPool | undefined;
    try {
      pool = await MarAgentMcpClientPool.connect([f.server], cwd);
      const before = pool.catalog();
      await f.notify();
      await f.waitForList(2);
      await f.notify();
      f.releaseList(2);
      await f.waitForListResponse(2);
      await new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));

      await f.notify();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.listCount()).toBe(2);
      expect(pool.catalog()).toEqual(before);

      clock.mockImplementation(() => now + MCP_CATALOG_LIMITS.retryMs + 1);
      await f.notify();
      await f.waitForList(3);
      await vi.waitFor(() =>
        expect(pool!.catalog().tools[0]?.definition.description).toBe('Catalog generation 3')
      );
      expect(f.listCount()).toBe(3);
    } finally {
      clock.mockRestore();
      await pool?.close();
      await f.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('aborts a pending refresh and closes its HTTP response when the pool closes', async () => {
    const cwd = await temporaryDirectory();
    const f = await fixture({ heldLists: [2] });
    let pool: MarAgentMcpClientPool | undefined;
    try {
      pool = await MarAgentMcpClientPool.connect([f.server], cwd);
      await f.notify();
      await f.waitForList(2);
      await pool.close();
      await f.waitForAbortedList();
      expect(f.listCount()).toBe(2);
      expect(pool.catalog()).toMatchObject({ servers: [], tools: [] });
    } finally {
      await pool?.close();
      await f.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

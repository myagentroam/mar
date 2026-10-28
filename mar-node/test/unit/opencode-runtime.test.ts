import { describe, expect, it, vi } from 'vitest';
import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';
import { createServer, type ServerResponse } from 'node:http';
import { OpenCodeServerClient } from '../../src/runner/opencode/opencode-server.js';
import {
  openCodeContextLimits,
  openCodeProfileModels,
  probeOpenCode
} from '../../src/opencode-runtime.js';

describe('OpenCode runtime', () => {
  it('waits for actual SSE response headers before announcing readiness and exposes clean EOF', async () => {
    const response = Promise.withResolvers<ServerResponse>();
    const server = createServer((_request, reply) => response.resolve(reply));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('Missing test server address');
    const ready = vi.fn();
    const event = vi.fn();
    const client = new OpenCodeServerClient();
    Object.assign(client, {
      client: createOpencodeClient({ baseUrl: `http://127.0.0.1:${address.port}` })
    });
    const abort = new AbortController();
    const subscription = client.subscribe('/workspace', abort.signal, event, ready);
    try {
      const reply = await response.promise;
      expect(ready).not.toHaveBeenCalled();
      reply.writeHead(200, { 'content-type': 'text/event-stream' });
      reply.end('data: {"type":"server.connected"}\n\n');
      await subscription;
      expect(ready).toHaveBeenCalledOnce();
      expect(event).toHaveBeenCalledExactlyOnceWith({ type: 'server.connected' });
    } finally {
      abort.abort();
      await subscription.catch(() => undefined);
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it('rejects failed SSE establishment instead of retrying silently or reporting ready', async () => {
    const fetchRequest = vi.fn(async () => new Response('unavailable', { status: 503 }));
    vi.stubGlobal('fetch', fetchRequest);
    const ready = vi.fn();
    const client = new OpenCodeServerClient();
    Object.assign(client, { client: createOpencodeClient({ baseUrl: 'http://opencode.test' }) });
    try {
      await expect(
        client.subscribe('/workspace', new AbortController().signal, vi.fn(), ready)
      ).rejects.toThrow('503');
      expect(ready).not.toHaveBeenCalled();
      expect(fetchRequest).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('bounds SSE establishment without silently retrying', async () => {
    vi.useFakeTimers();
    const schedule = vi.spyOn(globalThis, 'setTimeout');
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    const fetchRequest = vi.fn(
      async (request: Request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason), {
            once: true
          });
        })
    );
    vi.stubGlobal('fetch', fetchRequest);
    const client = new OpenCodeServerClient({ startTimeoutMs: 100 });
    Object.assign(client, { client: createOpencodeClient({ baseUrl: 'http://opencode.test' }) });
    try {
      const subscription = client.subscribe('/workspace', new AbortController().signal, vi.fn());
      const failed = expect(subscription).rejects.toThrow('OPENCODE_EVENT_CONNECT_TIMEOUT');
      await vi.advanceTimersByTimeAsync(100);
      await failed;
      expect(fetchRequest).toHaveBeenCalledOnce();
      const deadline = schedule.mock.calls.findIndex(([, delay]) => delay === 100);
      expect(deadline).toBeGreaterThanOrEqual(0);
      expect(clear).toHaveBeenCalledWith(schedule.mock.results[deadline]?.value);
    } finally {
      schedule.mockRestore();
      clear.mockRestore();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('keeps an established SSE stream alive beyond the connection deadline and closes on abort', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(new ReadableStream(), {
            headers: { 'content-type': 'text/event-stream' }
          })
      )
    );
    const client = new OpenCodeServerClient({ startTimeoutMs: 100 });
    Object.assign(client, { client: createOpencodeClient({ baseUrl: 'http://opencode.test' }) });
    const ready = vi.fn();
    const abort = new AbortController();
    const done = vi.fn();
    const subscription = client.subscribe('/workspace', abort.signal, vi.fn(), ready).then(done);
    try {
      await vi.advanceTimersByTimeAsync(101);
      expect(ready).toHaveBeenCalledOnce();
      expect(done).not.toHaveBeenCalled();
      abort.abort();
      await subscription;
      expect(done).toHaveBeenCalledOnce();
    } finally {
      abort.abort();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('paginates recovery messages back to the current Run boundary without replaying the full session', async () => {
    const message = (id: string, created: number) => ({
      info: { id, time: { created } },
      parts: []
    });
    const messages = vi
      .fn()
      .mockResolvedValueOnce({
        data: [message('latest', 30)],
        response: new Response(null, { headers: { 'x-next-cursor': 'page-2' } })
      })
      .mockResolvedValueOnce({
        data: [message('old', 5), message('current', 20)],
        response: new Response(null, { headers: { 'x-next-cursor': 'page-3' } })
      });
    const client = new OpenCodeServerClient();
    Object.assign(client, { client: { session: { messages } } });
    const signal = new AbortController().signal;
    await expect(
      client.messages('/workspace', 'session-1', 100, { since: 10, signal })
    ).resolves.toEqual([message('old', 5), message('current', 20), message('latest', 30)]);
    expect(messages).toHaveBeenCalledTimes(2);
    expect(messages).toHaveBeenLastCalledWith(
      { directory: '/workspace', sessionID: 'session-1', limit: 100, before: 'page-2' },
      { signal }
    );
  });

  it('appends session-level personal instructions through the official Prompt system field', async () => {
    const promptAsync = vi.fn(async () => ({ data: {} }));
    const client = new OpenCodeServerClient();
    Object.assign(client, { client: { session: { promptAsync } } });

    await client.prompt({
      directory: '/workspace',
      sessionID: 'session-1',
      text: 'hello',
      model: 'provider/model',
      system: 'inspect the tests before execution'
    });

    expect(promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({ system: 'inspect the tests before execution' })
    );
  });

  it('injects MCP through the dynamic interface without modifying Workspace configuration', async () => {
    const add = vi.fn(async () => ({ data: {} }));
    const update = vi.fn(async () => ({ data: {} }));
    const client = new OpenCodeServerClient();
    Object.assign(client, { client: { mcp: { add }, config: { update } } });

    await client.configureMcp('/workspace', {
      browser: { type: 'local', command: ['playwright-mcp', '--headless'] }
    });

    expect(add).toHaveBeenCalledWith({
      directory: '/workspace',
      name: 'browser',
      config: { type: 'local', command: ['playwright-mcp', '--headless'] }
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('uses session.fork with session, Workspace, and message-boundary parameters', async () => {
    const fork = vi.fn(async () => ({ data: { id: 'forked-session' } }));
    const client = new OpenCodeServerClient();
    Object.assign(client, { client: { session: { fork } } });
    await expect(client.forkSession('/workspace', 'source-session', 'message-2')).resolves.toEqual({
      id: 'forked-session'
    });
    expect(fork).toHaveBeenCalledWith({
      directory: '/workspace',
      sessionID: 'source-session',
      messageID: 'message-2'
    });
  });

  it('reuses one Server startup across concurrent requests', async () => {
    const client = new OpenCodeServerClient();
    const startServer = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    Object.assign(client, { startServer });

    await Promise.all([client.start(), client.start(), client.start()]);

    expect(startServer).toHaveBeenCalledOnce();
  });

  it('exposes only connected Provider models and preserves variant', () => {
    expect(
      openCodeProfileModels({
        connected: ['custom', 'opencode'],
        default: { custom: 'coder' },
        all: [
          {
            id: 'custom',
            name: 'Custom Gateway',
            source: 'config',
            models: {
              coder: {
                id: 'coder',
                name: 'Coder',
                limit: { context: 200_000 },
                variants: { low: {}, high: {}, disabled: { disabled: true } }
              }
            }
          },
          {
            id: 'opencode',
            name: 'OpenCode Zen',
            source: 'custom',
            models: { gateway: { id: 'gateway', name: 'Gateway' } }
          },
          { id: 'offline', name: 'Offline', models: { hidden: { id: 'hidden', name: 'Hidden' } } }
        ]
      })
    ).toEqual([
      {
        id: 'custom/coder',
        label: 'Coder',
        supportedEfforts: ['low', 'high']
      }
    ]);
    expect(
      openCodeContextLimits({
        connected: ['custom', 'opencode'],
        all: [
          {
            id: 'custom',
            source: 'config',
            models: { coder: { limit: { context: 200_000 } } }
          },
          {
            id: 'opencode',
            source: 'custom',
            models: { gateway: { limit: { context: 100_000 } } }
          }
        ]
      }).get('custom/coder')
    ).toBe(200_000);
    expect(
      openCodeContextLimits({
        connected: ['opencode'],
        all: [
          {
            id: 'opencode',
            source: 'custom',
            models: { gateway: { limit: { context: 100_000 } } }
          }
        ]
      }).has('opencode/gateway')
    ).toBe(false);
  });

  it('keeps the CLI probe version aligned with the SDK', () => {
    expect(probeOpenCode()).toMatchObject({
      available: true,
      compatible: true,
      version: '1.18.20'
    });
    expect(probeOpenCode('definitely-not-installed-opencode')).toEqual({
      available: false,
      compatible: false
    });
  });
});

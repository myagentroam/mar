import { createServer, type Server, type RequestListener } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { ExtensionManager } from '../../src/agent-core/extensions/manager.js';
import type { CoreSessionExtensionContext } from '../../src/agent-core/extensions/contracts.js';
import type { CoreNetworkBackend } from '../../src/agent-core/extensions/network.js';
import { LocalNetworkAccess } from '../../src/agent-core/host/local-network-access.js';
import {
  fixture as sdkFixture,
  answer,
  call,
  cleanupCoreFixtures
} from './support/core-extension-fixture.js';

const managers: ExtensionManager[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await cleanupCoreFixtures();
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    )
  );
});
async function fixture(network?: CoreNetworkBackend, wrap = false) {
  let context!: CoreSessionExtensionContext;
  const identities: { entry: string; executionId?: string }[] = [];
  const facts: unknown[] = [];
  const manager = new ExtensionManager({
    extensions: [
      {
        id: 'http',
        apiVersion: '1.0',
        attachSession(value) {
          context = value;
          value.hooks.observe('network.completed', (fact, call) => {
            facts.push(fact);
            identities.push({
              entry: call.entry,
              ...(call.executionId ? { executionId: call.executionId } : {})
            });
          });
          if (wrap)
            value.hooks.intercept('network.fetch', async (input, _call, next) => ({
              ...(await next(input)),
              status: 299
            }));
        }
      }
    ],
    capabilities: network ? ['network'] : [],
    busyExcept: () => false,
    ...(network ? { hostPorts: { network } } : {})
  });
  managers.push(manager);
  await manager.prepare('session', new AbortController().signal);
  return { manager, context, facts, identities };
}
async function server(handler: RequestListener) {
  const http = createServer(handler);
  servers.push(http);
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Missing loopback address');
  return `http://127.0.0.1:${address.port}`;
}
describe('Core native HTTP port', () => {
  it('projects real Host network capabilities into SDK idle and model operations without extra history', async () => {
    const bytes = Buffer.from([0, 1, 255, 128]);
    const url = await server((_request, response) => {
      response.writeHead(200);
      response.end(bytes);
    });
    let context!: CoreSessionExtensionContext;
    const identities: { entry: string; executionId?: string }[] = [];
    const { session, adapter } = await sdkFixture(
      [
        {
          id: 'network-sdk',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
            value.hooks.observe('network.completed', (_fact, call) => {
              identities.push({
                entry: call.entry,
                ...(call.executionId ? { executionId: call.executionId } : {})
              });
            });
            value.tools.register({
              name: 'http_probe',
              description: 'Fetch raw binary bytes.',
              inputSchema: { type: 'object' },
              execute: async () => {
                const response = await value.network!.fetch({ url });
                const chunks: Uint8Array[] = [];
                for await (const chunk of response.body) chunks.push(chunk);
                expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
                return { content: 'raw-http-ok' };
              }
            });
          }
        }
      ],
      (_request, index) => (index === 0 ? call('http_probe', {}) : answer())
    );
    const outcome = await session.run({ prompt: 'HTTP probe' }).result();
    expect(outcome).toMatchObject({ status: 'completed' });
    expect(context.capabilities.has('network')).toBe(true);
    expect(identities).toEqual([{ entry: 'direct', executionId: outcome.executionId }]);
    const history = JSON.stringify(adapter.requests.at(-1)!.messages);
    const idle = await context.network!.fetch({ url });
    await idle.close();
    expect(identities.at(-1)).toEqual({ entry: 'native-api' });
    expect(adapter.requests).toHaveLength(2);
    expect(JSON.stringify(adapter.requests.at(-1)!.messages)).toBe(history);
    let disabled!: CoreSessionExtensionContext;
    const other = await sdkFixture(
      [
        {
          id: 'disabled-network',
          apiVersion: '1.0',
          attachSession(value) {
            disabled = value;
          }
        }
      ],
      () => answer(),
      false,
      false,
      { network: false }
    );
    await other.session.run({ prompt: 'no network' }).result();
    expect(disabled.network).toBeUndefined();
    expect(disabled.capabilities.has('network')).toBe(false);
  });

  it('returns real HTTP metadata and complete binary bytes without tool clipping or extra execution identity', async () => {
    const bytes = Buffer.alloc(3 * 1024 * 1024, 0xfd);
    let requestBody = Buffer.alloc(0);
    const url = await server(async (request, response) => {
      expect(request.headers['x-request-probe']).toBe('readonly tuple');
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      requestBody = Buffer.concat(chunks);
      response.writeHead(418, { 'content-type': 'application/octet-stream', 'x-probe': 'raw' });
      response.end(bytes);
    });
    const { context, facts, identities } = await fixture(new LocalNetworkAccess(), true);
    const headers: readonly (readonly [string, string])[] = [['x-request-probe', 'readonly tuple']];
    Object.freeze(headers[0]);
    Object.freeze(headers);
    const response = await context.network!.fetch({
      url,
      method: 'POST',
      headers,
      body: new Uint8Array([0, 255, 128])
    });
    expect(response.status).toBe(299);
    expect(response.headers).toContainEqual(['x-probe', 'raw']);
    const chunks: Uint8Array[] = [];
    for await (const chunk of response.body) chunks.push(chunk);
    expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
    expect(requestBody).toEqual(Buffer.from([0, 255, 128]));
    expect(facts).toEqual([{ status: 418, redirected: false }]);
    expect(identities).toEqual([{ entry: 'native-api' }]);
    await response.close();
    await response.close();
  });

  it('does not pull early, serializes concurrent consumer reads, and closes even before a first read', async () => {
    let pulls = 0;
    let closes = 0;
    const { context } = await fixture({
      async fetch() {
        return {
          url: 'https://example.test',
          status: 200,
          statusText: 'OK',
          redirected: false,
          headers: [],
          body: {
            async *[Symbol.asyncIterator]() {
              pulls++;
              yield new Uint8Array([1]);
              pulls++;
              yield new Uint8Array([2]);
            }
          },
          async close() {
            closes++;
          }
        };
      }
    });
    const response = await context.network!.fetch({ url: 'https://example.test' });
    expect(pulls).toBe(0);
    const iterator = response.body[Symbol.asyncIterator]();
    expect(await Promise.all([iterator.next(), iterator.next()])).toEqual([
      { done: false, value: new Uint8Array([1]) },
      { done: false, value: new Uint8Array([2]) }
    ]);
    expect(pulls).toBe(2);
    await iterator.return?.();
    await response.close();
    expect(closes).toBe(1);
    const unread = await context.network!.fetch({ url: 'https://example.test' });
    await unread.body[Symbol.asyncIterator]().return?.();
    expect(pulls).toBe(2);
    expect(closes).toBe(2);
  });

  it('cancels a pending raw body pull and closes the real connection on instance retirement', async () => {
    let closed!: () => void;
    const transportClosed = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const url = await server((_request, response) => {
      response.writeHead(200);
      response.write('first');
      response.once('close', closed);
    });
    const { manager, context } = await fixture(new LocalNetworkAccess());
    const response = await context.network!.fetch({ url });
    const iterator = response.body[Symbol.asyncIterator]();
    expect(await iterator.next()).toMatchObject({ done: false });
    const pending = iterator.next();
    const rejected = pending.catch((error) => error);
    await manager.dispose();
    expect(await rejected).toBeInstanceOf(Error);
    await transportClosed;
    await expect(context.network!.fetch({ url })).rejects.toThrow(/RETIRED/);
  });

  it('keeps absent ports unavailable and uses stable errors for malformed requests or missing methods', async () => {
    expect((await fixture()).context.network).toBeUndefined();
    const { context } = await fixture(new LocalNetworkAccess());
    await expect(context.network!.fetch({ url: 'not-a-url' })).rejects.toMatchObject({
      code: 'MAR_AGENT_NETWORK_REQUEST_INVALID'
    });
    await expect(context.network!.fetch({ url: 'file:///tmp/not-http' })).rejects.toMatchObject({
      code: 'MAR_AGENT_NETWORK_REQUEST_INVALID'
    });
    const missing = await fixture({} as CoreNetworkBackend);
    await expect(
      missing.context.network!.fetch({ url: 'https://example.test' })
    ).rejects.toMatchObject({ code: 'MAR_AGENT_HOST_PORT_UNAVAILABLE' });
  });

  it('allows explicit request cancellation before response headers arrive', async () => {
    let entered!: () => void;
    const accepted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const url = await server(() => {
      entered();
    });
    const { context } = await fixture(new LocalNetworkAccess());
    const controller = new AbortController();
    const reason = new Error('explicit HTTP cancellation');
    const pending = context.network!.fetch({ url, signal: controller.signal });
    const rejected = pending.catch((error) => error);
    await accepted;
    controller.abort(reason);
    expect(await rejected).toBe(reason);
  });

  it('preserves a primary body failure and reports independent cleanup failure', async () => {
    const primary = new Error('body failure');
    const { manager, context } = await fixture({
      async fetch() {
        return {
          url: 'https://example.test',
          status: 200,
          statusText: 'OK',
          redirected: false,
          headers: [],
          body: {
            // eslint-disable-next-line require-yield -- This fixture fails or waits for cancellation without emitting model events.
            async *[Symbol.asyncIterator]() {
              throw primary;
            }
          },
          async close() {
            throw new Error('cleanup failure');
          }
        };
      }
    });
    try {
      const response = await context.network!.fetch({ url: 'https://example.test' });
      await expect(response.body[Symbol.asyncIterator]().next()).rejects.toBe(primary);
      expect(manager.diagnostics()).toContainEqual(
        expect.objectContaining({ code: 'MAR_AGENT_NETWORK_CLEANUP_FAILED' })
      );
    } finally {
      await expect(manager.dispose()).rejects.toThrow(/CLEANUP_FAILED/);
      managers.splice(managers.indexOf(manager), 1);
    }
  });
});

import { createServer } from 'node:http';
import { createServer as createTcpServer, type Socket } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SecretValue,
  parseModelCatalog,
  normalizeRuntimeModelConfiguration,
  type AgentModelConfiguration
} from '../../src/model/configuration.js';
import { AnthropicMessagesAdapter } from '../../src/model/anthropic-messages.js';
import {
  serializeModel,
  writeModelCatalog,
  readModelCatalog,
  modelCatalogPath
} from '../../src/cli/catalog-file.js';
import { OpenAiResponsesAdapter } from '../../src/model/openai-responses.js';
import { connectSocks5Target, fetchWithConnectionTimeout } from '../../src/network/http.js';
import { acquireModelCredential } from '../../src/network/credential-runtime.js';
import type { ModelEvent } from '../../src/model/contracts.js';
import {
  startHttp2ResponsesServer,
  startHttps1ResponsesServer,
  startResponsesWebSocketServer,
  startSocks5Proxy,
  type CloseableServer
} from './support/responses-transport-servers.js';

const servers: CloseableServer[] = [];
const originalTls = process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
afterEach(async () => {
  if (originalTls === undefined) delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
  else process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = originalTls;
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve()))
          )
      )
  );
});

const responsesEvents = [
  { type: 'response.created', response: { id: 'response-1' } },
  {
    type: 'response.output_text.done',
    item_id: 'message-1',
    phase: 'final_answer',
    text: 'Proxied'
  },
  {
    type: 'response.completed',
    response: { usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: {} } }
  }
];
const anthropicEvents = [
  { type: 'message_start', message: { id: 'message-1', usage: { input_tokens: 10 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Proxied' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
  { type: 'message_stop' }
];
function configuration(baseUrl: string, proxy: string): AgentModelConfiguration {
  return {
    id: 'inline',
    name: 'Inline',
    protocol: 'OPENAI_RESPONSES',
    baseUrl,
    apiKey: new SecretValue('static-key'),
    socks5Url: new SecretValue(proxy),
    modelId: 'fixture',
    contextWindowTokens: 200_000,
    maxOutputTokens: 4096,
    inputCapabilities: ['TEXT'],
    outputCapabilities: ['TEXT'],
    reasoningEfforts: [],
    hostedWebSearch: false,
    enabled: true
  };
}
async function collect(source: AsyncIterable<ModelEvent>) {
  const events: ModelEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}
const request = {
  system: 'Reply.',
  messages: [{ role: 'user' as const, content: 'Proxy request' }],
  tools: [],
  retryState: { attempts: 0, maxAttempts: 1 }
};

describe('static model SOCKS5 connections', () => {
  it.each(['HTTP_1_1', 'HTTP_2', 'WEBSOCKET'] as const)(
    'routes Responses %s through authenticated SOCKS5 with remote DNS',
    async (transport) => {
      process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
      const target = await (transport === 'WEBSOCKET'
        ? startResponsesWebSocketServer(responsesEvents)
        : transport === 'HTTP_2'
          ? startHttp2ResponsesServer(responsesEvents)
          : startHttps1ResponsesServer(responsesEvents));
      servers.push(target.server);
      const targetUrl = new URL(target.baseUrl);
      const proxy = await startSocks5Proxy({
        targetPort: Number(targetUrl.port),
        username: 'proxy-user',
        password: 'proxy-pass'
      });
      servers.push(proxy.server);
      const model: AgentModelConfiguration = {
        ...configuration(`${targetUrl.protocol}//model.internal:${targetUrl.port}`, proxy.url),
        responsesTransport:
          transport === 'WEBSOCKET'
            ? { transport: 'WEBSOCKET' }
            : { transport: 'HTTP', httpVersion: transport === 'HTTP_2' ? '2' : '1.1' }
      };
      const events = await collect(
        new OpenAiResponsesAdapter(model).start(
          { ...request, retryState: { attempts: 0, maxAttempts: 1 } },
          new AbortController().signal
        )
      );
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'text.completed', text: 'Proxied' })
      );
      expect(proxy.destinations).toEqual([
        { host: 'model.internal', port: Number(targetUrl.port) }
      ]);
      expect(proxy.authentications).toEqual([{ username: 'proxy-user', password: 'proxy-pass' }]);
      expect(JSON.stringify(model)).not.toContain('proxy-pass');
    }
  );

  it('routes Anthropic through SOCKS5 and never falls back to a reachable direct endpoint', async () => {
    let directRequests = 0;
    const target = createServer((incoming, response) => {
      directRequests++;
      expect(incoming.headers['x-api-key']).toBe('static-key');
      incoming.resume();
      incoming.on('end', () => {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(anthropicEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
      });
    });
    servers.push(target);
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    const address = target.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    const proxy = await startSocks5Proxy({
      targetPort: address.port,
      username: 'proxy-user',
      password: 'proxy-pass'
    });
    servers.push(proxy.server);
    const model = {
      ...configuration(`http://model.internal:${address.port}`, proxy.url),
      protocol: 'ANTHROPIC_MESSAGES' as const
    };
    expect(
      await collect(
        new AnthropicMessagesAdapter(model).start(
          { ...request, retryState: { attempts: 0, maxAttempts: 1 } },
          new AbortController().signal
        )
      )
    ).toContainEqual(expect.objectContaining({ type: 'text.completed', text: 'Proxied' }));
    expect(proxy.authentications).toEqual([{ username: 'proxy-user', password: 'proxy-pass' }]);
    const failedProxyModel = {
      ...model,
      baseUrl: `http://127.0.0.1:${address.port}`,
      socks5Url: new SecretValue(proxy.url.replace('proxy-pass', 'incorrect-pass'))
    };
    await expect(
      collect(
        new AnthropicMessagesAdapter(failedProxyModel).start(
          { ...request, retryState: { attempts: 0, maxAttempts: 1 } },
          new AbortController().signal
        )
      )
    ).rejects.toThrow();
    expect(directRequests).toBe(1);
  });

  it('rejects failed proxy authentication instead of directly reaching Responses', async () => {
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
    const target = await startHttps1ResponsesServer(responsesEvents);
    servers.push(target.server);
    const proxy = await startSocks5Proxy({
      targetPort: Number(new URL(target.baseUrl).port),
      username: 'proxy-user',
      password: 'proxy-pass'
    });
    servers.push(proxy.server);
    const model = configuration(target.baseUrl, proxy.url.replace('proxy-pass', 'incorrect-pass'));
    await expect(
      collect(
        new OpenAiResponsesAdapter(model).start(
          { ...request, retryState: { attempts: 0, maxAttempts: 1 } },
          new AbortController().signal
        )
      )
    ).rejects.toThrow();
    expect(target.requests()).toBe(0);
    expect(proxy.authentications).toEqual([{ username: 'proxy-user', password: 'incorrect-pass' }]);
  });

  it.each(['HTTP', 'SSE', 'INVALID_SSE'] as const)(
    'redacts static Anthropic proxy credentials from %s errors',
    async (transport) => {
      let proxyUrl = '';
      const target = createServer((incoming, response) => {
        incoming.resume();
        const error = {
          type: 'proxy_error',
          message: `Endpoint echoed ${proxyUrl} proxy-user proxy-pass`
        };
        if (transport === 'HTTP') {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error }));
        } else {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.end(
            transport === 'INVALID_SSE'
              ? 'data: proxy-pass\n\n'
              : `data: ${JSON.stringify({ type: 'error', error })}\n\n`
          );
        }
      });
      await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
      servers.push(target);
      const address = target.address();
      if (address === null || typeof address === 'string') throw new Error('Missing test address');
      const proxy = await startSocks5Proxy({
        targetPort: address.port,
        username: 'proxy-user',
        password: 'proxy-pass'
      });
      servers.push(proxy.server);
      proxyUrl = proxy.url;
      const model = {
        ...configuration(`http://model.internal:${address.port}`, proxy.url),
        protocol: 'ANTHROPIC_MESSAGES' as const
      };
      const failure = await collect(
        new AnthropicMessagesAdapter(model).start(
          { ...request, retryState: { attempts: 0, maxAttempts: 1 } },
          new AbortController().signal
        )
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      for (const secret of [proxyUrl, 'proxy-user', 'proxy-pass'])
        expect(inspect(failure, { depth: 6 })).not.toContain(secret);
    }
  );

  it.each(['HTTP', 'WEBSOCKET', 'INVALID_WEBSOCKET'] as const)(
    'redacts static Responses proxy credentials from %s stream errors',
    async (transport) => {
      process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
      const event = {
        type: 'response.failed',
        response: { error: { code: 'proxy_error', message: '' } }
      };
      const target = await (transport === 'HTTP'
        ? startHttps1ResponsesServer([event])
        : startResponsesWebSocketServer([event], {
            ...(transport === 'INVALID_WEBSOCKET'
              ? { rawResponseFrames: [Buffer.from([0x81, 10, ...Buffer.from('proxy-pass')])] }
              : {})
          }));
      servers.push(target.server);
      const targetUrl = new URL(target.baseUrl);
      const proxy = await startSocks5Proxy({
        targetPort: Number(targetUrl.port),
        username: 'proxy-user',
        password: 'proxy-pass'
      });
      servers.push(proxy.server);
      event.response.error.message = `Endpoint echoed ${proxy.url} proxy-user proxy-pass`;
      const model: AgentModelConfiguration = {
        ...configuration(`${targetUrl.protocol}//model.internal:${targetUrl.port}`, proxy.url),
        responsesTransport:
          transport === 'HTTP'
            ? { transport: 'HTTP', httpVersion: '1.1' }
            : { transport: 'WEBSOCKET' }
      };
      const failure = await collect(
        new OpenAiResponsesAdapter(model).start(
          { ...request, retryState: { attempts: 0, maxAttempts: 1 } },
          new AbortController().signal
        )
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      if (transport === 'INVALID_WEBSOCKET')
        expect(failure).toMatchObject({
          code: 'MAR_AGENT_MODEL_PROTOCOL_ERROR',
          publicMessage: 'Model WebSocket contained invalid JSON.'
        });
      for (const secret of [proxy.url, 'proxy-user', 'proxy-pass'])
        expect(inspect(failure, { depth: 6 })).not.toContain(secret);
    }
  );

  describe.each(['ANTHROPIC_MESSAGES', 'OPENAI_RESPONSES'] as const)(
    '%s Retry-After diagnostics',
    (protocol) => {
      it.each(['SSE_ERROR', 'EARLY_EOF', 'INTERRUPTED'] as const)(
        'redacts proxy secrets from %s headers',
        async (failureKind) => {
          let retryAfter = '';
          let interrupt!: () => void;
          const target = createServer((incoming, response) => {
            incoming.resume();
            const event =
              failureKind === 'SSE_ERROR'
                ? { type: 'error', error: { type: 'overloaded_error', message: 'Busy.' } }
                : protocol === 'ANTHROPIC_MESSAGES'
                  ? anthropicEvents[0]
                  : responsesEvents[0];
            const events = protocol === 'ANTHROPIC_MESSAGES' ? anthropicEvents : responsesEvents;
            const body = (failureKind === 'INTERRUPTED' ? events.slice(0, -1) : [event])
              .map((item) => `data: ${JSON.stringify(item)}\n\n`)
              .join('');
            response.writeHead(200, {
              'content-type': 'text/event-stream',
              'retry-after': retryAfter
            });
            if (failureKind === 'INTERRUPTED') {
              interrupt = () => response.destroy();
              response.write(body);
            } else response.end(body);
          });
          await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
          servers.push(target);
          const address = target.address();
          if (address === null || typeof address === 'string')
            throw new Error('Missing test address');
          const proxy = await startSocks5Proxy({
            targetPort: address.port,
            username: 'proxy-user',
            password: 'proxy-pass'
          });
          servers.push(proxy.server);
          retryAfter = `${proxy.url} proxy-user proxy-pass`;
          const model = {
            ...configuration(`http://model.internal:${address.port}`, proxy.url),
            protocol
          };
          const adapter =
            protocol === 'ANTHROPIC_MESSAGES'
              ? new AnthropicMessagesAdapter(model)
              : new OpenAiResponsesAdapter(model);
          const failure = await (async () => {
            for await (const event of adapter.start(
              { ...request, retryState: { attempts: 0, maxAttempts: 1 } },
              new AbortController().signal
            ))
              if (failureKind === 'INTERRUPTED' && event.type === 'response.started') interrupt();
          })().catch((error: unknown) => error);
          expect(failure).toMatchObject({
            retryable: true,
            details: {
              ...(failureKind === 'SSE_ERROR' ? {} : { reason: `${protocol}_EARLY_EOF` }),
              retryAfter: '[REDACTED] [REDACTED] [REDACTED]'
            }
          });
          for (const secret of [proxy.url, 'proxy-user', 'proxy-pass'])
            expect(inspect(failure, { depth: 6 })).not.toContain(secret);
        }
      );
    }
  );

  it('redacts proxy secrets from Responses WebSocket handshake headers', async () => {
    let retryAfter = '';
    const target = createServer();
    target.on('upgrade', (_incoming, socket) => {
      socket.end(
        `HTTP/1.1 503 Service Unavailable\r\nRetry-After: ${retryAfter}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`
      );
    });
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    servers.push(target);
    const address = target.address();
    if (address === null || typeof address === 'string') throw new Error('Missing test address');
    const proxy = await startSocks5Proxy({
      targetPort: address.port,
      username: 'proxy-user',
      password: 'proxy-pass'
    });
    servers.push(proxy.server);
    retryAfter = `${proxy.url} proxy-user proxy-pass`;
    const model: AgentModelConfiguration = {
      ...configuration(`http://model.internal:${address.port}`, proxy.url),
      responsesTransport: { transport: 'WEBSOCKET' }
    };
    const failure = await collect(
      new OpenAiResponsesAdapter(model).start(
        { ...request, retryState: { attempts: 0, maxAttempts: 1 } },
        new AbortController().signal
      )
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: 'MAR_AGENT_MODEL_CONNECTION_FAILED',
      retryable: true,
      details: { status: 503, retryAfter: '[REDACTED] [REDACTED] [REDACTED]' }
    });
    for (const secret of [proxy.url, 'proxy-user', 'proxy-pass'])
      expect(inspect(failure, { depth: 6 })).not.toContain(secret);
  });

  it('omits truncated proxy password fragments from invalid WebSocket JSON diagnostics', async () => {
    const password = 'private-proxy-password-'.repeat(3);
    const payload = Buffer.from(password);
    const target = await startResponsesWebSocketServer([], {
      rawResponseFrames: [Buffer.concat([Buffer.from([0x81, payload.length]), payload])]
    });
    servers.push(target.server);
    const proxy = await startSocks5Proxy({
      targetPort: Number(new URL(target.baseUrl).port),
      username: 'proxy-user',
      password
    });
    servers.push(proxy.server);
    const failure = await collect(
      new OpenAiResponsesAdapter({
        ...configuration(target.baseUrl, proxy.url),
        responsesTransport: { transport: 'WEBSOCKET' }
      }).start(request, new AbortController().signal)
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'MAR_AGENT_MODEL_PROTOCOL_ERROR' });
    expect(inspect(failure, { depth: 6 })).not.toContain(password.slice(0, 10));
  });

  it('preserves a SOCKS5 CONNECT rejection when the upstream is unavailable', async () => {
    const target = createServer();
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    const address = target.address();
    if (address === null || typeof address === 'string') throw new Error('Missing test address');
    await new Promise<void>((resolve, reject) =>
      target.close((error) => (error ? reject(error) : resolve()))
    );
    const proxy = await startSocks5Proxy({ targetPort: address.port });
    servers.push(proxy.server);
    await expect(
      connectSocks5Target({
        socks5Url: proxy.url,
        targetHost: 'model.internal',
        targetPort: address.port,
        tls: false,
        signal: AbortSignal.timeout(1_000)
      })
    ).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });

  it('closes an in-progress HTTP/2 SOCKS5 handshake when the request is cancelled', async () => {
    const proxy = createTcpServer();
    servers.push(proxy);
    let client: Socket | undefined;
    let closed = false;
    const greeting = new Promise<void>((resolve) => {
      proxy.once('connection', (socket) => {
        client = socket;
        socket.on('error', () => undefined);
        socket.once('data', () => resolve());
        socket.once('close', () => {
          closed = true;
        });
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const address = proxy.address();
    if (address === null || typeof address === 'string') throw new Error('Fixture unavailable');
    const controller = new AbortController();
    const failure = fetchWithConnectionTimeout(
      'https://model.invalid/v1/responses',
      {
        request: { method: 'GET' },
        httpVersion: '2',
        socks5Url: `socks5://127.0.0.1:${address.port}`
      },
      controller.signal,
      5_000
    ).catch((error: unknown) => error);
    try {
      await greeting;
      const reason = new Error('Fixture request cancelled');
      controller.abort(reason);
      expect(await failure).toBe(reason);
      await vi.waitFor(() => expect(closed).toBe(true), { timeout: 1_000 });
    } finally {
      controller.abort();
      client?.destroy();
    }
  });

  it.each([
    'socks5://proxy-user:invalid%ZZ@proxy.invalid:1080',
    'http://proxy-user:proxy-pass@proxy.invalid:1080',
    'socks5://proxy.invalid:0'
  ])('rejects an invalid dynamic credential proxy at acquisition (%s)', async (proxy) => {
    const failure = await acquireModelCredential(
      {
        credentialProvider: {
          acquire: async () => ({
            revision: 1,
            expiresAt: Number.MAX_SAFE_INTEGER,
            bearer: new SecretValue('dynamic-key'),
            headers: {},
            socks5Url: new SecretValue(proxy)
          }),
          invalidate: () => undefined,
          close: async () => undefined
        }
      },
      'REQUEST',
      'Fixture missing credential'
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'MAR_AGENT_MODEL_CONFIG_INVALID' });
    expect(inspect(failure, { depth: 6 })).not.toContain(proxy);
  });

  it('validates proxies at the SDK boundary and wraps catalog proxy secrets', async () => {
    const model = configuration('https://models.invalid', 'socks5://user:pass@localhost:1080');
    expect(() => normalizeRuntimeModelConfiguration(model)).not.toThrow();
    const catalog = parseModelCatalog({
      version: 1,
      models: [{ ...model, apiKey: 'static-key', socks5Url: 'socks5://user:pass@localhost:1080' }]
    });
    expect(catalog.models[0]?.socks5Url).toBeInstanceOf(SecretValue);
    expect(catalog.models[0]?.socks5Url?.reveal()).toBe('socks5://user:pass@localhost:1080');
    const serialized = serializeModel(catalog.models[0]!);
    expect(serialized.socks5Url).toBe('socks5://user:pass@localhost:1080');
    const home = await mkdtemp(join(tmpdir(), 'mar-model-proxy-'));
    try {
      await writeModelCatalog(home, catalog);
      expect((await readModelCatalog(home)).models[0]?.socks5Url?.reveal()).toBe(
        serialized.socks5Url
      );
      const { apiKey: _key, ...external } = serialized;
      await writeFile(
        modelCatalogPath(home),
        JSON.stringify({
          version: 1,
          models: [{ ...external, credential: { type: 'CODEX_AUTH_FILE' } }]
        })
      );
      await expect(readModelCatalog(home)).rejects.toMatchObject({
        code: 'MAR_AGENT_MODEL_CONFIG_INVALID'
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
    for (const value of [
      'http://localhost:1080',
      'socks5://localhost:0',
      'socks5://localhost:1080/path',
      'socks5://:password@localhost:1080',
      `socks5://${'x'.repeat(256)}@localhost:1080`
    ]) {
      expect(() =>
        normalizeRuntimeModelConfiguration({ ...model, socks5Url: new SecretValue(value) })
      ).toThrow();
    }
    expect(() =>
      normalizeRuntimeModelConfiguration({
        ...model,
        apiKey: undefined,
        credentialProvider: {
          acquire: async () => ({
            revision: 1,
            expiresAt: Date.now() + 60_000,
            bearer: new SecretValue('token'),
            headers: {}
          }),
          invalidate() {},
          async close() {}
        }
      })
    ).toThrow();
  });
});

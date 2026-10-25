import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SecretValue, type MarAgentModelConfiguration } from '../../src/index.js';
import { OpenAiResponsesAdapter } from '../../src/agent-core/model/openai-responses.js';
import type {
  ModelAttemptDiagnostic,
  ModelEvent,
  ModelRequest
} from '../../src/agent-core/model/contracts.js';
import {
  startResponsesWebSocketServer,
  startSocks5Proxy,
  type CloseableServer
} from './support/responses-transport-servers.js';

vi.mock('../../src/agent-core/model/http.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/agent-core/model/http.js')>();
  return {
    ...original,
    waitForModelRetry: vi.fn(async (_retryAfter: unknown, _attempt: number, signal: AbortSignal) =>
      signal.throwIfAborted()
    )
  };
});

const servers: CloseableServer[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        })
    )
  );
});

function configuration(baseUrl: string): MarAgentModelConfiguration {
  return {
    id: 'responses',
    name: 'Responses',
    protocol: 'OPENAI_RESPONSES',
    baseUrl,
    apiKey: new SecretValue('local-test-key'),
    modelId: 'gpt-test',
    contextWindowTokens: 200_000,
    maxOutputTokens: 4096,
    inputCapabilities: ['TEXT', 'IMAGE'],
    outputCapabilities: ['TEXT'],
    reasoningEfforts: ['medium'],
    defaultReasoningEffort: 'medium',
    responsesTransport: { transport: 'WEBSOCKET' },
    responsesPreviousResponseId: true,
    hostedWebSearch: false,
    enabled: true
  };
}

const completed = [
  { type: 'response.completed', response: { id: 'fixture', status: 'completed', output: [] } }
];
async function collect(events: AsyncIterable<ModelEvent>) {
  const result: ModelEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}
function request(diagnostics: ModelAttemptDiagnostic[], content = 'hello'): ModelRequest {
  return {
    system: 'Stable system.',
    messages: [{ role: 'user', content }],
    tools: [],
    retryState: { attempts: 0, maxAttempts: 1 },
    onAttemptDiagnostic: (diagnostic) => {
      diagnostics.push(diagnostic);
    }
  };
}

describe('Responses WebSocket request framing', () => {
  it.each([
    {
      error: 'gRPC error: Response not found',
      expectedCode: 'MAR_AGENT_MODEL_PROTOCOL_ERROR',
      expectedMessage: 'gRPC error: Response not found'
    },
    {
      error: { code: 'invalid_request_error', message: 'Unsupported input.' },
      expectedCode: 'invalid_request_error',
      expectedMessage: 'Unsupported input.'
    }
  ])(
    'immediately rejects an untyped WebSocket error $expectedCode',
    async ({ error, expectedCode, expectedMessage }) => {
      const server = await startResponsesWebSocketServer([{ error }], { closeWhenEmpty: false });
      servers.push(server.server);
      const adapter = new OpenAiResponsesAdapter({
        ...configuration(server.baseUrl),
        responsesPreviousResponseId: false
      });
      try {
        await expect(
          collect(adapter.start(request([]), AbortSignal.timeout(1000)))
        ).rejects.toMatchObject({
          code: expectedCode,
          message: `${expectedCode}: ${expectedMessage}`
        });
        expect(server.requests).toHaveLength(1);
      } finally {
        await adapter.close();
      }
    }
  );

  it.each([8, 16, 24, 32])(
    'sends a %s MiB mixed payload as one unchanged text message within the image budget',
    async (mib) => {
      const server = await startResponsesWebSocketServer(completed, {
        maxClientFrameBytes: 1_048_576
      });
      servers.push(server.server);
      const adapter = new OpenAiResponsesAdapter(configuration(server.baseUrl));
      const diagnostics: ModelAttemptDiagnostic[] = [];
      const image = {
        mimeType: 'image/png',
        dataBase64: Buffer.alloc((8 * 1024 * 1024 * 3) / 4).toString('base64')
      };
      const padding = 'x'.repeat((mib - 8) * 1024 * 1024);
      try {
        await collect(
          adapter.start(
            {
              ...request(diagnostics),
              messages: [{ role: 'user', content: `Inspect.${padding}` }],
              images: [image]
            },
            new AbortController().signal
          )
        );
        expect(server.requests).toHaveLength(1);
        const body = server.requests[0] as Record<string, unknown>;
        expect(JSON.stringify(body).includes(`data:image/png;base64,${image.dataBase64}`)).toBe(
          true
        );
        expect(JSON.stringify(body)).toContain(`Inspect.${padding}`);
        const frames = server.clientFrames.filter(
          (frame) => frame.opcode === 1 || frame.opcode === 0
        );
        expect(frames.length).toBeGreaterThan(1);
        expect(frames[0]).toMatchObject({ opcode: 1, fin: false });
        expect(frames.slice(1).every((frame) => frame.opcode === 0)).toBe(true);
        expect(frames.slice(0, -1).every((frame) => !frame.fin)).toBe(true);
        expect(frames.at(-1)?.fin).toBe(true);
        expect(frames.every((frame) => frame.bytes <= 1_048_576)).toBe(true);
        expect(diagnostics.at(-1)).toMatchObject({
          state: 'SUCCEEDED',
          requestBytes: Buffer.byteLength(JSON.stringify(body)),
          imageCount: 1,
          imageBytes: (8 * 1024 * 1024 * 3) / 4,
          requestFrameCount: frames.length,
          sentFrameCount: frames.length,
          webSocketPhase: 'RECEIVE'
        });
        expect(JSON.stringify(diagnostics)).not.toContain(image.dataBase64.slice(0, 256));
        expect(JSON.stringify(diagnostics)).not.toContain('local-test-key');
      } finally {
        await adapter.close();
      }
    }
  );

  it('keeps small requests single-frame and preserves UTF-8 across frame boundaries', async () => {
    const server = await startResponsesWebSocketServer(completed, {
      maxClientFrameBytes: 1_048_576
    });
    servers.push(server.server);
    const adapter = new OpenAiResponsesAdapter(configuration(server.baseUrl));
    const diagnostics: ModelAttemptDiagnostic[] = [];
    const content = '你😀'.repeat(220_000);
    try {
      await collect(adapter.start(request(diagnostics), new AbortController().signal));
      expect(server.clientFrames).toHaveLength(1);
      expect(server.clientFrames[0]).toMatchObject({ opcode: 1, fin: true });
      await collect(adapter.start(request(diagnostics, content), new AbortController().signal));
      expect(JSON.stringify(server.requests[1])).toContain(content);
      expect(diagnostics.at(-1)).toMatchObject({
        imageCount: 0,
        imageBytes: 0,
        state: 'SUCCEEDED'
      });
    } finally {
      await adapter.close();
    }
  });

  it.each(['callback', 'error', 'close', 'abort'] as const)(
    'stops after a middle-frame %s and ignores its late write callback',
    async (failure) => {
      const server = await startResponsesWebSocketServer(completed);
      servers.push(server.server);
      const adapter = new OpenAiResponsesAdapter(configuration(server.baseUrl));
      const diagnostics: ModelAttemptDiagnostic[] = [];
      const controller = new AbortController();
      const originalSend = WebSocket.prototype.send;
      const callbacks: Array<(error?: Error) => void> = [];
      const sockets: WebSocket[] = [];
      let writes = 0;
      vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function (
        this: WebSocket,
        ...args: unknown[]
      ) {
        writes++;
        sockets.push(this);
        if (writes !== 2) return Reflect.apply(originalSend, this, args);
        const callback = args.findLast(
          (value): value is (error?: Error) => void => typeof value === 'function'
        )!;
        callbacks.push(callback);
        queueMicrotask(() => {
          const cause = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
          if (failure === 'callback') callback(cause);
          else if (failure === 'error') this.emit('error', cause);
          else if (failure === 'close')
            this.emit('close', 1009, Buffer.from('private-close-reason'));
          else controller.abort(new Error('fixture cancellation'));
        });
      } as WebSocket['send']);
      try {
        await expect(
          collect(
            adapter.start(request(diagnostics, 'x'.repeat(3 * 1024 * 1024)), controller.signal)
          )
        ).rejects.toThrow();
        expect(writes).toBe(2);
        const terminal = diagnostics.at(-1)!;
        expect(terminal).toMatchObject({
          state: 'FAILED',
          requestFrameCount: 4,
          sentFrameCount: 1,
          webSocketPhase: 'SEND',
          willRetry: false
        });
        if (failure === 'callback' || failure === 'error') expect(terminal.causeCode).toBe('EPIPE');
        if (failure === 'close') expect(terminal.webSocketCloseCode).toBe(1009);
        expect(JSON.stringify(diagnostics)).not.toContain('private-close-reason');
        callbacks[0]!();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(writes).toBe(2);
        expect(diagnostics.at(-1)?.sentFrameCount).toBe(1);
        expect(sockets[0]?.listenerCount('message')).toBe(0);
      } finally {
        await adapter.close();
      }
    }
  );

  it('captures responses that arrive before the final write callback', async () => {
    const server = await startResponsesWebSocketServer(completed);
    servers.push(server.server);
    const adapter = new OpenAiResponsesAdapter(configuration(server.baseUrl));
    const diagnostics: ModelAttemptDiagnostic[] = [];
    const originalSend = WebSocket.prototype.send;
    vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function (
      this: WebSocket,
      ...args: unknown[]
    ) {
      const callback = args.findLast(
        (value): value is (error?: Error) => void => typeof value === 'function'
      )!;
      const patched = [...args];
      patched[patched.length - 1] = (error?: Error) => {
        if (error) return callback(error);
        this.once('message', () => {
          queueMicrotask(() => callback());
        });
      };
      return Reflect.apply(originalSend, this, patched);
    } as WebSocket['send']);
    try {
      await collect(adapter.start(request(diagnostics), new AbortController().signal));
      expect(diagnostics.at(-1)).toMatchObject({ state: 'SUCCEEDED', sentFrameCount: 1 });
    } finally {
      await adapter.close();
    }
  });

  it('preserves request success when diagnostic reporting fails', async () => {
    const server = await startResponsesWebSocketServer(completed);
    servers.push(server.server);
    const adapter = new OpenAiResponsesAdapter(configuration(server.baseUrl));
    try {
      const events = await collect(
        adapter.start(
          {
            ...request([]),
            onAttemptDiagnostic: () => {
              throw new Error('diagnostic failure');
            }
          },
          new AbortController().signal
        )
      );
      expect(events.some((event) => event.type === 'completed')).toBe(true);
    } finally {
      await adapter.close();
    }
  });

  it('reports a receive-side close without exposing its reason or keeping listeners', async () => {
    const server = await startResponsesWebSocketServer([]);
    servers.push(server.server);
    const adapter = new OpenAiResponsesAdapter(configuration(server.baseUrl));
    const diagnostics: ModelAttemptDiagnostic[] = [];
    let socket: WebSocket | undefined;
    const originalSend = WebSocket.prototype.send;
    vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function (
      this: WebSocket,
      ...args: unknown[]
    ) {
      // eslint-disable-next-line @typescript-eslint/no-this-alias -- Capture the actual socket identity for subsequent transport assertions.
      socket = this;
      return Reflect.apply(originalSend, this, args);
    } as WebSocket['send']);
    try {
      await expect(
        collect(adapter.start(request(diagnostics), new AbortController().signal))
      ).rejects.toThrow();
      expect(diagnostics.at(-1)).toMatchObject({
        state: 'FAILED',
        sentFrameCount: 1,
        webSocketPhase: 'RECEIVE',
        webSocketCloseCode: 1005
      });
      expect(socket?.listenerCount('message')).toBe(0);
    } finally {
      await adapter.close();
    }
  });

  it('reports unsent framing metadata when the handshake fails', async () => {
    const server = await startResponsesWebSocketServer(completed, { handshakeStatuses: [401] });
    servers.push(server.server);
    const adapter = new OpenAiResponsesAdapter(configuration(server.baseUrl));
    const diagnostics: ModelAttemptDiagnostic[] = [];
    try {
      await expect(
        collect(adapter.start(request(diagnostics), new AbortController().signal))
      ).rejects.toThrow();
      expect(diagnostics.at(-1)).toMatchObject({
        state: 'FAILED',
        requestFrameCount: 1,
        sentFrameCount: 0,
        imageCount: 0,
        webSocketPhase: 'CONNECT'
      });
      expect(server.requests).toHaveLength(0);
    } finally {
      await adapter.close();
    }
  });

  it.each(['DIRECT', 'SOCKS5'] as const)(
    'frames incremental images and resets diagnostics for full replay through %s',
    async (proxyType) => {
      const server = await startResponsesWebSocketServer(completed, {
        maxClientFrameBytes: 1_048_576
      });
      servers.push(server.server);
      const port = Number(new URL(server.baseUrl).port);
      const proxy =
        proxyType === 'SOCKS5'
          ? await startSocks5Proxy({
              targetPort: port,
              username: 'fixture-user',
              password: 'fixture-password'
            })
          : undefined;
      if (proxy) servers.push(proxy.server);
      const configured = configuration(proxy ? `http://model.internal:${port}` : server.baseUrl);
      const { apiKey, ...baseModel } = configured;
      void apiKey;
      const model: MarAgentModelConfiguration = {
        ...baseModel,
        credentialProvider: {
          acquire: async () => ({
            revision: 1,
            expiresAt: Date.now() + 60_000,
            bearer: new SecretValue('fixture-bearer'),
            headers: {},
            ...(proxy ? { socks5Url: new SecretValue(proxy.url) } : {})
          }),
          invalidate: () => undefined,
          close: async () => undefined
        }
      };
      const adapter = new OpenAiResponsesAdapter(model);
      const turn = adapter.createTurnSession();
      const diagnostics: ModelAttemptDiagnostic[] = [];
      const image = {
        mimeType: 'image/png',
        dataBase64: Buffer.alloc(2 * 1024 * 1024).toString('base64')
      };
      const first: ModelRequest = {
        ...request(diagnostics),
        messages: [{ role: 'user', content: 'first', images: [image] }]
      };
      const second: ModelRequest = {
        ...first,
        retryState: { attempts: 0, maxAttempts: 1 },
        messages: [...first.messages, { role: 'user', content: 'second', images: [image] }]
      };
      const originalSend = WebSocket.prototype.send;
      let socket: WebSocket | undefined;
      let frame = 0;
      try {
        await collect(turn.start(first, new AbortController().signal));
        await collect(turn.start(second, new AbortController().signal));
        expect(server.connections()).toBe(1);
        expect(server.requests[1]).toMatchObject({ previous_response_id: 'fixture' });
        expect(diagnostics.at(-1)).toMatchObject({
          state: 'SUCCEEDED',
          continuation: true,
          imageCount: 1,
          imageBytes: 2 * 1024 * 1024,
          proxyType
        });
        vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function (
          this: WebSocket,
          ...args: unknown[]
        ) {
          // eslint-disable-next-line @typescript-eslint/no-this-alias -- Capture the actual socket identity for subsequent transport assertions.
          if (socket === undefined) socket = this;
          if (this === socket) {
            frame++;
            if (frame === 2) {
              const callback = args.findLast(
                (value): value is (error: Error) => void => typeof value === 'function'
              )!;
              queueMicrotask(() =>
                callback(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
              );
              return;
            }
          }
          return Reflect.apply(originalSend, this, args);
        } as WebSocket['send']);
        await collect(
          turn.start(
            {
              ...second,
              retryState: { attempts: 0, maxAttempts: 2 },
              messages: [...second.messages, { role: 'user', content: 'third', images: [image] }]
            },
            new AbortController().signal
          )
        );
        expect(server.connections()).toBe(2);
        expect(server.requests).toHaveLength(3);
        expect(frame).toBe(2);
        const failure = diagnostics.findLast((item) => item.state === 'FAILED')!;
        expect(failure).toMatchObject({
          causeCode: 'EPIPE',
          continuation: true,
          imageCount: 1,
          sentFrameCount: 1,
          webSocketPhase: 'SEND',
          willRetry: true
        });
        const body = server.requests[2] as Record<string, unknown>;
        expect(body).not.toHaveProperty('previous_response_id');
        const replayFrames = server.clientFrames.filter(
          (item) => item.connection === 1 && (item.opcode === 0 || item.opcode === 1)
        );
        expect(diagnostics.at(-1)).toMatchObject({
          state: 'SUCCEEDED',
          continuation: false,
          imageCount: 3,
          imageBytes: 6 * 1024 * 1024,
          requestBytes: Buffer.byteLength(JSON.stringify(body)),
          requestFrameCount: replayFrames.length,
          sentFrameCount: replayFrames.length,
          webSocketPhase: 'RECEIVE',
          connectionReused: false,
          proxyType
        });
        expect(diagnostics.at(-1)).not.toHaveProperty('webSocketCloseCode');
        expect(diagnostics.at(-1)?.connectionId).not.toBe(failure.connectionId);
        expect(JSON.stringify(diagnostics)).not.toContain('fixture-password');
        expect(JSON.stringify(diagnostics)).not.toContain('fixture-bearer');
      } finally {
        await turn.close();
        await adapter.close();
      }
    }
  );
});

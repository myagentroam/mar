import { createECDH, createPublicKey, randomBytes, verify } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { createServer, request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { describe, expect, it, vi } from 'vitest';
import webPush from 'web-push';
import { createWebPushTransport } from '../../src/web-push-transport.js';
import type { WebPushTransportInput } from '../../src/web-push-dispatcher.js';

// Verify received ciphertext with the encryption implementation shipped by web-push.
const require = createRequire(import.meta.url);
const ece = createRequire(require.resolve('web-push'))('http_ece') as {
  decrypt(body: Buffer, options: Record<string, unknown>): Buffer;
};

function fixture(statusCode = 201) {
  const receiver = createECDH('prime256v1');
  const publicKey = receiver.generateKeys();
  const auth = randomBytes(16).toString('base64url');
  const controller = new AbortController();
  const keys = webPush.generateVAPIDKeys();
  const input: WebPushTransportInput = {
    ...keys,
    subject: 'https://console.example.test',
    subscription: {
      endpoint: 'https://fcm.googleapis.com/fcm/send/fixture',
      keys: { p256dh: publicKey.toString('base64url'), auth }
    },
    payload: JSON.stringify({ title: 'Task', body: 'Completed' }),
    ttl: 120,
    signal: controller.signal
  };
  let sent: Buffer | undefined;
  const response = Object.assign(new EventEmitter(), { statusCode, destroy: vi.fn() });
  const socket = Object.assign(new EventEmitter(), {
    end: vi.fn((body: Buffer) => {
      sent = body;
    })
  });
  const request = vi.fn((_options: RequestOptions, receive: (value: IncomingMessage) => void) => {
    queueMicrotask(() => receive(response as never));
    return socket;
  });
  const send = createWebPushTransport({ request: request as never });
  return {
    input,
    controller,
    keys,
    receiver,
    auth,
    request,
    socket,
    response,
    send,
    sent: () => sent!
  };
}

describe('standard Web Push transport', () => {
  it.each([false, true])(
    'exercises a real local socket with cancellation=%s, without contacting a provider',
    async (cancel) => {
      const f = fixture();
      let received!: (value: { body: Buffer; authorization: string | undefined }) => void;
      const message = new Promise<{ body: Buffer; authorization: string | undefined }>(
        (resolve) => {
          received = resolve;
        }
      );
      const server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk) => chunks.push(chunk));
        request.on('end', () => {
          received({ body: Buffer.concat(chunks), authorization: request.headers.authorization });
          if (!cancel) response.writeHead(201).end();
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const address = server.address();
        if (address === null || typeof address === 'string')
          throw new Error('TEST_SERVER_ADDRESS_INVALID');
        const send = createWebPushTransport({
          // Only the socket primitive is replaced; encryption, signing and URL validation still run.
          request: ((options: RequestOptions, callback: (response: IncomingMessage) => void) =>
            httpRequest(
              { ...options, protocol: 'http:', hostname: '127.0.0.1', port: address.port },
              callback
            )) as never
        });
        const pending = send(f.input);
        const rejection = cancel
          ? expect(pending).rejects.toThrow(/^WEB_PUSH_TRANSPORT_FAILED$/u)
          : undefined;
        const request = await message;
        expect(request.authorization).toMatch(/^vapid /u);
        expect(
          ece
            .decrypt(request.body, {
              version: 'aes128gcm',
              privateKey: f.receiver,
              authSecret: f.auth
            })
            .toString()
        ).toBe(f.input.payload);
        if (cancel) {
          f.controller.abort();
          await rejection;
        } else expect(await pending).toEqual({ statusCode: 201 });
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error === undefined ? resolve() : reject(error)))
        );
      }
    }
  );

  it.each([
    'https://fcm.googleapis.com/fcm/send/fixture',
    'https://wns2-db5p.notify.windows.com/w/?token=fixture',
    'https://web.push.apple.com/fixture',
    'https://uccm-intl.ucweb.com/wpush/m/fixture',
    'https://updates.push.services.mozilla.com/wpush/v2/fixture',
    'https://push.example.test:8443/up/fixture?token=fixture',
    'https://127.0.0.1:8443/up/fixture',
    'https://[::1]:8443/up/fixture'
  ])(
    'encrypts the message and signs a per-request VAPID authorization for %s',
    async (endpoint) => {
      const f = fixture();
      await expect(
        f.send({ ...f.input, subscription: { ...f.input.subscription, endpoint } })
      ).resolves.toEqual({ statusCode: 201 });
      const options = f.request.mock.calls[0]![0];
      expect(options).toMatchObject({
        protocol: 'https:',
        hostname: new URL(endpoint).hostname.replace(/^\[|\]$/gu, ''),
        method: 'POST',
        rejectUnauthorized: true,
        headers: { host: new URL(endpoint).host, TTL: 120, 'Content-Encoding': 'aes128gcm' }
      });
      expect(options.port).toBe(
        new URL(endpoint).port ? Number(new URL(endpoint).port) : undefined
      );
      expect(options).not.toHaveProperty('lookup');
      expect(options).not.toHaveProperty('family');
      expect(options).not.toHaveProperty('servername');
      expect(options.path).toBe(new URL(endpoint).pathname + new URL(endpoint).search);
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(f.sent().includes(Buffer.from(f.input.payload))).toBe(false);
      expect(
        ece
          .decrypt(f.sent(), { version: 'aes128gcm', privateKey: f.receiver, authSecret: f.auth })
          .toString()
      ).toBe(f.input.payload);
      const headers = options.headers as Record<string, string>;
      const match = /^vapid t=([^,]+),\s*k=(.+)$/u.exec(headers['Authorization']!);
      expect(match?.[2]).toBe(f.keys.publicKey);
      const [header, body, signature] = match![1]!.split('.');
      expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toMatchObject({
        alg: 'ES256'
      });
      expect(JSON.parse(Buffer.from(body!, 'base64url').toString())).toMatchObject({
        aud: new URL(endpoint).origin,
        sub: f.input.subject
      });
      const key = Buffer.from(f.keys.publicKey, 'base64url');
      expect(
        verify(
          'sha256',
          Buffer.from(`${header}.${body}`),
          {
            key: createPublicKey({
              key: {
                kty: 'EC',
                crv: 'P-256',
                x: key.subarray(1, 33).toString('base64url'),
                y: key.subarray(33).toString('base64url')
              },
              format: 'jwk'
            }),
            dsaEncoding: 'ieee-p1363'
          },
          Buffer.from(signature!, 'base64url')
        )
      ).toBe(true);
      expect(f.response.destroy).toHaveBeenCalledOnce();
    }
  );

  it.each([201, 302, 404, 410, 429, 503])(
    'returns status %i without following redirects or retaining response bodies',
    async (status) => {
      const f = fixture(status);
      expect(await f.send(f.input)).toEqual({ statusCode: status });
      expect(f.request).toHaveBeenCalledOnce();
      expect(f.response.destroy).toHaveBeenCalledOnce();
    }
  );

  it.each([
    'not a URL',
    'http://fcm.googleapis.com/push',
    'https://user:pass@push.example.test/push',
    'https://push.example.test/push#fragment'
  ])('rejects malformed or non-HTTPS endpoints before sending: %s', async (endpoint) => {
    const f = fixture();
    await expect(
      f.send({ ...f.input, subscription: { ...f.input.subscription, endpoint } })
    ).rejects.toThrow('WEB_PUSH_TRANSPORT_FAILED');
    expect(f.request).not.toHaveBeenCalled();
  });

  it('cancels the native HTTPS request while standard DNS resolution is pending', async () => {
    const f = fixture();
    let started!: () => void;
    const resolving = new Promise<void>((resolve) => {
      started = resolve;
    });
    const lookup = vi.fn<NonNullable<RequestOptions['lookup']>>(() => started());
    const request = vi.fn((options: RequestOptions, receive: (value: IncomingMessage) => void) =>
      httpsRequest({ ...options, agent: false, lookup }, receive)
    );
    const send = createWebPushTransport({ request: request as never });
    const rejected = expect(
      send({
        ...f.input,
        subscription: {
          ...f.input.subscription,
          endpoint: 'https://push.example.test:8443/up/fixture'
        }
      })
    ).rejects.toThrow(/^WEB_PUSH_TRANSPORT_FAILED$/u);
    try {
      await resolving;
      const pending = request.mock.results[0]!.value;
      const closed = new Promise<void>((resolve) => pending.once('close', resolve));
      f.controller.abort();
      await rejected;
      await closed;
      expect(lookup).toHaveBeenCalledOnce();
      expect(request).toHaveBeenCalledOnce();
      expect(pending.destroyed).toBe(true);
    } finally {
      f.controller.abort();
    }
  });

  it('bounds a pending HTTPS request with the delivery timeout', async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), milliseconds);
      return controller.signal;
    });
    try {
      const f = fixture();
      f.request.mockImplementation((options) => {
        options.signal!.addEventListener(
          'abort',
          () => f.socket.emit('error', new Error('aborted')),
          { once: true }
        );
        return f.socket;
      });
      const rejected = expect(f.send(f.input)).rejects.toThrow(/^WEB_PUSH_TRANSPORT_FAILED$/u);
      await vi.advanceTimersByTimeAsync(5_000);
      await rejected;
      expect(timeout).toHaveBeenCalledWith(5_000);
      expect(f.request).toHaveBeenCalledOnce();
      expect(f.request.mock.calls[0]![0].signal?.aborted).toBe(true);
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
    }
  });

  it('does not begin an already cancelled send or expose network/crypto error details', async () => {
    const f = fixture();
    f.controller.abort();
    await expect(f.send(f.input)).rejects.toThrow('WEB_PUSH_TRANSPORT_FAILED');
    expect(f.request).not.toHaveBeenCalled();
    const failed = fixture();
    failed.request.mockImplementation(() => {
      throw new Error('fixture endpoint and secret');
    });
    await expect(failed.send(failed.input)).rejects.toThrow(/^WEB_PUSH_TRANSPORT_FAILED$/u);
  });
});

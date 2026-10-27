import { describe, expect, it, vi } from 'vitest';
import { SecretValue } from '../../src/model/configuration.js';
import { connectSocks5Target, fetchModelResponse } from '../../src/model/http.js';
import { TransportFault } from '../../src/network/transport-error.js';
import { acquireCredential, appendCredentialHeaders, requestHttp } from '../../src/host/network.js';

describe('host network public subpath', () => {
  it('keeps model credentials usable through the host API', async () => {
    const credential = await acquireCredential(
      { apiKey: new SecretValue('test-key') },
      'REQUEST',
      'missing'
    );
    expect(credential.bearer.reveal()).toBe('test-key');
    expect(appendCredentialHeaders(new Headers(), credential, new Set())).toBeInstanceOf(Headers);
  });

  it('preserves the single-attempt transport error contract', async () => {
    const cause = Object.assign(new Error('unavailable'), { code: 'ECONNREFUSED' });
    const error = await requestHttp(
      'https://example.invalid',
      async () => {
        throw cause;
      },
      new AbortController().signal,
      1000
    ).catch((error: unknown) => error);
    expect(error).toMatchObject({
      code: 'MAR_AGENT_MODEL_CONNECTION_FAILED',
      publicMessage: 'Model transport request failed.',
      retryable: true,
      details: { reason: 'MODEL_TRANSPORT_FAILURE' }
    });
    expect((error as Error).cause).toBe(cause);
  });

  it.each([
    [
      'connection-timeout',
      'MAR_AGENT_MODEL_TIMEOUT',
      'Model connection timed out.',
      'MODEL_CONNECTION_TIMEOUT',
      true
    ],
    [
      'http2-negotiation',
      'MAR_AGENT_MODEL_CONNECTION_FAILED',
      'Model endpoint did not negotiate HTTP/2.',
      undefined,
      false
    ],
    [
      'invalid-proxy',
      'MAR_AGENT_MODEL_CONFIG_INVALID',
      'SOCKS5 proxy URL is invalid.',
      undefined,
      false
    ]
  ] as const)(
    'projects %s at both boundaries without retrying non-timeout faults',
    async (kind, code, message, reason, retryable) => {
      const cause = new Error('underlying failure');
      const fault = new TransportFault(kind, 'transport fault', cause);
      for (const request of [requestHttp, fetchModelResponse]) {
        const init = vi.fn(async () => {
          throw fault;
        });
        const error = await request(
          'https://example.invalid',
          init,
          new AbortController().signal,
          1
        ).catch((value: unknown) => value);
        expect(error).toMatchObject({ code, publicMessage: message, retryable });
        if (reason) expect(error).toMatchObject({ details: { reason } });
        if (kind !== 'connection-timeout') expect((error as Error).cause).toBe(cause);
        expect(init).toHaveBeenCalledTimes(1);
      }
    }
  );

  it('keeps caller cancellation identity ahead of transport failure', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled');
    const init = async () => {
      controller.abort(reason);
      throw new TransportFault('connection-timeout', 'timeout');
    };
    await expect(requestHttp('https://example.invalid', init, controller.signal, 1)).rejects.toBe(
      reason
    );
  });

  it('projects the actual connection deadline once at the Host boundary', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
    try {
      await expect(
        requestHttp('https://example.invalid', {}, new AbortController().signal, 1)
      ).rejects.toMatchObject({
        code: 'MAR_AGENT_MODEL_TIMEOUT',
        retryable: true,
        details: { reason: 'MODEL_CONNECTION_TIMEOUT' }
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      fetch.mockRestore();
    }
  });

  it('projects an invalid SOCKS5 proxy for the WebSocket connector', async () => {
    await expect(
      connectSocks5Target({
        socks5Url: 'not a proxy',
        targetHost: 'example.test',
        targetPort: 443,
        tls: true
      })
    ).rejects.toMatchObject({
      code: 'MAR_AGENT_MODEL_CONFIG_INVALID',
      publicMessage: 'SOCKS5 proxy URL is invalid.'
    });
  });

  it('preserves the WebSocket connector abort reason even when it resembles a transport fault', async () => {
    const controller = new AbortController();
    const reason = new TransportFault('invalid-proxy', 'cancelled');
    controller.abort(reason);
    await expect(
      connectSocks5Target({
        socks5Url: 'not a proxy',
        targetHost: 'example.test',
        targetPort: 443,
        tls: true,
        signal: controller.signal
      })
    ).rejects.toBe(reason);
  });

  it('preserves the nested proxy error across the real HTTP/2 connector', async () => {
    const init = { request: {}, httpVersion: '2' as const, socks5Url: 'not a proxy' };
    for (const request of [requestHttp, fetchModelResponse]) {
      const error = await request(
        'https://example.invalid',
        init,
        new AbortController().signal,
        1_000
      ).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).cause).toMatchObject({ code: 'MAR_AGENT_MODEL_CONFIG_INVALID' });
      expect(((error as Error).cause as Error).cause).toMatchObject({ code: 'ERR_INVALID_URL' });
    }
  });
});

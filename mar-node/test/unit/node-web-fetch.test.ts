import { createServer, type Server, type RequestListener } from 'node:http';
import dns from 'node:dns';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WEB_FETCH_MAX_BYTES,
  webFetchResultSchema
} from '../../src/service/web-fetch-contracts.js';
import { WebFetchService } from '../../src/service/web-fetch-service.js';
import { WebToolService } from '../../src/service/web-tool-service.js';
import type { Browser } from 'playwright';
import { gzipSync, brotliCompressSync, deflateSync } from 'node:zlib';
import { errors } from 'playwright';

const servers: Server[] = [];
const services: WebFetchService[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        })
    )
  );
});

async function target(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
}

function service(options?: ConstructorParameters<typeof WebFetchService>[0]) {
  const instance = new WebFetchService(options);
  services.push(instance);
  return instance;
}

describe('Node web fetch service', () => {
  it.each([
    ['gzip', gzipSync],
    ['br', brotliCompressSync],
    ['deflate', deflateSync]
  ] as const)(
    'decodes compressed HTTP text without launching a browser (%s)',
    async (encoding, compress) => {
      const launchBrowser = vi.fn();
      const url = await target((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': encoding });
        response.end(compress(Buffer.from('COMPRESSED_TEXT')));
      });
      await expect(
        service({ launchBrowser }).fetch({ url, mode: 'http' }, new AbortController().signal)
      ).resolves.toMatchObject({ content: 'COMPRESSED_TEXT', truncated: false });
      expect(launchBrowser).not.toHaveBeenCalled();
    }
  );

  it('enforces the browser redirect limit before fetching the excess target', async () => {
    const paths: string[] = [];
    const url = await target((request, response) => {
      paths.push(request.url!);
      const index = Number(request.url?.slice(1));
      if (index < 7) response.writeHead(302, { location: `/${index + 1}` });
      else response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<body>TOO_MANY_REDIRECTS</body>');
    });
    await expect(
      service().fetch({ url: `${url}/0`, mode: 'browser' }, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'MAR_AGENT_WEB_FETCH_UPSTREAM_FAILED' });
    expect(paths).not.toContain('/6');
  }, 20_000);

  it('blocks credential-bearing browser redirect locations before contacting the target', async () => {
    const requests: string[] = [];
    const url = await target((request, response) => {
      requests.push(request.url!);
      response.writeHead(
        request.url === '/target' ? 200 : 302,
        request.url === '/target'
          ? { 'content-type': 'text/html' }
          : { location: url.replace('http://', 'http://user:fixture-password@') + '/target' }
      );
      response.end('<body>PRIVATE_TARGET</body>');
    });
    await expect(
      service().fetch({ url, mode: 'browser' }, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'MAR_AGENT_TOOL_INPUT_INVALID' });
    expect(requests).toEqual(['/']);
  }, 20_000);

  it('bounds decompressed output and repaired invalid UTF-8 at the public byte budget', async () => {
    const url = await target((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
      response.end(gzipSync(Buffer.alloc(WEB_FETCH_MAX_BYTES + 1, 0xff)));
    });
    const result = await service().fetch({ url, mode: 'http' }, new AbortController().signal);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(WEB_FETCH_MAX_BYTES);
    expect(webFetchResultSchema.safeParse(result).success).toBe(true);
  });

  it.each([200, 404])(
    'settles client-side navigation and reports the destination response (%s)',
    async (status) => {
      const url = await target((request, response) => {
        if (request.url === '/destination') {
          response.writeHead(status, { 'content-type': 'text/html' });
          response.end('<title>Destination</title><body>DESTINATION_BODY</body>');
        } else {
          response.writeHead(200, { 'content-type': 'text/html' });
          response.end(
            '<body>REDIRECTING<script>setTimeout(()=>location.href="/destination",200)</script></body>'
          );
        }
      });
      const pending = service().fetch({ url, mode: 'browser' }, new AbortController().signal);
      if (status === 200)
        await expect(pending).resolves.toMatchObject({
          content: 'DESTINATION_BODY',
          data: { url: `${url}/destination`, status, title: 'Destination' }
        });
      else
        await expect(pending).rejects.toMatchObject({
          code: 'MAR_AGENT_WEB_FETCH_UPSTREAM_FAILED',
          details: { upstreamStatus: 404 }
        });
    },
    20_000
  );

  it('classifies browser navigation deadlines as timeout errors', async () => {
    const page = {
      on: vi.fn(),
      mainFrame: vi.fn(),
      isClosed: vi.fn(() => false),
      goto: vi.fn(async () => {
        throw new errors.TimeoutError('private url');
      })
    };
    const context = {
      route: vi.fn(),
      newPage: vi.fn(async () => page),
      newCDPSession: vi.fn(async () => ({
        on: vi.fn(),
        send: vi.fn(async () => ({ frameTree: { frame: { id: 'main' } } }))
      })),
      on: vi.fn(),
      close: vi.fn(async () => undefined)
    };
    const launchBrowser = vi.fn(
      async () =>
        ({
          newContext: vi.fn(async () => context),
          close: vi.fn(async () => undefined)
        }) as unknown as Browser
    );
    await expect(
      service({ launchBrowser }).fetch(
        { url: 'http://example.test/', mode: 'browser' },
        new AbortController().signal
      )
    ).rejects.toMatchObject({ code: 'MAR_AGENT_WEB_FETCH_TIMEOUT' });
  });
  it('fetches Node-reachable private HTTP URLs and follows relative redirects', async () => {
    const url = await target((request, response) => {
      if (request.url === '/redirect') {
        response.writeHead(302, { location: '/page' });
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('NODE_FETCH_OK');
    });
    const result = await service().fetch(
      { url: `${url}/redirect`, mode: 'http' },
      new AbortController().signal
    );
    expect(result).toEqual({
      content: 'NODE_FETCH_OK',
      data: { url: `${url}/page`, mode: 'http', status: 200, contentType: 'text/plain' },
      truncated: false
    });
  });

  it('does not execute JavaScript or launch Chromium in HTTP mode', async () => {
    const launchBrowser = vi.fn();
    const url = await target((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<body><script>document.body.textContent="Rendered"</script></body>');
    });
    const result = await service({ launchBrowser }).fetch(
      { url, mode: 'http' },
      new AbortController().signal
    );
    expect(result.content).toContain('<script>');
    expect(launchBrowser).not.toHaveBeenCalled();
  });

  it('preserves TLS handshake reset diagnostics without a browser fallback', async () => {
    const launchBrowser = vi.fn();
    const server = createServer();
    servers.push(server);
    server.on('connection', (socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    const failure = await service({ launchBrowser })
      .fetch(
        { url: `https://127.0.0.1:${address.port}/`, mode: 'http' },
        new AbortController().signal
      )
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: 'MAR_AGENT_WEB_FETCH_UPSTREAM_FAILED',
      publicMessage: 'Web fetch upstream failed during TLS negotiation (ECONNRESET).',
      details: { status: 502, mode: 'http', phase: 'tls', upstreamCode: 'ECONNRESET' }
    });
    expect(launchBrowser).not.toHaveBeenCalled();
  });

  it('distinguishes an HTTP request reset from a TLS handshake failure', async () => {
    const url = await target((request) => request.socket.destroy());
    await expect(
      service().fetch({ url, mode: 'http' }, new AbortController().signal)
    ).rejects.toMatchObject({
      code: 'MAR_AGENT_WEB_FETCH_UPSTREAM_FAILED',
      publicMessage: 'Web fetch upstream failed during the HTTP request (ECONNRESET).',
      details: { status: 502, mode: 'http', phase: 'request', upstreamCode: 'ECONNRESET' }
    });
  });

  it('does not label a DNS lookup failure as a TLS negotiation failure', async () => {
    vi.spyOn(dns, 'lookup').mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (error: NodeJS.ErrnoException) => void;
      callback(Object.assign(new Error('private DNS diagnostics'), { code: 'ENOTFOUND' }));
    });
    await expect(
      service().fetch(
        { url: 'https://web-fetch-dns.invalid/', mode: 'http' },
        new AbortController().signal
      )
    ).rejects.toMatchObject({
      code: 'MAR_AGENT_WEB_FETCH_UPSTREAM_FAILED',
      publicMessage: 'Web fetch upstream failed during the HTTP request (ENOTFOUND).',
      details: { status: 502, mode: 'http', phase: 'request', upstreamCode: 'ENOTFOUND' }
    });
  });

  it('preserves response decoding failures after a successful HTTP status', async () => {
    const url = await target((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
      response.end('not a gzip stream');
    });
    await expect(
      service().fetch({ url, mode: 'http' }, new AbortController().signal)
    ).rejects.toMatchObject({
      code: 'MAR_AGENT_WEB_FETCH_UPSTREAM_FAILED',
      publicMessage: 'Web fetch upstream failed during the HTTP response read (Z_DATA_ERROR).',
      details: { status: 502, mode: 'http', phase: 'response', upstreamCode: 'Z_DATA_ERROR' }
    });
  });

  it.each([
    ['ENOTFOUND', 'ENOTFOUND'],
    ['ECONNREFUSED', 'ECONNREFUSED'],
    ['X'.repeat(81), undefined],
    ['invalid code fixture-secret', undefined],
    [undefined, undefined]
  ])('bounds upstream codes and excludes private error messages (%s)', async (code, expected) => {
    const privateMessage = 'https://user:fixture-secret@example.test/?token=fixture-token';
    const launchBrowser = vi.fn(
      async () =>
        ({
          newContext: vi.fn(async () => {
            throw Object.assign(new Error(privateMessage), { code });
          }),
          close: vi.fn(async () => undefined)
        }) as unknown as Browser
    );
    const failure = await service({ launchBrowser })
      .fetch({ url: 'https://example.test/', mode: 'browser' }, new AbortController().signal)
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: 'MAR_AGENT_WEB_FETCH_UPSTREAM_FAILED',
      publicMessage: `Web fetch upstream failed during the browser read${expected ? ` (${expected})` : ''}.`,
      details: {
        status: 502,
        mode: 'browser',
        phase: 'browser',
        ...(expected ? { upstreamCode: expected } : {})
      }
    });
    expect(failure).not.toHaveProperty('cause', expect.anything());
    if (expected) expect(failure).toHaveProperty('details.upstreamCode', expected);
    else expect(failure).not.toHaveProperty('details.upstreamCode');
    expect(JSON.stringify(failure)).not.toContain('fixture-secret');
    expect(JSON.stringify(failure)).not.toContain('fixture-token');
  });

  it('bounds UTF-8 output and stops an oversized response with a valid truncation result', async () => {
    const url = await target((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('汉'.repeat(WEB_FETCH_MAX_BYTES));
    });
    const result = await service().fetch({ url, mode: 'http' }, new AbortController().signal);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(WEB_FETCH_MAX_BYTES);
    expect(result.content).not.toContain('\uFFFD');
    expect(webFetchResultSchema.safeParse(result).success).toBe(true);
  });

  it.each([
    [403, 'text/html', 'MAR_AGENT_WEB_FETCH_UPSTREAM_FAILED'],
    [200, 'application/pdf', 'MAR_AGENT_WEB_FETCH_UNSUPPORTED_CONTENT']
  ])(
    'rejects unsupported status/content without browser fallback (%s)',
    async (status, contentType, code) => {
      const launchBrowser = vi.fn();
      const url = await target((_request, response) => {
        response.writeHead(status, { 'content-type': contentType });
        response.end('unreadable');
      });
      await expect(
        service({ launchBrowser }).fetch({ url, mode: 'http' }, new AbortController().signal)
      ).rejects.toMatchObject({ code });
      expect(launchBrowser).not.toHaveBeenCalled();
    }
  );

  it('rejects unsafe redirects and bounds redirect loops', async () => {
    const url = await target((request, response) => {
      response.writeHead(302, {
        location: request.url === '/unsafe' ? 'file:///etc/passwd' : '/loop'
      });
      response.end();
    });
    const fetcher = service();
    await expect(
      fetcher.fetch({ url: `${url}/unsafe`, mode: 'http' }, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'MAR_AGENT_TOOL_INPUT_INVALID' });
    await expect(
      fetcher.fetch({ url: `${url}/loop`, mode: 'http' }, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'MAR_AGENT_WEB_FETCH_UPSTREAM_FAILED' });
  });

  it('cancels a pending HTTP response when Node closes and refuses later requests', async () => {
    let requested!: () => void;
    const seen = new Promise<void>((resolve) => {
      requested = resolve;
    });
    const url = await target((_request, _response) => {
      requested();
    });
    const fetcher = service();
    const pending = fetcher.fetch({ url, mode: 'http' }, new AbortController().signal);
    const failed = expect(pending).rejects.toMatchObject({ code: 'MAR_AGENT_WEB_FETCH_CANCELLED' });
    await seen;
    await fetcher.close();
    await failed;
    await expect(
      fetcher.fetch({ url, mode: 'http' }, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'MAR_AGENT_WEB_FETCH_CANCELLED' });
  });

  it('reports missing Chromium without fetching the target through HTTP', async () => {
    let requests = 0;
    const url = await target((_request, response) => {
      requests++;
      response.end('HTTP_FALLBACK');
    });
    const fetcher = service({
      launchBrowser: vi.fn(async () => {
        throw new Error('missing executable /private/path');
      })
    });
    await expect(
      fetcher.fetch({ url, mode: 'browser' }, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'MAR_AGENT_WEB_FETCH_BROWSER_UNAVAILABLE' });
    expect(requests).toBe(0);
  });

  it('local Fetch never reads Node credentials or invokes the Server transport', async () => {
    const config = vi.fn(() => {
      throw new Error('Credentials must not be read');
    });
    const request = vi.fn();
    const tools = new WebToolService(config, request);
    const url = await target((incoming, response) => {
      expect(incoming.headers.authorization).toBeUndefined();
      expect(incoming.headers['x-mar-node-id']).toBeUndefined();
      response.end('LOCAL_FETCH');
    });
    try {
      await expect(
        tools.webFetch({ url, mode: 'http' }, new AbortController().signal)
      ).resolves.toMatchObject({ content: 'LOCAL_FETCH' });
      expect(config).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    } finally {
      await tools.close();
    }
  });

  it('cancels an active browser navigation and can use the freed capacity again', async () => {
    let requested!: () => void;
    const seen = new Promise<void>((resolve) => {
      requested = resolve;
    });
    const url = await target((request, response) => {
      if (request.url === '/pending') {
        requested();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<body>AFTER_CANCEL</body>');
    });
    const fetcher = service();
    const abort = new AbortController();
    const pending = fetcher.fetch({ url: `${url}/pending`, mode: 'browser' }, abort.signal);
    const failed = expect(pending).rejects.toMatchObject({ code: 'MAR_AGENT_WEB_FETCH_CANCELLED' });
    await seen;
    abort.abort();
    await failed;
    await expect(
      fetcher.fetch({ url, mode: 'browser' }, new AbortController().signal)
    ).resolves.toMatchObject({ content: 'AFTER_CANCEL' });
  }, 20_000);

  it('bounds browser concurrency and releases launch-failure slots', async () => {
    const releases: Array<() => void> = [];
    const launchBrowser = vi.fn(
      () =>
        new Promise<Browser>((_resolve, reject) => {
          releases.push(() => reject(new Error('fixture launch failure')));
        })
    );
    const fetcher = service({ launchBrowser });
    const input = { url: 'http://127.0.0.1/', mode: 'browser' as const };
    const first = expect(fetcher.fetch(input, new AbortController().signal)).rejects.toMatchObject({
      code: 'MAR_AGENT_WEB_FETCH_BROWSER_UNAVAILABLE'
    });
    const second = expect(fetcher.fetch(input, new AbortController().signal)).rejects.toMatchObject(
      { code: 'MAR_AGENT_WEB_FETCH_BROWSER_UNAVAILABLE' }
    );
    await expect(fetcher.fetch(input, new AbortController().signal)).rejects.toMatchObject({
      code: 'MAR_AGENT_WEB_FETCH_BUSY'
    });
    expect(launchBrowser).toHaveBeenCalledTimes(2);
    releases.splice(0).forEach((release) => release());
    await Promise.all([first, second]);
    const third = expect(fetcher.fetch(input, new AbortController().signal)).rejects.toMatchObject({
      code: 'MAR_AGENT_WEB_FETCH_BROWSER_UNAVAILABLE'
    });
    releases.splice(0).forEach((release) => release());
    await third;
    expect(launchBrowser).toHaveBeenCalledTimes(3);
  });

  it('classifies deadline expiry separately from cancellation', async () => {
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    let requested!: () => void;
    const seen = new Promise<void>((resolve) => {
      requested = resolve;
    });
    const url = await target(() => {
      requested();
    });
    const pending = service().fetch({ url, mode: 'http' }, new AbortController().signal);
    const failed = expect(pending).rejects.toMatchObject({ code: 'MAR_AGENT_WEB_FETCH_TIMEOUT' });
    await seen;
    timeout.abort();
    await failed;
  });

  it('applies the configured TLS default but allows hosted reads to force verification', async () => {
    const newContext = vi.fn(async () => {
      throw new Error('stop after policy observation');
    });
    const launchBrowser = vi.fn(
      async () => ({ newContext, close: vi.fn(async () => undefined) }) as unknown as Browser
    );
    const fetcher = service({ allowUntrustedTls: true, launchBrowser });
    const input = { url: 'https://example.test/', mode: 'browser' as const };
    await expect(fetcher.fetch(input, new AbortController().signal)).rejects.toThrow();
    expect(newContext).toHaveBeenLastCalledWith(
      expect.objectContaining({ ignoreHTTPSErrors: true })
    );
    await expect(
      fetcher.fetch(input, new AbortController().signal, { allowUntrustedTls: false })
    ).rejects.toThrow();
    expect(newContext).toHaveBeenLastCalledWith(
      expect.objectContaining({ ignoreHTTPSErrors: false })
    );
    await expect(
      service({ allowUntrustedTls: false, launchBrowser }).fetch(
        input,
        new AbortController().signal
      )
    ).rejects.toThrow();
    expect(newContext).toHaveBeenLastCalledWith(
      expect.objectContaining({ ignoreHTTPSErrors: false })
    );
  });

  it('renders asynchronous JavaScript locally and isolates cookies', async () => {
    const cookies: string[] = [];
    const url = await target((request, response) => {
      cookies.push(request.headers.cookie ?? '');
      response.writeHead(200, {
        'content-type': 'text/html',
        'set-cookie': 'private=first-request; Path=/'
      });
      response.end(
        '<html><head><title>Dynamic page</title></head><body><div id="root">Loading</div><script>setTimeout(()=>document.getElementById("root").textContent="CLIENT_RENDERED_BODY",300)</script></body></html>'
      );
    });
    const fetcher = service();
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await fetcher.fetch({ url, mode: 'browser' }, new AbortController().signal);
      expect(result).toMatchObject({
        content: 'CLIENT_RENDERED_BODY',
        data: { mode: 'browser', title: 'Dynamic page', status: 200 },
        truncated: false
      });
      expect(result.content).not.toContain('<script>');
    }
    expect(cookies).toEqual(['', '']);
  }, 20_000);
});

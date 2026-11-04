import { createServer, type Server, type RequestListener } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WEB_FETCH_MAX_BYTES,
  browserFetchResultSchema
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
    ['text/plain; charset=utf-8', '  first line\n\nlast line\n'],
    ['text/markdown; charset=utf-8', '\n    code indentation\n\n# heading\n'],
    ['application/json; charset=utf-8', '  {\n    "hello": "world"\n  }\n'],
    [
      'application/xml; charset=utf-8',
      '<?xml version="1.0"?>\n<root>\n  <item>value</item>\n</root>\n'
    ]
  ])(
    'retains the exact source text for %s',
    async (contentType, body) => {
      const url = await target((_request, response) => {
        response.writeHead(200, { 'content-type': contentType });
        response.end(body);
      });
      const result = await service().fetch({ url, mode: 'browser' }, new AbortController().signal);
      expect(result.content).toBe(body);
      expect(result.truncated).toBe(false);
    },
    20_000
  );

  it('preserves whitespace when decoding a compressed non-UTF-8 response', async () => {
    const url = await target((_request, response) => {
      response.writeHead(200, {
        'content-type': 'text/plain; charset=iso-8859-1',
        'content-encoding': 'gzip'
      });
      response.end(gzipSync(Buffer.from([0x20, 0x63, 0x61, 0x66, 0xe9, 0x0a])));
    });
    const result = await service().fetch({ url, mode: 'browser' }, new AbortController().signal);
    expect(result.content).toBe(' café\n');
    expect(result.truncated).toBe(false);
  }, 20_000);

  it('reports an unsupported binary navigation rather than a generic browser failure', async () => {
    const url = await target((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end(Buffer.from([0, 1, 2, 3]));
    });
    await expect(
      service().fetch({ url, mode: 'browser' }, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'MAR_AGENT_WEB_FETCH_UNSUPPORTED_CONTENT' });
  });

  it('reports a binary main document reached by client-side navigation', async () => {
    const url = await target((request, response) => {
      if (request.url === '/binary') {
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        response.end(Buffer.from([0, 1, 2, 3]));
      } else {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(
          '<p>Loading</p><script>setTimeout(() => location.href="/binary", 100)</script>'
        );
      }
    });
    await expect(
      service().fetch({ url, mode: 'browser' }, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'MAR_AGENT_WEB_FETCH_UNSUPPORTED_CONTENT' });
  });

  it.each([
    ['text/plain; charset=utf-8', '  first\n    second\n\n'],
    [
      'application/xml; charset=utf-8',
      '<?xml version="1.0"?><root><value>XML-TARGET</value></root>'
    ]
  ])(
    'uses the final response body after an HTML script navigates to %s',
    async (type, body) => {
      let destinationRequests = 0;
      const url = await target((request, response) => {
        if (request.url === '/final') {
          destinationRequests++;
          response.writeHead(200, { 'content-type': type });
          response.end(body);
          return;
        }
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(
          '<p>Loading</p><script>setTimeout(() => location.href="/final", 100)</script>'
        );
      });
      const result = await service().fetch({ url, mode: 'browser' }, new AbortController().signal);
      expect(result.content).toBe(body);
      expect(result.data).toMatchObject({ url: new URL('/final', url).href, contentType: type });
      expect(destinationRequests).toBe(1);
    },
    20_000
  );
  it.each([
    ['gzip', gzipSync],
    ['br', brotliCompressSync],
    ['deflate', deflateSync]
  ] as const)(
    'decodes compressed text in Chromium (%s)',
    async (encoding, compress) => {
      const url = await target((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': encoding });
        response.end(compress(Buffer.from('COMPRESSED_TEXT')));
      });
      await expect(
        service().fetch({ url, mode: 'browser' }, new AbortController().signal)
      ).resolves.toMatchObject({ content: 'COMPRESSED_TEXT', truncated: false });
    },
    20_000
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

  it('bounds decompressed output and repaired invalid UTF-8 at the internal byte budget', async () => {
    const url = await target((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
      response.end(gzipSync(Buffer.alloc(WEB_FETCH_MAX_BYTES + 1, 0xff)));
    });
    const result = await service().fetch({ url, mode: 'browser' }, new AbortController().signal);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(WEB_FETCH_MAX_BYTES);
    expect(browserFetchResultSchema.safeParse(result).success).toBe(true);
  }, 20_000);

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
          content: String.raw`DESTINATION\_BODY`,
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
          on: vi.fn(),
          isConnected: () => true,
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
      { url: `${url}/redirect`, mode: 'browser' },
      new AbortController().signal
    );
    expect(result).toMatchObject({
      content: 'NODE_FETCH_OK',
      data: { url: `${url}/page`, mode: 'browser', status: 200, contentType: 'text/plain' },
      truncated: false
    });
  }, 20_000);

  it.each([
    ['ENOTFOUND', 'ENOTFOUND'],
    ['ECONNREFUSED', 'ECONNREFUSED'],
    ['X'.repeat(81), undefined],
    ['invalid code fixture-secret', undefined],
    [undefined, undefined]
  ])(
    'bounds upstream codes and excludes private error messages (%s)',
    async (code, expected) => {
      const privateMessage = 'https://user:fixture-secret@example.test/?token=fixture-token';
      const launchBrowser = vi.fn(
        async () =>
          ({
            newContext: vi.fn(async () => {
              throw Object.assign(new Error(privateMessage), { code });
            }),
            on: vi.fn(),
            isConnected: () => true,
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
    },
    20_000
  );

  it('bounds UTF-8 output and stops an oversized response with a valid truncation result', async () => {
    const url = await target((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('汉'.repeat(WEB_FETCH_MAX_BYTES));
    });
    const result = await service().fetch({ url, mode: 'browser' }, new AbortController().signal);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(WEB_FETCH_MAX_BYTES);
    expect(result.content).not.toContain('\uFFFD');
    expect(browserFetchResultSchema.safeParse(result).success).toBe(true);
  });

  it.each([
    [403, 'text/html', 'MAR_AGENT_WEB_FETCH_UPSTREAM_FAILED'],
    [200, 'application/pdf', 'MAR_AGENT_WEB_FETCH_UNSUPPORTED_CONTENT']
  ])(
    'rejects unsupported status/content without fallback (%s)',
    async (status, contentType, code) => {
      const url = await target((_request, response) => {
        response.writeHead(status, { 'content-type': contentType });
        response.end('unreadable');
      });
      await expect(
        service().fetch({ url, mode: 'browser' }, new AbortController().signal)
      ).rejects.toMatchObject({ code });
    },
    20_000
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
      fetcher.fetch({ url: `${url}/unsafe`, mode: 'browser' }, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'MAR_AGENT_WEB_FETCH_UPSTREAM_FAILED' });
    await expect(
      fetcher.fetch({ url: `${url}/loop`, mode: 'browser' }, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'MAR_AGENT_WEB_FETCH_UPSTREAM_FAILED' });
  });

  it('cancels a pending browser response when Node closes and refuses later requests', async () => {
    let requested!: () => void;
    const seen = new Promise<void>((resolve) => {
      requested = resolve;
    });
    const url = await target((_request, _response) => {
      requested();
    });
    const fetcher = service();
    const pending = fetcher.fetch({ url, mode: 'browser' }, new AbortController().signal);
    const failed = expect(pending).rejects.toMatchObject({ code: 'MAR_AGENT_WEB_FETCH_CANCELLED' });
    await seen;
    await fetcher.close();
    await failed;
    await expect(
      fetcher.fetch({ url, mode: 'browser' }, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'MAR_AGENT_WEB_FETCH_CANCELLED' });
  }, 20_000);

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
        tools.webFetch(
          { action: 'open', url, maxTokens: 2000 },
          new AbortController().signal,
          'test-session'
        )
      ).resolves.toMatchObject({ content: expect.stringContaining(String.raw`LOCAL\_FETCH`) });
      expect(config).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    } finally {
      await tools.close();
    }
  }, 20_000);

  it('keeps visible descendants without copying hidden HTML text', async () => {
    const url = await target((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<body style="visibility:hidden">
        HIDDEN_BODY_TEXT
        <p style="visibility:visible">Visible outside</p>
        <section>HIDDEN_CONTAINER_TEXT
          <h2 style="visibility:visible">Visible descendant</h2>
        </section>
        <section style="display:none">
          <span style="visibility:visible">HIDDEN_DISPLAY_NONE_TEXT</span>
        </section>
        <img src="/hidden.png" alt="HIDDEN_IMAGE_ALT">
        <a href="/hidden-link">HIDDEN_LINK_TEXT</a>
        <script>document.body.append(
          document.createTextNode('HIDDEN_DYNAMIC_ONE'),
          document.createTextNode('HIDDEN_DYNAMIC_TWO'))</script>
      </body>`);
    });
    const result = await service().fetch({ url, mode: 'browser' }, new AbortController().signal);
    expect(result.content).toContain('Visible outside');
    expect(result.content).toContain('## Visible descendant');
    expect(result.content).not.toContain('HIDDEN');
    expect(result.content).not.toContain('/hidden-link');
  }, 20_000);

  it('rejects a display-none body instead of returning invisible HTML text', async () => {
    const url = await target((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<body style="display:none">HIDDEN_BODY_TEXT</body>');
    });
    await expect(
      service().fetch({ url, mode: 'browser' }, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'MAR_AGENT_WEB_FETCH_EMPTY_CONTENT' });
  }, 20_000);

  it('opens one rendered Markdown snapshot, finds and continues it only within its session', async () => {
    let requests = 0;
    const url = await target((_request, response) => {
      requests++;
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<title>Fixture</title><h1>Heading</h1><a href="/relative">Link</a>
        <ul><li>First</li><li>Second</li></ul><table><thead><tr><th>Col</th></tr></thead><tbody><tr><td>Value</td></tr></tbody></table>
        <pre><code>code block</code></pre><script>document.body.insertAdjacentHTML('beforeend','<p>dynamic target</p>')</script>
        <p style="display:none">hidden secret</p>`);
    });
    const tools = new WebToolService(() => undefined);
    const signal = new AbortController().signal;
    const scope = JSON.stringify(['workspace', '/home/test', 'first']);
    try {
      const opened = await tools.webFetch({ action: 'open', url, maxTokens: 2000 }, signal, scope);
      const data = opened.data as { ref: string; format: string };
      expect(opened.content).toContain('# Heading');
      expect(opened.content).toContain(`[Link](${url}/relative)`);
      expect(opened.content).toContain('| Col |');
      expect(opened.content).toContain('code block');
      expect(opened.content).not.toContain('hidden secret');
      expect(opened.content).not.toContain('insertAdjacentHTML');
      expect(data.format).toBe('markdown');
      const found = await tools.webFetch(
        { action: 'find', ref: data.ref, pattern: 'DYNAMIC TARGET', maxTokens: 512 },
        signal,
        scope
      );
      expect(found.content).toContain('dynamic target');
      expect(found.content).toContain(data.ref);
      await expect(
        tools.webFetch(
          { action: 'open', ref: data.ref, maxTokens: 512 },
          signal,
          JSON.stringify(['workspace', '/home/test', 'second'])
        )
      ).rejects.toMatchObject({ code: 'MAR_AGENT_WEB_SNAPSHOT_UNAVAILABLE' });
      expect(requests).toBe(1);
      tools.clearSession(scope);
      await expect(
        tools.webFetch({ action: 'open', ref: data.ref, maxTokens: 512 }, signal, scope)
      ).rejects.toMatchObject({ code: 'MAR_AGENT_WEB_SNAPSHOT_UNAVAILABLE' });
    } finally {
      await tools.close();
    }
  }, 20_000);

  it('cancels an in-flight read when its session is invalidated', async () => {
    let requested!: () => void;
    const seen = new Promise<void>((resolve) => {
      requested = resolve;
    });
    const url = await target((_request, response) => {
      requested();
      response.on('close', () => response.end());
    });
    const tools = new WebToolService(() => undefined);
    try {
      const pending = tools.webFetch(
        { action: 'open', url, maxTokens: 512 },
        new AbortController().signal,
        'scope'
      );
      const cancelled = expect(pending).rejects.toMatchObject({
        code: 'MAR_AGENT_WEB_FETCH_CANCELLED'
      });
      await seen;
      tools.clearSession('scope');
      await cancelled;
    } finally {
      await tools.close();
    }
  }, 20_000);

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
    ).resolves.toMatchObject({ content: 'AFTER\\_CANCEL' });
  }, 20_000);

  it('queues excess browser reads and releases launch-failure slots', async () => {
    const releases: Array<() => void> = [];
    const launchBrowser = vi.fn(
      () =>
        new Promise<Browser>((_resolve, reject) => {
          releases.push(() => reject(new Error('fixture launch failure')));
        })
    );
    const fetcher = service({ launchBrowser });
    const input = { url: 'http://127.0.0.1/', mode: 'browser' as const };
    const first = Array.from({ length: 4 }, () =>
      expect(fetcher.fetch(input, new AbortController().signal)).rejects.toMatchObject({
        code: 'MAR_AGENT_WEB_FETCH_BROWSER_UNAVAILABLE'
      })
    );
    const queued = expect(fetcher.fetch(input, new AbortController().signal)).rejects.toMatchObject(
      {
        code: 'MAR_AGENT_WEB_FETCH_BROWSER_UNAVAILABLE'
      }
    );
    await vi.waitFor(() => expect(launchBrowser).toHaveBeenCalledTimes(1));
    releases.splice(0).forEach((release) => release());
    await Promise.all(first);
    await vi.waitFor(() => expect(launchBrowser).toHaveBeenCalledTimes(2));
    releases.splice(0).forEach((release) => release());
    await queued;
    const third = expect(fetcher.fetch(input, new AbortController().signal)).rejects.toMatchObject({
      code: 'MAR_AGENT_WEB_FETCH_BROWSER_UNAVAILABLE'
    });
    await vi.waitFor(() => expect(launchBrowser).toHaveBeenCalledTimes(3));
    releases.splice(0).forEach((release) => release());
    await third;
    expect(launchBrowser).toHaveBeenCalledTimes(3);
  });

  it('completes six parallel reads by waiting for browser capacity', async () => {
    const held: Array<() => void> = [];
    let firstBatchReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      firstBatchReady = resolve;
    });
    const url = await target((request, response) => {
      const reply = () => {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end(`Fetched ${request.url}`);
      };
      if (held.length < 4) {
        held.push(reply);
        if (held.length === 4) firstBatchReady();
      } else reply();
    });
    const fetcher = service();
    const results = Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        fetcher.fetch({ url: `${url}/${index}`, mode: 'browser' }, new AbortController().signal)
      )
    );
    await Promise.all([
      ready.then(() => held.forEach((reply) => reply())),
      expect(results).resolves.toEqual(
        Array.from({ length: 6 }, (_, index) =>
          expect.objectContaining({ content: `Fetched /${index}` })
        )
      )
    ]);
  }, 20_000);

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
    const pending = service().fetch({ url, mode: 'browser' }, new AbortController().signal);
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
      async () =>
        ({
          newContext,
          on: vi.fn(),
          isConnected: () => true,
          close: vi.fn(async () => undefined)
        }) as unknown as Browser
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
        content: String.raw`CLIENT\_RENDERED\_BODY`,
        data: { mode: 'browser', title: 'Dynamic page', status: 200 },
        truncated: false
      });
      expect(result.content).not.toContain('<script>');
    }
    expect(cookies).toEqual(['', '']);
  }, 20_000);
});

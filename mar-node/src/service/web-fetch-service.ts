import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { TLSSocket } from 'node:tls';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentError } from '@myagentroam/agent';
import { chromium, errors, type Browser, type BrowserContext, type Response } from 'playwright';
import {
  WEB_FETCH_MAX_BYTES,
  webFetchRequestSchema,
  type WebFetchRequest,
  type WebFetchResult
} from './web-fetch-contracts.js';

const TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const MAX_BROWSER_REQUESTS = 2;

export class WebFetchError extends AgentError {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly publicMessage: string,
    readonly publicParameters?: Readonly<Record<string, string | number>>
  ) {
    super(code, publicMessage, { details: { status, ...(publicParameters ?? {}) } });
  }
}

/** Owns Node-side network access and the lifetime of isolated browser reads. */
export class WebFetchService {
  readonly #shutdown = new AbortController();
  readonly #active = new Set<Promise<WebFetchResult>>();
  readonly #allowUntrustedTls: boolean;
  readonly #launchBrowser: typeof chromium.launch;
  #browserRequests = 0;
  #closing: Promise<void> | undefined;

  constructor(
    options: {
      allowUntrustedTls?: boolean;
      launchBrowser?: typeof chromium.launch;
    } = {}
  ) {
    this.#allowUntrustedTls =
      options.allowUntrustedTls ?? process.env['MAR_AGENT_WEB_FETCH_ALLOW_UNTRUSTED_TLS'] !== '0';
    this.#launchBrowser = options.launchBrowser ?? chromium.launch.bind(chromium);
  }

  fetch(
    input: WebFetchRequest,
    signal: AbortSignal,
    policy: { allowUntrustedTls?: boolean } = {}
  ): Promise<WebFetchResult> {
    const parsed = webFetchRequestSchema.safeParse(input);
    if (!parsed.success)
      return Promise.reject(
        new WebFetchError('MAR_AGENT_TOOL_INPUT_INVALID', 400, 'Web fetch input is invalid.')
      );
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const combined = AbortSignal.any([signal, this.#shutdown.signal, timeout]);
    const task = this.#execute(
      parsed.data,
      combined,
      policy.allowUntrustedTls ?? this.#allowUntrustedTls
    ).catch((error: unknown) => {
      if (timeout.aborted || error instanceof errors.TimeoutError)
        throw new WebFetchError('MAR_AGENT_WEB_FETCH_TIMEOUT', 504, 'Web fetch timed out.');
      if (combined.aborted)
        throw new WebFetchError('MAR_AGENT_WEB_FETCH_CANCELLED', 503, 'Web fetch was cancelled.');
      if (error instanceof WebFetchError) throw error;
      throw upstreamFailure(
        error,
        parsed.data.mode,
        parsed.data.mode === 'http' ? 'response' : 'browser'
      );
    });
    this.#active.add(task);
    void task.then(
      () => this.#active.delete(task),
      () => this.#active.delete(task)
    );
    return task;
  }

  close(): Promise<void> {
    return (this.#closing ??= this.#close());
  }

  async #close(): Promise<void> {
    this.#shutdown.abort();
    await Promise.allSettled([...this.#active]);
  }

  async #execute(
    input: WebFetchRequest,
    signal: AbortSignal,
    allowUntrustedTls: boolean
  ): Promise<WebFetchResult> {
    signal.throwIfAborted();
    return input.mode === 'http'
      ? this.#fetchHttp(input, signal, allowUntrustedTls)
      : this.#fetchBrowser(input, signal, allowUntrustedTls);
  }

  async #fetchHttp(
    input: WebFetchRequest,
    signal: AbortSignal,
    allowUntrustedTls: boolean
  ): Promise<WebFetchResult> {
    let url = new URL(input.url);
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      const response = await requestHttp(url, signal, allowUntrustedTls);
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if ([301, 302, 303, 307, 308].includes(status) && location) {
        response.destroy();
        const next = new URL(location, url);
        if (!webFetchRequestSchema.safeParse({ url: next.href, mode: 'http' }).success)
          throw new WebFetchError(
            'MAR_AGENT_TOOL_INPUT_INVALID',
            400,
            'Redirect URL is not supported.'
          );
        url = next;
        continue;
      }
      const contentType = (response.headers['content-type'] ?? 'text/plain').slice(0, 256);
      if (status < 200 || status >= 300 || !readableContentType(contentType)) {
        response.destroy();
        validateResponse(status, contentType);
      }
      const encoding = response.headers['content-encoding']?.trim().toLowerCase() ?? 'identity';
      const decompressor =
        encoding === 'gzip'
          ? createGunzip()
          : encoding === 'br'
            ? createBrotliDecompress()
            : encoding === 'deflate'
              ? createInflate()
              : undefined;
      if (!decompressor && encoding !== 'identity' && encoding !== '') {
        response.destroy();
        throw new WebFetchError(
          'MAR_AGENT_WEB_FETCH_UNSUPPORTED_CONTENT',
          415,
          'Response content encoding is not supported.'
        );
      }
      const body = decompressor ?? response;
      let transferError: unknown;
      const transfer = decompressor
        ? pipeline(response, decompressor, { signal }).catch((error: unknown) => {
            transferError = error;
          })
        : undefined;
      const chunks: Buffer[] = [];
      let bytes = 0;
      let truncated = false;
      try {
        for await (const chunk of body) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
          const remaining = WEB_FETCH_MAX_BYTES - bytes;
          chunks.push(buffer.subarray(0, remaining));
          bytes += Math.min(remaining, buffer.byteLength);
          if (buffer.byteLength > remaining) {
            truncated = true;
            break;
          }
        }
      } finally {
        response.destroy();
        decompressor?.destroy();
        await transfer;
      }
      if (!truncated && transferError) throw transferError;
      signal.throwIfAborted();
      const text = new TextDecoder().decode(Buffer.concat(chunks), { stream: truncated });
      const output = Buffer.from(text);
      truncated ||= output.byteLength > WEB_FETCH_MAX_BYTES;
      const content = new TextDecoder().decode(output.subarray(0, WEB_FETCH_MAX_BYTES), {
        stream: truncated
      });
      return { content, data: { url: url.href, mode: 'http', status, contentType }, truncated };
    }
    throw new WebFetchError(
      'MAR_AGENT_WEB_FETCH_UPSTREAM_FAILED',
      502,
      'Too many web fetch redirects.'
    );
  }

  async #fetchBrowser(
    input: WebFetchRequest,
    signal: AbortSignal,
    allowUntrustedTls: boolean
  ): Promise<WebFetchResult> {
    if (this.#browserRequests >= MAX_BROWSER_REQUESTS)
      throw new WebFetchError(
        'MAR_AGENT_WEB_FETCH_BUSY',
        429,
        'Node web fetch browser capacity is exhausted.'
      );
    this.#browserRequests++;
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    let navigationFailure: WebFetchError | undefined;
    const cancel = () => {
      void browser?.close().catch(() => undefined);
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      try {
        browser = await this.#launchBrowser({
          headless: true,
          channel: 'chromium',
          timeout: 15_000
        });
      } catch {
        throw new WebFetchError(
          'MAR_AGENT_WEB_FETCH_BROWSER_UNAVAILABLE',
          503,
          'Node Chromium could not start. Prepare the matching runtime with the Node browser installation script under the service account. On Linux, check Chromium system libraries; an administrator may need to install them.'
        );
      }
      signal.throwIfAborted();
      context = await browser.newContext({
        acceptDownloads: false,
        ignoreHTTPSErrors: allowUntrustedTls,
        serviceWorkers: 'block'
      });
      let blockedNavigation = false;
      let resourceRequests = 0;
      await context.route('**/*', async (route) => {
        const request = route.request();
        resourceRequests++;
        const valid = webFetchRequestSchema.safeParse({
          url: request.url(),
          mode: 'browser'
        }).success;
        if (request.isNavigationRequest() && request.frame() === page.mainFrame() && !valid)
          blockedNavigation = true;
        try {
          if (
            !valid ||
            blockedNavigation ||
            resourceRequests > 128 ||
            ['image', 'media', 'font'].includes(request.resourceType())
          )
            await route.abort();
          else await route.continue();
        } catch {
          // A cancelled or closed page may invalidate an outstanding route.
        }
      });
      const page = await context.newPage();
      // Playwright routes see only the first request in an HTTP redirect chain.
      // Chromium interception validates every hop before any redirected request is sent.
      const cdp = await context.newCDPSession(page);
      const { frameTree } = await cdp.send('Page.getFrameTree');
      const mainFrameId: string = frameTree.frame.id;
      let navigationRequests = 0;
      let interceptedRequests = 0;
      cdp.on('Fetch.requestPaused', (event) => {
        const valid = webFetchRequestSchema.safeParse({
          url: event.request.url,
          mode: 'browser'
        }).success;
        const mainNavigation = event.resourceType === 'Document' && event.frameId === mainFrameId;
        if (mainNavigation) {
          navigationRequests++;
          if (!valid)
            navigationFailure = new WebFetchError(
              'MAR_AGENT_TOOL_INPUT_INVALID',
              400,
              'Page navigation URL is not supported.'
            );
          else if (navigationRequests > MAX_REDIRECTS + 1)
            navigationFailure = new WebFetchError(
              'MAR_AGENT_WEB_FETCH_UPSTREAM_FAILED',
              502,
              'Too many web fetch redirects.'
            );
        }
        const blocked = !valid || navigationFailure !== undefined || ++interceptedRequests > 128;
        void cdp
          .send(blocked ? 'Fetch.failRequest' : 'Fetch.continueRequest', {
            requestId: event.requestId,
            ...(blocked ? { errorReason: 'BlockedByClient' } : {})
          })
          .catch(() => {
            if (!signal.aborted && !page.isClosed()) {
              navigationFailure ??= new WebFetchError(
                'MAR_AGENT_WEB_FETCH_UPSTREAM_FAILED',
                502,
                'Browser request interception failed.'
              );
              cancel();
            }
          });
      });
      await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
      let navigationResponse: Response | undefined;
      page.on('response', (response) => {
        if (
          response.request().isNavigationRequest() &&
          response.request().frame() === page.mainFrame()
        )
          navigationResponse = response;
      });
      context.on('page', (other) => {
        if (other !== page) void other.close().catch(() => undefined);
      });
      page.on('dialog', (dialog) => {
        void dialog.dismiss().catch(() => undefined);
      });
      const response = await page.goto(input.url, {
        waitUntil: 'domcontentloaded',
        timeout: 25_000
      });
      if (!response)
        throw new WebFetchError(
          'MAR_AGENT_WEB_FETCH_UPSTREAM_FAILED',
          502,
          'Page navigation returned no response.'
        );
      navigationResponse ??= response;
      validateResponse(
        response.status(),
        (await response.allHeaders())['content-type'] ?? 'text/html'
      );
      // Wait for visible text to settle, not for long-lived network connections to become idle.
      const start = Date.now();
      let previous = '';
      let changedAt = start;
      let snapshot: { content: string; title: string; url: string; truncated: boolean } | undefined;
      while (Date.now() - start < 5_000) {
        signal.throwIfAborted();
        try {
          const current = await page.evaluate((maxBytes) => {
            const text = document.body?.innerText.trim() ?? '';
            const bytes = new TextEncoder().encode(text);
            return {
              url: location.href,
              title: document.title.slice(0, 1_000),
              content: new TextDecoder().decode(bytes.subarray(0, maxBytes), {
                stream: bytes.length > maxBytes
              }),
              truncated: bytes.length > maxBytes
            };
          }, WEB_FETCH_MAX_BYTES);
          snapshot = current;
        } catch (error) {
          if (page.isClosed() || signal.aborted || navigationFailure) throw error;
          // A client-side navigation can replace the evaluation context between snapshots.
          snapshot = undefined;
        }
        const identity = snapshot ? `${snapshot.url}\n${snapshot.content}` : '';
        if (identity !== previous) {
          previous = identity;
          changedAt = Date.now();
        }
        if (snapshot?.content && Date.now() - start >= 1_000 && Date.now() - changedAt >= 750)
          break;
        await delay(100, undefined, { signal });
      }
      signal.throwIfAborted();
      if (navigationFailure) throw navigationFailure;
      const finalUrl = page.url();
      if (
        blockedNavigation ||
        !webFetchRequestSchema.safeParse({ url: finalUrl, mode: 'browser' }).success
      )
        throw new WebFetchError(
          'MAR_AGENT_TOOL_INPUT_INVALID',
          400,
          'Page navigation URL is not supported.'
        );
      if (!snapshot?.content || snapshot.url !== finalUrl)
        throw new WebFetchError(
          'MAR_AGENT_WEB_FETCH_EMPTY_CONTENT',
          422,
          'The rendered page has no readable text.'
        );
      const contentType = (
        (await navigationResponse.allHeaders())['content-type'] ?? 'text/html'
      ).slice(0, 256);
      validateResponse(navigationResponse.status(), contentType);
      return {
        content: snapshot.content,
        data: {
          url: finalUrl,
          mode: 'browser',
          status: navigationResponse.status(),
          contentType,
          title: snapshot.title
        },
        truncated: snapshot.truncated
      };
    } catch (error) {
      if (navigationFailure) throw navigationFailure;
      throw error;
    } finally {
      signal.removeEventListener('abort', cancel);
      await context?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
      this.#browserRequests--;
    }
  }
}

function readableContentType(contentType: string): boolean {
  return /^(?:text\/|application\/(?:[\w.+-]+\+)?(?:json|xml)(?:[;\s]|$))/iu.test(contentType);
}

function upstreamFailure(
  error: unknown,
  mode: WebFetchRequest['mode'],
  phase: 'tls' | 'request' | 'response' | 'browser'
): WebFetchError {
  const upstreamCode =
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^[A-Z][A-Z0-9_]{0,79}$/u.test(error.code)
      ? error.code
      : undefined;
  const operation = {
    tls: 'TLS negotiation',
    request: 'the HTTP request',
    response: 'the HTTP response read',
    browser: 'the browser read'
  }[phase];
  return new WebFetchError(
    'MAR_AGENT_WEB_FETCH_UPSTREAM_FAILED',
    502,
    `Web fetch upstream failed during ${operation}${upstreamCode ? ` (${upstreamCode})` : ''}.`,
    { mode, phase, ...(upstreamCode ? { upstreamCode } : {}) }
  );
}

function validateResponse(status: number, contentType: string): void {
  if (status < 200 || status >= 300)
    throw new WebFetchError(
      'MAR_AGENT_WEB_FETCH_UPSTREAM_FAILED',
      502,
      'Web fetch upstream returned an HTTP error.',
      { upstreamStatus: status }
    );
  if (!readableContentType(contentType))
    throw new WebFetchError(
      'MAR_AGENT_WEB_FETCH_UNSUPPORTED_CONTENT',
      415,
      'Response is not readable text.'
    );
}

function requestHttp(
  url: URL,
  signal: AbortSignal,
  allowUntrustedTls: boolean
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    let phase: 'tls' | 'request' = 'request';
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        signal,
        headers: {
          accept: 'text/html,application/json,text/plain;q=0.9,*/*;q=0.1',
          'accept-encoding': 'identity',
          'user-agent': 'MyAgentRoam/0.9'
        },
        ...(url.protocol === 'https:' ? { rejectUnauthorized: !allowUntrustedTls } : {})
      },
      resolve
    );
    request.once('socket', (socket) => {
      if (socket instanceof TLSSocket && !request.reusedSocket) {
        socket.once('connect', () => {
          phase = 'tls';
        });
        socket.once('secureConnect', () => {
          phase = 'request';
        });
      }
    });
    request.once('error', (error: unknown) => reject(upstreamFailure(error, 'http', phase)));
    request.end();
  });
}

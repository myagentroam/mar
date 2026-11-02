import { setTimeout as delay } from 'node:timers/promises';
import { AgentError } from '@myagentroam/agent';
import {
  chromium,
  errors,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Response
} from 'playwright';
import { convertWebDocument } from './web-markdown.js';
import {
  WEB_FETCH_MAX_BYTES,
  browserFetchRequestSchema,
  type BrowserFetchRequest,
  type BrowserFetchResult
} from './web-fetch-contracts.js';

const TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const MAX_BROWSER_REQUESTS = 4;
const BROWSER_IDLE_MS = 30 * 60_000;
const BROWSER_MAX_AGE_MS = 60 * 60_000;

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
  readonly #active = new Set<Promise<BrowserFetchResult>>();
  readonly #allowUntrustedTls: boolean;
  readonly #launchBrowser: typeof chromium.launch;
  readonly #pendingContexts = new Set<Promise<unknown>>();
  #browser: Browser | undefined;
  #browserStartedAt: number | undefined;
  #launching: Promise<Browser> | undefined;
  #browserClosing: Promise<void> | undefined;
  #idle: ReturnType<typeof setTimeout> | undefined;
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
    input: BrowserFetchRequest,
    signal: AbortSignal,
    policy: { allowUntrustedTls?: boolean } = {}
  ): Promise<BrowserFetchResult> {
    const parsed = browserFetchRequestSchema.safeParse(input);
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
      throw upstreamFailure(error, 'browser', 'browser');
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
    if (this.#idle) clearTimeout(this.#idle);
    await Promise.allSettled([...this.#active]);
    await this.#launching?.catch(() => undefined);
    await Promise.allSettled([...this.#pendingContexts]);
    await this.#browserClosing;
    await this.#browser?.close().catch(() => undefined);
    this.#browser = undefined;
  }

  #scheduleIdle(): void {
    if (this.#shutdown.signal.aborted || this.#browserRequests || !this.#browser || this.#idle)
      return;
    if (this.#expired()) {
      this.#retireBrowser();
      return;
    }
    this.#idle = setTimeout(() => {
      this.#idle = undefined;
      if (this.#browserRequests || !this.#browser) return;
      this.#retireBrowser();
    }, BROWSER_IDLE_MS);
    this.#idle.unref();
  }

  #expired(): boolean {
    return (
      this.#browserStartedAt !== undefined &&
      Date.now() - this.#browserStartedAt >= BROWSER_MAX_AGE_MS
    );
  }

  #retireBrowser(): void {
    const browser = this.#browser;
    if (!browser) return;
    this.#browser = undefined;
    this.#browserStartedAt = undefined;
    const closing = browser
      .close()
      .catch(() => undefined)
      .finally(() => {
        if (this.#browserClosing === closing) this.#browserClosing = undefined;
      });
    this.#browserClosing = closing;
  }

  #getBrowser(): Promise<Browser> {
    if (this.#browserClosing)
      return this.#browserClosing.then(() => {
        this.#shutdown.signal.throwIfAborted();
        return this.#getBrowser();
      });
    if (this.#browser?.isConnected()) return Promise.resolve(this.#browser);
    if (!this.#launching) {
      const launching = this.#launchBrowser({
        headless: true,
        channel: 'chromium',
        timeout: 15_000
      })
        .then((browser) => {
          this.#browser = browser;
          this.#browserStartedAt = Date.now();
          browser.on('disconnected', () => {
            if (this.#browser === browser) {
              this.#browser = undefined;
              this.#browserStartedAt = undefined;
            }
          });
          return browser;
        })
        .finally(() => {
          this.#launching = undefined;
          this.#scheduleIdle();
        });
      this.#launching = launching;
    }
    return this.#launching;
  }

  async #execute(
    input: BrowserFetchRequest,
    signal: AbortSignal,
    allowUntrustedTls: boolean
  ): Promise<BrowserFetchResult> {
    signal.throwIfAborted();
    return this.#fetchBrowser(input, signal, allowUntrustedTls);
  }

  async #fetchBrowser(
    input: BrowserFetchRequest,
    signal: AbortSignal,
    allowUntrustedTls: boolean
  ): Promise<BrowserFetchResult> {
    if (this.#expired()) {
      if (this.#browserRequests > 0)
        throw new WebFetchError(
          'MAR_AGENT_WEB_FETCH_BUSY',
          429,
          'Node web fetch browser capacity is exhausted.'
        );
      if (this.#idle) clearTimeout(this.#idle);
      this.#idle = undefined;
      this.#retireBrowser();
    }
    if (this.#browserRequests >= MAX_BROWSER_REQUESTS)
      throw new WebFetchError(
        'MAR_AGENT_WEB_FETCH_BUSY',
        429,
        'Node web fetch browser capacity is exhausted.'
      );
    this.#browserRequests++;
    if (this.#idle) clearTimeout(this.#idle);
    this.#idle = undefined;
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    let navigationFailure: WebFetchError | undefined;
    const cancel = () => {
      void context?.close().catch(() => undefined);
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      try {
        browser = await abortable(this.#getBrowser(), signal);
      } catch {
        throw new WebFetchError(
          'MAR_AGENT_WEB_FETCH_BROWSER_UNAVAILABLE',
          503,
          'Node Chromium could not start. Prepare the matching runtime with the Node browser installation script under the service account. On Linux, check Chromium system libraries; an administrator may need to install them.'
        );
      }
      signal.throwIfAborted();
      const creatingContext = browser.newContext({
        acceptDownloads: false,
        ignoreHTTPSErrors: allowUntrustedTls,
        serviceWorkers: 'block'
      });
      const cleanup = creatingContext
        .then(
          async (created) => {
            if (signal.aborted) await created.close().catch(() => undefined);
          },
          () => undefined
        )
        .finally(() => this.#pendingContexts.delete(cleanup));
      this.#pendingContexts.add(cleanup);
      context = await abortable(creatingContext, signal);
      signal.throwIfAborted();
      let blockedNavigation = false;
      let resourceRequests = 0;
      await context.route('**/*', async (route) => {
        const request = route.request();
        resourceRequests++;
        const valid = browserFetchRequestSchema.safeParse({
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
      let mainResponse:
        { requestId: string; url: string; status: number; mimeType: string } | undefined;
      cdp.on('Network.responseReceived', (event) => {
        if (event.type === 'Document' && event.frameId === mainFrameId) {
          mainResponse = {
            requestId: event.requestId,
            url: event.response.url,
            status: event.response.status,
            mimeType: event.response.mimeType
          };
          if (!navigationFailure && !readableContentType(mainResponse.mimeType)) {
            try {
              validateResponse(mainResponse.status, mainResponse.mimeType);
            } catch (error) {
              if (error instanceof WebFetchError) navigationFailure = error;
            }
          }
        }
      });
      cdp.on('Fetch.requestPaused', (event) => {
        const valid = browserFetchRequestSchema.safeParse({
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
      await cdp.send('Network.enable');
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
      let response: Response | null;
      try {
        response = await page.goto(input.url, {
          waitUntil: 'domcontentloaded',
          timeout: 25_000
        });
      } catch (error) {
        if (navigationFailure) throw navigationFailure;
        if (!signal.aborted && mainResponse && !readableContentType(mainResponse.mimeType))
          validateResponse(mainResponse.status, mainResponse.mimeType);
        throw error;
      }
      if (!response)
        throw new WebFetchError(
          'MAR_AGENT_WEB_FETCH_UPSTREAM_FAILED',
          502,
          'Page navigation returned no response.'
        );
      navigationResponse ??= response;
      const initialContentType = (await response.allHeaders())['content-type'] ?? 'text/html';
      validateResponse(response.status(), initialContentType);
      if (!/^text\/html\b/iu.test(initialContentType))
        return await readTextResponse(response, initialContentType, mainResponse, cdp, signal);
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
        !browserFetchRequestSchema.safeParse({ url: finalUrl, mode: 'browser' }).success
      )
        throw new WebFetchError(
          'MAR_AGENT_TOOL_INPUT_INVALID',
          400,
          'Page navigation URL is not supported.'
        );
      if (!snapshot || snapshot.url !== finalUrl)
        throw new WebFetchError(
          'MAR_AGENT_WEB_FETCH_EMPTY_CONTENT',
          422,
          'The rendered page has no readable text.'
        );
      const contentType = (
        (await navigationResponse.allHeaders())['content-type'] ?? 'text/html'
      ).slice(0, 256);
      validateResponse(navigationResponse.status(), contentType);
      const html = /^text\/html\b/iu.test(contentType);
      if (!html)
        return await readTextResponse(navigationResponse, contentType, mainResponse, cdp, signal);
      if (!snapshot.content)
        throw new WebFetchError(
          'MAR_AGENT_WEB_FETCH_EMPTY_CONTENT',
          422,
          'The rendered page has no readable text.'
        );
      const source = html
        ? await page.evaluate((maxBytes) => {
            const original = document.body;
            if (!original) return { content: '', truncated: false };
            const clone = original.cloneNode(true) as HTMLElement;
            const originals = [original, ...original.querySelectorAll('*')];
            const copies = [clone, ...clone.querySelectorAll('*')];
            for (let i = originals.length - 1; i >= 0; i--) {
              const node = originals[i]!;
              const copy = copies[i]!;
              const style = getComputedStyle(node);
              if (
                ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(node.tagName) ||
                style.display === 'none'
              ) {
                if (i === 0) clone.replaceChildren();
                else copy.remove();
                continue;
              }
              if (style.visibility === 'hidden' || style.visibility === 'collapse') {
                // Descendants can override visibility; only this node's text is hidden.
                for (const child of [...copy.childNodes]) {
                  if (child.nodeType === Node.TEXT_NODE) child.remove();
                }
                if (copy.children.length === 0) {
                  if (i === 0) clone.replaceChildren();
                  else copy.remove();
                  continue;
                }
              }
              for (const attribute of ['href', 'src']) {
                const value = copy.getAttribute(attribute);
                if (value) {
                  try {
                    copy.setAttribute(attribute, new URL(value, document.baseURI).href);
                  } catch {
                    /* Keep original. */
                  }
                }
              }
            }
            const bytes = new TextEncoder().encode(clone.innerHTML);
            return {
              content: new TextDecoder().decode(bytes.subarray(0, maxBytes), {
                stream: bytes.length > maxBytes
              }),
              truncated: bytes.length > maxBytes
            };
          }, WEB_FETCH_MAX_BYTES)
        : { content: snapshot.content, truncated: snapshot.truncated };
      signal.throwIfAborted();
      const converted = convertWebDocument(source.content, html);
      if (!converted.content)
        throw new WebFetchError(
          'MAR_AGENT_WEB_FETCH_EMPTY_CONTENT',
          422,
          'The rendered page has no readable text.'
        );
      return {
        content: converted.content,
        data: {
          url: finalUrl,
          mode: 'browser',
          status: navigationResponse.status(),
          contentType,
          title: snapshot.title
        },
        truncated: source.truncated || converted.truncated
      };
    } catch (error) {
      if (navigationFailure) throw navigationFailure;
      throw error;
    } finally {
      signal.removeEventListener('abort', cancel);
      await context?.close().catch(() => undefined);
      this.#browserRequests--;
      this.#scheduleIdle();
    }
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function readTextResponse(
  response: Response,
  contentType: string,
  navigation: { requestId: string; url: string } | undefined,
  cdp: CDPSession,
  signal: AbortSignal
): Promise<BrowserFetchResult> {
  const failure = await abortable(response.finished(), signal);
  if (failure) throw failure;
  if (!navigation || navigation.url !== response.url())
    throw new Error('BROWSER_RESPONSE_UNAVAILABLE');
  // Response.body() can re-request an empty response; use this navigation only.
  const body = await abortable(
    cdp.send('Network.getResponseBody', { requestId: navigation.requestId }),
    signal
  );
  const bytes = Buffer.from(body.body, body.base64Encoded ? 'base64' : 'utf8');
  signal.throwIfAborted();
  const charset = body.base64Encoded
    ? (/charset\s*=\s*["']?([^\s;"']+)/iu.exec(contentType)?.[1] ?? 'utf-8')
    : 'utf-8';
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    decoder = new TextDecoder('utf-8');
  }
  const sourceTruncated = bytes.length > WEB_FETCH_MAX_BYTES;
  const text = decoder.decode(bytes.subarray(0, WEB_FETCH_MAX_BYTES), {
    stream: sourceTruncated
  });
  const converted = convertWebDocument(text, false);
  if (!converted.content)
    throw new WebFetchError(
      'MAR_AGENT_WEB_FETCH_EMPTY_CONTENT',
      422,
      'The rendered page has no readable text.'
    );
  return {
    content: converted.content,
    data: {
      url: response.url(),
      mode: 'browser',
      status: response.status(),
      contentType: contentType.slice(0, 256)
    },
    truncated: sourceTruncated || converted.truncated
  };
}

function readableContentType(contentType: string): boolean {
  return /^(?:text\/|application\/(?:[\w.+-]+\+)?(?:json|xml)(?:[;\s]|$))/iu.test(contentType);
}

function upstreamFailure(
  error: unknown,
  mode: BrowserFetchRequest['mode'],
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

import { MarAgentError } from '../error.js';
import type {
  CoreHttpRequest,
  CoreHttpResponse,
  CoreNetworkBackend
} from '../extensions/network.js';
import type { CoreOperationContext } from '../extensions/operation.js';

/** Raw HTTP transport; presentation, retries, and browser fetch remain separate tools. */
export class LocalNetworkAccess implements CoreNetworkBackend {
  async fetch(input: CoreHttpRequest, call: CoreOperationContext): Promise<CoreHttpResponse> {
    call.signal.throwIfAborted();
    if (!input || typeof input.url !== 'string')
      throw new MarAgentError('MAR_AGENT_NETWORK_REQUEST_INVALID', 'HTTP URL is required.');
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      throw new MarAgentError('MAR_AGENT_NETWORK_REQUEST_INVALID', 'HTTP URL is invalid.');
    }
    if (!['http:', 'https:'].includes(url.protocol))
      throw new MarAgentError(
        'MAR_AGENT_NETWORK_REQUEST_INVALID',
        'An HTTP or HTTPS URL is required.'
      );
    const controller = new AbortController();
    const signal = AbortSignal.any([
      call.signal,
      controller.signal,
      ...(input.signal ? [input.signal] : [])
    ]);
    let response: Response;
    try {
      response = await globalThis.fetch(url, {
        ...(input.method === undefined ? {} : { method: input.method }),
        ...(input.headers === undefined
          ? {}
          : {
              headers: input.headers.map(([name, value]): [string, string] => [name, value])
            }),
        ...(input.body === undefined
          ? {}
          : { body: typeof input.body === 'string' ? input.body : Buffer.from(input.body) }),
        ...(input.redirect === undefined ? {} : { redirect: input.redirect }),
        signal
      });
    } catch (error) {
      signal.throwIfAborted();
      const cause =
        error && typeof error === 'object'
          ? (error as { cause?: { code?: unknown } }).cause
          : undefined;
      throw new MarAgentError('MAR_AGENT_NETWORK_FAILED', 'HTTP request failed.', {
        ...(typeof cause?.code === 'string' ? { details: { reasonCode: cause.code } } : {})
      });
    }
    const reader = response.body?.getReader();
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closing ??= (async () => {
        signal.removeEventListener('abort', onAbort);
        controller.abort();
        try {
          await reader?.cancel();
        } catch (error) {
          // An already-aborted Fetch reader rejects cancel with that same cancellation reason.
          if (!signal.aborted || error !== signal.reason) throw error;
        } finally {
          reader?.releaseLock();
        }
      })();
      return closing;
    };
    const onAbort = () => {
      void close().catch(() => undefined);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      await close();
      signal.throwIfAborted();
    }
    const body = async function* (): AsyncIterable<Uint8Array> {
      try {
        while (reader) {
          signal.throwIfAborted();
          const next = await reader.read();
          signal.throwIfAborted();
          if (next.done) return;
          yield next.value;
        }
      } finally {
        await close();
      }
    };
    return {
      url: response.url,
      status: response.status,
      statusText: response.statusText,
      redirected: response.redirected,
      headers: [...response.headers.entries()],
      body: body(),
      close
    };
  }
}

import { AgentError, countModelTokens, type ToolExecutionResult } from '@myagentroam/agent';
import { z } from 'zod';
import type { NodeConfig } from '../config.js';
import { readWebSearchError } from './web-search-error.js';
import { WebFetchError, WebFetchService } from './web-fetch-service.js';
import { browserFetchResultSchema, type WebFetchRequest } from './web-fetch-contracts.js';
import { WebSnapshots } from './web-snapshots.js';

const WEB_FETCH_REQUEST_FAILURES = new Set([
  'MAR_AGENT_WEB_FETCH_UPSTREAM_FAILED',
  'MAR_AGENT_WEB_FETCH_TIMEOUT',
  'MAR_AGENT_WEB_FETCH_UNSUPPORTED_CONTENT',
  'MAR_AGENT_WEB_FETCH_EMPTY_CONTENT'
]);

/** Owns Node web reads and the authenticated Server search adapter. */
export class WebToolService {
  readonly #config: () => NodeConfig | undefined;
  readonly #request: typeof fetch;
  readonly #fetcher: WebFetchService;
  readonly #snapshots = new WebSnapshots();
  readonly #pending = new Map<string, Set<AbortController>>();
  #closed = false;

  constructor(config: () => NodeConfig | undefined, request: typeof fetch = fetch) {
    this.#config = config;
    this.#request = request;
    this.#fetcher = new WebFetchService();
  }

  webSearch(
    input: { query: string; maxResults: number; maxTokens?: number },
    signal: AbortSignal
  ): Promise<ToolExecutionResult> {
    return this.#execute(input, signal);
  }

  webFetch = async (
    input: WebFetchRequest,
    signal: AbortSignal,
    scope: string,
    allowUntrustedTls?: boolean
  ): Promise<ToolExecutionResult> => {
    signal.throwIfAborted();
    if (this.#closed)
      throw new AgentError('MAR_AGENT_WEB_FETCH_CANCELLED', 'Web service is closed.');
    if (input.action === 'find')
      return this.#snapshots.find(scope, input.ref, input.pattern, input.maxTokens);
    if ('ref' in input)
      return this.#snapshots.open(scope, input.ref, {
        maxTokens: input.maxTokens,
        ...(input.line === undefined ? {} : { line: input.line }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor })
      });
    const controller = new AbortController();
    const pending = this.#pending.get(scope) ?? new Set<AbortController>();
    this.#pending.set(scope, pending);
    pending.add(controller);
    const combined = AbortSignal.any([signal, controller.signal]);
    let result;
    try {
      result = await this.#fetcher.fetch({ url: input.url, mode: 'browser' }, combined, {
        ...(allowUntrustedTls === undefined ? {} : { allowUntrustedTls })
      });
      combined.throwIfAborted();
    } catch (error) {
      if (
        combined.aborted ||
        !(error instanceof WebFetchError) ||
        !WEB_FETCH_REQUEST_FAILURES.has(error.code)
      )
        throw error;
      const data = {
        error: error.code,
        message: error.publicMessage,
        ...(error.publicParameters ? { details: error.publicParameters } : {})
      };
      return { content: JSON.stringify(data), data, eventData: data };
    } finally {
      pending.delete(controller);
      if (pending.size === 0) this.#pending.delete(scope);
    }
    const parsed = browserFetchResultSchema.safeParse(result);
    if (!parsed.success)
      throw new AgentError('MAR_AGENT_WEB_FETCH_FAILED', 'Web fetch returned an invalid result.');
    signal.throwIfAborted();
    if (this.#closed)
      throw new AgentError('MAR_AGENT_WEB_FETCH_CANCELLED', 'Web service is closed.');
    const { content, data, truncated } = parsed.data;
    const ref = this.#snapshots.add(scope, {
      content,
      url: data.url,
      status: data.status,
      contentType: data.contentType,
      ...(data.title === undefined ? {} : { title: data.title }),
      sourceTruncated: truncated
    });
    return this.#snapshots.open(scope, ref, { maxTokens: input.maxTokens });
  };

  clearSession(scope: string): void {
    for (const controller of this.#pending.get(scope) ?? []) controller.abort();
    this.#snapshots.clearScope(scope);
  }

  clearHostedStorage(storage: string): void {
    for (const [scope, controllers] of this.#pending) {
      try {
        const parts: unknown = JSON.parse(scope);
        if (Array.isArray(parts) && parts[0] === 'hosted' && parts[1] === storage)
          for (const controller of controllers) controller.abort();
      } catch {
        /* Ignore unrelated scopes. */
      }
    }
    this.#snapshots.clearHostedStorage(storage);
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#fetcher.close();
    this.#snapshots.clear();
  }

  async #execute(
    input: { query: string; maxResults: number; maxTokens?: number },
    signal: AbortSignal
  ): Promise<ToolExecutionResult> {
    signal.throwIfAborted();
    if (this.#closed) throw new AgentError('MAR_AGENT_WEB_SEARCH_FAILED', 'Web service is closed.');
    const config = this.#config();
    if (config?.nodeId === undefined || config.credential === undefined)
      throw new Error('NODE_UNAUTHENTICATED');
    try {
      const response = await this.#request(
        `${config.serverUrl.replace(/\/$/u, '')}/api/node-tools/web-search`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-mar-node-id': config.nodeId,
            authorization: `Bearer ${config.credential}`
          },
          body: JSON.stringify({ query: input.query, maxResults: input.maxResults }),
          signal
        }
      );
      if (!response.ok) throw await readWebSearchError(response);
      let result: unknown;
      try {
        result = await response.json();
      } catch {
        throw invalidResult();
      }
      const parsed = z
        .object({
          query: z.string().max(500),
          results: z
            .array(z.object({ title: z.string(), url: z.string().max(8192), snippet: z.string() }))
            .max(10)
        })
        .safeParse(result);
      if (!parsed.success) throw invalidResult();
      const budget = input.maxTokens ?? 2000;
      let snippetLimit = 2000;
      let metadataLimit = 8192;
      let results = parsed.data.results;
      let content = '';
      let truncated = false;
      do {
        results = parsed.data.results.map((item) => ({
          title: clip(item.title, metadataLimit),
          url: clip(item.url, metadataLimit),
          snippet: clip(item.snippet, snippetLimit)
        }));
        truncated = results.some(
          (item, i) =>
            item.title !== parsed.data.results[i]!.title ||
            item.url !== parsed.data.results[i]!.url ||
            item.snippet !== parsed.data.results[i]!.snippet
        );
        content =
          `Search results${truncated ? ' (truncated)' : ''}:\n` +
          results
            .map(
              (item, i) =>
                `${i + 1}. ${item.title}\nURL: ${item.url}\nSearch snippet: ${item.snippet}`
            )
            .join('\n');
        if (snippetLimit > 0) snippetLimit = snippetLimit <= 32 ? 0 : Math.floor(snippetLimit / 2);
        else metadataLimit = Math.floor(metadataLimit / 2);
      } while (countModelTokens(content) > budget && metadataLimit >= 32);
      if (countModelTokens(content) > budget) throw invalidResult();
      const data = {
        query: parsed.data.query,
        results: results.map((item, index) => ({
          ...item,
          url: parsed.data.results[index]!.url
        })),
        truncated
      };
      return {
        content,
        data,
        eventData: { ...data, sourcesOnly: true },
        truncated
      };
    } catch (error) {
      if (error instanceof AgentError || signal.aborted) throw error;
      throw new AgentError('MAR_AGENT_WEB_SEARCH_FAILED', 'Web search failed.', {
        cause: error
      });
    }
  }
}

function clip(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return value ? '…' : '';
  const bytes = Buffer.from(value);
  return bytes.length <= maxBytes
    ? value
    : `${new TextDecoder().decode(bytes.subarray(0, maxBytes - 3), { stream: true })}…`;
}

function invalidResult(): AgentError {
  return new AgentError('MAR_AGENT_WEB_SEARCH_FAILED', 'Web search returned an invalid result.');
}

import { MarAgentError, type ToolExecutionResult } from '@myagentroam/agent';
import type { NodeConfig } from '../config.js';
import { readWebSearchError } from './web-search-error.js';
import { WebFetchService } from './web-fetch-service.js';
import { webFetchResultSchema, type WebFetchRequest } from './web-fetch-contracts.js';

/** Owns Node web reads and the authenticated Server search adapter. */
export class WebToolService {
  readonly #config: () => NodeConfig | undefined;
  readonly #request: typeof fetch;
  readonly #fetcher: WebFetchService;

  constructor(config: () => NodeConfig | undefined, request: typeof fetch = fetch) {
    this.#config = config;
    this.#request = request;
    this.#fetcher = new WebFetchService();
  }

  webSearch(
    input: { query: string; maxResults: number },
    signal: AbortSignal
  ): Promise<ToolExecutionResult> {
    return this.#execute(input, signal);
  }

  webFetch = async (input: WebFetchRequest, signal: AbortSignal, allowUntrustedTls?: boolean) => {
    const result = await this.#fetcher.fetch(input, signal, {
      ...(allowUntrustedTls === undefined ? {} : { allowUntrustedTls })
    });
    const parsed = webFetchResultSchema.safeParse(result);
    if (!parsed.success)
      throw new MarAgentError(
        'MAR_AGENT_WEB_FETCH_FAILED',
        'Web fetch returned an invalid result.'
      );
    return parsed.data;
  };

  close(): Promise<void> {
    return this.#fetcher.close();
  }

  async #execute(input: unknown, signal: AbortSignal): Promise<ToolExecutionResult> {
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
          body: JSON.stringify(input),
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
      if (result === null || typeof result !== 'object') throw invalidResult();
      const content = JSON.stringify(result);
      if (content === undefined) throw invalidResult();
      return { content, data: result };
    } catch (error) {
      if (error instanceof MarAgentError || signal.aborted) throw error;
      throw new MarAgentError('MAR_AGENT_WEB_SEARCH_FAILED', 'Web search failed.', {
        cause: error
      });
    }
  }
}

function invalidResult(): MarAgentError {
  return new MarAgentError('MAR_AGENT_WEB_SEARCH_FAILED', 'Web search returned an invalid result.');
}

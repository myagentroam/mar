import type { FastifyInstance } from 'fastify';
import { sendError } from './http-errors.js';

export function registerWebSearchRoutes(input: {
  app: FastifyInstance;
  database: { authenticateNode(nodeId: string, credential: string): unknown | Promise<unknown> };
  endpoint: string;
  request?: typeof fetch;
}): void {
  input.app.post<{ Body: { query?: unknown; maxResults?: unknown } }>(
    '/api/node-tools/web-search',
    async (request, reply) => {
      const nodeId = request.headers['x-mar-node-id'];
      const authorization = request.headers.authorization;
      if (
        typeof nodeId !== 'string' ||
        !authorization?.startsWith('Bearer ') ||
        (await input.database.authenticateNode(nodeId, authorization.slice(7))) === undefined
      )
        return sendError(reply, 401, 'NODE_UNAUTHENTICATED');
      const query = request.body?.query;
      if (typeof query !== 'string' || query.trim().length === 0 || query.length > 500)
        return sendError(reply, 400, 'WEB_SEARCH_INVALID');
      const maxResults =
        typeof request.body.maxResults === 'number'
          ? Math.min(10, Math.max(1, Math.trunc(request.body.maxResults)))
          : 8;
      try {
        const url = new URL('/search', input.endpoint);
        url.searchParams.set('q', query.trim());
        url.searchParams.set('format', 'json');
        const upstream = await (input.request ?? fetch)(url, {
          signal: AbortSignal.timeout(25_000)
        });
        if (!upstream.ok)
          return sendError(reply, 502, 'WEB_SEARCH_UPSTREAM_FAILED', {
            parameters: { upstreamStatus: upstream.status }
          });
        const body = (await upstream.json()) as {
          results?: Array<{ title?: unknown; url?: unknown; content?: unknown }>;
        };
        const results = (body.results ?? [])
          .filter((item) => typeof item.url === 'string')
          .slice(0, maxResults)
          .map((item) => ({
            title: typeof item.title === 'string' ? item.title : '',
            url: item.url as string,
            snippet: typeof item.content === 'string' ? item.content.slice(0, 2_000) : ''
          }));
        return reply.send({ query: query.trim(), results });
      } catch (error) {
        const details = upstreamFailureDetails(error);
        return sendError(reply, 502, 'WEB_SEARCH_UPSTREAM_FAILED', {
          ...(details === undefined ? {} : { details })
        });
      }
    }
  );
}

function upstreamFailureDetails(error: unknown): string | undefined {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && !seen.has(current) && messages.length < 3) {
    seen.add(current);
    if (current instanceof Error && current.message.trim().length > 0)
      messages.push(current.message.trim());
    current =
      current !== null && typeof current === 'object' && 'cause' in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return messages.length === 0 ? undefined : messages.join(' Caused by: ');
}

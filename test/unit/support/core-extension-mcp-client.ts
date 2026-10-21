import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type {
  CoreMcpBackend,
  CoreOperationContext,
  CoreMcpToolCall
} from '../../../mar-agent/src/index.js';
import {
  MarAgentMcpClientCache,
  type MarAgentMcpClientLease
} from '../../../mar-node/src/runner/mar-agent/mcp-client-pool.js';
import type { ResolvedMcpServer } from '../../../mar-node/src/mcp/model.js';

// Resolve the application's installed server SDK, without adding a Core dependency.
const appRequire = createRequire(resolve('mar-node/package.json'));
const { McpServer } = appRequire(
  '@modelcontextprotocol/sdk/server/mcp.js'
) as typeof import('../../../mar-node/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js');
const { StreamableHTTPServerTransport } = appRequire(
  '@modelcontextprotocol/sdk/server/streamableHttp.js'
) as typeof import('../../../mar-node/node_modules/@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.js');
const { z } = appRequire('zod') as typeof import('../../../mar-node/node_modules/zod/index.js');

export function stdioDefinition(): ResolvedMcpServer {
  return {
    name: 'extension echo',
    transport: 'STDIO',
    lifecycle: 'SHARED',
    authorizationIdentity: 'isolated-extension-fixture',
    command: process.execPath,
    args: [resolve('mar-node/test/support/mar-agent-mcp-server.mjs')]
  };
}

/** Test-only application composition. No Client, loop, writer, or transport is duplicated. */
export function mcpLeasePort(cwd: () => string) {
  const cache = new MarAgentMcpClientCache();
  const leases: MarAgentMcpClientLease[] = [];
  const calls: Array<{ input: CoreMcpToolCall; operation: CoreOperationContext }> = [];
  let released = 0;
  const port: CoreMcpBackend = {
    async connect(definition, operation) {
      operation.signal.throwIfAborted();
      const lease = await cache.acquire(
        [definition.configuration as unknown as ResolvedMcpServer],
        cwd(),
        { authorizationScope: cwd() }
      );
      leases.push(lease);
      let closed = false;
      return {
        async catalog(call) {
          call.signal.throwIfAborted();
          await lease.pool.refreshForExecution();
          call.signal.throwIfAborted();
          // A failed refresh leaves the Client's last authoritative snapshot in place.
          return lease.pool.catalog();
        },
        async call(input, call) {
          calls.push({ input, operation: call });
          return lease.pool.call(input.name, input.arguments, call.signal, input.expectedTool);
        },
        async close() {
          if (closed) return;
          closed = true;
          released++;
          await lease.release();
        }
      };
    }
  };
  return { port, cache, leases, calls, released: () => released, close: () => cache.close() };
}

export async function httpMcpFixture() {
  const server = new McpServer({ name: 'core-extension-http', version: '1.0.0' });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
  const calls: string[] = [];
  let enter!: () => void;
  let abort!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const cancelled = new Promise<void>((resolve) => {
    abort = resolve;
  });
  const echo = server.registerTool(
    'echo',
    { description: 'Echo original bytes as text.', inputSchema: { value: z.string() } },
    async ({ value }) => {
      calls.push(value);
      return { content: [{ type: 'text' as const, text: value }] };
    }
  );
  server.registerTool(
    'gate',
    { description: 'Wait for actual request cancellation.' },
    async (extra) => {
      enter();
      await new Promise<void>((resolve) => {
        const finish = () => {
          abort();
          resolve();
        };
        if (extra.signal.aborted) finish();
        else extra.signal.addEventListener('abort', finish, { once: true });
      });
      return { content: [{ type: 'text' as const, text: 'cancelled' }] };
    }
  );
  // The official declarations widen optional callbacks beyond exactOptionalPropertyTypes.
  await server.connect(transport as Parameters<typeof server.connect>[0]);
  const http = createServer((request, response) => {
    void transport.handleRequest(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', resolve);
  });
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Missing isolated HTTP address.');
  return {
    definition: {
      name: 'extension HTTP',
      transport: 'HTTP' as const,
      lifecycle: 'SHARED' as const,
      url: `http://127.0.0.1:${address.port}/mcp`,
      authorizationIdentity: 'isolated-extension-fixture'
    },
    calls,
    entered,
    cancelled,
    update: (description: string) => echo.update({ description }),
    async close() {
      await server.close();
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve()))
      );
    }
  };
}

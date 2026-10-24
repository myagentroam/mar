import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  MarAgentMcpClientCache,
  MarAgentMcpClientPool
} from '../../src/runner/mar-agent/mcp-client-pool.js';

async function fixture(serverCount = 5) {
  let active = 0;
  let maximum = 0;
  let initializeCount = 0;
  let listCount = 0;
  let pendingLists = 0;
  let malformed = false;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    let text = '';
    for await (const chunk of request) text += String(chunk);
    const input = JSON.parse(text) as {
      id?: number;
      method: string;
      params?: { protocolVersion?: string; cursor?: string };
    };
    if (input.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    let result: unknown;
    if (input.method === 'initialize') {
      initializeCount++;
      active++;
      maximum = Math.max(maximum, active);
      if (active === Math.min(4, serverCount)) release();
      await barrier;
      active--;
      result = {
        protocolVersion: input.params?.protocolVersion,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'fixture', version: '1', title: 'Production records' },
        instructions: 'Discover production records.'
      };
    } else if (input.method === 'tools/list') {
      listCount++;
      pendingLists++;
      result = {
        tools: [
          {
            name: input.params?.cursor ? 'read_record' : 'find_record',
            description: 'Find production records',
            inputSchema: { type: 'object', properties: {} }
          }
        ],
        ...(!input.params?.cursor || malformed ? { nextCursor: 'second' } : {})
      };
    } else result = {};
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result }), () => {
      if (input.method === 'tools/list') pendingLists--;
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture address unavailable');
  return {
    servers: Array.from({ length: serverCount }, (_, index) => ({
      name: `records${index}`,
      transport: 'HTTP' as const,
      url: `http://127.0.0.1:${address.port}/mcp/${index}`
    })),
    stats: () => ({ maximum, initializeCount, listCount }),
    pendingLists: () => pendingLists,
    malformed: () => {
      malformed = true;
    },
    release,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

describe('HTTP MCP catalog', () => {
  it('does not forward credentials to a cross-origin redirect target', async () => {
    let receivedCredential: string | undefined;
    const target = createServer((request, response) => {
      receivedCredential = request.headers['x-mar-credential'] as string | undefined;
      response.writeHead(500).end();
    });
    target.listen(0, '127.0.0.1');
    await once(target, 'listening');
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress === 'string')
      throw new Error('Fixture address unavailable');
    const redirect = createServer((_request, response) => {
      response.writeHead(302, { location: `http://127.0.0.1:${targetAddress.port}/mcp` }).end();
    });
    redirect.listen(0, '127.0.0.1');
    await once(redirect, 'listening');
    const address = redirect.address();
    if (!address || typeof address === 'string') throw new Error('Fixture address unavailable');
    try {
      await expect(
        MarAgentMcpClientPool.connect(
          [
            {
              name: 'records',
              transport: 'HTTP',
              url: `http://127.0.0.1:${address.port}/mcp`,
              headers: { 'x-mar-credential': 'fixture-secret' }
            }
          ],
          '/fixture'
        )
      ).rejects.toThrow();
      expect(receivedCredential).toBeUndefined();
    } finally {
      redirect.closeAllConnections();
      target.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => redirect.close(() => resolve())),
        new Promise<void>((resolve) => target.close(() => resolve()))
      ]);
    }
  });

  it('initializes four servers concurrently and refreshes the warm catalog for each execution boundary', async () => {
    const f = await fixture();
    const cache = new MarAgentMcpClientCache();
    try {
      const first = await cache.acquire(f.servers, '/fixture', { authorizationScope: 'actor-one' });
      expect(f.stats()).toEqual({ maximum: 4, initializeCount: 5, listCount: 10 });
      expect(first.pool.definitions()).toHaveLength(10);
      expect(first.pool.catalog().servers[0]?.instructions).toBe('Discover production records.');
      expect(first.pool.catalog().tools.every((tool) => tool.exposure === 'deferred')).toBe(true);
      await first.pool.refreshForExecution();
      expect(f.stats().listCount).toBe(10);
      await first.pool.refreshForExecution();
      expect(f.stats().listCount).toBe(20);
      const second = await cache.acquire(f.servers, '/fixture', {
        authorizationScope: 'actor-one'
      });
      expect(second.pool).toBe(first.pool);
      expect(f.stats().initializeCount).toBe(5);
      expect(f.stats().listCount).toBe(20);
      await first.release();
      await second.release();
    } finally {
      f.release();
      await cache.close();
      await f.close();
    }
  });

  it('preserves a previous complete catalog when a refresh has repeated cursors', async () => {
    const f = await fixture();
    let pool: MarAgentMcpClientPool | undefined;
    try {
      pool = await MarAgentMcpClientPool.connect(f.servers, '/fixture');
      const before = pool.catalog();
      await pool.refreshForExecution();
      f.malformed();
      await expect(pool.refreshForExecution()).resolves.toBeUndefined();
      await vi.waitFor(() => expect(f.pendingLists()).toBe(0));
      expect(pool.catalog()).toEqual(before);
      await pool.close();
      expect(before.tools).toHaveLength(10);
    } finally {
      vi.restoreAllMocks();
      f.release();
      await pool?.close();
      await f.close();
    }
  });

  it('keeps source identity stable across same-principal token rotation but isolates actors and unknown pools', async () => {
    const f = await fixture(1);
    const cache = new MarAgentMcpClientCache();
    const leases: Array<{ pool: MarAgentMcpClientPool; release(): Promise<void> }> = [];
    const base = f.servers[0]!;
    try {
      const original = await cache.acquire(
        [
          {
            ...base,
            sourceIdentity: 'configured-installation',
            authorizationIdentity: 'actor-one',
            headers: { authorization: 'fixture-token-a' }
          }
        ],
        '/fixture',
        { authorizationScope: 'scope-one' }
      );
      leases.push(original);
      const rotated = await cache.acquire(
        [
          {
            ...base,
            sourceIdentity: 'configured-installation',
            authorizationIdentity: 'actor-one',
            headers: { authorization: 'fixture-token-b' }
          }
        ],
        '/fixture',
        { authorizationScope: 'scope-one' }
      );
      leases.push(rotated);
      expect(rotated.pool).not.toBe(original.pool);
      expect(rotated.pool.catalog().tools[0]?.sourceIdentity).toBe(
        original.pool.catalog().tools[0]?.sourceIdentity
      );

      const otherScope = await cache.acquire(
        [
          {
            ...base,
            sourceIdentity: 'configured-installation',
            authorizationIdentity: 'actor-one',
            headers: { authorization: 'fixture-token-b' }
          }
        ],
        '/fixture',
        { authorizationScope: 'scope-two' }
      );
      leases.push(otherScope);
      expect(otherScope.pool.catalog().tools[0]?.sourceIdentity).not.toBe(
        rotated.pool.catalog().tools[0]?.sourceIdentity
      );

      const otherActor = await cache.acquire(
        [
          {
            ...base,
            sourceIdentity: 'configured-installation',
            authorizationIdentity: 'actor-two',
            headers: { authorization: 'fixture-token-b' }
          }
        ],
        '/fixture',
        { authorizationScope: 'scope-one' }
      );
      leases.push(otherActor);
      expect(otherActor.pool.catalog().tools[0]?.sourceIdentity).not.toBe(
        rotated.pool.catalog().tools[0]?.sourceIdentity
      );

      const unknown = { name: base.name, transport: base.transport, url: base.url };
      const unknownFirst = await MarAgentMcpClientPool.connect([unknown], '/fixture', {
        authorizationScope: 'unknown-scope'
      });
      const unknownSecond = await MarAgentMcpClientPool.connect([unknown], '/fixture', {
        authorizationScope: 'unknown-scope'
      });
      try {
        expect(unknownFirst.catalog().tools[0]?.sourceIdentity).not.toBe(
          unknownSecond.catalog().tools[0]?.sourceIdentity
        );
      } finally {
        await Promise.all([unknownFirst.close(), unknownSecond.close()]);
      }
    } finally {
      await Promise.all(leases.map((lease) => lease.release()));
      await cache.close();
      await f.close();
    }
  });

  it('preserves a stable definition-change code at the MCP call boundary', async () => {
    const f = await fixture(1);
    let pool: MarAgentMcpClientPool | undefined;
    try {
      pool = await MarAgentMcpClientPool.connect([f.servers[0]!], '/fixture');
      const tool = pool.catalog().tools[0]!;
      await expect(
        pool.call(tool.definition.name, {}, undefined, {
          sourceIdentity: tool.sourceIdentity,
          definitionRevision: 'stale-definition'
        })
      ).rejects.toMatchObject({ code: 'MAR_AGENT_MCP_TOOL_DEFINITION_CHANGED' });
    } finally {
      await pool?.close();
      await f.close();
    }
  });
});

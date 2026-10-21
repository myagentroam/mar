import { mcpNameAlias, NODE_MCP_CLIENT_INFO } from '../../mcp/naming.js';
import { createHash, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type {
  ClientToolDefinition,
  McpToolCatalog,
  McpCatalogTool,
  McpToolCallContext,
  LocalProcessExecutor,
  ToolExecutionResult
} from '@myagentroam/agent';
import { assertMcpToolDefinition, assertMcpToolCatalog, MarAgentError } from '@myagentroam/agent';
import type { ResolvedMcpServer } from '../../mcp/model.js';
import { canonicalJson } from '../../util/canonical-json.js';
import { ExecutorStdioClientTransport } from './executor-stdio-client-transport.js';

interface ToolBinding {
  client: Client;
  nativeName: string;
  metadata: McpCatalogTool;
}

interface CachedPool {
  readonly promise: Promise<MarAgentMcpClientPool>;
  references: number;
  lastReleasedAt: number;
  timer?: NodeJS.Timeout;
}

export interface MarAgentMcpClientLease {
  readonly pool: MarAgentMcpClientPool;
  release(): Promise<void>;
}

export interface MarAgentMcpProcessOptions {
  readonly processExecutor?: LocalProcessExecutor;
  readonly owner?: { readonly sessionId: string; readonly executionId: string };
  readonly authorizationScope?: string;
}

export class MarAgentMcpClientCache {
  readonly #entries = new Map<string, CachedPool>();
  readonly #idleTtlMs: number;
  readonly #maxEntries: number;
  #closed = false;

  constructor(options: { readonly idleTtlMs?: number; readonly maxEntries?: number } = {}) {
    this.#idleTtlMs = options.idleTtlMs ?? 5 * 60_000;
    this.#maxEntries = options.maxEntries ?? 16;
  }

  async acquire(
    servers: readonly ResolvedMcpServer[],
    cwd: string,
    options: {
      readonly reusable?: boolean;
      readonly authorizationScope?: string;
      readonly processExecutor?: LocalProcessExecutor;
      readonly owner?: { readonly sessionId: string; readonly executionId: string };
    } = {}
  ): Promise<MarAgentMcpClientLease> {
    if (this.#closed) throw new Error('MAR_AGENT_MCP_CACHE_CLOSED');
    if (options.processExecutor !== undefined && options.reusable !== false)
      throw new Error('MAR_AGENT_MCP_SANDBOX_REUSE_INVALID');
    if (options.reusable === false) {
      const pool = await MarAgentMcpClientPool.connect(servers, cwd, options);
      return singleUseLease(pool);
    }
    const key = mcpConfigurationFingerprint(servers, cwd, options.authorizationScope);
    let entry = this.#entries.get(key);
    if (entry === undefined) {
      await this.#evictIdleEntry();
      if (this.#entries.size >= this.#maxEntries) {
        const pool = await MarAgentMcpClientPool.connect(servers, cwd, options);
        return singleUseLease(pool);
      }
      entry = {
        promise: MarAgentMcpClientPool.connect(servers, cwd, options),
        references: 0,
        lastReleasedAt: 0
      };
      this.#entries.set(key, entry);
      entry.promise.catch(() => {
        if (this.#entries.get(key) === entry) this.#entries.delete(key);
      });
    }
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
      delete entry.timer;
    }
    entry.references += 1;
    let pool: MarAgentMcpClientPool;
    try {
      pool = await entry.promise;
    } catch (error) {
      entry.references -= 1;
      throw error;
    }
    let released = false;
    return {
      pool,
      release: async () => {
        if (released) return;
        released = true;
        await this.#release(key, entry!);
      }
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    for (const entry of entries) if (entry.timer !== undefined) clearTimeout(entry.timer);
    await Promise.all(
      entries.map((entry) => entry.promise.then((pool) => pool.close()).catch(() => undefined))
    );
  }

  async #release(key: string, entry: CachedPool): Promise<void> {
    entry.references = Math.max(0, entry.references - 1);
    if (entry.references > 0 || this.#entries.get(key) !== entry) return;
    entry.lastReleasedAt = Date.now();
    entry.timer = setTimeout(() => {
      if (entry.references > 0 || this.#entries.get(key) !== entry) return;
      this.#entries.delete(key);
      void entry.promise.then((pool) => pool.close()).catch(() => undefined);
    }, this.#idleTtlMs);
    entry.timer.unref();
  }

  async #evictIdleEntry(): Promise<void> {
    if (this.#entries.size < this.#maxEntries) return;
    const candidate = [...this.#entries.entries()]
      .filter(([, entry]) => entry.references === 0)
      .sort((left, right) => left[1].lastReleasedAt - right[1].lastReleasedAt)[0];
    if (candidate === undefined) return;
    const [key, entry] = candidate;
    this.#entries.delete(key);
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    await (await entry.promise).close().catch(() => undefined);
  }
}

export const MCP_CATALOG_LIMITS = Object.freeze({
  httpConcurrency: 4,
  retryMs: 30_000,
  timeoutMs: 30_000,
  maximumPages: 256,
  maximumTools: 10_000,
  maximumBytes: 16 * 1024 * 1024
});
interface ServerCatalog {
  server: ResolvedMcpServer;
  client: Client;
  sourceIdentity: string;
  retryAt: number;
  dirty: boolean;
  tools: Map<string, ToolBinding>;
  metadata: McpToolCatalog['servers'][number];
  refreshing?: Promise<void>;
}

export class MarAgentMcpClientPool {
  readonly #unknownPrincipal = randomUUID();
  readonly #clients: Client[] = [];
  readonly #servers = new Map<string, ServerCatalog>();
  #tools = new Map<string, ToolBinding>();
  #snapshot: McpToolCatalog = { revision: '', servers: [], tools: [] };
  readonly #controller = new AbortController();
  #closed = false;
  #ready = false;
  #initialCatalogAvailable = true;
  #httpRefreshActive = 0;
  readonly #httpWaiters: Array<() => void> = [];

  static async connect(
    servers: readonly ResolvedMcpServer[],
    cwd: string,
    options: MarAgentMcpProcessOptions = {}
  ) {
    const pool = new MarAgentMcpClientPool();
    const http = servers.filter((server) => server.transport === 'HTTP');
    let next = 0;
    const jobs = Array.from(
      { length: Math.min(MCP_CATALOG_LIMITS.httpConcurrency, http.length) },
      async () => {
        while (next < http.length) await pool.#connect(http[next++]!, cwd, options);
      }
    );
    jobs.push(
      (async () => {
        for (const server of servers.filter((server) => server.transport === 'STDIO'))
          await pool.#connect(server, cwd, options);
      })()
    );
    try {
      await Promise.all(jobs);
      pool.#publish();
      pool.#ready = true;
      for (const state of pool.#servers.values())
        if (state.dirty) void pool.#refresh(state).catch(() => undefined);
      return pool;
    } catch (error) {
      pool.#controller.abort();
      await Promise.allSettled(jobs);
      await pool.close();
      throw error;
    }
  }

  definitions(): readonly ClientToolDefinition[] {
    return this.#snapshot.tools.map((tool) => tool.definition);
  }
  catalog(): McpToolCatalog {
    return this.#snapshot;
  }

  async refreshForExecution(): Promise<void> {
    if (this.#initialCatalogAvailable) {
      this.#initialCatalogAvailable = false;
      await Promise.all(
        [...this.#servers.values()].flatMap((state) =>
          state.refreshing ? [state.refreshing.catch(() => undefined)] : []
        )
      );
      return;
    }
    await Promise.all(
      [...this.#servers.values()].map((state) => this.#refresh(state).catch(() => undefined))
    );
  }

  async call(
    name: string,
    arguments_: unknown,
    signal?: AbortSignal,
    expectedTool?: McpToolCallContext['expectedTool']
  ): Promise<ToolExecutionResult> {
    const binding = this.#tools.get(name);
    if (!binding || this.#closed)
      throw new MarAgentError('MAR_AGENT_MCP_TOOL_NOT_FOUND', 'MCP tool is no longer available.');
    if (
      expectedTool &&
      (binding.metadata.sourceIdentity !== expectedTool.sourceIdentity ||
        binding.metadata.definitionRevision !== expectedTool.definitionRevision)
    )
      throw new MarAgentError(
        'MAR_AGENT_MCP_TOOL_DEFINITION_CHANGED',
        'MCP tool binding or definition changed.'
      );
    signal?.throwIfAborted();
    const result = await binding.client.callTool(
      {
        name: binding.nativeName,
        arguments:
          arguments_ !== null && typeof arguments_ === 'object' && !Array.isArray(arguments_)
            ? (arguments_ as Record<string, unknown>)
            : {}
      },
      undefined,
      {
        timeout: MCP_CATALOG_LIMITS.timeoutMs,
        signal: signal
          ? AbortSignal.any([signal, this.#controller.signal])
          : this.#controller.signal
      }
    );
    const items = Array.isArray(result.content) ? result.content : [];
    const images: Array<NonNullable<ToolExecutionResult['images']>[number]> = [];
    const remaining: unknown[] = [];
    const content = items
      .map((item: unknown) => {
        if (item === null || typeof item !== 'object') {
          remaining.push(item);
          return '[unknown]';
        }
        const value = item as {
          [key: string]: unknown;
          type?: unknown;
          text?: unknown;
          mimeType?: unknown;
          data?: unknown;
        };
        if (value.type === 'text' && typeof value.text === 'string') {
          const { text, ...metadata } = value;
          if (Object.keys(metadata).some((key) => key !== 'type')) remaining.push(metadata);
          return text;
        }
        if (
          value.type === 'image' &&
          typeof value.mimeType === 'string' &&
          typeof value.data === 'string'
        ) {
          // Native MCP pixels belong only in the SDK image channel, not duplicated JSON text.
          images.push({ mimeType: value.mimeType, dataBase64: value.data });
          const { data: _pixels, ...metadata } = value;
          if (Object.keys(metadata).some((key) => key !== 'type' && key !== 'mimeType'))
            remaining.push(metadata);
        } else {
          remaining.push(item);
        }
        return `[${String(value.type ?? 'unknown')}]`;
      })
      .join('\n');
    const structured = result.structuredContent;
    const data =
      structured !== undefined && structured !== null
        ? remaining.length
          ? { structuredContent: structured, content: remaining }
          : structured
        : remaining.length
          ? remaining
          : undefined;
    return {
      content,
      ...(data === undefined ? {} : { data }),
      ...(images.length ? { images } : {})
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#controller.abort();
    await Promise.allSettled(
      [...this.#servers.values()].flatMap((state) => (state.refreshing ? [state.refreshing] : []))
    );
    await Promise.all(this.#clients.map((client) => client.close().catch(() => undefined)));
    this.#clients.length = 0;
    this.#servers.clear();
    this.#tools.clear();
    this.#snapshot = { revision: '', servers: [], tools: [] };
  }

  #publish(replacement?: { state: ServerCatalog; tools: Map<string, ToolBinding> }) {
    const combined = new Map<string, ToolBinding>();
    for (const state of this.#servers.values())
      for (const [name, binding] of replacement?.state === state
        ? replacement.tools
        : state.tools) {
        if (combined.has(name)) throw new Error('MAR_AGENT_MCP_TOOL_NAME_CONFLICT');
        combined.set(name, binding);
      }
    const tools = [...combined]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, binding]) => binding.metadata);
    const servers = [...this.#servers.values()]
      .map((state) => state.metadata)
      .sort((a, b) => a.id.localeCompare(b.id));
    const revision = fingerprint({ servers, tools });
    assertMcpToolCatalog({ revision, servers, tools });
    if (replacement) replacement.state.tools = replacement.tools;
    this.#tools = combined;
    if (revision !== this.#snapshot.revision) this.#snapshot = { revision, servers, tools };
  }

  #refresh(state: ServerCatalog): Promise<void> {
    if (state.refreshing) return state.refreshing;
    if (this.#closed || Date.now() < state.retryAt) return Promise.resolve();
    const job = (async () => {
      do {
        state.dirty = false;
        const tools = await this.#enumerate(state);
        if (this.#closed) return;
        this.#publish({ state, tools });
        state.retryAt = 0;
      } while (state.dirty && !this.#closed);
    })()
      .catch((error: unknown) => {
        state.retryAt = Date.now() + MCP_CATALOG_LIMITS.retryMs;
        throw error;
      })
      .finally(() => {
        delete state.refreshing;
      });
    state.refreshing = job;
    return job;
  }

  async #enumerate(state: ServerCatalog): Promise<Map<string, ToolBinding>> {
    if (state.server.transport !== 'HTTP') return this.#enumeratePages(state);
    if (this.#httpRefreshActive < MCP_CATALOG_LIMITS.httpConcurrency) this.#httpRefreshActive++;
    else await new Promise<void>((resolve) => this.#httpWaiters.push(resolve));
    try {
      this.#controller.signal.throwIfAborted();
      return await this.#enumeratePages(state);
    } finally {
      const next = this.#httpWaiters.shift();
      if (next) next();
      else this.#httpRefreshActive--;
    }
  }
  async #enumeratePages(state: ServerCatalog): Promise<Map<string, ToolBinding>> {
    const tools = new Map<string, ToolBinding>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let bytes = 0;
    for (let page = 0; page < MCP_CATALOG_LIMITS.maximumPages; page++) {
      const listed = await state.client.listTools(cursor === undefined ? {} : { cursor }, {
        signal: this.#controller.signal,
        timeout: MCP_CATALOG_LIMITS.timeoutMs
      });
      bytes += Buffer.byteLength(JSON.stringify(listed));
      if (bytes > MCP_CATALOG_LIMITS.maximumBytes) throw new Error('MAR_AGENT_MCP_CATALOG_LIMIT');
      for (const tool of listed.tools) {
        const name = `mcp__${mcpNameAlias(state.server.name)}__${mcpNameAlias(tool.name)}`;
        if (tools.has(name)) throw new Error('MAR_AGENT_MCP_TOOL_NAME_CONFLICT');
        const definition: ClientToolDefinition = {
          name,
          description: tool.description ?? `MCP tool ${tool.name}.`,
          allowedCallers: [
            ...(state.server.allowedToolCallers?.[tool.name] ??
              (state.server.origin === 'BUILTIN' ? ['direct'] : ['direct', 'programmatic']))
          ],
          inputSchema: tool.inputSchema as Record<string, unknown>,
          ...(tool.outputSchema
            ? { outputSchema: tool.outputSchema as Record<string, unknown> }
            : {})
        };
        assertMcpToolDefinition(definition);
        const metadata: McpCatalogTool = {
          definition,
          serverId: state.metadata.id,
          rawName: tool.name,
          sourceIdentity: state.sourceIdentity,
          definitionRevision: fingerprint(definition),
          lifetime: state.server.lifecycle === 'EXECUTION' ? 'execution' : 'session',
          exposure: state.server.origin === 'BUILTIN' ? 'direct' : 'deferred',
          ...(tool.annotations ? { annotations: tool.annotations } : {})
        };
        tools.set(name, {
          client: state.client,
          nativeName: tool.name,
          metadata
        });
        if (tools.size > MCP_CATALOG_LIMITS.maximumTools)
          throw new Error('MAR_AGENT_MCP_CATALOG_LIMIT');
      }
      cursor = listed.nextCursor;
      if (cursor === undefined) return tools;
      if (cursors.has(cursor)) throw new Error('MAR_AGENT_MCP_CATALOG_CURSOR_INVALID');
      cursors.add(cursor);
    }
    throw new Error('MAR_AGENT_MCP_CATALOG_LIMIT');
  }

  async #connect(server: ResolvedMcpServer, cwd: string, options: MarAgentMcpProcessOptions) {
    const client = new Client(NODE_MCP_CLIENT_INFO);
    this.#clients.push(client);
    let state: ServerCatalog | undefined;
    let initialDirty = false;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      if (!state) {
        initialDirty = true;
        return;
      }
      state.dirty = true;
      if (this.#ready) void this.#refresh(state).catch(() => undefined);
    });
    const environment = { ...getDefaultEnvironment(), ...(server.environment ?? {}) };
    const transport =
      server.transport === 'STDIO'
        ? options.processExecutor === undefined
          ? new StdioClientTransport({
              command: server.command!,
              args: [...(server.args ?? [])],
              env: environment,
              cwd,
              stderr: 'pipe'
            })
          : new ExecutorStdioClientTransport({
              processExecutor: options.processExecutor,
              command: server.command!,
              args: [...(server.args ?? [])],
              environment,
              environmentKeys: Object.keys(server.environment ?? {}),
              cwd,
              owner: requireMcpOwner(options.owner)
            })
        : (new StreamableHTTPClientTransport(new URL(server.url!), {
            requestInit: { headers: { ...(server.headers ?? {}) } }
          }) as unknown as Transport);
    await client.connect(transport, {
      signal: this.#controller.signal,
      timeout: MCP_CATALOG_LIMITS.timeoutMs
    });
    const sourceIdentity = fingerprint({
      source: server.sourceIdentity ?? {
        name: server.name,
        transport: server.transport,
        url: server.url,
        command: server.command,
        args: server.args
      },
      cwd,
      allowedToolCallers: server.allowedToolCallers,
      authorizationScope: options.authorizationScope ?? cwd,
      principal: server.authorizationIdentity ?? this.#unknownPrincipal
    });
    const version = client.getServerVersion();
    state = {
      server,
      client,
      sourceIdentity,
      retryAt: 0,
      dirty: initialDirty,
      tools: new Map(),
      metadata: {
        id: sourceIdentity,
        name: server.name,
        ...(version?.title ? { description: version.title } : {}),
        ...(client.getInstructions() ? { instructions: client.getInstructions()! } : {})
      }
    };
    state.tools = await this.#enumerate(state);
    if (this.#servers.has(state.metadata.id)) throw new Error('MAR_AGENT_MCP_SERVER_NAME_CONFLICT');
    this.#servers.set(state.metadata.id, state);
  }
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function singleUseLease(pool: MarAgentMcpClientPool): MarAgentMcpClientLease {
  let released = false;
  return {
    pool,
    release: async () => {
      if (released) return;
      released = true;
      await pool.close();
    }
  };
}

function mcpConfigurationFingerprint(
  servers: readonly ResolvedMcpServer[],
  cwd: string,
  authorizationScope?: string
): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        cwd,
        authorizationScope,
        inheritedEnvironment: getDefaultEnvironment(),
        servers
      })
    )
    .digest('hex');
}

function requireMcpOwner(owner: MarAgentMcpProcessOptions['owner']): {
  readonly sessionId: string;
  readonly executionId: string;
} {
  if (owner === undefined) throw new Error('MAR_AGENT_MCP_SANDBOX_OWNER_REQUIRED');
  return owner;
}

import { mcpNameAlias, NODE_MCP_CLIENT_INFO } from '../../mcp/naming.js';
import { createHash, randomUUID } from 'node:crypto';
import { addAbortListener } from 'node:events';
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
  LocalProcessExecutor
} from '@myagentroam/agent/host';
import type { ToolExecutionResult } from '@myagentroam/agent';
import { assertMcpToolDefinition, assertMcpToolCatalog } from '@myagentroam/agent/host';
import { AgentError } from '@myagentroam/agent';
import type { ResolvedMcpServer } from '../../mcp/model.js';
import { canonicalJson } from '../../util/canonical-json.js';
import { ExecutorStdioClientTransport } from './executor-stdio-client-transport.js';

interface ToolBinding {
  state: ServerCatalog;
  nativeName: string;
  metadata: McpCatalogTool;
}

interface CachedPool {
  readonly promise: Promise<MarAgentMcpClientPool>;
  connecting?: AbortController;
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
  readonly signal?: AbortSignal;
}

/** Owns shared MCP initialization and idle pools; each Run owns only its acquisition or lease. */
export class MarAgentMcpClientCache {
  readonly #entries = new Map<string, CachedPool>();
  readonly #retiring = new Set<Promise<void>>();
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
    options: MarAgentMcpProcessOptions & { readonly reusable?: boolean } = {}
  ): Promise<MarAgentMcpClientLease> {
    if (this.#closed) throw new Error('MAR_AGENT_MCP_CACHE_CLOSED');
    const { signal, ...sharedOptions } = options;
    signal?.throwIfAborted();
    if (options.processExecutor !== undefined && options.reusable !== false)
      throw new Error('MAR_AGENT_MCP_SANDBOX_REUSE_INVALID');
    if (options.reusable === false) {
      const pool = await MarAgentMcpClientPool.connect(servers, cwd, options);
      return singleUseLease(pool);
    }
    const key = mcpConfigurationFingerprint(servers, cwd, options.authorizationScope);
    let entry = this.#entries.get(key);
    if (entry === undefined) {
      await waitForSharedMcp(this.#evictIdleEntry(), signal);
      signal?.throwIfAborted();
      if (this.#closed) throw new Error('MAR_AGENT_MCP_CACHE_CLOSED');
      entry = this.#entries.get(key);
      if (entry === undefined) {
        if (this.#entries.size >= this.#maxEntries) {
          const pool = await MarAgentMcpClientPool.connect(servers, cwd, options);
          return singleUseLease(pool);
        }
        const connecting = new AbortController();
        const created: CachedPool = {
          connecting,
          promise: MarAgentMcpClientPool.connect(servers, cwd, {
            ...sharedOptions,
            signal: connecting.signal
          }).finally(() => {
            delete created.connecting;
          }),
          references: 0,
          lastReleasedAt: 0
        };
        this.#entries.set(key, created);
        created.promise.catch(() => {
          if (this.#entries.get(key) === created) this.#entries.delete(key);
        });
        entry = created;
      }
    }
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
      delete entry.timer;
    }
    entry.references += 1;
    let pool: MarAgentMcpClientPool;
    try {
      pool = await waitForSharedMcp(entry.promise, signal);
      signal?.throwIfAborted();
    } catch (error) {
      await this.#release(key, entry);
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
    if (!this.#closed) {
      this.#closed = true;
      const entries = [...this.#entries.values()];
      this.#entries.clear();
      const reason = new Error('MAR_AGENT_MCP_CACHE_CLOSED');
      for (const entry of entries) void this.#retire(entry, reason);
    }
    await Promise.all(this.#retiring);
  }

  async #release(key: string, entry: CachedPool): Promise<void> {
    entry.references = Math.max(0, entry.references - 1);
    if (entry.references > 0 || this.#entries.get(key) !== entry) return;
    if (entry.connecting !== undefined) {
      // Never leave the next Run queued behind a handshake that nobody needs anymore.
      this.#entries.delete(key);
      await this.#retire(entry);
      return;
    }
    entry.lastReleasedAt = Date.now();
    entry.timer = setTimeout(() => {
      if (entry.references > 0 || this.#entries.get(key) !== entry) return;
      this.#entries.delete(key);
      void this.#retire(entry);
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
    await this.#retire(entry);
  }

  #retire(entry: CachedPool, reason?: Error): Promise<void> {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    // Keep transport cleanup owned by the cache even after a Run stops waiting for it.
    const retiring = entry.promise.then((pool) => pool.close()).catch(() => undefined);
    this.#retiring.add(retiring);
    void retiring.then(() => this.#retiring.delete(retiring));
    entry.connecting?.abort(reason);
    return retiring;
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
  close: () => Promise<void>;
  isAvailable: () => boolean;
  reopen?: () => Promise<ServerCatalog>;
  sourceIdentity: string;
  retryAt: number;
  dirty: boolean;
  tools: Map<string, ToolBinding>;
  metadata: McpToolCatalog['servers'][number];
  refreshing?: Promise<void>;
}

/** Owns MCP transports and atomic server catalogs; Runs only wait for shared recovery. */
export class MarAgentMcpClientPool {
  readonly #unknownPrincipal = randomUUID();
  readonly #closeTransports = new Set<() => Promise<void>>();
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
    options.signal?.throwIfAborted();
    const pool = new MarAgentMcpClientPool();
    const signal = options.signal
      ? AbortSignal.any([options.signal, pool.#controller.signal])
      : pool.#controller.signal;
    const http = servers.filter((server) => server.transport === 'HTTP');
    let next = 0;
    const jobs = Array.from(
      { length: Math.min(MCP_CATALOG_LIMITS.httpConcurrency, http.length) },
      async () => {
        while (next < http.length) await pool.#connect(http[next++]!, cwd, options, signal);
      }
    );
    jobs.push(
      (async () => {
        for (const server of servers.filter((server) => server.transport === 'STDIO'))
          await pool.#connect(server, cwd, options, signal);
      })()
    );
    try {
      await Promise.all(jobs);
      signal.throwIfAborted();
      pool.#publish();
      pool.#ready = true;
      for (const state of pool.#servers.values())
        if (state.dirty) void pool.#refresh(state).catch(() => undefined);
      return pool;
    } catch (error) {
      pool.#controller.abort();
      await Promise.allSettled(jobs);
      await pool.close();
      options.signal?.throwIfAborted();
      throw error;
    }
  }

  definitions(): readonly ClientToolDefinition[] {
    return this.#snapshot.tools.map((tool) => tool.definition);
  }
  catalog(): McpToolCatalog {
    return this.#snapshot;
  }

  async refreshForExecution(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const initial = this.#initialCatalogAvailable;
    this.#initialCatalogAvailable = false;
    const refreshes = [...this.#servers.values()].flatMap((state) => {
      const refresh = initial && state.isAvailable() ? state.refreshing : this.#refresh(state);
      return refresh === undefined ? [] : [refresh.catch(() => undefined)];
    });
    await waitForSharedMcp(Promise.all(refreshes), signal);
  }

  async call(
    name: string,
    arguments_: unknown,
    signal?: AbortSignal,
    expectedTool?: McpToolCallContext['expectedTool']
  ): Promise<ToolExecutionResult> {
    let binding = this.#tools.get(name);
    if (!binding || this.#closed)
      throw new AgentError('MAR_AGENT_MCP_TOOL_NOT_FOUND', 'MCP tool is no longer available.');
    signal?.throwIfAborted();
    if (!binding.state.isAvailable()) {
      const state = binding.state;
      if (state.reopen) {
        await waitForSharedMcp(
          this.#refresh(state).catch(() => undefined),
          signal
        );
        signal?.throwIfAborted();
        binding = this.#tools.get(name);
        if (!binding || this.#closed)
          throw new AgentError('MAR_AGENT_MCP_TOOL_NOT_FOUND', 'MCP tool is no longer available.');
      }
      if (!binding.state.isAvailable()) throw mcpConnectionUnavailable();
    }
    if (
      expectedTool &&
      (binding.metadata.sourceIdentity !== expectedTool.sourceIdentity ||
        binding.metadata.definitionRevision !== expectedTool.definitionRevision)
    )
      throw new AgentError(
        'MAR_AGENT_MCP_TOOL_DEFINITION_CHANGED',
        'MCP tool binding or definition changed.'
      );
    // Recover only before dispatch. The old server may have acted even if its reply was lost.
    const result = await binding.state.client.callTool(
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
    const diagnostics: string[] = [];
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
          diagnostics.push(value.text);
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
    if (result.isError === true) {
      const diagnostic = diagnostics.join('\n');
      throw new AgentError(
        'MAR_AGENT_MCP_TOOL_FAILED',
        diagnostic.length > 0
          ? `MCP tool reported an error: ${diagnostic}`
          : 'MCP tool reported an error without text diagnostics.'
      );
    }
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
    await Promise.all([...this.#closeTransports].map((close) => close().catch(() => undefined)));
    this.#servers.clear();
    this.#tools.clear();
    this.#snapshot = { revision: '', servers: [], tools: [] };
  }

  #publish(replacement?: {
    state: ServerCatalog;
    tools: Map<string, ToolBinding>;
    recovered?: ServerCatalog;
  }) {
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
      .map(
        (state) =>
          (replacement?.state === state ? (replacement.recovered ?? state) : state).metadata
      )
      .sort((a, b) => a.id.localeCompare(b.id));
    const revision = fingerprint({ servers, tools });
    assertMcpToolCatalog({ revision, servers, tools });
    if (replacement?.recovered) {
      this.#servers.set(replacement.state.metadata.id, replacement.recovered);
    } else if (replacement) replacement.state.tools = replacement.tools;
    this.#tools = combined;
    if (revision !== this.#snapshot.revision) this.#snapshot = { revision, servers, tools };
  }

  #refresh(state: ServerCatalog): Promise<void> {
    if (state.refreshing) return state.refreshing;
    if (this.#closed || Date.now() < state.retryAt) return Promise.resolve();
    const job = (async () => {
      if (state.isAvailable()) {
        try {
          const tools = await this.#withRefreshSlot(state, () => {
            state.dirty = false;
            return this.#enumerate(state);
          });
          if (this.#closed) return;
          if (!state.isAvailable()) throw mcpConnectionUnavailable();
          this.#publish({ state, tools });
          state.retryAt = 0;
          return state;
        } catch (error) {
          // A catalog error alone does not invalidate the connection.
          if (state.isAvailable() || !state.reopen) throw error;
        }
      }
      const reopen = state.reopen;
      if (this.#closed || !reopen) return;
      return this.#withRefreshSlot(state, async () => {
        if (this.#closed) return;
        await state.close().catch(() => undefined);
        const recovered = await reopen();
        try {
          if (this.#closed) return;
          if (!recovered.isAvailable()) throw mcpConnectionUnavailable();
          this.#publish({ state, tools: recovered.tools, recovered });
          return recovered;
        } finally {
          if (this.#servers.get(state.metadata.id) !== recovered)
            void recovered.close().catch(() => undefined);
        }
      });
    })().then(
      (published) => {
        delete state.refreshing;
        // Follow-up sweeps rejoin the queue and never extend a Run's startup barrier.
        if (published?.dirty && published.isAvailable())
          void this.#refresh(published).catch(() => undefined);
      },
      (error: unknown) => {
        state.retryAt = Date.now() + MCP_CATALOG_LIMITS.retryMs;
        delete state.refreshing;
        throw error;
      }
    );
    state.refreshing = job;
    return job;
  }

  async #withRefreshSlot<T>(state: ServerCatalog, refresh: () => Promise<T>): Promise<T> {
    if (state.server.transport !== 'HTTP') return refresh();
    if (this.#httpRefreshActive < MCP_CATALOG_LIMITS.httpConcurrency) this.#httpRefreshActive++;
    else await new Promise<void>((resolve) => this.#httpWaiters.push(resolve));
    try {
      return await refresh();
    } finally {
      const next = this.#httpWaiters.shift();
      if (next) next();
      else this.#httpRefreshActive--;
    }
  }
  async #enumerate(
    state: ServerCatalog,
    signal = this.#controller.signal
  ): Promise<Map<string, ToolBinding>> {
    const tools = new Map<string, ToolBinding>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let bytes = 0;
    for (let page = 0; page < MCP_CATALOG_LIMITS.maximumPages; page++) {
      signal.throwIfAborted();
      if (!state.isAvailable()) throw mcpConnectionUnavailable();
      const listed = await state.client.listTools(cursor === undefined ? {} : { cursor }, {
        signal,
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
          state,
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

  async #connect(
    server: ResolvedMcpServer,
    cwd: string,
    options: MarAgentMcpProcessOptions,
    signal: AbortSignal
  ) {
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
    const environment = { ...getDefaultEnvironment(), ...(server.environment ?? {}) };
    const open = (signal: AbortSignal) =>
      this.#open(server, cwd, options, sourceIdentity, environment, signal);
    const state = await open(signal);
    if (this.#servers.has(sourceIdentity)) throw new Error('MAR_AGENT_MCP_SERVER_NAME_CONFLICT');
    // Execution capabilities and sandboxed processes belong to the original Run only.
    if (server.lifecycle !== 'EXECUTION' && options.processExecutor === undefined) {
      const reopen = async () => {
        const recovered = await open(this.#controller.signal);
        recovered.reopen = reopen;
        return recovered;
      };
      state.reopen = reopen;
    }
    this.#servers.set(sourceIdentity, state);
  }

  async #open(
    server: ResolvedMcpServer,
    cwd: string,
    options: MarAgentMcpProcessOptions,
    sourceIdentity: string,
    environment: Record<string, string>,
    signal: AbortSignal
  ): Promise<ServerCatalog> {
    signal.throwIfAborted();
    const client = new Client(NODE_MCP_CLIENT_INFO);
    let state: ServerCatalog | undefined;
    let initialDirty = false;
    let invalidated = false;
    const invalidate = () => {
      if (invalidated) return;
      invalidated = true;
      if (state && this.#servers.get(sourceIdentity) === state) state.retryAt = 0;
    };
    client.onclose = invalidate;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      if (!state) {
        initialDirty = true;
        return;
      }
      state.dirty = true;
      if (this.#ready && this.#servers.get(sourceIdentity) === state && state.isAvailable())
        void this.#refresh(state).catch(() => undefined);
    });
    let initializing = true;
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
            requestInit: { headers: { ...(server.headers ?? {}) } },
            // The initialization notification has no SDK request options. Its HTTP I/O
            // follows the same lifetime as the handshake, not a single shared waiter.
            fetch: async (input, init) => {
              const response = await (initializing
                ? fetch(input, {
                    ...init,
                    signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal
                  })
                : fetch(input, init));
              // A session-bound 404 ends the HTTP session without an SDK onclose.
              // Leave response handling to the SDK; retire the transport on next use.
              if (response.status === 404 && new Headers(init?.headers).has('Mcp-Session-Id'))
                invalidate();
              return response;
            }
          }) as unknown as Transport);
    // Client.connect starts its own close on handshake failure without awaiting it.
    // Pool teardown must join that same transport cleanup before releasing the Run.
    const close = transport.close.bind(transport);
    let closing: Promise<void> | undefined;
    const closeTransport = () =>
      (closing ??= close().finally(() => this.#closeTransports.delete(closeTransport)));
    transport.close = closeTransport;
    this.#closeTransports.add(closeTransport);
    try {
      try {
        await client.connect(transport, { signal, timeout: MCP_CATALOG_LIMITS.timeoutMs });
      } finally {
        initializing = false;
      }
      const version = client.getServerVersion();
      state = {
        server,
        client,
        close: closeTransport,
        isAvailable: () => !invalidated,
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
      state.tools = await this.#enumerate(state, signal);
      if (!state.isAvailable()) throw mcpConnectionUnavailable();
      return state;
    } catch (error) {
      void closeTransport().catch(() => undefined);
      throw error;
    }
  }
}

function mcpConnectionUnavailable(): AgentError {
  return new AgentError('MAR_AGENT_MCP_CONNECTION_UNAVAILABLE', 'MCP connection is unavailable.');
}

// The cache/pool owns shared initialization and refresh. A Run can cancel its wait,
// but cannot cancel work that another lease may still use or publish to the pool.
async function waitForSharedMcp<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return pending;
  const cancelled = Promise.withResolvers<never>();
  const listener = addAbortListener(signal, () => cancelled.reject(signal.reason));
  try {
    return await Promise.race([pending, cancelled.promise]);
  } finally {
    listener[Symbol.dispose]();
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

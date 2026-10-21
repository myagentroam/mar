import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { MarAgentError } from '../error.js';
import { assertMcpToolCatalog } from '../tools/mcp/catalog.js';
import type { McpToolCatalog, ToolCall, ToolExecutionResult } from '../tools/contracts.js';
import { cloneCoreJson, type CoreJsonValue } from './data.js';
import type { CoreDomainFacts, CoreDomainOperations } from './contracts.js';
import type { ExtensionHooks } from './hooks.js';
import type { CoreOperationContext } from './operation.js';
import { ExtensionResourceScope, type CoreResourceRegistration } from './resources.js';
import type { CoreToolBinding, CoreToolRef, CoreToolInvocation, ExtensionTools } from './tools.js';

export interface CoreMcpServerDefinition {
  readonly id: string;
  readonly configuration: CoreJsonValue;
}
export interface CoreMcpServerRef {
  readonly definition: CoreMcpServerDefinition;
  readonly source: Readonly<{ extensionId: string; ownerInstanceId: string; revision: string }>;
}
export interface CoreMcpServerRegistration extends CoreResourceRegistration {
  readonly ref: CoreMcpServerRef;
}
export interface CoreMcpConnectionRef {
  readonly id: string;
  readonly serverId: string;
  readonly source: CoreMcpServerRef['source'];
}
export interface CoreMcpConnectInput {
  readonly server: CoreMcpServerRef | string;
  readonly signal?: AbortSignal;
}
export interface CoreMcpConnectionInput {
  readonly connection: CoreMcpConnectionRef;
  readonly signal?: AbortSignal;
}
export interface CoreMcpCallInput {
  readonly tool: CoreToolRef;
  readonly arguments: unknown;
  readonly callId?: string;
  readonly signal?: AbortSignal;
}
export interface CoreMcpCatalog {
  readonly revision: string;
  readonly servers: McpToolCatalog['servers'];
  readonly tools: readonly CoreToolRef[];
}
export interface CoreMcpApi {
  register(definition: CoreMcpServerDefinition): CoreMcpServerRegistration;
  servers(): readonly CoreMcpServerRef[];
  connect(input: CoreMcpConnectInput): Promise<CoreMcpConnectionRef>;
  connections(): readonly CoreMcpConnectionRef[];
  catalog(input: CoreMcpConnectionInput): Promise<CoreMcpCatalog>;
  call(input: CoreMcpCallInput): Promise<ToolExecutionResult>;
  disconnect(input: CoreMcpConnectionInput): Promise<void>;
}
export interface CoreMcpToolCall {
  readonly name: string;
  readonly serverId: string;
  readonly rawName: string;
  readonly arguments: unknown;
  readonly callId?: string;
  readonly expectedTool: Readonly<{ sourceIdentity: string; definitionRevision: string }>;
}
/** A lease on the application's existing MCP Client. Core never implements a transport. */
export interface CoreMcpConnectionBackend {
  catalog(call: CoreOperationContext): Promise<McpToolCatalog>;
  call(input: CoreMcpToolCall, call: CoreOperationContext): Promise<ToolExecutionResult>;
  close(): Promise<void>;
}
export interface CoreMcpBackend {
  connect(
    definition: CoreMcpServerDefinition,
    call: CoreOperationContext
  ): Promise<CoreMcpConnectionBackend>;
}
export interface CoreMcpCompletion {
  readonly operation: 'connect' | 'catalog' | 'call' | 'disconnect';
  readonly connectionId: string;
  readonly toolName?: string;
  readonly toolCount?: number;
}
interface Declaration {
  readonly owner: ExtensionResourceScope;
  readonly ref: CoreMcpServerRef;
  live: boolean;
}
interface Source {
  readonly binding: CoreToolBinding;
  readonly registration: CoreResourceRegistration;
  live: boolean;
}
interface Connection {
  readonly owner: ExtensionResourceScope;
  readonly ref: CoreMcpConnectionRef;
  readonly backend: CoreMcpConnectionBackend;
  readonly scope: ExtensionResourceScope;
  readonly signal: AbortSignal;
  readonly abort: () => void;
  registration: CoreResourceRegistration;
  catalog: McpToolCatalog;
  sources: Source[];
  closed: boolean;
  closing?: Promise<void>;
  tail?: Promise<unknown>;
}
type Run = <Value>(
  operation: (call: CoreOperationContext) => Promise<Value>,
  signal?: AbortSignal
) => Promise<Value>;

/** One Session's declarations and owned Client leases feed its sole tool registry. */
export class ExtensionMcp {
  readonly #declarations: Declaration[] = [];
  readonly #serverRefs = new WeakMap<CoreMcpServerRef, Declaration>();
  readonly #connectionRefs = new WeakMap<CoreMcpConnectionRef, Connection>();
  readonly #connections = new Set<Connection>();
  readonly #calling = new AsyncLocalStorage<{ connection: Connection; active: boolean }>();
  constructor(
    readonly tools: ExtensionTools,
    readonly hooks: ExtensionHooks<CoreDomainOperations, CoreDomainFacts>,
    readonly getTools: (call: CoreOperationContext) => ReadonlyMap<string, CoreToolBinding>,
    readonly toolRef: (binding: CoreToolBinding) => CoreToolRef,
    readonly isMcpRef: (ref: CoreToolRef) => boolean,
    readonly invoke: (
      input: CoreToolInvocation,
      call: CoreOperationContext
    ) => Promise<ToolExecutionResult>,
    readonly diagnose: () => void
  ) {}

  bind(
    owner: ExtensionResourceScope,
    extensionId: string,
    backend: CoreMcpBackend,
    run: Run
  ): CoreMcpApi {
    return {
      register: (definition) => this.#register(owner, extensionId, definition),
      servers: () =>
        Object.freeze(
          this.#declarations
            .filter((entry) => entry.owner === owner && this.#declared(entry))
            .map((entry) => entry.ref)
        ),
      connections: () =>
        Object.freeze(
          [...this.#connections]
            .filter((entry) => entry.owner === owner && !entry.closed)
            .map((entry) => entry.ref)
        ),
      connect: async (input) => {
        const request = captureInput(input, ['server', 'signal']);
        return run(
          (call) =>
            this.hooks.invoke('mcp.connect', request, call, async (input, effective) => {
              const server = this.#server(owner, input.server);
              return this.#connect(owner, extensionId, server.ref, backend, effective);
            }),
          request.signal
        );
      },
      catalog: async (input) => {
        const request = captureInput(input, ['connection', 'signal']);
        return run(
          (call) =>
            this.hooks.invoke('mcp.catalog', request, call, async (input, effective) => {
              const connection = this.#connection(input.connection);
              await this.#refresh(connection, effective);
              const bindings = this.getTools(effective);
              const result = Object.freeze({
                revision: connection.catalog.revision,
                servers: connection.catalog.servers,
                tools: Object.freeze(
                  connection.catalog.tools.flatMap((tool) => {
                    const binding = bindings.get(tool.definition.name);
                    return binding?.mcp && binding.mcp.sourceIdentity === tool.sourceIdentity
                      ? [this.toolRef(binding)]
                      : [];
                  })
                )
              });
              await this.hooks.emit(
                'mcp.completed',
                {
                  operation: 'catalog',
                  connectionId: connection.ref.id,
                  toolCount: connection.catalog.tools.length
                },
                effective
              );
              return result;
            }),
          request.signal
        );
      },
      call: async (input) => {
        const captured = captureInput(input, ['tool', 'arguments', 'callId', 'signal']);
        let arguments_: unknown;
        try {
          arguments_ = structuredClone(captured.arguments);
        } catch {
          throw new MarAgentError('MAR_AGENT_MCP_INPUT_INVALID', 'MCP arguments cannot be copied.');
        }
        return run(async (call) => {
          if (!this.isMcpRef(captured.tool))
            throw new MarAgentError(
              'MAR_AGENT_MCP_REFERENCE_INVALID',
              'MCP tool reference is invalid.'
            );
          return this.invoke(
            {
              name: captured.tool.definition.name,
              ref: captured.tool,
              arguments: arguments_,
              ...(captured.callId === undefined ? {} : { callId: captured.callId })
            },
            call
          );
        }, captured.signal);
      },
      disconnect: async (input) => {
        const request = captureInput(input, ['connection', 'signal']);
        return run(
          (call) =>
            this.hooks.invoke('mcp.disconnect', request, call, async (input, effective) => {
              const connection = this.#connectionRefs.get(input.connection);
              if (!connection)
                throw new MarAgentError(
                  'MAR_AGENT_MCP_REFERENCE_INVALID',
                  'MCP connection reference is invalid.'
                );
              const active = this.#calling.getStore();
              if (active?.active && active.connection === connection)
                throw new MarAgentError(
                  'MAR_AGENT_MCP_CONNECTION_BUSY',
                  'MCP connection cannot close from its active call.'
                );
              await connection.registration.dispose();
              await this.hooks.emit(
                'mcp.completed',
                { operation: 'disconnect', connectionId: connection.ref.id },
                effective
              );
            }),
          request.signal
        );
      }
    };
  }

  servers(): McpToolCatalog['servers'] {
    return [...this.#connections]
      .filter((entry) => !entry.closed)
      .flatMap((entry) => [...entry.catalog.servers]);
  }

  async #connect(
    owner: ExtensionResourceScope,
    extensionId: string,
    server: CoreMcpServerRef,
    backend: CoreMcpBackend,
    call: CoreOperationContext
  ): Promise<CoreMcpConnectionRef> {
    if (typeof backend.connect !== 'function')
      throw new MarAgentError(
        'MAR_AGENT_HOST_PORT_UNAVAILABLE',
        'Dynamic MCP port is unavailable.'
      );
    let connection: Connection | undefined;
    const registration = owner.effect(() => async () => {
      if (connection) await this.#close(connection);
    });
    await registration.ready;
    try {
      call.signal.throwIfAborted();
      const lease = await backend.connect(server.definition, call);
      if (!lease || typeof lease.close !== 'function')
        throw new MarAgentError(
          'MAR_AGENT_MCP_BACKEND_INVALID',
          'MCP backend did not return a closeable Client lease.'
        );
      const scope = new ExtensionResourceScope();
      scope.activate();
      const ref = Object.freeze({
        id: randomUUID(),
        serverId: server.definition.id,
        source: Object.freeze({
          extensionId,
          ownerInstanceId: owner.instanceId,
          revision: randomUUID()
        })
      });
      connection = {
        owner,
        ref,
        backend: lease,
        scope,
        signal: owner.signal,
        registration,
        catalog: { revision: '', servers: [], tools: [] },
        sources: [],
        closed: false,
        abort: () => {
          void registration.dispose().catch(() => this.diagnose());
        }
      };
      owner.signal.addEventListener('abort', connection.abort, { once: true });
      if (call.signal !== owner.signal)
        call.signal.addEventListener('abort', connection.abort, { once: true });
      if (typeof lease.catalog !== 'function' || typeof lease.call !== 'function')
        throw new MarAgentError(
          'MAR_AGENT_MCP_BACKEND_INVALID',
          'MCP Client lease is missing catalog or call.'
        );
      call.signal.throwIfAborted();
      await this.#refresh(connection, call);
      call.signal.throwIfAborted();
      this.#connectionRefs.set(ref, connection);
      this.#connections.add(connection);
      await this.hooks.emit(
        'mcp.completed',
        { operation: 'connect', connectionId: ref.id, toolCount: connection.catalog.tools.length },
        call
      );
      return ref;
    } catch (error) {
      try {
        await registration.dispose();
      } catch {
        this.diagnose();
      }
      throw error;
    } finally {
      // Only the owning scope, not a completed acquisition, controls the delivered lease.
      if (connection && call.signal !== connection.signal)
        call.signal.removeEventListener('abort', connection.abort);
    }
  }

  #refresh(connection: Connection, call: CoreOperationContext): Promise<void> {
    const result = (connection.tail ?? Promise.resolve()).then(async () => {
      if (connection.closed)
        throw new MarAgentError(
          'MAR_AGENT_MCP_REFERENCE_INVALID',
          'MCP connection is unavailable.'
        );
      await runMcpConnection(connection, call, async (signal) => {
        const raw = await connection.backend.catalog(Object.freeze({ ...call, signal }));
        let catalog: McpToolCatalog;
        try {
          catalog = structuredClone(raw);
        } catch {
          throw new MarAgentError('MAR_AGENT_MCP_CATALOG_INVALID', 'MCP catalog cannot be copied.');
        }
        assertMcpToolCatalog(catalog, { nativeToolNames: true });
        catalog = freeze({
          ...catalog,
          tools: catalog.tools.map((tool) => ({
            ...tool,
            definition: {
              ...tool.definition,
              allowedCallers: tool.definition.allowedCallers ?? ['direct', 'programmatic']
            }
          }))
        });
        signal.throwIfAborted();
        if (isDeepStrictEqual(catalog, connection.catalog)) return;
        const next: Source[] = [];
        const previous = connection.sources;
        try {
          for (const tool of catalog.tools) {
            let source!: Source;
            const binding: CoreToolBinding = Object.freeze({
              definition: tool.definition,
              mcp: tool,
              source: Object.freeze({
                kind: 'mcp',
                id: tool.sourceIdentity,
                revision: tool.definitionRevision,
                instanceId: connection.owner.instanceId
              }),
              registered: () => source.live,
              available: () =>
                source.live &&
                !connection.closed &&
                connection.owner.state !== 'RETIRING' &&
                connection.owner.state !== 'DISPOSED',
              invoke: async (input: ToolCall, operation: CoreOperationContext) => {
                if (!source.live || connection.closed)
                  throw new MarAgentError(
                    'MAR_AGENT_TOOL_NOT_AVAILABLE',
                    'MCP tool source is unavailable.'
                  );
                const frame = { connection, active: true };
                const result = await runMcpConnection(connection, operation, async (signal) => {
                  signal.throwIfAborted();
                  if (!source.live)
                    throw new MarAgentError(
                      'MAR_AGENT_TOOL_NOT_AVAILABLE',
                      'MCP tool source is unavailable.'
                    );
                  return this.#calling.run(frame, async () => {
                    try {
                      return await connection.backend.call(
                        {
                          name: tool.definition.name,
                          serverId: tool.serverId,
                          rawName: tool.rawName,
                          arguments: input.arguments,
                          ...(input.callId === undefined ? {} : { callId: input.callId }),
                          expectedTool: {
                            sourceIdentity: tool.sourceIdentity,
                            definitionRevision: tool.definitionRevision
                          }
                        },
                        Object.freeze({ ...operation, signal })
                      );
                    } finally {
                      frame.active = false;
                    }
                  });
                });
                await this.hooks.emit(
                  'mcp.completed',
                  {
                    operation: 'call',
                    connectionId: connection.ref.id,
                    toolName: tool.definition.name
                  },
                  operation
                );
                return result;
              }
            });
            source = {
              binding,
              live: false,
              registration: this.tools.contributeSource(connection.owner, binding)
            };
            next.push(source);
          }
          await Promise.all(next.map((source) => source.registration.ready));
          signal.throwIfAborted();
          for (const source of previous) source.live = false;
          for (const source of next) source.live = true;
          // Validation is synchronous: no other operation observes the tentative catalog.
          try {
            this.getTools(call);
          } catch (error) {
            for (const source of previous) source.live = true;
            for (const source of next) source.live = false;
            throw error;
          }
          connection.sources = next;
          connection.catalog = catalog;
        } catch (error) {
          for (const source of next) source.live = false;
          await Promise.all(next.map((source) => source.registration.dispose()));
          throw error;
        }
        await Promise.all(previous.map((source) => source.registration.dispose()));
      });
    });
    connection.tail = result.catch(() => undefined);
    return result;
  }

  #close(connection: Connection): Promise<void> {
    if (connection.closing) return connection.closing;
    connection.closed = true;
    this.#connections.delete(connection);
    connection.signal.removeEventListener('abort', connection.abort);
    connection.scope.retire();
    for (const source of connection.sources) source.live = false;
    connection.closing = (async () => {
      // Close the Client concurrently so non-cooperative transport waits can settle.
      const results = await Promise.allSettled([
        Promise.resolve().then(() => connection.backend.close()),
        connection.scope.dispose(),
        ...connection.sources.map((source) => source.registration.dispose())
      ]);
      const failure = results.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') {
        if (failure.reason instanceof MarAgentError) throw failure.reason;
        throw new MarAgentError('MAR_AGENT_MCP_CLEANUP_FAILED', 'MCP Client lease did not close.', {
          cause: failure.reason
        });
      }
    })();
    return connection.closing;
  }

  #register(
    owner: ExtensionResourceScope,
    extensionId: string,
    input: CoreMcpServerDefinition
  ): CoreMcpServerRegistration {
    const { id, configuration } = captureInput(input, ['id', 'configuration']);
    if (typeof id !== 'string' || !id.trim())
      throw new MarAgentError(
        'MAR_AGENT_MCP_DEFINITION_INVALID',
        'MCP declaration identity is invalid.'
      );
    let copied: CoreJsonValue;
    try {
      copied = cloneCoreJson(configuration);
    } catch {
      throw new MarAgentError(
        'MAR_AGENT_MCP_DEFINITION_INVALID',
        'MCP configuration must be serializable JSON.'
      );
    }
    if (
      this.#declarations.some(
        (entry) => this.#declared(entry) && entry.ref.definition.id === id && entry.owner !== owner
      )
    )
      throw new MarAgentError(
        'MAR_AGENT_MCP_DEFINITION_CONFLICT',
        'MCP declaration identity conflicts.'
      );
    const ref: CoreMcpServerRef = Object.freeze({
      definition: freeze({ id, configuration: copied }),
      source: Object.freeze({
        extensionId,
        ownerInstanceId: owner.instanceId,
        revision: randomUUID()
      })
    });
    const entry = { owner, ref, live: true };
    const registration = owner.effect(() => () => {
      entry.live = false;
      const index = this.#declarations.indexOf(entry);
      if (index !== -1) this.#declarations.splice(index, 1);
    });
    this.#declarations.push(entry);
    this.#serverRefs.set(ref, entry);
    return Object.freeze({ ...registration, ref });
  }
  #declared(entry: Declaration): boolean {
    return (
      entry.live &&
      (entry.owner.state === 'ACTIVE' ||
        (entry.owner.state === 'STAGED' && ExtensionResourceScope.initializing))
    );
  }
  #server(owner: ExtensionResourceScope, ref: CoreMcpServerRef | string): Declaration {
    const entry =
      typeof ref === 'string'
        ? this.#declarations.findLast(
            (entry) =>
              entry.owner === owner && entry.ref.definition.id === ref && this.#declared(entry)
          )
        : this.#serverRefs.get(ref);
    if (!entry || !this.#declared(entry))
      throw new MarAgentError('MAR_AGENT_MCP_REFERENCE_INVALID', 'MCP declaration is unavailable.');
    return entry;
  }
  #connection(ref: CoreMcpConnectionRef): Connection {
    const connection = this.#connectionRefs.get(ref);
    if (!connection || connection.closed)
      throw new MarAgentError('MAR_AGENT_MCP_REFERENCE_INVALID', 'MCP connection is unavailable.');
    return connection;
  }
}

/** Project the same captured bindings used by invocation; never rediscover a backend by name. */
export function coreMcpCatalog(
  servers: McpToolCatalog['servers'],
  bindings: ReadonlyMap<string, CoreToolBinding>
): McpToolCatalog {
  const descriptions = new Map<string, McpToolCatalog['servers'][number]>();
  for (const server of servers) {
    const previous = descriptions.get(server.id);
    if (previous && !isDeepStrictEqual(previous, server))
      throw new MarAgentError('MAR_AGENT_MCP_CATALOG_INVALID', 'MCP server identities conflict.');
    descriptions.set(server.id, server);
  }
  const tools = [...bindings.values()]
    .filter((binding) => binding.mcp !== undefined)
    .map((binding) => ({
      ...binding.mcp!,
      definition: binding.definition,
      sourceIdentity:
        binding.source.kind === 'mcp'
          ? binding.mcp!.sourceIdentity
          : digest([binding.source.id, binding.mcp!.sourceIdentity]),
      definitionRevision:
        binding.source.kind === 'mcp'
          ? binding.mcp!.definitionRevision
          : digest([binding.source.revision, binding.mcp!.definitionRevision, binding.definition])
    }));
  const catalog = { servers: [...descriptions.values()], tools };
  return {
    ...catalog,
    revision: createHash('sha256').update(JSON.stringify(catalog)).digest('hex')
  };
}

async function runMcpConnection<Value>(
  connection: Connection,
  call: CoreOperationContext,
  operation: (signal: AbortSignal) => Promise<Value>
): Promise<Value> {
  try {
    return await connection.scope.run(operation, call.signal);
  } catch (error) {
    // A Client may wrap the abort reason. The owned lease, not transport error identity,
    // decides whether teardown cancelled this operation; preserve the original cause.
    if (connection.scope.signal.aborted || connection.owner.signal.aborted)
      throw new MarAgentError('MAR_AGENT_CANCELLED', 'MCP operation was cancelled.', {
        cause: error
      });
    throw error;
  }
}

function captureInput<Value extends object>(input: Value, keys: readonly (keyof Value)[]): Value {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new MarAgentError('MAR_AGENT_MCP_INPUT_INVALID', 'MCP input must be an object.');
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, input[key]]))) as Value;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function freeze<Value>(value: Value): Value {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

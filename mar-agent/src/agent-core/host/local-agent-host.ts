import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { basename, delimiter, isAbsolute, join, resolve, win32 } from 'node:path';
import { MarAgentError } from '../error.js';
import type { MarAgentEvent } from '../runtime/events.js';
import type { CodeModeEngineFactory } from '../tools/code-mode/engine.js';
import type {
  McpToolCallContext,
  McpToolCatalog,
  McpToolCatalogContext,
  ToolCall,
  ToolExecutionContext,
  ToolExecutionResult
} from '../tools/contracts.js';
import { TOOL_EXECUTION_LIMITS } from '../tools/execution-limits.js';
import { LocalToolRegistry } from '../tools/local/registry.js';
import type { WorkspacePathMount } from '../tools/shared/path-resolver.js';
import type {
  HostDescription,
  HostExecutionExtensions,
  HostSkill,
  MarAgentHost,
  CoreHostToolsBackend,
  CoreHostToolSource
} from './contracts.js';
import { MAR_AGENT_HOST_API_VERSION } from './contracts.js';
import { LocalNetworkAccess } from './local-network-access.js';
import { LocalSessionEnvironment } from './local-session-environment.js';
import type { CoreNetworkBackend } from '../extensions/network.js';
import { directLocalProcessExecutor, type LocalProcessExecutor } from './local-process-executor.js';
import type { CoreOperationContext } from '../extensions/operation.js';
import { BUILTIN_TOOL_DEFINITIONS } from '../tools/registry.js';
import { assertMcpToolCatalog } from '../tools/mcp/catalog.js';

export interface LocalAgentMcpBinding {
  readonly tools: readonly import('../model/contracts.js').ClientToolDefinition[];
  readonly catalog?: () => McpToolCatalog;
  call(
    call: ToolCall,
    signal: AbortSignal,
    context?: McpToolCallContext
  ): Promise<ToolExecutionResult>;
}

export interface LocalAgentExecutionMcpBinding extends LocalAgentMcpBinding {
  active: boolean;
  readonly extensions?: LocalAgentExecutionExtensions;
}

export interface LocalAgentExecutionExtensions extends HostExecutionExtensions {
  /** Host-private process environment, snapshotted when bound to an execution. */
  readonly environment?: Readonly<Record<string, string>>;
  isToolAvailable?(
    name: string,
    context: Pick<ToolExecutionContext, 'sessionId' | 'executionId' | 'modelId'>
  ): boolean;
  executeTool?(call: ToolCall, context: ToolExecutionContext): Promise<ToolExecutionResult>;
}

export class LocalAgentHost implements MarAgentHost {
  readonly modelUsage: import('../model/usage-observer.js').ModelUsageObserver | undefined;
  readonly extensionPorts: import('./contracts.js').CoreHostExtensionPorts;
  readonly #home: string;
  readonly #workspace: string;
  readonly #tools: LocalToolRegistry;
  readonly #beforeToolExecute:
    ((call: ToolCall, context: ToolExecutionContext) => Promise<void> | void) | undefined;
  readonly #question:
    | ((
        input: { requestId: string; questions: unknown[] },
        signal: AbortSignal
      ) => Promise<Record<string, unknown>>)
    | undefined;
  readonly #mcpTools: readonly import('../model/contracts.js').ClientToolDefinition[];
  readonly #mcpCatalog: (() => McpToolCatalog) | undefined;
  readonly #mcpSource = randomUUID();
  readonly #toolSource = randomUUID();
  readonly #operationTools: CoreHostToolsBackend | undefined;
  readonly #beforeOperationToolExecute:
    ((input: ToolCall, call: CoreOperationContext) => Promise<void> | void) | undefined;
  readonly #callMcpOperation:
    | ((
        input: ToolCall,
        call: CoreOperationContext,
        expected: NonNullable<McpToolCallContext['expectedTool']>
      ) => Promise<ToolExecutionResult>)
    | undefined;
  readonly #callMcp:
    | ((
        call: ToolCall,
        signal: AbortSignal,
        context?: McpToolCallContext
      ) => Promise<ToolExecutionResult>)
    | undefined;
  readonly #executionMcp = new Map<string, LocalAgentExecutionMcpBinding>();
  #currentExecutionMcp: LocalAgentExecutionMcpBinding | undefined;
  readonly #extensions: LocalAgentExecutionExtensions | undefined;
  readonly events: MarAgentEvent[] = [];
  readonly requestToolApproval: MarAgentHost['requestToolApproval'];
  readonly publishModelImage?: NonNullable<MarAgentHost['publishModelImage']>;
  readonly #mode: 'normal' | 'node';
  readonly #environment: NodeJS.ProcessEnv;
  readonly #sessionEnvironment: LocalSessionEnvironment;
  readonly #guaranteedCommands: Readonly<Record<string, string>>;
  readonly #shell: { readonly name: string; readonly path: string };
  readonly #resourceIdleTtlMs: number | undefined;
  constructor(input: {
    mcp?: import('../extensions/mcp.js').CoreMcpBackend;
    operationTools?: CoreHostToolsBackend;
    beforeOperationToolExecute?: (
      input: ToolCall,
      call: CoreOperationContext
    ) => Promise<void> | void;
    callMcpOperation?: (
      input: ToolCall,
      call: CoreOperationContext,
      expected: NonNullable<McpToolCallContext['expectedTool']>
    ) => Promise<ToolExecutionResult>;
    network?: CoreNetworkBackend | false;
    modelUsage?: import('../model/usage-observer.js').ModelUsageObserver;
    publishModelImage?: MarAgentHost['publishModelImage'];
    homeDirectory: string;
    workspace: string;
    mode?: 'normal' | 'node';
    beforeToolExecute?: (call: ToolCall, context: ToolExecutionContext) => Promise<void> | void;
    approval?: NonNullable<MarAgentHost['requestToolApproval']> | undefined;
    question?: (
      input: { requestId: string; questions: unknown[] },
      signal: AbortSignal
    ) => Promise<Record<string, unknown>>;
    mcpTools?: readonly import('../model/contracts.js').ClientToolDefinition[];
    mcpCatalog?: () => McpToolCatalog;
    callMcp?: (
      call: ToolCall,
      signal: AbortSignal,
      context?: McpToolCallContext
    ) => Promise<ToolExecutionResult>;
    extensions?: LocalAgentExecutionExtensions;
    environment?: NodeJS.ProcessEnv;
    guaranteedCommands?: Readonly<Record<string, string>>;
    resourceIdleTtlMs?: number;
    processExecutor?: LocalProcessExecutor;
    codeModeEngineFactory?: CodeModeEngineFactory;
    restrictPaths?: boolean;
    workspaceWritable?: boolean;
    pathMounts?: readonly WorkspacePathMount[];
  }) {
    this.modelUsage = input.modelUsage;
    this.requestToolApproval = input.approval;
    if (input.publishModelImage !== undefined) this.publishModelImage = input.publishModelImage;
    this.#home = resolve(input.homeDirectory);
    this.#workspace = resolve(input.workspace);
    this.#environment = input.environment ?? process.env;
    this.#guaranteedCommands = input.guaranteedCommands ?? {};
    this.#shell = selectExecutionShell(this.#environment);
    this.#resourceIdleTtlMs = input.resourceIdleTtlMs;
    const processExecutor = input.processExecutor ?? directLocalProcessExecutor;
    this.#sessionEnvironment = new LocalSessionEnvironment(this.#environment, (executionId) => {
      const binding = executionId ? this.#executionMcp.get(executionId) : undefined;
      return binding?.active ? binding.extensions?.environment : undefined;
    });
    this.#tools = new LocalToolRegistry(this.#workspace, this.#environment, this.#shell.path, {
      ...(input.codeModeEngineFactory === undefined
        ? {}
        : { codeModeEngineFactory: input.codeModeEngineFactory }),
      processExecutor: {
        spawn: (request) => processExecutor.spawn(this.#sessionEnvironment.forProcess(request))
      },
      ...(input.restrictPaths === undefined ? {} : { restrictPaths: input.restrictPaths }),
      ...(input.workspaceWritable === undefined
        ? {}
        : { workspaceWritable: input.workspaceWritable }),
      ...(input.pathMounts === undefined ? {} : { pathMounts: input.pathMounts })
    });
    this.extensionPorts = {
      tools: {
        catalog: (sessionId, executionId) => this.#operationToolSources(sessionId, executionId)
      },
      environment: this.#sessionEnvironment,
      ...(input.mcp === undefined ? {} : { mcp: input.mcp }),
      processes: this.#tools.processes,
      files: this.#tools.files,
      ...(input.network === false ? {} : { network: input.network ?? new LocalNetworkAccess() })
    };
    this.#beforeToolExecute = input.beforeToolExecute;
    this.#operationTools = input.operationTools;
    this.#beforeOperationToolExecute = input.beforeOperationToolExecute;
    this.#callMcpOperation = input.callMcpOperation;
    this.#mode = input.mode ?? 'normal';
    this.#question = input.question;
    this.#mcpTools = input.mcpTools ?? [];
    this.#mcpCatalog = input.mcpCatalog;
    this.#callMcp = input.callMcp;
    this.#extensions = input.extensions;
  }
  async describe(): Promise<HostDescription> {
    await mkdir(this.#home, { recursive: true });
    await mkdir(this.#workspace, { recursive: true });
    return {
      apiVersion: MAR_AGENT_HOST_API_VERSION,
      mode: this.#mode,
      homeDirectory: this.#home,
      platform: process.platform as HostDescription['platform'],
      architecture: process.arch,
      shell: this.#shell,
      guaranteedCommands: this.#guaranteedCommands,
      capabilities: [
        'workspace.read',
        'workspace.patch',
        'process.manage',
        'code.execute',
        'user-input.request',
        'event.publish'
      ],
      limits: {
        maxProcesses: TOOL_EXECUTION_LIMITS.maxProcesses,
        maxOutputBytes: TOOL_EXECUTION_LIMITS.execDefaultMaxOutputBytes,
        maxExecutionMs: TOOL_EXECUTION_LIMITS.execMaxTimeoutMs
      }
    };
  }
  async executeTool(call: ToolCall, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    await this.#beforeToolExecute?.(call, context);
    const binding = this.#executionMcp.get(context.executionId);
    const extensions = binding?.extensions ?? this.#extensions;
    if (extensions?.tools?.some((tool) => tool.name === call.name)) {
      if (
        binding?.active === false ||
        !extensions.executeTool ||
        extensions.isToolAvailable?.(call.name, context) === false
      )
        throw new MarAgentError(
          'MAR_AGENT_TOOL_INPUT_INVALID',
          'Host tool execution is unavailable.'
        );
      context.signal.throwIfAborted();
      return extensions.executeTool(call, context);
    }
    return this.#tools.execute(call, context);
  }
  #operationToolSources(sessionId: string, executionId?: string): readonly CoreHostToolSource[] {
    const available = (call: CoreOperationContext) =>
      call.sessionId === sessionId &&
      (!this.#beforeToolExecute || this.#beforeOperationToolExecute !== undefined);
    const policy = async (input: ToolCall, call: CoreOperationContext) => {
      call.signal.throwIfAborted();
      if (!available(call))
        throw new MarAgentError(
          'MAR_AGENT_TOOL_NOT_AVAILABLE',
          'Operation tool policy is unavailable.'
        );
      await this.#beforeOperationToolExecute?.(input, call);
      call.signal.throwIfAborted();
    };
    const local = BUILTIN_TOOL_DEFINITIONS.filter((definition) =>
      this.#tools.names().includes(definition.name)
    ).map((definition): CoreHostToolSource => ({
      definition,
      source: {
        kind: 'builtin',
        id: `${this.#toolSource}:${definition.name}`,
        revision: createHash('sha256').update(JSON.stringify(definition)).digest('hex')
      },
      available: (call) =>
        available(call) && definition.name !== 'code_exec' && definition.name !== 'code_exec_wait',
      execute: async (input, call) => {
        await policy(input, call);
        return this.#tools.executeOperation(input, call);
      }
    }));
    const additional = (this.#operationTools?.catalog(sessionId, executionId) ?? []).map(
      (source): CoreHostToolSource => {
        const execute = source.execute.bind(source);
        const check = source.available?.bind(source);
        return {
          definition: source.definition,
          source: { ...source.source },
          ...(source.mcp === undefined ? {} : { mcp: source.mcp }),
          available: (call) => available(call) && check?.(call) !== false,
          execute: async (input, call) => {
            await policy(input, call);
            if (check?.(call) === false)
              throw new MarAgentError(
                'MAR_AGENT_TOOL_NOT_AVAILABLE',
                'Host tool source is unavailable.'
              );
            return execute(input, call);
          }
        };
      }
    );
    const sharedCatalog = (): McpToolCatalog =>
      structuredClone(
        this.#mcpCatalog?.() ?? {
          revision: '',
          servers: [{ id: 'legacy', name: 'External MCP' }],
          tools: this.#mcpTools.map((definition) => ({
            definition,
            serverId: 'legacy',
            rawName: definition.name,
            sourceIdentity: this.#mcpSource,
            definitionRevision: createHash('sha256')
              .update(JSON.stringify(definition))
              .digest('hex'),
            lifetime: 'session',
            exposure: 'deferred'
          }))
        }
      );
    const catalog =
      this.#callMcpOperation && executionId === undefined
        ? sharedCatalog()
        : { revision: '', servers: [], tools: [] };
    assertMcpToolCatalog(catalog);
    const current = (tool: McpToolCatalog['tools'][number]) => {
      const next = sharedCatalog().tools.find(
        (value) => value.definition.name === tool.definition.name
      );
      return (
        next?.lifetime === 'session' &&
        next.sourceIdentity === tool.sourceIdentity &&
        next.definitionRevision === tool.definitionRevision
      );
    };
    const mcp = this.#callMcpOperation
      ? catalog.tools
          .filter((tool) => tool.lifetime === 'session')
          .map((tool): CoreHostToolSource => ({
            definition: tool.definition,
            mcp: tool,
            source: { kind: 'mcp', id: tool.sourceIdentity, revision: tool.definitionRevision },
            available: (call) => available(call) && current(tool),
            execute: async (input, call) => {
              await policy(input, call);
              if (!current(tool))
                throw new MarAgentError(
                  'MAR_AGENT_MCP_TOOL_DEFINITION_CHANGED',
                  'MCP tool source changed.'
                );
              return this.#callMcpOperation!(input, call, {
                sourceIdentity: tool.sourceIdentity,
                definitionRevision: tool.definitionRevision
              });
            }
          }))
      : [];
    const sources = [...local, ...additional, ...mcp];
    if (new Set(sources.map((source) => source.definition.name)).size !== sources.length)
      throw new MarAgentError('MAR_AGENT_EXTENSION_TOOL_CONFLICT', 'Host tool sources conflict.');
    return sources;
  }
  bindExecutionExtensions(
    extensions: LocalAgentExecutionExtensions,
    mcp?: LocalAgentMcpBinding
  ): LocalAgentExecutionMcpBinding {
    const binding: LocalAgentExecutionMcpBinding = {
      tools: mcp?.tools ?? [],
      ...(mcp?.catalog ? { catalog: mcp.catalog } : {}),
      call:
        mcp?.call.bind(mcp) ??
        (async () => {
          throw new MarAgentError('MAR_AGENT_MCP_FAILED', 'MCP execution is unavailable.');
        }),
      extensions: {
        ...extensions,
        ...(extensions.environment === undefined
          ? {}
          : { environment: { ...extensions.environment } })
      },
      active: true
    };
    this.#currentExecutionMcp = binding;
    return binding;
  }
  async listExecutionExtensions(context: McpToolCatalogContext): Promise<HostExecutionExtensions> {
    const binding = this.#executionBinding(context);
    const {
      environment: _environment,
      isToolAvailable,
      ...extensions
    } = binding?.extensions ?? this.#extensions ?? {};
    return {
      ...extensions,
      ...(extensions.tools === undefined
        ? {}
        : {
            tools: extensions.tools.filter(
              (tool) => isToolAvailable?.(tool.name, context) !== false
            )
          })
    };
  }
  async listSessionSkills(
    _context: Pick<McpToolCatalogContext, 'sessionId' | 'modelId'>
  ): Promise<readonly HostSkill[]> {
    return Object.freeze([...(this.#extensions?.skills ?? [])]);
  }
  emit(event: MarAgentEvent) {
    this.events.push(event);
  }
  async requestUserInput(input: { requestId: string; questions: unknown[] }, signal: AbortSignal) {
    if (!this.#question)
      throw new MarAgentError('MAR_AGENT_USER_INPUT_UNAVAILABLE', 'User input is unavailable.');
    return this.#question(input, signal);
  }
  bindExecutionMcp(binding?: LocalAgentMcpBinding): LocalAgentExecutionMcpBinding | undefined {
    const current = binding === undefined ? undefined : { ...binding, active: true };
    if (current === undefined) this.#currentExecutionMcp = undefined;
    else this.#currentExecutionMcp = current;
    return current;
  }

  unbindExecutionMcp(binding: LocalAgentExecutionMcpBinding | undefined): void {
    if (binding !== undefined) binding.active = false;
    if (this.#currentExecutionMcp === binding) this.#currentExecutionMcp = undefined;
    for (const [executionId, candidate] of this.#executionMcp)
      if (candidate === binding) this.#executionMcp.delete(executionId);
  }

  listMcpTools(context?: McpToolCatalogContext) {
    const execution = this.#executionBinding(context);
    const tools = [
      ...(this.#mcpCatalog?.().tools.map((tool) => tool.definition) ?? this.#mcpTools),
      ...(execution?.active
        ? (execution.catalog?.().tools.map((tool) => tool.definition) ?? execution.tools)
        : [])
    ];
    if (new Set(tools.map((tool) => tool.name)).size !== tools.length)
      throw new MarAgentError('MAR_AGENT_MCP_FAILED', 'MCP tool names conflict.');
    return Promise.resolve(tools);
  }
  async listMcpToolCatalog(context: McpToolCatalogContext): Promise<McpToolCatalog> {
    const execution = this.#executionBinding(context);
    const fallback = (
      tools: readonly import('../model/contracts.js').ClientToolDefinition[],
      lifetime: 'session' | 'execution'
    ): McpToolCatalog => ({
      revision: '',
      servers: [{ id: 'legacy', name: 'External MCP' }],
      tools: tools.map((definition) => ({
        definition,
        serverId: 'legacy',
        rawName: definition.name,
        sourceIdentity: this.#mcpSource,
        definitionRevision: createHash('sha256').update(JSON.stringify(definition)).digest('hex'),
        lifetime,
        exposure: 'deferred'
      }))
    });
    const shared =
      this.#mcpCatalog?.() ??
      fallback(execution ? this.#mcpTools : await this.listMcpTools(context), 'session');
    const scoped = execution?.active
      ? (execution.catalog?.() ?? fallback(execution.tools, 'execution'))
      : { revision: '', servers: [], tools: [] };
    const servers = [
      ...new Map(
        [...shared.servers, ...scoped.servers].map((server) => [server.id, server])
      ).values()
    ];
    const tools = [...shared.tools, ...scoped.tools];
    if (new Set(tools.map((tool) => tool.definition.name)).size !== tools.length)
      throw new MarAgentError('MAR_AGENT_MCP_FAILED', 'MCP tool names conflict.');
    return {
      servers,
      tools,
      revision: createHash('sha256')
        .update(
          JSON.stringify({
            servers: [...servers].sort((a, b) => a.id.localeCompare(b.id)),
            tools: [...tools].sort((a, b) => a.definition.name.localeCompare(b.definition.name))
          })
        )
        .digest('hex')
    };
  }
  #executionBinding(context?: McpToolCatalogContext) {
    const execution =
      context?.claimExecutionScope === true
        ? this.#currentExecutionMcp
        : context?.executionScopeId === undefined
          ? undefined
          : this.#executionMcp.get(context.executionScopeId);
    if (context !== undefined && execution !== undefined)
      this.#executionMcp.set(context.executionId, execution);
    return execution;
  }
  async callMcpTool(call: ToolCall, signal: AbortSignal, context?: McpToolCallContext) {
    signal.throwIfAborted();
    if (context)
      await this.#beforeToolExecute?.(call, {
        mode: context.mode ?? 'run',
        signal,
        sessionId: context.sessionId,
        executionId: context.executionId
      });
    signal.throwIfAborted();
    if (context?.expectedTool) {
      const current = (
        await this.listMcpToolCatalog({
          sessionId: context.sessionId,
          executionId: context.executionId,
          executionScopeId: context.executionId
        })
      ).tools.find((tool) => tool.definition.name === call.name);
      if (
        !current ||
        current.sourceIdentity !== context.expectedTool.sourceIdentity ||
        current.definitionRevision !== context.expectedTool.definitionRevision
      )
        throw new MarAgentError(
          'MAR_AGENT_MCP_TOOL_DEFINITION_CHANGED',
          'MCP tool binding or definition changed.'
        );
    }
    signal.throwIfAborted();
    const execution =
      context === undefined
        ? this.#currentExecutionMcp
        : this.#executionMcp.get(context.executionId);
    if (
      (execution?.catalog?.().tools.map((tool) => tool.definition) ?? execution?.tools)?.some(
        (tool) => tool.name === call.name
      )
    ) {
      if (!execution.active)
        throw new MarAgentError('MAR_AGENT_MCP_FAILED', 'Execution MCP is no longer available.');
      return execution.call(call, signal, context);
    }
    if (
      !this.#callMcp ||
      !(this.#mcpCatalog?.().tools.map((tool) => tool.definition) ?? this.#mcpTools).some(
        (tool) => tool.name === call.name
      )
    )
      throw new MarAgentError('MAR_AGENT_MCP_FAILED', 'MCP tool execution is unavailable.');
    return this.#callMcp(call, signal, context);
  }
  listSessionResources(sessionId: string) {
    return Promise.resolve({
      ...(this.#resourceIdleTtlMs === undefined ? {} : { idleTtlMs: this.#resourceIdleTtlMs }),
      processes: this.#tools.listSessionResources(sessionId),
      codeCells: this.#tools.listCodeCells(sessionId)
    });
  }
  async disposeSessionResources(sessionId: string) {
    try {
      await this.#tools.disposeSessionResources(sessionId);
    } finally {
      this.#sessionEnvironment.clearSession(sessionId);
    }
  }
  async dispose() {
    try {
      await this.#tools.dispose();
    } finally {
      this.#sessionEnvironment.clear();
    }
  }
}

export function selectExecutionShell(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  available: (path: string) => boolean = existsSync
): { name: string; path: string } {
  const candidates =
    platform === 'win32'
      ? [
          resolveCommand('pwsh.exe', environment, platform, available),
          resolveCommand('powershell.exe', environment, platform, available),
          environment['ComSpec'],
          environment['COMSPEC'],
          'cmd.exe'
        ]
      : ['/bin/bash', resolveCommand('bash', environment, platform, available), '/bin/sh'];
  const path =
    candidates.find((candidate) => candidate && available(candidate)) ?? candidates.at(-1)!;
  const name = (platform === 'win32' ? win32.basename(path) : basename(path)).replace(
    /\.exe$/iu,
    ''
  );
  return { name, path };
}

function resolveCommand(
  name: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  available: (path: string) => boolean
): string | undefined {
  if (isAbsolute(name)) return available(name) ? name : undefined;
  const pathValue = environment[platform === 'win32' ? 'Path' : 'PATH'] ?? environment['PATH'];
  if (!pathValue) return undefined;
  const separator = platform === 'win32' ? win32.delimiter : delimiter;
  const combine = platform === 'win32' ? win32.join : join;
  for (const directory of pathValue.split(separator).filter(Boolean)) {
    const candidate = combine(directory, name);
    if (available(candidate)) return candidate;
  }
  return undefined;
}

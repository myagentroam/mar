import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { minimalRunnerEnvironment, platformCliInvocation, runRunnerProbe } from './operational.js';

const REQUEST_TIMEOUT_MS = 15_000;

export interface CodexProbe {
  readonly available: boolean;
  readonly version?: string;
  readonly compatible: boolean;
}

/**
 * The visible control state of a Codex thread.  This deliberately models a
 * verified transport, not a guess based on a transcript file.
 */
export type CodexSessionControlLevel = 'MANAGED';

export interface CodexSessionControl {
  readonly level: CodexSessionControlLevel;
  readonly capabilities: readonly (
    'history.read' | 'events.live' | 'turn.start' | 'turn.steer' | 'turn.interrupt'
  )[];
}

/**
 * Maps the facts that the Node can establish to the unified session controls.
 * Native-session activation is validated atomically with the first message.
 */
export function codexSessionControl(input: {
  readonly available: boolean;
  readonly nativeThreadId: string | null;
  readonly nativeControl: 'MAR_MANAGED' | 'EXTERNAL';
  readonly activeTurn: boolean;
}): CodexSessionControl {
  void [input.available, input.nativeThreadId, input.nativeControl];
  if (input.activeTurn) {
    return {
      level: 'MANAGED',
      capabilities: ['history.read', 'events.live', 'turn.steer', 'turn.interrupt']
    };
  }
  return {
    level: 'MANAGED',
    capabilities: ['history.read', 'turn.start']
  };
}

export interface JsonRpcNotification {
  readonly method: string;
  readonly params: unknown;
  readonly requestId?: string | number;
}

export interface CodexAppServerOptions {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly spawnProcess?: (
    command: string,
    args: readonly string[],
    options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv }
  ) => ChildProcessWithoutNullStreams;
}

export interface CodexRunConfiguration {
  readonly model?: string | null;
  readonly effort?: string | null;
  readonly access?: string | null;
  readonly serviceTier?: 'fast';
  readonly collaborationMode?: 'default' | 'plan';
  readonly mcpServers?: unknown;
  readonly developerInstructions?: string;
}

interface CodexRpcErrorPayload {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly data?: unknown;
}

export class CodexAppServerRpcError extends Error {
  readonly code: unknown;
  readonly rpcMessage: string;
  readonly data: unknown;

  constructor(payload: CodexRpcErrorPayload) {
    const rpcMessage =
      typeof payload.message === 'string' ? payload.message : 'Codex App Server request failed';
    super(`CODEX_APP_SERVER_RPC_ERROR:${JSON.stringify(payload)}`);
    this.name = 'CodexAppServerRpcError';
    this.code = payload.code;
    this.rpcMessage = rpcMessage;
    this.data = payload.data;
  }
}

export function isCodexRolloutMissingError(error: unknown): boolean {
  return (
    error instanceof CodexAppServerRpcError &&
    error.code === -32600 &&
    (/^no rollout found for thread id\b/i.test(error.rpcMessage) ||
      /^thread not loaded:\s*/i.test(error.rpcMessage))
  );
}

/** Public App Server turn inputs supported by the Workbench Composer. */
export type CodexComposerInput =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'localImage'; readonly path: string };

interface JsonRpcTransport {
  readonly writable: boolean;
  write(data: string): boolean;
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  once(event: 'error' | 'close', listener: (error?: Error) => void): unknown;
  destroy(): void;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
  readonly timer: NodeJS.Timeout;
}

/**
 * Local JSON-RPC client for a Node-supervised Codex App Server over stdio.
 * The transport is not exposed to MAR Server or the browser.
 */
export class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private transport: JsonRpcTransport | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly pendingDrainWaiters = new Set<() => void>();
  private readonly notifications = new Set<(notification: JsonRpcNotification) => void>();
  private environment: Readonly<Record<string, string>> = {};
  private starting: Promise<void> | undefined;
  private restarting: Promise<void> | undefined;
  private lifecycleRevision = 0;

  constructor(private readonly options: CodexAppServerOptions = {}) {}

  configureEnvironment(environment: Readonly<Record<string, string>>): void {
    if (this.child !== undefined) throw new Error('CODEX_APP_SERVER_ALREADY_STARTED');
    this.environment = { ...environment };
  }

  clearEnvironment(): void {
    if (this.child !== undefined) throw new Error('CODEX_APP_SERVER_ALREADY_STARTED');
    this.environment = {};
  }

  start(): Promise<void> {
    if (this.restarting !== undefined) return this.restarting;
    if (this.starting !== undefined) return this.starting;
    if (this.child !== undefined) return Promise.resolve();
    const starting = this.startManaged();
    this.starting = starting;
    const clearStarting = () => {
      if (this.starting === starting) this.starting = undefined;
    };
    void starting.then(clearStarting, clearStarting);
    return starting;
  }

  restart(): Promise<void> {
    if (this.restarting !== undefined) return this.restarting;
    const restarting = this.restartManaged(this.lifecycleRevision);
    this.restarting = restarting;
    const clearRestarting = () => {
      if (this.restarting === restarting) this.restarting = undefined;
    };
    void restarting.then(clearRestarting, clearRestarting);
    return restarting;
  }

  private async startManaged(): Promise<void> {
    const command = this.options.command ?? 'codex';
    const args = this.options.args ?? ['app-server'];
    const spawnProcess = this.options.spawnProcess ?? defaultSpawn;
    const child = spawnProcess(command, args, {
      ...(this.options.cwd === undefined ? {} : { cwd: this.options.cwd }),
      env: { ...minimalRunnerEnvironment(), ...this.environment }
    });
    this.child = child;
    this.transport = stdioTransport(child);
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => this.handleLine(line));
    const managedChild = child;
    child.once('error', (error) => {
      if (this.child !== managedChild) return;
      this.failAll(new Error(`CODEX_APP_SERVER_START_FAILED:${error.message}`));
    });
    child.once('exit', () => {
      if (this.child !== managedChild) return;
      this.child = undefined;
      this.failAll(new Error('CODEX_APP_SERVER_EXITED'));
    });
    await this.requestDirect('initialize', {
      clientInfo: { name: 'codex_vscode', title: 'MyAgentRoam', version: '0.1.4' },
      capabilities: { experimentalApi: true }
    });
    this.notify('initialized', {});
  }

  private async restartManaged(lifecycleRevision: number): Promise<void> {
    await Promise.resolve();
    if (this.starting !== undefined) await this.starting;
    await this.waitForPendingRequests();
    if (this.lifecycleRevision !== lifecycleRevision) throw new Error('CODEX_APP_SERVER_STOPPED');
    this.stopManaged();
    await this.startManaged();
  }

  stop(): void {
    this.lifecycleRevision += 1;
    this.stopManaged();
  }

  async stopAndWait(): Promise<void> {
    const child = this.child;
    if (child === undefined) {
      this.stop();
      return;
    }
    const exited = new Promise<void>((resolve, reject) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else {
        let forcedTimeout: NodeJS.Timeout | undefined;
        const onExit = () => {
          clearTimeout(timeout);
          if (forcedTimeout !== undefined) clearTimeout(forcedTimeout);
          resolve();
        };
        const timeout = setTimeout(() => {
          child.kill('SIGKILL');
          forcedTimeout = setTimeout(() => {
            child.off('exit', onExit);
            reject(new Error('CODEX_APP_SERVER_STOP_TIMEOUT'));
          }, 2_000);
        }, 2_000);
        child.once('exit', onExit);
      }
    });
    this.stop();
    await exited;
  }

  private stopManaged(): void {
    this.transport?.destroy();
    this.transport = undefined;
    this.child?.kill();
    this.child = undefined;
    this.failAll(new Error('CODEX_APP_SERVER_STOPPED'));
  }

  onNotification(listener: (notification: JsonRpcNotification) => void): () => void {
    this.notifications.add(listener);
    return () => this.notifications.delete(listener);
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (this.restarting !== undefined) await this.restarting;
    else if (this.starting !== undefined) await this.starting;
    return this.requestDirect(method, params);
  }

  private requestDirect(method: string, params: unknown): Promise<unknown> {
    const transport = this.transport;
    if (transport === undefined || !transport.writable)
      throw new Error('CODEX_APP_SERVER_UNAVAILABLE');
    const id = this.nextId++;
    const timeoutMs = this.options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.resolvePendingDrain();
        reject(new Error('CODEX_APP_SERVER_TIMEOUT'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    transport.write(`${JSON.stringify({ method, id, params })}\n`);
    return result;
  }

  private waitForPendingRequests(): Promise<void> {
    if (this.pending.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.pendingDrainWaiters.add(resolve));
  }

  private resolvePendingDrain(): void {
    if (this.pending.size !== 0) return;
    for (const resolve of this.pendingDrainWaiters) resolve();
    this.pendingDrainWaiters.clear();
  }

  notify(method: string, params: unknown): void {
    const transport = this.transport;
    if (transport === undefined || !transport.writable)
      throw new Error('CODEX_APP_SERVER_UNAVAILABLE');
    transport.write(`${JSON.stringify({ method, params })}\n`);
  }

  respond(requestId: string | number, result: unknown): void {
    const transport = this.transport;
    if (transport === undefined || !transport.writable)
      throw new Error('CODEX_APP_SERVER_UNAVAILABLE');
    transport.write(`${JSON.stringify({ id: requestId, result })}\n`);
  }

  startThread(cwd: string, configuration: CodexRunConfiguration = {}): Promise<unknown> {
    return this.request('thread/start', {
      cwd,
      experimentalRawEvents: true,
      ...codexThreadConfiguration(cwd, configuration)
    });
  }

  listThreads(): Promise<unknown> {
    return this.request('thread/list', {});
  }

  readThread(threadId: string): Promise<unknown> {
    return this.request('thread/read', { threadId, includeTurns: false });
  }

  listCollaborationModes(): Promise<unknown> {
    return this.request('collaborationMode/list', {});
  }

  listModels(params: {
    readonly cursor: string | null;
    readonly limit: number;
    readonly includeHidden: boolean;
  }): Promise<unknown> {
    return this.request('model/list', params);
  }

  forkThread(
    threadId: string,
    cwd: string,
    lastTurnId: string,
    configuration: CodexRunConfiguration = {}
  ): Promise<unknown> {
    return this.request('thread/fork', {
      threadId,
      lastTurnId,
      cwd,
      ...codexThreadConfiguration(cwd, configuration)
    });
  }

  revertThread(threadId: string, beforeTurnId: string): Promise<unknown> {
    return this.request('thread/revert', { threadId, beforeTurnId });
  }

  listThreadTurns(
    threadId: string,
    input: { readonly cursor?: string; readonly limit: number }
  ): Promise<unknown> {
    return this.request('thread/turns/list', {
      threadId,
      ...input,
      itemsView: 'full',
      sortDirection: 'desc'
    });
  }

  setThreadName(threadId: string, name: string): Promise<unknown> {
    return this.request('thread/name/set', { threadId, name });
  }

  resumeThread(
    threadId: string,
    cwd: string,
    configuration: CodexRunConfiguration = {}
  ): Promise<unknown> {
    return this.request('thread/resume', {
      threadId,
      cwd,
      ...codexThreadConfiguration(cwd, configuration)
    });
  }

  startTurn(
    threadId: string,
    text: string,
    cwd: string,
    configuration: CodexRunConfiguration = {},
    attachments: readonly Extract<CodexComposerInput, { readonly type: 'localImage' }>[] = []
  ): Promise<unknown> {
    return this.request('turn/start', {
      threadId,
      cwd,
      input: [{ type: 'text', text }, ...attachments],
      ...codexTurnConfiguration(cwd, configuration)
    });
  }

  steerTurn(threadId: string, expectedTurnId: string, text: string): Promise<unknown> {
    return this.request('turn/steer', {
      threadId,
      expectedTurnId,
      input: [{ type: 'text', text }]
    });
  }

  interruptTurn(threadId: string, turnId: string): Promise<unknown> {
    return this.request('turn/interrupt', { threadId, turnId });
  }

  private handleLine(line: string): void {
    let message: {
      id?: unknown;
      result?: unknown;
      error?: unknown;
      method?: unknown;
      params?: unknown;
    };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return;
    }
    if (
      (typeof message.id === 'number' || typeof message.id === 'string') &&
      typeof message.method === 'string'
    ) {
      for (const listener of this.notifications) {
        listener({ method: message.method, params: message.params, requestId: message.id });
      }
      return;
    }
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      this.resolvePendingDrain();
      if (message.error !== undefined) {
        pending.reject(
          new CodexAppServerRpcError(
            isRecord(message.error) ? message.error : { message: String(message.error) }
          )
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === 'string') {
      for (const listener of this.notifications)
        listener({ method: message.method, params: message.params });
    }
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    this.resolvePendingDrain();
  }
}

function codexThreadConfiguration(cwd: string, configuration: CodexRunConfiguration) {
  return {
    ...modelOption(configuration.model),
    ...(configuration.developerInstructions === undefined
      ? {}
      : { developerInstructions: configuration.developerInstructions }),
    ...(configuration.mcpServers === undefined
      ? {}
      : {
          config: {
            mcp_servers: configuration.mcpServers
          }
        }),
    ...codexPermissionConfiguration(cwd, configuration.access, 'thread')
  };
}

function codexTurnConfiguration(cwd: string, configuration: CodexRunConfiguration) {
  const effort =
    typeof configuration.effort === 'string' && configuration.effort.trim().length > 0
      ? configuration.effort
      : null;
  return {
    ...modelOption(configuration.model),
    ...(effort === null ? {} : { effort }),
    ...(configuration.serviceTier === 'fast' ? { serviceTier: 'fast' } : {}),
    ...(configuration.collaborationMode === undefined
      ? {}
      : {
          collaborationMode: {
            mode: configuration.collaborationMode,
            settings: {
              model: configuration.model ?? 'gpt-5.6-sol',
              reasoningEffort: effort
            }
          }
        }),
    ...codexPermissionConfiguration(cwd, configuration.access, 'turn')
  };
}

function modelOption(model: string | null | undefined) {
  return model === undefined || model === null ? {} : { model };
}

function codexPermissionConfiguration(
  cwd: string,
  access: string | null | undefined,
  phase: 'thread' | 'turn'
) {
  const sandbox =
    access === 'read-only'
      ? 'read-only'
      : access === 'workspace-write' || access === 'on-request'
        ? 'workspace-write'
        : access === 'full-access'
          ? 'danger-full-access'
          : undefined;
  const approvalPolicy =
    access === 'workspace-write' || access === 'full-access' ? 'never' : 'on-request';
  if (phase === 'thread')
    return {
      ...(sandbox === undefined ? {} : { sandbox }),
      approvalPolicy
    };
  return {
    ...(sandbox === undefined
      ? {}
      : {
          sandboxPolicy:
            sandbox === 'read-only'
              ? { type: 'readOnly' }
              : sandbox === 'danger-full-access'
                ? { type: 'dangerFullAccess' }
                : { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: true }
        }),
    approvalPolicy
  };
}

export function probeCodex(command = 'codex'): CodexProbe {
  const invocation = platformCliInvocation(command, ['--version']);
  const result = spawnSync(invocation.command, invocation.args, {
    windowsHide: true,
    env: minimalRunnerEnvironment(),
    timeout: 3_000,
    encoding: 'utf8'
  });
  if (result.status !== 0 || result.error !== undefined)
    return { available: false, compatible: false };
  const version = `${result.stdout}${result.stderr}`.trim().slice(0, 128);
  return {
    available: true,
    ...(version.length === 0 ? {} : { version }),
    // The CLI version is metadata only. Actual compatibility is established
    // by the App Server initialize handshake when the client starts.
    compatible: true
  };
}

export async function probeCodexAsync(command = 'codex'): Promise<CodexProbe> {
  const invocation = platformCliInvocation(command, ['--version']);
  const result = await runRunnerProbe(invocation.command, invocation.args, {
    env: minimalRunnerEnvironment(),
    timeoutMs: 3_000
  });
  if (result.status !== 0) return { available: false, compatible: false };
  const version = `${result.stdout}${result.stderr}`.trim().slice(0, 128);
  return {
    available: true,
    ...(version.length === 0 ? {} : { version }),
    // Do not reject a newer CLI before its App Server has had a chance to
    // negotiate the protocol it actually supports.
    compatible: true
  };
}

export function isSupportedCodexVersion(version: string): boolean {
  return version.trim().length > 0;
}

function defaultSpawn(
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv }
): ChildProcessWithoutNullStreams {
  const invocation = platformCliInvocation(command, args);
  return spawn(invocation.command, invocation.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env })
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stdioTransport(child: ChildProcessWithoutNullStreams): JsonRpcTransport {
  return {
    get writable() {
      return child.stdin.writable;
    },
    write: (data) => child.stdin.write(data),
    on: (event, listener) => child.stdout.on(event, listener),
    once: (event, listener) => child.stdout.once(event, listener),
    destroy: () => child.stdout.destroy()
  };
}

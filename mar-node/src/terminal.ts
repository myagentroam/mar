import { randomUUID } from 'node:crypto';
import { spawn as spawnProcess } from 'node:child_process';
import { chmodSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn, type IPty } from 'node-pty';
import { terminalDataFrameSchema, type TerminalDataFrame } from '@myagentroam/protocol';
import { nodeExecutionEnvironment } from './node-execution-environment.js';
import { terminateProcessTree, type ManagedProcess } from './process-tree.js';

const MAX_FRAME_CHARACTERS = 65_536;
const TERMINAL_COMMAND_MAX_BYTES = 64 * 1024;
const DEFAULT_MAX_TERMINALS = 10;
const DEFAULT_MAX_TERMINALS_PER_WORKSPACE = 5;
const DEFAULT_MAX_REPLAY_BYTES = 512 * 1024;
const DEFAULT_IDLE_TIMEOUT_MS = 60 * 60_000;

export type TerminalPlatform = 'linux' | 'darwin' | 'win32';
export type TerminalState = 'RUNNING' | 'EXITED' | 'CLOSED';

/** The subset of node-pty used by the terminal lifecycle, kept injectable for tests. */
export interface TerminalPty extends ManagedProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
}

export interface TerminalProfile {
  readonly id: string;
  readonly label: string;
  readonly shell: string;
  readonly args: readonly string[];
  readonly isDefault: boolean;
}

export interface TerminalSpawnOptions {
  readonly name: string;
  readonly cols: number;
  readonly rows: number;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export type TerminalPtyFactory = (
  shell: string,
  args: readonly string[],
  options: TerminalSpawnOptions
) => TerminalPty;

export interface TerminalPipe extends ManagedProcess {
  pause?(): void;
  resume?(): void;
  write(data: Buffer): void;
  onData(listener: (data: Buffer) => void): void;
  onExit(listener: (exitCode: number) => void): void;
}

export type TerminalPipeFactory = (
  shell: string,
  args: readonly string[],
  options: TerminalSpawnOptions
) => TerminalPipe;

export interface TerminalManagerOptions {
  readonly platform?: TerminalPlatform;
  /** This is controlled by the Node service, never supplied by a browser request. */
  readonly cwd?: string;
  readonly profiles?: readonly TerminalProfile[];
  readonly maxTerminals?: number;
  readonly maxTerminalsPerWorkspace?: number;
  readonly maxReplayBytes?: number;
  readonly idleTimeoutMs?: number;
  readonly now?: () => number;
  readonly ptyFactory?: TerminalPtyFactory;
  readonly pipeFactory?: TerminalPipeFactory;
  readonly terminate?: (process: ManagedProcess, platform: TerminalPlatform) => Promise<void>;
}

export interface TerminalSummary {
  readonly id: string;
  readonly workspaceId: string | null;
  readonly profileId: string;
  readonly state: TerminalState;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly exitCode: number | null;
  readonly rows: number;
  readonly cols: number;
  readonly latestSequence: number;
}

export interface TerminalAttachment {
  readonly attachmentId: string;
  readonly terminalId: string;
  readonly readonly: boolean;
  readonly latestSequence: number;
  readonly frames: readonly TerminalDataFrame[];
}

export interface TerminalAttachmentSynchronization {
  readonly active: boolean;
  readonly reason?: 'INACTIVE';
  readonly frames: readonly TerminalDataFrame[];
}

interface TerminalReplayFrame {
  readonly sequence: number;
  readonly data: string;
  readonly bytes: number;
}

interface ManagedTerminal {
  readonly id: string;
  workspaceId: string | null;
  readonly profile: TerminalProfile;
  pty: TerminalPty | undefined;
  pipe: TerminalPipe | undefined;
  readonly subscriptions: { dispose(): void }[];
  readonly binary: boolean;
  outputPaused?: boolean;
  outputBackpressureAttachments?: ReadonlySet<string>;
  deferredCommand?: {
    readonly shell: string;
    readonly args: readonly string[];
    readonly options: TerminalSpawnOptions;
  };
  readonly createdAt: number;
  state: TerminalState;
  updatedAt: number;
  exitCode: number | null;
  rows: number;
  cols: number;
  sequence: number;
  replayBytes: number;
  readonly replay: TerminalReplayFrame[];
  writerAttachmentId: string | undefined;
  lastUsedAt: number;
  detachedAt: number | undefined;
}

interface ManagedAttachment {
  readonly terminalId: string;
  readonly readonly: boolean;
}

/**
 * Owns Node-local PTY/ConPTY processes and their bounded output replay.
 * Browser relay transport intentionally lives outside this class: callers pass
 * only schema-validated TerminalDataFrame values after Server authorization.
 */
export class TerminalManager {
  private readonly platform: TerminalPlatform;
  private readonly cwd: string;
  private readonly profiles: readonly TerminalProfile[];
  private readonly maxTerminals: number;
  private readonly maxTerminalsPerWorkspace: number;
  private readonly maxReplayBytes: number;
  private readonly idleTimeoutMs: number;
  private readonly now: () => number;
  private readonly ptyFactory: TerminalPtyFactory;
  private readonly pipeFactory: TerminalPipeFactory;
  private readonly terminate: (
    process: ManagedProcess,
    platform: TerminalPlatform
  ) => Promise<void>;
  private readonly terminals = new Map<string, ManagedTerminal>();
  private readonly closing = new Map<string, Promise<TerminalSummary>>();
  private readonly attachments = new Map<string, ManagedAttachment>();
  private readonly frameListeners = new Set<(frame: TerminalDataFrame) => void>();
  private readonly summaryListeners = new Set<(summary: TerminalSummary) => void>();
  private idleTimer: NodeJS.Timeout | undefined;

  constructor(options: TerminalManagerOptions = {}) {
    this.platform =
      options.platform ??
      (process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux');
    this.cwd = options.cwd ?? homedir();
    this.profiles = options.profiles ?? defaultTerminalProfiles(this.platform);
    if (this.profiles.length === 0 || !this.profiles.some((profile) => profile.isDefault)) {
      throw new Error('TERMINAL_PROFILE_INVALID');
    }
    this.maxTerminals = options.maxTerminals ?? DEFAULT_MAX_TERMINALS;
    this.maxTerminalsPerWorkspace =
      options.maxTerminalsPerWorkspace ?? DEFAULT_MAX_TERMINALS_PER_WORKSPACE;
    this.maxReplayBytes = options.maxReplayBytes ?? DEFAULT_MAX_REPLAY_BYTES;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.maxTerminals) ||
      this.maxTerminals < 1 ||
      this.maxTerminals > 64 ||
      !Number.isSafeInteger(this.maxTerminalsPerWorkspace) ||
      this.maxTerminalsPerWorkspace < 1 ||
      this.maxTerminalsPerWorkspace > this.maxTerminals ||
      !Number.isSafeInteger(this.maxReplayBytes) ||
      this.maxReplayBytes < 1 ||
      this.maxReplayBytes > 16 * 1024 * 1024 ||
      !Number.isSafeInteger(this.idleTimeoutMs) ||
      this.idleTimeoutMs < 1_000
    ) {
      throw new Error('TERMINAL_CONFIG_INVALID');
    }
    this.now = options.now ?? Date.now;
    this.ptyFactory = options.ptyFactory ?? nodePtyFactory;
    this.pipeFactory = options.pipeFactory ?? nodePipeFactory;
    this.terminate =
      options.terminate ?? ((child, platform) => terminateProcessTree(child, platform));
    this.idleTimer = setInterval(
      () => void this.closeExpired(),
      Math.min(this.idleTimeoutMs, 60_000)
    );
    this.idleTimer.unref();
  }

  availableProfiles(): readonly Pick<TerminalProfile, 'id' | 'label' | 'isDefault'>[] {
    return this.profiles.map(({ id, label, isDefault }) => ({ id, label, isDefault }));
  }

  limits(): {
    readonly maxTerminals: number;
    readonly maxTerminalsPerWorkspace: number;
    readonly maxReplayBytes: number;
    readonly reconnectWindowMs: number;
  } {
    return {
      maxTerminals: this.maxTerminals,
      maxTerminalsPerWorkspace: this.maxTerminalsPerWorkspace,
      maxReplayBytes: this.maxReplayBytes,
      reconnectWindowMs: this.idleTimeoutMs
    };
  }

  open(
    input: {
      readonly profileId?: unknown;
      readonly rows?: unknown;
      readonly cols?: unknown;
      readonly cwd?: unknown;
      /** Resolved by NodeConnector; never trusted from a browser directly. */
      readonly workspaceId?: string | null;
      readonly environment?: Readonly<Record<string, string>>;
    } = {}
  ): TerminalSummary {
    return this.openInternal(input);
  }

  /** A command starts only after a relay or direct Terminal attachment is active. */
  openCommand(
    input: Parameters<TerminalManager['open']>[0],
    command: unknown,
    binary = false
  ): TerminalSummary {
    if (
      typeof command !== 'string' ||
      command.trim().length === 0 ||
      Buffer.byteLength(command, 'utf8') > TERMINAL_COMMAND_MAX_BYTES ||
      command.includes('\0')
    )
      throw new Error('TERMINAL_COMMAND_INVALID');
    return this.openInternal(input, command, binary);
  }

  startCommand(terminalId: string): void {
    const terminal = this.requireTerminal(terminalId);
    const deferred = terminal.deferredCommand;
    if (terminal.state !== 'RUNNING' || deferred === undefined) return;
    delete terminal.deferredCommand;
    try {
      if (terminal.binary) {
        const pipe = this.pipeFactory(deferred.shell, deferred.args, deferred.options);
        terminal.pipe = pipe;
        if (terminal.outputPaused) pipe.pause?.();
        pipe.onData((data) => this.recordBinaryOutput(terminal, data));
        pipe.onExit((exitCode) => this.exited(terminal, exitCode));
      } else {
        const pty = this.ptyFactory(deferred.shell, deferred.args, deferred.options);
        terminal.pty = pty;
        this.listenToPty(terminal, pty);
      }
    } catch {
      this.emit({ type: 'error', terminalId, code: 'TERMINAL_COMMAND_START_FAILED' });
      this.exited(terminal, 127);
    }
  }

  private openInternal(
    input: Parameters<TerminalManager['open']>[0] = {},
    command?: string,
    binary = false
  ): TerminalSummary {
    const profileId = input.profileId ?? this.profiles.find((profile) => profile.isDefault)?.id;
    if (typeof profileId !== 'string') throw new Error('TERMINAL_PROFILE_INVALID');
    const profile = this.profiles.find((candidate) => candidate.id === profileId);
    if (profile === undefined) throw new Error('TERMINAL_PROFILE_INVALID');
    const rows = terminalDimension(input.rows, 24);
    const cols = terminalDimension(input.cols, 80);
    if (input.cwd !== undefined && typeof input.cwd !== 'string')
      throw new Error('TERMINAL_OPEN_INVALID');
    if (
      input.workspaceId !== undefined &&
      input.workspaceId !== null &&
      typeof input.workspaceId !== 'string'
    )
      throw new Error('TERMINAL_OPEN_INVALID');
    this.evictForNewTerminal(input.workspaceId ?? null);
    const options: TerminalSpawnOptions = {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: typeof input.cwd === 'string' ? input.cwd : this.cwd,
      env: nodeExecutionEnvironment(input.environment, process.env, { platform: this.platform })
    };
    const commandArgs =
      command === undefined
        ? undefined
        : this.platform === 'win32'
          ? profile.shell.toLowerCase().endsWith('cmd.exe')
            ? ['/D', '/C', command]
            : ['-NoLogo', '-NoProfile', '-Command', command]
          : ['-c', command];
    const pty =
      commandArgs === undefined ? this.ptyFactory(profile.shell, profile.args, options) : undefined;
    const createdAt = this.now();
    const terminal: ManagedTerminal = {
      id: randomUUID(),
      workspaceId: input.workspaceId ?? null,
      profile,
      pty,
      pipe: undefined,
      subscriptions: [],
      binary,
      ...(commandArgs === undefined
        ? {}
        : { deferredCommand: { shell: profile.shell, args: commandArgs, options } }),
      createdAt,
      state: 'RUNNING',
      updatedAt: createdAt,
      exitCode: null,
      rows,
      cols,
      sequence: 0,
      replayBytes: 0,
      replay: [],
      writerAttachmentId: undefined,
      lastUsedAt: createdAt,
      detachedAt: createdAt
    };
    this.terminals.set(terminal.id, terminal);
    if (pty !== undefined) this.listenToPty(terminal, pty);
    return this.notifySummary(terminal);
  }

  list(): readonly TerminalSummary[] {
    return [...this.terminals.values()].map((terminal) => this.summary(terminal));
  }

  get(terminalId: string): TerminalSummary {
    return this.summary(this.requireTerminal(terminalId));
  }

  /** A removed registration no longer owns live or historical Terminal metadata. */
  removeWorkspaceAssociation(workspaceId: string): void {
    for (const terminal of this.terminals.values()) {
      if (terminal.workspaceId !== workspaceId) continue;
      terminal.workspaceId = null;
      terminal.updatedAt = this.now();
      this.notifySummary(terminal);
    }
  }

  /** One attachment may write; active writers cannot be replaced. */
  authorizeAttach(input: {
    readonly terminalId?: unknown;
    readonly afterSequence?: unknown;
    readonly readonly?: unknown;
    readonly takeover?: unknown;
  }): TerminalAttachment {
    if (typeof input.terminalId !== 'string') throw new Error('TERMINAL_NOT_FOUND');
    const terminal = this.requireTerminal(input.terminalId);
    if (terminal.state !== 'RUNNING') throw new Error('TERMINAL_CLOSED');
    const afterSequence = terminalSequence(input.afterSequence);
    const readonly = input.readonly === true;
    if (input.readonly !== undefined && typeof input.readonly !== 'boolean')
      throw new Error('TERMINAL_ATTACH_INVALID');
    if (input.takeover !== undefined && input.takeover !== false)
      throw new Error('TERMINAL_ATTACH_INVALID');
    if (!readonly && terminal.writerAttachmentId !== undefined) {
      throw new Error('TERMINAL_ATTACH_CONFLICT');
    }
    const attachmentId = randomUUID();
    this.attachments.set(attachmentId, { terminalId: terminal.id, readonly });
    if (!readonly) terminal.writerAttachmentId = attachmentId;
    this.updateOutputPause(terminal);
    terminal.updatedAt = this.now();
    terminal.lastUsedAt = terminal.updatedAt;
    terminal.detachedAt = undefined;
    const latestSequence = terminal.sequence;
    return {
      attachmentId,
      terminalId: terminal.id,
      readonly,
      latestSequence,
      frames: this.replayFrames(terminal, afterSequence)
    };
  }

  synchronizeAttachment(input: {
    readonly attachmentId: string;
    readonly terminalId: string;
    readonly afterSequence: unknown;
  }): TerminalAttachmentSynchronization {
    const attachment = this.attachments.get(input.attachmentId);
    if (attachment === undefined || attachment.terminalId !== input.terminalId) {
      return { active: false, reason: 'INACTIVE', frames: [] };
    }
    const terminal = this.terminals.get(attachment.terminalId);
    if (terminal === undefined || terminal.state !== 'RUNNING') {
      return { active: false, reason: 'INACTIVE', frames: [] };
    }
    return {
      active: true,
      frames: this.replayFrames(terminal, terminalSequence(input.afterSequence))
    };
  }

  detach(attachmentId: string): void {
    const attachment = this.attachments.get(attachmentId);
    if (attachment === undefined) return;
    this.attachments.delete(attachmentId);
    const terminal = this.terminals.get(attachment.terminalId);
    if (terminal?.writerAttachmentId === attachmentId) terminal.writerAttachmentId = undefined;
    if (terminal !== undefined) this.updateOutputPause(terminal);
    if (terminal !== undefined && !this.hasAttachment(terminal.id)) {
      terminal.detachedAt = this.now();
      terminal.lastUsedAt = terminal.detachedAt;
      this.notifySummary(terminal);
    }
  }

  /** Processes data frames from an already-authorized Server relay attachment. */
  async acceptFrame(attachmentId: string, frame: unknown): Promise<void> {
    const parsed = terminalDataFrameSchema.safeParse(frame);
    if (!parsed.success) throw new Error('TERMINAL_FRAME_INVALID');
    const attachment = this.attachments.get(attachmentId);
    if (attachment === undefined || attachment.terminalId !== parsed.data.terminalId)
      throw new Error('TERMINAL_ATTACH_INVALID');
    const terminal = this.requireTerminal(attachment.terminalId);
    if (terminal.state !== 'RUNNING') throw new Error('TERMINAL_CLOSED');
    if (
      parsed.data.type === 'attach' ||
      parsed.data.type === 'output' ||
      parsed.data.type === 'exit' ||
      parsed.data.type === 'error'
    ) {
      throw new Error('TERMINAL_FRAME_INVALID');
    }
    if (attachment.readonly || terminal.writerAttachmentId !== attachmentId)
      throw new Error('TERMINAL_WRITE_DENIED');
    terminal.updatedAt = this.now();
    terminal.lastUsedAt = terminal.updatedAt;
    if (parsed.data.type === 'input') {
      if (terminal.binary) {
        if (terminal.pipe === undefined) throw new Error('TERMINAL_COMMAND_NOT_STARTED');
        const bytes = Buffer.from(parsed.data.data, 'base64');
        if (bytes.length > 32 * 1024 || bytes.toString('base64') !== parsed.data.data)
          throw new Error('TERMINAL_FRAME_INVALID');
        terminal.pipe.write(bytes);
        return;
      }
      if (terminal.pty === undefined) throw new Error('TERMINAL_COMMAND_NOT_STARTED');
      terminal.pty.write(parsed.data.data);
      return;
    }
    if (parsed.data.type === 'resize') {
      if (terminal.binary) throw new Error('TERMINAL_FRAME_INVALID');
      if (terminal.pty === undefined) throw new Error('TERMINAL_COMMAND_NOT_STARTED');
      terminal.pty.resize(parsed.data.cols, parsed.data.rows);
      terminal.cols = parsed.data.cols;
      terminal.rows = parsed.data.rows;
      this.notifySummary(terminal);
      return;
    }
    await this.close(terminal.id);
  }

  close(terminalId: string): Promise<TerminalSummary> {
    const terminal = this.requireTerminal(terminalId);
    const pending = this.closing.get(terminalId);
    if (pending !== undefined) return pending;
    if (terminal.state !== 'RUNNING') return Promise.resolve(this.summary(terminal));
    terminal.state = 'CLOSED';
    terminal.updatedAt = this.now();
    let resolveClosing!: (summary: TerminalSummary) => void;
    let rejectClosing!: (error: unknown) => void;
    const closing = new Promise<TerminalSummary>((resolve, reject) => {
      resolveClosing = resolve;
      rejectClosing = reject;
    });
    this.closing.set(terminalId, closing);
    void (async () => {
      const { summary, failures } = this.detachAndNotify(terminal);
      try {
        if (terminal.pty !== undefined) {
          // Native PTY hangup reaches POSIX foreground jobs in a separate process group
          // and releases the native console on Windows; shell-group TERM cannot do this.
          try {
            terminal.pty.kill();
          } catch {
            await this.terminate(terminal.pty, this.platform);
          }
        }
        if (terminal.pipe !== undefined) await this.terminate(terminal.pipe, this.platform);
      } catch (error) {
        failures.push(error);
      } finally {
        this.releaseTerminalResources(terminal);
        try {
          this.emit({ type: 'exit', terminalId: terminal.id, exitCode: terminal.exitCode });
        } catch (error) {
          failures.push(error);
        }
      }
      this.throwCleanupFailures(failures);
      return summary;
    })().then(
      (summary) => {
        this.closing.delete(terminalId);
        resolveClosing(summary);
      },
      (error: unknown) => {
        this.closing.delete(terminalId);
        rejectClosing(error);
      }
    );
    return closing;
  }

  /** Ends current terminals without disposing the manager's idle collection. */
  async closeAll(): Promise<void> {
    await Promise.all(
      [...this.terminals.values()]
        .filter((terminal) => terminal.state === 'RUNNING' || this.closing.has(terminal.id))
        .map((terminal) => this.close(terminal.id))
    );
  }

  async shutdown(): Promise<void> {
    if (this.idleTimer !== undefined) clearInterval(this.idleTimer);
    this.idleTimer = undefined;
    await this.closeAll();
  }

  onFrame(listener: (frame: TerminalDataFrame) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  /** A relay can pause only its own pipe writer, never an unrelated direct writer or PTY. */
  setOutputBackpressure(terminalId: string, attachmentIds: ReadonlySet<string>): void {
    const terminal = this.terminals.get(terminalId);
    if (terminal === undefined) return;
    if (attachmentIds.size === 0) delete terminal.outputBackpressureAttachments;
    else terminal.outputBackpressureAttachments = new Set(attachmentIds);
    this.updateOutputPause(terminal);
  }

  private updateOutputPause(terminal: ManagedTerminal): void {
    const paused =
      terminal.state === 'RUNNING' &&
      terminal.binary &&
      terminal.writerAttachmentId !== undefined &&
      terminal.outputBackpressureAttachments?.has(terminal.writerAttachmentId) === true;
    if (Boolean(terminal.outputPaused) === paused) return;
    terminal.outputPaused = paused;
    if (paused) terminal.pipe?.pause?.();
    else terminal.pipe?.resume?.();
  }

  onSummary(listener: (summary: TerminalSummary) => void): () => void {
    this.summaryListeners.add(listener);
    return () => this.summaryListeners.delete(listener);
  }

  private async closeExpired(): Promise<void> {
    const expired = [...this.terminals.values()].filter(
      (terminal) =>
        terminal.state === 'RUNNING' &&
        terminal.detachedAt !== undefined &&
        this.now() - terminal.detachedAt >= this.idleTimeoutMs
    );
    await Promise.all(expired.map((terminal) => this.close(terminal.id)));
  }

  private recordOutput(terminal: ManagedTerminal, data: string): void {
    if (terminal.state !== 'RUNNING' || data.length === 0) return;
    for (const part of splitFrameData(data)) {
      const frame: TerminalReplayFrame = {
        sequence: ++terminal.sequence,
        data: part,
        bytes: Buffer.byteLength(part, 'utf8')
      };
      terminal.replay.push(frame);
      terminal.replayBytes += frame.bytes;
      while (terminal.replayBytes > this.maxReplayBytes && terminal.replay.length > 0) {
        const removed = terminal.replay.shift();
        if (removed !== undefined) terminal.replayBytes -= removed.bytes;
      }
      this.emit({
        type: 'output',
        terminalId: terminal.id,
        sequence: frame.sequence,
        data: frame.data
      });
    }
  }

  private recordBinaryOutput(terminal: ManagedTerminal, data: Buffer): void {
    if (terminal.state !== 'RUNNING') return;
    for (let offset = 0; offset < data.length; offset += 32 * 1024) {
      const part = data.subarray(offset, offset + 32 * 1024);
      const frame: TerminalReplayFrame = {
        sequence: ++terminal.sequence,
        data: part.toString('base64'),
        bytes: part.length
      };
      terminal.replay.push(frame);
      terminal.replayBytes += frame.bytes;
      while (terminal.replayBytes > this.maxReplayBytes && terminal.replay.length > 0) {
        const removed = terminal.replay.shift();
        if (removed !== undefined) terminal.replayBytes -= removed.bytes;
      }
      this.emit({
        type: 'output',
        terminalId: terminal.id,
        sequence: frame.sequence,
        data: frame.data
      });
    }
  }

  private exited(terminal: ManagedTerminal, exitCode: number): void {
    if (terminal.state !== 'RUNNING') return;
    terminal.state = 'EXITED';
    terminal.exitCode = exitCode;
    terminal.updatedAt = this.now();
    const { failures } = this.detachAndNotify(terminal);
    try {
      this.releaseTerminalResources(terminal);
      this.emit({ type: 'exit', terminalId: terminal.id, exitCode });
    } catch (error) {
      failures.push(error);
    }
    this.throwCleanupFailures(failures);
  }

  private throwCleanupFailures(failures: unknown[]): void {
    if (failures.length === 0) return;
    const failure =
      failures.length === 1
        ? failures[0]
        : new AggregateError(failures, 'Terminal cleanup did not complete.');
    const pending = [failure];
    const seen = new Set<unknown>();
    while (pending.length > 0) {
      const error = pending.pop();
      if (seen.has(error)) continue;
      seen.add(error);
      try {
        if (!(error instanceof Error)) continue;
        try {
          // Lazy V8 stacks can retain native receivers even after all subscriptions are disposed.
          void error.stack;
        } catch {
          // A custom stack formatter must not replace the original cleanup failure.
        }
        pending.push(error.cause);
        if (error instanceof AggregateError && Array.isArray(error.errors)) {
          for (const nested of error.errors) pending.push(nested);
        }
      } catch {
        // Preserve errors with custom cause/errors accessors without masking the original failure.
      }
    }
    throw failure;
  }

  private detachAndNotify(terminal: ManagedTerminal): {
    summary: TerminalSummary;
    failures: unknown[];
  } {
    const failures: unknown[] = [];
    let summary = this.summary(terminal);
    try {
      this.detachAll(terminal);
    } catch (error) {
      failures.push(error);
    }
    try {
      summary = this.notifySummary(terminal);
    } catch (error) {
      failures.push(error);
    }
    return { summary, failures };
  }

  private listenToPty(terminal: ManagedTerminal, pty: TerminalPty): void {
    const track = (subscription: { dispose(): void }) => {
      if (terminal.state === 'RUNNING') terminal.subscriptions.push(subscription);
      else this.disposeSubscription(terminal, subscription);
    };
    track(pty.onData((data) => this.recordOutput(terminal, data)));
    if (terminal.state !== 'RUNNING') return;
    let subscribing = true;
    let failure: { error: unknown } | undefined;
    const subscription = pty.onExit((event) => {
      try {
        this.exited(terminal, event.exitCode);
      } catch (error) {
        if (!subscribing) throw error;
        failure = { error };
      }
    });
    subscribing = false;
    track(subscription);
    if (failure !== undefined) throw failure.error;
  }

  private disposeSubscription(terminal: ManagedTerminal, subscription: { dispose(): void }): void {
    try {
      subscription.dispose();
    } catch {
      try {
        this.emit({ type: 'error', terminalId: terminal.id, code: 'TERMINAL_CLEANUP_FAILED' });
      } catch {
        // A failing error observer must not prevent the remaining resources from being released.
      }
    }
  }

  private releaseTerminalResources(terminal: ManagedTerminal): void {
    // Historical summaries and replay must not keep native handles or spawn environments alive.
    terminal.pty = undefined;
    terminal.pipe = undefined;
    delete terminal.deferredCommand;
    for (const subscription of terminal.subscriptions.splice(0))
      this.disposeSubscription(terminal, subscription);
  }

  private replayFrames(
    terminal: ManagedTerminal,
    afterSequence: number
  ): readonly TerminalDataFrame[] {
    const first = terminal.replay[0]?.sequence;
    const frames: TerminalDataFrame[] = [];
    if (first !== undefined && afterSequence < first - 1) {
      frames.push({ type: 'error', terminalId: terminal.id, code: 'TERMINAL_REPLAY_GAP' });
    }
    for (const replay of terminal.replay) {
      if (replay.sequence > afterSequence) {
        frames.push({
          type: 'output',
          terminalId: terminal.id,
          sequence: replay.sequence,
          data: replay.data
        });
      }
    }
    return frames;
  }

  private summary(terminal: ManagedTerminal): TerminalSummary {
    return {
      id: terminal.id,
      workspaceId: terminal.workspaceId,
      profileId: terminal.profile.id,
      state: terminal.state,
      createdAt: terminal.createdAt,
      updatedAt: terminal.updatedAt,
      exitCode: terminal.exitCode,
      rows: terminal.rows,
      cols: terminal.cols,
      latestSequence: terminal.sequence
    };
  }

  private notifySummary(terminal: ManagedTerminal): TerminalSummary {
    const summary = this.summary(terminal);
    for (const listener of this.summaryListeners) listener(summary);
    return summary;
  }

  private requireTerminal(terminalId: string): ManagedTerminal {
    const terminal = this.terminals.get(terminalId);
    if (terminal === undefined) throw new Error('TERMINAL_NOT_FOUND');
    return terminal;
  }

  private runningCount(): number {
    return [...this.terminals.values()].filter((terminal) => terminal.state === 'RUNNING').length;
  }

  private evictForNewTerminal(workspaceId: string | null): void {
    if (
      workspaceId !== null &&
      this.runningCountForWorkspace(workspaceId) >= this.maxTerminalsPerWorkspace
    ) {
      this.evictLeastRecentlyUsed((terminal) => terminal.workspaceId === workspaceId);
    }
    if (this.runningCount() >= this.maxTerminals) this.evictLeastRecentlyUsed(() => true);
  }

  private evictLeastRecentlyUsed(predicate: (terminal: ManagedTerminal) => boolean): void {
    const candidate = [...this.terminals.values()]
      .filter(
        (terminal) =>
          terminal.state === 'RUNNING' && predicate(terminal) && !this.hasAttachment(terminal.id)
      )
      .sort(
        (left, right) => left.lastUsedAt - right.lastUsedAt || left.createdAt - right.createdAt
      )[0];
    if (candidate === undefined) throw new Error('TERMINAL_LIMIT_REACHED');
    void this.close(candidate.id);
  }

  private runningCountForWorkspace(workspaceId: string): number {
    return [...this.terminals.values()].filter(
      (terminal) => terminal.state === 'RUNNING' && terminal.workspaceId === workspaceId
    ).length;
  }

  private hasAttachment(terminalId: string): boolean {
    return [...this.attachments.values()].some(
      (attachment) => attachment.terminalId === terminalId
    );
  }

  private detachAll(terminal: ManagedTerminal): void {
    for (const [attachmentId, attachment] of this.attachments) {
      if (attachment.terminalId === terminal.id) this.attachments.delete(attachmentId);
    }
    terminal.writerAttachmentId = undefined;
    delete terminal.outputBackpressureAttachments;
    this.updateOutputPause(terminal);
    terminal.detachedAt = undefined;
  }

  private emit(frame: TerminalDataFrame): void {
    for (const listener of this.frameListeners) listener(frame);
  }
}

export function nodePtyFactory(
  shell: string,
  args: readonly string[],
  options: TerminalSpawnOptions
): TerminalPty {
  repairPtySpawnHelper();
  const pty: IPty = spawn(shell, [...args], {
    name: options.name,
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env: options.env
  });
  return pty as unknown as TerminalPty;
}

export function repairPtySpawnHelper(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
  packageRoot?: string
): void {
  if (platform !== 'darwin') return;
  const root =
    packageRoot ?? dirname(createRequire(import.meta.url).resolve('node-pty/package.json'));
  const helper = join(root, `prebuilds/darwin-${architecture}/spawn-helper`);
  // node-pty 1.1.0 publishes these prebuild helpers without their execute bit.
  if (existsSync(helper) && (statSync(helper).mode & 0o111) !== 0o111) chmodSync(helper, 0o755);
}

function nodePipeFactory(
  shell: string,
  args: readonly string[],
  options: TerminalSpawnOptions
): TerminalPipe {
  const child = spawnProcess(shell, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true
  });
  child.stdin.on('error', () => undefined);
  child.stderr.resume();
  return {
    pid: child.pid,
    kill: (signal) => child.kill(signal),
    pause: () => child.stdout.pause(),
    resume: () => child.stdout.resume(),
    write: (bytes) => {
      if (child.stdin.destroyed) throw new Error('TERMINAL_PIPE_CLOSED');
      child.stdin.write(bytes);
    },
    onData: (listener) => {
      child.stdout.on('data', listener);
    },
    onExit: (listener) => {
      child.on('error', () => listener(127));
      child.on('close', (exitCode) => listener(exitCode ?? 1));
    }
  };
}

export function defaultTerminalProfiles(
  platform: TerminalPlatform,
  findWindowsExecutable = resolveWindowsExecutable
): readonly TerminalProfile[] {
  if (platform === 'win32') {
    const pwsh = findWindowsExecutable('pwsh.exe');
    const powershell = pwsh === undefined ? findWindowsExecutable('powershell.exe') : undefined;
    const commandPrompt =
      pwsh === undefined && powershell === undefined
        ? (findWindowsExecutable('cmd.exe') ??
          process.env['ComSpec'] ??
          'C:\\Windows\\System32\\cmd.exe')
        : undefined;
    return [
      {
        id: 'default',
        label:
          pwsh === undefined
            ? powershell === undefined
              ? 'Windows Command Prompt'
              : 'Windows PowerShell'
            : 'PowerShell 7',
        shell: pwsh ?? powershell ?? commandPrompt!,
        args: [],
        isDefault: true
      }
    ];
  }
  return [
    {
      id: 'default',
      label: 'User Shell',
      shell: process.env['SHELL']?.trim() || '/bin/bash',
      args: ['-l', '-i'],
      isDefault: true
    }
  ];
}

function resolveWindowsExecutable(
  command: 'pwsh.exe' | 'powershell.exe' | 'cmd.exe'
): string | undefined {
  const pathValue = process.env['Path']?.trim() || process.env['PATH'];
  for (const directory of pathValue?.split(';') ?? []) {
    const candidate = join(directory.trim(), command);
    if (directory.trim() !== '' && existsSync(candidate)) return candidate;
  }
  if (command === 'pwsh.exe') {
    const programFiles = process.env['ProgramFiles'];
    const candidate =
      programFiles === undefined ? undefined : join(programFiles, 'PowerShell', '7', command);
    return candidate !== undefined && existsSync(candidate) ? candidate : undefined;
  }
  if (command === 'powershell.exe') {
    const systemRoot = process.env['SystemRoot'] ?? process.env['windir'];
    const candidate =
      systemRoot === undefined
        ? undefined
        : join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', command);
    return candidate !== undefined && existsSync(candidate) ? candidate : undefined;
  }
  return process.env['ComSpec'] ?? process.env['COMSPEC'];
}

function terminalDimension(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 1000)
    throw new Error('TERMINAL_DIMENSIONS_INVALID');
  return value;
}

function terminalSequence(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('TERMINAL_REPLAY_INVALID');
  return value;
}

function splitFrameData(value: string): readonly string[] {
  if (value.length <= MAX_FRAME_CHARACTERS) return [value];
  const chunks: string[] = [];
  for (let start = 0; start < value.length;) {
    let end = Math.min(value.length, start + MAX_FRAME_CHARACTERS);
    if (
      end < value.length &&
      value.charCodeAt(end - 1) >= 0xd800 &&
      value.charCodeAt(end - 1) <= 0xdbff &&
      value.charCodeAt(end) >= 0xdc00 &&
      value.charCodeAt(end) <= 0xdfff
    )
      end -= 1;
    chunks.push(value.slice(start, end));
    start = end;
  }
  return chunks;
}

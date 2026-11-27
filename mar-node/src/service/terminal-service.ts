import { isAbsolute } from 'node:path';
import { terminalCopySchema } from '@myagentroam/protocol';
import type { NodeDatabase } from '../database.js';
import type { NodeOperationHandler } from '../application/node-operation-contracts.js';
import type { TerminalManager } from '../terminal.js';
import { parseSecretEnvironment } from '../mcp/secret-environment.js';

const TERMINAL_OPEN_FIELDS = new Set([
  'rows',
  'cols',
  'profileId',
  'workspaceId',
  'secretEnvironment',
  '__requestUserId',
  '__workspaceWatchSessionHash',
  '__marctlCaller',
  '__usageGrant',
  '__requestAbortSignal'
]);

/** Owns Terminal operation validation and user-scoped environment leases; the manager owns processes. */
export class TerminalService {
  private readonly terminalOwners = new Map<
    string,
    {
      readonly userId: number;
      readonly release: () => void;
      readonly kind: 'GIT' | 'COMMAND' | 'COMPUTER';
      readonly sessionHash?: string;
    }
  >();
  constructor(
    private readonly database: () => NodeDatabase,
    private readonly terminalManager: TerminalManager,
    private readonly retainEnvironment?: (
      environment: Readonly<Record<string, string>>
    ) => () => void
  ) {
    terminalManager.onSummary((summary) => {
      if (summary.state !== 'RUNNING') {
        this.terminalOwners.get(summary.id)?.release();
        this.terminalOwners.delete(summary.id);
      }
    });
  }

  openComputer(data: unknown, open: Parameters<TerminalManager['openComputer']>[0]): unknown {
    const actor = data as Record<string, unknown> | undefined;
    if (
      !Number.isSafeInteger(actor?.__requestUserId) ||
      Number(actor?.__requestUserId) <= 0 ||
      typeof actor?.__workspaceWatchSessionHash !== 'string' ||
      actor.__workspaceWatchSessionHash.length === 0
    )
      throw new Error('USER_AUTHORIZATION_REQUIRED');
    const terminal = this.terminalManager.openComputer(open);
    this.terminalOwners.set(terminal.id, {
      userId: Number(actor.__requestUserId),
      sessionHash: actor.__workspaceWatchSessionHash,
      release: () => undefined,
      kind: 'COMPUTER'
    });
    return { terminal };
  }

  operations(): Readonly<Record<string, NodeOperationHandler>> {
    return {
      'terminal.open': (data) => this.open(data),
      'terminal.command.open': (data) => this.open(data, true),
      'terminal.copy.open': (data) => this.openCopy(data),
      'terminal.list': (data) => ({
        terminals: this.database()
          .listTerminalSessions()
          .filter(
            (terminal) =>
              !this.terminalOwners.has(terminal.id) ||
              this.terminalOwners.get(terminal.id)?.userId ===
                (data as Record<string, unknown> | null | undefined)?.__requestUserId
          )
      }),
      'terminal.close': (data) => this.close(data),
      'terminal.attach.authorize': (data) => this.authorizeAttach(data),
      'computer.use.attach': (data) => this.authorizeAttach(data, true),
      'terminal.direct.preflight': (data) => this.preflightDirect(data)
    };
  }

  private openCopy(data: unknown): unknown {
    if (data === null || typeof data !== 'object') throw new Error('SCP_OPEN_INVALID');
    const { __requestUserId: userId, copy } = data as Record<string, unknown>;
    if (typeof userId !== 'number' || !Number.isSafeInteger(userId) || userId <= 0)
      throw new Error('USER_AUTHORIZATION_REQUIRED');
    const parsed = terminalCopySchema.safeParse(copy);
    if (!parsed.success || !isAbsolute(parsed.data.path)) throw new Error('SCP_OPEN_INVALID');
    const terminal = this.terminalManager.openCopy(parsed.data);
    this.terminalOwners.set(terminal.id, { userId, release: () => undefined, kind: 'COMMAND' });
    return { terminal };
  }

  private open(data: unknown, commandMode = false): unknown {
    if (data === null || typeof data !== 'object' || Array.isArray(data))
      throw new Error('TERMINAL_OPEN_INVALID');
    const input = data as Record<string, unknown>;
    if (
      Object.keys(input).some(
        (key) => !TERMINAL_OPEN_FIELDS.has(key) && !(commandMode && key === 'command')
      )
    )
      throw new Error('TERMINAL_OPEN_INVALID');
    if (
      commandMode &&
      (input.workspaceId !== undefined ||
        typeof input.command !== 'string' ||
        input.command.trim().length === 0)
    )
      throw new Error('TERMINAL_COMMAND_INVALID');
    const secretEnvironment = parseSecretEnvironment(input.secretEnvironment);
    if (
      (commandMode || secretEnvironment.MAR_GIT_TOKEN !== undefined) &&
      (!Number.isSafeInteger(input.__requestUserId) || Number(input.__requestUserId) <= 0)
    )
      throw new Error('USER_AUTHORIZATION_REQUIRED');
    let cwd: string | undefined;
    if (input.workspaceId !== undefined) {
      if (typeof input.workspaceId !== 'string') throw new Error('TERMINAL_OPEN_INVALID');
      const workspace = this.database().getWorkspace(input.workspaceId);
      if (workspace === undefined) throw new Error('WORKSPACE_NOT_FOUND');
      cwd = workspace.path;
    }
    const release = this.retainEnvironment?.(secretEnvironment);
    try {
      const options = {
        rows: input.rows,
        cols: input.cols,
        profileId: input.profileId,
        workspaceId: typeof input.workspaceId === 'string' ? input.workspaceId : null,
        environment: { ...secretEnvironment, MAR_CTL_CONTEXT_REQUIRED: '1' },
        ...(cwd === undefined ? {} : { cwd })
      };
      const terminal = commandMode
        ? this.terminalManager.openCommand(options, input.command)
        : this.terminalManager.open(options);
      if (commandMode || secretEnvironment.MAR_GIT_TOKEN !== undefined)
        this.terminalOwners.set(terminal.id, {
          userId: Number(input.__requestUserId),
          release: release ?? (() => undefined),
          kind: commandMode ? 'COMMAND' : 'GIT'
        });
      else release?.();
      return { terminal };
    } catch (error) {
      release?.();
      throw error;
    }
  }

  private async close(data: unknown): Promise<unknown> {
    const input = data as Record<string, unknown>;
    if (typeof input.terminalId !== 'string') throw new Error('TERMINAL_NOT_FOUND');
    this.assertOwner(input);
    return { terminal: await this.terminalManager.close(input.terminalId) };
  }

  private authorizeAttach(data: unknown, computer = false): unknown {
    if (data === null || typeof data !== 'object') throw new Error('TERMINAL_ATTACH_INVALID');
    const input = data as Record<string, unknown>;
    this.assertOwner(input);
    if ((this.terminalOwners.get(String(input.terminalId))?.kind === 'COMPUTER') !== computer)
      throw new Error('TERMINAL_ATTACH_INVALID');
    if (computer && (input.readonly === true || (input.afterSequence ?? 0) !== 0))
      throw new Error('TERMINAL_ATTACH_INVALID');
    const attachment = this.terminalManager.authorizeAttach(input);
    const { frames: _, ...identity } = attachment;
    return { attachment: identity, terminal: this.terminalManager.get(attachment.terminalId) };
  }

  private preflightDirect(data: unknown): unknown {
    if (data === null || typeof data !== 'object') throw new Error('TERMINAL_ATTACH_INVALID');
    const input = data as Record<string, unknown>;
    this.assertOwner(input);
    if (this.terminalOwners.get(String(input.terminalId))?.kind === 'COMPUTER')
      throw new Error('TERMINAL_ATTACH_INVALID');
    const terminal = this.terminalManager.get(String(input.terminalId));
    if (terminal.state !== 'RUNNING') throw new Error('TERMINAL_CLOSED');
    if (terminal.workspaceId !== (input.workspaceId ?? null))
      throw new Error('TERMINAL_WORKSPACE_MISMATCH');
    return { terminalId: terminal.id, workspaceId: terminal.workspaceId };
  }

  private assertOwner(input: Record<string, unknown>): void {
    const owner = this.terminalOwners.get(String(input.terminalId));
    if (
      owner !== undefined &&
      (owner.userId !== input.__requestUserId ||
        (owner.kind === 'COMPUTER' && owner.sessionHash !== input.__workspaceWatchSessionHash))
    )
      throw new Error(
        owner.kind === 'GIT' ? 'TERMINAL_GIT_OWNER_REQUIRED' : 'TERMINAL_OWNER_REQUIRED'
      );
  }
}

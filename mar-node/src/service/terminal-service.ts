import type { NodeDatabase } from '../database.js';
import type { NodeOperationHandler } from '../connector/node-operation-router.js';
import type { TerminalManager } from '../terminal.js';
import { parseSecretEnvironment } from '../util/secret-environment.js';

export class TerminalService {
  private readonly terminalOwners = new Map<
    string,
    { readonly userId: number; readonly release: () => void; readonly kind: 'GIT' | 'COMMAND' }
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

  operations(): Readonly<Record<string, NodeOperationHandler>> {
    return {
      'terminal.open': (data) => this.open(data),
      'terminal.command.open': (data) => this.open(data, true),
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
      'terminal.direct.preflight': (data) => this.preflightDirect(data)
    };
  }

  private open(data: unknown, commandMode = false): unknown {
    if (data === null || typeof data !== 'object') throw new Error('TERMINAL_OPEN_INVALID');
    const input = data as Record<string, unknown>;
    if (
      commandMode &&
      (input.workspaceId !== undefined ||
        typeof input.command !== 'string' ||
        input.command.trim().length === 0 ||
        (input.binary !== undefined && typeof input.binary !== 'boolean'))
    )
      throw new Error('TERMINAL_COMMAND_INVALID');
    if (!commandMode && input.binary !== undefined) throw new Error('TERMINAL_OPEN_INVALID');
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
        ...input,
        workspaceId: typeof input.workspaceId === 'string' ? input.workspaceId : null,
        environment: { ...secretEnvironment, MAR_CTL_CONTEXT_REQUIRED: '1' },
        ...(cwd === undefined ? {} : { cwd })
      };
      const terminal = commandMode
        ? this.terminalManager.openCommand(options, input.command, input.binary === true)
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

  private authorizeAttach(data: unknown): unknown {
    if (data === null || typeof data !== 'object') throw new Error('TERMINAL_ATTACH_INVALID');
    this.assertOwner(data as Record<string, unknown>);
    const attachment = this.terminalManager.authorizeAttach(data as Record<string, unknown>);
    return { attachment, terminal: this.terminalManager.get(attachment.terminalId) };
  }

  private preflightDirect(data: unknown): unknown {
    if (data === null || typeof data !== 'object') throw new Error('TERMINAL_ATTACH_INVALID');
    const input = data as Record<string, unknown>;
    this.assertOwner(input);
    const terminal = this.terminalManager.get(String(input.terminalId));
    if (terminal.state !== 'RUNNING') throw new Error('TERMINAL_CLOSED');
    if (terminal.workspaceId !== (input.workspaceId ?? null))
      throw new Error('TERMINAL_WORKSPACE_MISMATCH');
    return { terminalId: terminal.id, workspaceId: terminal.workspaceId };
  }

  private assertOwner(input: Record<string, unknown>): void {
    const owner = this.terminalOwners.get(String(input.terminalId));
    if (owner !== undefined && owner.userId !== input.__requestUserId)
      throw new Error(
        owner.kind === 'COMMAND' ? 'TERMINAL_OWNER_REQUIRED' : 'TERMINAL_GIT_OWNER_REQUIRED'
      );
  }
}

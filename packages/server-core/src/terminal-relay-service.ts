import { randomUUID } from 'node:crypto';
import {
  matchesNodeOperation,
  type NodeRequestAuthorization,
  type NodeOperationScope,
  type UserNodeAuthorization
} from './node-access-contracts.js';
import { safeErrorCode } from './http-errors.js';
import { definiteNodeRejection } from './node-request-error.js';

const TERMINAL_TICKET_TTL_MS = 30_000;
const MAX_TERMINAL_RELAYS_PER_USER = 10;
const TERMINAL_STREAM_REJECTION_CODES = new Set([
  'NODE_ACCESS_DENIED',
  'RESOURCE_ACCESS_DENIED',
  'SESSION_UNAUTHENTICATED',
  'TERMINAL_ATTACH_CONFLICT',
  'TERMINAL_CLOSED',
  'TERMINAL_GIT_OWNER_REQUIRED',
  'TERMINAL_NOT_AUTHORIZED',
  'TERMINAL_NOT_FOUND',
  'TERMINAL_OWNER_REQUIRED',
  'TERMINAL_WORKSPACE_MISMATCH',
  'USER_AUTHORIZATION_REQUIRED',
  'WORKSPACE_ACCESS_DENIED'
]);

interface TerminalTicketRecord {
  readonly ticket: string;
  readonly nodeId: string;
  readonly terminalId: string;
  readonly userSessionHash: string;
  readonly userId: number;
  readonly workspaceId?: string;
  readonly afterSequence: number;
  readonly readonly: boolean;
  readonly computer: boolean;
  readonly cli: boolean;
  readonly expiresAt: number;
  readonly timer: NodeJS.Timeout;
}

export interface TerminalRelayOptions {
  readonly authorizeNodeRequest: NodeRequestAuthorization;
  readonly requestNode: (
    nodeId: string,
    operation: string,
    data: unknown,
    user: UserNodeAuthorization,
    timeoutMs?: number,
    signal?: AbortSignal
  ) => Promise<unknown>;
}

/** Owns Relay attachment tickets and authorization lifetime; the shared relay carries the bytes and Node owns the terminals. */
export class TerminalRelayService {
  private directCount?: (sessionHash: string) => number;
  private closed = false;
  private readonly tickets = new Map<string, TerminalTicketRecord>();
  private readonly streams = new Map<TerminalTicketRecord, AbortController>();

  constructor(private readonly options: TerminalRelayOptions) {}

  createTicket(input: {
    readonly nodeId: string;
    readonly terminalId: string;
    readonly user: UserNodeAuthorization;
    readonly workspaceId?: string;
    readonly afterSequence?: unknown;
    readonly readonly?: unknown;
    readonly computer?: boolean;
    readonly cli?: boolean;
  }): {
    readonly ticket: string;
    readonly nodeId: string;
    readonly terminalId: string;
    readonly expiresAt: number;
  } {
    if (
      !isIdentifier(input.nodeId) ||
      !isIdentifier(input.terminalId) ||
      !Number.isSafeInteger(input.user.userId) ||
      input.user.userId <= 0 ||
      input.user.sessionHash.length === 0
    )
      throw new Error('TERMINAL_TICKET_INVALID');
    const afterSequence = input.afterSequence ?? 0;
    if (!Number.isSafeInteger(afterSequence) || (afterSequence as number) < 0)
      throw new Error('TERMINAL_TICKET_INVALID');
    if (input.readonly !== undefined && typeof input.readonly !== 'boolean')
      throw new Error('TERMINAL_TICKET_INVALID');
    const ticket = randomUUID();
    const expiresAt = Date.now() + TERMINAL_TICKET_TTL_MS;
    const record: TerminalTicketRecord = {
      ticket,
      nodeId: input.nodeId,
      terminalId: input.terminalId,
      userSessionHash: input.user.sessionHash,
      userId: input.user.userId,
      ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
      afterSequence: afterSequence as number,
      readonly: input.readonly === true,
      computer: input.computer === true,
      cli: input.cli === true,
      expiresAt,
      timer: setTimeout(() => this.tickets.delete(ticket), TERMINAL_TICKET_TTL_MS)
    };
    record.timer.unref();
    this.tickets.set(ticket, record);
    return { ticket, nodeId: record.nodeId, terminalId: record.terminalId, expiresAt };
  }

  async authorizeStream(
    ticketValue: string,
    nodeId: string,
    user: UserNodeAuthorization,
    cli: boolean,
    signal: AbortSignal
  ): Promise<{ grant: string; revoked: AbortSignal } | { code: string } | undefined> {
    const ticket = this.tickets.get(ticketValue);
    if (
      this.closed ||
      signal.aborted ||
      ticket === undefined ||
      ticket.expiresAt <= Date.now() ||
      ticket.nodeId !== nodeId ||
      ticket.cli !== cli ||
      ticket.userId !== user.userId ||
      ticket.userSessionHash !== user.sessionHash
    )
      return undefined;
    if (
      this.countSession(user.sessionHash) + (this.directCount?.(user.sessionHash) ?? 0) >=
      MAX_TERMINAL_RELAYS_PER_USER
    )
      return { code: 'NODE_STREAM_LIMIT' };
    this.tickets.delete(ticketValue);
    clearTimeout(ticket.timer);
    const scope = new AbortController();
    this.streams.set(ticket, scope);
    const finish = () => {
      this.streams.delete(ticket);
      signal.removeEventListener('abort', finish);
      scope.abort();
    };
    signal.addEventListener('abort', finish, { once: true });
    try {
      const response = await this.options.requestNode(
        ticket.nodeId,
        ticket.computer ? 'computer.use.attach' : 'terminal.attach.authorize',
        {
          terminalId: ticket.terminalId,
          afterSequence: ticket.afterSequence,
          readonly: ticket.readonly,
          ...(ticket.workspaceId === undefined ? {} : { workspaceId: ticket.workspaceId }),
          ...(cli ? { closeOnDisconnect: true } : {})
        },
        {
          ...user,
          ...(ticket.workspaceId === undefined ? {} : { workspaceId: ticket.workspaceId })
        },
        undefined,
        scope.signal
      );
      if (
        !scope.signal.aborted &&
        response &&
        typeof response === 'object' &&
        'grant' in response &&
        typeof response.grant === 'string' &&
        isIdentifier(response.grant)
      ) {
        return { grant: response.grant, revoked: scope.signal };
      }
    } catch (error) {
      finish();
      const code = definiteNodeRejection(error) ?? safeErrorCode(error);
      if (TERMINAL_STREAM_REJECTION_CODES.has(code)) return { code };
      return { code: 'NODE_STREAM_UNAVAILABLE' };
    }
    finish();
    return { code: 'NODE_STREAM_UNAVAILABLE' };
  }

  closeSession(sessionHash: string): void {
    this.revoke((record) => record.userSessionHash === sessionHash);
  }

  closeUser(userId: number): void {
    this.revoke((record) => record.userId === userId);
  }

  closeTerminal(nodeId: string, terminalId: string): void {
    this.revoke((record) => record.nodeId === nodeId && record.terminalId === terminalId);
  }

  setDirectCoordination(input: { readonly directCount: (sessionHash: string) => number }): void {
    this.directCount = input.directCount;
  }

  countSession(sessionHash: string): number {
    return [...this.streams.keys()].filter((ticket) => ticket.userSessionHash === sessionHash)
      .length;
  }

  closeAllRelays(): void {
    this.revoke(() => true);
  }

  async revalidateAuthorizations(scope: NodeOperationScope): Promise<void> {
    const authorizationChecks = new Map<string, Promise<boolean>>();
    const allowed = (
      record: { readonly userId: number; readonly nodeId: string; readonly workspaceId?: string },
      computer: boolean
    ): Promise<boolean> => {
      const key = `${record.userId}\0${record.nodeId}\0${record.workspaceId ?? ''}\0${computer}`;
      const existing = authorizationChecks.get(key);
      if (existing !== undefined) return existing;
      const check = Promise.resolve()
        .then(() =>
          this.options.authorizeNodeRequest(
            record.userId,
            record.nodeId,
            computer ? 'computer.use.attach' : 'terminal.attach.authorize',
            {},
            record.workspaceId
          )
        )
        .catch(() => false);
      authorizationChecks.set(key, check);
      return check;
    };
    // Pending tickets already check current authorization when OPEN consumes them.
    for (const [record, operation] of this.streams)
      if (matchesNodeOperation(scope, record) && !(await allowed(record, record.computer)))
        operation.abort();
  }

  disconnectNode(nodeId: string): void {
    this.revoke((record) => record.nodeId === nodeId);
  }

  close(): void {
    this.closed = true;
    this.closeAllRelays();
  }

  private revoke(matches: (record: TerminalTicketRecord) => boolean): void {
    this.dropTickets(matches);
    for (const [record, scope] of this.streams) if (matches(record)) scope.abort();
  }

  private dropTickets(matches: (record: TerminalTicketRecord) => boolean): void {
    for (const [ticket, record] of this.tickets) {
      if (!matches(record)) continue;
      this.tickets.delete(ticket);
      clearTimeout(record.timer);
    }
  }
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

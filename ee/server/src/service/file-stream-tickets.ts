import { randomUUID } from 'node:crypto';
import type { UserNodeAuthorization } from '@myagentroam/server-core/node-access-contracts';
import type { NodeStreamAdmission } from '@myagentroam/server-core/node-relay-channel';
import { definiteNodeRejection } from '@myagentroam/server-core/node-request-error';

type TicketIdentity = { readonly nodeId: string; readonly user: UserNodeAuthorization };

/** Owns single-use Relay tickets and active revocation, not resource authorization or bytes. */
export class FileStreamTickets<Ticket extends TicketIdentity> {
  private readonly pending = new Map<string, { ticket: Ticket; timer: NodeJS.Timeout }>();
  private readonly active = new Map<Ticket, { scope: AbortController; prepared: boolean }>();
  private closed = false;

  constructor(
    private readonly options: {
      kind(ticket: Ticket): string;
      allowed(ticket: Ticket): boolean | Promise<boolean>;
      prepare(ticket: Ticket, signal: AbortSignal): Promise<unknown>;
      finishAfterResourceRevocation?(ticket: Ticket): boolean;
      onEnd?(ticket: Ticket): NodeStreamAdmission['onEnd'];
    }
  ) {}

  async issue(ticket: Ticket): Promise<string> {
    if (!(await this.options.allowed(ticket))) throw new Error('RESOURCE_DENIED');
    if (this.closed) throw new Error('NODE_STREAM_UNAVAILABLE');
    if (this.pending.size >= 1024) throw new Error('NODE_STREAM_LIMIT');
    const id = randomUUID();
    const timer = setTimeout(() => this.pending.delete(id), 15_000);
    timer.unref();
    this.pending.set(id, { ticket, timer });
    return id;
  }

  async authorize(
    kind: string,
    id: string,
    nodeId: string,
    user: UserNodeAuthorization,
    signal: AbortSignal,
    prepare?: (ticket: Ticket, signal: AbortSignal) => Promise<unknown>
  ): Promise<(NodeStreamAdmission & { revoked: AbortSignal }) | { code: string } | undefined> {
    const entry = this.pending.get(id);
    if (entry === undefined || signal.aborted) return undefined;
    const { ticket, timer } = entry;
    if (
      ticket.nodeId !== nodeId ||
      ticket.user.userId !== user.userId ||
      ticket.user.sessionHash !== user.sessionHash ||
      kind !== this.options.kind(ticket)
    )
      return undefined;
    this.pending.delete(id);
    clearTimeout(timer);
    const scope = new AbortController();
    const entryState = { scope, prepared: false };
    this.active.set(ticket, entryState);
    const finish = () => {
      this.active.delete(ticket);
      signal.removeEventListener('abort', finish);
      scope.abort();
    };
    signal.addEventListener('abort', finish, { once: true });
    try {
      const result = await (prepare ?? this.options.prepare)(ticket, scope.signal);
      if (
        !scope.signal.aborted &&
        result !== null &&
        typeof result === 'object' &&
        'grant' in result &&
        typeof result.grant === 'string' &&
        /^[a-f0-9-]{36}$/u.test(result.grant)
      ) {
        entryState.prepared = true;
        const onEnd = this.options.onEnd?.(ticket);
        return { grant: result.grant, revoked: scope.signal, ...(onEnd && { onEnd }) };
      }
    } catch (error) {
      finish();
      const code = definiteNodeRejection(error);
      return {
        code:
          code !== undefined && /^[A-Z][A-Z0-9_]{0,95}$/u.test(code)
            ? code
            : 'NODE_STREAM_UNAVAILABLE'
      };
    }
    finish();
    return { code: 'NODE_STREAM_UNAVAILABLE' };
  }

  async revalidate(matches: (ticket: Ticket) => boolean): Promise<void> {
    await Promise.all(
      [...this.active].map(async ([ticket, { scope, prepared }]) => {
        // An OPEN still awaiting Node authorization must not escape a concurrent revocation.
        if (!matches(ticket) || (prepared && this.options.finishAfterResourceRevocation?.(ticket)))
          return;
        if (
          !(await Promise.resolve()
            .then(() => this.options.allowed(ticket))
            .catch(() => false))
        )
          scope.abort();
      })
    );
  }

  close(): void {
    this.closed = true;
    for (const { timer } of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    for (const { scope } of this.active.values()) scope.abort();
    this.active.clear();
  }
}

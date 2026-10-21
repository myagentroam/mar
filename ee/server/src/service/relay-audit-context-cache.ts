import type {
  RelayResourceFacts,
  RelayResourceRemoval,
  RelaySessionFact
} from './node-resource-scope-index.js';

const MAX_AUDIT_CONTEXT_ENTRIES = 8192;
type AuditEntry = {
  readonly nodeId: string;
  readonly workspaceId: string | undefined;
  readonly sessionId: string;
} & ({ readonly kind: 'session'; readonly name: string } | { readonly kind: 'run' });

/** Display-only LRU. It must never be consulted to authorize a resource. */
export class RelayAuditContextCache {
  private readonly entries = new Map<string, AuditEntry>();

  context(
    nodeId: string,
    sessionId?: string,
    runId?: string
  ): { sessionId: string | undefined; name: string | undefined } {
    const related =
      sessionId ??
      (runId === undefined ? undefined : this.get(key(nodeId, 'run', runId))?.sessionId);
    const entry = related === undefined ? undefined : this.get(key(nodeId, 'session', related));
    return { sessionId: related, name: entry?.kind === 'session' ? entry.name : undefined };
  }

  observe(nodeId: string, facts: RelayResourceFacts): void {
    for (const session of facts.sessions) {
      const id = key(nodeId, 'session', session.id);
      const name = sessionName(session);
      if (name !== undefined)
        this.set(id, {
          kind: 'session',
          nodeId,
          sessionId: session.id,
          workspaceId: session.workspaceId,
          name: name.slice(0, 512)
        });
      else if (session.complete) this.entries.delete(id);
    }
    for (const run of facts.runs)
      this.set(key(nodeId, 'run', run.id), {
        kind: 'run',
        nodeId,
        workspaceId: run.workspaceId,
        sessionId: run.sessionId
      });
  }

  remove(nodeId: string, removal: RelayResourceRemoval): void {
    for (const [id, entry] of this.entries) {
      if (entry.nodeId !== nodeId) continue;
      if (
        (removal.kind === 'session' && entry.sessionId === removal.id) ||
        (removal.kind === 'workspace' && entry.workspaceId === removal.id)
      )
        this.entries.delete(id);
    }
  }

  removeNode(nodeId: string): void {
    for (const [id, entry] of this.entries) if (entry.nodeId === nodeId) this.entries.delete(id);
  }

  clear(): void {
    this.entries.clear();
  }

  private get(id: string): AuditEntry | undefined {
    const entry = this.entries.get(id);
    if (entry !== undefined) {
      this.entries.delete(id);
      this.entries.set(id, entry);
    }
    return entry;
  }

  private set(id: string, entry: AuditEntry): void {
    const workspaceId = entry.workspaceId ?? this.entries.get(id)?.workspaceId;
    this.entries.delete(id);
    this.entries.set(id, { ...entry, workspaceId });
    while (this.entries.size > MAX_AUDIT_CONTEXT_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }
}

function key(nodeId: string, kind: 'session' | 'run', id: string): string {
  return JSON.stringify([nodeId, kind, id]);
}

function sessionName(session: RelaySessionFact): string | undefined {
  for (const value of [
    session.title,
    session.customTitle,
    session.runnerTitle,
    session.conversationTitle
  ])
    if (typeof value === 'string' && value.trim().length > 0) return value;
  return undefined;
}

import { createHash, randomUUID } from 'node:crypto';

export interface CompletionCacheScope {
  readonly workspaceId: string;
  readonly generation: string;
  /** A Server-authorized resource view, never a client-selected author filter. */
  readonly authorizationView: string;
}

export interface CompletionHistoryMessage {
  readonly id: string;
  readonly revision: number;
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

export interface CompletionReference {
  readonly sessionId: string;
  readonly id: string;
  readonly revision: number;
  readonly text: string;
}

export interface CompletionHistoryLease {
  readonly expiresAt: number;
  /** Checks both resource authorization and the existing page observation lease. */
  readonly valid: () => boolean;
}

interface ReferenceSnapshot {
  readonly epoch: string;
  readonly hash: string;
  readonly messages: readonly CompletionReference[];
  verifiedAt: number;
}

interface SessionWindow {
  readonly generation: string;
  readonly refreshedAt: number;
  readonly messages: readonly CompletionHistoryMessage[];
}

interface ScopeCache {
  readonly scope: CompletionCacheScope;
  readonly snapshots: ReferenceSnapshot[];
  readonly pins: Map<string, { epoch: string; pinnedAt: number }>;
  readonly sessions: Map<string, SessionWindow>;
  lastUsed: number;
  lease?: CompletionHistoryLease;
  load?: (signal: AbortSignal) => Promise<readonly CompletionReference[]>;
  build?: { readonly controller: AbortController; readonly promise: Promise<void> };
}

const EMPTY_REFERENCES = Object.freeze({ epoch: 'empty', messages: [] as readonly string[] });
const MAX_SCOPES = 32;
const MAX_SESSIONS = 16;
const MAX_WORKSPACE_BYTES = 2 * 1024 * 1024;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_REFERENCE_SESSIONS = 4;
export const PROMPT_COMPLETION_REFERENCE_POOL_SESSIONS = MAX_REFERENCE_SESSIONS + 1;
const MAX_REFERENCE_MESSAGES = 20;
const MAX_REFERENCE_BYTES = 8_192;
const MAX_REFERENCE_TEXT_BYTES = 1_024;

/** Node-only material cache. Drafts, generated suggestions and credentials never enter it. */
export class PromptCompletionCache {
  private readonly scopes = new Map<string, ScopeCache>();
  private readonly now: () => number;
  private readonly refreshMs: number;
  private readonly hardTtlMs: number;
  private disposed = false;
  private reads = 0;

  constructor(
    options: {
      readonly now?: () => number;
      readonly refreshMs?: number;
      readonly hardTtlMs?: number;
    } = {}
  ) {
    this.now = options.now ?? Date.now;
    this.refreshMs = options.refreshMs ?? 5 * 60_000;
    this.hardTtlMs = options.hardTtlMs ?? 15 * 60_000;
  }

  async references(
    scope: CompletionCacheScope,
    sessionId: string | null,
    lease: CompletionHistoryLease,
    load: (signal: AbortSignal) => Promise<readonly CompletionReference[]>
  ): Promise<{ readonly epoch: string; readonly messages: readonly string[] }> {
    if (this.disposed || !this.authorized(lease)) return EMPTY_REFERENCES;
    const entry = this.entry(scope);
    entry.lease = lease;
    entry.load = load;
    const latest = entry.snapshots.at(-1);
    if (!latest || this.now() - latest.verifiedAt >= this.refreshMs) await this.build(entry);
    if (!this.retained(entry) || !this.authorized(lease)) return EMPTY_REFERENCES;
    const pin = sessionId === null ? undefined : entry.pins.get(sessionId);
    const pinned =
      pin && this.now() - pin.pinnedAt < this.hardTtlMs
        ? entry.snapshots.find((value) => value.epoch === pin.epoch)
        : undefined;
    const snapshot =
      pinned && this.now() - pinned.verifiedAt < this.hardTtlMs ? pinned : entry.snapshots.at(-1);
    if (!snapshot || this.now() - snapshot.verifiedAt >= this.hardTtlMs) return EMPTY_REFERENCES;
    if (sessionId !== null && snapshot !== pinned) {
      entry.pins.delete(sessionId);
      entry.pins.set(sessionId, { epoch: snapshot.epoch, pinnedAt: this.now() });
      trimMap(entry.pins, MAX_SESSIONS);
    }
    return {
      epoch: snapshot.epoch,
      messages: selectReferences(snapshot.messages, sessionId)
    };
  }

  /** The caller supplies an authoritative bounded window, not an unverified delta. */
  session(
    scope: CompletionCacheScope,
    sessionId: string,
    generation: string,
    messages: readonly CompletionHistoryMessage[]
  ): readonly CompletionHistoryMessage[] {
    if (this.disposed) return [];
    const entry = this.entry(scope);
    const previous = entry.sessions.get(sessionId);
    const start =
      previous?.generation === generation && previous.messages[0]
        ? messages.findIndex((value) => value.id === previous.messages[0]!.id)
        : -1;
    const bounded = boundMessages(start >= 0 ? messages.slice(start) : messages);
    const unchangedPrefix =
      previous?.generation === generation &&
      previous.messages.length <= bounded.length &&
      previous.messages.every((old, index) => {
        const next = bounded[index];
        return (
          next?.id === old.id &&
          next.revision === old.revision &&
          next.role === old.role &&
          next.text === old.text
        );
      });
    const result = unchangedPrefix
      ? [...previous.messages, ...bounded.slice(previous.messages.length)]
      : bounded;
    if (!unchangedPrefix) entry.pins.delete(sessionId);
    entry.sessions.delete(sessionId);
    entry.lastUsed = this.now();
    entry.sessions.set(sessionId, { generation, messages: result, refreshedAt: this.now() });
    trimMap(entry.sessions, MAX_SESSIONS);
    this.enforceLimits();
    return result;
  }

  /** Maintenance only reclaims idle material; history reads require a manual request. */
  sweep(): void {
    for (const entry of this.scopes.values()) {
      if (this.now() - entry.lastUsed >= this.hardTtlMs) {
        this.evict(entry);
        continue;
      }
      for (const [id, window] of entry.sessions)
        if (this.now() - window.refreshedAt >= this.hardTtlMs) {
          entry.sessions.delete(id);
          entry.pins.delete(id);
        }
      if (!entry.lease || !this.authorized(entry.lease)) {
        entry.build?.controller.abort();
        delete entry.load;
        delete entry.lease;
        continue;
      }
    }
  }

  invalidateWorkspace(workspaceId: string): void {
    for (const entry of this.scopes.values())
      if (entry.scope.workspaceId === workspaceId) this.evict(entry);
  }

  invalidateSession(workspaceId: string, sessionId: string): void {
    for (const entry of this.scopes.values()) {
      if (entry.scope.workspaceId !== workspaceId) continue;
      // A source removal also invalidates every pinned reference containing that source.
      if (
        entry.build ||
        entry.snapshots.some((snapshot) =>
          snapshot.messages.some((message) => message.sessionId === sessionId)
        )
      )
        this.evict(entry);
      else {
        entry.sessions.delete(sessionId);
        entry.pins.delete(sessionId);
      }
    }
  }

  invalidateView(authorizationView: string): void {
    for (const entry of this.scopes.values())
      if (entry.scope.authorizationView === authorizationView) this.evict(entry);
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
  }

  clear(): void {
    for (const entry of this.scopes.values()) this.evict(entry);
  }

  statistics(): { scopes: number; bytes: number } {
    return {
      scopes: this.scopes.size,
      bytes: [...this.scopes.values()].reduce((total, entry) => total + bytes(entry), 0)
    };
  }

  private authorized(lease: CompletionHistoryLease): boolean {
    return lease.expiresAt > this.now() && lease.valid();
  }

  private entry(scope: CompletionCacheScope): ScopeCache {
    const key = scopeKey(scope);
    let entry = this.scopes.get(key);
    if (entry && this.now() - entry.lastUsed >= this.hardTtlMs) {
      this.evict(entry);
      entry = undefined;
    }
    if (!entry) {
      entry = {
        scope: { ...scope },
        snapshots: [],
        pins: new Map(),
        sessions: new Map(),
        lastUsed: this.now()
      };
      this.scopes.set(key, entry);
    }
    entry.lastUsed = this.now();
    // Map order is LRU across views as well as Workspaces.
    this.scopes.delete(key);
    this.scopes.set(key, entry);
    this.enforceLimits();
    return entry;
  }

  private retained(entry: ScopeCache): boolean {
    return !this.disposed && this.scopes.get(scopeKey(entry.scope)) === entry;
  }

  private build(entry: ScopeCache): Promise<void> {
    if (entry.build) return entry.build.promise;
    const { lease, load } = entry;
    if (this.reads >= 2 || !lease || !load || !this.authorized(lease) || !this.retained(entry))
      return Promise.resolve();
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(1_000)]);
    const promise = (async () => {
      try {
        this.reads++;
        const loading = Promise.resolve().then(() => {
          signal.throwIfAborted();
          if (!this.retained(entry) || !this.authorized(lease))
            throw new Error('PROMPT_COMPLETION_UNAVAILABLE');
          return load(signal);
        });
        void loading
          .finally(() => {
            this.reads--;
          })
          .catch(() => undefined);
        const values = await abortable(loading, signal);
        if (signal.aborted || !this.retained(entry) || !this.authorized(lease)) return;
        const messages = boundReferences(values);
        const hash = createHash('sha256').update(JSON.stringify(messages)).digest('hex');
        const latest = entry.snapshots.at(-1);
        if (latest?.hash === hash) latest.verifiedAt = this.now();
        else {
          entry.snapshots.push({ epoch: randomUUID(), hash, messages, verifiedAt: this.now() });
          if (entry.snapshots.length > 2) entry.snapshots.shift();
          for (const [id, pin] of entry.pins)
            if (!entry.snapshots.some((value) => value.epoch === pin.epoch)) entry.pins.delete(id);
        }
        this.enforceLimits();
      } catch {
        // Optional references may be omitted; failure never renews freshness.
      } finally {
        if (entry.build?.controller === controller) delete entry.build;
      }
    })();
    entry.build = { controller, promise };
    return promise;
  }

  private evict(entry: ScopeCache): void {
    entry.build?.controller.abort();
    this.scopes.delete(scopeKey(entry.scope));
    delete entry.load;
    delete entry.lease;
    entry.snapshots.length = 0;
    entry.sessions.clear();
    entry.pins.clear();
  }

  private enforceLimits(): void {
    let total = 0;
    const workspaceBytes = new Map<string, number>();
    for (const entry of [...this.scopes.values()].reverse()) {
      const size = bytes(entry);
      const workspaceSize = (workspaceBytes.get(entry.scope.workspaceId) ?? 0) + size;
      if (total + size > MAX_BYTES || workspaceSize > MAX_WORKSPACE_BYTES) this.evict(entry);
      else {
        total += size;
        workspaceBytes.set(entry.scope.workspaceId, workspaceSize);
      }
    }
    while (this.scopes.size > MAX_SCOPES) this.evict(this.scopes.values().next().value!);
  }
}

function scopeKey(scope: CompletionCacheScope): string {
  return JSON.stringify([scope.workspaceId, scope.generation, scope.authorizationView]);
}

function bytes(entry: ScopeCache): number {
  return Buffer.byteLength(JSON.stringify([entry.snapshots, [...entry.sessions], [...entry.pins]]));
}

function trimMap<K, V>(map: Map<K, V>, size: number): void {
  while (map.size > size) map.delete(map.keys().next().value!);
}

function boundReferences(values: readonly CompletionReference[]): readonly CompletionReference[] {
  const seen = new Set<string>();
  const result: CompletionReference[] = [];
  for (const group of groupReferences(
    values.slice(0, 100),
    PROMPT_COMPLETION_REFERENCE_POOL_SESSIONS,
    null
  )) {
    const selected: CompletionReference[] = [];
    let size = 0;
    for (const value of group.slice(-MAX_REFERENCE_MESSAGES).reverse()) {
      const key = JSON.stringify([value.sessionId, value.id]);
      if (seen.has(key) || !value.text.trim()) continue;
      seen.add(key);
      const text = clipReferenceText(value.text);
      if (size + Buffer.byteLength(text) > MAX_REFERENCE_BYTES) continue;
      size += Buffer.byteLength(text);
      selected.push(
        Object.freeze({ sessionId: value.sessionId, id: value.id, revision: value.revision, text })
      );
    }
    result.push(...selected.reverse());
  }
  return Object.freeze(result);
}

function groupReferences(
  values: readonly CompletionReference[],
  maximumSessions: number,
  excludedSessionId: string | null
): CompletionReference[][] {
  const groups = new Map<string, CompletionReference[]>();
  for (const value of values) {
    if (value.sessionId === excludedSessionId) continue;
    let group = groups.get(value.sessionId);
    if (!group) {
      if (groups.size >= maximumSessions) continue;
      group = [];
      groups.set(value.sessionId, group);
    }
    group.push(value);
  }
  return [...groups.values()];
}

function selectReferences(
  values: readonly CompletionReference[],
  sessionId: string | null
): string[] {
  const groups = groupReferences(values, MAX_REFERENCE_SESSIONS, sessionId);
  const selected: string[] = [];
  let size = 0;
  for (
    let offset = 1;
    offset <= MAX_REFERENCE_MESSAGES && selected.length < MAX_REFERENCE_MESSAGES;
    offset++
  ) {
    for (const group of groups) {
      const value = group.at(-offset);
      if (!value || size + Buffer.byteLength(value.text) > MAX_REFERENCE_BYTES) continue;
      selected.push(value.text);
      size += Buffer.byteLength(value.text);
      if (selected.length >= MAX_REFERENCE_MESSAGES) break;
    }
  }
  // Generation reads this sequence from the end, so the newest round stays last.
  return selected.reverse();
}

function clipReferenceText(text: string): string {
  if (Buffer.byteLength(text) <= MAX_REFERENCE_TEXT_BYTES) return text;
  const suffix = '\n[truncated]';
  let size = Buffer.byteLength(suffix);
  let prefix = '';
  for (const character of text) {
    const length = Buffer.byteLength(character);
    if (size + length > MAX_REFERENCE_TEXT_BYTES) break;
    prefix += character;
    size += length;
  }
  return prefix + suffix;
}

function boundMessages(
  values: readonly CompletionHistoryMessage[]
): readonly CompletionHistoryMessage[] {
  const selected = values.slice(-64).map((value) =>
    Object.freeze({
      id: value.id,
      revision: value.revision,
      role: value.role,
      text: clip(value.text, 4_096)
    })
  );
  let size = selected.reduce((sum, value) => sum + Buffer.byteLength(value.text), 0);
  if (values.length > 64 || size > 32_768)
    while (selected.length > 1 && (selected.length > 32 || size > 16_384))
      size -= Buffer.byteLength(selected.shift()!.text);
  return Object.freeze(selected);
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = /[\uD800-\uDBFF]/u.test(text[max - 1]!) ? max - 1 : max;
  return `${text.slice(0, end)}\n[truncated]`;
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = () => signal.removeEventListener('abort', aborted);
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', aborted, { once: true });
    pending.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      }
    );
  });
}

import type { ExtensionSessionContextProvider } from '@myagentroam/agent/extensions';
import { isPlainRecord } from '../../util/records.js';

type AgentObservation =
  | {
      readonly kind: 'message' | 'terminal';
      readonly value: string;
      readonly final?: boolean;
      readonly turnId?: string;
    }
  | { readonly kind: 'files'; readonly paths: readonly string[] };

export function agentObservationFromRunEvent(input: {
  readonly eventType: string;
  readonly payload: unknown;
  readonly terminalStatus: string | undefined;
}): AgentObservation | undefined {
  if (input.terminalStatus !== undefined) return { kind: 'terminal', value: input.terminalStatus };
  if (
    input.eventType === 'conversation.item' &&
    isPlainRecord(input.payload) &&
    input.payload.kind === 'assistant_message' &&
    input.payload.status === 'COMPLETED' &&
    isPlainRecord(input.payload.payload) &&
    typeof input.payload.payload.text === 'string' &&
    input.payload.payload.text.length > 0
  )
    return {
      kind: 'message',
      value: input.payload.payload.text,
      ...(input.payload.payload.phase === 'final_answer' ? { final: true } : {}),
      ...(typeof input.payload.turnId === 'string' ? { turnId: input.payload.turnId } : {})
    };
  if (
    input.eventType === 'conversation.item' &&
    isPlainRecord(input.payload) &&
    input.payload.kind === 'file_change' &&
    input.payload.status === 'COMPLETED' &&
    isPlainRecord(input.payload.payload) &&
    Array.isArray(input.payload.payload.changes)
  ) {
    const paths = input.payload.payload.changes.flatMap((change: unknown) =>
      isPlainRecord(change) && typeof change.path === 'string' && change.path.length > 0
        ? [change.path]
        : []
    );
    if (paths.length) return { kind: 'files', paths };
  }
  return undefined;
}

type Observation = {
  readonly revision: number;
  readonly childId: string;
  readonly runId: string;
  readonly executionId: string;
  readonly kind: 'message' | 'terminal';
  readonly value: string;
  readonly truncated: boolean;
  readonly final?: boolean;
  readonly wakes?: boolean;
};

type ResultProjection = {
  summary?: string;
  summaryTruncated?: boolean;
  summaryRevision?: number;
  turnId?: string;
  changedFiles: string[];
  changedFilesTruncated?: boolean;
  revision: number;
};
export interface AgentObservationSnapshot {
  readonly childId: string;
  readonly runId: string;
  readonly executionId: string;
  readonly firstRevision: number;
  readonly hasMoreUpdates?: true;
  /** Updates evicted from this relationship since its last confirmed observation. */
  readonly omittedUpdates?: number;
  readonly result?: Omit<ResultProjection, 'revision' | 'summaryRevision'>;
  readonly updates: readonly {
    readonly kind: 'message' | 'terminal';
    readonly value: string;
    readonly truncated: boolean;
    readonly final?: boolean;
  }[];
  acknowledge(): void;
}

/** Volatile, session-owned delivery of live direct-child observations. */
export class AgentNetworkObservations {
  readonly #parents = new Map<string, ParentObservations>();
  readonly #waiters = new Map<
    ParentObservations,
    readonly { agentId: string; runId: string; executionId: string | undefined }[]
  >();

  attach(parentId: string): ParentObservations {
    if (this.#parents.has(parentId)) throw new Error('AGENT_NETWORK_PARENT_ALREADY_ATTACHED');
    const parent = new ParentObservations(() => {
      for (const [id, current] of this.#parents) if (current === parent) this.#parents.delete(id);
    });
    this.#parents.set(parentId, parent);
    return parent;
  }

  get(parentId: string): ParentObservations | undefined {
    return this.#parents.get(parentId);
  }

  publish(
    input: {
      readonly parentId: string;
      readonly childId: string;
      readonly runId: string;
      readonly executionId: string;
    } & AgentObservation
  ): void {
    this.#parents.get(input.parentId)?.publish(input);
  }

  /** Call-local observations never enter a Session's automatic context or wake channel. */
  watchExecutions(
    targets: readonly { agentId: string; runId: string; executionId: string | undefined }[]
  ): ParentObservations {
    const observations = new ParentObservations(() => this.#waiters.delete(observations));
    this.#waiters.set(observations, targets);
    return observations;
  }

  /** Only direct children are automatic; other targets reach active, execution-scoped waits. */
  publishChild(
    input: {
      readonly parentId?: string | null;
      readonly childId: string;
      readonly runId: string;
      readonly executionId: string;
    } & AgentObservation
  ): void {
    if (input.parentId != null) this.#parents.get(input.parentId)?.publish(input);
    for (const [waiter, targets] of this.#waiters) {
      if (
        targets.some(
          (target) =>
            target.agentId === input.childId &&
            target.runId === input.runId &&
            target.executionId === input.executionId
        )
      )
        waiter.publish(input);
    }
  }

  promote(previousId: string, nextId: string): void {
    if (previousId === nextId) return;
    const parent = this.#parents.get(previousId);
    if (parent === undefined) return;
    if (this.#parents.has(nextId)) throw new Error('AGENT_NETWORK_PARENT_ALREADY_ATTACHED');
    this.#parents.delete(previousId);
    this.#parents.set(nextId, parent);
  }
}

/** Session-scoped unread reports in publication order; acknowledges only delivered versions.
 * Automatic collection batches reports; explicit consumers take one message at a time.
 * Terminal state and its final result are independent of the remaining message backlog.
 * This buffer does not own Agent executions or approval decisions.
 */
export class ParentObservations implements ExtensionSessionContextProvider {
  readonly #items = new Map<string, Observation>();
  readonly #results = new Map<string, ResultProjection>();
  readonly #omissions = new Map<string, { total: number; acknowledged: number }>();
  readonly #listeners = new Set<(snapshot?: AgentObservationSnapshot) => void>();
  readonly #wakeListeners = new Set<() => void>();
  #revision = 0;
  #closed = false;

  constructor(private readonly detach: () => void) {}

  readonly wake = {
    pending: (): boolean =>
      [...this.#items.values()].some((item) => item.kind === 'message' && item.wakes !== false),
    subscribe: (listener: () => void): (() => void) => {
      if (!this.#closed) this.#wakeListeners.add(listener);
      return () => this.#wakeListeners.delete(listener);
    }
  };

  /** Queue an upward report for natural collection without waking the parent. */
  report(input: {
    readonly childId: string;
    readonly runId: string;
    readonly executionId: string;
    readonly value: string;
  }): boolean {
    if (this.#closed) return false;
    const value = boundedUtf8(input.value, 2000);
    const revision = ++this.#revision;
    this.#items.set(
      JSON.stringify([input.childId, input.runId, input.executionId, 'report', revision]),
      {
        revision,
        childId: input.childId,
        runId: input.runId,
        executionId: input.executionId,
        kind: 'message',
        value: value.value,
        truncated: value.truncated,
        wakes: false
      }
    );
    this.trim(input.childId);
    return true;
  }

  /** Waiters also need terminal notifications; sleeping model turns only wake for messages. */
  subscribe(listener: (snapshot?: AgentObservationSnapshot) => void): () => void {
    if (!this.#closed) this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  publish(
    input: {
      readonly childId: string;
      readonly runId: string;
      readonly executionId: string;
    } & AgentObservation
  ): void {
    if (this.#closed) return;
    const { childId, runId, executionId, kind } = input;
    const revision = ++this.#revision;
    const resultKey = JSON.stringify([childId, runId, executionId]);
    if (kind === 'terminal' && input.value !== 'SUCCEEDED') {
      const result = this.#results.get(resultKey);
      if (result) {
        result.revision = revision;
        delete result.summary;
        delete result.summaryTruncated;
        delete result.summaryRevision;
      }
    }
    if (kind === 'files' || (kind === 'message' && input.final)) {
      const result = this.#results.get(resultKey) ?? { changedFiles: [], revision: 0 };
      result.revision = revision;
      if (kind === 'files') {
        for (const path of input.paths) {
          if (result.changedFiles.includes(path)) continue;
          if (result.changedFiles.length >= 200) {
            result.changedFilesTruncated = true;
            break;
          }
          result.changedFiles.push(path);
        }
      } else {
        const summary = boundedUtf8(input.value, 16_384);
        result.summary = summary.value;
        result.summaryRevision = revision;
        if (summary.truncated) result.summaryTruncated = true;
        else delete result.summaryTruncated;
        if (input.turnId) result.turnId = input.turnId;
        else delete result.turnId;
      }
      this.#results.set(resultKey, result);
    }
    if (kind === 'files') {
      this.trim(childId);
      return;
    }
    const { value } = input;
    const bounded = boundedUtf8(value, 2_000);
    const key = JSON.stringify([
      childId,
      runId,
      executionId,
      kind,
      ...(kind === 'message' ? [revision] : [])
    ]);
    this.#items.delete(key);
    this.#items.set(key, {
      revision,
      childId,
      runId,
      executionId,
      kind,
      value: bounded.value,
      truncated: bounded.truncated,
      ...(input.final ? { final: true } : {})
    });
    this.trim(childId);
    const terminalSnapshot = kind === 'terminal' ? this.capture(childId, executionId) : undefined;
    for (const listener of [...this.#listeners]) {
      try {
        listener(terminalSnapshot);
      } catch {
        // An observer must not interrupt authoritative Run publication or cleanup.
      }
    }
    if (kind === 'message')
      for (const listener of [...this.#wakeListeners]) {
        try {
          listener();
        } catch {
          /* A wake observer cannot affect Run publication. */
        }
      }
  }

  collect(signal: AbortSignal): ReturnType<ExtensionSessionContextProvider['collect']> {
    signal.throwIfAborted();
    const pending = [...this.#items.values()];
    const children = [...new Set(pending.map((item) => item.childId))];
    const batch = children.slice(0, 8);
    return batch.map((childId) => {
      const snapshot = this.captureBatch(childId, undefined, Infinity)!;
      // Automatic collection follows child Sessions; explicit capture stays execution-scoped.
      const hasMoreUpdates =
        snapshot.hasMoreUpdates ||
        pending.some(
          (item) =>
            item.childId === childId &&
            (item.runId !== snapshot.runId || item.executionId !== snapshot.executionId)
        );
      const content = boundedObservation({
        agentId: snapshot.childId,
        runId: snapshot.runId,
        executionId: snapshot.executionId,
        ...(hasMoreUpdates ? { hasMoreUpdates: true } : {}),
        ...(snapshot.omittedUpdates ? { omittedUpdates: snapshot.omittedUpdates } : {}),
        ...(batch.length < children.length ? { hasMoreAgents: true } : {}),
        ...snapshot.result,
        updates: snapshot.updates.map((item) => ({
          kind: item.kind,
          value: item.value,
          ...(item.truncated ? { truncated: true } : {})
        }))
      });
      return {
        content,
        acknowledge: snapshot.acknowledge
      };
    });
  }

  /** Capture one unread message plus the terminal result for an explicit consumer. */
  capture(childId: string, executionId?: string): AgentObservationSnapshot | undefined {
    return this.captureBatch(childId, executionId, 1);
  }

  /** Loss is relationship-scoped, never evidence about a particular execution. */
  captureOmissions(childId: string) {
    const notice = this.#omissions.get(childId);
    if (!notice) return undefined;
    const through = notice.total;
    return {
      omittedUpdates: through - notice.acknowledged,
      acknowledge: () => {
        if (this.#omissions.get(childId) !== notice) return;
        notice.acknowledged = Math.max(notice.acknowledged, through);
        if (notice.acknowledged === notice.total) this.#omissions.delete(childId);
      }
    };
  }

  private captureBatch(
    childId: string,
    executionId: string | undefined,
    maximumMessages: number
  ): AgentObservationSnapshot | undefined {
    const group: Array<[string, Observation]> = [];
    for (const [key, item] of this.#items) {
      if (
        item.childId !== childId ||
        (executionId !== undefined && item.executionId !== executionId)
      )
        continue;
      const first = group[0]?.[1];
      if (first && (first.runId !== item.runId || first.executionId !== item.executionId)) continue;
      group.push([key, item]);
    }
    const first = group[0]?.[1];
    if (!first) return undefined;
    const notice = this.captureOmissions(childId);
    const omittedUpdates = notice?.omittedUpdates;
    const resultKey = JSON.stringify([childId, first.runId, first.executionId]);
    const stored = group.some(([, item]) => item.kind === 'terminal')
      ? this.#results.get(resultKey)
      : undefined;
    const result = stored && {
      ...(stored.summary === undefined ? {} : { summary: stored.summary }),
      ...(stored.summaryTruncated ? { summaryTruncated: true } : {}),
      ...(stored.turnId ? { turnId: stored.turnId } : {}),
      changedFiles: [...stored.changedFiles],
      ...(stored.changedFilesTruncated ? { changedFilesTruncated: true } : {})
    };
    const resultRevision = stored?.revision;
    const coveredFinal =
      result?.summary && !result.summaryTruncated
        ? group.find(([, item]) => item.revision === stored?.summaryRevision)
        : undefined;
    // Keep space for the terminal result and envelope. Escaping can expand a 2 KB message sixfold.
    let messageBytes = 0;
    let messageCount = 0;
    let batchFull = false;
    const delivered = group.filter(([key, item]) => {
      if (item.kind === 'terminal' || key === coveredFinal?.[0]) return true;
      if (batchFull || messageCount >= maximumMessages) return false;
      const bytes = Buffer.byteLength(
        escapedJson({
          kind: item.kind,
          value: item.value,
          ...(item.truncated ? { truncated: true } : {})
        }),
        'utf8'
      );
      if (messageBytes + bytes > 16_384) {
        batchFull = true;
        return false;
      }
      messageBytes += bytes;
      messageCount++;
      return true;
    });
    return {
      childId,
      runId: first.runId,
      executionId: first.executionId,
      firstRevision: Math.min(...delivered.map(([, item]) => item.revision)),
      ...(delivered.length < group.length ? { hasMoreUpdates: true as const } : {}),
      ...(omittedUpdates ? { omittedUpdates } : {}),
      ...(result === undefined ? {} : { result }),
      updates: delivered
        .filter(([key]) => key !== coveredFinal?.[0])
        .map(([, item]) => ({
          kind: item.kind,
          value: item.value,
          truncated: item.truncated,
          ...(item.final ? { final: true } : {})
        })),
      acknowledge: () => {
        let terminalAcknowledged = false;
        for (const [key, item] of delivered) {
          if (this.#items.get(key)?.revision !== item.revision) continue;
          this.#items.delete(key);
          if (item.kind === 'terminal') terminalAcknowledged = true;
        }
        if (terminalAcknowledged && this.#results.get(resultKey)?.revision === resultRevision)
          this.#results.delete(resultKey);
        notice?.acknowledge();
      }
    };
  }

  /** Bound each relationship across executions, including result-only file snapshots. */
  private trim(childId: string): void {
    const entries = [...this.#items].filter(([, item]) => item.childId === childId);
    const removedResults = new Set<string>();
    let omitted = 0;
    for (const [key, item] of entries.slice(0, Math.max(0, entries.length - 10))) {
      this.#items.delete(key);
      removedResults.add(JSON.stringify([childId, item.runId, item.executionId]));
      omitted++;
    }
    const retainedResults = new Set(
      [...this.#items.values()]
        .filter((item) => item.childId === childId)
        .map((item) => JSON.stringify([childId, item.runId, item.executionId]))
    );
    for (const key of removedResults) if (!retainedResults.has(key)) this.#results.delete(key);
    const prefix = JSON.stringify([childId]).slice(0, -1) + ',';
    const results = [...this.#results]
      .filter(([key]) => key.startsWith(prefix))
      .sort(
        (a, b) =>
          Number(retainedResults.has(b[0])) - Number(retainedResults.has(a[0])) ||
          b[1].revision - a[1].revision
      );
    for (const [key] of results.slice(10)) {
      this.#results.delete(key);
      // File-only snapshots do not wake the parent; their omissions accompany the next reply.
      omitted++;
    }
    if (omitted) {
      const notice = this.#omissions.get(childId) ?? { total: 0, acknowledged: 0 };
      notice.total += omitted;
      this.#omissions.set(childId, notice);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#items.clear();
    this.#results.clear();
    this.#omissions.clear();
    this.#listeners.clear();
    this.#wakeListeners.clear();
    this.detach();
  }
}

function boundedUtf8(value: string, maximum: number): { value: string; truncated: boolean } {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maximum) return { value, truncated: false };
  let end = maximum;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return { value: bytes.subarray(0, end).toString('utf8'), truncated: true };
}

function escapedJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&]/g, (character) =>
    character === '<' ? '\\u003c' : character === '>' ? '\\u003e' : '\\u0026'
  );
}

function boundedObservation(input: {
  agentId: string;
  runId: string;
  executionId: string;
  hasMoreUpdates?: boolean;
  omittedUpdates?: number;
  hasMoreAgents?: boolean;
  summary?: string;
  summaryTruncated?: boolean;
  turnId?: string;
  changedFiles?: string[];
  changedFilesTruncated?: boolean;
  updates: Array<{ kind: string; value: string; truncated?: boolean }>;
}): string {
  const data = {
    ...input,
    ...(input.changedFiles ? { changedFiles: [...input.changedFiles] } : {}),
    updates: input.updates.map((update) => ({ ...update }))
  };
  let updatesTruncated = false;
  const render = () =>
    `<mar_subagent_update>\n${escapedJson({
      ...data,
      ...(updatesTruncated ? { updatesTruncated: true } : {})
    })}\n</mar_subagent_update>`;
  const tooLarge = () => Buffer.byteLength(render(), 'utf8') > 32768;
  while (tooLarge() && data.changedFiles?.length) {
    data.changedFiles.pop();
    data.changedFilesTruncated = true;
  }
  const shorten = (value: string, set: (value: string) => void) => {
    let low = 0;
    let high = Buffer.byteLength(value, 'utf8');
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      set(boundedUtf8(value, middle).value);
      if (tooLarge()) high = middle - 1;
      else low = middle;
    }
    set(boundedUtf8(value, low).value);
  };
  if (tooLarge() && data.summary !== undefined) {
    const summary = data.summary;
    data.summaryTruncated = true;
    shorten(summary, (value) => {
      data.summary = value;
    });
  }
  for (const update of data.updates) {
    if (!tooLarge()) break;
    const value = update.value;
    update.truncated = true;
    shorten(value, (text) => {
      update.value = text;
    });
  }
  while (tooLarge() && data.updates.length) {
    data.updates.pop();
    updatesTruncated = true;
  }
  if (tooLarge()) {
    const fallback = {
      agentId: boundedUtf8(data.agentId, 512).value,
      runId: boundedUtf8(data.runId, 512).value,
      executionId: boundedUtf8(data.executionId, 512).value,
      ...(data.hasMoreUpdates ? { hasMoreUpdates: true } : {}),
      ...(data.omittedUpdates ? { omittedUpdates: data.omittedUpdates } : {}),
      ...(data.hasMoreAgents ? { hasMoreAgents: true } : {}),
      detailsTruncated: true
    };
    return `<mar_subagent_update>\n${escapedJson(fallback)}\n</mar_subagent_update>`;
  }
  return render();
}

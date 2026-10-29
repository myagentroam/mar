import type { ExtensionSessionContextProvider } from '@myagentroam/agent/extensions';
import { isPlainRecord } from '../util/records.js';

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
  readonly result?: Omit<ResultProjection, 'revision'>;
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

  /** Direct children are automatic; other Sessions are watched only when explicitly targeted. */
  publishChild(
    input: {
      readonly parentId?: string | null;
      readonly childId: string;
      readonly runId: string;
      readonly executionId: string;
    } & AgentObservation
  ): void {
    for (const [parentId, parent] of this.#parents) {
      if (parentId === input.parentId || parent.observes(input.childId)) parent.publish(input);
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

export class ParentObservations implements ExtensionSessionContextProvider {
  readonly #items = new Map<string, Observation>();
  readonly #results = new Map<string, ResultProjection>();
  readonly #listeners = new Set<(snapshot?: AgentObservationSnapshot) => void>();
  readonly #wakeListeners = new Set<() => void>();
  readonly #targets = new Set<string>();
  #revision = 0;
  #closed = false;

  constructor(private readonly detach: () => void) {}

  observe(childId: string): void {
    if (!this.#closed) this.#targets.add(childId);
  }

  observes(childId: string): boolean {
    return this.#targets.has(childId);
  }

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
    this.#items.set(JSON.stringify([input.childId, input.runId, input.executionId, 'report']), {
      revision: ++this.#revision,
      childId: input.childId,
      runId: input.runId,
      executionId: input.executionId,
      kind: 'message',
      value: value.value,
      truncated: value.truncated,
      wakes: false
    });
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
    const resultKey = JSON.stringify([childId, runId, executionId]);
    if (kind === 'terminal' && input.value !== 'SUCCEEDED') {
      const result = this.#results.get(resultKey);
      if (result) {
        result.revision = ++this.#revision;
        delete result.summary;
        delete result.summaryTruncated;
      }
    }
    if (kind === 'files' || (kind === 'message' && input.final)) {
      const result = this.#results.get(resultKey) ?? { changedFiles: [], revision: 0 };
      result.revision = ++this.#revision;
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
        if (summary.truncated) result.summaryTruncated = true;
        else delete result.summaryTruncated;
        if (input.turnId) result.turnId = input.turnId;
        else delete result.turnId;
      }
      this.#results.set(resultKey, result);
    }
    if (kind === 'files') return;
    const { value } = input;
    const bounded = boundedUtf8(value, 2_000);
    const key = JSON.stringify([childId, runId, executionId, kind]);
    this.#items.set(key, {
      revision: ++this.#revision,
      childId,
      runId,
      executionId,
      kind,
      value: bounded.value,
      truncated: bounded.truncated,
      ...(input.final ? { final: true } : {})
    });
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
    const children = [...new Set([...this.#items.values()].map((item) => item.childId))].slice(
      0,
      8
    );
    return children.map((childId) => {
      const snapshot = this.capture(childId)!;
      const updates =
        snapshot.result?.summary && !snapshot.result.summaryTruncated
          ? snapshot.updates.filter((item) => !item.final)
          : snapshot.updates;
      const content = boundedObservation({
        agentId: snapshot.childId,
        runId: snapshot.runId,
        executionId: snapshot.executionId,
        ...snapshot.result,
        updates: updates.map((item) => ({
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

  /** Capture the same versions used by automatic collection for wait/send consumption. */
  capture(childId: string, executionId?: string): AgentObservationSnapshot | undefined {
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
    return {
      childId,
      runId: first.runId,
      executionId: first.executionId,
      firstRevision: Math.min(...group.map(([, item]) => item.revision)),
      ...(result === undefined ? {} : { result }),
      updates: group.map(([, item]) => ({
        kind: item.kind,
        value: item.value,
        truncated: item.truncated,
        ...(item.final ? { final: true } : {})
      })),
      acknowledge: () => {
        let terminalAcknowledged = false;
        for (const [key, item] of group) {
          if (this.#items.get(key)?.revision !== item.revision) continue;
          this.#items.delete(key);
          if (item.kind === 'terminal') terminalAcknowledged = true;
        }
        if (terminalAcknowledged && this.#results.get(resultKey)?.revision === resultRevision)
          this.#results.delete(resultKey);
      }
    };
  }

  captureBeforeSend(childId: string): { acknowledge(): void } {
    const captured = [...this.#items].filter(([, item]) => item.childId === childId);
    const results = new Map(
      captured
        .filter(([, item]) => item.kind === 'terminal')
        .map(([, item]) => {
          const key = JSON.stringify([item.childId, item.runId, item.executionId]);
          return [key, this.#results.get(key)?.revision] as const;
        })
    );
    return {
      acknowledge: () => {
        for (const [key, item] of captured) {
          if (this.#items.get(key)?.revision !== item.revision) continue;
          this.#items.delete(key);
          if (item.kind === 'terminal') {
            const resultKey = JSON.stringify([item.childId, item.runId, item.executionId]);
            if (this.#results.get(resultKey)?.revision === results.get(resultKey))
              this.#results.delete(resultKey);
          }
        }
      }
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#items.clear();
    this.#results.clear();
    this.#listeners.clear();
    this.#wakeListeners.clear();
    this.#targets.clear();
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

function boundedObservation(input: {
  agentId: string;
  runId: string;
  executionId: string;
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
    `<mar_subagent_update>\n${JSON.stringify({
      ...data,
      ...(updatesTruncated ? { updatesTruncated: true } : {})
    }).replace(/[<>&]/g, (character) =>
      character === '<' ? '\\u003c' : character === '>' ? '\\u003e' : '\\u0026'
    )}\n</mar_subagent_update>`;
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
      detailsTruncated: true
    };
    return `<mar_subagent_update>\n${JSON.stringify(fallback).replace(/[<>&]/g, (character) =>
      character === '<' ? '\\u003c' : character === '>' ? '\\u003e' : '\\u0026'
    )}\n</mar_subagent_update>`;
  }
  return render();
}

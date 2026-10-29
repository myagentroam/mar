import type { Agent, AgentEvent, AgentSession, ExecutionResult } from '@myagentroam/agent';
import type { ExtensionSessionContextProvider } from '@myagentroam/agent/extensions';
import {
  boundedUtf8,
  projectChildEvent,
  publicChildSnapshot,
  type ChildSnapshot
} from './snapshot.js';

type Item = {
  readonly sessionId: string;
  readonly executionId: string;
  readonly kind: 'message' | 'terminal';
  readonly value: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly permissionStop?: ExecutionResult['permissionStop'];
  readonly final?: boolean;
  readonly truncated?: boolean;
  readonly revision: number;
  readonly wakes: boolean;
};

/** One warm parent Session's live observations; Execution remains owned by Core. */
export class SessionObservations implements ExtensionSessionContextProvider {
  constructor(
    readonly full = false,
    private readonly agent?: Pick<Agent, 'sessionHistory'>
  ) {}
  readonly #subscriptions = new Map<string, () => void>();
  readonly #items = new Map<string, Item>();
  readonly #snapshots = new Map<string, ChildSnapshot>();
  readonly #terminals = new Map<string, AgentEvent>();
  readonly #latestTerminal = new Map<string, string>();
  readonly #consumedTerminals = new Set<string>();
  readonly #receipts = new Map<string, { clientMessageId: string; executionId: string }>();
  readonly #listeners = new Set<() => void>();
  #revision = 0;
  #closed = false;

  readonly wake = {
    pending: () => [...this.#items.values()].some((item) => item.wakes),
    subscribe: (listener: () => void) => {
      if (!this.#closed) this.#listeners.add(listener);
      return () => this.#listeners.delete(listener);
    }
  };

  observe(session: Pick<AgentSession, 'id' | 'subscribe'>): void {
    if (this.#closed || this.#subscriptions.has(session.id)) return;
    const subscription = session.subscribe((event) => {
      this.#publish(session.id, event);
      if (isTerminal(event)) this.#unobserve(session.id);
    });
    this.#subscriptions.set(session.id, subscription.unsubscribe);
    if (subscription.terminalEvent) {
      this.#publish(session.id, subscription.terminalEvent);
      this.#unobserve(session.id);
    }
  }

  #unobserve(sessionId: string): void {
    this.#subscriptions.get(sessionId)?.();
    this.#subscriptions.delete(sessionId);
  }

  #publish(sessionId: string, event: AgentEvent): void {
    if (this.#closed) return;
    const snapshotKey = JSON.stringify([sessionId, event.executionId]);
    if (
      (event.type === 'message.completed' && (this.full || event.phase === 'final_answer')) ||
      (event.type === 'tool.completed' && (this.full || event.toolName === 'apply_patch')) ||
      (this.full && (event.type === 'tool.started' || event.type === 'tool.failed')) ||
      event.type === 'execution.failed' ||
      event.type === 'execution.cancelled'
    ) {
      const snapshot = this.#snapshots.get(snapshotKey) ?? { changedFiles: [] };
      projectChildEvent(snapshot, event, this.full);
      this.#snapshots.set(snapshotKey, snapshot);
    }
    const item =
      event.type === 'message.completed'
        ? { kind: 'message' as const, value: event.text }
        : event.type === 'execution.completed' ||
            event.type === 'execution.cancelled' ||
            event.type === 'execution.failed'
          ? { kind: 'terminal' as const, value: event.type }
          : undefined;
    if (!item) return;
    if (item.kind === 'terminal' && this.agent) {
      this.#terminals.set(snapshotKey, event);
      this.#latestTerminal.set(sessionId, snapshotKey);
    }
    const key = JSON.stringify([sessionId, event.executionId, item.kind]);
    const bounded = this.full
      ? { value: item.value, truncated: false }
      : boundedUtf8(item.value, 2000);
    this.#items.set(key, {
      sessionId,
      executionId: event.executionId,
      ...item,
      value: bounded.value,
      ...(bounded.truncated ? { truncated: true } : {}),
      ...(event.type === 'execution.failed'
        ? {
            errorCode: event.code,
            ...(event.message === undefined
              ? {}
              : {
                  errorMessage: this.full ? event.message : boundedUtf8(event.message, 1000).value
                })
          }
        : {}),
      ...(event.type === 'execution.completed' && event.permissionStop !== undefined
        ? {
            permissionStop: {
              ...event.permissionStop,
              reason: this.full
                ? event.permissionStop.reason
                : boundedUtf8(event.permissionStop.reason, 1000).value
            }
          }
        : {}),
      ...(event.type === 'message.completed' && event.phase === 'final_answer'
        ? { final: true }
        : {}),
      revision: ++this.#revision,
      wakes: item.kind === 'message'
    });
    if (item.kind === 'message')
      for (const listener of [...this.#listeners]) {
        try {
          listener();
        } catch {
          /* Listener failures cannot affect Core event delivery. */
        }
      }
  }

  /** Upward reports are collected at the parent's next natural round, without waking it. */
  report(sessionId: string, executionId: string, value: string): boolean {
    if (this.#closed) return false;
    const key = JSON.stringify([sessionId, executionId, 'report']);
    const bounded = boundedUtf8(value, 2000);
    this.#items.set(key, {
      sessionId,
      executionId,
      kind: 'message',
      value: bounded.value,
      ...(bounded.truncated ? { truncated: true } : {}),
      revision: ++this.#revision,
      wakes: false
    });
    return true;
  }

  snapshot(sessionId: string, executionId: string): ChildSnapshot {
    const stored = this.#snapshots.get(JSON.stringify([sessionId, executionId]));
    return stored
      ? {
          ...stored,
          changedFiles: [...stored.changedFiles],
          ...(stored.latestMessage ? { latestMessage: { ...stored.latestMessage } } : {}),
          ...(stored.latestActivity ? { latestActivity: { ...stored.latestActivity } } : {}),
          ...(stored.verification ? { verification: [...stored.verification] } : {}),
          ...(stored.evidence ? { evidence: stored.evidence.map((item) => ({ ...item })) } : {})
        }
      : { changedFiles: [] };
  }

  terminal(sessionId: string): AgentEvent | undefined {
    const key = this.#latestTerminal.get(sessionId);
    return key === undefined ? undefined : this.#terminals.get(key);
  }

  #releaseSnapshot(sessionId: string, executionId: string): void {
    if (
      this.#terminals.has(JSON.stringify([sessionId, executionId])) ||
      [...this.#items.values()].some(
        (item) => item.sessionId === sessionId && item.executionId === executionId
      )
    )
      return;
    this.#snapshots.delete(JSON.stringify([sessionId, executionId]));
  }

  /** A consumed observation may be discarded only after its terminal is present in Session history. */
  #verifyTerminal(sessionId: string, executionId: string): void {
    const key = JSON.stringify([sessionId, executionId]);
    const terminal = this.#terminals.get(key);
    if (!this.agent || !terminal) {
      this.#releaseSnapshot(sessionId, executionId);
      return;
    }
    void this.agent
      .sessionHistory(sessionId, { limit: 100 })
      .then((page) => {
        if (this.#closed || this.#terminals.get(key) !== terminal) return;
        if (
          !page.entries.some(
            (entry) => entry.kind === 'event' && entry.event.eventId === terminal.eventId
          )
        )
          return;
        this.#terminals.delete(key);
        if (this.#latestTerminal.get(sessionId) === key) this.#latestTerminal.delete(sessionId);
        this.#releaseSnapshot(sessionId, executionId);
      })
      .catch(() => {
        /* Retain the observation if persistence cannot be confirmed. */
      });
  }

  rememberReceipt(
    sessionId: string,
    receipt: { clientMessageId: string; executionId: string }
  ): void {
    if (!this.#closed) this.#receipts.set(sessionId, receipt);
  }

  receipt(sessionId: string): { clientMessageId: string; executionId: string } | undefined {
    return this.#receipts.get(sessionId);
  }

  capture(sessionId: string, executionId?: string) {
    const items = [...this.#items.entries()].filter(
      ([, item]) =>
        item.sessionId === sessionId &&
        (executionId === undefined || item.executionId === executionId)
    );
    const first = items[0]?.[1];
    if (!first) return undefined;
    const captured = items.filter(([, item]) => item.executionId === first.executionId);
    const snapshotKey = JSON.stringify([sessionId, first.executionId]);
    const snapshot = captured.some(([, item]) => item.kind === 'terminal')
      ? publicChildSnapshot(this.#snapshots.get(snapshotKey))
      : {};
    return {
      sessionId,
      executionId: first.executionId,
      snapshot,
      updates: captured.map(([, item]) => ({
        kind: item.kind,
        value: item.value,
        ...(item.final ? { final: true } : {}),
        ...(item.truncated ? { truncated: true } : {}),
        ...(item.errorCode === undefined ? {} : { errorCode: item.errorCode }),
        ...(item.errorMessage === undefined ? {} : { errorMessage: item.errorMessage }),
        ...(item.permissionStop === undefined ? {} : { permissionStop: item.permissionStop })
      })),
      acknowledge: () => {
        for (const [key, item] of captured) {
          if (this.#items.get(key)?.revision !== item.revision) continue;
          this.#items.delete(key);
          if (item.kind === 'terminal') this.claimTerminal(item.sessionId, item.executionId);
        }
        if (captured.some(([, item]) => item.kind === 'terminal'))
          this.#verifyTerminal(sessionId, first.executionId);
      }
    };
  }

  /** Capture the currently unread versions without consuming later events. */
  acknowledgement(sessionId: string): () => void {
    const captured = [...this.#items.entries()].filter(([, item]) => item.sessionId === sessionId);
    return () => {
      for (const [key, item] of captured) {
        if (this.#items.get(key)?.revision !== item.revision) continue;
        this.#items.delete(key);
        if (item.kind === 'terminal') this.claimTerminal(item.sessionId, item.executionId);
      }
      for (const [, item] of captured) {
        if (
          item.kind !== 'terminal' ||
          [...this.#items.values()].some(
            (remaining) =>
              remaining.sessionId === item.sessionId && remaining.executionId === item.executionId
          )
        )
          continue;
        this.#verifyTerminal(item.sessionId, item.executionId);
      }
    };
  }

  /** Claim a terminal projection once per warm parent, including restored history. */
  claimTerminal(sessionId: string, executionId: string): boolean {
    const key = JSON.stringify([sessionId, executionId]);
    if (this.#consumedTerminals.has(key)) return false;
    this.#consumedTerminals.add(key);
    return true;
  }

  collect(signal: AbortSignal) {
    signal.throwIfAborted();
    const ids = [...new Set([...this.#items.values()].map((item) => item.sessionId))].slice(0, 8);
    return ids.flatMap((id) => {
      const item = this.capture(id);
      if (!item) return [];
      const updates =
        item.snapshot.summary && !item.snapshot.summaryTruncated
          ? item.updates.filter((update) => !('final' in update && update.final))
          : item.updates;
      const content = boundedObservation({
        agentId: id,
        executionId: item.executionId,
        ...item.snapshot,
        updates
      });
      return [{ content, acknowledge: item.acknowledge }];
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const unsubscribe of this.#subscriptions.values()) unsubscribe();
    this.#subscriptions.clear();
    this.#listeners.clear();
    this.#items.clear();
    this.#snapshots.clear();
    this.#terminals.clear();
    this.#latestTerminal.clear();
    this.#consumedTerminals.clear();
    this.#receipts.clear();
  }
}

function isTerminal(event: AgentEvent): boolean {
  return (
    event.type === 'execution.completed' ||
    event.type === 'execution.cancelled' ||
    event.type === 'execution.failed'
  );
}

function boundedObservation<
  T extends {
    agentId: string;
    executionId: string;
    summary?: string;
    summaryTruncated?: boolean;
    changedFiles?: string[];
    changedFilesTruncated?: boolean;
    updates: Array<{ value: string; truncated?: boolean }>;
  }
>(input: T): string {
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
      executionId: boundedUtf8(data.executionId, 512).value,
      detailsTruncated: true
    };
    return `<mar_subagent_update>\n${JSON.stringify(fallback).replace(/[<>&]/g, (character) =>
      character === '<' ? '\\u003c' : character === '>' ? '\\u003e' : '\\u0026'
    )}\n</mar_subagent_update>`;
  }
  return render();
}

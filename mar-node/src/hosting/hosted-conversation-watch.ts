import type { MarAgentRuntimeModelConfiguration, WorkbenchEvent } from '@myagentroam/protocol';
import { safeErrorCode } from '../util/safe-error.js';
import type {
  SessionWatchSlotCoordinator,
  SessionWatchSlotToken
} from '../service/session-watch-slot-coordinator.js';

interface WatchInput {
  readonly mode?: string;
  readonly workbenchConnectionId: string;
  readonly watchId: string;
  readonly conversationId: string;
}

interface WatchLease {
  readonly ownerKey: string;
  readonly slotToken: SessionWatchSlotToken;
  readonly sessionHash: string;
  readonly workbenchConnectionId: string;
  readonly watchId: string;
  readonly conversationId: string;
  readonly templateId: string;
  readonly userId: number;
  readonly models: readonly MarAgentRuntimeModelConfiguration[];
  readonly nodeGeneration: string;
  readonly pendingEvents: WorkbenchEvent[];
  expiresAt: number;
  ready: boolean;
  timer: NodeJS.Timeout;
}

interface WatchOptions {
  readonly slots: SessionWatchSlotCoordinator;
  readonly nodeId: () => string;
  readonly nodeGeneration: (() => string) | undefined;
  readonly emit: ((payload: unknown) => void) | undefined;
  readonly nextEvent: (payload: unknown) => WorkbenchEvent | undefined;
  readonly initial: (
    lease: Pick<WatchLease, 'conversationId' | 'userId' | 'templateId' | 'models'>
  ) => Promise<unknown>;
  readonly snapshot: (
    userId: number,
    conversationId: string,
    models: readonly MarAgentRuntimeModelConfiguration[]
  ) => Promise<unknown>;
  readonly mayRefresh: (conversationId: string, completedRunId: string) => boolean;
}

const WATCH_TTL_MS = 45_000;

/** Owns hosted Watch leases, initialization ordering and pending realtime events. */
export class HostedConversationWatch {
  private readonly leases = new Map<string, WatchLease>();
  private snapshotSequence = 0;
  constructor(private readonly options: WatchOptions) {}

  watch(
    input: WatchInput,
    sessionHash: string,
    userId: number,
    templateId: string,
    models: () => readonly MarAgentRuntimeModelConfiguration[]
  ): unknown {
    const ownerKey = `${sessionHash}:${input.workbenchConnectionId}`;
    const existing = this.leases.get(ownerKey);
    if (input.mode === 'renew') {
      if (
        !existing ||
        !this.options.slots.owns(ownerKey, existing.slotToken) ||
        existing.watchId !== input.watchId ||
        existing.conversationId !== input.conversationId ||
        existing.userId !== userId
      )
        throw new Error('SESSION_WATCH_NOT_FOUND');
      if (existing.expiresAt <= Date.now()) {
        this.remove(ownerKey);
        throw new Error('SESSION_WATCH_NOT_FOUND');
      }
      return this.renew(existing);
    }
    const resolvedModels = models();
    if (
      existing &&
      this.options.slots.owns(ownerKey, existing.slotToken) &&
      existing.watchId === input.watchId &&
      existing.conversationId === input.conversationId &&
      existing.userId === userId &&
      existing.expiresAt > Date.now()
    )
      return this.renew(existing);
    this.remove(ownerKey);
    const slotToken = this.options.slots.replace(ownerKey, 'hosted-conversation', () =>
      this.remove(ownerKey)
    );
    const lease: WatchLease = {
      ownerKey,
      slotToken,
      sessionHash,
      workbenchConnectionId: input.workbenchConnectionId,
      watchId: input.watchId,
      conversationId: input.conversationId,
      templateId,
      userId,
      models: resolvedModels,
      nodeGeneration: this.options.nodeGeneration?.() ?? 'local-test-generation',
      pendingEvents: [],
      expiresAt: Date.now() + WATCH_TTL_MS,
      ready: false,
      timer: undefined as unknown as NodeJS.Timeout
    };
    lease.timer = this.timer(ownerKey);
    this.leases.set(ownerKey, lease);
    void this.initialize(lease);
    return this.accepted(lease);
  }

  unwatch(input: WatchInput, sessionHash: string, userId: number): unknown {
    const key = `${sessionHash}:${input.workbenchConnectionId}`;
    const lease = this.leases.get(key);
    if (
      lease?.watchId === input.watchId &&
      lease.conversationId === input.conversationId &&
      lease.userId === userId
    )
      this.remove(key);
    return { unwatched: true };
  }

  hasConversation(id: string): boolean {
    return [...this.leases.values()].some((lease) => lease.conversationId === id);
  }
  removeConversation(id: string): void {
    for (const lease of [...this.leases.values()])
      if (lease.conversationId === id) this.remove(lease.ownerKey);
  }
  close(): void {
    for (const key of [...this.leases.keys()]) this.remove(key);
  }

  publishEvent(conversationId: string, payload: unknown): boolean {
    const leases = [...this.leases.values()].filter(
      (lease) => lease.conversationId === conversationId
    );
    if (leases.length === 0) return false;
    const event = this.options.nextEvent(payload);
    if (event === undefined) return false;
    for (const lease of leases) {
      if (!lease.ready) lease.pendingEvents.push(event);
      else this.emitEvent(lease, event);
    }
    return true;
  }

  publishSnapshot(conversationId: string, snapshot: unknown): void {
    for (const lease of this.leases.values())
      if (lease.conversationId === conversationId && lease.ready)
        this.emitSnapshot(lease, snapshot);
  }

  async refreshReadySnapshots(conversationId: string, completedRunId: string): Promise<void> {
    const leases = [...this.leases.values()].filter(
      (lease) => lease.conversationId === conversationId && lease.ready
    );
    await Promise.allSettled(
      leases.map(async (lease) => {
        const snapshot = await this.options.snapshot(lease.userId, conversationId, lease.models);
        if (
          this.leases.get(lease.ownerKey) !== lease ||
          !lease.ready ||
          !this.options.mayRefresh(conversationId, completedRunId)
        )
          return;
        this.emitSnapshot(lease, { ...(snapshot as Record<string, unknown>), run: null });
      })
    );
  }

  private async initialize(lease: WatchLease): Promise<void> {
    try {
      const snapshot = await this.options.initial(lease);
      if (this.leases.get(lease.ownerKey) !== lease) return;
      this.emitSnapshot(lease, snapshot);
      lease.ready = true;
      for (const event of lease.pendingEvents) this.emitEvent(lease, event);
      lease.pendingEvents.length = 0;
    } catch (error) {
      if (this.leases.get(lease.ownerKey) !== lease) return;
      this.options.emit?.({
        type: 'watch.failed',
        workbenchConnectionId: lease.workbenchConnectionId,
        watchType: 'hosted-conversation',
        watchId: lease.watchId,
        nodeGeneration: lease.nodeGeneration,
        nodeId: this.options.nodeId(),
        templateId: lease.templateId,
        conversationId: lease.conversationId,
        code: safeErrorCode(error, 'HOSTED_CONVERSATION_WATCH_FAILED'),
        message: 'Hosted conversation watch snapshot failed.'
      });
      this.remove(lease.ownerKey);
    }
  }

  private emitSnapshot(lease: WatchLease, payload: unknown): void {
    this.options.emit?.({
      type: 'watch.hosted-conversation.snapshot',
      workbenchConnectionId: lease.workbenchConnectionId,
      watchId: lease.watchId,
      nodeGeneration: lease.nodeGeneration,
      nodeId: this.options.nodeId(),
      templateId: lease.templateId,
      conversationId: lease.conversationId,
      revision: 1,
      snapshotSequence: ++this.snapshotSequence,
      expiresAt: lease.expiresAt,
      payload
    });
  }
  private emitEvent(lease: WatchLease, event: WorkbenchEvent): void {
    this.options.emit?.({
      type: 'watch.hosted-conversation.event',
      workbenchConnectionId: lease.workbenchConnectionId,
      watchId: lease.watchId,
      nodeGeneration: lease.nodeGeneration,
      nodeId: this.options.nodeId(),
      templateId: lease.templateId,
      conversationId: lease.conversationId,
      expiresAt: lease.expiresAt,
      event
    });
  }
  private accepted(lease: WatchLease): unknown {
    return {
      accepted: true,
      watchId: lease.watchId,
      nodeGeneration: lease.nodeGeneration,
      expiresAt: lease.expiresAt
    };
  }
  private renew(lease: WatchLease): unknown {
    lease.expiresAt = Date.now() + WATCH_TTL_MS;
    clearTimeout(lease.timer);
    lease.timer = this.timer(lease.ownerKey);
    return this.accepted(lease);
  }
  private remove(key: string): void {
    const lease = this.leases.get(key);
    if (!lease) return;
    clearTimeout(lease.timer);
    this.leases.delete(key);
    this.options.slots.release(key, lease.slotToken);
  }
  private timer(key: string): NodeJS.Timeout {
    const timer = setTimeout(() => this.remove(key), WATCH_TTL_MS);
    timer.unref();
    return timer;
  }
}

import type { NodeAgentSession } from '../session/contracts.js';
import type { NodeOperationHandler } from '../application/node-operation-contracts.js';
import type { WorkbenchEvent } from '@myagentroam/protocol';
import { isPlainRecord } from '../util/records.js';
import type { ConversationHistoryPage } from '../session/runner-native-session-parsers.js';
import {
  ConversationObservation,
  type ConversationObservationOptions,
  type ConversationObservationUpdate
} from './conversation-observation.js';
import { safeErrorCode } from '../util/safe-error.js';
import {
  SessionWatchSlotCoordinator,
  type SessionWatchPosition,
  type SessionWatchSlotToken
} from './session-watch-slot-coordinator.js';

const INTERVAL_MS = 2_000;
const TTL_MS = 45_000;
const MAX_FAILURES = 3;
const INITIAL_SEGMENT_LIMIT = 6;

interface NativeSessionWatch {
  readonly observation: ConversationObservation;
  expiresAt: number;
  timer: NodeJS.Timeout;
  refresh: Promise<ConversationHistoryPage | undefined> | undefined;
  sessionSignature: string | undefined;
  failures: number;
}

interface NativeSessionLease {
  readonly ownerKey: string;
  readonly slotOwnerKey: string;
  readonly sessionHash: string;
  readonly workbenchConnectionId: string;
  readonly watchId: string;
  readonly sessionId: string;
  readonly unit: 'TURN' | 'SEGMENT';
  readonly nodeGeneration: string;
  workspaceId?: string;
  expiresAt: number;
  ready: boolean;
  snapshotSent: boolean;
  historyReset?: true;
  readonly pendingEvents: WorkbenchEvent[];
  readonly slotToken: SessionWatchSlotToken;
  timer: NodeJS.Timeout;
}

export interface NativeSessionWatchOptions extends ConversationObservationOptions {
  readonly resolve: (sessionId: string) => Promise<NodeAgentSession | undefined>;
  readonly present: (session: NodeAgentSession) => unknown;
  readonly projectInitialPage?: (
    session: NodeAgentSession,
    page: ConversationHistoryPage,
    unit: 'SEGMENT',
    limit: number
  ) => unknown;
  readonly emitSession: (session: unknown) => void;
  readonly emitPage: (session: NodeAgentSession, page: ConversationHistoryPage) => void;
  readonly nodeId?: () => string;
  readonly nodeGeneration?: () => string;
  readonly emitWatchEvent?: (payload: unknown) => void;
  readonly sessionWatchSlots?: SessionWatchSlotCoordinator;
  readonly log?: (event: string, fields: Record<string, unknown>) => void;
}

/** Owns shared native observation and page leases; history invalidation restarts reads, not leases. */
export class NativeSessionWatchService {
  private readonly watches = new Map<string, NativeSessionWatch>();
  private readonly leases = new Map<string, NativeSessionLease>();
  private readonly sessionWatchSlots: SessionWatchSlotCoordinator;
  private snapshotNumber = 0;

  constructor(private readonly options: NativeSessionWatchOptions) {
    this.sessionWatchSlots = options.sessionWatchSlots ?? new SessionWatchSlotCoordinator();
  }

  operations(): Readonly<Record<string, NodeOperationHandler>> {
    return {
      'session.watch': (data) => this.executeWatch(isPlainRecord(data) ? data : {}),
      'session.unwatch': (data) => this.executeUnwatch(isPlainRecord(data) ? data : {})
    };
  }

  private async executeWatch(input: Record<string, unknown>): Promise<unknown> {
    const projectInitialPage = this.options.projectInitialPage;
    if (input.unit === 'SEGMENT' && projectInitialPage === undefined)
      throw new Error('SESSION_INVALID');
    if (
      typeof input.sessionId !== 'string' ||
      (input.workspaceId !== undefined && typeof input.workspaceId !== 'string') ||
      typeof input.watchId !== 'string' ||
      typeof input.workbenchConnectionId !== 'string' ||
      (input.mode !== 'initial' && input.mode !== 'renew') ||
      (input.position !== undefined &&
        input.position !== 'primary' &&
        input.position !== 'secondary') ||
      (input.unit !== undefined && input.unit !== 'SEGMENT')
    )
      throw new Error('SESSION_INVALID');
    const ownerKey = this.ownerKey(input);
    if (input.mode === 'renew') {
      const lease = this.leases.get(ownerKey);
      if (
        lease === undefined ||
        !this.sessionWatchSlots.owns(lease.slotOwnerKey, lease.slotToken) ||
        lease.watchId !== input.watchId ||
        lease.sessionId !== input.sessionId ||
        (input.workspaceId !== undefined && lease.workspaceId !== input.workspaceId)
      )
        throw new Error('SESSION_WATCH_NOT_FOUND');
      if (lease.expiresAt <= Date.now()) {
        this.removeLease(ownerKey);
        throw new Error('SESSION_WATCH_NOT_FOUND');
      }
      lease.expiresAt = Date.now() + TTL_MS;
      const observer = this.watches.get(lease.sessionId);
      if (observer !== undefined) observer.expiresAt = this.latestLeaseExpiry(lease.sessionId);
      clearTimeout(lease.timer);
      lease.timer = this.leaseTimer(ownerKey);
      return this.accepted(lease);
    }
    const existing = this.leases.get(ownerKey);
    const unit = input.unit === 'SEGMENT' ? 'SEGMENT' : 'TURN';
    if (
      existing?.watchId === input.watchId &&
      this.sessionWatchSlots.owns(existing.slotOwnerKey, existing.slotToken) &&
      existing.sessionId === input.sessionId &&
      (input.workspaceId === undefined || existing.workspaceId === input.workspaceId) &&
      existing.unit === unit &&
      existing.expiresAt > Date.now()
    ) {
      existing.expiresAt = Date.now() + TTL_MS;
      clearTimeout(existing.timer);
      existing.timer = this.leaseTimer(ownerKey);
      return this.accepted(existing);
    }
    this.removeLease(ownerKey);
    const slotOwnerKey = this.slotOwnerKey(input);
    const position: SessionWatchPosition = input.position === 'secondary' ? 'secondary' : 'primary';
    const slotToken = this.sessionWatchSlots.replace(
      slotOwnerKey,
      'session',
      () => this.removeLease(ownerKey),
      position
    );
    const lease: NativeSessionLease = {
      ownerKey,
      slotOwnerKey,
      sessionHash: this.sessionHash(input),
      workbenchConnectionId: input.workbenchConnectionId,
      watchId: input.watchId,
      sessionId: input.sessionId,
      unit,
      nodeGeneration: this.options.nodeGeneration?.() ?? 'local-test-generation',
      ...(typeof input.workspaceId === 'string' ? { workspaceId: input.workspaceId } : {}),
      expiresAt: Date.now() + TTL_MS,
      ready: false,
      snapshotSent: false,
      pendingEvents: [],
      slotToken,
      timer: undefined as unknown as NodeJS.Timeout
    };
    lease.timer = this.leaseTimer(ownerKey);
    this.leases.set(ownerKey, lease);
    const observer = this.watches.get(lease.sessionId);
    if (observer !== undefined) observer.expiresAt = this.latestLeaseExpiry(lease.sessionId);
    void this.initializeLease(lease, projectInitialPage);
    return this.accepted(lease);
  }

  private executeUnwatch(input: Record<string, unknown>): unknown {
    if (
      typeof input.sessionId !== 'string' ||
      typeof input.watchId !== 'string' ||
      typeof input.workbenchConnectionId !== 'string' ||
      (input.position !== undefined &&
        input.position !== 'primary' &&
        input.position !== 'secondary')
    )
      throw new Error('SESSION_INVALID');
    const ownerKey = this.ownerKey(input);
    const lease = this.leases.get(ownerKey);
    if (lease?.watchId === input.watchId && lease.sessionId === input.sessionId)
      this.removeLease(ownerKey);
    return { stopped: true };
  }

  watch(session: NodeAgentSession): { readonly expiresAt: number } | undefined {
    const existing = this.watches.get(session.id);
    if (existing !== undefined) {
      existing.expiresAt = Date.now() + TTL_MS;
      return { expiresAt: existing.expiresAt };
    }
    const watch: NativeSessionWatch = {
      observation: new ConversationObservation(session, this.options),
      expiresAt: Date.now() + TTL_MS,
      refresh: undefined,
      sessionSignature: undefined,
      failures: 0,
      timer: undefined as unknown as NodeJS.Timeout
    };
    watch.timer = this.refreshTimer(session.id);
    this.watches.set(session.id, watch);
    return { expiresAt: watch.expiresAt };
  }

  emitRealtime(sessionId: string, event: WorkbenchEvent): boolean {
    const watch = this.watches.get(sessionId);
    const leases = [...this.leases.values()].filter((lease) => lease.sessionId === sessionId);
    const transition = watch?.observation.observe(event);
    if (transition !== undefined && watch !== undefined) {
      for (const lease of leases) lease.ready = false;
      void this.completeRefresh(sessionId, watch, transition, 'observation');
    }
    for (const lease of leases) {
      if (watch?.observation.snapshotPending === true) lease.ready = false;
      if (!lease.ready) {
        // Observations are useful only to an already watching page, never after a snapshot.
        if (
          event.category !== 'conversation' ||
          !isPlainRecord(event.payload) ||
          event.payload.performance === undefined
        )
          lease.pendingEvents.push(event);
      } else this.emitLeaseEvent(lease, event);
    }
    return leases.length > 0;
  }

  renew(session: NodeAgentSession): { readonly expiresAt: number } | undefined {
    const watch = this.watches.get(session.id);
    if (watch === undefined || watch.expiresAt <= Date.now()) {
      this.stop(session.id);
      return undefined;
    }
    watch.expiresAt = Date.now() + TTL_MS;
    return { expiresAt: watch.expiresAt };
  }

  stop(sessionId: string): void {
    const watch = this.watches.get(sessionId);
    if (watch === undefined) return;
    clearTimeout(watch.timer);
    watch.observation.close();
    this.watches.delete(sessionId);
  }

  invalidate(sessionId: string): void {
    this.stop(sessionId);
    for (const [ownerKey, lease] of this.leases) {
      if (lease.sessionId !== sessionId) continue;
      // Replace the lease object so pre-reset asynchronous reads cannot publish into it.
      const replacement: NativeSessionLease = {
        ...lease,
        ready: false,
        snapshotSent: false,
        historyReset: true,
        pendingEvents: []
      };
      this.leases.set(ownerKey, replacement);
      void this.initializeLease(replacement, this.options.projectInitialPage);
    }
  }

  clear(): void {
    for (const watch of this.watches.values()) {
      clearTimeout(watch.timer);
      watch.observation.close();
    }
    this.watches.clear();
    for (const ownerKey of [...this.leases.keys()]) this.removeLease(ownerKey);
  }

  has(sessionId: string): boolean {
    return this.watches.has(sessionId);
  }

  observes(
    sessionHash: string,
    connectionId: string,
    workspaceId: string,
    sessionId: string
  ): boolean {
    const slotOwnerKey = `${sessionHash}:${connectionId}`;
    return [...this.leases.values()].some(
      (lease) =>
        lease.slotOwnerKey === slotOwnerKey &&
        lease.ready &&
        lease.expiresAt > Date.now() &&
        lease.sessionId === sessionId &&
        lease.workspaceId === workspaceId &&
        this.sessionWatchSlots.owns(slotOwnerKey, lease.slotToken)
    );
  }

  isWatching(sessionId: string): boolean {
    return this.has(sessionId);
  }

  entry(sessionId: string): { readonly expiresAt: number } | undefined {
    return this.watches.get(sessionId);
  }

  get size(): number {
    return this.watches.size;
  }

  async refresh(
    sessionId: string,
    limit = 10,
    mode: 'observation' | 'initial' = 'observation'
  ): Promise<ConversationHistoryPage | undefined> {
    const watch = this.watches.get(sessionId);
    if (watch === undefined) return undefined;
    if (watch.refresh !== undefined) return watch.refresh;
    if (watch.expiresAt <= Date.now()) {
      this.stop(sessionId);
      return undefined;
    }
    return this.completeRefresh(
      sessionId,
      watch,
      this.readObservation(sessionId, watch, limit, mode),
      mode
    );
  }

  private async readObservation(
    sessionId: string,
    watch: NativeSessionWatch,
    limit: number,
    mode: 'observation' | 'initial'
  ): Promise<ConversationObservationUpdate | undefined> {
    const session = await this.options.resolve(sessionId);
    if (this.watches.get(sessionId) !== watch) return undefined;
    if (session === undefined || session.externalSessionId === null) {
      this.releaseSessionLeases(sessionId);
      return undefined;
    }
    watch.observation.session = session;
    return watch.observation.refresh(mode, limit);
  }

  private completeRefresh(
    sessionId: string,
    watch: NativeSessionWatch,
    read: Promise<ConversationObservationUpdate | undefined>,
    mode: 'observation' | 'initial'
  ): Promise<ConversationHistoryPage | undefined> {
    const current = () => this.watches.get(sessionId) === watch && watch.refresh === refresh;
    const refresh = read
      .then((update) => {
        if (!current() || update === undefined) return undefined;
        const presented = this.options.present(watch.observation.session);
        const sessionSignature = JSON.stringify(presented);
        if (sessionSignature !== watch.sessionSignature) {
          watch.sessionSignature = sessionSignature;
          if (mode === 'observation') this.options.emitSession(presented);
        }
        watch.failures = 0;
        this.deliverObservation(watch, update);
        return update.page;
      })
      .catch((error) => {
        if (!current()) return undefined;
        watch.failures += 1;
        this.options.log?.('session.watch.refresh.failed', {
          nodeId: this.options.nodeId?.() ?? 'local-test-node',
          sessionId,
          runner: watch.observation.session.runner,
          stage: watch.observation.stage,
          errorCode: diagnosticErrorCode(error, 'SESSION_WATCH_REFRESH_FAILED'),
          failureCount: watch.failures,
          terminal: watch.failures >= MAX_FAILURES
        });
        if (watch.failures >= MAX_FAILURES) this.failSession(sessionId);
        else this.releasePendingEvents(sessionId);
        return undefined;
      })
      .finally(() => {
        if (!current()) return;
        watch.refresh = undefined;
        clearTimeout(watch.timer);
        watch.timer = this.refreshTimer(sessionId);
      });
    watch.refresh = refresh;
    return refresh;
  }

  private deliverObservation(
    watch: NativeSessionWatch,
    update: ConversationObservationUpdate | undefined
  ): void {
    const session = watch.observation.session;
    if (this.watches.get(session.id) !== watch || update === undefined) return;
    if (update.snapshot) this.emitSnapshotToLeases(session, update.page, true);
    else if (update.handoff) this.releasePendingEvents(session.id);
    else if (update.changed) this.emitObservedPage(session, update.page);
  }

  private sessionHash(input: Record<string, unknown>): string {
    return typeof input.__workspaceWatchSessionHash === 'string'
      ? input.__workspaceWatchSessionHash
      : 'local-test';
  }

  private ownerKey(input: Record<string, unknown>): string {
    return `${this.slotOwnerKey(input)}:${input.position === 'secondary' ? 'secondary' : 'primary'}`;
  }

  private slotOwnerKey(input: Record<string, unknown>): string {
    return `${this.sessionHash(input)}:${input.workbenchConnectionId as string}`;
  }

  private accepted(lease: NativeSessionLease): unknown {
    return {
      accepted: true,
      watchId: lease.watchId,
      nodeGeneration: lease.nodeGeneration,
      expiresAt: lease.expiresAt
    };
  }

  private async initializeLease(
    lease: NativeSessionLease,
    projectInitialPage: NativeSessionWatchOptions['projectInitialPage']
  ): Promise<void> {
    let stage = 'resolve';
    try {
      const session = await this.options.resolve(lease.sessionId);
      if (session === undefined || session.externalSessionId === null)
        throw new Error('SESSION_NOT_FOUND');
      if (lease.workspaceId !== undefined && session.workspaceId !== lease.workspaceId)
        throw new Error('SESSION_WORKSPACE_MISMATCH');
      if (this.leases.get(lease.ownerKey) !== lease) return;
      lease.workspaceId = session.workspaceId;
      stage = 'initial_refresh';
      this.watch(session);
      const watch = this.watches.get(session.id);
      if (watch === undefined) return;
      watch.observation.session = session;
      // Every Turn contributes at least one Segment, including an empty Turn.
      const update = await watch.observation.initial(
        lease.unit === 'SEGMENT' ? INITIAL_SEGMENT_LIMIT : undefined
      );
      if (this.leases.get(lease.ownerKey) !== lease || this.watches.get(session.id) !== watch)
        return;
      if (update === undefined) throw new Error('NATIVE_TRANSCRIPT_UNAVAILABLE');
      watch.failures = 0;
      this.deliverObservation(watch, update);
      if (lease.snapshotSent) return;
      stage = 'project_snapshot';
      const page = update.page;
      const payload =
        lease.unit === 'SEGMENT'
          ? projectInitialPage!(session, page, 'SEGMENT', INITIAL_SEGMENT_LIMIT)
          : page;
      this.emitSnapshot(lease, session, payload);
      this.releaseSnapshotPendingEvents(lease, page);
      const hydration = watch.observation.hydrate();
      if (hydration !== undefined)
        void hydration
          .then((result) => this.deliverObservation(watch, result))
          .catch((error) => {
            if (this.watches.get(session.id) !== watch) return;
            this.options.log?.('session.watch.running-history.failed', {
              sessionId: session.id,
              errorCode: diagnosticErrorCode(error, 'SESSION_WATCH_HISTORY_FAILED')
            });
            this.releasePendingEvents(session.id);
          });
    } catch (error) {
      if (this.leases.get(lease.ownerKey) !== lease) return;
      const errorCode = diagnosticErrorCode(error, 'SESSION_WATCH_SNAPSHOT_FAILED');
      this.options.log?.('session.watch.initial.failed', {
        nodeId: this.options.nodeId?.() ?? 'local-test-node',
        sessionId: lease.sessionId,
        workspaceId: lease.workspaceId ?? 'unknown',
        workbenchConnectionId: lease.workbenchConnectionId,
        watchId: lease.watchId,
        stage,
        errorCode
      });
      this.options.emitWatchEvent?.({
        type: 'watch.failed',
        workbenchConnectionId: lease.workbenchConnectionId,
        watchType: 'session',
        watchId: lease.watchId,
        nodeGeneration: lease.nodeGeneration,
        nodeId: this.options.nodeId?.() ?? 'local-test-node',
        workspaceId: lease.workspaceId ?? 'unknown',
        sessionId: lease.sessionId,
        code: errorCode,
        message: 'Session watch snapshot failed.'
      });
      this.removeLease(lease.ownerKey);
    }
  }

  private removeLease(ownerKey: string): void {
    const lease = this.leases.get(ownerKey);
    if (lease === undefined) return;
    clearTimeout(lease.timer);
    this.leases.delete(ownerKey);
    this.sessionWatchSlots.release(lease.slotOwnerKey, lease.slotToken);
    const observer = this.watches.get(lease.sessionId);
    const nextExpiry = this.latestLeaseExpiry(lease.sessionId);
    if (nextExpiry === 0) this.stop(lease.sessionId);
    else if (observer !== undefined) observer.expiresAt = nextExpiry;
  }

  private emitLeaseEvent(lease: NativeSessionLease, event: WorkbenchEvent): void {
    this.options.emitWatchEvent?.({
      type: 'watch.session.event',
      workbenchConnectionId: lease.workbenchConnectionId,
      watchId: lease.watchId,
      nodeGeneration: lease.nodeGeneration,
      nodeId: this.options.nodeId?.() ?? 'local-test-node',
      workspaceId: lease.workspaceId ?? 'unknown',
      sessionId: lease.sessionId,
      expiresAt: lease.expiresAt,
      event
    });
  }

  private emitObservedPage(session: NodeAgentSession, page: ConversationHistoryPage): void {
    const leases = [...this.leases.values()].filter((lease) => lease.sessionId === session.id);
    if (leases.length === 0) {
      this.options.emitPage(session, page);
      return;
    }
    for (const lease of leases) {
      if (!lease.ready) continue;
      const payload =
        lease.unit === 'SEGMENT'
          ? this.options.projectInitialPage?.(session, page, 'SEGMENT', INITIAL_SEGMENT_LIMIT)
          : page;
      if (payload === undefined) continue;
      this.options.emitWatchEvent?.({
        type: 'watch.session.snapshot',
        workbenchConnectionId: lease.workbenchConnectionId,
        watchId: lease.watchId,
        nodeGeneration: lease.nodeGeneration,
        nodeId: this.options.nodeId?.() ?? 'local-test-node',
        workspaceId: session.workspaceId,
        sessionId: session.id,
        revision: 1,
        snapshotSequence: ++this.snapshotNumber,
        expiresAt: lease.expiresAt,
        payload
      });
    }
  }

  private emitSnapshotToLeases(
    session: NodeAgentSession,
    page: ConversationHistoryPage,
    releasePending: boolean
  ): void {
    for (const lease of [...this.leases.values()]) {
      if (lease.sessionId !== session.id) continue;
      if (!lease.snapshotSent) continue;
      const payload =
        lease.unit === 'SEGMENT'
          ? this.options.projectInitialPage?.(session, page, 'SEGMENT', INITIAL_SEGMENT_LIMIT)
          : page;
      if (payload === undefined) continue;
      this.emitSnapshot(lease, session, payload);
      if (!releasePending) continue;
      this.releaseSnapshotPendingEvents(lease, page);
    }
  }

  private emitSnapshot(
    lease: NativeSessionLease,
    session: NodeAgentSession,
    payload: unknown
  ): void {
    lease.snapshotSent = true;
    this.options.emitWatchEvent?.({
      type: 'watch.session.snapshot',
      ...(lease.historyReset ? { historyReset: true } : {}),
      workbenchConnectionId: lease.workbenchConnectionId,
      watchId: lease.watchId,
      nodeGeneration: lease.nodeGeneration,
      nodeId: this.options.nodeId?.() ?? 'local-test-node',
      workspaceId: session.workspaceId,
      sessionId: session.id,
      revision: 1,
      snapshotSequence: ++this.snapshotNumber,
      expiresAt: lease.expiresAt,
      payload
    });
    delete lease.historyReset;
  }

  private releasePendingEvents(sessionId: string): void {
    for (const lease of this.leases.values()) {
      if (lease.sessionId !== sessionId) continue;
      if (!lease.snapshotSent) continue;
      lease.ready = true;
      for (const event of lease.pendingEvents) this.emitLeaseEvent(lease, event);
      lease.pendingEvents.length = 0;
    }
  }

  private releaseSnapshotPendingEvents(
    lease: NativeSessionLease,
    page: ConversationHistoryPage
  ): void {
    const candidateSequence = page.snapshotSequence;
    const snapshotSequence =
      typeof candidateSequence === 'number' &&
      Number.isSafeInteger(candidateSequence) &&
      candidateSequence >= 0
        ? candidateSequence
        : undefined;
    lease.ready = true;
    for (const event of lease.pendingEvents)
      if (snapshotSequence === undefined || event.sequence > snapshotSequence)
        this.emitLeaseEvent(lease, event);
    lease.pendingEvents.length = 0;
  }

  private failSession(sessionId: string): void {
    for (const lease of [...this.leases.values()]) {
      if (lease.sessionId !== sessionId) continue;
      this.options.emitWatchEvent?.({
        type: 'watch.failed',
        workbenchConnectionId: lease.workbenchConnectionId,
        watchType: 'session',
        watchId: lease.watchId,
        nodeGeneration: lease.nodeGeneration,
        nodeId: this.options.nodeId?.() ?? 'local-test-node',
        workspaceId: lease.workspaceId ?? 'unknown',
        sessionId,
        code: 'NATIVE_TRANSCRIPT_UNAVAILABLE',
        message: 'Session watch snapshot failed.'
      });
      this.removeLease(lease.ownerKey);
    }
    this.stop(sessionId);
  }

  private releaseSessionLeases(sessionId: string): void {
    for (const lease of [...this.leases.values()])
      if (lease.sessionId === sessionId) this.removeLease(lease.ownerKey);
    this.stop(sessionId);
  }

  private leaseTimer(ownerKey: string): NodeJS.Timeout {
    const timer = setTimeout(() => this.removeLease(ownerKey), TTL_MS);
    timer.unref();
    return timer;
  }

  private latestLeaseExpiry(sessionId: string): number {
    let latest = 0;
    for (const lease of this.leases.values())
      if (lease.sessionId === sessionId) latest = Math.max(latest, lease.expiresAt);
    return latest;
  }

  private refreshTimer(sessionId: string): NodeJS.Timeout {
    const timer = setTimeout(() => void this.refresh(sessionId), INTERVAL_MS);
    timer.unref();
    return timer;
  }
}

function diagnosticErrorCode(error: unknown, fallback: string): string {
  const direct = safeErrorCode(error, '');
  if (direct.length > 0) return direct;
  if (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^[A-Z][A-Z0-9_]{0,127}$/.test(error.code)
  )
    return error.code;
  return fallback;
}

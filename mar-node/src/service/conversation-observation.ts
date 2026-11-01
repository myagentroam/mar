import type { WorkbenchEvent } from '@myagentroam/protocol';
import type { NodeAgentSession } from '../session/contracts.js';
import type { ConversationHistoryPage } from '../session/runner-native-session-parsers.js';
import { isPlainRecord } from '../util/records.js';
import {
  composeConversationRuntimePage,
  convergeConversationWatchPage
} from './conversation-history-service.js';

const INITIAL_TURN_LIMIT = 30;
const EMITTED_TURN_LIMIT = 10;

export interface ConversationObservationOptions {
  readonly managedActive: (session: NodeAgentSession) => boolean;
  readonly readPage: (session: NodeAgentSession, limit: number) => Promise<ConversationHistoryPage>;
  readonly readHistoryPage?: (
    session: NodeAgentSession,
    limit: number
  ) => Promise<ConversationHistoryPage>;
  readonly refreshActivity: (session: NodeAgentSession) => Promise<void>;
  readonly suspended?: (sessionId: string) => boolean;
}

export interface ConversationObservationUpdate {
  readonly page: ConversationHistoryPage;
  readonly changed: boolean;
  readonly handoff: boolean;
  readonly snapshot: boolean;
}

/** Conversation state shared by a Session's leases; no timers or transport ownership. */
export class ConversationObservation {
  private mode: 'HISTORY' | 'RUNNING' | 'CONVERGING';
  private page: ConversationHistoryPage | undefined;
  private observedPage: ConversationHistoryPage | undefined;
  private authority: ConversationHistoryPage['source'] | undefined;
  private signature: string | undefined;
  private runtimePage: ConversationHistoryPage | undefined;
  private runtimeRevision: number | undefined;
  private runtimeRead:
    { readonly revision: number; readonly read: Promise<ConversationHistoryPage> } | undefined;
  private historyRead: Promise<ConversationObservationUpdate | undefined> | undefined;
  private refreshRead: Promise<ConversationObservationUpdate | undefined> | undefined;
  private refreshMode: 'initial' | 'observation' | undefined;
  private refreshLimit = 0;
  private eventRevision = 0;
  private transitionGeneration = 0;
  private closed = false;
  private pendingRuntimeSnapshot = false;
  stage = 'read_page';

  constructor(
    public session: NodeAgentSession,
    private readonly options: ConversationObservationOptions
  ) {
    this.mode = options.managedActive(session) ? 'RUNNING' : 'HISTORY';
  }

  get snapshotPending(): boolean {
    return this.mode === 'RUNNING' && this.pendingRuntimeSnapshot;
  }

  close(): void {
    this.closed = true;
    this.page = this.observedPage = this.runtimePage = undefined;
  }

  async initial(limit = INITIAL_TURN_LIMIT): Promise<ConversationObservationUpdate | undefined> {
    if (this.closed) return undefined;
    if (this.options.managedActive(this.session)) {
      this.mode = 'RUNNING';
      return { page: await this.runningWindow(), changed: false, handoff: false, snapshot: false };
    }
    // A fresh initial must not join an older observation's smaller or stale window.
    while (
      this.refreshRead !== undefined &&
      (this.page !== undefined || this.refreshMode === 'observation' || this.refreshLimit < limit)
    )
      await this.refreshRead.catch(() => undefined);
    if (this.closed) return undefined;
    const joinedInitial = this.refreshRead !== undefined;
    // A narrow initial must not discard coverage already shared with existing subscribers.
    const initialLimit = Math.max(
      limit,
      Math.min(this.page?.turns.length ?? 0, EMITTED_TURN_LIMIT)
    );
    const update = await this.refresh('initial', initialLimit);
    if (this.closed || update === undefined) return undefined;
    if (this.options.managedActive(this.session)) {
      this.mode = 'RUNNING';
      return { ...update, page: await this.runningWindow(update.page) };
    }
    return joinedInitial ? { ...update, changed: false, handoff: false, snapshot: false } : update;
  }

  refresh(
    mode: 'initial' | 'observation' = 'observation',
    limit = EMITTED_TURN_LIMIT
  ): Promise<ConversationObservationUpdate | undefined> {
    if (this.refreshRead !== undefined) return this.refreshRead;
    const read = this.performRefresh(mode, limit).finally(() => {
      if (this.refreshRead === read) {
        this.refreshRead = undefined;
        this.refreshMode = undefined;
        this.refreshLimit = 0;
      }
    });
    this.refreshRead = read;
    this.refreshMode = mode;
    this.refreshLimit = limit;
    return read;
  }

  private async performRefresh(
    mode: 'initial' | 'observation',
    limit: number
  ): Promise<ConversationObservationUpdate | undefined> {
    if (this.closed || this.options.suspended?.(this.session.id) === true) return undefined;
    if (mode === 'observation' && this.options.managedActive(this.session)) return undefined;
    const historical = this.mode === 'HISTORY' && this.options.readHistoryPage !== undefined;
    this.stage = 'refresh_activity';
    await this.options.refreshActivity(this.session);
    if (this.closed || this.options.suspended?.(this.session.id) === true) return undefined;
    this.stage = 'read_page';
    const revision = this.eventRevision;
    const page = await (historical
      ? this.options.readHistoryPage!(this.session, limit)
      : this.options.readPage(this.session, limit));
    if (this.closed) return undefined;
    if (revision !== this.eventRevision) {
      if (mode !== 'initial') return undefined;
      const initial = convergeConversationWatchPage(
        this.page,
        this.observedPage,
        page,
        this.authority
      ).page;
      if (this.page === undefined && this.signature === undefined)
        this.signature = JSON.stringify({
          source: initial.source,
          turns: initial.turns.slice(-EMITTED_TURN_LIMIT)
        });
      return { page: initial, changed: false, handoff: false, snapshot: false };
    }
    this.stage = 'converge_page';
    const convergence = convergeConversationWatchPage(
      this.page,
      this.observedPage,
      page,
      this.authority
    );
    this.observedPage = { ...page, turns: page.turns.slice(-EMITTED_TURN_LIMIT) };
    this.authority = convergence.authority;
    const accepted = {
      ...convergence.page,
      turns: convergence.page.turns.slice(-(EMITTED_TURN_LIMIT + 1))
    };
    const handoff = this.mode === 'CONVERGING' && !this.options.managedActive(this.session);
    if (handoff) {
      this.mode = 'HISTORY';
      this.runtimePage = undefined;
      this.runtimeRevision = undefined;
    }
    const signature = JSON.stringify({
      source: accepted.source,
      turns: accepted.turns.slice(-EMITTED_TURN_LIMIT)
    });
    // Expanding a bounded initial window with an unchanged older prefix is not a live update.
    const previousCount = this.page?.turns.length ?? 0;
    const comparison =
      previousCount > 0 && previousCount < EMITTED_TURN_LIMIT
        ? JSON.stringify({ source: accepted.source, turns: accepted.turns.slice(-previousCount) })
        : signature;
    const changed = comparison !== this.signature;
    this.signature = signature;
    // Keep coverage metadata current even when the visible content did not change.
    this.page = accepted;
    return {
      page: mode === 'initial' ? convergence.page : accepted,
      changed,
      handoff,
      snapshot: handoff && (changed || accepted.source !== 'runtime')
    };
  }

  /** Return work only for a domain transition; the Watch pauses delivery, not the Run. */
  observe(event: WorkbenchEvent): Promise<ConversationObservationUpdate | undefined> | undefined {
    this.eventRevision = event.sequence;
    const activity = sessionActivity(event);
    if (activity === 'RUNNING' && this.mode !== 'RUNNING') {
      this.mode = 'RUNNING';
      const generation = ++this.transitionGeneration;
      return this.runtimeSnapshot(generation);
    }
    if (activity === 'IDLE' && this.mode === 'RUNNING') {
      this.mode = 'CONVERGING';
      const generation = ++this.transitionGeneration;
      return this.convergeHistory(generation);
    }
    return undefined;
  }

  hydrate(): Promise<ConversationObservationUpdate | undefined> | undefined {
    if (
      this.closed ||
      this.mode !== 'RUNNING' ||
      this.page !== undefined ||
      this.options.readHistoryPage === undefined
    )
      return undefined;
    if (this.historyRead !== undefined) return undefined;
    const read = this.hydrateHistory().finally(() => {
      if (this.historyRead === read) this.historyRead = undefined;
    });
    this.historyRead = read;
    return read;
  }

  private async hydrateHistory(): Promise<ConversationObservationUpdate | undefined> {
    const generation = this.transitionGeneration;
    try {
      const page = await this.options.readHistoryPage!(this.session, INITIAL_TURN_LIMIT);
      if (this.closed || this.mode !== 'RUNNING' || this.transitionGeneration !== generation)
        return undefined;
      this.page = page;
      this.authority = page.source;
      return await this.runtimeSnapshot(generation);
    } catch (error) {
      if (this.closed || this.transitionGeneration !== generation) return undefined;
      throw error;
    }
  }

  private async convergeHistory(
    generation: number
  ): Promise<ConversationObservationUpdate | undefined> {
    await this.historyRead?.catch(() => undefined);
    // Let the current event enter each lease's buffer before completing a handoff.
    if (this.closed || this.mode !== 'CONVERGING' || this.transitionGeneration !== generation)
      return undefined;
    return this.refresh('observation', INITIAL_TURN_LIMIT);
  }

  private async runningWindow(history = this.page): Promise<ConversationHistoryPage> {
    return composeConversationRuntimePage(history, await this.readRuntime());
  }

  private async runtimeSnapshot(
    generation: number
  ): Promise<ConversationObservationUpdate | undefined> {
    this.pendingRuntimeSnapshot = true;
    try {
      const page = await this.runningWindow();
      if (this.closed || this.mode !== 'RUNNING' || this.transitionGeneration !== generation)
        return undefined;
      return { page, changed: true, handoff: true, snapshot: true };
    } finally {
      if (this.transitionGeneration === generation) this.pendingRuntimeSnapshot = false;
    }
  }

  private readRuntime(): Promise<ConversationHistoryPage> {
    if (this.runtimePage !== undefined && this.runtimeRevision === this.eventRevision)
      return Promise.resolve(this.runtimePage);
    if (this.runtimeRead?.revision === this.eventRevision) return this.runtimeRead.read;
    const revision = this.eventRevision;
    const read = this.options
      .readPage(this.session, INITIAL_TURN_LIMIT)
      .then((page) => {
        if (!this.closed && this.runtimeRead?.read === read) {
          this.runtimePage = page;
          this.runtimeRevision = revision;
        }
        return page;
      })
      .finally(() => {
        if (this.runtimeRead?.read === read) this.runtimeRead = undefined;
      });
    this.runtimeRead = { revision, read };
    return read;
  }
}

function sessionActivity(event: WorkbenchEvent): 'RUNNING' | 'IDLE' | undefined {
  if (!isPlainRecord(event.payload)) return undefined;
  if (event.category === 'run' && isPlainRecord(event.payload.run)) {
    const status = event.payload.run.status;
    return status === 'STARTING' || status === 'RUNNING' || status === 'CANCELLING'
      ? 'RUNNING'
      : undefined;
  }
  if (event.category !== 'session' || !isPlainRecord(event.payload.session)) return undefined;
  const activity = event.payload.session.activity;
  return typeof activity === 'string'
    ? activity === 'MANAGED_ACTIVE'
      ? 'RUNNING'
      : 'IDLE'
    : undefined;
}

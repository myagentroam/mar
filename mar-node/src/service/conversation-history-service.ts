import type { NodeCapabilities } from '@myagentroam/protocol';
import { projectConversationWorkProcesses } from './conversation-work-process.js';
import type { NodeAgentSession } from '../database.js';
import type { NodeConversationTurn } from '../runtime-model.js';
import { discoverNativeSessions, readNativeSession } from '../native-session-history.js';
import type { NodeRuntimeState } from '../runtime-state.js';
import type { RunnerRegistry } from '../runner/runner-registry.js';
import type { RunnerConversationHistoryPage } from '../runner/abstract-runner.js';
import {
  nativeConversationPage,
  type ConversationHistoryPage
} from '../util/runner-native-session-parsers.js';
import { isPlainRecord } from '../util/node-operation-parsers.js';
import { conversationClientMessageId } from '../util/conversation-identity.js';
import type { RunAttachmentService } from './run-attachment-service.js';
import type { ExternalSessionActivationState } from './session-domain-state.js';
import { nodeLog } from '../operational.js';

export function hasManagedActiveRun(runtime: NodeRuntimeState, session: NodeAgentSession): boolean {
  return (
    session.nativeControl === 'MAR_MANAGED' &&
    runtime
      .listRunsForSession(session.id)
      .some(
        (run) =>
          run.status === 'STARTING' || run.status === 'RUNNING' || run.status === 'CANCELLING'
      )
  );
}

export function convergeConversationWatchPage(
  previous: ConversationHistoryPage | undefined,
  previousObserved: ConversationHistoryPage | undefined,
  next: ConversationHistoryPage,
  previousAuthority: unknown
): {
  readonly page: ConversationHistoryPage;
  readonly authority: ConversationHistoryPage['source'];
} {
  const authority = isConversationHistorySource(previousAuthority)
    ? previousAuthority
    : previous?.source;
  if (next.deferredOlderHistory === true && previous !== undefined)
    return {
      page: composeConversationRuntimePage(previous, next),
      authority: authority ?? next.source
    };
  // A Runner history read can lag a Run that the Watch has already delivered. Keep the
  // unconfirmed Runtime tail until the history includes that Turn; source priority alone
  // does not establish that the returned window contains the latest conversation.
  if (
    previous?.source === 'runtime' &&
    previous.turns.length > 0 &&
    next.source !== 'runtime' &&
    (authority === undefined || sourceRank(next.source) >= sourceRank(authority))
  ) {
    const boundary = previous.turns.findLastIndex((turn) =>
      next.turns.some((candidate) => sameConversationTurn(candidate, turn))
    );
    if (boundary < 0) return { page: previous, authority: next.source };
    const tail = previous.turns
      .slice(boundary + 1)
      .filter((turn) => !next.turns.some((candidate) => sameConversationTurn(candidate, turn)));
    if (tail.length > 0)
      return {
        page: {
          ...next,
          source: 'runtime',
          snapshotSequence: previous.snapshotSequence,
          turns: [...next.turns, ...tail]
        },
        authority: next.source
      };
  }
  if (
    previous === undefined ||
    authority === undefined ||
    sourceRank(next.source) >= sourceRank(authority)
  )
    return { page: next, authority: next.source };
  if (previous.turns.length === 0) return { page: next, authority };
  const boundary = next.turns.findLastIndex((turn) =>
    previous.turns.some((candidate) => sameConversationTurn(candidate, turn))
  );
  const observedBoundary =
    boundary >= 0 || previousObserved === undefined
      ? -1
      : next.turns.findLastIndex((turn) =>
          previousObserved.turns.some((candidate) => sameConversationTurn(candidate, turn))
        );
  const safeBoundary = Math.max(boundary, observedBoundary);
  if (safeBoundary < 0) return { page: previous, authority };
  const additions = next.turns
    .slice(safeBoundary + 1)
    .filter((turn) => !previous.turns.some((candidate) => sameConversationTurn(candidate, turn)));
  if (additions.length === 0) return { page: previous, authority };
  return {
    page: {
      ...previous,
      source: next.source,
      snapshotSequence: Math.max(previous.snapshotSequence, next.snapshotSequence),
      readAt: next.readAt,
      latestVisibleAt: next.latestVisibleAt ?? previous.latestVisibleAt,
      turns: [...previous.turns, ...additions]
    },
    authority
  };
}

export function composeConversationRuntimePage(
  history: ConversationHistoryPage | undefined,
  runtime: ConversationHistoryPage
): ConversationHistoryPage {
  if (history === undefined) return runtime;
  const turns = [...history.turns];
  for (const turn of runtime.turns) {
    const index = turns.findIndex((candidate) => sameConversationTurn(candidate, turn));
    if (index < 0) insertConversationTurnChronologically(turns, turn);
    else turns[index] = turn;
  }
  return { ...runtime, nextCursor: history.nextCursor, turns };
}

function insertConversationTurnChronologically(
  turns: NodeConversationTurn[],
  turn: NodeConversationTurn
): void {
  const time = earliestTurnActivityAt(turn);
  if (time === 0) {
    turns.push(turn);
    return;
  }
  const next = turns.findIndex((candidate) => {
    const candidateTime = earliestTurnActivityAt(candidate);
    return candidateTime > 0 && candidateTime > time;
  });
  if (next < 0) turns.push(turn);
  else turns.splice(next, 0, turn);
}

function earliestTurnActivityAt(turn: NodeConversationTurn): number {
  const values = [
    turn.startedAt,
    turn.completedAt,
    ...turn.items.map((item) => item.startedAt)
  ].filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0
  );
  return values.length === 0 ? 0 : Math.min(...values);
}

function isConversationHistorySource(value: unknown): value is ConversationHistoryPage['source'] {
  return value === 'official' || value === 'native' || value === 'runtime';
}

interface ConversationHistoryServiceOptions {
  readonly runtime: NodeRuntimeState;
  readonly runners: RunnerRegistry;
  readonly capabilities: () => NodeCapabilities;
  readonly attachments: RunAttachmentService;
  readonly snapshotSequence: () => number;
  readonly hasManagedActiveRun: (session: NodeAgentSession) => boolean;
  readonly setExternalActivity: (
    sessionId: string,
    activity: ExternalSessionActivationState
  ) => void;
}

export class ConversationHistoryService {
  constructor(private readonly options: ConversationHistoryServiceOptions) {}

  async read(
    session: NodeAgentSession,
    input: { readonly cursor?: string; readonly limit?: number }
  ): Promise<ConversationHistoryPage> {
    const snapshotSequence = this.options.snapshotSequence();
    const readAt = Date.now();
    const idleCursor = decodeIdleMarHistoryCursor(input.cursor, session.id);
    if (idleCursor !== undefined) {
      if (session.runner !== 'mar-agent') throw new Error('EVENT_CURSOR_INVALID');
      return this.readIdleMarAgentHistory(session, input, snapshotSequence, readAt);
    }
    const activeCursor = decodeActiveHistoryCursor(input.cursor, session.id);
    if (activeCursor !== undefined || this.options.hasManagedActiveRun(session))
      return this.readManagedRuntime(session, input, activeCursor, snapshotSequence, readAt);
    return this.readHistory(session, input, snapshotSequence, readAt);
  }

  async readHistoryPage(
    session: NodeAgentSession,
    input: { readonly cursor?: string; readonly limit?: number }
  ): Promise<ConversationHistoryPage> {
    if (input.cursor !== undefined) return this.read(session, input);
    if (this.options.hasManagedActiveRun(session) && this.hasManagedRuntimeHistory(session)) {
      const runtimeTurns = this.options.runtime.listConversationTurns({
        sessionId: session.id,
        limit: 500
      }).turns;
      const olderCursor: ActiveHistoryCursor = {
        sessionId: session.id,
        stage: 'OFFICIAL',
        beforeAt: oldestTurnActivityAt(runtimeTurns),
        cursor: null
      };
      return this.readManagedRuntime(
        session,
        input,
        olderCursor,
        this.options.snapshotSequence(),
        Date.now()
      );
    }
    return this.readHistory(session, input, this.options.snapshotSequence(), Date.now());
  }

  private hasManagedRuntimeHistory(session: NodeAgentSession): boolean {
    return (
      session.runner === 'mar-agent' &&
      session.nativeControl === 'MAR_MANAGED' &&
      this.options.runtime.getAgentSession(session.id) !== undefined &&
      this.options.runtime.listConversationTurns({ sessionId: session.id, limit: 1 }).turns.length >
        0
    );
  }

  private async readHistory(
    session: NodeAgentSession,
    input: { readonly cursor?: string; readonly limit?: number },
    snapshotSequence: number,
    readAt: number
  ): Promise<ConversationHistoryPage> {
    if (session.runner === 'mar-agent' && session.nativeControl === 'MAR_MANAGED')
      return this.readIdleMarAgentHistory(session, input, snapshotSequence, readAt);
    let selected: Awaited<ReturnType<ConversationHistoryService['readRunnerHistory']>>;
    try {
      selected = await this.readRunnerHistory(session, input);
    } catch (error) {
      // An unavailable persistent source must not erase accepted live output.
      // Older-page and external-session errors remain visible to the caller.
      if (
        input.cursor !== undefined ||
        this.options.runtime.getAgentSession(session.id) === undefined
      )
        throw error;
      const runtimePage = this.options.runtime.listConversationTurns({
        sessionId: session.id,
        ...input
      });
      if (runtimePage.turns.length === 0) throw error;
      return this.page(runtimePage.nextCursor, runtimePage.turns, {
        snapshotSequence,
        source: 'runtime',
        readAt
      });
    }
    if (selected.page?.source === 'native')
      return this.page(selected.page.nextCursor, selected.page.turns, {
        snapshotSequence,
        source: 'native',
        readAt
      });
    let official = selected.page?.source === 'official' ? selected.page : undefined;
    if (official !== undefined) {
      const limit = Math.min(Math.max(input.limit ?? 30, 1), 500);
      const runtimeTurns =
        this.options.runtime.getAgentSession(session.id) === undefined
          ? []
          : this.options.runtime.listConversationTurns({ sessionId: session.id, limit: 500 }).turns;
      const initialOfficialTurns = official.turns;
      const lastRepresentedRuntimeIndex = runtimeTurns.findLastIndex((turn) =>
        initialOfficialTurns.some((officialTurn) => sameConversationTurn(officialTurn, turn))
      );
      const officialHasTurns = initialOfficialTurns.length > 0;
      const absentLocalTurns = runtimeTurns.filter(
        (turn, index) =>
          !initialOfficialTurns.some((officialTurn) => sameConversationTurn(officialTurn, turn)) &&
          (!officialHasTurns || index > lastRepresentedRuntimeIndex)
      );
      const missingLocalTurns = absentLocalTurns.slice(-limit);
      if (
        input.cursor === undefined &&
        missingLocalTurns.length > 0 &&
        official.turns.length + missingLocalTurns.length > limit
      ) {
        const reserved = Math.min(missingLocalTurns.length, Math.max(0, limit - 1));
        const narrowed = await this.readOfficial(session, { ...input, limit: limit - reserved });
        if (narrowed !== undefined) official = { ...narrowed, source: 'official' };
      }
      const officialTurns = official.turns;
      const runtimeTurnsByOfficialId = new Map<string, NodeConversationTurn>();
      const runtimeSupplementalItemsByOfficialId = new Map<string, NodeConversationTurn['items']>();
      for (const officialTurn of officialTurns) {
        const runtimeTurn = runtimeTurns.find((candidate) =>
          sameConversationTurn(officialTurn, candidate)
        );
        if (runtimeTurn === undefined) continue;
        runtimeTurnsByOfficialId.set(officialTurn.id, runtimeTurn);
        const runtimeSupplementalItems = runtimeTurn.items.filter(
          (item) =>
            item.kind === 'error' ||
            item.kind === 'approval_request' ||
            (item.kind === 'user_input_request' && item.status === 'PENDING')
        );
        if (runtimeSupplementalItems.length > 0)
          runtimeSupplementalItemsByOfficialId.set(officialTurn.id, runtimeSupplementalItems);
      }
      const availableLocalSlots = Math.max(0, limit - officialTurns.length);
      const localCandidates = input.cursor === undefined ? missingLocalTurns : [];
      const localTurns =
        availableLocalSlots === 0 ? [] : localCandidates.slice(-availableLocalSlots);
      const localInteractionIds = new Set([
        ...localTurns.flatMap((turn) =>
          turn.items.flatMap((item) => {
            if (!isPlainRecord(item.payload)) return [];
            const interactionId =
              item.kind === 'approval_request'
                ? item.payload.approvalId
                : item.kind === 'user_input_request'
                  ? item.payload.requestId
                  : undefined;
            return typeof interactionId === 'string' ? [interactionId] : [];
          })
        ),
        ...[...runtimeSupplementalItemsByOfficialId.values()].flatMap((items) =>
          items.flatMap((item) => {
            if (!isPlainRecord(item.payload)) return [];
            const interactionId =
              item.kind === 'approval_request' ? item.payload.approvalId : item.payload.requestId;
            return typeof interactionId === 'string' ? [interactionId] : [];
          })
        )
      ]);
      const turns = [
        ...officialTurns
          .map((turn) => {
            const runtimeTurn = runtimeTurnsByOfficialId.get(turn.id);
            const hydratedTurn =
              runtimeTurn === undefined
                ? turn
                : mergeRuntimeUserMetadata(turn, runtimeTurn, this.options.attachments);
            const runtimeSupplementalItems =
              runtimeSupplementalItemsByOfficialId.get(turn.id) ?? [];
            const items = [
              ...hydratedTurn.items.filter(
                (item) =>
                  (item.kind !== 'approval_request' && item.kind !== 'user_input_request') ||
                  !isPlainRecord(item.payload) ||
                  !localInteractionIds.has(
                    item.kind === 'approval_request'
                      ? String(item.payload.approvalId ?? '')
                      : String(item.payload.requestId ?? '')
                  )
              ),
              ...runtimeSupplementalItems.filter(
                (item) =>
                  !hydratedTurn.items.some(
                    (officialItem) =>
                      officialItem.id === item.id ||
                      (officialItem.kind === 'error' && item.kind === 'error')
                  )
              )
            ];
            return {
              ...hydratedTurn,
              status: runtimeSupplementalItems.some((item) => item.kind === 'error')
                ? 'FAILED'
                : turn.status,
              items
            };
          })
          .filter((turn) => turn.items.length > 0),
        ...localTurns
      ];
      return this.page(official.nextCursor, turns, {
        snapshotSequence,
        source: 'official',
        readAt
      });
    }
    if (session.externalSessionId !== null && selected.incompleteNative) {
      const runtimePage = this.options.runtime.listConversationTurns({
        sessionId: session.id,
        ...input
      });
      if (runtimePage.turns.length === 0) throw new Error('NATIVE_TRANSCRIPT_INCOMPLETE');
      return this.page(runtimePage.nextCursor, runtimePage.turns, {
        snapshotSequence,
        source: 'runtime',
        readAt
      });
    }
    const page =
      this.options.runtime.getAgentSession(session.id) === undefined
        ? { turns: [], nextCursor: null }
        : this.options.runtime.listConversationTurns({ sessionId: session.id, ...input });
    if (
      session.externalSessionId !== null &&
      session.nativeControl === 'EXTERNAL' &&
      page.turns.length === 0
    )
      throw new Error('NATIVE_TRANSCRIPT_UNAVAILABLE');
    return this.page(page.nextCursor, page.turns, { snapshotSequence, source: 'runtime', readAt });
  }

  private async readIdleMarAgentHistory(
    session: NodeAgentSession,
    input: { readonly cursor?: string; readonly limit?: number },
    snapshotSequence: number,
    readAt: number
  ): Promise<ConversationHistoryPage> {
    const limit = Math.min(Math.max(input.limit ?? 30, 1), 500);
    const cursor = decodeIdleMarHistoryCursor(input.cursor, session.id);
    const runtime =
      this.options.runtime.getAgentSession(session.id) === undefined
        ? []
        : this.options.runtime.listConversationTurns({ sessionId: session.id, limit: 500 }).turns;
    const before = (turn: NodeConversationTurn) => {
      const at = earliestTurnActivityAt(turn);
      return cursor === undefined || at <= cursor.beforeAt;
    };
    let nativeCursor = cursor === undefined ? input.cursor : (cursor.nativeCursor ?? undefined);
    let exhausted = false;
    let locatingBoundary = cursor !== undefined;
    const native: NodeConversationTurn[] = [];
    let merged: NodeConversationTurn[] = [];
    let lastInputCursor = nativeCursor;
    const visited = new Set<string>();
    if (nativeCursor !== undefined) visited.add(nativeCursor);
    try {
      for (;;) {
        // Keep the containing SDK page as the anchor: a local-only failure has no
        // native cursor, and equal timestamps require a stable Turn boundary.
        lastInputCursor = nativeCursor;
        const page = await this.readOfficial(session, {
          limit,
          ...(nativeCursor === undefined ? {} : { cursor: nativeCursor })
        });
        if (page === undefined) throw new Error('NATIVE_TRANSCRIPT_UNAVAILABLE');
        native.unshift(...page.turns);
        exhausted = page.nextCursor === null;
        const projected = native.map((turn) => {
          const local = runtime.find((candidate) => sameConversationTurn(turn, candidate));
          return local === undefined ? turn : mergeMarAgentRuntimeTurn(turn, local);
        });
        merged = projected.filter(before);
        const oldestNative = oldestTurnActivityAt(native);
        for (const turn of runtime) {
          if (
            before(turn) &&
            (exhausted || earliestTurnActivityAt(turn) >= oldestNative) &&
            !native.some((candidate) => sameConversationTurn(candidate, turn))
          )
            insertConversationTurnChronologically(merged, turn);
        }
        if (cursor !== undefined) {
          const boundary = merged.findIndex(
            (turn) => conversationTurnKey(turn) === cursor.beforeTurnKey
          );
          if (boundary >= 0) {
            merged = merged.slice(0, boundary);
            locatingBoundary = false;
          }
        }
        if ((!locatingBoundary && merged.length >= limit) || exhausted) break;
        if (visited.has(page.nextCursor!)) throw new Error('EVENT_CURSOR_INVALID');
        visited.add(page.nextCursor!);
        nativeCursor = page.nextCursor!;
      }
    } catch (error) {
      // Never replace a visible local failure with an empty SDK snapshot.
      if (input.cursor !== undefined || runtime.length === 0) throw error;
      return this.readManagedActive(session, input, undefined, snapshotSequence, readAt);
    }
    if (locatingBoundary) throw new Error('EVENT_CURSOR_INVALID');
    const turns = merged.slice(-limit);
    const nextCursor =
      turns.length > 0 && (merged.length > turns.length || !exhausted)
        ? encodeIdleMarHistoryCursor({
            sessionId: session.id,
            beforeAt: earliestTurnActivityAt(turns[0]!),
            beforeTurnKey: conversationTurnKey(turns[0]!),
            nativeCursor: lastInputCursor ?? null
          })
        : null;
    return this.page(nextCursor, turns, { snapshotSequence, source: 'official', readAt });
  }

  private async readRunnerHistory(
    session: NodeAgentSession,
    input: { readonly cursor?: string; readonly limit?: number }
  ): Promise<{
    readonly page: RunnerConversationHistoryPage | undefined;
    readonly incompleteNative: boolean;
  }> {
    const runner = this.options.runners.require(session.runner);
    let incompleteNative = false;
    const page = await runner.readConversationHistory({
      native: async () => {
        const startedAt = performance.now();
        let history;
        try {
          history = await this.readNative(session, input.cursor, input.limit);
        } catch {
          return undefined;
        } finally {
          const durationMs = Math.round(performance.now() - startedAt);
          if (durationMs >= 250)
            nodeLog('native.session.history.native-read.completed', {
              runner: session.runner,
              sessionId: session.id,
              durationMs
            });
        }
        if (history === undefined) return undefined;
        if (
          history.truncated === true &&
          (!runner.acceptsTruncatedNativeHistory() || history.items.length === 0)
        ) {
          incompleteNative = true;
          return undefined;
        }
        const runtimeTurns =
          this.options.runtime.getAgentSession(session.id) === undefined
            ? []
            : this.options.runtime.listConversationTurns({ sessionId: session.id, limit: 500 })
                .turns;
        const native = nativeConversationPage(
          session,
          history,
          history.cursorReset === true
            ? input.limit === undefined
              ? {}
              : { limit: input.limit }
            : input,
          runtimeTurns,
          (images) => this.options.attachments.registerNative(session, images)
        );
        return native;
      },
      session,
      official: () => this.readOfficial(session, input)
    });
    return { page, incompleteNative };
  }

  private async readManagedActive(
    session: NodeAgentSession,
    input: { readonly cursor?: string; readonly limit?: number },
    cursor: ActiveHistoryCursor | undefined,
    snapshotSequence: number,
    readAt: number
  ): Promise<ConversationHistoryPage> {
    const limit = Math.min(Math.max(input.limit ?? 30, 1), 500);
    const runtimeTurns = this.options.runtime.listConversationTurns({
      sessionId: session.id,
      limit: 500
    }).turns;
    const beforeAt = cursor?.beforeAt ?? oldestTurnActivityAt(runtimeTurns);
    if (cursor?.stage === 'OFFICIAL') {
      const selected = await this.readRunnerHistory(session, {
        ...(cursor.cursor === null ? {} : { cursor: cursor.cursor }),
        limit
      });
      const history = selected.page;
      if (history === undefined)
        return this.page(null, [], { snapshotSequence, source: 'runtime', readAt });
      const hydratedTurns = history.turns;
      const turns = hydratedTurns.filter((turn) => latestTurnActivityAt(turn) < beforeAt);
      return this.page(
        history.nextCursor === null
          ? null
          : encodeActiveHistoryCursor({
              sessionId: session.id,
              stage: 'OFFICIAL',
              beforeAt,
              cursor: history.nextCursor
            }),
        turns,
        { snapshotSequence, source: history.source, readAt }
      );
    }
    const runtimePage = this.options.runtime.listConversationTurns({
      sessionId: session.id,
      ...(cursor?.cursor === null || cursor === undefined ? {} : { cursor: cursor.cursor }),
      limit
    });
    const nextCursor =
      runtimePage.nextCursor !== null
        ? encodeActiveHistoryCursor({
            sessionId: session.id,
            stage: 'RUNTIME',
            beforeAt,
            cursor: runtimePage.nextCursor
          })
        : session.externalSessionId === null || runtimePage.historyComplete === true
          ? null
          : encodeActiveHistoryCursor({
              sessionId: session.id,
              stage: 'OFFICIAL',
              beforeAt,
              cursor: null
            });
    return this.page(nextCursor, runtimePage.turns, {
      snapshotSequence,
      source: 'runtime',
      readAt,
      deferredOlderHistory: true
    });
  }

  private async readManagedRuntime(
    session: NodeAgentSession,
    input: { readonly cursor?: string; readonly limit?: number },
    cursor: ActiveHistoryCursor | undefined,
    snapshotSequence: number,
    readAt: number
  ): Promise<ConversationHistoryPage> {
    const page = await this.readManagedActive(session, input, cursor, snapshotSequence, readAt);
    try {
      const supplements = await this.options.runners
        .require(session.runner)
        .readConversationRewind({
          session,
          turns: page.turns,
          managedActive: this.options.hasManagedActiveRun(session),
          firstPage: input.cursor === undefined,
          readHistory: async (historyInput) =>
            (await this.readRunnerHistory(session, historyInput)).page
        });
      if (supplements.size === 0) return page;
      return {
        ...page,
        turns: page.turns.map((turn) => {
          const rewind = supplements.get(turn.id);
          return turn.rewind !== undefined || rewind === undefined ? turn : { ...turn, rewind };
        })
      };
    } catch {
      return page;
    }
  }

  async refreshExternalActivity(session: NodeAgentSession): Promise<void> {
    const runner = this.options.runners.require(session.runner);
    if (!runner.available(this.options.capabilities())) {
      this.options.setExternalActivity(session.id, 'IDLE');
      return;
    }
    const activity = await runner.readExternalActivity(session);
    if (activity !== undefined) this.options.setExternalActivity(session.id, activity);
  }

  async readNative(session: NodeAgentSession, cursor?: string, limit = 30) {
    if (session.externalSessionId === null) return undefined;
    const page = nativeHistoryPageCursor(cursor, session.id);
    const current = await readNativeSession(
      session.runner,
      session.cwd,
      session.externalSessionId,
      page,
      limit
    );
    if (current !== undefined) return current;
    await discoverNativeSessions(session.runner, session.cwd);
    return readNativeSession(session.runner, session.cwd, session.externalSessionId, page, limit);
  }

  async readOfficial(
    session: NodeAgentSession,
    input: { readonly cursor?: string; readonly limit?: number }
  ) {
    const runner = this.options.runners.require(session.runner);
    if (session.externalSessionId === null || !runner.available(this.options.capabilities()))
      return undefined;
    const startedAt = performance.now();
    try {
      return await runner.readOfficialConversation(
        session,
        input,
        (nativeTurnId) => this.managedRunnerTurn(session, nativeTurnId),
        (images) => this.options.attachments.registerNative(session, images)
      );
    } finally {
      const durationMs = Math.round(performance.now() - startedAt);
      if (durationMs >= 250)
        nodeLog('native.session.history.official-read.completed', {
          runner: session.runner,
          sessionId: session.id,
          durationMs
        });
    }
  }

  private managedRunnerTurn(
    session: NodeAgentSession,
    nativeTurnId: string
  ): NodeConversationTurn | undefined {
    const executionId = this.options.runners
      .require(session.runner)
      .managedRunForNativeTurn(nativeTurnId);
    if (executionId === undefined) return undefined;
    return this.options.runtime.conversationTurnForExecution(executionId);
  }

  private page(
    nextCursor: string | null,
    turns: readonly NodeConversationTurn[],
    metadata: Omit<ConversationHistoryPage, 'turns' | 'nextCursor' | 'latestVisibleAt'>
  ): ConversationHistoryPage {
    return {
      ...metadata,
      turns: turns.map(projectConversationWorkProcesses),
      nextCursor,
      latestVisibleAt: Math.max(
        0,
        ...turns.map((turn) => Math.max(turn.startedAt ?? 0, turn.completedAt ?? 0))
      )
    };
  }
}

function nativeHistoryPageCursor(
  cursor: string | undefined,
  sessionId: string
):
  | {
      readonly snapshotEnd: number;
      readonly nextEnd: number;
      readonly fileAnchor: string;
      readonly anchorBytes: number;
      readonly readLimit?: number;
    }
  | undefined {
  if (cursor === undefined) return undefined;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      sessionId?: unknown;
      snapshotEnd?: unknown;
      nextEnd?: unknown;
      fileAnchor?: unknown;
      anchorBytes?: unknown;
      readLimit?: unknown;
    };
    return value.sessionId === sessionId &&
      Number.isInteger(value.snapshotEnd) &&
      Number.isInteger(value.nextEnd) &&
      Number.isInteger(value.anchorBytes) &&
      (value.snapshotEnd as number) >= 0 &&
      (value.nextEnd as number) >= 0 &&
      (value.nextEnd as number) <= (value.snapshotEnd as number) &&
      (value.anchorBytes as number) >= 0 &&
      (value.anchorBytes as number) <= (value.snapshotEnd as number) &&
      (value.readLimit === undefined ||
        (Number.isInteger(value.readLimit) &&
          (value.readLimit as number) >= 1 &&
          (value.readLimit as number) <= 500)) &&
      typeof value.fileAnchor === 'string'
      ? {
          snapshotEnd: value.snapshotEnd as number,
          nextEnd: value.nextEnd as number,
          fileAnchor: value.fileAnchor,
          anchorBytes: value.anchorBytes as number,
          ...(value.readLimit === undefined ? {} : { readLimit: value.readLimit as number })
        }
      : undefined;
  } catch {
    return undefined;
  }
}

interface IdleMarHistoryCursor {
  readonly sessionId: string;
  readonly beforeAt: number;
  readonly beforeTurnKey: string;
  readonly nativeCursor: string | null;
}

const IDLE_MAR_HISTORY_CURSOR_PREFIX = 'mar-idle-history:1:';

function encodeIdleMarHistoryCursor(cursor: IdleMarHistoryCursor): string {
  return `${IDLE_MAR_HISTORY_CURSOR_PREFIX}${Buffer.from(JSON.stringify(cursor)).toString('base64url')}`;
}

function decodeIdleMarHistoryCursor(
  value: string | undefined,
  sessionId: string
): IdleMarHistoryCursor | undefined {
  if (value === undefined || !value.startsWith(IDLE_MAR_HISTORY_CURSOR_PREFIX)) return undefined;
  try {
    if (value.length > 1024) throw new Error('EVENT_CURSOR_INVALID');
    const decoded = JSON.parse(
      Buffer.from(value.slice(IDLE_MAR_HISTORY_CURSOR_PREFIX.length), 'base64url').toString('utf8')
    ) as Partial<IdleMarHistoryCursor>;
    if (
      decoded.sessionId !== sessionId ||
      typeof decoded.beforeAt !== 'number' ||
      !Number.isFinite(decoded.beforeAt) ||
      decoded.beforeAt < 0 ||
      typeof decoded.beforeTurnKey !== 'string' ||
      decoded.beforeTurnKey.length === 0 ||
      decoded.beforeTurnKey.length > 256 ||
      (decoded.nativeCursor !== null &&
        (typeof decoded.nativeCursor !== 'string' || decoded.nativeCursor.length > 256))
    )
      throw new Error('EVENT_CURSOR_INVALID');
    return decoded as IdleMarHistoryCursor;
  } catch {
    throw new Error('EVENT_CURSOR_INVALID');
  }
}

/** Retained MAR output owns its matched Turn, never the entire shared Session. */
function mergeMarAgentRuntimeTurn(
  native: NodeConversationTurn,
  local: NodeConversationTurn
): NodeConversationTurn {
  const nativeErrors = local.items.some((item) => item.kind === 'error')
    ? []
    : native.items.filter((item) => item.kind === 'error');
  const matchedInput =
    conversationClientMessageId(local) !== null &&
    conversationClientMessageId(local) === conversationClientMessageId(native);
  return {
    ...local,
    ...(matchedInput && native.rewind !== undefined ? { rewind: native.rewind } : {}),
    status: nativeErrors.length > 0 ? 'FAILED' : local.status,
    items: [
      ...local.items,
      ...nativeErrors.map((item) => ({ ...item, turnId: local.id, runId: local.runId }))
    ]
  };
}

interface ActiveHistoryCursor {
  readonly sessionId: string;
  readonly stage: 'RUNTIME' | 'OFFICIAL';
  readonly beforeAt: number;
  readonly cursor: string | null;
}

const ACTIVE_HISTORY_CURSOR_PREFIX = 'mar-active-history:1:';

function encodeActiveHistoryCursor(cursor: ActiveHistoryCursor): string {
  return `${ACTIVE_HISTORY_CURSOR_PREFIX}${Buffer.from(JSON.stringify(cursor)).toString('base64url')}`;
}

function decodeActiveHistoryCursor(
  value: string | undefined,
  sessionId: string
): ActiveHistoryCursor | undefined {
  if (value === undefined || !value.startsWith(ACTIVE_HISTORY_CURSOR_PREFIX)) return undefined;
  try {
    const decoded = JSON.parse(
      Buffer.from(value.slice(ACTIVE_HISTORY_CURSOR_PREFIX.length), 'base64url').toString('utf8')
    ) as Partial<ActiveHistoryCursor>;
    if (
      decoded.sessionId !== sessionId ||
      (decoded.stage !== 'RUNTIME' && decoded.stage !== 'OFFICIAL') ||
      typeof decoded.beforeAt !== 'number' ||
      !Number.isFinite(decoded.beforeAt) ||
      decoded.beforeAt < 0 ||
      (decoded.cursor !== null && typeof decoded.cursor !== 'string')
    )
      throw new Error('EVENT_CURSOR_INVALID');
    return decoded as ActiveHistoryCursor;
  } catch {
    throw new Error('EVENT_CURSOR_INVALID');
  }
}

function latestTurnActivityAt(turn: NodeConversationTurn): number {
  return Math.max(turn.startedAt ?? 0, turn.completedAt ?? 0);
}

function oldestTurnActivityAt(turns: readonly NodeConversationTurn[]): number {
  return turns.length === 0 ? 0 : Math.min(...turns.map(earliestTurnActivityAt));
}

function mergeRuntimeUserMetadata(
  officialTurn: NodeConversationTurn,
  runtimeTurn: NodeConversationTurn,
  attachments: Pick<RunAttachmentService, 'read'>
): NodeConversationTurn {
  const officialUser = officialTurn.items.find((item) => item.kind === 'user_message');
  const runtimeUser = runtimeTurn.items.find((item) => item.kind === 'user_message');
  if (
    officialUser === undefined ||
    runtimeUser === undefined ||
    !isPlainRecord(officialUser.payload) ||
    !isPlainRecord(runtimeUser.payload)
  )
    return officialTurn;
  const officialPayload = officialUser.payload;
  const runtimePayload = runtimeUser.payload;
  const scheduledSource =
    runtimePayload.source === 'SCHEDULED' && officialPayload.source !== 'SCHEDULED';
  const officialAttachments = Array.isArray(officialPayload.attachments)
    ? officialPayload.attachments
    : [];
  const runtimeAttachments = Array.isArray(runtimePayload.attachments)
    ? runtimePayload.attachments
    : [];
  const runtimeImages = runtimeAttachments.filter(
    (attachment): attachment is Record<string, unknown> =>
      isPlainRecord(attachment) &&
      typeof attachment.mime === 'string' &&
      attachment.mime.startsWith('image/')
  );
  let runtimeImageIndex = 0;
  let changed = false;
  const mergedAttachments = officialAttachments.map((attachment) => {
    if (
      !isPlainRecord(attachment) ||
      typeof attachment.mime !== 'string' ||
      !attachment.mime.startsWith('image/')
    )
      return attachment;
    const runtimeAttachment = runtimeImages[runtimeImageIndex++];
    if (
      runtimeAttachment === undefined ||
      runtimeAttachment.name !== attachment.name ||
      runtimeAttachment.mime !== attachment.mime ||
      typeof attachment.byteSize !== 'number' ||
      !Number.isSafeInteger(attachment.byteSize) ||
      attachment.byteSize < 0 ||
      runtimeAttachment.byteSize !== attachment.byteSize ||
      typeof runtimeAttachment.runId !== 'string' ||
      typeof runtimeAttachment.imageIndex !== 'number' ||
      !Number.isSafeInteger(runtimeAttachment.imageIndex) ||
      runtimeAttachment.imageIndex < 0
    )
      return attachment;
    const cached = attachments.read(runtimeAttachment.runId, runtimeAttachment.imageIndex);
    if (
      cached === undefined ||
      cached.name !== runtimeAttachment.name ||
      cached.mime !== runtimeAttachment.mime ||
      Buffer.byteLength(cached.dataBase64, 'base64') !== attachment.byteSize
    )
      return attachment;
    changed = true;
    return {
      ...attachment,
      runId: runtimeAttachment.runId,
      imageIndex: runtimeAttachment.imageIndex
    };
  });
  if (!changed && !scheduledSource) return officialTurn;
  return {
    ...officialTurn,
    items: officialTurn.items.map((item) =>
      item.id === officialUser.id
        ? {
            ...item,
            payload: {
              ...officialPayload,
              ...(scheduledSource ? { source: 'SCHEDULED' } : {}),
              ...(changed ? { attachments: mergedAttachments } : {})
            }
          }
        : item
    )
  };
}

function conversationTurnKey(turn: NodeConversationTurn): string {
  const messageId = conversationClientMessageId(turn);
  return messageId === null ? `turn:${turn.id}` : `message:${messageId}`;
}

function sameConversationTurn(left: NodeConversationTurn, right: NodeConversationTurn): boolean {
  if (left.id === right.id) return true;
  const leftMessageId = conversationClientMessageId(left);
  const rightMessageId = conversationClientMessageId(right);
  if (leftMessageId !== null && rightMessageId !== null) return leftMessageId === rightMessageId;
  if (left.userItemId !== null && right.userItemId !== null) return false;
  // Runtime namespaces stable Runner Items by Run. A failure before input
  // persistence can leave an error-only native Turn and a local user Turn.
  const [native, local] = left.runId === null ? [left, right] : [right, left];
  if (native.runId !== null || local.runId === null) return false;
  return native.items.some((item) =>
    local.items.some(
      (candidate) =>
        candidate.kind === item.kind &&
        candidate.id === `${local.runId}:${item.id}` &&
        ((native.userItemId === null && local.userItemId === null) || item.kind === 'error')
    )
  );
}

function sourceRank(source: ConversationHistoryPage['source']): number {
  if (source === 'official') return 3;
  if (source === 'native') return 2;
  return 1;
}

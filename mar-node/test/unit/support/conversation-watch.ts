import type { NodeConversationItem, NodeConversationTurn } from '../../../src/runtime-model.js';
import type { ConversationHistoryPage } from '../../../src/util/runner-native-session-parsers.js';
import {
  NativeSessionWatchService,
  type NativeSessionWatchOptions
} from '../../../src/service/native-session-watch-service.js';

interface TestPage {
  readonly turns: readonly (Omit<Partial<NodeConversationTurn>, 'items'> & {
    readonly id: string;
    readonly items?: readonly (Partial<NodeConversationItem> & { readonly id: string })[];
  })[];
  readonly source?: string;
  readonly nextCursor?: string | null;
  readonly snapshotSequence?: number;
  readonly readAt?: number;
  readonly latestVisibleAt?: number;
}

/** Small lease fixtures still exercise the real Conversation authority rules. */
export function createTestSessionWatch(
  options: Omit<NativeSessionWatchOptions, 'readPage' | 'readHistoryPage'> & {
    readonly readPage: (
      session: Parameters<NativeSessionWatchOptions['readPage']>[0],
      limit: number
    ) => Promise<TestPage>;
    readonly readHistoryPage?: (
      session: Parameters<NativeSessionWatchOptions['readPage']>[0],
      limit: number
    ) => Promise<TestPage>;
  }
): NativeSessionWatchService {
  const normalize = (page: TestPage, sessionId: string): ConversationHistoryPage => ({
    nextCursor: null,
    snapshotSequence: 0,
    readAt: 0,
    latestVisibleAt: 0,
    ...page,
    source: page.source === 'official' || page.source === 'runtime' ? page.source : 'native',
    turns: page.turns.map((turn) => ({
      sessionId,
      runId: null,
      userItemId: null,
      status: 'SUCCEEDED',
      model: null,
      effort: null,
      access: null,
      startedAt: null,
      completedAt: null,
      ...turn,
      items: (turn.items ?? []).map((item) => ({
        sessionId,
        turnId: turn.id,
        runId: turn.runId ?? null,
        parentItemId: null,
        sourceSequence: null,
        revision: 0,
        kind: 'assistant_message',
        status: 'COMPLETED',
        payload: {},
        startedAt: null,
        completedAt: null,
        ...item
      }))
    }))
  });
  const { readHistoryPage, ...rest } = options;
  return new NativeSessionWatchService({
    ...rest,
    readPage: async (session, limit) =>
      normalize(await options.readPage(session, limit), session.id),
    ...(readHistoryPage === undefined
      ? {}
      : {
          readHistoryPage: async (session, limit) =>
            normalize(await readHistoryPage(session, limit), session.id)
        })
  });
}

import { defineComponent, h, onBeforeUnmount, ref } from 'vue';
import { watchEventSchema } from '@myagentroam/protocol';
import type { ConversationItem, ConversationTurn, Session } from '../../src/model/workbench.js';
import { createConversationProjectionService } from '../../src/service/conversation-projection-service.js';
import { createWorkbenchConversationComposition } from '../../src/service/workbench-conversation-composition.js';
import { createWorkbenchEventProjectionService } from '../../src/service/workbench-event-projection-service.js';
import { createWorkbenchSessionWatchController } from '../../src/service/workbench-session-watch-controller.js';
import { createWorkbenchSessionHistoryMutationService } from '../../src/service/workbench-session-history-mutation-service.js';
import { i18n, localePreferenceService } from '../../src/service/locale-preference-service.js';
import ConversationTimeline from '../../src/view/conversation/ConversationTimeline.vue';
import { createTooltipApp } from './tooltip-app.js';
import '../../src/styles.css';

// Isolated component integration: real Node Watch frames enter the production Web projection.
localePreferenceService().setLocale('en-US');
createTooltipApp(
  defineComponent({
    setup() {
      const turns = ref<ConversationTurn[]>([]);
      const nextCursor = ref<string | null>(null);
      const draft = ref('');
      const identity = ref<Record<string, unknown>>();
      const workspaceTarget = ref({ nodeId: 'node-1', workspaceId: 'workspace-1' });
      const selectedSessionId = ref<string | undefined>('session-1');
      const session: Session = {
        id: 'session-1',
        workspaceId: 'workspace-1',
        runner: 'codex',
        externalSessionId: 'native-1',
        activity: 'IDLE'
      };
      const projection = createConversationProjectionService({
        turns,
        nextCursor,
        limitHistory: (values) => [...values],
        onRecentWindowOverflow: () => undefined
      });
      const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
        if (path.endsWith('/watch')) {
          identity.value = JSON.parse(String(init?.body));
          return { nodeGeneration: 'generation-1' } as T;
        }
        return (await fetch(path, init)).json() as Promise<T>;
      };
      const conversation = createWorkbenchConversationComposition({
        workspaceTarget,
        selectedSessionId,
        turns,
        nextCursor,
        loadingOlder: ref(false),
        projection,
        request,
        capturePrependAnchor: () => () => undefined,
        pageSize: 3,
        recentSegmentWindowSize: 15,
        sessionPathId: (value) => value,
        notice: () => undefined,
        errorMessage: String,
        replaceCached: () => undefined
      });
      const events = createWorkbenchEventProjectionService({
        workspaceTarget,
        selectedSessionId,
        sessions: ref([session]),
        conversationNextCursor: nextCursor,
        cacheQueue: () => undefined,
        mergeQueue: () => undefined,
        mergeSessions: () => undefined,
        settleSessionRuns: () => false,
        observeManagedSessionActive: () => undefined,
        updateContext: () => undefined,
        syncTurnStatus: projection.syncRunStatus,
        cacheRun: () => undefined,
        acceptRun: (run) => run,
        openRun: () => undefined,
        markLiveTurn: projection.markLive,
        cacheTurn: () => undefined,
        mergeTurns: projection.mergeLatest,
        applyConversationSnapshot: conversation.applySnapshot,
        mergeItem: projection.mergeItem,
        mergeTextDelta: projection.mergeTextDelta,
        invalidateWorkspace: () => undefined,
        onNodeConnected: () => undefined
      });
      const watch = createWorkbenchSessionWatchController({
        workspaceTarget,
        selectedSessionId,
        followConversation: ref(false),
        workbenchConnectionId: () => `connection-${location.search.slice(1)}`,
        heartbeatMs: 60_000,
        requestTimeoutMs: 10_000,
        confirmationTimeoutMs: 60_000,
        request,
        sessionPathId: (value) => value,
        applySnapshot: conversation.applySnapshot,
        applyEvent: events.apply,
        scrollAfterLayout: async () => undefined,
        refreshSnapshot: () => undefined,
        openSession: async () => undefined
      });
      const mutation = createWorkbenchSessionHistoryMutationService({
        current: () => ({ nodeId: 'node-1', session }),
        currentRevision: () => 1,
        canRewind: () => false,
        canRollback: () => true,
        confirmRewind: async () => false,
        confirmRollback: async () => true,
        request,
        sessionPathId: (value) => value,
        beginSubmission: () => () => undefined,
        draft: {
          read: () => draft.value,
          restore: (text) => {
            draft.value = text;
          },
          fill: (text) => {
            draft.value = text;
          }
        },
        replaceSession: () => undefined,
        openSession: async () => undefined,
        invalidateDetail: () => undefined,
        clearHistory: () => projection.resetHistory()
      });
      const receive = (event: Event) =>
        watch.handleEvent(watchEventSchema.parse((event as CustomEvent).detail));
      window.addEventListener('fixture-watch-frame', receive);
      void watch.beginSelectedSessionWatch(session.id);
      onBeforeUnmount(() => {
        window.removeEventListener('fixture-watch-frame', receive);
        watch.stopSelectedSessionWatch();
      });
      return () =>
        h('main', [
          h('output', { 'data-testid': 'watch-identity' }, JSON.stringify(identity.value)),
          h(ConversationTimeline, {
            turns: turns.value,
            loading: false,
            initializing: false,
            initialRenderVersion: 0,
            workspaceRoot: undefined,
            imageAttachments: () => [],
            userInputQuestions: () => [],
            userInputAnswer: () => '',
            userInputSubmitted: () => false,
            planContinuation: undefined,
            nodeReady: true,
            synchronized: true,
            rewindEnabled: false,
            rollbackEnabled: true,
            captureRenderAnchor: () => () => undefined,
            onRollback: (turn: ConversationTurn, item: ConversationItem) => {
              void mutation.rollback(turn, item);
            }
          }),
          h('textarea', {
            'aria-label': 'Draft',
            value: draft.value,
            onInput: (event: Event) => {
              draft.value = (event.target as HTMLTextAreaElement).value;
            }
          })
        ]);
    }
  })
)
  .use(i18n)
  .mount('#app');

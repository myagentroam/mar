import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, nextTick, ref } from 'vue';
import type { ConversationTurn } from '../../src/model/workbench.js';
import { createConversationProjectionState } from '../../src/service/conversation-projection-service.js';
import { installWorkbenchPageLifecycle } from '../../src/service/workbench-page-lifecycle-service.js';
import { renderComponent } from './support/component-renderer.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('document', {
    title: '',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  });
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function mountLifecycle(initial: ConversationTurn[]) {
  const conversation = createConversationProjectionState({
    limitHistory: (turns) => [...turns],
    onRecentWindowOverflow: vi.fn()
  });
  conversation.projection.restoreWindow(initial, null);
  const following = ref(true);
  const scroll = vi.fn();
  const save = vi.fn();
  const noop = () => {};
  const component = renderComponent(
    defineComponent({
      setup() {
        installWorkbenchPageLifecycle({
          persistenceSources: [],
          cacheSources: [conversation.turns],
          routeSources: [],
          documentTitle: ref('Workbench'),
          newSessionRunner: ref('mar-agent'),
          newSessionModel: ref('model'),
          workspaceTarget: ref(undefined),
          selectedSessionId: ref('session'),
          conversationTurns: conversation.turns,
          conversationScroll: ref(undefined),
          followConversation: following,
          persistWorkbenchState: noop,
          syncWorkbenchRoute: noop,
          normalizeNewSessionOptions: noop,
          clearRunnerCommand: noop,
          clearComposerModelEffort: noop,
          closeFileReferences: noop,
          saveCurrentWorkspaceView: save,
          scrollConversationToLatest: scroll,
          stopSelectedSessionWatch: noop,
          restoreWorkbenchState: noop,
          restoreWorkbenchEventCursors: noop,
          restoreWorkspaceUploads: noop,
          startNavigation: noop,
          handleSessionWatchVisibility: noop,
          workspaceShortcuts: [],
          refreshAdmin: async () => {},
          recoverAuthentication: noop,
          cancelFileReferenceSearch: noop,
          disposeNavigation: noop,
          disposeWorkspaceUploads: noop,
          disposeWorkbenchNotifications: noop,
          disposeWebVersionUpdateCheck: noop,
          stopWorkspaceWatch: noop,
          closeWorkbenchLive: noop,
          disposeDirectTransport: noop,
          clearNewSessionAttachments: noop,
          releaseRunImagePreviews: noop
        });
        return () => null;
      }
    })
  );
  return { ...conversation, following, scroll, save, unmount: component.unmount };
}

const initialTurn: ConversationTurn = {
  id: 'turn',
  sessionId: 'session',
  runId: 'run',
  status: 'RUNNING',
  items: []
};

describe('Workbench reactive Conversation lifecycle', () => {
  it('observes window replacements without traversing nested history payloads', async () => {
    const readPayload = vi.fn(() => 'History text');
    const turn = {
      ...initialTurn,
      items: [
        {
          id: 'history',
          kind: 'assistant_message',
          status: 'COMPLETED',
          payload: {
            get text() {
              return readPayload();
            }
          }
        }
      ]
    };
    const state = mountLifecycle([turn]);
    try {
      expect(readPayload).not.toHaveBeenCalled();
      state.projection.restoreWindow([turn], null);
      expect(state.scroll).not.toHaveBeenCalled();
      await nextTick();
      expect(state.scroll).toHaveBeenCalledOnce();
      expect(readPayload).not.toHaveBeenCalled();
      vi.runAllTimers();
      expect(state.save).toHaveBeenCalledOnce();
    } finally {
      state.unmount();
    }
  });

  it('follows streamed replacements only while following and releases watchers on unmount', async () => {
    const state = mountLifecycle([initialTurn]);
    try {
      state.projection.mergeTextDelta('run', { itemId: 'reply', text: 'First' }, 1);
      state.projection.mergeTextDelta('run', { itemId: 'reply', text: ' second' }, 2);
      state.projection.flushPendingTextDeltas();
      expect(state.scroll).not.toHaveBeenCalled();
      await nextTick();
      expect(state.scroll).toHaveBeenCalledOnce();
      expect(state.turns.value[0]?.items[0]?.payload).toMatchObject({ text: 'First second' });

      state.following.value = false;
      state.projection.mergeTextDelta('run', { itemId: 'reply', text: ' third' }, 3);
      state.projection.flushPendingTextDeltas();
      state.projection.mergeOlderPage({
        turns: [{ ...initialTurn, id: 'older', runId: null }],
        nextCursor: 'before-older'
      });
      await nextTick();
      expect(state.scroll).toHaveBeenCalledOnce();
      vi.runAllTimers();
      expect(state.save).toHaveBeenCalledOnce();

      state.following.value = true;
      state.projection.syncRunStatus('run', 'SUCCEEDED');
      await nextTick();
      expect(state.scroll).toHaveBeenCalledTimes(2);
    } finally {
      state.unmount();
    }
    state.projection.restoreWindow([], null);
    await nextTick();
    vi.runAllTimers();
    expect(state.scroll).toHaveBeenCalledTimes(2);
    expect(state.save).toHaveBeenCalledOnce();
  });
});

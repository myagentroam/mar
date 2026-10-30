<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';
import type { ConversationTurn, Session } from '../../src/model/workbench.js';
import { createConversationScrollService } from '../../src/service/conversation-scroll-service.js';
import { createConversationStateService } from '../../src/service/conversation-state-service.js';
import { createRunService } from '../../src/service/run-service.js';
import {
  createWorkbenchSessionSelectionService,
  type WorkbenchSessionSelectionOptions
} from '../../src/service/workbench-session-selection-service.js';
import ConversationScroll from '../../src/view/conversation/ConversationScroll.vue';

const scroll = createConversationScrollService();
const { following, positioningInitialConversation: positioning } = scroll;
const selectedSessionId = ref<string | undefined>('previous-session');
const conversation = createConversationStateService(() => undefined);
const run = createRunService(selectedSessionId);
const turns = conversation.turns;
const history = ref<HTMLElement>();
const parameters = new URL(location.href).searchParams;
const underflow = parameters.has('underflow');
const historyHeight = ref(underflow ? 80 : 4000);
const initialPending = ref(underflow);
const initialFailed = ref(parameters.has('initial-failed'));
const initialRequests = ref(0);
const olderPending = ref(false);
const olderError = ref('');
const contextKey = ref(0);
const loading = ref(false);
const opened = ref(false);
const olderRequests = ref(0);
const guardedAtInterruption = ref(false);
const interruptionPhase = new URL(location.href).searchParams.get('interrupt');
const interruptionInput = new URL(location.href).searchParams.get('input');
let revision = 0;
let releaseWatch: (() => void) | undefined;
const session: Session = { id: 'cached-session', workspaceId: 'workspace', runner: 'mar-agent' };
const options: WorkbenchSessionSelectionOptions = {
  workspaceTarget: ref({ nodeId: 'node', workspaceId: 'workspace' }),
  selectedSessionId,
  selectedRunId: ref(),
  sessions: ref([session]),
  runs: run.runs,
  turns,
  loadingInitial: loading,
  initialLoadFailed: ref(false),
  queue: ref({ version: 0, paused: false, items: [] }),
  positioning,
  draftOpen: ref(false),
  composerMode: ref('message'),
  selectedCommand: ref(),
  commandPickerOpen: ref(false),
  nextRequest: () => ++revision,
  currentRequest: () => revision,
  closeMobileSurface: () => undefined,
  workspaceTabId: () => 'tab',
  ensureSessionVisible: () => undefined,
  markSessionRead: () => undefined,
  saveCurrent: () => undefined,
  selectWorkspace: async () => true,
  applyComposerConfiguration: () => undefined,
  restoreCachedDetail: () => {
    const cachedTurns: ConversationTurn[] = [
      {
        id: 'cached-turn',
        sessionId: session.id,
        runId: null,
        status: 'COMPLETED',
        items: [
          {
            id: 'reply',
            kind: 'assistant_message',
            status: 'COMPLETED',
            payload: { text: 'Reply' }
          }
        ]
      }
    ];
    historyHeight.value = 2800;
    return {
      sessionId: session.id,
      runs: [],
      turns: cachedTurns,
      nextCursor: null,
      contextUsage: null,
      lastAccessedAt: 1
    };
  },
  cachedQueue: () => ({ version: 0, paused: false, items: [] }),
  installCachedDetail: (detail) => {
    run.replaceRuns(detail.runs);
    conversation.projection.restoreWindow(detail.turns, detail.nextCursor);
  },
  clearActiveContent: () => {
    run.replaceRuns([]);
    conversation.projection.restoreWindow([], null);
  },
  openRun: () => undefined,
  scrollLatest: () => {
    const request = revision;
    const pending = scroll.scrollToLatestAfterLayout(() => revision === request);
    const element = scroll.element.value!;
    // Deliver the layout-induced scroll notification before the pending frame calibration.
    history.value!.style.height = '1200px';
    void element.scrollTop;
    history.value!.style.height = '2800px';
    element.dispatchEvent(new Event('scroll'));
    if (interruptionPhase === 'during') interruptPositioning();
    return pending;
  },
  beginInitialRender: async () => undefined,
  request: async <T,>() => ({ session }) as T,
  sessionPathId: (id) => id,
  replaceSession: () => undefined,
  canWatch: () => true,
  hasInitialSnapshot: () => true,
  beginWatch: () => new Promise<boolean>((resolve) => (releaseWatch = () => resolve(true))),
  applySnapshot: () => false,
  mergeTurns: () => false,
  notice: () => undefined,
  errorMessage: String
};
const selection = createWorkbenchSessionSelectionService(options);

function interruptPositioning(): void {
  const element = scroll.element.value!;
  guardedAtInterruption.value = positioning.value;
  if (interruptionInput === 'touch') {
    const touch = (clientY: number) => new Touch({ identifier: 1, target: element, clientY });
    element.dispatchEvent(new TouchEvent('touchstart', { touches: [touch(100)], bubbles: true }));
    element.dispatchEvent(new TouchEvent('touchmove', { touches: [touch(200)], bubbles: true }));
  } else if (interruptionInput === 'keyboard') {
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }));
  } else if (interruptionInput === 'pointer') {
    // Headless Chromium can hide native scrollbars; supply gutter geometry for hit testing.
    const clientWidth = element.clientWidth;
    const hiddenScrollbar = element.offsetWidth === clientWidth;
    if (hiddenScrollbar)
      Object.defineProperty(element, 'clientWidth', {
        value: clientWidth - 16,
        configurable: true
      });
    element.dispatchEvent(
      new PointerEvent('pointerdown', {
        button: 0,
        clientX: element.getBoundingClientRect().right - 1,
        bubbles: true
      })
    );
    if (hiddenScrollbar) Reflect.deleteProperty(element, 'clientWidth');
  } else if (interruptionInput === 'overlay') {
    Object.defineProperty(element, 'offsetWidth', {
      value: element.clientWidth,
      configurable: true
    });
    const clientX = element.getBoundingClientRect().right - 1;
    element.dispatchEvent(
      new PointerEvent('pointerdown', {
        button: 0,
        clientX,
        clientY: 200,
        pointerType: 'mouse',
        bubbles: true
      })
    );
    element.dispatchEvent(
      new PointerEvent('pointermove', {
        buttons: 1,
        clientX,
        clientY: 100,
        pointerType: 'mouse',
        bubbles: true
      })
    );
    element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    Reflect.deleteProperty(element, 'offsetWidth');
  } else {
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, bubbles: true }));
  }
  element.scrollTop = 500;
  element.dispatchEvent(new Event('scroll'));
}

async function restore(): Promise<void> {
  const opening = selection.openSession(session.id);
  if (interruptionPhase === 'before') interruptPositioning();
  await opening;
  opened.value = true;
}

onMounted(async () => {
  await nextTick();
  if (parameters.has('small-overflow')) {
    const element = scroll.element.value!;
    historyHeight.value += element.clientHeight - element.scrollHeight + 7;
    await nextTick();
  }
  scroll.scrollToLatest();
});
</script>

<template>
  <main>
    <template v-if="underflow || parameters.has('small-overflow')">
      <button data-testid="finish-initial" @click="initialPending = false">Finish initial</button>
      <button data-testid="finish-older" @click="olderPending = false">Finish older</button>
      <button
        data-testid="fail-older"
        @click="
          olderPending = false;
          olderError = 'Unavailable';
        "
      >
        Fail older
      </button>
      <button
        data-testid="next-context"
        @click="
          contextKey++;
          initialPending = true;
        "
      >
        Next conversation
      </button>
    </template>
    <button data-testid="restore-cache" @click="restore">Restore cached conversation</button>
    <button data-testid="finish-watch" @click="releaseWatch?.()">Finish Watch</button>
    <button data-testid="grow-content" @click="historyHeight += 240">Append content</button>
    <output data-testid="following">{{ following }}</output>
    <output data-testid="positioning">{{ positioning }}</output>
    <output data-testid="loading">{{ loading }}</output>
    <output data-testid="opened">{{ opened }}</output>
    <output data-testid="older-requests">{{ olderRequests }}</output>
    <output data-testid="initial-requests">{{ initialRequests }}</output>
    <output data-testid="guarded-interruption">{{ guardedAtInterruption }}</output>
    <section class="scroll-fixture">
      <ConversationScroll
        :context-key="String(contextKey)"
        :has-older="!parameters.has('no-older')"
        :loading-initial="initialPending"
        :initial-load-failed="initialFailed"
        :loading-older="olderPending"
        :older-error="olderError"
        :has-turns="true"
        :following="following"
        @scroll-element="scroll.setElement"
        @scroll="scroll.handleScroll(() => olderRequests++)"
        @scroll-intent="scroll.stopFollowing"
        @load-older="
          olderRequests++;
          olderPending = true;
          olderError = '';
        "
        @latest="scroll.scrollToLatest"
        @reload="
          initialRequests++;
          initialPending = true;
          initialFailed = false;
        "
      >
        <div ref="history" class="history" :style="{ height: `${historyHeight}px` }">
          <p>Latest cached message</p>
        </div>
      </ConversationScroll>
    </section>
  </main>
</template>

<style scoped>
.scroll-fixture {
  display: flex;
  height: 500px;
}
.history {
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
}
</style>

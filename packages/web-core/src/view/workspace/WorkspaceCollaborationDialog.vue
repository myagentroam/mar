<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, shallowRef, useTemplateRef, watch } from 'vue';
import { MarButton } from '@myagentroam/mar-ui/button';
import MarBusyIndicator from '@myagentroam/mar-ui/busy-indicator';
import { MarDialog } from '@myagentroam/mar-ui/dialog';
import { MarIcon } from '@myagentroam/mar-ui/icons';
import { readOverflowText } from '@myagentroam/mar-ui/tooltip';
import type { SessionCollaborationEdge } from '@myagentroam/protocol';
import type {
  NavigationSession,
  NavigationSnapshot
} from '../../service/session-navigation-projection.js';
import { currentLocale, translate } from '../../service/locale-preference-service.js';
import { createMobileLayerHistoryService } from '../../service/mobile-layer-history-service.js';
import WorkspaceCollaborationCanvas from './WorkspaceCollaborationCanvas.vue';

/** Owns the transient selection and inspector; Workspace Watch owns all resource data. */
const props = defineProps<{
  anchor: string;
  title: string;
  snapshot: NavigationSnapshot | undefined;
  status: 'idle' | 'loading' | 'ready' | 'failed';
  canRetry: boolean;
}>();
const emit = defineEmits<{
  close: [];
  retry: [];
  board: [sessionId: string | undefined];
  open: [sessionId: string, destination: 'main' | 'aside'];
}>();
const currentGraph = shallowRef<{
  readonly sessions: readonly NavigationSession[];
  readonly sharing: NonNullable<NavigationSnapshot['collaboration']>['sharing'];
  readonly truncated: boolean;
}>();
type BoardSelection =
  { kind: 'session'; sessionId: string } | { kind: 'sharing'; edge: SessionCollaborationEdge };
const selection = shallowRef<BoardSelection>({ kind: 'session', sessionId: props.anchor });
const selectedSession = computed(() =>
  selection.value.kind === 'session' ? selection.value.sessionId : undefined
);
const selectedEdge = computed(() =>
  selection.value.kind === 'sharing' ? selection.value.edge : undefined
);
const boardId = computed(
  () => selectedEdge.value?.ownerSessionId ?? selectedSession.value ?? props.anchor
);
const anchorTitle = useTemplateRef<HTMLElement>('anchorTitle');
const boardHeadingLabel = useTemplateRef<HTMLElement>('boardHeadingLabel');
const mobileHistory = createMobileLayerHistoryService({
  isOpen: () => true,
  close: () => emit('close')
});
onMounted(mobileHistory.start);
onBeforeUnmount(mobileHistory.dispose);
watch(
  () => props.snapshot,
  (snapshot) => {
    if (!snapshot) return;
    const tree = snapshot.tree;
    const graph = snapshot.collaboration;
    if (!tree || !graph || tree.anchorSessionId !== props.anchor) {
      currentGraph.value = undefined;
      return;
    }
    const sessions = [
      graph.anchor,
      ...(tree.parent ? [tree.parent] : []),
      ...tree.nodes,
      ...graph.peers
    ];
    currentGraph.value = {
      sessions: [...new Map(sessions.map((session) => [session.id, session])).values()],
      sharing: graph.sharing,
      truncated: graph.truncated
    };
  },
  { immediate: true }
);

const names = computed(
  () => new Map(currentGraph.value?.sessions.map((session) => [session.id, session]))
);
const boardOwner = computed(() => names.value.get(boardId.value));
const board = computed(() => {
  if (!boardId.value || props.status !== 'ready') return undefined;
  const result = props.snapshot?.collaboration?.board;
  return result?.sessionId === boardId.value ? result : result === null ? null : undefined;
});
const boardTitle = computed(() => board.value?.title ?? boardOwner.value?.title);

function select(next: BoardSelection) {
  const previousBoard = boardId.value;
  selection.value = next;
  if (boardId.value !== previousBoard) emit('board', boardId.value);
}

function readClippedBoardTitle() {
  const label = boardHeadingLabel.value;
  if (label && label.clientHeight > 0 && label.scrollHeight > label.clientHeight) {
    return label.textContent?.trim() || undefined;
  }
}

function time(at: number) {
  return new Intl.DateTimeFormat(currentLocale(), {
    dateStyle: 'short',
    timeStyle: 'short'
  }).format(at);
}
</script>

<template>
  <MarDialog
    v-if="anchor"
    :model-value="true"
    :title="translate('collaboration.title')"
    width="min(1080px, calc(100vw - 32px))"
    align-center
    append-to-body
    @update:model-value="(open) => !open && emit('close')"
  >
    <template #header="{ titleId, titleClass }">
      <div class="collaboration-heading">
        <h2 :id="titleId" :class="titleClass">{{ translate('collaboration.title') }}</h2>
        <p ref="anchorTitle" v-tooltip="() => readOverflowText(anchorTitle)" class="clip-title">
          {{ title }}
        </p>
      </div>
    </template>
    <div
      v-if="!currentGraph"
      class="collaboration-placeholder"
      :aria-busy="status !== 'failed' && status !== 'ready'"
    >
      <div v-if="status === 'failed'" class="collaboration-feedback" role="status">
        {{ translate('collaboration.unavailable') }}
        <MarButton v-if="canRetry" link @click="emit('retry')">{{
          translate('sessionGroups.retry')
        }}</MarButton>
      </div>
      <span v-else-if="status === 'ready'">{{ translate('collaboration.missing') }}</span>
      <span v-else role="status" :aria-label="translate('collaboration.loading')">
        <MarBusyIndicator class="mar-read-loading-indicator" aria-hidden="true" />
      </span>
    </div>
    <template v-else>
      <div
        v-if="status === 'failed' || currentGraph.truncated"
        class="collaboration-feedback"
        role="status"
      >
        {{
          translate(status === 'failed' ? 'collaboration.unavailable' : 'collaboration.truncated')
        }}
        <MarButton v-if="canRetry" link @click="emit('retry')">{{
          translate('sessionGroups.retry')
        }}</MarButton>
      </div>
      <div class="collaboration-body">
        <WorkspaceCollaborationCanvas
          :anchor="anchor"
          :selected="selectedSession"
          :selected-edge="selectedEdge"
          :sessions="currentGraph.sessions"
          :sharing="currentGraph.sharing"
          :can-open-session="status === 'ready'"
          @select="(sessionId) => select({ kind: 'session', sessionId })"
          @board="(edge) => select({ kind: 'sharing', edge })"
          @open="
            (sessionId, destination) => status === 'ready' && emit('open', sessionId, destination)
          "
        />
        <section
          class="collaboration-inspector"
          :aria-label="translate('collaboration.whiteboard')"
        >
          <div class="board-heading">
            <h3 v-tooltip="readClippedBoardTitle" class="board-title" tabindex="0">
              <span class="board-title-icon"><MarIcon name="collection" /></span>
              <span ref="boardHeadingLabel" class="board-title-label">
                {{
                  boardTitle
                    ? translate(
                        selectedEdge
                          ? 'collaboration.sharedBoardTitle'
                          : 'collaboration.boardTitle',
                        { title: boardTitle }
                      )
                    : translate('collaboration.whiteboard')
                }}
              </span>
            </h3>
          </div>
          <p v-if="boardOwner && boardOwner.runner !== 'mar-agent'" role="status">
            {{ translate('collaboration.noBoard') }}
          </p>
          <p v-else-if="status === 'failed' || board === null" role="status">
            {{ translate('collaboration.boardUnavailable') }}
          </p>
          <span
            v-else-if="board === undefined"
            role="status"
            :aria-label="translate('collaboration.boardLoading')"
          >
            <MarBusyIndicator class="mar-read-loading-indicator" aria-hidden="true" />
          </span>
          <template v-else>
            <ul v-if="board.entries.length" class="board-entries">
              <li v-for="entry in board.entries" :key="entry.id">{{ entry.content }}</li>
            </ul>
            <p v-else>{{ translate('collaboration.emptyBoard') }}</p>
            <section v-if="board.recentChanges.length" class="board-changes">
              <h4>{{ translate('collaboration.recentChanges') }}</h4>
              <ul>
                <li v-for="change in board.recentChanges" :key="change.revision">
                  <small
                    >{{ time(change.at)
                    }}<template v-if="change.actorTitle">
                      · {{ change.actorTitle }}</template
                    ></small
                  >
                  <div>{{ change.summary }}</div>
                </li>
              </ul>
            </section>
          </template>
        </section>
      </div>
    </template>
  </MarDialog>
</template>

<style scoped>
.collaboration-heading {
  min-width: 0;
}
.collaboration-heading h2 {
  font-weight: 400;
}
.collaboration-heading p {
  margin: 0.25rem 0 0;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
}
.clip-title {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.collaboration-body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(16rem, 28%);
  min-height: min(32rem, 66dvh);
  border: 1px solid var(--mar-border-subtle);
  border-radius: var(--mar-radius-surface);
  overflow: clip;
}
.collaboration-inspector {
  min-width: 0;
  max-height: min(32rem, 66dvh);
  overflow: auto;
  overscroll-behavior: contain;
  padding: 1rem;
  border-inline-start: 1px solid var(--mar-border-subtle);
  overflow-wrap: anywhere;
}
.board-heading {
  margin: 0 0 0.375rem;
}
.board-heading .board-title {
  display: flex;
  align-items: start;
  gap: 0.375rem;
  margin: 0;
  font-size: var(--mar-font-size-body);
  font-weight: 400;
  line-height: 1.5;
}
.board-title-icon {
  flex: none;
  display: grid;
  place-items: center;
  block-size: 1lh;
  color: var(--mar-text-secondary);
}
.board-title-label {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  /* Legacy clamping preserves scroll height for the overflow-only tooltip. */
  -webkit-line-clamp: 2;
  min-inline-size: 0;
  overflow: clip;
}
.collaboration-inspector small {
  font-size: var(--mar-font-size-meta);
  color: var(--mar-text-secondary);
}
.collaboration-inspector p {
  font-size: var(--mar-font-size-body);
}
.collaboration-placeholder {
  min-height: 14rem;
  display: grid;
  place-items: center;
  color: var(--mar-text-secondary);
}
.collaboration-feedback {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.375rem;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
}
.collaboration-inspector ul {
  list-style: none;
  margin: 0 0 0.875rem;
  padding: 0;
}
.board-entries li,
.board-changes li {
  padding: 0.625rem 0;
  border-bottom: 1px solid var(--mar-border-subtle);
  white-space: pre-wrap;
}
.board-changes h4 {
  margin: 0;
  font-size: var(--mar-font-size-body);
  font-weight: 400;
}
@media (max-width: 767px) {
  .collaboration-body {
    grid-template-columns: minmax(0, 1fr);
  }
  .collaboration-body > :first-child {
    min-height: min(25rem, 49dvh);
  }
  .collaboration-inspector {
    min-height: 0;
    max-height: none;
    overflow: visible;
    border-inline-start: 0;
    border-top: 1px solid var(--mar-border-subtle);
  }
}
</style>

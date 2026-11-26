<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { MarButton } from '@myagentroam/mar-ui/button';
import MarBusyIndicator from '@myagentroam/mar-ui/busy-indicator';
import { MarDialog } from '@myagentroam/mar-ui/dialog';
import { MarIcon } from '@myagentroam/mar-ui/icons';
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
const selected = ref(props.anchor);
const boardId = ref(props.anchor);
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
    if (!sessions.some((session) => session.id === selected.value)) selected.value = props.anchor;
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
const relatedBoards = computed(() => {
  const ids = new Set([selected.value]);
  for (const edge of currentGraph.value?.sharing ?? []) {
    if (edge.followerSessionId === selected.value) ids.add(edge.ownerSessionId);
  }
  if (boardId.value !== selected.value) ids.add(boardId.value);
  return [...ids].flatMap((id) => {
    const owner = names.value.get(id);
    return owner?.runner === 'mar-agent' ? [owner] : [];
  });
});
const board = computed(() => {
  if (!boardId.value || props.status !== 'ready') return undefined;
  const result = props.snapshot?.collaboration?.board;
  return result?.sessionId === boardId.value ? result : result === null ? null : undefined;
});
const boardTitle = computed(() => board.value?.title ?? boardOwner.value?.title);
const canOpenBoardSession = computed(
  () => props.status === 'ready' && Boolean(boardOwner.value || board.value)
);

function select(id: string) {
  selected.value = id;
  selectBoard(id);
}

function selectBoard(id: string) {
  if (boardId.value === id) return;
  boardId.value = id;
  emit('board', id);
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
        <p>{{ title }}</p>
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
          :selected="selected"
          :sessions="currentGraph.sessions"
          :sharing="currentGraph.sharing"
          @select="select"
          @board="selectBoard"
        />
        <section
          class="collaboration-inspector"
          :aria-label="translate('collaboration.whiteboard')"
        >
          <div class="board-panel-header">
            <div
              class="board-actions"
              role="group"
              :aria-label="translate('collaboration.openSession', { title: boardTitle ?? title })"
            >
              <MarButton
                icon="split"
                :disabled="!canOpenBoardSession"
                @click="emit('open', boardId, 'aside')"
              >
                {{ translate('sessionGroups.openAside') }}
              </MarButton>
              <MarButton
                icon="external-link"
                :disabled="!canOpenBoardSession"
                @click="emit('open', boardId, 'main')"
              >
                {{ translate('sessionGroups.openMain') }}
              </MarButton>
            </div>
          </div>
          <div class="board-heading">
            <h3 class="board-title">
              <MarIcon name="collection" />
              <span>
                {{
                  boardTitle
                    ? translate('collaboration.boardTitle', { title: boardTitle })
                    : translate('collaboration.whiteboard')
                }}
              </span>
            </h3>
          </div>
          <div
            v-if="relatedBoards.some(({ id }) => id !== boardId)"
            class="board-switcher"
            role="group"
            :aria-label="translate('collaboration.switchBoard')"
          >
            <MarButton
              v-for="owner in relatedBoards"
              :key="owner.id"
              text
              :aria-label="translate('collaboration.viewBoard', { title: owner.title })"
              :aria-pressed="owner.id === boardId"
              @click="selectBoard(owner.id)"
              >{{ owner.title }}</MarButton
            >
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
.collaboration-heading p {
  margin: 0.25rem 0 0;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
  overflow-wrap: anywhere;
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
.board-panel-header {
  padding-bottom: 0.75rem;
  border-bottom: 1px solid var(--mar-border-subtle);
}
.board-actions,
.board-switcher {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.board-heading {
  margin: 0.875rem 0 0.375rem;
}
.board-heading .board-title {
  display: flex;
  align-items: baseline;
  gap: 0.375rem;
  margin: 0;
  font-size: var(--mar-font-size-title);
  font-weight: 600;
}
.board-title :deep(.mar-icon) {
  flex: none;
  align-self: flex-start;
  color: var(--mar-text-secondary);
}
.collaboration-inspector small {
  font-size: var(--mar-font-size-meta);
  color: var(--mar-text-secondary);
}
.collaboration-inspector p {
  font-size: var(--mar-font-size-body);
}
.board-actions,
.board-switcher {
  flex-wrap: wrap;
}
.board-switcher {
  gap: 0.25rem;
  margin: 0.5rem 0;
}
.board-switcher :deep([aria-pressed='true']) {
  background: var(--mar-fill-selection);
}
.collaboration-inspector :deep(.mar-ui-button) {
  max-width: 100%;
  white-space: normal;
  text-align: start;
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
  font-weight: 600;
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

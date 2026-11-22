<script setup lang="ts">
import '../session/runner-brand-icon.css';
import '../session/session-markers.css';
import { vMarLoading } from '@myagentroam/mar-ui/loading';
import { MarDialog } from '@myagentroam/mar-ui/dialog';
import { MarTag } from '@myagentroam/mar-ui/tag';
import { MarInput } from '@myagentroam/mar-ui/input';
import { MarDropdown, MarDropdownMenu, MarDropdownItem } from '@myagentroam/mar-ui/dropdown';
import { MarButton } from '@myagentroam/mar-ui/button';
import {
  mountMobileDialogReturn,
  unmountMobileDialogReturn
} from '../../service/mobile-dialog-return-service.js';
import { showMessage } from '../../service/message-feedback-service.js';

import { MarIcon } from '@myagentroam/mar-ui/icons';
import SessionGroupTabs from '../session/SessionGroupTabs.vue';
import { marIcon } from '@myagentroam/mar-ui/icons';

import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { Session, Workspace } from '../../model/workbench.js';
import { createEffectiveWorkspaceSkillService } from '../../service/effective-workspace-skill-service.js';
import { createMcpCenterService } from '../../service/mcp-center-service.js';
import { translate } from '../../service/locale-preference-service.js';
import { vSessionReorderMotion } from '../session/session-reorder-motion.js';
import '../session/session-list-title.css';
import MarBusyIndicator from '@myagentroam/mar-ui/busy-indicator';
import WorkspaceSessionActionsMenu from './WorkspaceSessionActionsMenu.vue';

const props = defineProps<{
  readonly sessionGroup?: import('@myagentroam/protocol').SessionGroup | undefined;
  readonly sessions: readonly Session[];
  readonly selectedSessionId: string | undefined;
  readonly mobileViewport: boolean;
  readonly canLoadMore: boolean;
  readonly loadingMore: boolean;
  readonly loadMoreError?: unknown;
  readonly active?: boolean;
  readonly watchStatus: 'idle' | 'loading' | 'ready' | 'failed';
  readonly nodeReady: boolean;
  readonly loading: boolean;
  readonly workspaceKind: Workspace['kind'] | undefined;
  readonly workspaceKindLabel: string;
  readonly workspaceBranch: string | undefined;
  readonly title: (session: Session) => string;
  readonly runnerIcon: (runner: Session['runner']) => string;
  readonly activity: (session: Session) => string;
  readonly canDeleteSession?: (session: Session) => boolean;
  readonly activityLabel: (session: Session) => string;
  readonly activityDateTime: (session: Session) => string | undefined;
  readonly activityTitle: (session: Session) => string | undefined;
  readonly relativeActivity: (session: Session) => string;
  readonly nodeId: string;
  readonly workspaceId: string;
  readonly skillSupported: boolean;
  readonly mcpSupported: boolean;
  readonly cleanupSessionsSupported: boolean;
  readonly searchSupported: boolean;
  readonly searchQuery: string;
  readonly searching: boolean;
  readonly searchReady?: boolean;
  readonly refreshing: boolean;
  readonly workspaceManageable: boolean;
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly hasUnread: (sessionId: string) => boolean;
  readonly asideSupported?: boolean;
}>();

const emit = defineEmits<{
  selectGroup: [group: import('@myagentroam/protocol').SessionGroup];
  openTree: [sessionId: string, anchor: HTMLElement, title: string];
  openAside: [
    target: { readonly nodeId: string; readonly workspaceId: string; readonly sessionId: string }
  ];
  create: [];
  open: [sessionId: string];
  openMain: [sessionId: string];
  openDialog: [kind: 'share' | 'prompt' | 'schedule', session: Session];
  rename: [session: Session];
  pin: [session: Session, pinned: boolean];
  movePin: [session: Session, direction: 'up' | 'down'];
  movePinTo: [session: Session, target: Session, position: 'before' | 'after'];
  deleteSession: [session: Session];
  cleanupSessions: [];
  loadMore: [];
  search: [query: string];
  refresh: [];
}>();

const draggingPinnedSessionId = ref<string>();
const asideActionTarget = ref<{ nodeId: string; workspaceId: string; sessionId: string }>();
function updateSessionActions(visible: boolean, session: Session): void {
  openSessionActionsId.value = visible ? session.id : undefined;
  if (visible)
    asideActionTarget.value = {
      nodeId: props.nodeId,
      workspaceId: session.workspaceId,
      sessionId: session.id
    };
}
const sessionListElement = ref<HTMLElement>();
const appendMarker = ref<HTMLElement>();
const retryingAppend = ref(false);
const hasListContent = computed(
  () => props.sessions.length > 0 || props.canLoadMore || props.loadMoreError !== undefined
);
let appendObserver: IntersectionObserver | undefined;
function canAppend(): boolean {
  return (
    props.active !== false &&
    props.nodeReady &&
    props.watchStatus === 'ready' &&
    props.canLoadMore &&
    !props.loading &&
    !props.searching &&
    !props.refreshing &&
    !props.loadingMore &&
    props.loadMoreError === undefined
  );
}
watch(
  () => [
    sessionListElement.value,
    appendMarker.value,
    props.active,
    props.sessions,
    props.canLoadMore,
    props.loading,
    props.searching,
    props.refreshing,
    props.loadingMore,
    props.loadMoreError,
    props.watchStatus,
    props.nodeReady,
    props.searchQuery
  ],
  () => {
    appendObserver?.disconnect();
    if (!props.loadingMore && props.loadMoreError === undefined) retryingAppend.value = false;
    const root = sessionListElement.value;
    const marker = appendMarker.value;
    if (
      !canAppend() ||
      root === undefined ||
      marker === undefined ||
      typeof IntersectionObserver === 'undefined'
    )
      return;
    appendObserver = new IntersectionObserver(
      (entries) => {
        if (
          entries.some((entry) => entry.isIntersecting) &&
          canAppend() &&
          root.getClientRects().length > 0
        )
          emit('loadMore');
      },
      { root, rootMargin: '0px 0px 96px 0px' }
    );
    appendObserver.observe(marker);
  },
  { flush: 'post' }
);
function retryAppend(): void {
  if (props.loadingMore || !props.canLoadMore) return;
  retryingAppend.value = true;
  emit('loadMore');
}
onBeforeUnmount(() => appendObserver?.disconnect());
const sessionReorderSnapshot = computed(() => ({
  context: JSON.stringify([props.nodeId, props.workspaceId, props.searchQuery]),
  ready:
    props.watchStatus === 'ready' &&
    !props.loading &&
    !props.searching &&
    !props.refreshing &&
    !props.loadingMore &&
    draggingPinnedSessionId.value === undefined,
  items: props.sessions.map((session) => ({
    key: session.id,
    lastActivityAt: session.lastActivityAt,
    pin: session.pinOrder ?? null
  }))
}));
const dragOverPinnedSessionId = ref<string>();
const dragOverPinnedPosition = ref<'before' | 'after'>('before');
const hoveredSessionId = ref<string>();
const focusedSessionId = ref<string>();
const openSessionActionsId = ref<string>();
const searchInput = ref(props.searchQuery);
const searchInitialLoading = computed(() => props.searching && !props.searchReady);
const searchActionLoading = computed(
  () => !searchInitialLoading.value && (props.refreshing || props.searching)
);
watch(
  () => props.searchQuery,
  (query) => (searchInput.value = query)
);
const skillDialogOpen = ref(false);
const skillService = createEffectiveWorkspaceSkillService(props.request);
const mcpDialogOpen = ref(false);
const mcpService = createMcpCenterService(props.request);
const loadedMcps = mcpService.loadedInstallations;
const executionBuiltIns = computed(() => mcpService.inspection.value?.executionBuiltIns ?? []);

async function openSkills(): Promise<void> {
  skillDialogOpen.value = true;
  try {
    await skillService.load(props.nodeId, props.workspaceId);
  } catch {
    showMessage(
      translate('generated.workspaceSessionList.unableToLoadCurrentSkillsTryAgain'),
      'error'
    );
  }
}

async function openMcps(): Promise<void> {
  mcpDialogOpen.value = true;
  try {
    await mcpService.run(() => mcpService.loadWorkspace(props.nodeId, props.workspaceId));
  } catch {
    showMessage(
      translate('generated.workspaceSessionList.unableToLoadCurrentMCPServersTry'),
      'error'
    );
  }
}

function skillWarningLabel(status: string): string {
  if (status === 'PARTIAL') {
    return translate('generated.workspaceSessionList.incompleteInstallation');
  }
  if (status === 'GIT_EXCLUDE_BROKEN') {
    return translate('generated.workspaceSessionList.invalidGitRules');
  }
  return translate('generated.workspaceSessionList.invalidDirectory');
}

function pinned(session: Session): boolean {
  return session.pinOrder !== null && session.pinOrder !== undefined;
}

function startPinnedDrag(event: DragEvent, session: Session): void {
  if (!pinnedDragEnabled(session)) {
    event.preventDefault();
    return;
  }
  draggingPinnedSessionId.value = session.id;
  if (event.dataTransfer !== null) {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', session.id);
  }
}

function pinnedDragEnabled(session: Session): boolean {
  return !props.mobileViewport && pinned(session) && !props.loading;
}

function clearPinnedDrag(): void {
  draggingPinnedSessionId.value = undefined;
  dragOverPinnedSessionId.value = undefined;
}

function dragOverPinned(event: DragEvent, session: Session): void {
  if (!pinnedDragEnabled(session) || draggingPinnedSessionId.value === undefined) return;
  event.preventDefault();
  if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move';
  dragOverPinnedSessionId.value = session.id;
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
  dragOverPinnedPosition.value =
    event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after';
}

function dropPinned(session: Session): void {
  if (!pinnedDragEnabled(session)) {
    clearPinnedDrag();
    return;
  }
  const source = props.sessions.find((candidate) => candidate.id === draggingPinnedSessionId.value);
  const position = dragOverPinnedPosition.value;
  clearPinnedDrag();
  if (source === undefined || source.id === session.id) return;
  emit('movePinTo', source, session, position);
}

function sessionActionsVisible(sessionId: string): boolean {
  return (
    hoveredSessionId.value === sessionId ||
    focusedSessionId.value === sessionId ||
    openSessionActionsId.value === sessionId
  );
}

function clearFocus(event: FocusEvent, clear: () => void): void {
  const target = event.currentTarget;
  if (
    target instanceof HTMLElement &&
    event.relatedTarget instanceof Node &&
    target.contains(event.relatedTarget)
  )
    return;
  clear();
}

function triggerSessionActions(sessionId: string, row: HTMLElement): void {
  hoveredSessionId.value = sessionId;
  void nextTick(() => row.querySelector<HTMLButtonElement>('.session-more-button')?.click());
}

function openSessionActions(sessionId: string, event: MouseEvent): void {
  event.preventDefault();
  const row = (event.currentTarget as HTMLElement).closest<HTMLElement>('.session-row');
  if (row !== null) triggerSessionActions(sessionId, row);
}

function openSession(sessionId: string): void {
  emit('open', sessionId);
}

function showTree(sessionId: string): void {
  const row = [
    ...(sessionListElement.value?.querySelectorAll<HTMLElement>('.session-row') ?? [])
  ].find((item) => item.dataset.sessionId === sessionId);
  const anchor = row?.querySelector<HTMLElement>('.session-link');
  const session = props.sessions.find((item) => item.id === sessionId);
  if (anchor && session) emit('openTree', sessionId, anchor, props.title(session));
}

function submitSessionSearch(): void {
  if (!props.nodeReady || props.searching || props.refreshing) return;
  if (searchInput.value.trim() !== '') {
    emit('search', searchInput.value);
    return;
  }
  if (props.searchQuery !== '') emit('search', '');
  emit('refresh');
}
</script>

<template>
  <aside
    tabindex="-1"
    :inert="mobileViewport && !active"
    class="conversation-sidebar"
    :aria-label="translate('generated.workspaceSessionList.workspaceSessions')"
  >
    <div class="mar-sidebar-heading session-heading">
      <div class="session-heading-meta">
        <h2>{{ translate('generated.workspaceSessionList.sessions') }}</h2>
        <span
          v-if="workspaceKind === 'GIT_WORKSPACE' && workspaceBranch !== undefined"
          v-tooltip="{ content: workspaceBranch, touch: true }"
          class="workspace-branch-tag"
        >
          <MarIcon
            name="branch"
            size="1.15em"
            role="img"
            aria-hidden="false"
            :aria-label="workspaceKindLabel"
          />
          <span class="workspace-branch-name">{{ workspaceBranch }}</span>
        </span>
      </div>
    </div>
    <form
      v-if="searchSupported"
      class="session-search"
      role="search"
      @submit.prevent="submitSessionSearch"
    >
      <MarInput
        v-model="searchInput"
        :placeholder="translate('workspaceSessions.searchPlaceholder')"
        :aria-label="translate('workspaceSessions.searchLabel')"
        :prefix-icon="marIcon('search')"
        clearable
        @clear="emit('search', '')"
        :clear-icon="marIcon('clear-input')"
      />
      <button
        v-tooltip="
          translate(
            searchInput.trim()
              ? 'workspaceSessions.searchAction'
              : 'generated.workspaceSessionList.refreshWorkspaceSessions'
          )
        "
        class="session-search-button mar-icon-action"
        :aria-label="
          translate(
            searchInput.trim()
              ? 'workspaceSessions.searchAction'
              : 'generated.workspaceSessionList.refreshWorkspaceSessions'
          )
        "
        :aria-busy="searchActionLoading || undefined"
        :disabled="!nodeReady || searching || refreshing"
        type="submit"
      >
        <MarIcon name="loading-action" v-if="searchActionLoading" />
        <MarIcon name="refresh" v-else />
      </button>
    </form>
    <div class="new-session-form">
      <MarButton
        class="new-session-button"
        type="primary"
        icon="session-add"
        :disabled="!nodeReady"
        @click="emit('create')"
      >
        {{ translate('generated.workspaceSessionList.newSession') }}
      </MarButton>
      <MarDropdown trigger="click" popper-class="workspace-tool-menu">
        <button
          class="workspace-more-button mar-icon-action"
          :aria-label="translate('generated.workspaceSessionList.moreWorkspaceActions')"
          :disabled="!nodeReady"
          type="button"
        >
          <MarIcon name="more" />
        </button>
        <template #dropdown>
          <MarDropdownMenu>
            <MarDropdownItem v-if="skillSupported" @click="openSkills">
              <MarIcon name="collection" /><span>{{
                translate('generated.workspaceSessionList.loadedSkills')
              }}</span>
            </MarDropdownItem>
            <MarDropdownItem v-if="mcpSupported" @click="openMcps">
              <MarIcon name="connection" /><span>{{
                translate('generated.workspaceSessionList.loadedMCP')
              }}</span>
            </MarDropdownItem>
            <MarDropdownItem
              v-if="cleanupSessionsSupported"
              :disabled="loading || !nodeReady || !workspaceManageable"
              @click="emit('cleanupSessions')"
            >
              <MarIcon name="delete" /><span>{{
                translate('generated.workspaceSessionList.cleanupSessions')
              }}</span>
            </MarDropdownItem>
          </MarDropdownMenu>
        </template>
      </MarDropdown>
    </div>
    <SessionGroupTabs
      v-if="sessionGroup"
      :model-value="sessionGroup"
      @update:model-value="emit('selectGroup', $event)"
    />
    <div
      v-if="searchInitialLoading || (watchStatus === 'loading' && !searchActionLoading)"
      class="watch-status"
      :class="{ 'is-centered': !hasListContent }"
      role="status"
      :aria-label="translate('workspaceWatch.loadingSessions')"
    >
      <MarBusyIndicator class="mar-read-loading-indicator" />
    </div>
    <p
      v-else-if="watchStatus === 'failed'"
      class="watch-status failed"
      :class="{ 'is-centered': !hasListContent }"
      role="status"
    >
      {{ translate('workspaceWatch.sessionsFailed') }}
    </p>
    <ul
      v-if="hasListContent"
      v-session-reorder-motion="sessionReorderSnapshot"
      ref="sessionListElement"
      class="session-list"
    >
      <li
        v-for="session in sessions"
        :key="session.id"
        class="mar-session-reorder-item"
        :class="{
          'dragging-pinned': draggingPinnedSessionId === session.id,
          'drag-over-pinned': dragOverPinnedSessionId === session.id,
          'drag-over-pinned-after':
            dragOverPinnedSessionId === session.id && dragOverPinnedPosition === 'after'
        }"
        :draggable="pinnedDragEnabled(session)"
        @dragend="clearPinnedDrag"
        @dragover="dragOverPinned($event, session)"
        @drop.prevent="dropPinned(session)"
        @dragstart="startPinnedDrag($event, session)"
        @mouseenter="hoveredSessionId = session.id"
        @mouseleave="hoveredSessionId = undefined"
        @focusin="focusedSessionId = session.id"
        @focusout="clearFocus($event, () => (focusedSessionId = undefined))"
      >
        <div
          :data-session-id="session.id"
          :class="[
            'session-row',
            {
              pinned: pinned(session),
              selected: selectedSessionId === session.id
            }
          ]"
          @contextmenu="openSessionActions(session.id, $event)"
        >
          <button
            v-tooltip="title(session)"
            :class="['session-link', { selected: selectedSessionId === session.id }]"
            type="button"
            :aria-current="selectedSessionId === session.id ? 'page' : undefined"
            @click="openSession(session.id)"
          >
            <span class="session-link-content">
              <span class="session-title-row mar-session-list-title">
                <img
                  :src="runnerIcon(session.runner)"
                  :data-runner="session.runner"
                  alt=""
                  aria-hidden="true"
                  class="mar-runner-brand-icon"
                />
                <MarIcon
                  v-if="session.schedule?.enabled === true"
                  v-tooltip="translate('generated.scheduledSession.enabledIndicator')"
                  name="clock"
                  class="session-status-indicator"
                  role="img"
                  aria-hidden="false"
                  :aria-label="translate('generated.scheduledSession.enabledIndicator')"
                />
                <MarIcon
                  v-else-if="pinned(session)"
                  v-tooltip="translate('generated.workspaceSessionList.pinned2')"
                  name="pin"
                  class="session-status-indicator"
                  role="img"
                  aria-hidden="false"
                  :aria-label="translate('generated.workspaceSessionList.pinned')"
                />
                <strong>{{ title(session) }}</strong>
                <span
                  v-tooltip="translate('generated.workspaceSessionList.hasUnreadNotifications2')"
                  v-if="hasUnread(session.id)"
                  class="session-unread-label mar-unread-label"
                  :aria-label="translate('generated.workspaceSessionList.hasUnreadNotifications')"
                  >{{ translate('generated.workspaceSessionList.unread') }}</span
                >
                <span
                  v-tooltip="activityLabel(session)"
                  v-if="nodeReady && activity(session) === 'RUNNING'"
                  :class="['mar-session-activity', activity(session).toLocaleLowerCase()]"
                  :aria-label="activityLabel(session)"
                  role="img"
                  ><i aria-hidden="true"
                /></span>
                <time
                  v-tooltip="activityTitle(session)"
                  class="session-relative-time mar-session-list-meta"
                  :datetime="activityDateTime(session)"
                  >{{ relativeActivity(session) }}</time
                >
              </span>
            </span>
          </button>
          <MarDropdown
            v-if="sessionActionsVisible(session.id)"
            class="session-row-actions"
            placement="bottom-end"
            popper-class="session-action-menu"
            trigger="click"
            @visible-change="updateSessionActions($event, session)"
            @command="$event === 'tree' && showTree(session.id)"
          >
            <button
              v-tooltip="translate('generated.workspaceSessionList.moreSessionActions2')"
              class="session-more-button mar-icon-action mar-icon-action--inline"
              :disabled="loading"
              :aria-label="
                translate('generated.workspaceSessionList.moreSessionActions', {
                  value0: title(session)
                })
              "
              type="button"
            >
              <MarIcon name="more" />
            </button>
            <template #dropdown>
              <WorkspaceSessionActionsMenu
                :session="session"
                :list-context="{ sessions, canDelete: canDeleteSession?.(session) !== false }"
                :can-navigate="asideSupported === true"
                :navigation-disabled="loading || !nodeReady"
                :mutating="loading"
                @open="
                  (id, destination) => {
                    if (destination === 'main') emit('openMain', id);
                    else if (asideActionTarget) emit('openAside', asideActionTarget);
                  }
                "
                @pin="emit('pin', session, $event)"
                @move-pin="emit('movePin', session, $event)"
                @rename="emit('rename', session)"
                @dialog="emit('openDialog', $event, session)"
                @delete="emit('deleteSession', session)"
              />
            </template>
          </MarDropdown>
        </div>
      </li>
      <li
        v-if="canLoadMore || loadMoreError !== undefined"
        ref="appendMarker"
        class="mar-list-append-state"
        :aria-busy="loadingMore"
      >
        <span
          v-if="loadingMore && !retryingAppend"
          role="status"
          :aria-label="translate('generated.workspaceSessionList.loading')"
          ><MarBusyIndicator class="mar-read-loading-indicator"
        /></span>
        <MarButton
          v-if="retryingAppend || (loadMoreError !== undefined && !loadingMore)"
          link
          :aria-disabled="loadingMore"
          :aria-busy="loadingMore"
          :aria-label="loadingMore ? translate('common.loading') : undefined"
          @click="retryAppend"
        >
          <MarBusyIndicator v-if="loadingMore" class="mar-read-loading-indicator" />
          <template v-else>{{ translate('common.loadFailedRetry') }}</template>
        </MarButton>
      </li>
    </ul>
    <p
      v-else-if="
        watchStatus !== 'loading' &&
        watchStatus !== 'failed' &&
        !searchInitialLoading &&
        (!searchQuery || searchReady)
      "
      class="mar-empty sidebar-empty"
    >
      {{
        translate(
          searchQuery
            ? 'sessionGroups.noResults'
            : sessionGroup === 'MAIN'
              ? 'sessionGroups.emptyMain'
              : sessionGroup === 'CHILD'
                ? 'sessionGroups.emptyChild'
                : 'generated.workspaceSessionList.syncingOpenCodeCodexAndClaudeCodeSessions'
        )
      }}
    </p>
    <MarDialog
      @vue:mounted="mountMobileDialogReturn"
      @vue:before-unmount="unmountMobileDialogReturn"
      v-if="skillDialogOpen"
      v-model="skillDialogOpen"
      :title="translate('generated.workspaceSessionList.currentSkills')"
      width="min(560px, calc(100vw - 32px))"
      append-to-body
    >
      <div v-mar-loading:region="skillService.loading.value" class="effective-skill-list">
        <p v-if="!skillService.loading.value && skillService.skills.value.length === 0">
          {{ translate('generated.workspaceSessionList.thisWorkspaceHasNoAvailableSkills') }}
        </p>
        <div
          v-for="skill in skillService.skills.value"
          :key="skill.name"
          class="effective-skill-row"
        >
          <div>
            <strong>{{ skill.name }}</strong>
            <p>
              {{ skill.description || translate('generated.workspaceSessionList.noDescription') }}
            </p>
          </div>
          <span class="effective-skill-tags">
            <MarTag
              v-if="skill.localStatus !== 'VALID' && skill.localStatus !== 'UNKNOWN_VERSION'"
              effect="plain"
              type="warning"
            >
              {{ skillWarningLabel(skill.localStatus) }}
            </MarTag>
            <MarTag effect="plain" :type="skill.source === 'WORKSPACE' ? 'primary' : 'info'">
              {{
                skill.source === 'WORKSPACE'
                  ? translate('common.workspace')
                  : translate('common.nodeHome')
              }}
            </MarTag>
          </span>
        </div>
      </div>
    </MarDialog>
    <MarDialog
      @vue:mounted="mountMobileDialogReturn"
      @vue:before-unmount="unmountMobileDialogReturn"
      v-if="mcpDialogOpen"
      v-model="mcpDialogOpen"
      :title="translate('generated.workspaceSessionList.loadedMCP2')"
      width="min(560px, calc(100vw - 32px))"
      append-to-body
    >
      <div v-mar-loading:region="mcpService.loading.value" class="effective-skill-list">
        <p
          v-if="
            !mcpService.loading.value && loadedMcps.length === 0 && executionBuiltIns.length === 0
          "
        >
          {{ translate('generated.workspaceSessionList.thisWorkspaceHasNoLoadedMCPServers') }}
        </p>
        <div v-for="mcp in loadedMcps" :key="mcp.serverName" class="effective-skill-row">
          <div>
            <strong>{{ mcp.displayName }}</strong>
            <p>
              {{ mcp.description || translate('generated.workspaceSessionList.noDescription') }}
            </p>
            <p class="effective-mcp-meta">{{ mcp.serverName }} · {{ mcp.version }}</p>
          </div>
          <span class="effective-skill-tags">
            <MarTag effect="plain" type="success">{{
              translate('generated.workspaceSessionList.loaded')
            }}</MarTag>
            <MarTag effect="plain" :type="mcp.origin === 'WORKSPACE' ? 'primary' : 'info'">
              {{
                mcp.origin === 'WORKSPACE'
                  ? translate('common.workspace')
                  : translate('common.node')
              }}
            </MarTag>
          </span>
        </div>
        <template v-if="executionBuiltIns.length > 0">
          <div
            v-for="serverName in executionBuiltIns"
            :key="serverName"
            class="effective-skill-row"
          >
            <div>
              <strong>{{
                translate(
                  serverName === 'mar_schedule'
                    ? 'generated.workspaceSessionList.marScheduleMcp'
                    : 'generated.workspaceSessionList.marNotificationMcp'
                )
              }}</strong>
              <p>
                {{
                  translate(
                    serverName === 'mar_schedule'
                      ? 'generated.workspaceSessionList.marScheduleMcpDescription'
                      : 'generated.workspaceSessionList.marNotificationMcpDescription'
                  )
                }}
              </p>
              <p class="effective-mcp-meta">{{ serverName }}</p>
            </div>
            <span class="effective-skill-tags">
              <MarTag effect="plain" type="info">{{
                translate('generated.workspaceSessionList.executionInjected')
              }}</MarTag>
              <MarTag effect="plain" type="info">{{
                translate('generated.workspaceSessionList.builtInMcp')
              }}</MarTag>
            </span>
          </div>
        </template>
      </div>
    </MarDialog>
  </aside>
</template>

<style scoped>
.conversation-sidebar {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  border-right: 1px solid var(--mar-workbench-divider);
  background: var(--mar-bg-chrome);
  padding: 0.7rem;
}

.mar-sidebar-heading {
  margin-bottom: 0.65rem;
}

.mar-sidebar-heading.session-heading {
  margin-bottom: 0.45rem;
}

.watch-status {
  margin: 0.25rem 0.45rem;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
  text-align: center;
}

.watch-status.is-centered {
  display: grid;
  flex: 1 1 auto;
  margin: 0;
  place-items: safe center;
}

.session-heading-meta {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 0.35rem;
}

.session-heading-meta h2 {
  flex: none;
  color: var(--mar-text-primary);
  font-size: var(--mar-font-size-body);
  font-weight: 500;
  line-height: 1.4;
}

.workspace-branch-tag {
  display: inline-flex;
  min-width: 0;
  max-width: 10rem;
  min-height: 1.5em;
  align-items: center;
  gap: 0.25rem;
  padding-inline: 0.28rem;
  border: 1px solid var(--mar-workbench-control-border);
  border-radius: var(--mar-radius-marker);
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
  line-height: 1.2;
}

.workspace-branch-tag .mar-icon {
  flex: none;
}

.workspace-branch-name {
  overflow: hidden;
  color: inherit;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.new-session-form {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  margin-bottom: 0.25rem;
}

.new-session-button {
  flex: 1;
  min-width: 0;
  justify-content: flex-start;
}

.session-search {
  display: flex;
  gap: 0.35rem;
  margin-bottom: 0.35rem;
}

.session-search .mar-ui-input {
  min-width: 0;
}

.new-session-form select {
  min-width: 0;
  padding: 0.37rem;
  font-size: var(--mar-font-size-input);
}

.session-search .session-search-button,
.new-session-form .workspace-more-button {
  display: inline-grid;
  width: var(--mar-compact-control-size);
  min-width: var(--mar-compact-control-size);
  height: var(--mar-compact-control-size);
  min-height: var(--mar-compact-control-size);
  margin: 0;
  place-items: center;
  border: 0;
  border-radius: var(--mar-radius-control);
  font: inherit;
  padding: 0;
  cursor: pointer;
}

.session-search .session-search-button:disabled,
.new-session-form .workspace-more-button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

:global(.workspace-tool-menu .mar-ui-dropdown-item) {
  font-size: var(--mar-font-size-body);
}

.session-row {
  display: flex;
  min-width: 0;
  align-items: stretch;
  border-radius: var(--mar-radius-selection);
  background: transparent;
  -webkit-touch-callout: none;
  -webkit-user-select: none;
  user-select: none;
}

.session-link {
  display: grid;
  min-width: 0;
  flex: 1 1 auto;
  width: 100%;
  gap: 2px;
  border: 0;
  min-height: var(--mar-session-row-min-height);
  border-radius: inherit;
  background: transparent;
  color: var(--mar-text-primary);
  padding: var(--mar-session-row-padding-block) 0.65rem;
  text-align: left;
  cursor: pointer;
}

.session-link:disabled {
  cursor: not-allowed;
}

.session-link:hover:not(:disabled),
.session-link.selected {
  color: var(--mar-text-primary);
}

.session-link strong {
  display: block;
  min-width: 0;
  flex: 1;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-title-row {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 0.4rem;
}

.session-link-content {
  display: grid;
  width: 100%;
  min-width: 0;
  gap: 2px;
}

.session-row:hover {
  background: var(--mar-fill-row-hover);
}

.session-row.selected,
.session-row.selected:hover {
  background: var(--mar-fill-selection);
}

.session-row-actions {
  display: inline-flex;
  flex: none;
  align-items: center;
  padding: 0 0.35rem 0 0.1rem;
  background: transparent;
}

.session-more-button {
  --mar-ui-action-icon-size: 14px;
  display: inline-grid;
  width: 24px;
  height: 24px;
  place-items: center;
  border: 0;
  border-radius: var(--mar-radius-control);
  background: transparent;
  color: var(--mar-text-secondary);
  cursor: pointer;
}

.session-more-button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.session-relative-time {
  flex: none;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  white-space: nowrap;
}

.sidebar-empty {
  margin: 0.9rem 0;
  font-size: var(--mar-font-size-meta);
  text-align: center;
}

@media (max-width: 767px) {
  .conversation-sidebar {
    background: var(--mar-bg-chrome);
  }
}
</style>

<style scoped>
.session-list {
  min-height: 0;
  flex: 1 1 auto;
  margin: 0.5rem -0.7rem 0;
  padding: 0;
  list-style: none;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.session-list li {
  border-bottom: 0;
  padding: 1px 6px;
}

.session-group-tabs {
  margin-inline: -0.7rem;
  padding-inline: 6px;
}

.session-group-tabs ~ .session-list {
  margin-top: 0;
}

.session-list li:first-child {
  padding-top: 4px;
}

.session-status-indicator {
  width: 14px;
  height: 14px;
  flex: none;
  margin-inline: -0.12rem;
}
.effective-skill-list {
  min-height: 96px;
}
.effective-skill-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 0;
  border-bottom: 1px solid var(--mar-control-border-color-lighter);
}
.effective-skill-row > div {
  min-width: 0;
  flex: 1 1 auto;
}
.effective-skill-row p {
  margin: 4px 0 0;
  color: var(--mar-text-secondary);
  overflow-wrap: anywhere;
}
.effective-skill-tags {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  gap: 6px;
}

.effective-skill-row .effective-mcp-meta {
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
}

.session-list li[draggable='true'] {
  cursor: grab;
}

.session-list li.dragging-pinned {
  opacity: 0.5;
}

.session-list li.drag-over-pinned {
  box-shadow: inset 0 2px var(--mar-control-focus);
}

.session-list li.drag-over-pinned-after {
  box-shadow: inset 0 -2px var(--mar-control-focus);
}

@media (max-width: 767px) {
  .session-list {
    max-height: none;
    overflow: auto;
  }

  .effective-skill-row {
    flex-direction: column;
    gap: 8px;
  }

  .effective-skill-tags {
    width: 100%;
  }
}
</style>

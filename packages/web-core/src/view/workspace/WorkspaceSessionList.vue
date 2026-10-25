<script setup lang="ts">
import {
  mountMobileDialogReturn,
  unmountMobileDialogReturn
} from '../../service/mobile-dialog-return-service.js';
import { showMessage } from '../../service/message-feedback-service.js';

import MarIcon from '../common/MarIcon.vue';
import SessionGroupTabs from '../common/SessionGroupTabs.vue';
import { marIcon } from '../../util/mar-icons.js';

import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { Session, Workspace } from '../../model/workbench.js';
import { createEffectiveWorkspaceSkillService } from '../../service/effective-workspace-skill-service.js';
import { createMcpCenterService } from '../../service/mcp-center-service.js';
import { translate } from '../../service/locale-preference-service.js';
import { vSessionReorderMotion } from '../common/session-reorder-motion.js';
import BusyIndicator from '../common/BusyIndicator.vue';
import { errorMessage } from '../../util/error-presentation.js';
import SessionScheduleDialog from './SessionScheduleDialog.vue';
import SessionPromptDialog from './SessionPromptDialog.vue';
import SessionShareDialog from './SessionShareDialog.vue';

const props = defineProps<{
  readonly sessionGroup?: import('@myagentroam/protocol').SessionGroup | undefined;
  readonly groupState?: Record<
    import('@myagentroam/protocol').SessionGroup,
    { running: number; unread: boolean }
  >;
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
  readonly sessionPromptSupported?: boolean;
  readonly searchSupported: boolean;
  readonly searchQuery: string;
  readonly searching: boolean;
  readonly refreshing: boolean;
  readonly workspaceManageable: boolean;
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly hasUnread: (sessionId: string) => boolean;
}>();

const emit = defineEmits<{
  selectGroup: [group: import('@myagentroam/protocol').SessionGroup];
  moveToMain: [session: Session];
  create: [];
  open: [sessionId: string];
  rename: [session: Session];
  pin: [session: Session, pinned: boolean];
  movePin: [session: Session, direction: 'up' | 'down'];
  movePinTo: [session: Session, targetIndex: number];
  deleteSession: [session: Session];
  cleanupSessions: [];
  loadMore: [];
  search: [query: string];
  refresh: [];
}>();

const draggingPinnedSessionId = ref<string>();
const sessionListElement = ref<HTMLElement>();
const appendMarker = ref<HTMLElement>();
const retryingAppend = ref(false);
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
const promptSession = ref<Session>();
const shareSession = ref<Session>();
watch(
  () => [props.nodeId, props.workspaceId],
  () => {
    shareSession.value = undefined;
  }
);
watch(
  () => [props.nodeId, props.workspaceId, props.sessionPromptSupported],
  () => {
    promptSession.value = undefined;
  }
);
const dragOverPinnedSessionId = ref<string>();
const hoveredSessionId = ref<string>();
const focusedSessionId = ref<string>();
const openSessionActionsId = ref<string>();
const searchInput = ref(props.searchQuery);
watch(
  () => props.searchQuery,
  (query) => (searchInput.value = query)
);
const skillDialogOpen = ref(false);
const skillService = createEffectiveWorkspaceSkillService(props.request);
const mcpDialogOpen = ref(false);
const scheduleSession = ref<Session>();
const scheduleDialogOpen = ref(false);
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

function skillStatusLabel(status: string): string {
  return status === 'VALID'
    ? translate('generated.workspaceSessionList.available')
    : status === 'PARTIAL'
      ? translate('generated.workspaceSessionList.incompleteInstallation')
      : status === 'UNKNOWN_VERSION'
        ? translate('generated.workspaceSessionList.unknownVersion')
        : status === 'GIT_EXCLUDE_BROKEN'
          ? translate('generated.workspaceSessionList.invalidGitRules')
          : translate('generated.workspaceSessionList.invalidDirectory');
}

function pinned(session: Session): boolean {
  return session.pinOrder !== null && session.pinOrder !== undefined;
}

function pinnedIndex(session: Session): number {
  return props.sessions.filter(pinned).findIndex((candidate) => candidate.id === session.id);
}

function canMove(session: Session, direction: 'up' | 'down'): boolean {
  const authoritative = direction === 'up' ? session.canMovePinUp : session.canMovePinDown;
  if (authoritative !== undefined) return authoritative;
  const index = pinnedIndex(session);
  const count = props.sessions.filter(pinned).length;
  return index >= 0 && (direction === 'up' ? index > 0 : index < count - 1);
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
}

function dropPinned(session: Session): void {
  if (!pinnedDragEnabled(session)) {
    clearPinnedDrag();
    return;
  }
  const source = props.sessions.find((candidate) => candidate.id === draggingPinnedSessionId.value);
  const targetIndex = pinnedIndex(session);
  clearPinnedDrag();
  if (source === undefined || source.id === session.id || targetIndex < 0) return;
  emit('movePinTo', source, targetIndex);
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

function submitSessionSearch(): void {
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
    <div class="sidebar-heading session-heading">
      <div class="session-heading-meta">
        <h2>{{ translate('generated.workspaceSessionList.sessions') }}</h2>
        <el-tag
          v-if="workspaceKind === 'GIT_WORKSPACE'"
          class="workspace-kind-tag"
          type="info"
          effect="plain"
          size="small"
          >{{ workspaceKindLabel }}</el-tag
        >
        <el-tag
          v-if="workspaceBranch !== undefined"
          class="workspace-branch-tag"
          type="info"
          effect="plain"
          size="small"
          >{{ workspaceBranch }}</el-tag
        >
      </div>
    </div>
    <form
      v-if="searchSupported"
      class="session-search"
      role="search"
      @submit.prevent="submitSessionSearch"
    >
      <el-input
        v-model="searchInput"
        :placeholder="translate('workspaceSessions.searchPlaceholder')"
        :aria-label="translate('workspaceSessions.searchLabel')"
        :prefix-icon="marIcon('search')"
        clearable
        size="small"
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
        class="session-search-button utility-control"
        :aria-label="
          translate(
            searchInput.trim()
              ? 'workspaceSessions.searchAction'
              : 'generated.workspaceSessionList.refreshWorkspaceSessions'
          )
        "
        :aria-busy="searching || refreshing || undefined"
        :disabled="!nodeReady || searching || refreshing"
        type="submit"
      >
        <MarIcon name="loading-action" v-if="searching || refreshing" />
        <MarIcon name="refresh" v-else />
      </button>
    </form>
    <div class="new-session-form">
      <el-button
        class="new-session-button"
        :disabled="!nodeReady"
        type="primary"
        @click="emit('create')"
      >
        <MarIcon name="session-add" /><span>{{
          translate('generated.workspaceSessionList.newSession')
        }}</span>
      </el-button>
      <el-dropdown trigger="click" popper-class="workspace-tool-menu">
        <button
          class="workspace-more-button utility-control"
          :aria-label="translate('generated.workspaceSessionList.moreWorkspaceActions')"
          :disabled="!nodeReady"
          type="button"
        >
          <MarIcon name="more" />
        </button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item v-if="skillSupported" @click="openSkills">
              <MarIcon name="collection" /><span>{{
                translate('generated.workspaceSessionList.loadedSkills')
              }}</span>
            </el-dropdown-item>
            <el-dropdown-item v-if="mcpSupported" @click="openMcps">
              <MarIcon name="connection" /><span>{{
                translate('generated.workspaceSessionList.loadedMCP')
              }}</span>
            </el-dropdown-item>
            <el-dropdown-item
              v-if="cleanupSessionsSupported"
              :disabled="loading || !nodeReady || !workspaceManageable"
              @click="emit('cleanupSessions')"
            >
              <MarIcon name="delete" /><span>{{
                translate('generated.workspaceSessionList.cleanupSessions')
              }}</span>
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>
    <SessionGroupTabs
      v-if="sessionGroup && groupState"
      :model-value="sessionGroup"
      :state="groupState"
      @update:model-value="emit('selectGroup', $event)"
    />
    <p v-if="watchStatus === 'loading'" class="watch-status">
      {{ translate('workspaceWatch.loadingSessions') }}
    </p>
    <p v-else-if="watchStatus === 'failed'" class="watch-status failed">
      {{ translate('workspaceWatch.sessionsFailed') }}
    </p>
    <ul
      v-if="sessions.length || canLoadMore || loadMoreError !== undefined"
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
          'drag-over-pinned': dragOverPinnedSessionId === session.id
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
            @click="openSession(session.id)"
          >
            <span class="session-link-content">
              <span class="session-title-row">
                <img
                  :src="runnerIcon(session.runner)"
                  :data-runner="session.runner"
                  alt=""
                  aria-hidden="true"
                  class="runner-brand-icon session-title-runner-icon"
                />
                <MarIcon
                  v-tooltip="
                    translate(
                      session.schedule.enabled
                        ? 'generated.scheduledSession.enabled'
                        : 'generated.scheduledSession.paused'
                    )
                  "
                  v-if="session.schedule"
                  name="clock"
                  :class="[
                    'session-pin-indicator',
                    { 'schedule-paused': !session.schedule.enabled }
                  ]"
                  :aria-label="
                    translate(
                      session.schedule.enabled
                        ? 'generated.scheduledSession.enabled'
                        : 'generated.scheduledSession.paused'
                    )
                  "
                />
                <MarIcon
                  v-tooltip="translate('generated.workspaceSessionList.pinned2')"
                  v-else-if="pinned(session)"
                  name="star-filled"
                  class="session-pin-indicator"
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
                  v-if="nodeReady && activity(session) === 'MANAGED_ACTIVE'"
                  :class="['session-activity', activity(session).toLocaleLowerCase()]"
                  :aria-label="activityLabel(session)"
                  role="img"
                  ><i aria-hidden="true"
                /></span>
                <time
                  v-tooltip="activityTitle(session)"
                  class="session-relative-time"
                  :datetime="activityDateTime(session)"
                  >{{ relativeActivity(session) }}</time
                >
              </span>
            </span>
          </button>
          <el-dropdown
            v-if="sessionActionsVisible(session.id)"
            class="session-row-actions"
            placement="bottom-end"
            popper-class="session-action-menu"
            trigger="click"
            @visible-change="openSessionActionsId = $event ? session.id : undefined"
          >
            <button
              v-tooltip="translate('generated.workspaceSessionList.moreSessionActions2')"
              class="session-more-button utility-control"
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
              <el-dropdown-menu>
                <el-dropdown-item v-if="!pinned(session)" @click="emit('pin', session, true)"
                  ><MarIcon name="pin" />{{
                    translate('generated.workspaceSessionList.pin')
                  }}</el-dropdown-item
                >
                <template v-else>
                  <el-dropdown-item
                    :disabled="session.schedule?.enabled === true"
                    @click="emit('pin', session, false)"
                    ><MarIcon name="pin" />{{
                      translate('generated.workspaceSessionList.unpin')
                    }}</el-dropdown-item
                  >
                  <el-dropdown-item
                    :disabled="!canMove(session, 'up')"
                    @click="emit('movePin', session, 'up')"
                    ><MarIcon name="chevron-up" />{{
                      translate('generated.workspaceSessionList.moveUp')
                    }}</el-dropdown-item
                  >
                  <el-dropdown-item
                    :disabled="!canMove(session, 'down')"
                    @click="emit('movePin', session, 'down')"
                    ><MarIcon name="chevron-down" />{{
                      translate('generated.workspaceSessionList.moveDown')
                    }}</el-dropdown-item
                  >
                </template>
                <el-dropdown-item @click="shareSession = session"
                  ><MarIcon name="share" />{{ translate('sessionShare.title') }}</el-dropdown-item
                >
                <el-dropdown-item @click="emit('rename', session)"
                  ><MarIcon name="edit" />{{
                    translate('generated.workspaceSessionList.rename')
                  }}</el-dropdown-item
                >
                <el-dropdown-item
                  v-if="sessionGroup && session.sessionGroup === 'CHILD'"
                  :disabled="loading || !nodeReady"
                  @click="emit('moveToMain', session)"
                >
                  <MarIcon name="chevron-up" />{{ translate('sessionGroups.move') }}
                </el-dropdown-item>
                <el-dropdown-item
                  v-if="
                    props.sessionPromptSupported &&
                    session.runtime?.capabilities?.includes('session.prompt')
                  "
                  @click="promptSession = session"
                  ><MarIcon name="document" />{{
                    translate('generated.sessionPrompt.title')
                  }}</el-dropdown-item
                >
                <el-dropdown-item
                  v-if="session.runtime?.capabilities?.includes('session.schedule')"
                  @click="
                    scheduleSession = session;
                    scheduleDialogOpen = true;
                  "
                  ><MarIcon name="clock" />{{
                    translate('generated.scheduledSession.title')
                  }}</el-dropdown-item
                >
                <el-dropdown-item
                  v-if="props.canDeleteSession?.(session) !== false"
                  divided
                  @click="emit('deleteSession', session)"
                  ><MarIcon name="delete" />{{
                    translate('generated.workspaceSessionList.delete')
                  }}</el-dropdown-item
                >
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </li>
      <li
        v-if="canLoadMore || loadMoreError !== undefined"
        ref="appendMarker"
        class="list-append-state"
        :aria-busy="loadingMore"
      >
        <span
          v-if="loadingMore"
          role="status"
          :aria-label="translate('generated.workspaceSessionList.loading')"
          ><BusyIndicator class="read-loading-indicator"
        /></span>
        <span v-if="loadMoreError !== undefined">{{ errorMessage(loadMoreError) }}</span>
        <el-button
          v-if="loadMoreError !== undefined || retryingAppend"
          link
          :aria-disabled="loadingMore"
          @click="retryAppend"
        >
          {{ translate('common.retry') }}
        </el-button>
      </li>
    </ul>
    <p
      v-else-if="watchStatus !== 'loading' && watchStatus !== 'failed'"
      class="empty sidebar-empty"
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
    <el-dialog
      @vue:mounted="mountMobileDialogReturn"
      @vue:before-unmount="unmountMobileDialogReturn"
      v-if="skillDialogOpen"
      v-model="skillDialogOpen"
      :title="translate('generated.workspaceSessionList.currentSkills')"
      width="min(560px, calc(100vw - 32px))"
      append-to-body
      :close-icon="marIcon('close')"
    >
      <div v-loading="skillService.loading.value" class="effective-skill-list">
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
            <el-tag effect="plain" :type="skill.localStatus === 'VALID' ? 'success' : 'warning'">
              {{ skillStatusLabel(skill.localStatus) }}
            </el-tag>
            <el-tag effect="plain" :type="skill.source === 'WORKSPACE' ? 'primary' : 'info'">
              {{
                skill.source === 'WORKSPACE'
                  ? translate('common.workspace')
                  : translate('common.nodeHome')
              }}
            </el-tag>
          </span>
        </div>
      </div>
    </el-dialog>
    <el-dialog
      @vue:mounted="mountMobileDialogReturn"
      @vue:before-unmount="unmountMobileDialogReturn"
      v-if="mcpDialogOpen"
      v-model="mcpDialogOpen"
      :title="translate('generated.workspaceSessionList.loadedMCP2')"
      width="min(560px, calc(100vw - 32px))"
      append-to-body
      :close-icon="marIcon('close')"
    >
      <div v-loading="mcpService.loading.value" class="effective-skill-list">
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
            <el-tag effect="plain" type="success">{{
              translate('generated.workspaceSessionList.loaded')
            }}</el-tag>
            <el-tag effect="plain" :type="mcp.origin === 'WORKSPACE' ? 'primary' : 'info'">
              {{
                mcp.origin === 'WORKSPACE'
                  ? translate('common.workspace')
                  : translate('common.node')
              }}
            </el-tag>
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
              <el-tag effect="plain" type="info">{{
                translate('generated.workspaceSessionList.executionInjected')
              }}</el-tag>
              <el-tag effect="plain" type="info">{{
                translate('generated.workspaceSessionList.builtInMcp')
              }}</el-tag>
            </span>
          </div>
        </template>
      </div>
    </el-dialog>
    <SessionShareDialog
      v-if="shareSession"
      :key="`${nodeId}:${workspaceId}:${shareSession.id}`"
      :target="{ nodeId, workspaceId, sessionId: shareSession.id }"
      :request="request"
      @close="shareSession = undefined"
    />
    <SessionPromptDialog
      v-if="promptSession !== undefined"
      :key="`${nodeId}:${promptSession.id}`"
      :node-id="nodeId"
      :session-id="promptSession.id"
      :request="request"
      @close="promptSession = undefined"
    />
    <SessionScheduleDialog
      v-if="scheduleDialogOpen"
      v-model="scheduleDialogOpen"
      :session="scheduleSession"
      :node-id="nodeId"
      :workspace-id="workspaceId"
      :request="request"
    />
  </aside>
</template>

<style scoped>
.conversation-sidebar {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  border-right: 1px solid var(--mar-border-subtle);
  background: var(--mar-bg-chrome);
  padding: 0.7rem;
}

.sidebar-heading {
  margin-bottom: 0.65rem;
}

.sidebar-heading.session-heading {
  margin-bottom: 0.45rem;
}

.watch-status {
  margin: 0.25rem 0.45rem;
  color: var(--mar-text-muted);
  font-size: var(--mar-font-size-meta);
}

.watch-status.failed {
  color: var(--el-color-warning);
}

.schedule-paused {
  opacity: 0.5;
}

.session-heading-meta {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 0.35rem;
}

.session-heading-meta h2 {
  flex: none;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-body);
  font-weight: 500;
  line-height: 1.4;
}

.workspace-kind-tag,
.workspace-branch-tag {
  color: var(--el-tag-text-color);
  min-height: 1.5em;
  height: auto;
  border-radius: var(--mar-radius-marker);
  font-size: var(--mar-font-size-meta);
  line-height: 1.2;
  padding: 0 5px;
}

.workspace-kind-tag {
  --el-tag-bg-color: var(--mar-color-warning-bg);
  --el-tag-border-color: color-mix(in srgb, var(--mar-color-warning-text) 55%, transparent);
  --el-tag-text-color: var(--mar-color-warning-text);
}

.workspace-branch-tag {
  --el-tag-bg-color: var(--mar-color-brand-subtle);
  --el-tag-border-color: var(--mar-color-brand-border);
  --el-tag-text-color: var(--mar-color-brand-text);
  max-width: 10rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-heading-meta :deep(.el-tag__content) {
  color: inherit;
}

.new-session-form {
  display: flex;
  align-items: center;
  justify-content: stretch;
  gap: 0.35rem;
  margin-bottom: 0.25rem;
}

.session-search {
  display: flex;
  gap: 0.35rem;
  margin-bottom: 0.35rem;
}

.session-search .el-input {
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
  border-radius: 6px;
  font: inherit;
  padding: 0;
  cursor: pointer;
}

.session-search .session-search-button:disabled,
.new-session-form .workspace-more-button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.new-session-form .new-session-button {
  width: auto;
  min-width: 0;
  flex: 1;
  border-radius: 6px;
  justify-content: flex-start;
  padding-inline: 0.65rem;
}

:global(.workspace-tool-menu .el-dropdown-menu__item) {
  font-size: var(--mar-font-size-body);
}

.session-row {
  display: flex;
  min-width: 0;
  align-items: stretch;
  overflow: hidden;
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
  font-size: var(--mar-font-size-body);
  font-weight: 400;
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

.session-row:hover,
.session-row:focus-within {
  background: var(--mar-fill-row-hover);
}

.session-row.selected,
.session-row.selected:hover,
.session-row.selected:focus-within {
  background: var(--mar-fill-selection);
}

.session-row-actions {
  display: inline-flex;
  flex: none;
  align-items: center;
  padding: 0.25rem 0.35rem 0.25rem 0.1rem;
  background: transparent;
}

.session-more-button {
  --mar-action-icon-size: 14px;
  display: inline-grid;
  width: 24px;
  height: 24px;
  place-items: center;
  border: 0;
  border-radius: 3px;
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
  color: var(--mar-text-faint);
  font-size: var(--mar-font-size-meta);
  font-variant-numeric: tabular-nums;
  line-height: 1;
  white-space: nowrap;
}

.session-row.selected .session-relative-time {
  color: var(--mar-text-secondary);
}

.sidebar-empty {
  margin: 0.9rem 0;
  font-size: var(--mar-font-size-meta);
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
  border-top: 1px solid var(--mar-border-subtle);
  padding: 0;
  list-style: none;
  overflow-y: auto;
}

.session-list li {
  border-bottom: 0;
  padding: 2px 6px;
}

.session-group-tabs {
  margin: 0.5rem -0.7rem 0;
  border-top: 1px solid var(--mar-border-subtle);
  padding-inline: 6px;
}

.session-group-tabs ~ .session-list {
  margin-top: 0;
  border-top: 0;
}

.session-list li:first-child {
  padding-top: 4px;
}

@media (min-width: 768px) {
  .session-link strong {
    font-size: var(--mar-font-size-body);
  }
}

.session-pin-indicator {
  width: 0.68rem;
  height: 0.68rem;
  flex: none;
  margin-inline: -0.12rem;
  color: var(--mar-color-warning-accent);
  font-size: 0.68rem;
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
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.effective-skill-row > div {
  min-width: 0;
  flex: 1 1 auto;
}
.effective-skill-row p {
  margin: 4px 0 0;
  color: var(--el-text-color-secondary);
  overflow-wrap: anywhere;
}
.effective-skill-tags {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  gap: 6px;
}

.effective-skill-row .effective-mcp-meta {
  color: var(--mar-text-tertiary);
  font-size: var(--mar-font-size-meta);
}

.session-list li[draggable='true'] {
  cursor: grab;
}

.session-list li.dragging-pinned {
  opacity: 0.5;
}

.session-list li.drag-over-pinned {
  box-shadow: inset 0 2px var(--mar-color-brand);
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

<style scoped>
:global(.session-action-menu .el-dropdown-menu__item) {
  gap: 0.4rem;
}
</style>

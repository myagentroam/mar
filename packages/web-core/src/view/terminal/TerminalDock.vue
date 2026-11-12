<script setup lang="ts">
import type { MessageType } from '../../model/message-feedback.js';
import { marIcon } from '../../util/mar-icons.js';
import MarIcon from '../common/MarIcon.vue';
import {
  computed,
  defineAsyncComponent,
  inject,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch
} from 'vue';
import { consoleKeyboardShortcutService } from '../../service/console-keyboard-shortcut-service.js';
import { createScopedHttpService } from '../../service/scoped-http-service.js';
import {
  AuthenticationContextChangedError,
  WORKBENCH_HTTP_KEY
} from '../../service/workbench-http-service.js';
import { ApiError, errorCode } from '../../util/api-error.js';
import { errorSummary } from '../../util/error-presentation.js';
import type { createTerminalDirectClient } from '../../service/terminal-direct-client.js';
import { translate } from '../../service/locale-preference-service.js';

const TerminalTabView = defineAsyncComponent(() => import('./TerminalTabView.vue'));

interface TerminalProfile {
  readonly id: string;
  readonly label: string;
  readonly isDefault: boolean;
}
interface TerminalCapability {
  readonly available: boolean;
  readonly reasonCode: string | null;
  readonly supportsReplay: boolean;
  readonly supportsConPty: boolean;
  readonly supportsTakeover: boolean;
  readonly profiles: readonly TerminalProfile[];
}
interface TerminalSummary {
  readonly id: string;
  readonly workspaceId: string | null;
  readonly profileId: string;
  readonly state: 'RUNNING' | 'EXITED' | 'CLOSED';
  readonly latestSequence: number;
}
const props = defineProps<{
  readonly errorMessage: (error: unknown) => string;
  readonly nodeId: string | undefined;
  readonly direct?: Pick<ReturnType<typeof createTerminalDirectClient>, 'attach'>;
  readonly workspaceId: string | undefined;
  readonly csrfToken: string;
  readonly renewCsrfToken: () => Promise<string>;
  readonly enabled: boolean;
  readonly capability: TerminalCapability | undefined;
  readonly nodeOsRelease: string | undefined;
  readonly visible: boolean;
  readonly embedded?: boolean;
  readonly mobileMode: boolean;
  /** Inactive tabs keep their mounted relay without reading or clearing Workspace state. */
  readonly active: boolean;
}>();
const emit = defineEmits<{
  notice: [message: string, type: MessageType, cause?: unknown];
  collapse: [];
}>();

const selectedProfileId = ref<string>();
const terminalRoot = ref<HTMLElement>();
let unregisterShortcutRegion: (() => void) | undefined;
const creating = ref(false);
const closingId = ref<string>();
const expanded = ref(false);
const hasOpened = ref(false);
const autoCreateAttempted = ref(false);
const refreshing = ref(false);
let refreshRevision = 0;
let contextRevision = 0;
let released = false;
let focusRequested = false;
const terminals = ref<TerminalSummary[]>([]);
const activeTerminalId = ref<string>();
const terminalViews = new Map<string, { focus(): void }>();
const workbenchHttp = inject(WORKBENCH_HTTP_KEY, undefined);
const http =
  workbenchHttp ??
  createScopedHttpService({
    csrfToken: () => props.csrfToken,
    renewCsrfToken: props.renewCsrfToken
  });

const canUseTerminal = computed(
  () => props.enabled && props.nodeId !== undefined && props.capability?.available === true
);
const windowsBuildNumber = computed(() => {
  if (props.capability?.supportsConPty !== true || props.nodeOsRelease === undefined)
    return undefined;
  const build = /^\d+\.\d+\.(\d+)(?:\.|$)/u.exec(props.nodeOsRelease)?.[1];
  if (build === undefined) return undefined;
  const parsed = Number(build);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
});
const profiles = computed(() =>
  (props.capability?.profiles ?? []).map((profile) => {
    const canonicalLabel = profile.label.replace(/\s*\(Tab completion supported\)$/u, '');
    const labelKey = {
      'User Shell': 'nodeMessages.userShell',
      'Windows Command Prompt': 'nodeMessages.windowsCommandPrompt'
    }[canonicalLabel];
    return {
      ...profile,
      label: labelKey === undefined ? canonicalLabel : translate(labelKey)
    };
  })
);
const contextLabel = computed(() =>
  props.workspaceId === undefined
    ? translate('generated.terminalDock.nodeTerminal')
    : translate('generated.terminalDock.workspaceTerminal')
);
const terminalActionTitle = computed(() => {
  if (canUseTerminal.value) return translate('generated.terminalDock.newTerminal');
  if (props.nodeId === undefined)
    return translate('generated.terminalDock.selectAnOnlineNodeFirst');
  if (props.capability?.available !== false) return translate('generated.terminalDock.newTerminal');
  const fallback = translate('generated.terminalDock.theTargetNodeDoesNotProvideA');
  return props.capability.reasonCode === null
    ? fallback
    : errorSummary(new ApiError(props.capability.reasonCode, fallback));
});

function selectTerminal(terminalId: string): void {
  if (activeTerminalId.value === terminalId) return;
  activeTerminalId.value = terminalId;
}
function insertOpenedTerminal(terminal: TerminalSummary): void {
  terminals.value = [...terminals.value.filter((item) => item.id !== terminal.id), terminal].filter(
    (item) => item.state === 'RUNNING'
  );
}
function setExpanded(value: boolean): void {
  if (value && !expanded.value) autoCreateAttempted.value = false;
  expanded.value = value;
  if (value) hasOpened.value = true;
}
function toggleExpanded(): void {
  setExpanded(!expanded.value);
}
async function focusActiveTerminal(): Promise<void> {
  focusRequested = true;
  setExpanded(true);
  await ensureTerminalForExpandedDock();
  await focusSelectedTerminalIfReady();
}
async function toggleTerminal(): Promise<void> {
  if (expanded.value) {
    focusRequested = false;
    setExpanded(false);
    return;
  }
  await focusActiveTerminal();
}
async function focusSelectedTerminalIfReady(): Promise<void> {
  await nextTick();
  if (released || !focusRequested || !expanded.value || !props.active || !props.visible) return;
  const terminalId = activeTerminalId.value;
  const terminalView = terminalId === undefined ? undefined : terminalViews.get(terminalId);
  if (terminalView === undefined) return;
  terminalView.focus();
  focusRequested = false;
}
async function refreshContext(): Promise<void> {
  // Manifest is briefly cleared during Node switches; do not unmount this tab's xterm in that loading state.
  if (released || !props.active || props.nodeId === undefined || props.capability === undefined)
    return;
  const revision = ++refreshRevision;
  if (!canUseTerminal.value) {
    terminals.value = [];
    activeTerminalId.value = undefined;
    refreshing.value = false;
    return;
  }
  refreshing.value = true;
  try {
    const result = await http.request<{ terminals: readonly TerminalSummary[] }>(
      `/api/terminals?nodeId=${encodeURIComponent(props.nodeId)}`
    );
    if (revision !== refreshRevision) return;
    const owned = new Set(terminals.value.map((terminal) => terminal.id));
    terminals.value = result.terminals.filter(
      (terminal) =>
        owned.has(terminal.id) &&
        terminal.state === 'RUNNING' &&
        terminal.workspaceId === (props.workspaceId ?? null)
    );
    if (!terminals.value.some((terminal) => terminal.id === activeTerminalId.value))
      activeTerminalId.value = terminals.value[0]?.id;
  } catch (error) {
    if (revision !== refreshRevision) return;
    notifyFailure(
      translate('generated.terminalDock.unableToLoadTerminals', { value0: message(error) }),
      error
    );
  } finally {
    if (revision !== refreshRevision) return;
    refreshing.value = false;
    void ensureTerminalForExpandedDock();
  }
}
async function openTerminal(): Promise<void> {
  if (
    released ||
    !props.active ||
    !canUseTerminal.value ||
    props.nodeId === undefined ||
    creating.value
  )
    return;
  setExpanded(true);
  autoCreateAttempted.value = true;
  const nodeId = props.nodeId;
  const workspaceId = props.workspaceId;
  const revision = contextRevision;
  creating.value = true;
  try {
    const result = await http.request<{ terminal: TerminalSummary }>('/api/terminals', {
      method: 'POST',
      body: JSON.stringify({
        nodeId,
        ...(workspaceId === undefined ? {} : { workspaceId }),
        ...(selectedProfileId.value === undefined ? {} : { profileId: selectedProfileId.value }),
        rows: 18,
        cols: 100
      })
    });
    if (released || revision !== contextRevision) {
      await releaseTerminals(nodeId, [result.terminal]);
      return;
    }
    // A cached Workspace Dock still owns the result while another tab is in front.
    // A list read started before this write must not discard the newly owned terminal.
    refreshRevision += 1;
    refreshing.value = false;
    insertOpenedTerminal(result.terminal);
    selectTerminal(result.terminal.id);
  } catch (error) {
    if (released || revision !== contextRevision || !props.active) return;
    notifyFailure(
      translate('generated.terminalDock.unableToCreateATerminal', { value0: message(error) }),
      error,
      translate('generated.terminalDock.createResultUnknown', { value0: message(error) })
    );
  } finally {
    creating.value = false;
    void ensureTerminalForExpandedDock();
  }
}
async function ensureTerminalForExpandedDock(): Promise<void> {
  if (
    released ||
    !props.active ||
    !expanded.value ||
    !props.visible ||
    refreshing.value ||
    creating.value ||
    autoCreateAttempted.value ||
    !canUseTerminal.value ||
    props.workspaceId === undefined ||
    terminals.value.length > 0
  )
    return;
  await openTerminal();
}
function collapseDock(): void {
  setExpanded(false);
  emit('collapse');
}
async function closeTerminal(terminalId: string): Promise<void> {
  if (props.nodeId === undefined) return;
  const revision = contextRevision;
  closingId.value = terminalId;
  try {
    await http.request(`/api/terminals/${encodeURIComponent(terminalId)}`, {
      method: 'DELETE',
      body: JSON.stringify({ nodeId: props.nodeId })
    });
    terminals.value = terminals.value.filter((item) => item.id !== terminalId);
    if (activeTerminalId.value === terminalId) {
      activeTerminalId.value = undefined;
      const next = terminals.value[0];
      if (next !== undefined) selectTerminal(next.id);
    }
    if (terminals.value.length === 0) collapseDock();
  } catch (error) {
    if (released || revision !== contextRevision) return;
    notifyFailure(
      translate('generated.terminalDock.unableToCloseTheTerminal', { value0: message(error) }),
      error,
      translate('generated.terminalDock.closeResultUnknown', { value0: message(error) })
    );
  } finally {
    closingId.value = undefined;
  }
}
function handleTerminalExited(terminalId: string): void {
  const wasActive = activeTerminalId.value === terminalId;
  terminals.value = terminals.value.filter((item) => item.id !== terminalId);
  if (wasActive) activeTerminalId.value = terminals.value[0]?.id;
  if (terminals.value.length === 0 && expanded.value) collapseDock();
}
function message(error: unknown): string {
  return props.errorMessage(error);
}

function notifyFailure(message: string, error: unknown, unknownWriteMessage?: string): void {
  if (errorCode(error) === 'NETWORK_UNAVAILABLE') {
    // A later reachable response does not establish the outcome of an earlier write.
    if (unknownWriteMessage !== undefined) {
      emit('notice', unknownWriteMessage, 'warning', error);
      return;
    }
    if (workbenchHttp?.networkUnavailable.value) return;
  }
  emit('notice', message, 'error', error);
}

watch(
  () => [props.nodeId, props.workspaceId] as const,
  () => {
    contextRevision += 1;
    autoCreateAttempted.value = false;
  },
  { flush: 'sync' }
);
watch(
  () => props.capability?.profiles,
  (next) => {
    selectedProfileId.value = next?.find((profile) => profile.isDefault)?.id ?? next?.[0]?.id;
  },
  { immediate: true }
);
watch(
  () =>
    [
      props.nodeId,
      props.workspaceId,
      props.enabled,
      props.capability?.available,
      props.active,
      props.embedded ? props.visible : true
    ] as const,
  () => {
    if (props.embedded && !props.visible) return;
    void refreshContext();
  },
  { immediate: true }
);
watch(
  () => [props.mobileMode, props.embedded, props.visible] as const,
  ([mobileMode, embedded, visible]) => {
    if ((mobileMode || embedded) && visible) setExpanded(true);
  },
  { immediate: true }
);
watch(
  () =>
    [
      expanded.value,
      props.visible,
      canUseTerminal.value,
      terminals.value.length,
      activeTerminalId.value,
      refreshing.value,
      creating.value
    ] as const,
  () => {
    void ensureTerminalForExpandedDock();
    void focusSelectedTerminalIfReady();
  },
  { immediate: true }
);

async function releaseTerminals(
  nodeId: string | undefined,
  owned: readonly TerminalSummary[]
): Promise<void> {
  const results = await Promise.allSettled(
    owned.map((terminal) =>
      http.request(`/api/terminals/${encodeURIComponent(terminal.id)}`, {
        method: 'DELETE',
        body: JSON.stringify({ nodeId })
      })
    )
  );
  const failed = results.filter((result) => result.status === 'rejected');
  // Keep obsolete identity causes suppressible before choosing an uncertain aggregate result.
  const firstFailure =
    failed.find((result) => result.reason instanceof AuthenticationContextChangedError) ??
    failed.find((result) => errorCode(result.reason) === 'NETWORK_UNAVAILABLE') ??
    failed[0];
  if (firstFailure !== undefined)
    notifyFailure(
      translate('generated.terminalDock.unableToReleaseTerminals', {
        value0: failed.length,
        value1: message(firstFailure.reason)
      }),
      firstFailure.reason,
      translate('generated.terminalDock.releaseResultsUnknown', {
        value0: failed.length,
        value1: message(firstFailure.reason)
      })
    );
}

async function release(): Promise<void> {
  if (released) return;
  released = true;
  refreshRevision += 1;
  expanded.value = false;
  focusRequested = false;
  try {
    await releaseTerminals(props.nodeId, terminals.value);
  } finally {
    terminals.value = [];
    activeTerminalId.value = undefined;
  }
}

onMounted(() => {
  unregisterShortcutRegion = consoleKeyboardShortcutService.registerRegion({
    scope: 'terminal',
    root: () => terminalRoot.value,
    blocksOtherScopes: true
  });
});
onBeforeUnmount(() => {
  unregisterShortcutRegion?.();
  void release();
});

defineExpose({ release, toggle: toggleTerminal });
</script>

<template>
  <section
    ref="terminalRoot"
    class="admin-terminal"
    :class="{ 'is-embedded': embedded }"
    :aria-label="translate('common.adminTerminal')"
  >
    <header class="admin-terminal-header">
      <h2>{{ contextLabel }}</h2>
      <div
        v-if="hasOpened"
        v-show="expanded || terminals.length === 0"
        class="terminal-tabs"
        role="tablist"
        :aria-label="translate('generated.terminalDock.list', { value0: contextLabel })"
      >
        <div
          v-for="(item, index) in terminals"
          :key="item.id"
          class="terminal-tab"
          :class="{ active: item.id === activeTerminalId }"
        >
          <button
            class="terminal-tab-select"
            type="button"
            role="tab"
            :aria-selected="item.id === activeTerminalId"
            @click="selectTerminal(item.id)"
          >
            <span>Terminal {{ index + 1 }}</span>
          </button>
          <button
            v-tooltip="translate('generated.terminalDock.closeTerminal', { value0: index + 1 })"
            class="terminal-tab-close icon-button icon-action icon-action--inline mar-tab-close"
            type="button"
            :aria-label="translate('generated.terminalDock.closeTerminal', { value0: index + 1 })"
            :disabled="closingId === item.id"
            @click="closeTerminal(item.id)"
          >
            <MarIcon name="close" />
          </button>
        </div>
        <button
          v-tooltip="terminalActionTitle"
          class="terminal-tab terminal-tab-add icon-action"
          type="button"
          :aria-label="translate('generated.terminalDock.newTerminal2')"
          :disabled="!canUseTerminal || creating"
          @click="openTerminal"
        >
          <MarIcon name="plus" />
        </button>
      </div>
      <div v-if="profiles.length > 1 || !mobileMode" class="admin-terminal-actions">
        <label v-if="profiles.length > 1" class="terminal-profile">
          {{ translate('generated.terminalDock.terminalProfile') }}
          <el-select
            v-model="selectedProfileId"
            :aria-label="translate('generated.terminalDock.terminalProfile2')"
            size="small"
            :disabled="!canUseTerminal || creating"
            :clear-icon="marIcon('clear-input')"
            :suffix-icon="marIcon('chevron-down')"
          >
            <el-option
              v-for="profile in profiles"
              :key="profile.id"
              :value="profile.id"
              :label="profile.label"
            />
          </el-select>
        </label>
        <el-button
          v-tooltip="
            expanded
              ? translate('generated.terminalDock.collapseTerminal2')
              : translate('generated.terminalDock.expandTerminal2')
          "
          v-if="!mobileMode && !embedded"
          size="small"
          :aria-label="
            expanded
              ? translate('generated.terminalDock.collapseTerminal')
              : translate('generated.terminalDock.expandTerminal')
          "
          @click="toggleExpanded"
        >
          <span>{{
            expanded
              ? translate('generated.terminalDock.collapseTerminal3')
              : translate('generated.terminalDock.expandTerminal3')
          }}</span>
        </el-button>
      </div>
    </header>
    <div v-if="hasOpened" v-show="expanded" class="admin-terminal-content">
      <div class="terminal-context-cache">
        <TerminalTabView
          v-for="item in terminals"
          :key="item.id"
          :ref="
            (instance) => {
              if (instance === null) terminalViews.delete(item.id);
              else {
                terminalViews.set(item.id, instance as unknown as { focus(): void });
                void focusSelectedTerminalIfReady();
              }
            }
          "
          :terminal-id="item.id"
          :node-id="nodeId ?? ''"
          :direct="direct"
          :workspace-id="workspaceId"
          :csrf-token="csrfToken"
          :renew-csrf-token="renewCsrfToken"
          :windows-con-pty="capability?.supportsConPty === true"
          :windows-build-number="windowsBuildNumber"
          :active="item.id === activeTerminalId"
          :fill-available="embedded === true"
          :visible="active && visible && expanded"
          @exited="handleTerminalExited"
          @notice="(message, type, cause) => emit('notice', message, type, cause)"
        />
      </div>
    </div>
  </section>
</template>

<style scoped>
.admin-terminal {
  border-top: 1px solid var(--mar-border-subtle);
  background: var(--mar-bg-chrome);
}

.admin-terminal.is-embedded,
.admin-terminal.is-embedded .admin-terminal-content,
.admin-terminal.is-embedded .terminal-context-cache {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
}

.admin-terminal.is-embedded .admin-terminal-header {
  flex: none;
}

.admin-terminal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  min-height: 32px;
  padding: 0.2rem 0.55rem;
}

.admin-terminal-header h2 {
  flex: none;
  margin: 0;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-body);
  font-weight: 500;
  line-height: 1.4;
}

.admin-terminal-actions {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: flex-end;
  gap: 0.25rem;
}

.admin-terminal-actions button {
  width: auto;
  min-height: 28px;
  border-radius: 6px;
}

.terminal-tabs {
  display: flex;
  gap: 3px;
  overflow-x: auto;
  background: var(--mar-bg-chrome);
  padding: 4px 3px 3px;
}

.terminal-tab {
  position: relative;
  display: flex;
  flex: none;
  align-items: center;
  min-width: 100px;
  border-radius: var(--mar-radius-selection);
  background: transparent;
  color: var(--mar-text-tertiary);
  font-size: var(--mar-font-size-body);
  font-weight: 500;
}

.terminal-tab-select {
  display: flex;
  width: 100%;
  min-width: 0;
  cursor: pointer;
  padding: 0.3rem 32px 0.3rem 0.55rem;
  border: 0;
  border-radius: inherit;
  background: transparent;
  color: inherit;
  font: inherit;
}

.terminal-tab.active {
  background: var(--mar-fill-selection);
  color: var(--mar-text-primary);
}

.terminal-tab:not(.active, .terminal-tab-add):hover {
  background: var(--mar-fill-row-hover);
  color: var(--mar-text-primary);
}

.terminal-tab-add {
  min-width: 32px;
  justify-content: center;
  padding: 0.3rem 0.55rem;
  border: 0;
  color: var(--mar-text-secondary);
  cursor: pointer;
}

.terminal-tab-add:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.terminal-tab-close {
  position: absolute;
  right: 3px;
  align-self: center;
  margin: 2px 0;
}

.terminal-profile {
  gap: 2px;
  font-size: var(--mar-font-size-meta);
}

.terminal-profile select {
  min-width: 112px;
  padding: 0.31rem;
}

@media (min-width: 768px) {
  .admin-terminal {
    container-type: inline-size;
  }

  .admin-terminal-header {
    padding-block: 0;
  }

  .admin-terminal-actions button {
    min-height: var(--mar-compact-control-size);
  }

  .terminal-tabs {
    flex: 1;
    min-width: 0;
    padding: 4px 0;
  }

  .terminal-tab {
    min-width: 0;
    min-height: var(--mar-compact-control-size);
    font-size: calc(var(--mar-font-size-body) - 1px);
  }

  .terminal-tab-select {
    align-items: center;
    min-height: var(--mar-compact-control-size);
    padding: 0.1rem 32px 0.1rem 0.45rem;
    line-height: 1.2;
    white-space: nowrap;
  }

  .terminal-tab-add {
    min-width: var(--mar-compact-control-size);
    padding: 0;
  }

  .terminal-profile {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    white-space: nowrap;
  }

  .terminal-profile .el-select {
    width: 8rem;
  }

  @container (max-width: 36rem) {
    .admin-terminal-header {
      flex-wrap: wrap;
      row-gap: 0;
      padding-top: 0.2rem;
    }

    .terminal-tabs {
      order: 1;
      flex-basis: 100%;
    }
  }
}

@media (max-width: 767px) {
  .admin-terminal {
    background: var(--mar-bg-chrome);
  }

  .admin-terminal-header {
    min-height: 32px;
    flex: none;
    flex-wrap: wrap;
    padding: 0.25rem 0.7rem;
  }

  .admin-terminal-actions {
    min-width: 0;
    max-width: 100%;
  }

  .terminal-tabs {
    order: 1;
    flex-basis: calc(100% + 1.4rem);
    min-width: calc(100% + 1.4rem);
    margin: 0 -0.7rem -0.25rem;
  }
}
</style>

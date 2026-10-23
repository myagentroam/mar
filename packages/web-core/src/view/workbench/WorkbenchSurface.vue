<script
  setup
  lang="ts"
  generic="ManagementSection extends string, RegistrationContext, NodeRegistrationContext"
>
import { marIcon } from '../../util/mar-icons.js';
import MarIcon from '../common/MarIcon.vue';
import LoadingPanel from '../common/LoadingPanel.vue';

import {
  computed,
  defineAsyncComponent,
  h,
  onBeforeUnmount,
  ref,
  type ShallowUnwrapRef
} from 'vue';
import { supportsNodeFeature } from '../../util/node-features.js';
import type { Workspace, WorkspaceQueueItem } from '../../model/workbench.js';
import type { createWorkbenchPageController } from '../../service/WorkbenchPageController.js';
import {
  errorMessage,
  hostedConversationTitle,
  runnerLabel
} from '../../util/workbench-presentation.js';
import WorkspaceInspector from '../../view/workspace/WorkspaceInspector.vue';
import WorkspaceSessionList from '../../view/workspace/WorkspaceSessionList.vue';
import BusyIndicator from '../common/BusyIndicator.vue';
import WorkspaceSessionCleanupDialog from '../../view/workspace/WorkspaceSessionCleanupDialog.vue';
import WorkspaceTabs from '../../view/workspace/WorkspaceTabs.vue';
import WorkspaceRegistrationPicker from '../workspace/WorkspaceRegistrationPicker.vue';
import ConversationHeader from '../../view/conversation/ConversationHeader.vue';
import ConversationScroll from '../../view/conversation/ConversationScroll.vue';
import ConversationTimeline from '../../view/conversation/ConversationTimeline.vue';
import SessionPerformanceInfo from '../../view/conversation/SessionPerformanceInfo.vue';
import ComposerQueue from '../../view/composer/ComposerQueue.vue';
import ComposerToolbar from '../../view/composer/ComposerToolbar.vue';
import ComposerAttachments from '../../view/composer/ComposerAttachments.vue';
import ComposerCommandPicker from '../../view/composer/ComposerCommandPicker.vue';
import ComposerFileReferencePicker from '../../view/composer/ComposerFileReferencePicker.vue';
import WorkbenchHeader from '../../view/workbench/WorkbenchHeader.vue';
import ConversationComposer from '../../view/composer/ConversationComposer.vue';
import TerminalDock from '../../view/terminal/TerminalDock.vue';
import HostedConversationWorkspacePage from '../../view/conversation/HostedConversationWorkspacePage.vue';
import { translate } from '../../service/LocalePreferenceService.js';
import { useManagementComposition } from '../../service/ManagementComposition.js';
import PanelResizeHandle from './PanelResizeHandle.vue';
import { WORKBENCH_PANEL_LIMITS } from '../../service/WorkbenchLayoutService.js';

const loadingComponent = {
  render: () =>
    h(LoadingPanel, { loading: true, variant: 'page', 'aria-label': translate('common.loading') })
};

const SettingsContent = defineAsyncComponent({
  loader: () => import('../settings/SettingsContent.vue'),
  loadingComponent,
  delay: 0
});

const props = defineProps<{
  page: ShallowUnwrapRef<
    ReturnType<
      typeof createWorkbenchPageController<
        ManagementSection,
        RegistrationContext,
        NodeRegistrationContext
      >
    >
  >;
}>();
const managementComposition = useManagementComposition<ManagementSection>();
const managementPage = computed(() =>
  managementComposition.resolve(props.page.managementSection, props.page.admin)
);
const composer = ref<{ focusAt(cursor: number): void; focus(): void }>();
const composerToolbar = ref<{ openModelMenu(): boolean }>();
const cleanupDialogOpen = ref(false);
const inspectorElement = ref<HTMLElement>();
const cleanupTarget = ref<{ readonly nodeId: string; readonly workspace: Workspace }>();
const hostedConversationHeader = computed(() => {
  const workspace = props.page.hostedConversationWorkspace;
  return (
    workspace.snapshot.value?.conversation ??
    workspace.conversations.value.find(
      (conversation) =>
        conversation.nodeId === workspace.selectedNodeId.value &&
        conversation.id === workspace.selectedConversationId.value
    )
  );
});

function openWorkspaceSessionCleanupDialog(): void {
  const nodeId = props.page.workspaceTarget?.nodeId;
  const workspace = props.page.selectedWorkspace;
  if (nodeId === undefined || workspace === undefined) return;
  cleanupTarget.value = { nodeId, workspace };
  cleanupDialogOpen.value = true;
}

async function cleanupWorkspaceSessions(inactiveDays: number) {
  const target = cleanupTarget.value;
  if (target === undefined) return undefined;
  return props.page.cleanupWorkspaceSessions(target.nodeId, target.workspace, inactiveDays);
}

function updateCleanupDialogOpen(value: boolean): void {
  cleanupDialogOpen.value = value;
  if (!value) cleanupTarget.value = undefined;
}

function onComposerKeydown(event: KeyboardEvent): void {
  if (
    event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === 'm' &&
    composerToolbar.value?.openModelMenu()
  ) {
    event.preventDefault();
    return;
  }
  props.page.onComposerKeydown(event);
}

function selectComposerModelEffort(value: string): void {
  props.page.selectComposerModelEffort(value);
  composer.value?.focus();
}

const workspaceImageResourceUrl = computed(() => {
  const nodeId = props.page.workspaceTarget?.nodeId;
  const workspaceId = props.page.workspaceTarget?.workspaceId;
  if (nodeId === undefined || workspaceId === undefined) return undefined;
  return (path: string) =>
    `/api/workspaces/${encodeURIComponent(workspaceId)}/files/content?${new URLSearchParams({ nodeId, path })}`;
});

props.page.setComposerInputFocus((cursor) => composer.value?.focusAt(cursor));
onBeforeUnmount(() => props.page.setComposerInputFocus(() => undefined));
</script>

<template>
  <section
    :class="[
      'workbench',
      {
        settings: page.view !== 'nodes' && page.view !== 'conversations',
        standalone: page.view === 'conversations',
        compact: page.sidebarCollapsed
      }
    ]"
  >
    <el-dialog
      v-if="page.workspaceRegistrationNodeId !== undefined"
      :model-value="true"
      :title="translate('generated.workbenchSurface.registerWorkspace')"
      width="min(980px, calc(100vw - 32px))"
      destroy-on-close
      @update:model-value="
        (value: boolean) => {
          if (!value) page.closeWorkspaceRegistration();
        }
      "
      :close-icon="marIcon('close')"
    >
      <slot name="workspace-registration">
        <WorkspaceRegistrationPicker
          v-model="page.openWorkspaceTools"
          v-model:preserve-git-config="page.workspacePreserveGitConfig"
          :directory="page.workspaceDirectory"
          :selected-path="page.workspacePath"
          :pending-directory-name="page.pendingWorkspaceDirectoryName"
          :loading-directory="page.loadingWorkspaceDirectory"
          :loading="page.loading"
          :node-ready="page.workspaceRegistrationReady"
          :selected-path-valid="page.selectedWorkspaceDirectorySelectable"
          @navigate="page.loadWorkspaceDirectories"
          @select="page.selectWorkspaceDirectory"
          @select-pending="page.selectPendingWorkspaceDirectory"
          @discard-pending="page.discardPendingWorkspaceDirectory"
          @register="page.registerWorkspace"
        />
      </slot>
    </el-dialog>
    <WorkbenchHeader
      :mobile-viewport="page.mobileViewport"
      :view="page.view"
      :sidebar-collapsed="page.sidebarCollapsed"
      :settings-section="page.settingsSection"
      :management-section="page.managementSection"
      :settings-items="page.settingsItems"
      :management-items="page.managementItems"
      :conversation-title="
        hostedConversationHeader === undefined
          ? translate('hostedConversations.temporaryTitle')
          : hostedConversationTitle(hostedConversationHeader)
      "
      @toggle-sidebar="page.sidebarCollapsed = !page.sidebarCollapsed"
    >
      <template v-if="page.view === 'nodes' && !page.mobileViewport" #workspace-tabs>
        <WorkspaceTabs
          placement="header"
          :tabs="page.workspaceTabs"
          :active-tab-id="page.activeWorkspaceTabId"
          :empty-label="
            page.workspaceHost === undefined
              ? translate('workspaceTabs.newTab')
              : page.nodeLabel(page.workspaceHost)
          "
          :empty-context="translate('navigation.selectWorkspace')"
          :node-label="page.workspaceTabNodeLabel"
          :direct-available="page.workspaceDirectAvailable"
          :direct-description="page.workspaceDirectDescription"
          :has-active-run="page.workbenchNotificationService.hasActiveWorkspaceRun"
          :has-unread="page.workbenchNotificationService.hasUnreadWorkspace"
          @activate="page.activateWorkspaceTab"
          @close="page.closeWorkspaceTab"
          @reorder="page.workspaceTabService.move"
          @pin="page.workspaceTabService.setPinned"
        />
      </template>
    </WorkbenchHeader>
    <section v-if="page.view === 'nodes'" class="session-layout">
      <section v-if="page.workspaceTarget === undefined" class="welcome-panel compact-welcome">
        <h1>{{ translate('generated.workbenchSurface.selectAWorkspace') }}</h1>
        <p>
          {{ translate('generated.workbenchSurface.selectANodeInTheResourceExplorer') }}
        </p>
        <p class="workspace-selection-hint">
          {{ translate('generated.workbenchSurface.noNodeConnectedYetCreateARegistration') }}
          <el-button link type="primary" @click="page.openNodeRegistration">{{
            translate('generated.workbenchSurface.openNodeManagement')
          }}</el-button>
        </p>
      </section>
      <template v-else>
        <WorkspaceTabs
          v-if="page.mobileViewport"
          placement="body"
          :tabs="page.workspaceTabs"
          :active-tab-id="page.activeWorkspaceTabId"
          :node-label="page.workspaceTabNodeLabel"
          :direct-available="page.workspaceDirectAvailable"
          :direct-description="page.workspaceDirectDescription"
          :has-active-run="page.workbenchNotificationService.hasActiveWorkspaceRun"
          :has-unread="page.workbenchNotificationService.hasUnreadWorkspace"
          @activate="page.activateWorkspaceTab"
          @close="page.closeWorkspaceTab"
          @reorder="page.workspaceTabService.move"
          @pin="page.workspaceTabService.setPinned"
        />
        <el-alert
          v-if="
            page.workspaceHost?.connected !== false &&
            !page.nodeReady &&
            page.selectedNodeStatus !== undefined
          "
          class="readonly-banner"
          :closable="false"
          show-icon
          :title="
            page.selectedNodeStatus ??
            translate('generated.workbenchSurface.nodeWorkbenchCapabilitiesAreUnavailable')
          "
          type="error"
          ><template #icon><MarIcon name="error" /></template
        ></el-alert>
        <section
          v-if="page.workspaceHost?.connected === false"
          class="workspace-offline-placeholder"
          role="status"
        >
          <div class="workspace-offline-message">
            <MarIcon name="connection" class="workspace-offline-icon" aria-hidden="true" />
            <p>{{ translate('generated.workbenchSurface.offlineWorkspace') }}</p>
          </div>
        </section>
        <section
          v-if="
            page.workspaceHost?.connected !== false &&
            page.workspaceTarget !== undefined &&
            page.selectedWorkspace === undefined
          "
          class="welcome-panel compact-welcome workspace-selection-panel"
        >
          <div
            v-if="page.workspaceSelectionLoading"
            class="page-loading-state"
            role="status"
            :aria-label="translate('common.loading')"
          >
            <BusyIndicator />
          </div>
          <el-empty
            v-else
            :description="translate('generated.workbenchSurface.workspaceMetadataUnavailable')"
          >
            <el-button @click="page.retryWorkspaceSelection">{{
              translate('generated.workbenchSurface.retryWorkspace')
            }}</el-button>
          </el-empty>
        </section>
        <div
          v-else-if="page.selectedWorkspace !== undefined"
          v-show="page.workspaceHost?.connected !== false"
          :class="['workspace-grid', `mobile-surface-${page.mobileWorkspaceSurface}`]"
        >
          <WorkspaceSessionList
            :sessions="page.visibleWorkspaceSessions"
            :selected-session-id="page.selectedSessionId"
            :mobile-viewport="page.mobileViewport"
            :can-load-more="page.canLoadMoreWorkspaceSessions"
            :loading-more="page.loadingMoreWorkspaceSessions"
            :load-more-error="page.loadMoreWorkspaceSessionsError"
            :active="
              (!page.mobileViewport || page.mobileWorkspaceSurface === 'sessions') &&
              page.workspaceHost?.connected !== false
            "
            :watch-status="page.workspaceWatchTopicStatus.sessions"
            :node-ready="page.nodeReady"
            :loading="page.loading"
            :workspace-kind="page.selectedWorkspace?.kind"
            :workspace-kind-label="page.workspaceKindLabel(page.selectedWorkspace)"
            :workspace-branch="page.workspaceBranchLabel(page.selectedWorkspace)"
            :title="page.sessionTitle"
            :runner-icon="page.runnerBrandIcon"
            :activity="page.sessionActivity"
            :can-delete-session="page.canDeleteSession"
            :activity-label="page.sessionActivityLabel"
            :activity-date-time="page.sessionActivityDateTime"
            :activity-title="page.sessionActivityTitle"
            :relative-activity="page.sessionRelativeActivity"
            :node-id="page.workspaceTarget?.nodeId"
            :workspace-id="page.selectedWorkspace.id"
            :skill-supported="true"
            :mcp-supported="true"
            :cleanup-sessions-supported="page.cleanupSessionsEnabled"
            :session-prompt-supported="
              supportsNodeFeature(page.workspaceHost?.nodeAppVersion ?? '', 'SESSION_PROMPT')
            "
            :search-supported="page.workspaceSessionSearchEnabled"
            :search-query="page.workspaceSessionSearchQuery"
            :searching="page.searchingWorkspaceSessions"
            :refreshing="page.refreshingWorkspaceSessions"
            :workspace-manageable="page.selectedWorkspace.manageable !== false"
            :request="page.request"
            :has-unread="
              (sessionId) =>
                page.workbenchNotificationService.hasUnreadSession(
                  page.workspaceTarget?.nodeId!,
                  page.selectedWorkspace!.id,
                  sessionId
                )
            "
            @create="page.openNewSessionComposer"
            @open="page.openSessionFromList"
            @rename="page.renameSession"
            @pin="page.setSessionPinned"
            @move-pin="page.movePinnedSession"
            @move-pin-to="page.movePinnedSessionTo"
            @delete-session="page.deleteSession"
            @cleanup-sessions="openWorkspaceSessionCleanupDialog"
            @load-more="page.loadMoreWorkspaceSessions"
            @search="page.searchWorkspaceSessions"
            @refresh="page.refreshWorkspaceSessions"
          />
          <WorkspaceSessionCleanupDialog
            v-if="cleanupDialogOpen && cleanupTarget !== undefined"
            :model-value="cleanupDialogOpen"
            :cleanup="cleanupWorkspaceSessions"
            @update:model-value="updateCleanupDialogOpen"
          />
          <section
            class="conversation-panel"
            :aria-label="translate('generated.workbenchSurface.agentConversation')"
          >
            <template v-if="page.composerSessionOpen">
              <ConversationHeader
                :session="page.selectedSession"
                :runner="page.composerRunner"
                :files-ready="page.filesReady"
                :terminal-ready="page.terminalReady"
                :runner-icon="page.runnerBrandIcon"
                :session-title="page.sessionTitle"
                :activity="page.sessionActivity"
                :activity-label="page.sessionActivityLabel"
                :content-search-ready="page.contentSearchReady"
                @open-surface="page.openMobileWorkspaceSurface"
              />
              <ConversationScroll
                :has-older="page.conversationNextCursor !== null"
                :loading-initial="page.loadingInitialConversation"
                :initial-load-failed="page.initialConversationLoadFailed"
                :loading-older="page.loadingOlderConversation"
                :older-error="page.olderHistoryError"
                :has-turns="page.conversationTurns.length > 0"
                :following="page.followConversation"
                @scroll-element="page.conversationScroll = $event"
                @scroll="page.onComposerScroll"
                @load-older="page.loadOlderConversationTurns"
                @latest="page.scrollConversationToLatest"
                @reload="page.reloadSelectedSession"
              >
                <ConversationTimeline
                  :runs="page.conversationRuns"
                  :turns="page.displayedConversationTurns"
                  :initializing="page.loadingInitialConversation"
                  :initial-render-version="page.conversationInitialRenderVersion"
                  :workspace-root="page.selectedWorkspace?.path"
                  :image-resource-url="workspaceImageResourceUrl"
                  :loading="page.loading || page.composerSubmitting"
                  :image-attachments="page.userMessageImageAttachments"
                  :user-input-questions="page.userInputQuestions"
                  :user-input-answer="page.userInputAnswer"
                  :user-input-submitted="page.userInputSubmitted"
                  :plan-continuation="page.activePlanContinuation"
                  :node-ready="page.nodeReady"
                  :synchronized="page.liveConnected && !page.conversationSyncPending"
                  :tool-change-enabled="
                    page.nodeReady &&
                    supportsNodeFeature(
                      page.workspaceHost?.nodeAppVersion ?? '',
                      'TOOL_RESULT_DIFF'
                    )
                  "
                  :rewind-enabled="page.rewindConversationEnabled"
                  :rollback-enabled="page.rollbackConversationEnabled"
                  @initial-rendered="page.confirmConversationInitialRender"
                  @open-image="page.openConversationImagePreview"
                  @image-unavailable="page.markRunImageUnavailable"
                  @open-file="page.openAgentWorkspaceFile"
                  @open-file-change="page.openAgentFileChange"
                  @set-answer="page.setUserInputAnswer"
                  @submit-input="page.submitUserInput"
                  @implement-plan="page.implementPlan"
                  @copy="page.copyConversationMessage"
                  @rewind="page.rewindConversation"
                  @rollback="page.rollbackConversation"
                  @decide-approval="page.decideApproval"
                />
                <template #status>
                  <SessionPerformanceInfo :performance="page.sessionPerformance" />
                </template>
              </ConversationScroll>
              <ConversationComposer
                ref="composer"
                v-model:input="page.sessionInput"
                :placeholder="
                  page.selectedRunnerCommand
                    ? translate('generated.workbenchSurface.run', {
                        value0: page.selectedRunnerCommand.id
                      })
                    : page.composerInputDisabled
                      ? page.nodeManifest === undefined &&
                        page.workspaceHost?.connected === true &&
                        page.workspaceHost.disabled !== true
                        ? page.nodeManifestLoading
                          ? translate('generated.workspaceInspector.loading')
                          : translate(
                              'generated.workbenchSurface.nodeWorkbenchCapabilitiesAreUnavailable'
                            )
                        : translate('generated.workbenchSurface.thisSessionIsReadOnly')
                      : translate(
                          'generated.workbenchSurface.typeForCommandsToReferenceWorkspaceFiles',
                          {
                            value0: runnerLabel(page.composerRunner)
                          }
                        )
                "
                :working="page.composerWorking"
                :working-label="page.composerWorkingLabel"
                :working-busy="page.composerWorkingBusy"
                :elapsed-label="page.composerElapsedLabel"
                :connection-busy="!page.liveConnected || page.conversationSyncPending"
                :connection-label="
                  !page.liveConnected
                    ? translate('conversationActivity.reconnecting')
                    : page.conversationSyncPending
                      ? translate('conversationActivity.syncing')
                      : ''
                "
                :readonly="page.composerInputDisabled"
                :drop-target="page.draggingComposerAttachments"
                :mobile-viewport="page.mobileViewport"
                :command-states="page.activeCommandStates"
                :loading="page.loading || page.composerSubmitting"
                :skill-tokens="page.composerSkillTokens"
                :file-references="page.composerFileReferences"
                :completion="page.workPromptCompletion"
                :completion-blocked="
                  page.commandPickerOpen ||
                  page.fileReferencePickerOpen ||
                  page.selectedRunnerCommand !== undefined ||
                  page.composerAttachmentsPending
                "
                @submit="page.sendSessionMessage"
                @input="page.onComposerInput"
                @keydown="onComposerKeydown"
                @cursor="page.onComposerCursor"
                @paste="page.onNewSessionPaste"
                @dragenter="page.onComposerAttachmentDragEnter"
                @dragleave="page.onComposerAttachmentDragLeave"
                @drop="page.onComposerAttachmentDrop"
                @close-command="page.closeCommandState"
                @remove-skill="page.removeComposerSkillToken"
                @remove-reference="page.removeComposerFileReference"
              >
                <template #queue>
                  <ComposerQueue
                    :items="page.currentSessionQueue.items"
                    :paused="page.currentSessionQueue.paused"
                    :loading="page.loading || page.composerSubmitting"
                    :editing-queue-item-id="page.editingQueueItemId"
                    :editing-content="page.editingQueueContent"
                    :goal="page.activeGoal"
                    @drag-start="page.draggingQueueItemId = $event"
                    @reorder="page.reorderWorkspaceQueue"
                    @edit="page.composerQueueService.startEditing($event)"
                    @update-content="page.editingQueueContent = $event"
                    @save="page.saveQueuedMessage"
                    @execute="
                      (item, editedContent) =>
                        page.executeQueuedMessage(item as WorkspaceQueueItem, editedContent)
                    "
                    @delete-item="page.deleteQueuedMessage"
                    @save-goal="page.editGoal"
                    @clear-goal="page.clearGoal"
                  />
                </template>
                <template #toolbar>
                  <ComposerToolbar
                    :submitting="page.composerSubmitting"
                    v-if="page.canUseComposer"
                    ref="composerToolbar"
                    :draft-session-open="page.composerDraftOpen"
                    :runner="page.newSessionRunner"
                    :runner-options="page.composerRunnerOptions"
                    :runner-loading="page.runnerProfilesLoading"
                    :runner-disabled="
                      !page.draftSessionOpen || page.loading || page.composerSubmitting
                    "
                    :runner-label="page.composerRunnerLabel"
                    :model-effort-selection="page.composerModelEffortSelection"
                    :model-effort-label="page.composerModelEffortLabel"
                    :selected-model="page.newSessionModel"
                    :selected-effort="page.newSessionEffort"
                    :models="page.composerModels"
                    :efforts="page.composerEfforts"
                    :access="page.newSessionAccess"
                    :access-label="page.composerAccessLabel"
                    :access-options="page.composerAccessOptions"
                    :configuration-disabled="page.composerConfigurationDisabled"
                    :access-disabled="page.composerAccessDisabled"
                    :fast-enabled="page.codexFastEnabled"
                    :context-usage="page.sessionContextUsage"
                    :context-usage-label="page.contextUsageLabel"
                    :can-compact-context="page.canCompactContext"
                    :mobile-viewport="page.mobileViewport"
                    :active-run="page.activeComposerRun"
                    :interrupt-visible="page.interruptVisible"
                    :can-interrupt="page.canInterruptTurn"
                    :input-has-content="
                      page.sessionInput.trim().length > 0 ||
                      page.composerSkillTokens.length > 0 ||
                      page.composerFileReferences.length > 0 ||
                      page.newSessionAttachments.length > 0
                    "
                    :has-selected-command="page.composerCommandReady"
                    :loading="page.loading || page.composerSubmitting"
                    :attachments-pending="page.composerAttachmentsPending"
                    :effort-label="page.effortLabel"
                    @files="page.addNewSessionFiles"
                    @update-runner="page.selectComposerRunner"
                    @update-model-effort="selectComposerModelEffort"
                    @update-access="page.selectComposerAccess"
                    @compact="page.compactCurrentContext"
                    @stop="page.stopActiveRun"
                  />
                </template>
                <template #attachments>
                  <ComposerAttachments
                    :attachments="page.newSessionAttachments"
                    @preview="page.openAttachmentPreview"
                    @remove-attachment="page.removeNewSessionAttachment"
                  />
                </template>
                <template #picker>
                  <ComposerCommandPicker
                    :open="page.commandPickerOpen"
                    :commands="
                      page.composerPickerKind === 'runner' ? page.visibleRunnerCommands : []
                    "
                    :skills="page.composerPickerKind === 'runner' ? page.visibleComposerSkills : []"
                    :quick-prompts="
                      page.composerPickerKind === 'quick-prompt' ? page.visibleQuickPrompts : []
                    "
                    :quick-prompts-loading="page.quickPromptsLoading"
                    :quick-prompts-failed="page.quickPromptsFailed"
                    :picker-kind="page.composerPickerKind"
                    :skills-enabled="page.composerSkillsSupported"
                    :skills-loading="page.composerSkillsLoading"
                    :skills-failed="page.composerSkillsFailed"
                    :active-index="page.activeRunnerCommandIndex"
                    :loading="page.runnerProfilesLoading"
                    :failed="page.runnerProfilesFailed"
                    @activate="page.activeRunnerCommandIndex = $event"
                    @select="page.selectRunnerCommand"
                    @select-skill="page.selectComposerSkill"
                    @select-quick-prompt="page.selectComposerQuickPrompt"
                  />
                  <ComposerFileReferencePicker
                    :open="page.fileReferencePickerOpen"
                    :entries="page.fileReferenceEntries"
                    :active-index="page.activeFileReferenceIndex"
                    :loading="page.fileReferenceLoading"
                    :query="page.activeFileReferenceMatch?.query ?? ''"
                    @activate="page.activeFileReferenceIndex = $event"
                    @select="page.selectFileReference"
                  />
                </template>
              </ConversationComposer>
            </template>
          </section>
          <aside
            ref="inspectorElement"
            class="inspector-column"
            :aria-label="translate('generated.workbenchSurface.readOnlyInspector')"
          >
            <PanelResizeHandle
              class="inspector-resize"
              :target="inspectorElement"
              :label="translate('generated.panelResize.files')"
              :min="WORKBENCH_PANEL_LIMITS.inspector.min"
              :max="WORKBENCH_PANEL_LIMITS.inspector.max"
              :direction="-1"
              @resize="page.setPanelWidth('inspector', $event)"
            />
            <WorkspaceInspector
              :ref="(instance) => (page.workspaceInspector = instance as never)"
              :node-id="page.workspaceTarget?.nodeId"
              :workspace-id="page.workspaceTarget?.workspaceId"
              :workspace-name="
                page.selectedWorkspace === undefined
                  ? translate('generated.workbenchSurface.workspace')
                  : page.workspaceTabLabel(page.selectedWorkspace)
              "
              :workspace-kind="page.selectedWorkspace?.kind"
              :workspace-path="page.selectedWorkspace?.path"
              :history-capability="page.nodeManifest?.git?.supportsHistory"
              :csrf-token="page.csrfToken"
              :renew-csrf-token="page.renewCsrfToken"
              :enabled="page.filesReady"
              :prediction-enabled="page.workPromptCompletion.enabled"
              :capability-loading="page.nodeManifestLoading && page.nodeManifest === undefined"
              :node-online="
                page.workspaceHost?.connected === true && page.workspaceHost.disabled !== true
              "
              :mobile-viewport="page.mobileViewport"
              :content-search-enabled="page.contentSearchReady"
              :code-navigation-enabled="page.codeNavigationReady"
              :code-navigation-prewarm-enabled="page.codeNavigationPrewarmReady"
              :file-write-enabled="page.fileWriteReady"
              :files-revision="page.workspaceFilesRevision"
              :changes-revision="page.workspaceChangesRevision"
              :subscription-snapshot="page.workspaceWatchSnapshot"
              :files-watch-status="page.workspaceWatchTopicStatus.files"
              :changes-watch-status="page.workspaceWatchTopicStatus.changes"
              :direct-file-download="page.directWorkspaceFileDownload"
              :direct-file-object-url="page.directWorkspaceFileObjectUrl"
              :direct-file-read-range="page.directWorkspaceFileReadRange"
              :direct-git-file-download="page.directGitFileDownload"
              :direct-git-file-object-url="page.directGitFileObjectUrl"
              :direct-git-file-read-range="page.directGitFileReadRange"
              :standalone-file-mode="page.standaloneFileMode"
              @directory="page.changeWorkspaceWatchDirectory"
              @branch="
                (workspaceId, branch) =>
                  page.updateWorkspaceBranch(
                    page.workspaceTarget?.nodeId ?? '',
                    workspaceId,
                    branch
                  )
              "
              @workspace="page.updateWorkspaceMetadata(page.workspaceTarget?.nodeId ?? '', $event)"
              @notice="page.notice = $event"
              @uploads="page.queueWorkspaceUploads"
            />
          </aside>
        </div>
        <div
          v-for="tab in page.workspaceTabs"
          :key="tab.id"
          v-show="tab.id === page.activeWorkspaceTabId && page.terminalReady"
          :class="[
            'terminal-dock',
            { 'mobile-active': page.mobileWorkspaceSurface === 'terminal' }
          ]"
        >
          <TerminalDock
            :error-message="errorMessage"
            :ref="
              (instance) => {
                if (instance === null) page.terminalDocks.delete(tab.id);
                else
                  page.terminalDocks.set(
                    tab.id,
                    instance as unknown as {
                      release(): Promise<void>;
                      toggle(): Promise<void>;
                    }
                  );
              }
            "
            :node-id="tab.nodeId"
            :direct="page.terminalDirectClient"
            :workspace-id="tab.workspaceId"
            :csrf-token="page.csrfToken"
            :renew-csrf-token="page.renewCsrfToken"
            :enabled="tab.id === page.activeWorkspaceTabId && page.terminalReady"
            :capability="page.nodeManifest?.terminal"
            :node-os-release="
              page.nodes.find((node) => node.id === tab.nodeId)?.metadata?.osRelease
            "
            :visible="
              tab.id === page.activeWorkspaceTabId &&
              page.terminalReady &&
              (!page.mobileViewport || page.mobileWorkspaceSurface === 'terminal')
            "
            :mobile-mode="page.mobileViewport"
            :active="tab.id === page.activeWorkspaceTabId"
            @collapse="page.mobileViewport && page.closeMobileWorkspaceSurface()"
            @notice="page.notice = $event"
          />
        </div>
      </template>
    </section>
    <HostedConversationWorkspacePage
      v-else-if="page.view === 'conversations'"
      :connected="page.liveConnected"
      :workspace="page.hostedConversationWorkspace"
      :request="page.request"
      :mobile-viewport="page.mobileViewport"
      :mobile-history-open="page.hostedConversationMobileHistoryOpen"
      :sidebar-collapsed="page.sidebarCollapsed"
      :select-conversation="page.selectHostedConversation"
      :route-target="page.hostedConversationRoute"
      :restoring-route="page.restoringHostedConversationRoute"
      :clear-conversation="page.clearHostedConversation"
      :has-unread-conversation="page.workbenchNotificationService.hasUnreadConversation"
      @close-mobile-history="page.closeHostedConversationMobileHistory"
    />
    <template v-else-if="page.view === 'settings'">
      <slot name="settings">
        <SettingsContent
          :web-version="page.webVersion"
          v-model:new-password="page.newPassword"
          :section="page.settingsSection"
          :sessions="page.adminSessions"
          :password-validation-error="page.passwordValidationError"
          :registration-token="page.registrationToken"
          :loading="page.loading"
          :format-session-time="page.formatSessionTime"
          :request="page.request"
          :quick-prompts="page.quickPrompts"
          :quick-prompts-loading="page.quickPromptsLoading"
          :quick-prompts-failed="page.quickPromptsFailed"
          :refresh-quick-prompts="page.refreshQuickPrompts"
          :system-notifications="page.workbenchNotificationService.systemNotifications"
          @clear-password-error="page.passwordValidationError = ''"
          @refresh-sessions="page.refreshAdminSessions"
          @logout-session="page.logoutAdminSession"
          :change-password="page.changePassword"
          @logout="page.logout"
          @create-registration-token="page.createRegistrationToken"
        />
      </slot>
    </template>
    <template v-else>
      <slot name="management-notice" />
      <component
        :is="managementPage.component"
        :key="managementPage.id"
        v-bind="managementPage.props(page)"
        @changed="page.refreshNodes"
        @extension-changed="page.refreshAdmin"
      />
    </template>
  </section>
</template>

<style scoped>
.session-layout {
  --workspace-layout-inset: 0px;
  display: flex;
  height: calc(100vh - var(--mar-workbench-header-height));
  min-height: 0;
  flex-direction: column;
  box-sizing: border-box;
  overflow: hidden;
  padding: 0;
}

.welcome-panel {
  display: grid;
  max-width: 560px;
  min-height: 260px;
  align-content: center;
  justify-items: start;
  gap: 0.35rem;
  border: 1px solid var(--mar-border-medium);
  border-radius: 5px;
  background: var(--mar-bg-panel);
  padding: 2rem;
}

.welcome-panel h1 {
  margin: 0;
}

.welcome-panel p {
  max-width: 430px;
  margin-bottom: 0.8rem;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-body);
  line-height: 1.6;
}

.compact-welcome {
  flex: 1 1 auto;
  width: 100%;
  max-width: none;
  min-height: 0;
  margin: 0.45rem 0 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  overflow: auto;
  align-content: start;
  justify-items: stretch;
  padding: 1rem clamp(0.9rem, 1.6vw, 1.25rem);
}

.workspace-selection-panel > h1 {
  font-size: var(--mar-font-size-page-title);
}

.workspace-selection-panel > p {
  max-width: 720px;
  margin-bottom: 0.25rem;
}

.workspace-selection-hint {
  color: var(--mar-text-tertiary) !important;
  font-size: var(--mar-font-size-meta) !important;
}

.readonly-banner {
  border-radius: 0;
  margin: 0;
  --el-alert-bg-color: var(--mar-color-danger-bg);
  --el-color-error: var(--mar-color-danger-text);
}

.workspace-offline-placeholder {
  display: grid;
  min-height: 0;
  flex: 1 1 auto;
  place-items: center;
  padding: 2rem 1.5rem;
  color: var(--mar-text-secondary);
  text-align: center;
}

.workspace-offline-message {
  display: grid;
  max-width: 28rem;
  justify-items: center;
  gap: 0.5rem;
}

.workspace-offline-icon {
  position: relative;
  color: var(--mar-text-muted);
  font-size: 1.75rem;
}

.workspace-offline-icon::after {
  position: absolute;
  width: 115%;
  height: 1px;
  border-radius: 1px;
  background: currentColor;
  content: '';
  transform: rotate(-45deg);
}

.workspace-offline-message p {
  margin: 0;
  font-size: var(--mar-font-size-meta);
  line-height: 1.5;
  overflow-wrap: anywhere;
}

@media (max-width: 767px) {
  .workspace-offline-icon {
    font-size: 1.5rem;
  }

  .workspace-offline-message p {
    font-size: var(--mar-font-size-body);
  }
}

.workspace-grid {
  display: grid;
  height: 0;
  grid-template-columns:
    var(--mar-session-sidebar-width) minmax(360px, 1fr)
    min(
      var(--mar-inspector-width, var(--mar-inspector-max-width)),
      max(var(--mar-inspector-min-width), calc(100% - var(--mar-session-sidebar-width) - 360px))
    );
  width: 100%;
  max-width: 100%;
  min-height: 0;
  min-width: 0;
  flex: 1 1 auto;
  border: 0;
  border-bottom: 1px solid var(--mar-border-default);
  border-radius: 0;
  margin-top: 0;
  overflow: hidden;
}

.conversation-panel {
  position: relative;
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  background: var(--mar-bg-panel);
}

.inspector-column {
  position: relative;
  border-left: 1px solid var(--mar-border-subtle);
  background: var(--mar-bg-chrome);
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.inspector-column > :deep(.workspace-inspector) {
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
}

.inspector-resize {
  left: -4px;
}

.terminal-dock {
  flex: none;
  margin-top: 0;
  border: 0;
  border-radius: 0;
  overflow: hidden;
}

@media (max-width: 1180px) {
  .inspector-resize {
    display: none;
  }

  .workspace-grid {
    grid-template-columns: min(242px, var(--mar-session-sidebar-width)) minmax(340px, 1fr);
  }
}

@media (max-width: 1180px) {
  .inspector-column {
    grid-column: 1 / -1;
    max-height: 350px;
    border-top: 1px solid var(--mar-border-strong);
    border-left: 0;
  }
}

@media (max-width: 767px) {
  .workspace-grid {
    position: relative;
    height: 0;
    min-height: 0;
    grid-template-rows: minmax(0, 1fr);
    grid-template-columns: 1fr;
    flex: 1 1 auto;
    overflow: hidden;
  }
}

@media (max-width: 767px) {
  .session-layout {
    height: auto;
    min-height: 0;
    flex: 1 1 auto;
    overflow: hidden;
  }
}

@media (max-width: 767px) {
  .inspector-column {
    max-height: none;
    background: var(--mar-bg-chrome);
  }
}

@media (max-width: 767px) {
  .workspace-grid.mobile-surface-inspector .inspector-column {
    transform: translateX(0);
    visibility: visible;
    pointer-events: auto;
    transition:
      transform 0.16s ease,
      visibility 0s;
  }
}

@media (max-width: 767px) {
  .conversation-panel {
    grid-area: 1 / 1;
    min-height: 0;
  }
}

@media (max-width: 767px) {
  .terminal-dock {
    display: flex;
    min-height: 0;
    flex-direction: column;
    background: var(--mar-bg-chrome);
  }
}

@media (max-width: 767px) {
  .terminal-dock.mobile-active {
    transform: translateY(0);
    visibility: visible;
    pointer-events: auto;
    transition:
      transform 0.16s ease,
      visibility 0s;
  }
}
</style>

<style scoped>
.workbench {
  display: flex;
  height: 100vh;
  min-height: 100vh;
  flex-direction: column;
  margin-left: var(--mar-workbench-sidebar-total-width);
  overflow: hidden;
  background: var(--mar-bg-panel);
}

.workbench.compact {
  margin-left: var(--mar-activity-rail-width);
}

@media (min-width: 768px) and (prefers-reduced-motion: no-preference) {
  .workbench {
    transition: margin-left var(--mar-motion-duration-collapse) var(--mar-motion-easing-collapse);
  }

  .console-shell:has(.workspace-tree-resize.dragging) .workbench {
    transition: none;
  }
}

.workbench.standalone {
  margin-left: var(--mar-workbench-sidebar-total-width);
}

.workbench.standalone.compact {
  margin-left: var(--mar-activity-rail-width);
}

.workbench.settings {
  margin-left: var(--mar-workbench-sidebar-total-width);
}

.workbench.settings.compact {
  margin-left: var(--mar-activity-rail-width);
}

.workbench.settings :deep(.settings-content) {
  min-height: 0;
  flex: 1 1 auto;
  overflow: auto;
}

.workspace-selection-panel :deep(.workspace-tools) {
  width: 100%;
  max-width: 1080px;
  margin-top: 0.55rem;
}

.workspace-selection-panel :deep(.workspace-tools .el-collapse-item__content) {
  padding-top: 0.35rem;
}

@media (max-width: 767px) {
  .workbench,
  .workbench.compact,
  .workbench.standalone,
  .workbench.standalone.compact,
  .workbench.settings,
  .workbench.settings.compact {
    display: flex;
    min-height: 0;
    flex: 1 1 auto;
    flex-direction: column;
    margin-left: 0;
    overflow: hidden;
  }

  .workbench.settings :deep(.settings-content) {
    min-height: 0;
    flex: 1 1 auto;
    overflow: auto;
  }

  .conversation-sidebar,
  .inspector-column {
    position: fixed;
    z-index: 12;
    inset: var(--sidebar-header-height) auto 0 0;
    width: min(300px, calc(100vw - 48px));
    border: 0;
    border-right: 1px solid var(--mar-border-strong);
    box-shadow: 10px 0 24px var(--mar-shadow-medium);
    transform: translateX(-104%);
    visibility: hidden;
    pointer-events: none;
    transition:
      transform 0.16s ease,
      visibility 0.16s step-end;
  }

  .workspace-grid.mobile-surface-sessions .conversation-sidebar {
    transform: translateX(0);
    visibility: visible;
    pointer-events: auto;
    transition:
      transform 0.16s ease,
      visibility 0s;
  }

  .terminal-dock {
    position: fixed;
    z-index: 12;
    inset: auto 0 0;
    width: 100%;
    height: 50dvh;
    box-sizing: border-box;
    padding-bottom: env(safe-area-inset-bottom, 0px);
    border-top: 1px solid var(--mar-border-strong);
    box-shadow: 0 -10px 24px var(--mar-shadow-medium);
    transform: translateY(104%);
    visibility: hidden;
    pointer-events: none;
    transition:
      transform 0.16s ease,
      visibility 0.16s step-end;
  }

  .terminal-dock :deep(.admin-terminal) {
    display: flex;
    min-height: 0;
    flex: 1 1 auto;
    flex-direction: column;
  }

  .terminal-dock :deep(.admin-terminal > div) {
    display: flex;
    min-height: 0;
    flex: 1 1 auto;
    flex-direction: column;
  }

  .terminal-dock :deep(.terminal-context-cache) {
    display: flex;
    min-height: 0;
    flex: 1 1 auto;
    flex-direction: column;
  }

  .terminal-dock :deep(.admin-terminal-body) {
    block-size: auto;
    min-height: 0;
    flex: 1 1 auto;
  }
}

@media (prefers-reduced-motion: reduce) {
  .workbench,
  .terminal-dock,
  .terminal-dock.mobile-active {
    transition: none;
  }
}
</style>

<style scoped>
:global(.workspace-selection-hint .el-button) {
  vertical-align: baseline;
}
</style>

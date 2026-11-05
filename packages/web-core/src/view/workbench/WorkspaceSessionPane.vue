<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, proxyRefs, ref } from 'vue';
import type { ComposerAttachment, WorkspaceQueueItem } from '../../model/workbench.js';
import type { NavigationSummary } from '../../service/session-navigation-projection.js';
import type { createWorkspaceSessionPaneController } from '../../service/workspace-session-pane-controller.js';
import { runnerBrandIcon } from '../../util/runner-brand-icon.js';
import { translate } from '../../service/locale-preference-service.js';
import { runnerLabel } from '../../util/workbench-presentation.js';
import { userInputQuestions } from '../../util/conversation-presentation.js';
import { sessionTitle } from '../../util/session-presentation.js';
import { errorMessage } from '../../util/error-presentation.js';
import WorkspaceSessionTreeButton from '../workspace/WorkspaceSessionTreeButton.vue';
import ConversationHeader from '../conversation/ConversationHeader.vue';
import ConversationScroll from '../conversation/ConversationScroll.vue';
import ConversationTimeline from '../conversation/ConversationTimeline.vue';
import SessionPerformanceInfo from '../conversation/SessionPerformanceInfo.vue';
import ComposerQueue from '../composer/ComposerQueue.vue';
import ComposerToolbar from '../composer/ComposerToolbar.vue';
import ComposerAttachments from '../composer/ComposerAttachments.vue';
import ComposerCommandPicker from '../composer/ComposerCommandPicker.vue';
import ComposerReferencePicker from '../composer/ComposerReferencePicker.vue';
import ConversationComposer from '../composer/ConversationComposer.vue';

const props = defineProps<{
  controller: ReturnType<typeof createWorkspaceSessionPaneController>;
  treeSupported?: boolean;
  asideReady?: boolean;
  treeOpenSessionId?: string | undefined;
  treeSummaries?: readonly NavigationSummary[] | undefined;
  treeStatus?: 'idle' | 'loading' | 'ready' | 'failed';
}>();
const state = props.controller.state;
const workspaceTarget = state.workspaceTarget;
const presentation = proxyRefs(props.controller.presentation);
const configuration = proxyRefs(props.controller.configuration);
const runner = proxyRefs(props.controller.runner);
const interactions = props.controller.interactions;
const references = proxyRefs(props.controller.references);
const queueView = props.controller.currentSessionQueue;
const submitting = props.controller.submitting;
const canInterrupt = props.controller.canInterrupt;
const performance = props.controller.performance.current;
const olderHistoryError = props.controller.conversationWindow.paging.olderHistoryError;
const sessionContextKey = computed(() =>
  JSON.stringify([
    state.workspaceTarget.value?.nodeId,
    state.workspaceTarget.value?.workspaceId,
    props.controller.selectedSessionId.value
  ])
);
const emit = defineEmits<{
  openTree: [sessionId: string, anchor: HTMLElement, title: string];
  openSurface: [surface: 'sessions' | 'inspector' | 'terminal'];
  previewAttachment: [attachment: ComposerAttachment];
  reload: [];
}>();
const composer = ref<{
  readonly $el: HTMLElement;
  focusAt(cursor: number): void;
  focus(): void;
  replaceRange(start: number, end: number, text: string): boolean;
}>();
const composerToolbar = ref<{ openModelMenu(): boolean }>();

let unregisterComposerShortcut: (() => void) | undefined;
let unregisterComposerActions: (() => void) | undefined;
onMounted(() => {
  unregisterComposerShortcut = state.registerShortcuts(
    () => composer.value?.$el,
    () => composerToolbar.value?.openModelMenu() === true
  );
  unregisterComposerActions = props.controller.interactions.registerShortcuts(
    () => composer.value?.$el.querySelector('textarea') ?? undefined
  );
});

function selectComposerModelEffort(value: string): void {
  props.controller.selectModelEffort(value);
  composer.value?.focus();
}

const workspaceImageResourceUrl = computed(() => {
  const nodeId = state.workspaceTarget.value?.nodeId;
  const workspaceId = state.workspaceTarget.value?.workspaceId;
  if (nodeId === undefined || workspaceId === undefined) return undefined;
  return (path: string) =>
    `/api/workspaces/${encodeURIComponent(workspaceId)}/files/content?${new URLSearchParams({ nodeId, path })}`;
});

state.setInputFocus((cursor) => composer.value?.focusAt(cursor));
state.setRangeEditor((start, end, text) => composer.value?.replaceRange(start, end, text) ?? false);
onBeforeUnmount(() => {
  unregisterComposerShortcut?.();
  unregisterComposerActions?.();
  state.setInputFocus(() => undefined);
  state.setRangeEditor(() => false);
});
</script>

<template>
  <section
    class="conversation-panel"
    :aria-label="translate('generated.workbenchSurface.agentConversation')"
  >
    <template v-if="presentation.composerSessionOpen">
      <ConversationHeader
        :session="configuration.selectedSession"
        :runner="configuration.activeRunner"
        :files-ready="controller.filesReady.value"
        :terminal-ready="controller.terminalReady.value"
        :aside-ready="asideReady"
        :runner-icon="runnerBrandIcon"
        :session-title="sessionTitle"
        :content-search-ready="controller.filesReady.value"
        @open-surface="emit('openSurface', $event)"
      >
        <template #tree="{ sessionId }">
          <WorkspaceSessionTreeButton
            v-if="workspaceTarget && treeSupported"
            :key="sessionId"
            :session-id="sessionId"
            :open="treeOpenSessionId === sessionId"
            :summary="treeSummaries?.find((item) => item.anchorSessionId === sessionId)"
            :status="treeStatus ?? 'idle'"
            @show="
              (id, anchor) =>
                emit(
                  'openTree',
                  id,
                  anchor,
                  configuration.selectedSession ? sessionTitle(configuration.selectedSession) : id
                )
            "
          />
        </template>
      </ConversationHeader>
      <ConversationScroll
        :context-key="sessionContextKey"
        :has-older="state.conversation.nextCursor.value !== null"
        :loading-initial="controller.status.initialContentLoading()"
        :initial-sync-pending="state.conversation.loadingInitial.value"
        :initial-load-failed="state.conversation.initialLoadFailed.value"
        :initial-error="
          state.conversation.initialLoadFailed.value
            ? errorMessage(state.conversation.initialFailureCause.value)
            : undefined
        "
        :loading-older="state.conversation.loadingOlder.value"
        :older-error="olderHistoryError"
        :has-turns="state.conversation.turns.value.length > 0"
        :following="state.scroll.following.value"
        :empty-prompt="controller.draftOpen.value ? 'workspace' : undefined"
        @scroll-element="state.scroll.setElement($event)"
        @scroll="interactions.onComposerScroll"
        @scroll-intent="state.scroll.stopFollowing"
        @load-older="controller.conversationWindow.paging.loadOlderConversationTurns"
        @latest="interactions.scrollConversationToLatest"
        @reload="emit('reload')"
      >
        <ConversationTimeline
          :runs="controller.conversationRuns.value"
          :turns="presentation.displayedConversationTurns"
          :performance="performance"
          :initializing="controller.status.initialContentLoading()"
          :initial-render-version="state.conversation.initialRenderVersion.value"
          :capture-render-anchor="state.scroll.captureRenderAnchor"
          :workspace-root="controller.selectedWorkspace.value?.path"
          :image-resource-url="workspaceImageResourceUrl"
          :loading="controller.loading.value || submitting"
          :image-attachments="controller.images.attachments"
          :user-input-questions="userInputQuestions"
          :user-input-answer="controller.userInput.answer"
          :user-input-submitted="controller.userInput.submitted"
          :plan-continuation="controller.activePlanContinuation.value"
          :node-ready="presentation.nodeReady"
          :synchronized="controller.status.connected() && !controller.conversationSyncPending.value"
          :tool-change-enabled="presentation.nodeReady"
          :rewind-enabled="presentation.rewindConversationEnabled"
          :rollback-enabled="presentation.rollbackConversationEnabled"
          @initial-rendered="state.conversation.confirmInitialRender"
          @open-image="controller.images.open"
          @image-unavailable="controller.images.markUnavailable"
          @open-file="controller.openAgentFile"
          @open-file-change="controller.openFileChange"
          @set-answer="controller.userInput.setAnswer"
          @submit-input="controller.userInput.submit"
          @implement-plan="controller.plan.implementPlan"
          @copy="controller.copyMessage"
          @rewind="controller.rewindConversation"
          @rollback="controller.rollbackConversation"
          @decide-approval="controller.approvals.decideApproval"
        />
        <template #status>
          <SessionPerformanceInfo :performance="performance" />
        </template>
      </ConversationScroll>
      <ConversationComposer
        ref="composer"
        v-model:input="state.draft.input.value"
        :placeholder="
          runner.selectedCommand
            ? translate('generated.workbenchSurface.run', {
                value0: runner.selectedCommand.id
              })
            : controller.nodeManifest.value === undefined &&
                presentation.workspaceHost?.connected === true &&
                presentation.workspaceHost.disabled !== true
              ? controller.status.manifestLoading.value
                ? translate('generated.workspaceInspector.loading')
                : translate('generated.workbenchSurface.nodeWorkbenchCapabilitiesAreUnavailable')
              : translate('generated.workbenchSurface.typeForCommandsToReferenceWorkspaceFiles', {
                  value0: runnerLabel(configuration.activeRunner)
                })
        "
        :working="presentation.composerWorking"
        :working-label="presentation.composerWorkingLabel"
        :working-busy="presentation.composerWorkingBusy"
        :elapsed-label="presentation.workingElapsedLabel"
        :connection-busy="
          !controller.status.connected() || controller.conversationSyncPending.value
        "
        :connection-label="
          !controller.status.connected()
            ? translate('conversationActivity.reconnecting')
            : controller.conversationSyncPending.value
              ? translate('conversationActivity.syncing')
              : ''
        "
        :readonly="presentation.composerInputDisabled"
        :drop-target="state.draggingAttachments.value"
        :mobile-viewport="controller.mobileViewport.value"
        :command-states="runner.activeCommandStates"
        :loading="controller.loading.value || submitting"
        :skill-tokens="state.draft.skillTokens.value"
        :file-references="state.draft.references.value"
        :completion="controller.completion.value"
        :completion-blocked="
          runner.commandPickerOpen ||
          references.open ||
          runner.selectedCommand !== undefined ||
          presentation.composerAttachmentsPending
        "
        @submit="controller.sendMessage"
        @input="interactions.onComposerInput"
        @keydown="interactions.onComposerKeydown"
        @cursor="interactions.onComposerCursor"
        @paste="controller.attachmentInput.onPaste"
        @dragenter="controller.attachmentInput.onDragEnter"
        @dragleave="controller.attachmentInput.onDragLeave"
        @drop="controller.attachmentInput.onDrop"
        @close-command="controller.closeCommandState"
        @remove-skill="state.skillTokens.remove"
        @remove-reference="controller.references.remove"
      >
        <template #queue>
          <ComposerQueue
            :items="queueView.items"
            :paused="queueView.paused"
            :loading="controller.loading.value || submitting"
            :editing-queue-item-id="state.queue.editingQueueItemId.value"
            :editing-content="state.queue.editingContent.value"
            :goal="controller.activeGoal.value"
            @drag-start="state.queue.draggingQueueItemId.value = $event"
            @reorder="controller.queueActions.reorder"
            @edit="state.queue.startEditing($event)"
            @cancel-edit="state.queue.finishEditing()"
            @update-content="state.queue.editingContent.value = $event"
            @save="controller.queueActions.save"
            @execute="
              (item, editedContent) =>
                controller.queueActions.execute(item as WorkspaceQueueItem, editedContent)
            "
            @delete-item="controller.queueActions.remove"
            @save-goal="controller.editGoal"
            @clear-goal="controller.clearGoal"
          />
        </template>
        <template #toolbar>
          <ComposerToolbar
            :submitting="submitting"
            v-if="presentation.canUseComposer"
            ref="composerToolbar"
            :draft-session-open="presentation.composerDraftOpen"
            :runner="configuration.runner"
            :runner-options="controller.runnerOptions.value"
            :runner-loading="controller.runnerProfilesLoading.value"
            :runner-disabled="!controller.draftOpen.value || controller.loading.value || submitting"
            :runner-label="configuration.runnerLabel"
            :model-effort-selection="configuration.modelEffortSelection"
            :model-effort-label="configuration.modelEffortLabel"
            :selected-model="configuration.modelId"
            :selected-effort="configuration.effort"
            :models="configuration.models"
            :efforts="configuration.efforts"
            :access="configuration.access"
            :access-label="configuration.accessLabel"
            :access-options="configuration.accessOptions"
            :configuration-disabled="presentation.composerConfigurationDisabled"
            :access-disabled="presentation.composerAccessDisabled"
            :fast-enabled="runner.codexFastEnabled"
            :context-usage="state.conversation.contextUsage.value"
            :context-usage-label="presentation.contextUsageLabel"
            :can-compact-context="presentation.canCompactContext"
            :mobile-viewport="controller.mobileViewport.value"
            :active-run="presentation.activeComposerRun"
            :context-key="sessionContextKey"
            :interrupt-visible="presentation.interruptVisible"
            :can-interrupt="canInterrupt"
            :input-has-content="
              state.draft.input.value.trim().length > 0 ||
              state.draft.skillTokens.value.length > 0 ||
              state.draft.references.value.length > 0 ||
              state.attachments.attachments.value.length > 0
            "
            :has-selected-command="runner.selectedCommand !== undefined"
            :loading="controller.loading.value || submitting"
            :attachments-pending="presentation.composerAttachmentsPending"
            :effort-label="controller.effortLabel"
            @files="state.attachments.add"
            @update-runner="controller.composer.selectRunner"
            @update-model-effort="selectComposerModelEffort"
            @update-access="controller.selectAccess"
            @compact="controller.context.compactCurrentContext"
            @stop="controller.runControl.stopActiveRun"
            @send="controller.sendMessage()"
            @steer="controller.sendMessage('REPLACE_CURRENT')"
          />
        </template>
        <template #attachments>
          <ComposerAttachments
            :attachments="state.attachments.attachments.value"
            @preview="emit('previewAttachment', $event)"
            @remove-attachment="state.attachments.remove"
          />
        </template>
        <template #picker>
          <ComposerCommandPicker
            :open="runner.commandPickerOpen"
            :commands="runner.pickerKind === 'runner' ? runner.visibleCommands : []"
            :skills="runner.pickerKind === 'runner' ? runner.visibleSkills : []"
            :quick-prompts="runner.pickerKind === 'quick-prompt' ? runner.visibleQuickPrompts : []"
            :quick-prompts-loading="controller.status.promptsLoading.value"
            :quick-prompts-failed="controller.status.promptsFailed.value"
            :picker-kind="runner.pickerKind"
            :skills-enabled="true"
            :skills-loading="controller.status.skillsLoading.value"
            :skills-failed="controller.status.skillsFailed.value"
            :active-index="runner.activeCommandIndex"
            :loading="controller.runnerProfilesLoading.value"
            :failed="controller.runnerProfilesFailed.value"
            @activate="runner.activeCommandIndex = $event"
            @select="controller.selectCommand"
            @select-skill="controller.selectSkill"
            @select-quick-prompt="controller.selectQuickPrompt"
          />
          <ComposerReferencePicker
            :open="references.open"
            :candidates="references.candidates"
            :active-index="references.activeIndex"
            :loading="references.loading"
            :query="references.match?.query ?? ''"
            :session-enabled="true"
            :session-ready="references.sessionAvailable()"
            :file-ready="controller.filesReady.value"
            :session-only="references.match?.sessionOnly ?? false"
            :session-loading="references.sessionLoading"
            :file-error="references.fileError"
            :session-error="references.sessionError"
            :file-more="references.fileMore"
            :session-more="references.sessionMore"
            @activate="references.activeIndex = $event"
            @select="interactions.selectReference"
          />
        </template>
      </ConversationComposer>
    </template>
  </section>
</template>

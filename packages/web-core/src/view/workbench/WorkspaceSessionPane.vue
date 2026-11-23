<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, proxyRefs, ref } from 'vue';
import { I18nT } from 'vue-i18n';
import { MarButton } from '@myagentroam/mar-ui/button';
import { MarDropdown, MarDropdownItem, MarDropdownMenu } from '@myagentroam/mar-ui/dropdown';
import { MarIcon } from '@myagentroam/mar-ui/icons';
import '../session/runner-brand-icon.css';
import type { ComposerAttachment, WorkspaceQueueItem } from '../../model/workbench.js';
import type { NavigationSummary } from '../../service/session-navigation-projection.js';
import type { WorkspaceSessionPaneView } from '../../service/workspace-session-pane-controller.js';
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
import ComposerQueue from '../composer/ComposerQueue.vue';
import ComposerToolbar from '../composer/ComposerToolbar.vue';
import ComposerAttachments from '../composer/ComposerAttachments.vue';
import ComposerCommandPicker from '../composer/ComposerCommandPicker.vue';
import ComposerReferencePicker from '../composer/ComposerReferencePicker.vue';
import ConversationComposer from '../composer/ConversationComposer.vue';
import type { WorkbenchBrowserLink } from '../../service/browser-link-routing.js';
import { isHtmlFile, workspaceFileTarget } from '../../util/file-preview.js';

const props = defineProps<{
  controller: WorkspaceSessionPaneView;
  openBrowserLink?: (link: WorkbenchBrowserLink, alternate: boolean) => boolean;
  treeSupported?: boolean;
  asideReady?: boolean;
  asideControls?: string;
  asideExpanded?: boolean;
  asideDisabled?: boolean;
  treeOpenSessionId?: string | undefined;
  treeSummaries?: readonly NavigationSummary[] | undefined;
  treeStatus?: 'idle' | 'loading' | 'ready' | 'failed';
}>();
const state = props.controller.state;
const workspaceTarget = state.workspaceTarget;
function openUrl(url: string, alternate: boolean): boolean {
  const source = workspaceTarget.value;
  return (
    source !== undefined &&
    (props.openBrowserLink?.({ kind: 'url', source, url }, alternate) ?? false)
  );
}
const openFile: WorkspaceSessionPaneView['openAgentFile'] = (
  path,
  line,
  column,
  alternate,
  attachment
) => {
  const source = workspaceTarget.value;
  const file =
    source &&
    props.openBrowserLink &&
    line === undefined &&
    column === undefined &&
    isHtmlFile(path)
      ? workspaceFileTarget(
          path,
          props.controller.selectedWorkspace.value?.path,
          window.location.origin
        )
      : undefined;
  if (
    source &&
    file &&
    !/^(?:\/|[a-z]:)/iu.test(file.path) &&
    props.openBrowserLink?.({ kind: 'html', source, path: file.path }, alternate ?? false)
  )
    return;
  props.controller.openAgentFile(path, line, column, alternate, attachment);
};
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
  sessionMenuOpen: [];
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
const hasDraftAgent = computed(() =>
  props.controller.runnerOptions.value.some((option) => option.value === configuration.runner)
);
const DraftAgentIcon = () =>
  h('img', {
    class: 'mar-runner-brand-icon',
    'data-runner': configuration.runner,
    src: runnerBrandIcon(configuration.runner),
    alt: ''
  });

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
    <template v-if="presentation.sessionPaneOpen">
      <ConversationHeader
        v-if="presentation.composerSessionOpen"
        :session="configuration.selectedSession"
        :runner="configuration.activeRunner"
        :files-ready="controller.filesReady.value"
        :terminal-ready="controller.terminalReady.value"
        :aside-ready="asideReady"
        :aside-controls="asideControls"
        :aside-expanded="asideExpanded"
        :aside-disabled="asideDisabled"
        :runner-icon="runnerBrandIcon"
        :session-title="sessionTitle"
        :content-search-ready="controller.filesReady.value"
        @open-surface="emit('openSurface', $event)"
        @session-menu-open="emit('sessionMenuOpen')"
        @open-tree="
          (id, anchor) =>
            emit(
              'openTree',
              id,
              anchor,
              configuration.selectedSession ? sessionTitle(configuration.selectedSession) : id
            )
        "
      >
        <template v-if="$slots['workspace-tools']" #workspace-tools>
          <slot name="workspace-tools" />
        </template>
        <template v-if="$slots['session-menu']" #session-menu="menu">
          <slot name="session-menu" v-bind="menu" />
        </template>
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
        :empty-prompt="presentation.composerDraftOpen ? 'workspace' : undefined"
        @scroll-element="state.scroll.setElement($event)"
        @scroll="interactions.onComposerScroll"
        @scroll-intent="state.scroll.stopFollowing"
        @load-older="controller.conversationWindow.paging.loadOlderConversationTurns"
        @latest="state.scroll.jumpToLatest"
        @reload="emit('reload')"
      >
        <template v-if="presentation.canUseComposer && hasDraftAgent" #empty-description>
          <I18nT
            class="draft-session-description"
            tag="div"
            keypath="conversationEmpty.workspace.createWithAgent"
            scope="global"
          >
            <template #agent>
              <MarDropdown
                class="draft-agent-dropdown"
                :placement="controller.mobileViewport.value ? 'top' : 'bottom'"
                :disabled="
                  controller.runnerProfilesLoading.value || presentation.sessionControlsBusy
                "
                @command="
                  $event !== configuration.runner && controller.composer.selectRunner($event)
                "
              >
                <MarButton
                  text
                  class="draft-agent-trigger mar-icon-action"
                  :icon="DraftAgentIcon"
                  :loading="controller.runnerProfilesLoading.value"
                  :aria-label="
                    translate('conversationEmpty.workspace.changeAgent', {
                      agent: configuration.runnerLabel
                    })
                  "
                >
                  <span class="draft-agent-label">
                    <span>{{ configuration.runnerLabel }}</span>
                    <MarIcon name="chevron-down" />
                  </span>
                </MarButton>
                <template #dropdown>
                  <MarDropdownMenu :aria-label="translate('common.runner')">
                    <MarDropdownItem
                      v-for="option in controller.runnerOptions.value"
                      :key="option.value"
                      :command="option.value"
                      :aria-current="option.value === configuration.runner ? 'true' : undefined"
                    >
                      <img
                        class="mar-runner-brand-icon"
                        :data-runner="option.value"
                        :src="runnerBrandIcon(option.value)"
                        alt=""
                      />
                      <span>{{ option.label }}</span>
                    </MarDropdownItem>
                  </MarDropdownMenu>
                </template>
              </MarDropdown>
            </template>
          </I18nT>
        </template>
        <ConversationTimeline
          :quote-target="controller.quoteTarget"
          :runs="controller.conversationRuns.value"
          :turns="presentation.displayedConversationTurns"
          :performance="performance"
          :initializing="controller.status.initialContentLoading()"
          :initial-render-version="state.conversation.initialRenderVersion.value"
          :capture-render-anchor="state.scroll.captureRenderAnchor"
          :workspace-root="controller.selectedWorkspace.value?.path"
          :open-url="props.openBrowserLink ? openUrl : undefined"
          :image-resource-url="controller.imageResourceUrl.value"
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
          @open-file="openFile"
          @open-file-change="controller.openFileChange"
          @set-answer="controller.userInput.setAnswer"
          @submit-input="controller.userInput.submit"
          @implement-plan="controller.plan.implementPlan"
          @copy="controller.copyMessage"
          @rewind="controller.rewindConversation"
          @rollback="controller.rollbackConversation"
          @decide-approval="controller.approvals.decideApproval"
        />
      </ConversationScroll>
      <ConversationComposer
        v-if="presentation.composerSessionOpen"
        ref="composer"
        v-model:input="state.draft.input.value"
        :placeholder="
          runner.selectedCommand
            ? translate('generated.workbenchSurface.run', {
                value0: runner.selectedCommand.id
              })
            : controller.nodeManifest.value === undefined && controller.status.manifestLoading.value
              ? translate('generated.workspaceInspector.loading')
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
        :loading="controller.loading.value"
        :submitting="submitting"
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
            model-shortcut
            :draft-session-open="false"
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
            :capacity-exceeded="references.capacityExceeded"
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

<style scoped>
.conversation-panel {
  position: relative;
  display: flex;
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  background: var(--mar-conversation-canvas);
}

.draft-session-description {
  max-width: 100%;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-body);
  line-height: 1.6;
}

.draft-agent-dropdown {
  max-width: 100%;
}

.draft-agent-trigger.mar-icon-action {
  /* Center the row within the touch target while keeping the label's inline baseline. */
  display: inline-grid;
  grid-auto-flow: column;
  align-content: center;
  align-items: baseline;
  padding-inline: 0.35rem;
  color: var(--mar-text-primary);
  font: inherit;
}

.draft-agent-trigger :deep(.mar-ui-button__icon) {
  align-self: center;
}

.draft-agent-label {
  display: inline-flex;
  align-items: baseline;
  gap: 0.375rem;
}

.draft-agent-label :deep(.mar-icon) {
  align-self: center;
  color: var(--mar-text-secondary);
}

@media (max-width: 767px) {
  .draft-agent-trigger {
    min-block-size: 36px;
  }
}
</style>

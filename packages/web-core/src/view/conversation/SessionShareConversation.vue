<script setup lang="ts">
import { showMessage } from '../../service/message-feedback-service.js';

import { marIcon } from '../../util/mar-icons.js';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { ClickOutside as vClickOutside, type ButtonInstance } from 'element-plus';
import { createSessionShareConversationService } from '../../service/session-share-conversation-service.js';
import type { createSessionShareAccessService } from '../../service/session-share-access-service.js';
import { createConversationImageService } from '../../service/conversation-image-service.js';
import { createWorkbenchClockService } from '../../service/workbench-clock-service.js';
import {
  conversationActivityLabel,
  conversationActivityBusy,
  conversationElapsedLabel
} from '../../util/conversation-activity.js';
import { sessionSubmissionContext } from '../../service/workbench-submission-service.js';
import { errorMessage } from '../../util/error-presentation.js';
import { translate } from '../../service/locale-preference-service.js';
import { userInputQuestions } from '../../util/conversation-user-input.js';
import ConversationScroll from './ConversationScroll.vue';
import ConversationTimeline from './ConversationTimeline.vue';
import ConversationComposer from '../composer/ConversationComposer.vue';
import ComposerToolbar from '../composer/ComposerToolbar.vue';
import ComposerAttachments from '../composer/ComposerAttachments.vue';
import ComposerQueue from '../composer/ComposerQueue.vue';
import ImagePreviewDialogs from './ImagePreviewDialogs.vue';
import SessionShareNameDialog from './SessionShareNameDialog.vue';
import ComposerCommandPicker from '../composer/ComposerCommandPicker.vue';
import ComposerReferencePicker from '../composer/ComposerReferencePicker.vue';
import { createWorkbenchComposerInteractionController } from '../../service/workbench-composer-interaction-controller.js';
import type { EffectiveWorkspaceSkill } from '../../service/effective-workspace-skill-service.js';
const props = defineProps<{ access: ReturnType<typeof createSessionShareAccessService> }>();
const emit = defineEmits<{
  openFile: [path: string, line?: number, column?: number, external?: boolean];
}>();
const chat = createSessionShareConversationService({
  access: props.access,
  beforeSend: props.access.ensureNamed,
  notice: showMessage
});
const {
  input,
  selectedSession,
  ready,
  busy,
  activeRun,
  profile,
  submission,
  participants,
  queue,
  references,
  skillTokens,
  attachmentsPending
} = chat;
const clock = createWorkbenchClockService(
  computed(() => chat.target.sessionId),
  busy,
  activeRun
);
const workingLabel = computed(() =>
  conversationActivityLabel(activeRun.value, chat.state.turns.value)
);
const elapsedLabel = computed(() =>
  conversationElapsedLabel(clock.workingStartedAt.value, clock.workingNow.value)
);
const submitting = computed(
  () =>
    submission.pending.value &&
    submission.context.value === sessionSubmissionContext(chat.target.sessionId)
);
const { turns, nextCursor, loadingInitial, initialLoadFailed, loadingOlder, initialRenderVersion } =
  chat.state;
const { following } = chat.scroll;
const { attachments, preview, previewOpen } = chat.attachments;
const { editingQueueItemId, editingContent } = chat.queueEditor;
const { nameRequired } = props.access;
const editingName = ref(false);
const images = createConversationImageService(ref(chat.target.nodeId), {
  sourceUrl: ({ runId, imageSelector }) =>
    `${props.access.base}/runs/${encodeURIComponent(runId)}/images/${encodeURIComponent(imageSelector)}`
});
const { previewOpen: imageOpen, preview: image } = images;
const mobile = ref(window.matchMedia('(max-width: 767px)').matches);
const showParticipants = ref(false);
const participantsButton = ref<ButtonInstance>();
const composer = ref<InstanceType<typeof ConversationComposer>>();
const { interactions, fileReferences } = chat;
const selectSkill = (skill: EffectiveWorkspaceSkill, cursor: number) => {
  chat.tokens.select(skill);
  composer.value?.focusAt(cursor);
};
const interaction = createWorkbenchComposerInteractionController({
  input,
  workspaceTarget: ref({ nodeId: chat.target.nodeId, workspaceId: chat.target.workspaceId }),
  filesReady: ready,
  mobileViewport: mobile,
  canInterruptTurn: computed(() => ready.value && busy.value),
  runnerProfilesLoading: chat.profilesLoading,
  runnerProfilesFailed: chat.profilesFailed,
  commandPickerOpen: interactions.commandPickerOpen,
  fileReferences,
  runnerInteractions: interactions,
  hasRunnerProfile: () => profile.value !== undefined,
  loadRunnerProfiles: chat.loadProfiles,
  ensureComposerSkills: chat.skillService.ensureFresh,
  ensureQuickPrompts: () => undefined,
  selectSkill,
  stopActiveRun: chat.controls.stopActiveRun,
  sendMessage: (replace, preserve, content) =>
    void chat.send(replace ? 'REPLACE_CURRENT' : undefined, preserve, content),
  loadOlderConversationTurns: chat.paging.loadOlderConversationTurns,
  handleConversationScroll: chat.scroll.handleScroll,
  scrollToLatest: chat.scroll.scrollToLatest,
  scrollToLatestAfterLayout: chat.scroll.scrollToLatestAfterLayout,
  editRange: (start, end, text) => composer.value?.replaceRange(start, end, text) ?? false
});
const observer = window.matchMedia('(max-width: 767px)');
const onResize = () => {
  mobile.value = observer.matches;
  chat.scroll.handleResize();
};
const title = computed(
  () =>
    selectedSession.value?.customTitle ||
    selectedSession.value?.runnerTitle ||
    translate('sessionShare.title')
);
const name = (visitor: { visitorId: string; name?: string | undefined }) =>
  visitor.name ??
  translate('sessionShare.anonymous', { id: visitor.visitorId.replaceAll('-', '').slice(-6) });
function keydown(event: KeyboardEvent): void {
  if (!event.isComposing) interaction.onComposerKeydown(event);
}
function paste(event: ClipboardEvent): void {
  const files = event.clipboardData?.files;
  if (files?.length && ready.value) {
    event.preventDefault();
    chat.attachments.add(files);
  }
}
async function copyMessage(text: string, done: () => void): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    done();
  } catch (error) {
    showMessage(errorMessage(error), 'error', error);
  }
}
function confirmName(value: string): void {
  props.access.setName(value);
  editingName.value = false;
}
function cancelName(): void {
  editingName.value = false;
  props.access.cancelName();
}
function closeParticipants(): void {
  showParticipants.value = false;
}
onMounted(() => {
  observer.addEventListener('change', onResize);
  void chat.start();
});
onBeforeUnmount(() => {
  observer.removeEventListener('change', onResize);
  props.access.cancelName();
  images.dispose();
  chat.dispose();
});
</script>

<template>
  <main class="share-room">
    <section class="share-chat" :aria-label="title">
      <header class="share-heading">
        <div>
          <span class="share-kicker">{{ translate('sessionShare.sharedConversation') }}</span>
          <div class="share-title-line">
            <h1>{{ title }}</h1>
            <span v-if="access.session.value!.workspaceName" class="share-workspace">{{
              access.session.value!.workspaceName
            }}</span>
          </div>
        </div>
        <el-button
          v-if="mobile"
          ref="participantsButton"
          @click="showParticipants = !showParticipants"
          :aria-expanded="showParticipants"
          >{{ translate('sessionShare.participants') }}</el-button
        >
      </header>
      <ConversationScroll
        :context-key="chat.target.sessionId"
        :has-older="nextCursor !== null"
        :loading-initial="loadingInitial"
        :initial-load-failed="initialLoadFailed"
        :loading-older="loadingOlder"
        :older-error="chat.paging.olderHistoryError.value"
        :has-turns="turns.length > 0"
        :following="following"
        @scroll-element="chat.scroll.setElement"
        @scroll="
          chat.scroll.handleScroll(() => {
            if (!chat.paging.olderHistoryError.value) void chat.paging.loadOlderConversationTurns();
          })
        "
        @load-older="chat.paging.loadOlderConversationTurns"
        @latest="chat.scroll.scrollToLatest"
        @reload="chat.restartWatch"
      >
        <ConversationTimeline
          :turns="turns"
          :runs="chat.runs.value"
          :sharer-name="access.session.value!.sharerName"
          :workspace-root="undefined"
          :image-resource-url="
            (path) => `${access.base}/files/content?path=${encodeURIComponent(path)}`
          "
          :loading="submission.pending.value"
          :initializing="loadingInitial"
          :initial-render-version="initialRenderVersion"
          :capture-render-anchor="chat.scroll.captureRenderAnchor"
          :image-attachments="images.attachments"
          :user-input-questions="userInputQuestions"
          :user-input-answer="chat.questions.answer"
          :user-input-submitted="chat.questions.submitted"
          :plan-continuation="undefined"
          :node-ready="ready"
          :synchronized="chat.connected.value && chat.watchReady.value"
          :rewind-enabled="false"
          :rollback-enabled="false"
          @open-file="
            (path, line, column, external) => emit('openFile', path, line, column, external)
          "
          @open-image="images.open"
          @image-unavailable="images.markUnavailable"
          @initial-rendered="chat.state.confirmInitialRender"
          @set-answer="chat.questions.setAnswer"
          @submit-input="chat.questions.submit"
          @decide-approval="chat.approvals.decideApproval"
          @copy="copyMessage"
        />
      </ConversationScroll>
      <ConversationComposer
        ref="composer"
        v-model:input="input"
        :placeholder="translate('sessionShare.messagePlaceholder')"
        :working="clock.working.value"
        :working-label="workingLabel"
        :working-busy="conversationActivityBusy(activeRun, turns)"
        :elapsed-label="elapsedLabel"
        :connection-busy="!chat.connected.value || (!chat.watchReady.value && !initialLoadFailed)"
        :connection-label="
          !chat.connected.value
            ? translate('conversationActivity.reconnecting')
            : !chat.watchReady.value && !initialLoadFailed
              ? translate('conversationActivity.syncing')
              : ''
        "
        :readonly="!ready"
        :drop-target="false"
        :mobile-viewport="mobile"
        :command-states="[]"
        :loading="submission.pending.value"
        :skill-tokens="skillTokens"
        :file-references="references"
        @input="interaction.onComposerInput"
        @cursor="interaction.onComposerCursor"
        @submit="chat.send()"
        @keydown="keydown"
        @paste="paste"
        @drop="
          (event) =>
            ready && event.dataTransfer?.files && chat.attachments.add(event.dataTransfer.files)
        "
        @remove-skill="(name) => (skillTokens = skillTokens.filter((value) => value.name !== name))"
        @remove-reference="chat.fileReferences.remove"
      >
        <template #queue
          ><ComposerQueue
            :items="queue.items"
            :paused="queue.paused"
            :loading="!ready || submission.pending.value"
            :editing-queue-item-id="editingQueueItemId"
            :editing-content="editingContent"
            :goal="undefined"
            @drag-start="(id) => (chat.queueEditor.draggingQueueItemId.value = id)"
            @reorder="chat.queueActions.reorder"
            @edit="chat.queueEditor.startEditing"
            @cancel-edit="chat.queueEditor.finishEditing"
            @update-content="(value) => (editingContent = value)"
            @save="chat.queueActions.save"
            @execute="chat.queueActions.execute"
            @delete-item="chat.queueActions.remove"
        /></template>
        <template #attachments
          ><ComposerAttachments
            :attachments="attachments"
            @preview="chat.attachments.openPreview"
            @remove-attachment="chat.attachments.remove"
        /></template>
        <template #picker>
          <ComposerReferencePicker
            :open="fileReferences.open.value"
            :candidates="fileReferences.candidates.value"
            :active-index="fileReferences.activeIndex.value"
            :loading="fileReferences.loading.value"
            :query="fileReferences.match.value?.query ?? ''"
            :file-error="fileReferences.fileError.value"
            :file-more="fileReferences.fileMore.value"
            @activate="(index) => (fileReferences.activeIndex.value = index)"
            @select="interaction.selectReference"
          />
          <ComposerCommandPicker
            :open="interactions.commandPickerOpen.value"
            :commands="interactions.visibleCommands.value"
            :skills="interactions.visibleSkills.value"
            :quick-prompts="[]"
            :quick-prompts-loading="false"
            :quick-prompts-failed="false"
            :picker-kind="interactions.pickerKind.value"
            :skills-enabled="true"
            :skills-loading="chat.skillsLoading.value"
            :skills-failed="chat.skillsFailed.value"
            :active-index="interactions.activeCommandIndex.value"
            :loading="chat.profilesLoading.value"
            :failed="chat.profilesFailed.value"
            @activate="(index) => (interactions.activeCommandIndex.value = index)"
            @select="
              (command) =>
                interactions.selectCommand(command, (preserve) => chat.send(undefined, preserve))
            "
            @select-skill="(skill) => interactions.selectSkill(skill, selectSkill)"
          />
        </template>
        <template #toolbar
          ><ComposerToolbar
            :submitting="submitting"
            :draft-session-open="false"
            :runner="selectedSession?.runner ?? 'mar-agent'"
            :runner-options="[]"
            :runner-loading="false"
            :runner-label="selectedSession?.runner"
            hide-model-selection
            hide-access-selection
            hide-context-usage
            :model-effort-selection="undefined"
            :model-effort-label="selectedSession?.modelId ?? ''"
            :selected-model="selectedSession?.modelId ?? ''"
            :selected-effort="selectedSession?.effort ?? ''"
            :models="profile?.models ?? []"
            :efforts="[]"
            :access="selectedSession?.access ?? ''"
            :access-label="selectedSession?.access ?? ''"
            :access-options="[]"
            :configuration-disabled="true"
            :access-disabled="true"
            :fast-enabled="false"
            :context-usage="undefined"
            :context-usage-label="''"
            :can-compact-context="false"
            :mobile-viewport="mobile"
            :active-run="activeRun"
            :context-key="chat.target.sessionId"
            :can-interrupt="ready && !submission.pending.value"
            :interrupt-visible="busy"
            :input-has-content="
              input.trim().length > 0 ||
              attachments.length > 0 ||
              references.length > 0 ||
              skillTokens.length > 0
            "
            :has-selected-command="false"
            :loading="!ready || submission.pending.value"
            :attachments-pending="attachmentsPending"
            :effort-label="(value) => value"
            @files="chat.attachments.add"
            @stop="chat.controls.stopActiveRun"
            @send="chat.send()"
            @steer="chat.send('REPLACE_CURRENT')"
        /></template>
      </ConversationComposer>
    </section>
    <aside
      v-if="!mobile || showParticipants"
      v-click-outside:[participantsButton?.$el]="closeParticipants"
      class="share-people"
      :aria-label="translate('sessionShare.participants')"
    >
      <h2>
        {{ translate('sessionShare.participants') }}
      </h2>
      <div class="share-person sharer">
        <div>
          <div class="share-person-name">
            <span v-if="chat.sharerOnline.value" class="presence" aria-hidden="true" />
            <strong>{{ access.session.value!.sharerName }}</strong>
          </div>
          <small>{{ translate('sessionShare.sharer') }}</small>
        </div>
      </div>
      <div v-for="visitor in participants" :key="visitor.visitorId" class="share-person">
        <span class="presence" aria-hidden="true" /><span>{{ name(visitor) }}</span>
        <el-button
          v-tooltip="translate('sessionShare.editName')"
          v-if="chat.canRename.value && visitor.visitorId === access.visitor.value.visitorId"
          class="share-edit-name"
          :icon="marIcon('edit')"
          :aria-label="translate('sessionShare.editName')"
          link
          @click="editingName = true"
        />
      </div>
    </aside>
    <SessionShareNameDialog
      v-if="nameRequired || editingName"
      :initial-name="access.visitor.value.name ?? ''"
      :editing="editingName"
      @confirm="confirmName"
      @cancel="cancelName"
    />
    <ImagePreviewDialogs
      v-model:attachment-open="previewOpen"
      :attachment="preview"
      v-model:conversation-open="imageOpen"
      :conversation="image"
      @conversation-error="images.previewFailed"
    />
  </main>
</template>

<style scoped>
.share-room {
  height: 100dvh;
  display: grid;
  grid-template-columns: minmax(0, 58rem) 14rem;
  justify-content: center;
  background: var(--el-bg-color-page);
  padding: 0 1.5rem;
}
.share-chat {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  background: var(--el-bg-color);
  border-inline: 1px solid var(--el-border-color-lighter);
}
.share-heading {
  padding: 1rem 1.5rem;
  border-bottom: 1px solid var(--el-border-color-lighter);
  display: flex;
  gap: 1rem;
  align-items: center;
  justify-content: space-between;
}
.share-kicker {
  font-size: var(--mar-font-size-meta);
  color: var(--el-text-color-secondary);
}
.share-heading > div {
  min-width: 0;
}
.share-title-line {
  display: flex;
  align-items: baseline;
  gap: 0.25rem 0.75rem;
  flex-wrap: wrap;
}
.share-workspace {
  font-size: var(--mar-font-size-body);
  color: var(--el-text-color-secondary);
  overflow-wrap: anywhere;
}
h1 {
  font-size: var(--mar-font-size-page-title);
  font-weight: 600;
  margin: 0.25rem 0 0;
  overflow-wrap: anywhere;
}
.share-people {
  padding: 1.5rem 1.25rem;
  overflow: auto;
}
.share-people h2 {
  font-size: var(--mar-font-size-title);
  margin: 0 0 1rem;
  display: flex;
  justify-content: space-between;
}
.share-people h2 span {
  color: var(--el-text-color-secondary);
  font-variant-numeric: tabular-nums;
}
.share-person {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.7rem 0;
  overflow-wrap: anywhere;
  font-size: var(--mar-font-size-body);
}
.sharer {
  border-bottom: 1px solid var(--el-border-color-lighter);
  padding-bottom: 1rem;
  margin-bottom: 0.5rem;
}
.share-person-name {
  display: grid;
  grid-template-columns: 6px minmax(0, 1fr);
  align-items: center;
  column-gap: 0.75rem;
}
.share-person-name strong {
  grid-column: 2;
}
.sharer small {
  margin-inline-start: calc(6px + 0.75rem);
}
.share-edit-name {
  margin-inline-start: auto;
  opacity: 0;
  flex-shrink: 0;
}
.share-person:hover .share-edit-name,
.share-person:focus-within .share-edit-name {
  opacity: 1;
}
@media (hover: none) {
  .share-edit-name {
    opacity: 1;
  }
}
.share-person strong {
  font-weight: 500;
}
.share-person small {
  display: block;
  color: var(--el-text-color-secondary);
  margin-top: 0.2rem;
}
.presence {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--el-color-success);
  flex-shrink: 0;
}
.share-chat :deep(.conversation-scroll-region) {
  flex: 1;
  min-height: 0;
}
@media (max-width: 767px) {
  .share-room {
    padding: 0;
    grid-template-columns: minmax(0, 1fr);
  }
  .share-heading {
    padding: 0.75rem 1rem;
  }
  .share-people {
    position: absolute;
    right: 0.5rem;
    top: 4.5rem;
    z-index: 20;
    width: min(17rem, calc(100vw - 1rem));
    max-height: 60dvh;
    background: var(--el-bg-color);
    border: 1px solid var(--el-border-color);
    border-radius: 8px;
    box-shadow: var(--el-box-shadow-light);
  }
}
</style>

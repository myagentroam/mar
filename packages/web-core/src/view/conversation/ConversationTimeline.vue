<script setup lang="ts">
import { marIcon } from '../../util/mar-icons.js';
import MarIcon from '../common/MarIcon.vue';
import { managementDateTime } from '../../util/time-presentation.js';
import {
  toolPresentation,
  toolPresentationSources,
  toolPresentationStatus
} from '../../util/tool-presentation.js';
import { translate } from '../../service/locale-preference-service.js';
import { createWorkbenchSecondClock } from '../../service/workbench-clock-service.js';
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onBeforeUpdate,
  onUpdated,
  provide,
  reactive,
  ref,
  watch,
  type ComponentPublicInstance
} from 'vue';
import AgentMarkdown from '../common/AgentMarkdown.vue';
import {
  CONVERSATION_MARKDOWN_CACHE_KEY,
  createConversationMarkdownCache
} from '../../util/conversation-markdown-cache.js';
import MessageAttachmentFiles from '../composer/MessageAttachmentFiles.vue';
import ConversationImageThumbnail from './ConversationImageThumbnail.vue';
import ConversationWorkProcess from './ConversationWorkProcess.vue';
import ConversationRecordIcon from './ConversationRecordIcon.vue';
import ConversationToolDetail from './ConversationToolDetail.vue';
import {
  conversationWorkProcessProjection,
  conversationWorkProcessVisibleBlocks,
  nextConversationRenderItemCount
} from '../../util/conversation-work-process.js';
import RunnerApprovalCard from './RunnerApprovalCard.vue';
import type { ComposerAttachmentFile } from '@myagentroam/protocol';
import type { FileChangeEntry } from '../../util/conversation-presentation.js';
import { composerMessagePresentation } from '../../util/composer-message.js';
import {
  CONVERSATION_RENDER_BATCH_ITEMS,
  conversationPayload,
  conversationItemCount,
  conversationTurnHasRunId,
  initialConversationRenderItemCount,
  latestConversationItems
} from '../../util/conversation-history.js';
import {
  conversationDisplayItems,
  type ConversationDisplayItem,
  conversationApproval,
  conversationFileChangeEntries,
  conversationToolEntries,
  conversationReadFileCount,
  conversationItemDetail,
  conversationItemLabel,
  composerMessageSource,
  conversationItemText,
  subagentGroupText,
  subagentOperationText,
  conversationErrorCodeVisible,
  conversationErrorPresentation,
  planSteps,
  taskListItems,
  approvalDetail,
  approvalStatusLabel,
  approvalToolLabel,
  approvalReason,
  permissionStopDetail
} from '../../util/conversation-presentation.js';
import type {
  ConversationItem,
  ConversationTurn,
  RunnerCommandState
} from '../../model/workbench.js';
import { userInputOtherAnswerId } from '../../service/conversation-user-input-service.js';
import { absoluteMessageTime } from '../../util/conversation-presentation.js';
import type { AgentRun } from '../../model/workbench.js';
import {
  completedStepDuration,
  completedConversationDurations
} from '../../util/conversation-activity.js';
import { preciseElapsedDurationLabel } from '../../util/time-presentation.js';
import { isTerminalRunStatus } from '../../util/run-state.js';

interface ImageAttachment {
  readonly name: string;
  readonly previewUrl: string | undefined;
}

interface UserInputQuestion {
  readonly id: string;
  readonly prompt: string;
  readonly options: readonly { readonly label: string; readonly value: string }[];
  readonly allowOther: boolean;
  readonly input: 'SINGLE_SELECT' | 'MULTI_SELECT' | 'SHORT_TEXT';
}

type UserInputAnswer = string | readonly string[];

function messageHeading(payload: unknown) {
  return (
    composerMessageSource(composerMessagePresentation(payload)) ?? {
      label: props.sharerName ?? conversationItemLabel('user_message', payload),
      title: undefined
    }
  );
}

const props = defineProps<{
  readonly turns: readonly ConversationTurn[];
  readonly runs?: readonly Pick<AgentRun, 'id' | 'status' | 'startedAt' | 'completedAt'>[];
  readonly sharerName?: string;
  readonly workspaceRoot: string | undefined;
  readonly imageResourceUrl?: ((path: string) => string) | undefined;
  readonly loading: boolean;
  readonly initializing: boolean;
  readonly initialRenderVersion: number;
  readonly imageAttachments: (runId: string | null, payload: unknown) => readonly ImageAttachment[];
  readonly userInputQuestions: (payload: unknown) => readonly UserInputQuestion[];
  readonly userInputAnswer: (itemId: string, questionId: string) => UserInputAnswer;
  readonly userInputSubmitted: (itemId: string) => boolean;
  readonly planContinuation: RunnerCommandState | undefined;
  readonly nodeReady: boolean;
  readonly synchronized?: boolean;
  readonly toolChangeEnabled?: boolean;
  readonly rewindEnabled: boolean;
  readonly rollbackEnabled: boolean;
  readonly captureRenderAnchor: () => () => void;
}>();

provide(CONVERSATION_MARKDOWN_CACHE_KEY, createConversationMarkdownCache());

function markdownCacheIdentity(
  turn: ConversationTurn,
  item: ConversationItem
): string[] | undefined {
  if (!isTerminalRunStatus(turn.status) || item.status !== 'COMPLETED') return undefined;
  const run = props.runs?.find((candidate) => candidate.id === turn.runId);
  if (run && !isTerminalRunStatus(run.status)) return undefined;
  return [turn.sessionId, turn.id, item.id];
}

const emit = defineEmits<{
  openFileChange: [entry: FileChangeEntry];
  initialRendered: [version: number];
  openImage: [attachment: ImageAttachment];
  imageUnavailable: [source: string];
  openFile: [
    path: string,
    line: number | undefined,
    column: number | undefined,
    external: boolean,
    attachment?: ComposerAttachmentFile
  ];
  setAnswer: [itemId: string, questionId: string, value: UserInputAnswer];
  submitInput: [turn: ConversationTurn, item: ConversationItem];
  implementPlan: [item: ConversationItem];
  copy: [text: string, onSuccess: () => void];
  rewind: [turn: ConversationTurn, item: ConversationItem];
  rollback: [turn: ConversationTurn, item: ConversationItem];
  decideApproval: [runId: string, approvalId: string, decision: 'APPROVED' | 'REJECTED'];
}>();

const timelineElement = ref<HTMLElement>();
let focusedRecord: HTMLElement | undefined;
let previousEntrySignature = '';
let previousMotionVersion = props.initialRenderVersion;
let previousMotionReady = (props.synchronized ?? props.nodeReady) && !props.initializing;
let enteringAfter: Set<string> | undefined;
onBeforeUpdate(() => {
  if (typeof document === 'undefined') return;
  const signature = processBlocks.value
    .flatMap((block) =>
      block.entries.map(({ turn, displayItem }) => `${turn.sessionId}:${displayItem.id}`)
    )
    .join('\n');
  enteringAfter = undefined;
  if (
    signature !== previousEntrySignature &&
    !props.initializing &&
    !progressiveRenderPending &&
    synchronized.value &&
    previousMotionReady &&
    previousMotionVersion === props.initialRenderVersion &&
    !document.hidden &&
    !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ) {
    enteringAfter = new Set(
      [...(timelineElement.value?.querySelectorAll<HTMLElement>('[data-entry-key]') ?? [])].map(
        (element) => element.dataset.entryKey!
      )
    );
  }
  previousEntrySignature = signature;
  previousMotionVersion = props.initialRenderVersion;
  previousMotionReady = synchronized.value && !props.initializing && !progressiveRenderPending;
  const active = document.activeElement;
  focusedRecord =
    active && active instanceof HTMLElement && timelineElement.value?.contains(active)
      ? active
      : undefined;
});
onUpdated(() => {
  // Moving a keyed group can detach its focused disclosure from the document.
  if (focusedRecord?.isConnected && document.activeElement === document.body)
    focusedRecord.focus({ preventScroll: true });
  focusedRecord = undefined;
  if (enteringAfter) {
    const entries = [
      ...(timelineElement.value?.querySelectorAll<HTMLElement>('[data-entry-key]') ?? [])
    ];
    const lastExisting = entries.findLastIndex((element) =>
      enteringAfter!.has(element.dataset.entryKey!)
    );
    // Only animate appended identities, never prepended history or moved groups.
    if (lastExisting >= 0 || enteringAfter.size === 0) {
      for (const element of entries.slice(lastExisting + 1)) {
        element.animate(
          [
            { opacity: 0, transform: 'translateY(3px)' },
            { opacity: 1, transform: 'none' }
          ],
          { duration: 160, easing: 'ease-out' }
        );
      }
    }
  }
  enteringAfter = undefined;
});
const renderedItemCount = ref(0);
let renderFrame: number | undefined;
let progressiveRenderPending = false;
let renderGeneration = 0;
let preparedInitialRenderVersion = 0;
let renderedSessionId: string | undefined;

const renderedTurns = computed(() => latestConversationItems(props.turns, renderedItemCount.value));
const runDurations = computed(() => {
  const labels = new Map<string, string>();
  for (const [turnId, duration] of completedConversationDurations(props.turns)) {
    labels.set(
      turnId,
      translate('conversationActivity.total', { value: preciseElapsedDurationLabel(duration) })
    );
  }
  return labels;
});
const processMetadata = computed(
  () =>
    conversationWorkProcessProjection(
      props.turns,
      [],
      props.runs,
      new Set(runDurations.value.keys())
    ).metadataBlocks
);
const processViews = new Map<string, InstanceType<typeof ConversationWorkProcess>>();
function setProcessView(id: string, instance: Element | ComponentPublicInstance | null): void {
  if (instance) processViews.set(id, instance as InstanceType<typeof ConversationWorkProcess>);
  else processViews.delete(id);
}
const copiedMessage = ref<string>();
const copyResetTimers = new Map<string, ReturnType<typeof setTimeout>>();

function copyItem(turn: ConversationTurn, item: ConversationItem): void {
  const key = `${turn.id}:${item.id}`;
  emit('copy', conversationItemText(item.kind, item.payload), () => {
    const previous = copyResetTimers.get(key);
    if (previous !== undefined) clearTimeout(previous);
    copiedMessage.value = key;
    copyResetTimers.set(
      key,
      setTimeout(() => {
        if (copiedMessage.value === key) copiedMessage.value = undefined;
        copyResetTimers.delete(key);
      }, 500)
    );
  });
}

function cancelProgressiveRender(): void {
  renderGeneration += 1;
  progressiveRenderPending = false;
  if (renderFrame !== undefined) cancelAnimationFrame(renderFrame);
  renderFrame = undefined;
}

function scheduleProgressiveRender(): void {
  cancelProgressiveRender();
  const generation = renderGeneration;
  const total = conversationItemCount(props.turns);
  if (renderedItemCount.value >= total) return;
  if (typeof requestAnimationFrame === 'undefined') {
    renderedItemCount.value = total;
    return;
  }
  progressiveRenderPending = true;
  renderFrame = requestAnimationFrame(async () => {
    if (generation !== renderGeneration) return;
    renderFrame = undefined;
    const restoreAnchor = props.captureRenderAnchor();
    renderedItemCount.value = nextConversationRenderItemCount(
      props.turns,
      renderedItemCount.value,
      processMetadata.value,
      (id) => processViews.get(id)?.isOpen(),
      CONVERSATION_RENDER_BATCH_ITEMS
    );
    await nextTick();
    if (generation !== renderGeneration) return;
    restoreAnchor();
    scheduleProgressiveRender();
  });
}

async function prepareInitialRender(version: number, turns: readonly ConversationTurn[]) {
  cancelProgressiveRender();
  preparedInitialRenderVersion = version;
  renderedItemCount.value = initialConversationRenderItemCount(turns);
  const generation = renderGeneration;
  await nextTick();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  if (generation !== renderGeneration || props.initialRenderVersion !== version) return;
  emit('initialRendered', version);
  if (!props.initializing) scheduleProgressiveRender();
}

watch(
  [() => props.initialRenderVersion, () => props.turns],
  ([version, turns]) => {
    const total = conversationItemCount(turns);
    const sessionId = turns[0]?.sessionId;
    const switching = sessionId !== renderedSessionId;
    if (switching) {
      cancelProgressiveRender();
      renderedSessionId = sessionId;
      renderedItemCount.value = initialConversationRenderItemCount(turns);
    }
    if (version > 0 && version !== preparedInitialRenderVersion) {
      void prepareInitialRender(version, turns);
      return;
    }
    if (props.initializing) {
      if (progressiveRenderPending) cancelProgressiveRender();
      renderedItemCount.value = initialConversationRenderItemCount(turns);
      return;
    }
    if (switching) {
      scheduleProgressiveRender();
      return;
    }
    if (!progressiveRenderPending) renderedItemCount.value = total;
  },
  { immediate: true }
);

watch(
  () => props.initializing,
  (initializing) => {
    if (initializing && progressiveRenderPending) cancelProgressiveRender();
    if (!initializing && preparedInitialRenderVersion === props.initialRenderVersion)
      scheduleProgressiveRender();
  }
);

onBeforeUnmount(() => {
  cancelProgressiveRender();
  for (const timer of copyResetTimers.values()) clearTimeout(timer);
});

function userInputCheckboxAnswer(itemId: string, questionId: string): readonly string[] {
  const answer = props.userInputAnswer(itemId, questionId);
  return Array.isArray(answer) ? answer : [];
}

const latestPlanItemId = computed(
  () =>
    props.turns
      .flatMap((turn) => turn.items)
      .filter((item) => item.kind === 'plan')
      .at(-1)?.id
);

const reasoningDisclosure = reactive<Record<string, boolean>>({});
const groupedItemDisclosure = reactive<Record<string, boolean>>({});

watch(
  () =>
    renderedTurns.value.flatMap((turn) =>
      turn.items.flatMap((item) => [
        item.id,
        `group:${item.id}`,
        ...(item.kind === 'tool_call' && toolPresentation(item.payload)?.kind === 'READ'
          ? conversationToolEntries([item]).map(({ id }) => id)
          : [])
      ])
    ),
  (itemIds) => {
    const currentIds = new Set(itemIds);
    for (const id of Object.keys(groupedItemDisclosure)) {
      if (!currentIds.has(id)) delete groupedItemDisclosure[id];
    }
  }
);

function updateReasoningDisclosure(id: string, event: Event): void {
  reasoningDisclosure[id] = (event.currentTarget as HTMLDetailsElement).open;
}

function updateGroupedItemDisclosure(id: string, event: Event): void {
  groupedItemDisclosure[id] = (event.currentTarget as HTMLDetailsElement).open;
}

const disclosureMotions = new Map<
  HTMLDetailsElement,
  { open: boolean; animation: Animation | undefined }
>();

onBeforeUnmount(() => {
  for (const motion of disclosureMotions.values()) motion.animation?.cancel();
  disclosureMotions.clear();
});

async function animateDisclosure(event: MouseEvent): Promise<void> {
  if (event.defaultPrevented || !(event.target instanceof Element)) return;
  const summary = event.target.closest('summary');
  const details = summary?.parentElement;
  if (
    !summary ||
    !(details instanceof HTMLDetailsElement) ||
    !details.closest('.conversation-item') ||
    event.target.closest('a, button, input, select, textarea')
  )
    return;
  const previous = disclosureMotions.get(details);
  const motion = {
    open: !(previous?.open ?? details.open),
    animation: undefined as Animation | undefined
  };
  const startHeight = details.getBoundingClientRect().height;
  previous?.animation?.cancel();
  delete details.dataset.disclosureClosing;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    if (previous) {
      event.preventDefault();
      details.open = motion.open;
      disclosureMotions.delete(details);
    }
    return;
  }
  event.preventDefault();
  disclosureMotions.set(details, motion);
  if (!motion.open) details.dataset.disclosureClosing = '';
  if (!details.open) {
    await new Promise<void>((resolve) => {
      details.addEventListener('toggle', () => resolve(), { once: true });
      details.open = true;
    });
    await nextTick();
  }
  if (disclosureMotions.get(details) !== motion) return;
  if (!details.isConnected) {
    disclosureMotions.delete(details);
    return;
  }
  const style = getComputedStyle(details);
  const duration = style.getPropertyValue('--el-transition-duration-fast').trim();
  const collapsedHeight =
    summary.getBoundingClientRect().bottom -
    details.getBoundingClientRect().top +
    Number.parseFloat(style.paddingBottom) +
    Number.parseFloat(style.borderBottomWidth);
  const endHeight = motion.open ? details.getBoundingClientRect().height : collapsedHeight;
  motion.animation = details.animate(
    {
      height: [`${startHeight}px`, `${endHeight}px`],
      overflow: ['hidden', 'hidden'],
      boxSizing: ['border-box', 'border-box']
    },
    {
      duration: Number.parseFloat(duration) * (duration.endsWith('ms') ? 1 : 1000),
      easing: 'ease',
      fill: 'both'
    }
  );
  motion.animation.onfinish = () => {
    if (disclosureMotions.get(details) !== motion) return;
    details.open = motion.open;
    delete details.dataset.disclosureClosing;
    motion.animation?.cancel();
    disclosureMotions.delete(details);
  };
}

function rollbackTarget(turn: ConversationTurn, item: ConversationItem): boolean {
  return (
    item.kind === 'user_message' &&
    item.status === 'COMPLETED' &&
    ['SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED', 'LOST'].includes(turn.status)
  );
}
function turnActive(turn: ConversationTurn): boolean {
  const run = props.runs?.find((entry) => entry.id === turn.runId);
  return run
    ? !isTerminalRunStatus(run.status)
    : ['PREPARING', 'RUNNING', 'WAITING_INPUT', 'WAITING_APPROVAL'].includes(turn.status);
}

function hasConversationDetail(item: ConversationItem): boolean {
  return conversationItemDetail(item.kind, item.payload).length > 0;
}

function hasPlanContent(item: ConversationItem): boolean {
  return (
    conversationItemText(item.kind, item.payload).length > 0 ||
    planSteps(item.payload).length > 0 ||
    (item.id === latestPlanItemId.value && props.planContinuation !== undefined)
  );
}

function errorCard(item: ConversationItem) {
  return conversationErrorPresentation(item.payload);
}

function messageTimestamp(turn: ConversationTurn, item: ConversationItem): number | undefined {
  for (const value of [item.startedAt, item.completedAt, turn.startedAt, turn.completedAt])
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  return undefined;
}

function messageTimeLabel(timestamp: number): string {
  return absoluteMessageTime(timestamp);
}

function messageTimeTitle(timestamp: number): string {
  return absoluteMessageTime(timestamp);
}

const processBlocks = computed(() =>
  conversationWorkProcessVisibleBlocks(
    renderedTurns.value,
    processMetadata.value,
    new Set(runDurations.value.keys())
  )
);
const synchronized = computed(() => props.synchronized ?? (props.nodeReady && !props.initializing));
const processNow = createWorkbenchSecondClock(
  computed(
    () =>
      synchronized.value &&
      processBlocks.value.some((block) => block.active && block.startedAt !== undefined)
  )
);

function stepDuration(item: ConversationItem): string | undefined {
  const duration = completedStepDuration(item);
  return duration === undefined
    ? undefined
    : translate('conversationActivity.step', { value: preciseElapsedDurationLabel(duration) });
}
</script>

<template>
  <div
    v-if="renderedTurns.length"
    ref="timelineElement"
    class="conversation-timeline"
    :class="{ 'is-initializing': initializing }"
    :aria-hidden="initializing"
    :inert="initializing"
    @click="animateDisclosure"
  >
    <ConversationWorkProcess
      v-for="block in processBlocks"
      :key="block.id"
      :ref="(instance) => setProcessView(block.id, instance)"
      :block="block"
      :synchronized="synchronized"
      :now="block.active ? processNow : undefined"
      class="conversation-turn"
    >
      <article
        v-for="{ turn, displayItem } in block.entries"
        :key="`${turn.sessionId}:${displayItem.id}`"
        :data-entry-key="`${turn.sessionId}:${displayItem.id}`"
        :class="[
          'conversation-item',
          {
            'is-pending-approval':
              displayItem.type === 'item' &&
              conversationApproval(displayItem.item)?.status === 'PENDING'
          },
          displayItem.type === 'item'
            ? displayItem.item.kind
            : displayItem.type === 'reasoning_group'
              ? 'reasoning reasoning-group'
              : displayItem.type === 'image_generation'
                ? 'tool_call image-generation'
                : displayItem.type === 'subagent_group'
                  ? 'tool_call subagent-group'
                  : displayItem.type === 'tool_group' || displayItem.type === 'read_group'
                    ? 'tool_call tool-group'
                    : displayItem.type === 'command_group'
                      ? 'command_execution command-group'
                      : 'file_change file-change-group'
        ]"
      >
        <template v-if="displayItem.type === 'item' && displayItem.item.permissionStop">
          <RunnerApprovalCard
            class="permission-stop-card"
            :title="
              translate(
                displayItem.item.permissionStop.action === 'ask'
                  ? 'permissionStop.ask'
                  : 'permissionStop.deny'
              )
            "
            :decidable="false"
            :disabled="true"
          >
            <span>{{ displayItem.item.permissionStop.source.toolName }}</span>
            <p>{{ displayItem.item.permissionStop.reason }}</p>
            <details class="permission-call-details" open>
              <summary class="mar-disclosure-summary">
                <MarIcon class="mar-disclosure-icon" name="chevron-right" />{{
                  permissionStopDetail(displayItem.item).label
                }}
              </summary>
              <pre class="approval-detail">{{ permissionStopDetail(displayItem.item).text }}</pre>
              <span v-if="conversationPayload(displayItem.item.payload)?.truncated === true">
                {{ translate('presentation.truncated') }}
              </span>
            </details>
            <p v-if="displayItem.item.permissionStop.action === 'ask'">
              {{ translate('permissionStop.continue') }}
            </p>
          </RunnerApprovalCard>
        </template>
        <template v-else-if="displayItem.type === 'reasoning_group'">
          <details
            v-if="displayItem.text"
            :open="reasoningDisclosure[displayItem.id]"
            @toggle="updateReasoningDisclosure(displayItem.id, $event)"
            @vue:unmounted="delete reasoningDisclosure[displayItem.id]"
          >
            <summary class="mar-disclosure-summary conversation-record-heading">
              <MarIcon class="mar-disclosure-icon" name="chevron-right" />
              <ConversationRecordIcon kind="reasoning" class="conversation-record-icon" />
              <strong>{{ conversationItemLabel('reasoning') }}</strong>
              <span
                v-if="!reasoningDisclosure[displayItem.id] && displayItem.preview"
                class="reasoning-subtitle"
                >{{ displayItem.preview.text }}</span
              >
            </summary>
            <div v-if="reasoningDisclosure[displayItem.id]" class="conversation-detail-body">
              <p class="conversation-detail-text">{{ displayItem.text }}</p>
            </div>
          </details>
        </template>
        <template v-else-if="displayItem.type === 'image_generation'">
          <details v-if="hasConversationDetail(displayItem.item)">
            <summary class="mar-disclosure-summary">
              <MarIcon class="mar-disclosure-icon" name="chevron-right" />
              <strong>{{ translate('presentation.imageGeneration') }}</strong>
              <span>{{
                conversationItemText(
                  displayItem.item.kind,
                  displayItem.item.payload,
                  displayItem.item.status
                )
              }}</span>
            </summary>
            <p>{{ conversationItemDetail(displayItem.item.kind, displayItem.item.payload) }}</p>
          </details>
          <div v-else class="conversation-item-heading">
            <strong>{{ translate('presentation.imageGeneration') }}</strong>
            <span>{{
              conversationItemText(
                displayItem.item.kind,
                displayItem.item.payload,
                displayItem.item.status
              )
            }}</span>
          </div>
          <div
            v-if="props.imageAttachments(turn.runId, displayItem.item.payload).length"
            class="conversation-user-image-attachments"
          >
            <template
              v-for="attachment in props.imageAttachments(turn.runId, displayItem.item.payload)"
              :key="attachment.name"
            >
              <ConversationImageThumbnail
                v-if="attachment.previewUrl"
                :source="attachment.previewUrl"
                :name="attachment.name"
                :aria-label="
                  translate('generated.conversationTimeline.enlarge2', {
                    value0: attachment.name
                  })
                "
                @click="emit('openImage', attachment)"
                @unavailable="emit('imageUnavailable', $event)"
              />
              <span v-else class="conversation-user-image-placeholder"
                >{{ translate('nodeMessages.imageGenerated') }}: {{ attachment.name }}</span
              >
            </template>
          </div>
        </template>
        <template v-else-if="displayItem.type === 'subagent_group'">
          <details
            class="conversation-record-group"
            :open="groupedItemDisclosure[`group:${displayItem.id}`] === true"
            @toggle="updateGroupedItemDisclosure(`group:${displayItem.id}`, $event)"
            @vue:unmounted="delete groupedItemDisclosure[`group:${displayItem.id}`]"
          >
            <summary class="mar-disclosure-summary conversation-record-heading">
              <MarIcon class="mar-disclosure-icon" name="chevron-right" />
              <ConversationRecordIcon kind="tool_call" class="conversation-record-icon" />
              <strong>{{ translate('generated.conversationPresentation.subagent') }}</strong>
              <span class="conversation-record-preview">{{
                subagentGroupText(displayItem.items)
              }}</span>
              <span class="conversation-group-meta">{{
                translate('presentation.subagentOperationCount', {
                  count: displayItem.items.length
                })
              }}</span>
            </summary>
            <template v-if="groupedItemDisclosure[`group:${displayItem.id}`]">
              <details
                v-for="toolItem in displayItem.items"
                :key="toolItem.id"
                class="conversation-tool-detail"
                :open="groupedItemDisclosure[toolItem.id] === true"
                @toggle="updateGroupedItemDisclosure(toolItem.id, $event)"
                @vue:unmounted="delete groupedItemDisclosure[toolItem.id]"
              >
                <summary class="mar-disclosure-summary">
                  <MarIcon class="mar-disclosure-icon" name="chevron-right" />
                  <span class="conversation-tool-preview">{{
                    subagentOperationText(toolItem.payload)
                  }}</span>
                  <span class="conversation-record-meta">{{
                    toolPresentationStatus(toolItem.status)
                  }}</span>
                </summary>
                <ConversationToolDetail
                  v-if="groupedItemDisclosure[toolItem.id]"
                  :item="toolItem"
                  @copy="(text, done) => emit('copy', text, done)"
                />
              </details>
            </template>
          </details>
        </template>
        <template
          v-else-if="displayItem.type === 'tool_group' || displayItem.type === 'read_group'"
        >
          <details
            class="conversation-record-group"
            :data-tool-presentation="displayItem.type === 'read_group' ? 'READ' : undefined"
            :open="groupedItemDisclosure[`group:${displayItem.id}`] === true"
            @toggle="updateGroupedItemDisclosure(`group:${displayItem.id}`, $event)"
            @vue:unmounted="delete groupedItemDisclosure[`group:${displayItem.id}`]"
          >
            <summary class="mar-disclosure-summary conversation-record-heading">
              <MarIcon class="mar-disclosure-icon" name="chevron-right" />
              <ConversationRecordIcon
                :kind="displayItem.type === 'read_group' ? 'READ' : 'tool_call'"
                class="conversation-record-icon"
              />
              <strong>{{
                displayItem.type === 'read_group'
                  ? translate('toolPresentation.title.READ')
                  : conversationItemLabel('tool_call')
              }}</strong>
              <span
                v-if="
                  displayItem.type !== 'read_group' || conversationReadFileCount(displayItem.items)
                "
                class="conversation-group-meta"
              >
                <span>{{
                  displayItem.type === 'read_group'
                    ? translate('toolPresentation.files', {
                        count: conversationReadFileCount(displayItem.items)
                      })
                    : translate('toolPresentation.calls', { count: displayItem.items.length })
                }}</span>
              </span>
            </summary>
            <details
              v-for="entry in groupedItemDisclosure[`group:${displayItem.id}`]
                ? conversationToolEntries(displayItem.items)
                : []"
              :key="entry.id"
              class="conversation-tool-detail"
              :data-read-path="entry.path"
              :open="groupedItemDisclosure[entry.id] === true"
              @toggle="updateGroupedItemDisclosure(entry.id, $event)"
              @vue:unmounted="delete groupedItemDisclosure[entry.id]"
            >
              <summary class="mar-disclosure-summary">
                <MarIcon class="mar-disclosure-icon" name="chevron-right" />
                <span class="conversation-tool-preview">{{
                  entry.path ||
                  conversationItemText(entry.item.kind, entry.item.payload, entry.item.status) ||
                  conversationItemLabel(entry.item.kind, entry.item.payload)
                }}</span>
                <span class="conversation-record-meta">{{
                  toolPresentationStatus(entry.item.status)
                }}</span>
              </summary>
              <template v-if="groupedItemDisclosure[entry.id]">
                <ConversationToolDetail
                  :item="entry.item"
                  @copy="(text, done) => emit('copy', text, done)"
                >
                  <pre class="conversation-detail-text">{{
                    conversationItemDetail(entry.item.kind, entry.item.payload)
                  }}</pre>
                </ConversationToolDetail>
              </template>
            </details>
          </details>
        </template>
        <template v-else-if="displayItem.type === 'command_group'">
          <details
            class="conversation-record-group"
            :open="groupedItemDisclosure[`group:${displayItem.id}`] === true"
            @toggle="updateGroupedItemDisclosure(`group:${displayItem.id}`, $event)"
            @vue:unmounted="delete groupedItemDisclosure[`group:${displayItem.id}`]"
          >
            <summary class="mar-disclosure-summary conversation-record-heading">
              <MarIcon class="mar-disclosure-icon" name="chevron-right" />
              <ConversationRecordIcon kind="command_execution" class="conversation-record-icon" />
              <strong>{{ conversationItemLabel('command_execution') }}</strong>
              <span class="conversation-group-meta">
                <span>{{
                  translate('toolPresentation.calls', { count: displayItem.items.length })
                }}</span>
              </span>
            </summary>
            <details
              v-for="commandItem in groupedItemDisclosure[`group:${displayItem.id}`]
                ? displayItem.items
                : []"
              :key="commandItem.id"
              class="conversation-command-detail"
              :open="groupedItemDisclosure[commandItem.id] === true"
              @toggle="updateGroupedItemDisclosure(commandItem.id, $event)"
              @vue:unmounted="delete groupedItemDisclosure[commandItem.id]"
            >
              <summary class="mar-disclosure-summary">
                <MarIcon class="mar-disclosure-icon" name="chevron-right" />
                <span class="conversation-command-preview">{{
                  conversationItemText(commandItem.kind, commandItem.payload) ||
                  conversationItemLabel(commandItem.kind)
                }}</span>
                <span
                  v-if="toolPresentationStatus(commandItem.status) || stepDuration(commandItem)"
                  class="conversation-command-meta conversation-record-meta"
                >
                  <span class="conversation-command-status">{{
                    toolPresentationStatus(commandItem.status)
                  }}</span>
                  <span v-if="stepDuration(commandItem)" class="conversation-step-duration">{{
                    stepDuration(commandItem)
                  }}</span>
                </span>
              </summary>
              <ConversationToolDetail
                v-if="groupedItemDisclosure[commandItem.id]"
                :item="commandItem"
                @copy="(text, done) => emit('copy', text, done)"
              />
            </details>
          </details>
        </template>
        <template v-else-if="displayItem.type === 'file_change_group'">
          <details
            v-if="conversationFileChangeEntries(displayItem.items).length > 0"
            class="conversation-file-change-details"
            @toggle="updateGroupedItemDisclosure(displayItem.id, $event)"
            @vue:unmounted="delete groupedItemDisclosure[displayItem.id]"
          >
            <summary class="mar-disclosure-summary conversation-record-heading">
              <MarIcon class="mar-disclosure-icon" name="chevron-right" />
              <ConversationRecordIcon kind="file_change" class="conversation-record-icon" />
              <strong>{{ conversationItemLabel('file_change') }}</strong>
              <span class="conversation-group-meta"
                >{{ conversationFileChangeEntries(displayItem.items).length }}
                {{ translate('generated.conversationTimeline.files') }}</span
              >
            </summary>
            <ul v-if="groupedItemDisclosure[displayItem.id]" class="conversation-file-change-list">
              <li
                v-for="(entry, index) in conversationFileChangeEntries(displayItem.items)"
                :key="entry.sourceId ?? `${index}:${entry.status}:${entry.path}`"
              >
                <span
                  v-if="entry.status"
                  class="conversation-file-change-status"
                  :class="`conversation-file-change-status--${entry.change.toLowerCase()}`"
                  >{{ entry.status }}</span
                >
                <button
                  v-tooltip="
                    translate(
                      entry.diff?.status === 'available' && toolChangeEnabled
                        ? 'presentation.viewThisChange'
                        : 'presentation.openCurrentFile',
                      {
                        value0: entry.path
                      }
                    )
                  "
                  class="conversation-file-change-button"
                  type="button"
                  :aria-label="
                    translate(
                      entry.diff?.status === 'available' && toolChangeEnabled
                        ? 'presentation.viewThisChange'
                        : 'presentation.openCurrentFile',
                      {
                        value0: entry.path
                      }
                    )
                  "
                  @click.stop="
                    entry.diff?.status === 'available' && entry.changeId && toolChangeEnabled
                      ? emit('openFileChange', entry)
                      : emit(
                          'openFile',
                          entry.path,
                          undefined,
                          undefined,
                          $event.ctrlKey || $event.metaKey
                        )
                  "
                >
                  {{ entry.path }}
                </button>
                <span
                  v-tooltip="{
                    content: translate(`presentation.diffUnavailable.${entry.diff.reason}`),
                    touch: true
                  }"
                  v-if="entry.diff?.status === 'unavailable'"
                  class="conversation-file-change-note"
                  >{{ translate('presentation.diffUnavailableLabel') }}</span
                >
                <span class="conversation-file-change-stats">
                  <span
                    v-if="entry.additions !== undefined"
                    class="change-additions"
                    :aria-label="translate('presentation.addedLines', { count: entry.additions })"
                    >+{{ entry.additions }}</span
                  >
                  <span
                    v-if="entry.deletions !== undefined"
                    class="change-deletions"
                    :aria-label="translate('presentation.deletedLines', { count: entry.deletions })"
                    >-{{ entry.deletions }}</span
                  >
                </span>
              </li>
            </ul>
          </details>
          <div v-else class="conversation-item-heading">
            <strong>{{ conversationItemLabel('file_change') }}</strong>
          </div>
        </template>
        <template v-else-if="displayItem.item.kind === 'user_message'">
          <div class="conversation-item-heading">
            <strong
              v-tooltip="{
                content: messageHeading(displayItem.item.payload).title,
                disabled: !messageHeading(displayItem.item.payload).title
              }"
              :aria-description="messageHeading(displayItem.item.payload).title"
              >{{ messageHeading(displayItem.item.payload).label }}</strong
            >
          </div>
          <p
            v-if="conversationItemText(displayItem.item.kind, displayItem.item.payload)"
            class="conversation-message"
          >
            {{ conversationItemText(displayItem.item.kind, displayItem.item.payload) }}
          </p>
          <MessageAttachmentFiles
            :files="composerMessagePresentation(displayItem.item.payload).files"
            :image-resource-url="props.imageResourceUrl"
            @open-file="
              (path, line, column, external, attachment) =>
                emit('openFile', path, line, column, external, attachment)
            "
          />
          <div
            v-if="
              !composerMessagePresentation(displayItem.item.payload).files.length &&
              props.imageAttachments(turn.runId, displayItem.item.payload).length
            "
            class="conversation-user-image-attachments"
          >
            <template
              v-for="attachment in props.imageAttachments(turn.runId, displayItem.item.payload)"
              :key="attachment.name"
            >
              <ConversationImageThumbnail
                v-if="attachment.previewUrl"
                :source="attachment.previewUrl"
                :name="attachment.name"
                :aria-label="
                  translate('generated.conversationTimeline.enlarge', { value0: attachment.name })
                "
                @click="emit('openImage', attachment)"
                @unavailable="emit('imageUnavailable', $event)"
              />
              <span v-else class="conversation-user-image-placeholder"
                >{{ translate('generated.conversationTimeline.imageAttachment') }}:
                {{ attachment.name }}</span
              >
            </template>
          </div>
          <div
            v-if="
              messageTimestamp(turn, displayItem.item) !== undefined ||
              conversationItemText(displayItem.item.kind, displayItem.item.payload) ||
              (props.rewindEnabled && turn.rewind) ||
              (props.rollbackEnabled && rollbackTarget(turn, displayItem.item))
            "
            class="conversation-message-actions"
          >
            <time
              v-tooltip="messageTimeTitle(messageTimestamp(turn, displayItem.item)!)"
              v-if="messageTimestamp(turn, displayItem.item) !== undefined"
              class="conversation-message-time"
              :datetime="new Date(messageTimestamp(turn, displayItem.item)!).toISOString()"
              >{{ messageTimeLabel(messageTimestamp(turn, displayItem.item)!) }}</time
            >
            <button
              v-tooltip="
                translate(
                  copiedMessage === `${turn.id}:${displayItem.item.id}`
                    ? 'generated.conversationTimeline.copiedMessage'
                    : 'generated.conversationTimeline.copyMessage2'
                )
              "
              v-if="conversationItemText(displayItem.item.kind, displayItem.item.payload)"
              class="conversation-message-action icon-button utility-control"
              type="button"
              :aria-label="
                copiedMessage === `${turn.id}:${displayItem.item.id}`
                  ? translate('generated.conversationTimeline.copiedMessage')
                  : translate('generated.conversationTimeline.copyMessage', {
                      value0: conversationItemLabel(displayItem.item.kind)
                    })
              "
              @click.stop="copyItem(turn, displayItem.item)"
            >
              <MarIcon name="check" v-if="copiedMessage === `${turn.id}:${displayItem.item.id}`" />
              <MarIcon name="copy" v-else />
            </button>
            <button
              v-tooltip="translate('generated.conversationTimeline.rollBackBeforeThisMessage')"
              v-if="props.rewindEnabled && turn.rewind"
              class="conversation-message-action icon-button utility-control"
              type="button"
              :aria-label="
                translate('generated.conversationTimeline.createARollbackBranchBeforeThisMessage')
              "
              @click.stop="emit('rewind', turn, displayItem.item)"
            >
              <MarIcon name="undo" />
            </button>
            <button
              v-tooltip="translate('generated.conversationTimeline.rollbackConversation')"
              v-if="props.rollbackEnabled && turn.rewind && rollbackTarget(turn, displayItem.item)"
              class="conversation-message-action icon-button utility-control"
              type="button"
              :disabled="props.loading"
              :aria-label="
                translate('generated.conversationTimeline.rollbackConversationBeforeThisMessage')
              "
              @click.stop="emit('rollback', turn, displayItem.item)"
            >
              <MarIcon name="back" />
            </button>
          </div>
        </template>
        <template v-else-if="displayItem.item.kind === 'assistant_message'">
          <AgentMarkdown
            :content="conversationItemText(displayItem.item.kind, displayItem.item.payload)"
            :cache-identity="markdownCacheIdentity(turn, displayItem.item)"
            v-bind="workspaceRoot === undefined ? {} : { workspaceRoot }"
            :image-resource-url="imageResourceUrl"
            @open-image="(source, name) => emit('openImage', { name, previewUrl: source })"
            @open-file="
              (path, line, column, external) => emit('openFile', path, line, column, external)
            "
          />
          <div
            v-if="
              messageTimestamp(turn, displayItem.item) !== undefined ||
              conversationItemText(displayItem.item.kind, displayItem.item.payload) ||
              (props.rewindEnabled && turn.rewind)
            "
            class="conversation-message-actions"
          >
            <time
              v-tooltip="messageTimeTitle(messageTimestamp(turn, displayItem.item)!)"
              v-if="messageTimestamp(turn, displayItem.item) !== undefined"
              class="conversation-message-time"
              :datetime="new Date(messageTimestamp(turn, displayItem.item)!).toISOString()"
              >{{ messageTimeLabel(messageTimestamp(turn, displayItem.item)!) }}</time
            >
            <button
              v-tooltip="
                translate(
                  copiedMessage === `${turn.id}:${displayItem.item.id}`
                    ? 'generated.conversationTimeline.copiedMessage'
                    : 'generated.conversationTimeline.copyMessage4'
                )
              "
              v-if="conversationItemText(displayItem.item.kind, displayItem.item.payload)"
              class="conversation-message-action icon-button utility-control"
              type="button"
              :aria-label="
                copiedMessage === `${turn.id}:${displayItem.item.id}`
                  ? translate('generated.conversationTimeline.copiedMessage')
                  : translate('generated.conversationTimeline.copyMessage3', {
                      value0: conversationItemLabel(displayItem.item.kind)
                    })
              "
              @click.stop="copyItem(turn, displayItem.item)"
            >
              <MarIcon name="check" v-if="copiedMessage === `${turn.id}:${displayItem.item.id}`" />
              <MarIcon name="copy" v-else />
            </button>
            <button
              v-tooltip="translate('generated.conversationTimeline.rollBackAfterThisMessage')"
              v-if="props.rewindEnabled && turn.rewind"
              class="conversation-message-action icon-button utility-control"
              type="button"
              :aria-label="
                translate('generated.conversationTimeline.createARollbackBranchAfterThisMessage')
              "
              @click.stop="emit('rewind', turn, displayItem.item)"
            >
              <MarIcon name="undo" />
            </button>
          </div>
        </template>
        <template v-else-if="displayItem.item.kind === 'user_input_request'">
          <strong>{{ conversationItemLabel(displayItem.item.kind) }}</strong>
          <section class="user-input-card">
            <div
              v-for="question in props.userInputQuestions(displayItem.item.payload)"
              :key="question.id"
              class="user-input-question"
            >
              <span>{{ question.prompt }}</span>
              <el-checkbox-group
                v-if="question.input === 'MULTI_SELECT' && question.options.length"
                :disabled="
                  loading ||
                  displayItem.item.status !== 'PENDING' ||
                  props.userInputSubmitted(displayItem.item.id)
                "
                :model-value="userInputCheckboxAnswer(displayItem.item.id, question.id)"
                @update:model-value="
                  emit(
                    'setAnswer',
                    displayItem.item.id,
                    question.id,
                    Array.isArray($event) ? $event.map(String) : []
                  )
                "
              >
                <el-checkbox
                  v-for="option in question.options"
                  :key="option.value"
                  :value="option.value"
                  >{{ option.label }}</el-checkbox
                >
              </el-checkbox-group>
              <el-radio-group
                v-else-if="question.options.length"
                :disabled="
                  loading ||
                  displayItem.item.status !== 'PENDING' ||
                  props.userInputSubmitted(displayItem.item.id)
                "
                :model-value="props.userInputAnswer(displayItem.item.id, question.id)"
                @update:model-value="
                  emit('setAnswer', displayItem.item.id, question.id, String($event))
                "
              >
                <el-radio
                  v-for="option in question.options"
                  :key="option.value"
                  :value="option.value"
                  >{{ option.label }}</el-radio
                >
              </el-radio-group>
              <el-input
                v-if="
                  question.options.length === 0 ||
                  (question.allowOther && question.input !== 'MULTI_SELECT')
                "
                :model-value="props.userInputAnswer(displayItem.item.id, question.id)"
                :disabled="
                  loading ||
                  displayItem.item.status !== 'PENDING' ||
                  props.userInputSubmitted(displayItem.item.id)
                "
                :placeholder="
                  question.allowOther
                    ? translate('generated.conversationTimeline.orEnterAnotherAnswer')
                    : translate('generated.conversationTimeline.enterAnAnswer')
                "
                size="small"
                @update:model-value="emit('setAnswer', displayItem.item.id, question.id, $event)"
              />
              <el-input
                v-if="question.allowOther && question.input === 'MULTI_SELECT'"
                :model-value="
                  props.userInputAnswer(displayItem.item.id, userInputOtherAnswerId(question.id))
                "
                :disabled="
                  loading ||
                  displayItem.item.status !== 'PENDING' ||
                  props.userInputSubmitted(displayItem.item.id)
                "
                :placeholder="translate('generated.conversationTimeline.orEnterAnotherAnswer2')"
                size="small"
                @update:model-value="
                  emit(
                    'setAnswer',
                    displayItem.item.id,
                    userInputOtherAnswerId(question.id),
                    $event
                  )
                "
              />
            </div>
            <div class="conversation-card-actions">
              <el-button
                type="primary"
                size="small"
                :disabled="
                  loading ||
                  displayItem.item.status !== 'PENDING' ||
                  !conversationTurnHasRunId(turn) ||
                  props.userInputSubmitted(displayItem.item.id)
                "
                @click="emit('submitInput', turn, displayItem.item)"
                :loading-icon="marIcon('loading-action')"
                >{{ translate('generated.conversationTimeline.submitAnswers') }}</el-button
              >
            </div>
          </section>
        </template>
        <template v-else-if="displayItem.item.kind === 'approval_request'">
          <RunnerApprovalCard
            v-if="conversationApproval(displayItem.item)"
            :title="approvalToolLabel(conversationApproval(displayItem.item)!)"
            :status-label="approvalStatusLabel(conversationApproval(displayItem.item)!.status)"
            :decidable="
              turnActive(turn) &&
              conversationApproval(displayItem.item)!.status === 'PENDING' &&
              nodeReady
            "
            :disabled="loading || !conversationTurnHasRunId(turn)"
            @decide="
              emit(
                'decideApproval',
                turn.runId!,
                conversationApproval(displayItem.item)!.id,
                $event
              )
            "
          >
            <p v-if="approvalReason(conversationApproval(displayItem.item)!)">
              {{ approvalReason(conversationApproval(displayItem.item)!) }}
            </p>
            <details class="permission-call-details" open>
              <summary class="mar-disclosure-summary">
                <MarIcon class="mar-disclosure-icon" name="chevron-right" />{{
                  approvalDetail(conversationApproval(displayItem.item)!).label
                }}
              </summary>
              <pre class="approval-detail">{{
                approvalDetail(conversationApproval(displayItem.item)!).text
              }}</pre>
            </details>
            <span
              v-if="conversationApproval(displayItem.item)!.expiresAt > 0"
              class="approval-expiry"
            >
              {{ translate('generated.conversationApprovals.expires') }}
              {{ managementDateTime(conversationApproval(displayItem.item)!.expiresAt) }}
            </span>
          </RunnerApprovalCard>
        </template>
        <template v-else-if="displayItem.item.kind === 'todo_list'">
          <section v-if="taskListItems(displayItem.item.payload).length" class="task-list">
            <div class="task-list-heading">
              <strong>{{ conversationItemLabel(displayItem.item.kind) }}</strong>
              <span>{{
                conversationItemText(displayItem.item.kind, displayItem.item.payload)
              }}</span>
            </div>
            <ul class="task-list-items">
              <li v-for="(task, index) in taskListItems(displayItem.item.payload)" :key="index">
                <span class="task-list-status" :class="`task-list-status--${task.tone}`">
                  {{ task.status }}
                </span>
                <div class="task-list-content">
                  <AgentMarkdown
                    :content="task.text"
                    v-bind="workspaceRoot === undefined ? {} : { workspaceRoot }"
                    :image-resource-url="imageResourceUrl"
                    @open-image="(source, name) => emit('openImage', { name, previewUrl: source })"
                    @open-file="
                      (path, line, column, external) =>
                        emit('openFile', path, line, column, external)
                    "
                  />
                </div>
              </li>
            </ul>
          </section>
          <div v-else class="conversation-item-heading">
            <strong>{{ conversationItemLabel(displayItem.item.kind) }}</strong>
          </div>
        </template>
        <template v-else-if="displayItem.item.kind === 'error'">
          <section class="conversation-error-card">
            <div class="conversation-error-heading">
              <strong>{{ conversationItemLabel(displayItem.item.kind) }}</strong>
              <span
                v-if="errorCard(displayItem.item).httpStatus !== null"
                class="conversation-error-http-status"
              >
                {{
                  translate('generated.conversationPresentation.httpStatus', {
                    value0: errorCard(displayItem.item).httpStatus ?? ''
                  })
                }}
              </span>
              <span
                v-if="conversationErrorCodeVisible(errorCard(displayItem.item))"
                class="conversation-error-code"
              >
                {{ errorCard(displayItem.item).code }}
              </span>
            </div>
            <p v-if="errorCard(displayItem.item).message" class="conversation-error-message">
              {{ errorCard(displayItem.item).message }}
            </p>
          </section>
        </template>
        <template v-else-if="displayItem.item.kind === 'plan'">
          <details v-if="hasPlanContent(displayItem.item)" open>
            <summary class="mar-disclosure-summary">
              <MarIcon class="mar-disclosure-icon" name="chevron-right" />
              <strong>{{ conversationItemLabel(displayItem.item.kind) }}</strong>
              <span
                v-if="planSteps(displayItem.item.payload).length"
                class="conversation-record-meta"
                >{{ planSteps(displayItem.item.payload).length }}
                {{ translate('generated.conversationTimeline.planItems') }}</span
              >
            </summary>
            <AgentMarkdown
              v-if="conversationItemText(displayItem.item.kind, displayItem.item.payload)"
              :content="conversationItemText(displayItem.item.kind, displayItem.item.payload)"
              v-bind="workspaceRoot === undefined ? {} : { workspaceRoot }"
              :image-resource-url="imageResourceUrl"
              @open-image="(source, name) => emit('openImage', { name, previewUrl: source })"
              @open-file="
                (path, line, column, external) => emit('openFile', path, line, column, external)
              "
            />
            <ol v-if="planSteps(displayItem.item.payload).length" class="plan-step-list">
              <li v-for="(step, index) in planSteps(displayItem.item.payload)" :key="index">
                <span v-if="step.status" class="plan-step-status">{{ step.status }}</span>
                <AgentMarkdown
                  :content="step.text"
                  v-bind="workspaceRoot === undefined ? {} : { workspaceRoot }"
                  :image-resource-url="imageResourceUrl"
                  @open-image="(source, name) => emit('openImage', { name, previewUrl: source })"
                  @open-file="
                    (path, line, column, external) => emit('openFile', path, line, column, external)
                  "
                />
              </li>
            </ol>
            <div
              v-if="displayItem.item.id === latestPlanItemId && planContinuation"
              class="conversation-card-actions"
            >
              <el-button
                type="primary"
                size="small"
                :disabled="loading"
                @click="emit('implementPlan', displayItem.item)"
                >{{ planContinuation.continuation?.label }}</el-button
              >
            </div>
          </details>
          <div v-else class="conversation-item-heading">
            <strong>{{ conversationItemLabel(displayItem.item.kind) }}</strong>
          </div>
        </template>
        <template
          v-else-if="
            displayItem.item.kind === 'tool_call' && toolPresentation(displayItem.item.payload)
          "
        >
          <details
            class="conversation-tool-presentation"
            :data-tool-presentation="toolPresentation(displayItem.item.payload)?.kind"
          >
            <summary class="mar-disclosure-summary conversation-record-heading">
              <MarIcon class="mar-disclosure-icon" name="chevron-right" />
              <ConversationRecordIcon
                :kind="toolPresentation(displayItem.item.payload)?.kind ?? 'tool_call'"
                class="conversation-record-icon"
              />
              <strong>{{
                conversationItemLabel(displayItem.item.kind, displayItem.item.payload)
              }}</strong>
              <span class="conversation-record-preview">{{
                conversationItemText(
                  displayItem.item.kind,
                  displayItem.item.payload,
                  displayItem.item.status
                )
              }}</span>
              <span class="conversation-record-meta">{{
                toolPresentationStatus(displayItem.item.status)
              }}</span>
            </summary>
            <ConversationToolDetail
              :item="displayItem.item"
              @copy="(text, done) => emit('copy', text, done)"
            >
              <p class="conversation-detail-text">
                {{ conversationItemDetail(displayItem.item.kind, displayItem.item.payload) }}
              </p>
              <ul
                v-if="toolPresentationSources(displayItem.item.payload).length"
                class="conversation-tool-sources"
              >
                <li
                  v-for="(source, index) in toolPresentationSources(displayItem.item.payload)"
                  :key="index"
                >
                  <a
                    v-if="source.href"
                    :href="source.href"
                    target="_blank"
                    rel="noopener noreferrer"
                    >{{ source.title || source.url }}</a
                  >
                  <span v-else>{{ source.title || source.url }}</span>
                  <span v-if="source.host" class="conversation-tool-source-host">{{
                    source.host
                  }}</span>
                  <p v-if="source.snippet">{{ source.snippet }}</p>
                </li>
              </ul>
            </ConversationToolDetail>
          </details>
        </template>
        <template v-else>
          <details v-if="hasConversationDetail(displayItem.item)">
            <summary class="mar-disclosure-summary">
              <MarIcon class="mar-disclosure-icon" name="chevron-right" />
              <strong>{{
                conversationItemLabel(displayItem.item.kind, displayItem.item.payload)
              }}</strong>
              <span>{{
                conversationItemText(
                  displayItem.item.kind,
                  displayItem.item.payload,
                  displayItem.item.status
                )
              }}</span>
            </summary>
            <ConversationToolDetail
              v-if="displayItem.item.kind === 'tool_call'"
              :item="displayItem.item"
              @copy="(text, done) => emit('copy', text, done)"
            />
            <div v-else-if="displayItem.item.kind === 'reasoning'" class="conversation-detail-body">
              <p class="conversation-detail-text">
                {{ conversationItemDetail(displayItem.item.kind, displayItem.item.payload) }}
              </p>
            </div>
            <p v-else-if="conversationItemDetail(displayItem.item.kind, displayItem.item.payload)">
              {{ conversationItemDetail(displayItem.item.kind, displayItem.item.payload) }}
            </p>
          </details>
          <div v-else class="conversation-item-heading">
            <strong>
              {{ conversationItemLabel(displayItem.item.kind, displayItem.item.payload) }}
            </strong>
            <span>{{
              conversationItemText(
                displayItem.item.kind,
                displayItem.item.payload,
                displayItem.item.status
              )
            }}</span>
          </div>
          <div
            v-if="props.imageAttachments(turn.runId, displayItem.item.payload).length"
            class="conversation-user-image-attachments"
          >
            <template
              v-for="attachment in props.imageAttachments(turn.runId, displayItem.item.payload)"
              :key="attachment.name"
            >
              <ConversationImageThumbnail
                v-if="attachment.previewUrl"
                :source="attachment.previewUrl"
                :name="attachment.name"
                :aria-label="
                  translate('generated.conversationTimeline.enlarge2', { value0: attachment.name })
                "
                @click="emit('openImage', attachment)"
                @unavailable="emit('imageUnavailable', $event)"
              />
              <span v-else class="conversation-user-image-placeholder"
                >{{ translate('generated.conversationTimeline.imageAttachment2') }}:
                {{ attachment.name }}</span
              >
            </template>
          </div>
        </template>
      </article>
      <p v-if="block.footerTurnId" class="conversation-run-duration">
        {{ runDurations.get(block.footerTurnId) }}
      </p>
    </ConversationWorkProcess>
  </div>
</template>

<style scoped>
.conversation-run-duration,
.conversation-step-duration {
  color: var(--mar-conversation-muted);
  font-size: var(--mar-font-size-meta);
}

.conversation-tool-sources {
  padding-left: 1.25rem;
  overflow-wrap: anywhere;
}

.conversation-tool-sources > li + li {
  margin-top: 0.5rem;
}

.conversation-tool-source-host {
  margin-left: 0.5rem;
  color: var(--mar-conversation-muted);
  font-size: var(--mar-font-size-meta);
}

.permission-stop-card {
  display: grid;
  gap: 0.5rem;
  overflow-wrap: anywhere;
}

.plan-step-list {
  display: grid;
  gap: 0.5rem;
  margin: 0.6rem 0;
  padding-left: 1.25rem;
}

.plan-step-list > li {
  min-width: 0;
}

.plan-step-status {
  display: inline-block;
  margin-bottom: 0.2rem;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
  font-weight: 600;
}

.task-list {
  display: grid;
  gap: 0.45rem;
}

.task-list-heading {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
}

.task-list-items {
  display: grid;
  margin: 0;
  border-top: 1px solid var(--mar-conversation-process-border);
  padding: 0;
  list-style: none;
}

.task-list-items > li {
  display: grid;
  min-width: 0;
  grid-template-columns: max-content minmax(0, 1fr);
  align-items: start;
  gap: 0.5rem;
  border-bottom: 1px solid var(--mar-conversation-process-border);
  padding: 0.42rem 0;
}

.task-list-status {
  align-self: start;
  display: inline-flex;
  min-width: 4.25rem;
  justify-content: center;
  line-height: 1.45;
  white-space: nowrap;
}

.task-list-content {
  min-width: 0;
}

.task-list-content :deep(.agent-markdown) {
  line-height: 1.45;
}

.task-list-content :deep(.agent-markdown > p) {
  margin: 0;
}

.conversation-timeline {
  --conversation-record-gap: 4px;
  --conversation-item-inset: 12px;
  display: grid;
  min-width: 0;
  gap: var(--conversation-record-gap);
}

.conversation-timeline.is-initializing {
  visibility: hidden;
}

.conversation-turn {
  display: grid;
  min-width: 0;
  gap: 0;
}

.conversation-item {
  position: relative;
  width: min(100%, 820px);
  max-width: 100%;
  min-width: 0;
  box-sizing: border-box;
  border: 1px solid var(--mar-conversation-border);
  border-radius: var(--mar-radius-surface);
  background: var(--mar-conversation-surface);
  color: var(--mar-conversation-text);
  padding: 12px 14px;
  box-shadow: none;
  font-size: var(--mar-font-size-body);
}

.conversation-item.user_message {
  width: min(88%, 760px);
  justify-self: end;
  border-color: color-mix(in srgb, var(--mar-color-brand) 8%, var(--mar-conversation-border));
  background: color-mix(in srgb, var(--mar-color-brand) 6%, var(--mar-conversation-surface));
}

.conversation-item.assistant_message {
  justify-self: start;
  border: 0;
  background: transparent;
  padding: 4px var(--conversation-item-inset);
}

.conversation-item:where(:not(.user_message):not(.assistant_message)) {
  justify-self: start;
  border: 0;
  background: transparent;
  padding: 4px var(--conversation-item-inset);
}

.conversation-item:where(.approval_request, .user_input_request, .error) {
  padding-block: 8px;
  border: 1px solid var(--mar-conversation-process-border);
  background: var(--mar-conversation-process);
}

.conversation-item > details[open] {
  display: flow-root;
  border-radius: var(--mar-radius-surface);
  background: var(--mar-conversation-process);
}

.conversation-item:where(
    .reasoning,
    .reasoning-group,
    .tool_call,
    .tool-group,
    .subagent-group,
    .command-group,
    .file-change-group
  )
  > details[open],
.conversation-item > details.conversation-tool-presentation[open] {
  background: transparent;
}

.conversation-item.error {
  border-left-color: var(--el-color-danger);
  background: color-mix(in srgb, var(--el-color-danger) 6%, var(--mar-conversation-surface));
}

.conversation-item.is-pending-approval {
  border-left-color: var(--mar-color-warning-accent);
}

.conversation-item:has(> details.conversation-tool-presentation),
.conversation-item:where(
  .reasoning-group,
  .tool-group,
  .subagent-group,
  .command-group,
  .file-change-group
) {
  padding: 0;
}

.conversation-item:has(> details.conversation-tool-presentation) > details > summary,
.conversation-item:where(
    .reasoning-group,
    .tool-group,
    .subagent-group,
    .command-group,
    .file-change-group
  )
  > details
  > summary,
.conversation-reasoning-status {
  padding: 4px var(--conversation-item-inset);
  box-sizing: border-box;
}

.conversation-item:has(> details.conversation-tool-presentation)
  > details
  > :not(summary):not(.conversation-detail-body),
.conversation-item:where(
    .reasoning-group,
    .tool-group,
    .subagent-group,
    .command-group,
    .file-change-group
  )
  > details
  > :not(summary):not(details):not(.conversation-detail-body) {
  margin: 0 var(--conversation-item-inset) 8px;
}

.conversation-item > details > summary > span,
.conversation-reasoning-status > span,
.conversation-item-heading > span,
.task-list-heading > span {
  color: var(--mar-conversation-muted);
}

.conversation-item.reasoning-group > details > summary {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conversation-item.reasoning-group > details,
.conversation-item.tool-group > details,
.conversation-item.subagent-group > details,
.conversation-item.command-group > details,
.conversation-item.file-change-group {
  min-width: 0;
}

.subagent-call-error {
  color: var(--mar-color-danger-text);
}

.conversation-reasoning-status {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
}

.conversation-item-heading {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
}

.conversation-error-card {
  display: grid;
  gap: 0.45rem;
}

.conversation-error-heading {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.conversation-error-http-status,
.conversation-error-code {
  border: 1px solid color-mix(in srgb, var(--el-color-danger) 52%, transparent);
  border-radius: var(--mar-radius-marker);
  background: color-mix(in srgb, var(--el-color-danger) 12%, transparent);
  padding: 0 0.3rem;
  color: var(--el-color-danger);
  font-size: var(--mar-font-size-meta);
  font-weight: 600;
  line-height: 1.3;
}

.conversation-error-code {
  max-width: 100%;
  border-color: var(--mar-border-medium);
  background: var(--mar-fill-soft);
  color: var(--mar-text-secondary);
  font-family: var(--mar-font-mono);
  overflow-wrap: anywhere;
}

.conversation-error-message {
  margin: 0;
  color: var(--mar-text-primary);
  line-height: 1.55;
  overflow-wrap: anywhere;
}

.conversation-tool-list,
.conversation-command-list {
  display: grid;
  gap: 0.45rem;
  margin: 0.45rem 0 0 0.65rem;
  border-left: 2px solid var(--mar-conversation-process-border);
  padding-left: 0.7rem;
}

.conversation-tool-detail,
.conversation-command-detail {
  border-top: 1px solid var(--mar-conversation-process-border);
  padding-top: 0.45rem;
}

.conversation-record-icon {
  display: block;
  width: 1.125rem;
  height: 1.125rem;
  color: var(--mar-conversation-muted);
}

.conversation-item summary.conversation-record-heading > .mar-disclosure-icon,
.conversation-item summary.conversation-record-heading > .conversation-record-icon,
.conversation-item summary.conversation-record-heading > strong,
.conversation-item summary.conversation-record-heading > span {
  margin-inline: 0;
}

.conversation-item summary.conversation-record-heading > strong {
  font-weight: 500;
}

.conversation-group-meta {
  display: flex;
  gap: 0.25rem 0.5rem;
  min-width: 0;
  justify-self: end;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.conversation-record-heading > .reasoning-subtitle {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conversation-record-heading > .conversation-record-preview {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conversation-record-group > .conversation-tool-detail,
.conversation-record-group > .conversation-command-detail {
  border-top: 0;
  padding: 0;
}

details.conversation-record-group[open] > details:last-child {
  margin-bottom: var(--conversation-record-gap);
}

.conversation-record-group > summary {
  padding: 4px var(--conversation-item-inset);
}

.conversation-item details.conversation-record-group > details {
  margin: var(--conversation-record-gap) 0 0 0.5rem;
}

.conversation-record-group > summary > span + span {
  margin-inline-start: 0.4em;
}

.conversation-record-group > details > summary {
  padding: 4px var(--conversation-item-inset);
}

.conversation-item .conversation-detail-body {
  margin: 0.5rem var(--conversation-item-inset);
  margin-inline-start: calc(
    var(--conversation-item-inset) + var(--conversation-detail-start, calc(1em + 0.5rem)) - 0.75rem
  );
}

.conversation-item .conversation-detail-body > .conversation-detail-text {
  margin: 0;
  font-size: inherit;
  line-height: inherit;
}

.conversation-item.reasoning-group,
.conversation-item:has(> .conversation-tool-presentation) {
  --conversation-detail-start: calc(1em + 1.125rem + 1rem);
}

.conversation-record-group > details > summary > .mar-disclosure-icon {
  margin-inline: 0;
  color: var(--mar-conversation-muted);
}

.conversation-record-group > details > summary > span {
  min-width: 0;
  overflow-wrap: anywhere;
}

.conversation-record-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0 0.5rem;
  color: var(--mar-conversation-muted);
  font-size: var(--mar-font-size-meta);
  font-variant-numeric: tabular-nums;
}

.conversation-command-meta > span {
  margin-inline: 0;
}

.conversation-command-preview {
  font-family: var(--mar-font-mono);
}

.conversation-item .conversation-command-output,
.conversation-item .conversation-record-detail {
  margin: 0.5rem 0 0 0.5rem;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.conversation-item .conversation-command-output {
  padding: 0.625rem 0.75rem;
  background: var(--mar-conversation-code);
  border-radius: var(--mar-radius-control);
  font-family: var(--mar-font-mono);
}

.conversation-tool-sources {
  margin: 0.5rem 0 0;
  padding-inline-start: 1rem;
}

.conversation-tool-sources > li + li {
  margin-top: 0.75rem;
}

.conversation-tool-source-host {
  margin-inline-start: 0.5rem;
  color: var(--mar-conversation-muted);
  font-size: var(--mar-font-size-meta);
}

.conversation-file-change-list {
  display: grid;
  gap: 0.25rem;
  margin: 0.45rem 0 0;
  padding: 0;
  list-style: none;
  color: var(--mar-text-primary);
  font: inherit;
  font-size: var(--mar-font-size-body);
  line-height: 1.65;
  word-break: break-all;
}

.conversation-file-change-list li {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr) max-content;
  align-items: baseline;
  gap: 0.35rem;
  min-width: 0;
}

.conversation-file-change-stats {
  grid-column: 3;
  display: inline-flex;
  flex: 0 0 auto;
  gap: 0.4rem;
  margin-left: auto;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.change-additions {
  color: var(--mar-color-success-text);
}
.change-deletions {
  color: var(--mar-color-danger-text);
}
.conversation-file-change-note {
  color: var(--el-text-color-secondary);
  font-size: var(--mar-font-size-meta);
}

.conversation-file-change-status,
.task-list-status {
  flex: 0 0 auto;
  border: 1px solid color-mix(in srgb, var(--el-color-info) 48%, transparent);
  border-radius: var(--mar-radius-marker);
  background: color-mix(in srgb, var(--el-color-info) 12%, transparent);
  padding: 0 0.3rem;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
  font-weight: 600;
  line-height: 1.3;
  text-align: center;
  white-space: nowrap;
}

.conversation-file-change-status {
  grid-column: 1;
  min-width: 2.75rem;
  line-height: 1.3;
}

.task-list-status.task-list-status--todo {
  border-color: var(--mar-border-strong);
  background: var(--mar-fill-soft);
  color: var(--mar-text-secondary);
}

.task-list-status.task-list-status--in-progress {
  border-color: color-mix(in srgb, var(--el-color-warning) 52%, transparent);
  background: color-mix(in srgb, var(--el-color-warning) 13%, transparent);
  color: var(--el-color-warning);
}

.task-list-status.task-list-status--done {
  border-color: color-mix(in srgb, var(--el-color-success) 52%, transparent);
  background: color-mix(in srgb, var(--el-color-success) 13%, transparent);
  color: var(--el-color-success);
}

.conversation-file-change-status--added {
  border-color: color-mix(in srgb, var(--el-color-success) 52%, transparent);
  background: color-mix(in srgb, var(--el-color-success) 13%, transparent);
  color: var(--el-color-success);
}

.conversation-file-change-status--modified,
.conversation-file-change-status--type_changed {
  border-color: color-mix(in srgb, var(--el-color-warning) 52%, transparent);
  background: color-mix(in srgb, var(--el-color-warning) 13%, transparent);
  color: var(--el-color-warning);
}

.conversation-file-change-status--deleted {
  border-color: color-mix(in srgb, var(--el-color-danger) 52%, transparent);
  background: color-mix(in srgb, var(--el-color-danger) 13%, transparent);
  color: var(--el-color-danger);
}

.conversation-file-change-status--renamed,
.conversation-file-change-status--copied {
  border-color: color-mix(in srgb, var(--el-color-primary) 52%, transparent);
  background: color-mix(in srgb, var(--el-color-primary) 13%, transparent);
  color: var(--el-color-primary);
}

.conversation-file-change-button {
  grid-column: 2;
  min-width: 0;
  max-width: 100%;
  border: 0;
  border-radius: 4px;
  background: transparent;
  padding: 0;
  color: inherit;
  cursor: pointer;
  font: inherit;
  text-align: left;
  text-decoration: underline;
  text-decoration-color: transparent;
  text-underline-offset: 2px;
  overflow-wrap: anywhere;
  word-break: normal;
}

.conversation-file-change-button:hover,
.conversation-file-change-button:focus-visible {
  color: var(--mar-color-brand-text);
  text-decoration-color: currentColor;
  outline: none;
}

.user-input-card {
  display: grid;
  gap: 0.65rem;
  margin-top: 0.5rem;
}

.user-input-question {
  display: grid;
  gap: 0.35rem;
  color: var(--mar-text-primary);
}

.conversation-card-actions {
  display: grid;
  gap: 0.5rem;
  margin-top: 0.5rem;
}

.conversation-item strong {
  color: var(--mar-conversation-muted);
  font-size: var(--mar-font-size-body);
}

.conversation-item-heading {
  min-height: 1.2rem;
}

.conversation-message-actions {
  display: flex;
  min-height: 24px;
  justify-content: flex-end;
  gap: 2px;
  margin-top: 4px;
}

.conversation-message-time {
  align-self: center;
  margin-right: auto;
  color: var(--mar-conversation-muted);
  font-size: var(--mar-font-size-meta);
  font-variant-numeric: tabular-nums;
  line-height: 1;
}

.conversation-message-action {
  display: inline-flex;
  width: var(--mar-utility-control-size);
  height: var(--mar-utility-control-size);
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  padding: 0;
}

@media (prefers-reduced-motion: reduce) {
  .conversation-message-action {
    transition: none;
  }
}

.conversation-item p,
.conversation-item summary {
  margin: 0.25rem 0 0;
  white-space: pre-wrap;
  font-size: var(--mar-font-size-body);
  line-height: 1.65;
  word-break: break-word;
}

.conversation-item.user_message strong {
  color: var(--mar-conversation-muted);
}

.conversation-user-image-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem;
  margin-top: 0.55rem;
}

.conversation-user-image-placeholder {
  display: inline-flex;
  align-items: center;
  min-height: 32px;
  border: 1px dashed color-mix(in srgb, var(--mar-color-brand) 46%, transparent);
  border-radius: 6px;
  padding: 0.3rem 0.5rem;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
}

.conversation-item details {
  margin-top: 0;
}

.conversation-item summary {
  margin: 0;
  cursor: pointer;
  color: var(--mar-conversation-text);
  line-height: 20px;
  list-style: none;
  border-radius: var(--mar-radius-control);
}

.conversation-item details > summary {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  white-space: nowrap;
}

.conversation-item details > summary > .mar-disclosure-icon,
.conversation-item details > summary > .conversation-record-icon {
  flex: none;
  margin-inline: 0;
}

.conversation-item details > summary > strong {
  min-width: 0;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-inline: 0;
}

.conversation-item details > summary > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conversation-item
  details
  > summary
  > span:not(.conversation-record-meta):not(.conversation-group-meta) {
  flex: 1;
}

.conversation-item summary > .conversation-record-meta,
.conversation-item summary.conversation-record-heading > .conversation-group-meta {
  flex: none;
  margin-inline-start: auto;
  white-space: nowrap;
}

@media (hover: hover) and (pointer: fine) {
  .conversation-item summary:hover {
    background-color: var(--mar-fill-row-hover);
  }
}

.conversation-item summary:active {
  background-color: var(--mar-fill-row-hover);
}

.conversation-command-status,
.conversation-step-duration {
  margin-inline-start: 0.5rem;
}

.conversation-item summary:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
}

.conversation-item summary strong {
  margin-right: 0.4rem;
}

@media (max-width: 767px) {
  .conversation-timeline {
    --conversation-item-inset: 8px;
  }

  .conversation-file-change-list li {
    grid-template-columns: minmax(0, 1fr) max-content;
    row-gap: 2px;
  }

  .conversation-file-change-status {
    justify-self: start;
    grid-row: 1;
  }

  .conversation-file-change-stats {
    grid-column: 2;
    grid-row: 1;
  }

  .conversation-file-change-button {
    grid-column: 1 / -1;
    grid-row: 2;
  }

  .conversation-message-action {
    width: 36px;
    height: 36px;
  }

  .conversation-item.user_message {
    width: 100%;
    max-width: 100%;
    justify-self: stretch;
  }
}
</style>

<style scoped>
.approval-item-card p {
  margin: 0;
  line-height: 1.55;
}

.permission-call-details {
  min-width: 0;
}

.permission-call-details > summary,
.approval-expiry {
  color: var(--mar-conversation-muted);
  font-size: var(--mar-font-size-meta);
}

.permission-call-details > summary {
  cursor: pointer;
}

.permission-call-details > summary:focus-visible {
  outline: 2px solid var(--mar-color-brand);
  outline-offset: 2px;
}

.approval-detail {
  margin: 0.35rem 0 0;
  max-height: 9rem;
  overflow: auto;
  border: 1px solid var(--mar-conversation-process-border);
  border-radius: 6px;
  background: var(--mar-conversation-code);
  padding: 0.45rem 0.55rem;
  color: var(--mar-conversation-text);
  font-family: var(--mar-font-mono);
  font-size: var(--mar-font-size-meta);
  line-height: 1.45;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>

<style scoped>
:global(.user-input-question .el-radio-group) {
  display: grid;
  gap: 0.25rem;
  align-items: start;
}

:global(.conversation-card-actions .el-button) {
  width: 100%;
  margin: 0;
}
</style>

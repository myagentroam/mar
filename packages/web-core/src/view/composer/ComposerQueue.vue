<script setup lang="ts">
import { ArrowDown, ArrowUp } from '@element-plus/icons-vue';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { translate } from '../../service/LocalePreferenceService.js';
import type { RunnerCommandState, WorkspaceQueueItem } from '../../model/workbench.js';
import { composerMessagePresentation } from '../../util/composer-message.js';
import {
  composerMessageSource,
  conversationItemText
} from '../../util/conversation-presentation.js';

function messageSource(item: WorkspaceQueueItem) {
  return composerMessageSource(composerMessagePresentation({ text: item.content }));
}

const props = defineProps<{
  readonly items: readonly WorkspaceQueueItem[];
  readonly paused: boolean;
  readonly loading: boolean;
  readonly editingQueueItemId: string | undefined;
  readonly editingContent: string;
  readonly goal: RunnerCommandState | undefined;
}>();

const emit = defineEmits<{
  dragStart: [queueItemId: string];
  reorder: [queueItemId: string];
  edit: [item: WorkspaceQueueItem];
  updateContent: [value: string];
  save: [queueItemId: string];
  execute: [item: WorkspaceQueueItem, editedContent?: string];
  deleteItem: [queueItemId: string];
  saveGoal: [objective: string];
  clearGoal: [];
}>();

const goalEditing = ref(false);
const goalObjective = ref('');
const goalDetailsOpen = ref(false);
const contextMenu = ref<{ queueItemId: string; x: number; y: number }>();
const contextMenuTrigger = ref<HTMLButtonElement>();
const contextMenuIndex = computed(() =>
  props.items.findIndex((item) => item.queueItemId === contextMenu.value?.queueItemId)
);
const LONG_PRESS_MS = 500;
let lastPointerType: string | undefined;
let pressItem: WorkspaceQueueItem | undefined;
let pressPointerId: number | undefined;
let pressTimer: ReturnType<typeof setTimeout> | undefined;
let pressStartX = 0;
let pressStartY = 0;
let clickGuard: (() => void) | undefined;

function clearPress(): void {
  if (pressTimer !== undefined) {
    clearTimeout(pressTimer);
    pressTimer = undefined;
  }
  pressItem = undefined;
  pressPointerId = undefined;
}

function releaseClickGuard(): void {
  clickGuard?.();
  clickGuard = undefined;
}

function suppressPostPressClick(pointerId: number): void {
  if (typeof globalThis.addEventListener !== 'function') return;
  if (clickGuard !== undefined) return;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const onClick = (event: Event): void => {
    if ('detail' in event && event.detail === 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    releaseClickGuard();
  };
  const onPointerUp = (event: Event): void => {
    if ((event as PointerEvent).pointerId !== pointerId) return;
    globalThis.removeEventListener('pointerup', onPointerUp, true);
    globalThis.removeEventListener('pointercancel', onPointerUp, true);
    timeout = globalThis.setTimeout(releaseClickGuard, 50);
  };
  globalThis.addEventListener('click', onClick, true);
  globalThis.addEventListener('pointerup', onPointerUp, true);
  globalThis.addEventListener('pointercancel', onPointerUp, true);
  clickGuard = () => {
    if (timeout !== undefined) globalThis.clearTimeout(timeout);
    globalThis.removeEventListener('click', onClick, true);
    globalThis.removeEventListener('pointerup', onPointerUp, true);
    globalThis.removeEventListener('pointercancel', onPointerUp, true);
  };
}

function closeContextMenu(): void {
  contextMenu.value = undefined;
}

function isInteractivePointerTarget(event: Event): boolean {
  const target = event.target as Element | null;
  return (
    typeof target?.closest === 'function' &&
    target.closest('button, textarea, .el-textarea, a, .el-input') !== null
  );
}

function onItemPointerDown(event: PointerEvent, item: WorkspaceQueueItem): void {
  lastPointerType = event.pointerType;
  if (event.pointerType === 'mouse' || !event.isPrimary || event.button !== 0 || props.loading)
    return;
  if (isInteractivePointerTarget(event) || props.editingQueueItemId === item.queueItemId) return;
  clearPress();
  pressItem = item;
  pressPointerId = event.pointerId;
  pressStartX = event.clientX;
  pressStartY = event.clientY;
  pressTimer = setTimeout(() => {
    pressTimer = undefined;
    const current = pressItem;
    const pointerId = pressPointerId;
    if (current === undefined || pointerId === undefined) return;
    suppressPostPressClick(pointerId);
    void openContextMenu(pressStartX, pressStartY, current);
  }, LONG_PRESS_MS);
}

function onItemPointerMove(event: PointerEvent): void {
  if (pressPointerId !== event.pointerId) return;
  if (Math.hypot(event.clientX - pressStartX, event.clientY - pressStartY) >= 8) clearPress();
}

function onItemPointerUp(event: PointerEvent): void {
  if (pressPointerId !== event.pointerId) return;
  clearPress();
}

function onItemContextMenu(event: MouseEvent, item: WorkspaceQueueItem): void {
  if (lastPointerType === 'mouse' || props.loading || isInteractivePointerTarget(event)) return;
  event.preventDefault();
  event.stopPropagation();
  const heldPointerId = pressPointerId;
  const openedByPress = pressTimer === undefined && pressItem?.queueItemId === item.queueItemId;
  clearPress();
  if (heldPointerId !== undefined) suppressPostPressClick(heldPointerId);
  if (openedByPress || contextMenu.value?.queueItemId === item.queueItemId) return;
  void openContextMenu(event.clientX, event.clientY, item);
}

function onNativeDragStart(event: DragEvent, queueItemId: string): void {
  if (lastPointerType === 'touch' || lastPointerType === 'pen') {
    event.preventDefault();
    return;
  }
  emit('dragStart', queueItemId);
}

async function openContextMenu(
  clientX: number,
  clientY: number,
  item: WorkspaceQueueItem
): Promise<void> {
  contextMenu.value = undefined;
  await nextTick();
  const width = globalThis.innerWidth ?? clientX + 180;
  const height = globalThis.innerHeight ?? clientY + 96;
  const menu = {
    queueItemId: item.queueItemId,
    x: Math.max(6, Math.min(clientX, width - 180)),
    y: Math.max(6, Math.min(clientY, height - 96))
  };
  contextMenu.value = menu;
  await nextTick();
  if (contextMenu.value?.queueItemId === menu.queueItemId) contextMenuTrigger.value?.click();
}

function contextCommand(command: string | number | object): void {
  const menu = contextMenu.value;
  contextMenu.value = undefined;
  if (menu === undefined || props.loading || (command !== 'up' && command !== 'down')) return;
  const index = props.items.findIndex((item) => item.queueItemId === menu.queueItemId);
  const target = props.items[index + (command === 'up' ? -1 : 1)];
  if (index < 0 || target === undefined) return;
  emit('dragStart', menu.queueItemId);
  emit('reorder', target.queueItemId);
}

watch(
  () => props.items.map((item) => item.queueItemId),
  (itemIds) => {
    if (contextMenu.value && !itemIds.includes(contextMenu.value.queueItemId)) closeContextMenu();
  }
);
watch(
  () => [props.loading, props.editingQueueItemId],
  () => {
    clearPress();
    closeContextMenu();
  }
);
onBeforeUnmount(() => {
  clearPress();
  closeContextMenu();
  releaseClickGuard();
});
watch(
  () => props.goal?.goal?.objective,
  (objective) => (goalObjective.value = objective ?? ''),
  { immediate: true }
);
watch(
  () => props.goal?.goal?.id,
  () => {
    goalEditing.value = false;
    goalDetailsOpen.value = false;
  }
);

function startGoalEdit(): void {
  goalObjective.value = props.goal?.goal?.objective ?? '';
  goalEditing.value = true;
}

function cancelGoalEdit(): void {
  goalObjective.value = props.goal?.goal?.objective ?? '';
  goalEditing.value = false;
}

function updateGoal(): void {
  const objective = goalObjective.value.trim();
  if (objective.length === 0) return;
  emit('saveGoal', objective);
  goalEditing.value = false;
}

function executeQueueItem(item: WorkspaceQueueItem): void {
  emit(
    'execute',
    item,
    props.editingQueueItemId === item.queueItemId ? props.editingContent : undefined
  );
}

function onQueueEditorKeydown(event: KeyboardEvent, item: WorkspaceQueueItem): void {
  if (event.isComposing || event.key !== 'Enter' || event.shiftKey || event.altKey) return;
  event.preventDefault();
  if (event.ctrlKey) executeQueueItem(item);
  else emit('save', item.queueItemId);
}
</script>

<template>
  <section
    v-if="items.length || goal?.goal"
    class="composer-queue"
    :aria-label="translate('generated.composerQueue.pendingWork')"
  >
    <div class="composer-queue-heading">
      <strong>{{ translate('generated.composerQueue.pendingWork') }}</strong>
      <span v-if="paused" class="composer-queue-paused">{{
        translate('generated.composerQueue.paused')
      }}</span>
    </div>
    <div class="composer-work-list">
      <div v-if="goal?.goal" class="work-item goal-card">
        <span class="work-item-kind goal-kind">{{
          translate('generated.composerQueue.goalType')
        }}</span>
        <div v-if="!goalEditing" class="goal-content-row">
          <el-tooltip
            :content="goal.goal.objective"
            placement="top-start"
            popper-class="goal-objective-tooltip"
            :show-after="350"
          >
            <p class="work-item-content goal-objective" tabindex="0">
              {{ goal.goal.objective }}
            </p>
          </el-tooltip>
          <div class="work-item-actions goal-actions">
            <button type="button" @click="goalDetailsOpen = true">
              {{ translate('goal.view') }}
            </button>
            <button type="button" @click="startGoalEdit">
              {{ translate('goal.edit') }}
            </button>
            <button
              class="work-item-danger-action"
              type="button"
              :disabled="loading"
              @click="emit('clearGoal')"
            >
              {{ translate('goal.clear') }}
            </button>
          </div>
        </div>
        <div v-if="goalEditing" class="goal-editor">
          <el-input
            v-model="goalObjective"
            class="goal-objective-input"
            type="textarea"
            :rows="3"
            resize="vertical"
            maxlength="20000"
            :aria-label="translate('goal.objectiveLabel')"
          />
          <div class="work-item-actions goal-editor-actions">
            <button type="button" :disabled="loading" @click="cancelGoalEdit">
              {{ translate('goal.cancel') }}
            </button>
            <button
              class="work-item-primary-action"
              type="button"
              :disabled="loading || !goalObjective.trim()"
              @click="updateGoal"
            >
              {{ translate('goal.update') }}
            </button>
          </div>
        </div>
        <el-dialog
          v-if="goalDetailsOpen"
          v-model="goalDetailsOpen"
          class="goal-details-dialog"
          :title="translate('goal.detailsTitle')"
          width="min(560px, calc(100vw - 32px))"
          append-to-body
        >
          <dl class="goal-details">
            <div>
              <dt>{{ translate('goal.objectiveLabel') }}</dt>
              <dd class="goal-details-objective">{{ goal.goal.objective }}</dd>
            </div>
            <div>
              <dt>{{ translate('goal.turnsLabel') }}</dt>
              <dd>{{ goal.goal.turns ?? 0 }}</dd>
            </div>
            <div>
              <dt>{{ translate('goal.revisionLabel') }}</dt>
              <dd>{{ goal.goal.revision }}</dd>
            </div>
          </dl>
        </el-dialog>
      </div>
      <ol v-if="items.length">
        <li
          v-for="(item, index) in items"
          :key="item.queueItemId"
          class="work-item queue-item"
          :class="{ editing: editingQueueItemId === item.queueItemId }"
          :data-queue-item-id="item.queueItemId"
          draggable="true"
          @pointerdown="onItemPointerDown($event, item)"
          @pointermove="onItemPointerMove"
          @pointerup="onItemPointerUp"
          @pointercancel="onItemPointerUp"
          @contextmenu="onItemContextMenu($event, item)"
          @dragstart="onNativeDragStart($event, item.queueItemId)"
          @dragover.prevent
          @drop.prevent="emit('reorder', item.queueItemId)"
        >
          <span class="queue-drag" aria-hidden="true">⠿</span>
          <span class="work-item-kind">{{
            composerMessagePresentation({ text: item.content }).restarted
              ? translate('presentation.systemRestart')
              : translate('generated.composerQueue.queueType', { position: index + 1 })
          }}</span>
          <div class="queue-item-content">
            <small v-if="messageSource(item)" :title="messageSource(item)?.title">{{
              messageSource(item)?.label
            }}</small>
            <el-input
              v-if="editingQueueItemId === item.queueItemId"
              :model-value="editingContent"
              type="textarea"
              :autosize="{ minRows: 1, maxRows: 4 }"
              class="composer-queue-input"
              @update:model-value="emit('updateContent', $event)"
              @keydown="onQueueEditorKeydown($event, item)"
            />
            <template v-else>
              <p
                v-if="conversationItemText('user_message', { text: item.content })"
                class="work-item-content"
                :title="conversationItemText('user_message', { text: item.content })"
              >
                {{ conversationItemText('user_message', { text: item.content }) }}
              </p>
            </template>
          </div>
          <div class="work-item-actions queue-item-actions">
            <button
              v-if="editingQueueItemId === item.queueItemId"
              type="button"
              :aria-label="translate('generated.composerQueue.save')"
              :title="translate('generated.composerQueue.save')"
              @click="emit('save', item.queueItemId)"
            >
              <span class="work-item-action-label">{{
                translate('generated.composerQueue.save')
              }}</span>
            </button>
            <button
              v-else
              type="button"
              :aria-label="translate('generated.composerQueue.edit')"
              :title="translate('generated.composerQueue.edit')"
              @click="emit('edit', item)"
            >
              <span class="work-item-action-label">{{
                translate('generated.composerQueue.edit')
              }}</span>
            </button>
            <button
              class="work-item-primary-action"
              type="button"
              :disabled="loading"
              :aria-label="translate('generated.composerQueue.runNow')"
              :title="translate('generated.composerQueue.runNow')"
              @click="executeQueueItem(item)"
            >
              <span class="work-item-action-label">{{
                translate('generated.composerQueue.runNow')
              }}</span>
            </button>
            <button
              class="work-item-danger-action"
              type="button"
              :aria-label="translate('generated.composerQueue.delete')"
              :title="translate('generated.composerQueue.delete')"
              @click="emit('deleteItem', item.queueItemId)"
            >
              <span class="work-item-action-label">{{
                translate('generated.composerQueue.delete')
              }}</span>
            </button>
          </div>
        </li>
      </ol>
    </div>
    <div
      v-if="contextMenu !== undefined"
      class="queue-context-anchor"
      :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
    >
      <el-dropdown
        trigger="click"
        placement="bottom-start"
        @command="contextCommand"
        @visible-change="!$event && (contextMenu = undefined)"
      >
        <button
          ref="contextMenuTrigger"
          class="queue-context-trigger"
          type="button"
          tabindex="-1"
        />
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="up" :disabled="contextMenuIndex <= 0">
              <el-icon><ArrowUp /></el-icon>{{ translate('generated.composerQueue.moveUp') }}
            </el-dropdown-item>
            <el-dropdown-item
              command="down"
              :disabled="contextMenuIndex < 0 || contextMenuIndex >= items.length - 1"
            >
              <el-icon><ArrowDown /></el-icon>{{ translate('generated.composerQueue.moveDown') }}
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>
  </section>
</template>
<style scoped>
.composer-queue {
  display: flex;
  flex-direction: column;
  max-height: 220px;
  overflow: hidden;
  border-bottom: 1px solid var(--mar-border-subtle);
  background: var(--mar-bg-panel);
  padding: 8px 10px 4px;
}

.composer-queue ~ :deep(.el-input .el-textarea__inner) {
  border-radius: 0;
}

.composer-queue-heading {
  display: flex;
  align-items: center;
  min-height: 28px;
  gap: 8px;
  padding: 0 4px 6px;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
}

.composer-queue-heading strong {
  color: var(--mar-text-primary);
  font-size: var(--mar-font-size-body);
}

.composer-queue-paused {
  margin-left: auto;
  color: var(--mar-color-warning-text);
}

.composer-work-list {
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
}

.work-item-actions button {
  border: 0;
  background: transparent;
  color: var(--mar-text-secondary);
  cursor: pointer;
  font-size: var(--mar-font-size-meta);
  line-height: 1.2;
  padding: 4px 5px;
  white-space: nowrap;
}

.work-item-actions .work-item-primary-action {
  color: var(--mar-text-secondary);
}

.goal-card {
  grid-template-columns: max-content minmax(0, 1fr) max-content;
}

.goal-actions,
.goal-editor-actions {
  display: flex;
  align-items: center;
}

.goal-content-row {
  display: contents;
}

.goal-editor {
  display: grid;
  grid-column: 2 / -1;
  grid-template-columns: minmax(0, 1fr) max-content;
  align-items: center;
  gap: 0.4rem;
  min-width: 0;
}

.goal-objective {
  grid-column: 2;
}

.goal-actions {
  grid-column: 3;
  justify-content: flex-end;
  gap: 2px;
  min-width: 0;
}

.goal-card .goal-actions button,
.goal-editor-actions button {
  flex: 0 0 auto;
}

.composer-queue .goal-objective {
  box-sizing: border-box;
  display: block;
  min-width: 0;
  overflow: hidden;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.composer-queue .goal-objective:focus-visible {
  outline: 2px solid var(--mar-color-brand);
  outline-offset: 1px;
}

:global(.goal-objective-tooltip) {
  max-width: min(560px, calc(100vw - 24px));
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.goal-editor {
  align-items: end;
}

.goal-objective-input {
  min-width: 0;
}

.goal-objective-input :deep(.el-textarea__inner) {
  border: 1px solid var(--mar-border-medium);
  border-radius: 6px;
  background: var(--mar-bg-panel);
  box-shadow: none;
  color: var(--mar-text-primary);
  font-size: var(--mar-font-size-input);
  padding: 0.42rem 0.5rem;
  line-height: 1.55;
}

.goal-objective-input :deep(.el-textarea__inner:focus) {
  border-color: var(--mar-color-brand);
  box-shadow: 0 0 0 1px var(--mar-color-brand);
}

.goal-editor-actions {
  justify-content: flex-end;
  gap: 0.32rem;
  flex-wrap: nowrap;
}

:global(.goal-details-dialog .el-dialog__body) {
  padding-top: 0.35rem;
}

.goal-details {
  display: grid;
  gap: 0;
  margin: 0;
  border: 1px solid var(--mar-border-subtle);
  border-radius: 6px;
  overflow: hidden;
}

.goal-details > div {
  display: grid;
  grid-template-columns: minmax(110px, 0.28fr) minmax(0, 1fr);
  border-top: 1px solid var(--mar-border-subtle);
}

.goal-details > div:first-child {
  border-top: 0;
}

.goal-details dt,
.goal-details dd {
  margin: 0;
  padding: 0.58rem 0.68rem;
}

.goal-details dt {
  background: var(--mar-fill-subtle);
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
}

.goal-details dd {
  color: var(--mar-text-primary);
  font-variant-numeric: tabular-nums;
}

.goal-details-objective {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.work-item-actions button:not(:disabled):hover,
.work-item-actions button:not(:disabled):focus-visible {
  background: transparent;
  color: var(--mar-color-brand-text);
}

.work-item-actions button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.composer-queue ol {
  display: grid;
  grid-auto-rows: max-content;
  gap: 0;
  min-height: 0;
  margin: 0;
  padding: 0;
  border-top: 1px solid var(--mar-border-subtle);
  list-style: none;
}

.work-item {
  box-sizing: border-box;
  min-height: 32px;
  min-width: 0;
  border-top: 1px solid var(--mar-border-subtle);
  background: transparent;
  padding: 1px 6px;
}

.goal-card {
  display: grid;
  align-items: center;
  gap: 8px;
}

.composer-queue ol .work-item:first-child {
  border-top: 0;
}

.queue-item {
  display: grid;
  grid-template-columns: 16px max-content minmax(0, 1fr) max-content;
  align-items: center;
  gap: 8px;
  -webkit-touch-callout: none;
  -webkit-user-select: none;
  user-select: none;
}

.queue-item .work-item-kind {
  max-width: 9rem;
  white-space: normal;
}

.work-item:hover,
.work-item:focus-within {
  background: var(--mar-fill-subtle);
}

.work-item-kind {
  min-width: 0;
  color: var(--mar-text-tertiary);
  font-size: var(--mar-font-size-meta);
  line-height: 1.2;
  white-space: nowrap;
}

.goal-kind {
  align-self: center;
}

.work-item-content {
  color: var(--mar-text-primary);
  font-size: var(--mar-font-size-meta);
  line-height: 1.2;
}

.composer-queue li.editing {
  align-items: center;
  background: var(--mar-fill-subtle);
}

.queue-item-content {
  min-width: 0;
  overflow: hidden;
}

.composer-queue-input :deep(.el-textarea__inner) {
  min-height: 28px !important;
  resize: none;
  color: var(--mar-text-primary);
  background: var(--mar-bg-panel);
  font-size: var(--mar-font-size-input);
  padding: 4px 6px;
  line-height: 1.55;
}

.composer-queue small {
  color: var(--mar-text-tertiary);
}

.composer-queue p {
  min-width: 0;
  overflow: hidden;
  margin: 0;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.queue-item.editing {
  -webkit-user-select: text;
  user-select: text;
}

.queue-drag {
  cursor: grab;
  color: var(--mar-text-faint);
  font-size: 14px;
  line-height: 1;
  user-select: none;
}

.queue-context-anchor {
  position: fixed;
  z-index: 5000;
  width: 1px;
  height: 1px;
}

.queue-context-trigger {
  width: 1px;
  height: 1px;
  padding: 0;
  border: 0;
  background: transparent;
}

.queue-item-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}
</style>

<style scoped>
@media (max-width: 767px) {
  .composer-queue {
    max-height: 180px;
  }

  .goal-objective-input :deep(.el-textarea__inner),
  .composer-queue-input :deep(.el-textarea__inner) {
    font-size: var(--mar-font-size-meta);
  }

  .composer-queue-input :deep(.el-textarea__inner) {
    padding-block: 2px;
  }

  .work-item {
    padding-block: 0;
  }

  .goal-card,
  .queue-item {
    gap: 4px 8px;
  }

  .goal-card {
    grid-template-columns: max-content minmax(0, 1fr) max-content;
    gap: 0 6px;
  }

  .goal-actions {
    gap: 0;
  }

  .goal-actions button {
    min-width: 0;
    padding: 0 3px;
  }

  .goal-editor {
    grid-column: 1 / -1;
    grid-template-columns: minmax(0, 1fr);
    gap: 4px;
  }

  .queue-drag {
    display: none;
  }

  .queue-item {
    grid-template-columns: max-content minmax(0, 1fr) max-content;
    gap: 0 6px;
  }

  .queue-item-content {
    grid-column: 2;
  }

  .queue-item-actions {
    grid-column: 3;
  }

  .work-item-actions {
    justify-content: flex-end;
    flex-wrap: nowrap;
  }

  .queue-item-actions {
    gap: 0;
  }

  .queue-item-actions button {
    box-sizing: border-box;
    min-width: 0;
    padding: 0 3px;
  }

  .queue-item-actions .work-item-action-label {
    display: inline;
  }

  .goal-details > div {
    grid-template-columns: 96px minmax(0, 1fr);
  }
}
</style>

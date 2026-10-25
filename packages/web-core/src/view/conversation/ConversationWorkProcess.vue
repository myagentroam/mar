<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import BusyIndicator from '../common/BusyIndicator.vue';
import MarIcon from '../common/MarIcon.vue';
import { translate } from '../../service/locale-preference-service.js';
import {
  conversationProcessLabel,
  conversationProcessDuration,
  type ConversationProcessBlock
} from '../../util/conversation-work-process.js';
import { preciseElapsedDurationLabel } from '../../util/time-presentation.js';

const props = defineProps<{
  block: ConversationProcessBlock;
  synchronized: boolean;
  now: number | undefined;
}>();
const root = ref<HTMLElement>();
const manualOpen = ref<boolean>();
const defaultOpen = ref(props.synchronized && props.block.active);
const open = computed(() => !props.block.groupId || (manualOpen.value ?? defaultOpen.value));
// The scheduler reads the actual disclosure state, including manual and focus overrides.
defineExpose({ isOpen: () => open.value });
const statusLabel = computed(() => conversationProcessLabel(props.block, props.synchronized));
const durationMs = computed(() =>
  conversationProcessDuration(props.block, props.now, props.synchronized)
);
function updateDefault() {
  if (
    !props.synchronized ||
    (typeof document !== 'undefined' &&
      root.value?.querySelector('.process-content')?.contains(document.activeElement))
  )
    return;
  defaultOpen.value = props.block.active;
}
watch([() => props.block.active, () => props.synchronized], updateDefault);
watch(open, async () => {
  const element = root.value;
  const scroll = element?.closest<HTMLElement>('.conversation-scroll');
  if (!element || !scroll) return;
  const following = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 28;
  const above = element.getBoundingClientRect().bottom <= scroll.getBoundingClientRect().top;
  const height = scroll.scrollHeight;
  const top = scroll.scrollTop;
  await nextTick();
  if (!element.isConnected) return;
  if (following) scroll.scrollTop = scroll.scrollHeight;
  else if (above) scroll.scrollTop = top + scroll.scrollHeight - height;
});
</script>

<template>
  <section
    ref="root"
    class="conversation-process"
    :class="{ 'is-group': block.groupId }"
    :data-process-id="block.groupId"
    @focusout="nextTick(updateDefault)"
  >
    <p v-if="block.groupId && block.active && block.preview" class="process-summary">
      {{ block.preview.text }}
    </p>
    <button
      v-if="block.groupId"
      type="button"
      class="process-heading"
      :aria-expanded="open"
      @click="manualOpen = !open"
    >
      <MarIcon name="chevron-right" class="process-chevron" :class="{ 'is-open': open }" />
      <span
        class="process-meta process-activity"
        :class="{ 'is-active': block.active && synchronized }"
      >
        <BusyIndicator v-if="block.active && synchronized" class="process-activity-indicator" />
        <span class="process-activity-label">{{ statusLabel }}</span>
      </span>
      <span v-if="durationMs !== undefined" class="process-duration"
        >·
        {{
          translate('conversationActivity.step', {
            value: preciseElapsedDurationLabel(durationMs)
          })
        }}</span
      >
      <span v-if="block.partial" class="process-meta">{{
        translate('conversationProcess.partial')
      }}</span>
    </button>
    <div
      class="process-body"
      :class="{ 'is-collapsed': !open }"
      :aria-hidden="!open"
      :inert="!open"
    >
      <Transition name="process-content">
        <div v-if="open" class="process-content"><slot /></div>
      </Transition>
    </div>
  </section>
</template>

<style scoped>
.conversation-process,
.process-content {
  min-width: 0;
}
.process-heading {
  display: flex;
  align-items: center;
  flex-wrap: nowrap;
  gap: var(--conversation-record-gap, 8px);
  width: 100%;
  padding: 4px var(--conversation-item-inset, 12px);
  border: 0;
  background: transparent;
  color: var(--mar-conversation-text);
  font: inherit;
  font-size: var(--mar-font-size-body);
  line-height: 20px;
  text-align: start;
  cursor: pointer;
  border-radius: var(--mar-radius-control);
}
@media (hover: hover) and (pointer: fine) {
  .process-heading:hover {
    background-color: var(--mar-fill-row-hover);
  }
}
.process-heading:active {
  background-color: var(--mar-fill-row-hover);
}
.process-heading:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
}
.process-chevron {
  width: 1em;
  height: 1em;
  flex: none;
  transition: transform var(--el-transition-duration-fast);
}
.process-chevron.is-open {
  transform: rotate(90deg);
}
.process-meta {
  color: var(--mar-conversation-muted);
  font-size: var(--mar-font-size-meta);
}
.process-duration {
  flex: none;
  color: var(--mar-conversation-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.process-summary {
  margin: 0;
  color: var(--mar-conversation-text);
  font-size: var(--mar-font-size-body);
  line-height: 1.5;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.process-activity {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: 0.34rem;
  font-size: var(--mar-font-size-body);
  font-weight: 500;
}
.process-activity.is-active {
  color: var(--mar-conversation-text);
  font-weight: 600;
}
.process-activity-indicator {
  width: 10px;
  height: 10px;
  border-width: 1.5px;
  color: var(--mar-color-brand-text);
}
.process-activity-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.process-body {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows var(--el-transition-duration-fast);
}
.process-body.is-collapsed {
  grid-template-rows: 0fr;
}
.process-content {
  display: grid;
  gap: var(--conversation-record-gap, 8px);
  min-height: 0;
}
.process-content-enter-active,
.process-content-leave-active {
  transition: opacity var(--el-transition-duration-fast);
}
.process-content-enter-from,
.process-content-leave-to {
  opacity: 0;
}
.is-group .process-content {
  overflow: hidden;
  padding-inline-start: 8px;
}
@media (max-width: 767px) {
  .is-group .process-content {
    padding-inline-start: 4px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .process-body,
  .process-chevron,
  .process-content-enter-active,
  .process-content-leave-active {
    transition: none;
  }
}
</style>

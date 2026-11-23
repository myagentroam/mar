<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import MarBusyIndicator from '@myagentroam/mar-ui/busy-indicator';
import { MarIcon } from '@myagentroam/mar-ui/icons';
import ConversationProcessDuration from './ConversationProcessDuration.vue';
import SessionPerformanceInfo from './SessionPerformanceInfo.vue';
import { translate } from '../../service/locale-preference-service.js';
import {
  conversationProcessLabel,
  type ConversationProcessBlock
} from '../../util/conversation-work-process.js';
import type { RunPerformance } from '@myagentroam/protocol';
import { sessionPerformanceDetails } from '../../util/session-performance-presentation.js';

const props = defineProps<{
  block: ConversationProcessBlock;
  synchronized: boolean;
  performance?: RunPerformance | undefined;
}>();
const root = ref<HTMLElement>();
const manualOpen = ref<boolean>();
// Restore cached disclosure without treating cached activity as confirmed live progress.
const defaultOpen = ref(props.block.active);
const open = computed(() => !props.block.groupId || (manualOpen.value ?? defaultOpen.value));
// The scheduler reads the actual disclosure state, including manual and focus overrides.
defineExpose({ isOpen: () => open.value });
const statusLabel = computed(() => conversationProcessLabel(props.block, props.synchronized));
const observedPerformance = computed(() =>
  props.synchronized && props.block.runId === props.performance?.runId
    ? props.performance
    : undefined
);
const performanceDetails = computed(() =>
  sessionPerformanceDetails(observedPerformance.value, true)
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
    <p
      v-if="block.groupId && block.active && synchronized && block.preview"
      class="process-summary"
    >
      {{ block.preview.text }}
    </p>
    <div v-if="block.groupId" class="process-heading-row">
      <button
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
          <MarBusyIndicator
            v-if="block.active && synchronized"
            class="process-activity-indicator"
          />
          <span class="process-activity-label">{{ statusLabel }}</span>
        </span>
        <ConversationProcessDuration :block="block" :synchronized="synchronized" />
        <span v-if="block.partial" class="process-meta">{{
          translate('conversationProcess.partial')
        }}</span>
      </button>
      <div v-if="observedPerformance" class="process-metrics">
        <span v-if="performanceDetails" class="process-performance"
          >· {{ performanceDetails }}</span
        >
        <SessionPerformanceInfo :performance="observedPerformance" />
      </div>
    </div>
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
.process-heading-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  column-gap: var(--conversation-record-gap, 8px);
  padding-inline: var(--conversation-item-inset, 12px);
  border-radius: var(--mar-radius-control);
}
.process-heading {
  display: flex;
  align-items: center;
  flex-wrap: nowrap;
  gap: var(--conversation-record-gap, 8px);
  max-width: 100%;
  min-width: 0;
  padding: 4px 0;
  border: 0;
  background: transparent;
  color: var(--mar-text-primary);
  font: inherit;
  font-size: var(--mar-font-size-body);
  line-height: 20px;
  text-align: start;
  cursor: pointer;
  border-radius: var(--mar-radius-control);
}
@media (hover: hover) and (pointer: fine) {
  .process-heading-row:hover {
    background-color: var(--mar-fill-row-hover);
  }
}
.process-heading-row:active {
  background-color: var(--mar-fill-row-hover);
}
.process-chevron {
  /* This row disclosure matches the nested summary arrows, not standalone mobile actions. */
  font-size: inherit;
  width: 1em;
  height: 1em;
  flex: none;
  transition: transform var(--mar-motion-duration-fast);
}
.process-chevron.is-open {
  transform: rotate(90deg);
}
.process-meta {
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
}
.process-metrics {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  max-width: 100%;
  font-size: var(--mar-font-size-body);
  line-height: 20px;
}
.process-performance {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 100%;
  color: var(--mar-text-secondary);
  font-variant-numeric: tabular-nums;
  text-box: trim-both cap alphabetic;
  overflow-wrap: anywhere;
}
.process-summary {
  margin: 0;
  color: var(--mar-text-secondary);
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
  color: var(--mar-text-primary);
  font-weight: 600;
}
.process-activity-indicator {
  width: 10px;
  height: 10px;
  border-width: 1.5px;
  color: var(--mar-conversation-activity-fg);
}
.process-activity-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.process-body {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows var(--mar-motion-duration-fast);
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
  transition: opacity var(--mar-motion-duration-fast);
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

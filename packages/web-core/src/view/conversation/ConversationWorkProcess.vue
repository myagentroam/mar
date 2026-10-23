<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { translate } from '../../service/LocalePreferenceService.js';
import {
  conversationProcessLabel,
  type ConversationProcessBlock
} from '../../util/conversation-work-process.js';
import { preciseElapsedDurationLabel } from '../../util/time-presentation.js';

const props = defineProps<{ block: ConversationProcessBlock; synchronized: boolean }>();
const root = ref<HTMLElement>();
const manualOpen = ref<boolean>();
const defaultOpen = ref(props.synchronized && props.block.active);
const open = computed(() => !props.block.groupId || (manualOpen.value ?? defaultOpen.value));
const statusLabel = computed(() => conversationProcessLabel(props.block, props.synchronized));
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
    <p v-if="block.groupId && block.summary" class="process-summary">{{ block.summary.text }}</p>
    <button
      v-if="block.groupId"
      type="button"
      class="process-heading"
      :aria-expanded="open"
      @click="manualOpen = !open"
    >
      <span class="process-chevron" :class="{ 'is-open': open }" aria-hidden="true" />
      <span
        class="process-meta process-activity"
        :class="{ 'is-active': block.active && synchronized }"
      >
        <i
          v-if="block.active && synchronized"
          class="process-activity-indicator"
          aria-hidden="true"
        />
        <span class="process-activity-label" :title="statusLabel">{{ statusLabel }}</span>
      </span>
      <span v-if="block.durationMs !== undefined" class="process-duration"
        >·
        {{
          translate('conversationActivity.step', {
            value: preciseElapsedDurationLabel(block.durationMs)
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
      <div class="process-content"><slot /></div>
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
  padding: 0.5rem 0;
  border: 0;
  background: transparent;
  color: var(--mar-conversation-text);
  font: inherit;
  font-size: var(--mar-font-size-body);
  line-height: 20px;
  text-align: start;
  cursor: pointer;
}
.process-heading:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
}
.process-chevron {
  width: 1em;
  height: 1em;
  flex: none;
  background: currentColor;
  mask: var(--conversation-chevron) center / contain no-repeat;
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
  overflow-wrap: anywhere;
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
  color: var(--mar-color-brand-text);
}
.process-activity-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.process-activity-indicator {
  box-sizing: border-box;
  width: 0.75rem;
  height: 0.75rem;
  flex: none;
  border: 2px solid currentColor;
  border-inline-end-color: transparent;
  border-radius: 50%;
}
@media (prefers-reduced-motion: no-preference) {
  .process-activity-indicator {
    animation: process-activity-spin 1.2s linear infinite;
  }
}
@keyframes process-activity-spin {
  to {
    transform: rotate(360deg);
  }
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
.is-group .process-content {
  overflow: hidden;
  padding-inline-start: 1.25rem;
}
@media (max-width: 767px) {
  .is-group .process-content {
    padding-inline-start: 0.5rem;
  }
}
@media (prefers-reduced-motion: reduce) {
  .process-body,
  .process-chevron {
    transition: none;
  }
}
</style>

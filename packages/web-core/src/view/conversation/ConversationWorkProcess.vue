<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { ArrowRight } from '@element-plus/icons-vue';
import { translate } from '../../service/LocalePreferenceService.js';
import type { ConversationProcessBlock } from '../../util/conversation-work-process.js';

const props = defineProps<{ block: ConversationProcessBlock; synchronized: boolean }>();
const root = ref<HTMLElement>();
const manualOpen = ref<boolean>();
const defaultOpen = ref(props.synchronized && props.block.active);
const open = computed(() => !props.block.groupId || (manualOpen.value ?? defaultOpen.value));
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
    <button
      v-if="block.groupId"
      type="button"
      class="process-heading"
      :aria-expanded="open"
      @click="manualOpen = !open"
    >
      <ArrowRight class="process-chevron" :class="{ 'is-open': open }" aria-hidden="true" />
      <span>{{ translate('conversationProcess.title') }}</span>
      <span class="process-meta">{{
        translate('conversationProcess.records', { count: block.entries.length })
      }}</span>
      <span v-if="block.partial" class="process-meta">{{
        translate('conversationProcess.partial')
      }}</span>
      <span v-if="block.active && synchronized" class="process-meta">{{
        translate('conversationActivity.running')
      }}</span>
      <span v-if="block.warning" class="process-warning">{{
        translate('conversationProcess.warning')
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
  flex-wrap: wrap;
  gap: 0.5rem;
  width: 100%;
  padding: 0.5rem 0;
  border: 0;
  background: transparent;
  color: var(--mar-conversation-text);
  font: inherit;
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
  transition: transform var(--el-transition-duration-fast);
}
.process-chevron.is-open {
  transform: rotate(90deg);
}
.process-meta {
  color: var(--mar-conversation-muted);
  font-size: var(--mar-font-size-meta);
}
.process-warning {
  color: var(--el-color-warning);
  font-size: var(--mar-font-size-meta);
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
  gap: 0.5rem;
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

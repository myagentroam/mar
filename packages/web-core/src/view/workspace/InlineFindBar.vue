<script setup lang="ts">
import { marIcon } from '../../util/mar-icons.js';
import MarIcon from '../common/MarIcon.vue';
import { nextTick, onMounted, ref } from 'vue';
import { translate } from '../../service/LocalePreferenceService.js';

defineProps<{
  readonly modelValue: string;
  readonly current: number;
  readonly total: number;
  readonly truncated: boolean;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: string];
  previous: [];
  next: [];
  close: [];
}>();
const input = ref<{ focus?: () => void; select?: () => void }>();

async function focus(): Promise<void> {
  await nextTick();
  input.value?.focus?.();
  input.value?.select?.();
}

function onEnter(event: KeyboardEvent): void {
  if (event.shiftKey) emit('previous');
  else emit('next');
}

defineExpose({ focus });
onMounted(focus);
</script>

<template>
  <div class="inline-find-row">
    <div class="inline-find-bar" role="search" :aria-label="translate('inlineFind.label')">
      <el-input
        ref="input"
        :model-value="modelValue"
        :placeholder="translate('inlineFind.placeholder')"
        clearable
        @update:model-value="emit('update:modelValue', $event)"
        @keydown.enter.stop.prevent="onEnter"
        @keydown.esc.stop.prevent="emit('close')"
        :clear-icon="marIcon('clear-input')"
      >
        <template #prefix><MarIcon name="search" /></template>
      </el-input>
      <span class="inline-find-count" aria-live="polite"
        >{{ current }} / {{ total }}{{ truncated ? '+' : '' }}</span
      >
      <el-button
        v-tooltip="translate('inlineFind.previous')"
        text
        :disabled="total === 0"
        :aria-label="translate('inlineFind.previous')"
        @click="emit('previous')"
        ><MarIcon name="chevron-up"
      /></el-button>
      <el-button
        v-tooltip="translate('inlineFind.next')"
        text
        :disabled="total === 0"
        :aria-label="translate('inlineFind.next')"
        @click="emit('next')"
        ><MarIcon name="chevron-down"
      /></el-button>
      <el-button
        v-tooltip="translate('inlineFind.close')"
        text
        :aria-label="translate('inlineFind.close')"
        @click="emit('close')"
        ><MarIcon name="close"
      /></el-button>
    </div>
  </div>
</template>

<style scoped>
.inline-find-row {
  display: flex;
  justify-content: flex-end;
  border-bottom: 1px solid var(--mar-border-default);
  background: var(--mar-bg-panel);
  padding: 0.3rem 0.75rem;
}
.inline-find-bar {
  display: flex;
  width: min(25rem, 100%);
  align-items: center;
  gap: 0.15rem;
}
.inline-find-bar :deep(.el-input) {
  flex: 1;
}
.inline-find-bar :deep(.el-button) {
  flex: none;
  margin-left: 0;
}
.inline-find-count {
  min-width: 3.4rem;
  color: var(--mar-text-tertiary);
  font-size: var(--mar-font-size-meta);
  text-align: center;
  white-space: nowrap;
}
</style>

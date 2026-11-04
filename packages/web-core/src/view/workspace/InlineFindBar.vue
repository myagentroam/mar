<script setup lang="ts">
import { marIcon } from '../../util/mar-icons.js';
import MarIcon from '../common/MarIcon.vue';
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { translate } from '../../service/locale-preference-service.js';
import { consoleKeyboardShortcutService } from '../../service/console-keyboard-shortcut-service.js';
import { fileKeys, findNavigationKeys } from '../../service/console-shortcut-keys.js';

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
const root = ref<HTMLElement>();
let unregister: (() => void)[] = [];

async function focus(): Promise<void> {
  await nextTick();
  input.value?.focus?.();
  input.value?.select?.();
}

defineExpose({ focus });
onMounted(() => {
  const owner = () => root.value?.querySelector('input') ?? undefined;
  unregister = [
    consoleKeyboardShortcutService.register({
      command: 'filePreview.findNext',
      scope: 'file-preview',
      priority: 130,
      owner,
      keys: findNavigationKeys,
      when: () => true,
      execute: (event) => {
        if (event.shiftKey) emit('previous');
        else emit('next');
        return 'HANDLED';
      }
    }),
    consoleKeyboardShortcutService.register({
      command: 'filePreview.dismissFind',
      scope: 'file-preview',
      priority: 130,
      owner,
      keys: fileKeys.dismiss,
      when: () => true,
      execute: () => {
        emit('close');
        return 'HANDLED';
      }
    })
  ];
  void focus();
});
onBeforeUnmount(() => {
  unregister.forEach((release) => release());
  unregister = [];
});
</script>

<template>
  <div ref="root" class="inline-find-row">
    <div class="inline-find-bar" role="search" :aria-label="translate('inlineFind.label')">
      <el-input
        ref="input"
        :model-value="modelValue"
        :placeholder="translate('inlineFind.placeholder')"
        clearable
        @update:model-value="emit('update:modelValue', $event)"
        :clear-icon="marIcon('clear-input')"
      >
        <template #prefix><MarIcon name="search" /></template>
      </el-input>
      <span class="inline-find-count" aria-live="polite"
        >{{ current }} / {{ total }}{{ truncated ? '+' : '' }}</span
      >
      <el-button
        class="utility-control"
        v-tooltip="translate('inlineFind.previous')"
        text
        :disabled="total === 0"
        :aria-label="translate('inlineFind.previous')"
        @click="emit('previous')"
        ><MarIcon name="chevron-up"
      /></el-button>
      <el-button
        class="utility-control"
        v-tooltip="translate('inlineFind.next')"
        text
        :disabled="total === 0"
        :aria-label="translate('inlineFind.next')"
        @click="emit('next')"
        ><MarIcon name="chevron-down"
      /></el-button>
      <el-button
        class="utility-control"
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

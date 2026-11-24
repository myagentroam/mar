<script setup lang="ts">
import { useTemplateRef } from 'vue';
import { MarInput } from '@myagentroam/mar-ui/input';
import { MarButton } from '@myagentroam/mar-ui/button';
import type { BrowserFindResult } from '@myagentroam/protocol';
import { translate as t } from '../../service/locale-preference-service.js';

defineProps<{
  query: string;
  result: BrowserFindResult | undefined;
  failed: boolean;
  pending: boolean;
}>();
const emit = defineEmits<{
  edit: [value: string];
  step: [direction: 'previous' | 'next'];
  close: [];
}>();
const input = useTemplateRef<InstanceType<typeof MarInput>>('input');
defineExpose({
  focus() {
    input.value?.focus({ preventScroll: true });
    input.value?.select();
  }
});

function onKey(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  emit('step', event.shiftKey ? 'previous' : 'next');
}
</script>

<template>
  <div class="browser-find-bar" role="search" :aria-label="t('browser.find')">
    <MarInput
      ref="input"
      class="browser-find-field"
      :model-value="query"
      :maxlength="256"
      :aria-label="t('browser.find')"
      :placeholder="t('browser.find')"
      autocomplete="off"
      spellcheck="false"
      @update:model-value="emit('edit', $event)"
      @keydown="onKey"
    />
    <span class="browser-find-count" role="status" :aria-busy="pending">
      <template v-if="failed">{{ t('browser.findUnavailable') }}</template>
      <template v-else-if="result && (result.total || !result.limited)">
        {{
          t(result.limited ? 'browser.findPartial' : 'browser.findCount', {
            index: result.index,
            total: result.total
          })
        }}
      </template>
      <template v-else-if="result?.limited">{{ t('browser.findPartialEmpty') }}</template>
    </span>
    <div class="browser-find-actions">
      <MarButton
        icon="chevron-up"
        :aria-label="t('browser.findPrevious')"
        v-tooltip="t('browser.findPrevious')"
        :disabled="!result?.total"
        :aria-disabled="pending || undefined"
        @click="emit('step', 'previous')"
      />
      <MarButton
        icon="chevron-down"
        :aria-label="t('browser.findNext')"
        v-tooltip="t('browser.findNext')"
        :disabled="!result?.total"
        :aria-disabled="pending || undefined"
        @click="emit('step', 'next')"
      />
      <MarButton
        icon="close"
        :aria-label="t('browser.findClose')"
        v-tooltip="t('browser.findClose')"
        @click="emit('close')"
      />
    </div>
  </div>
</template>

<style scoped>
.browser-find-bar {
  position: absolute;
  inset-block-start: 0;
  inset-inline-end: 0.5rem;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 0.375rem;
  inline-size: min(23rem, calc(100% - 1rem));
  box-sizing: border-box;
  padding: 0.375rem;
  color: var(--mar-ui-text-primary);
  background: var(--mar-ui-overlay-surface);
  border: 1px solid var(--mar-ui-overlay-border);
  border-radius: 0 0 var(--mar-ui-radius-surface) var(--mar-ui-radius-surface);
  box-shadow: var(--mar-ui-overlay-shadow);
}
.browser-find-field {
  flex: 1;
  min-inline-size: 0;
}
.browser-find-count {
  flex: 0 0 auto;
  max-inline-size: 8em;
  color: var(--mar-ui-text-secondary);
  font-size: var(--mar-ui-font-size-meta);
  font-variant-numeric: tabular-nums;
}
.browser-find-actions {
  display: flex;
  align-items: center;
  border-inline-start: 1px solid var(--mar-ui-overlay-border);
  padding-inline-start: 0.25rem;
}
.browser-find-actions > :deep(button) {
  border-color: transparent;
}
</style>

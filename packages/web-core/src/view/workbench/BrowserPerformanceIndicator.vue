<script setup lang="ts">
import { ref, useId, watch } from 'vue';
import { MarButton } from '@myagentroam/mar-ui/button';
import { MarPopover } from '@myagentroam/mar-ui/popover';
import type { BrowserStreamSample } from '../../service/browser-attachment-client.js';
import { useI18n } from 'vue-i18n';

// Owns only the local popover and formatting; attachment measurements are read-only.
const props = defineProps<{
  connection: string;
  frame?: { width: number; height: number } | undefined;
  sample?: BrowserStreamSample | undefined;
  disabled?: boolean;
}>();
const { t, n } = useI18n();
const open = ref(false);
const panelId = useId();
const rateFormat = { maximumFractionDigits: 1 } as const;
watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) open.value = false;
  }
);

function bitrate(bits: number): string {
  if (bits >= 1_000_000) return `${n(bits / 1_000_000, rateFormat)} Mbit/s`;
  if (bits >= 1_000) return `${n(bits / 1_000, rateFormat)} kbit/s`;
  return `${n(bits, rateFormat)} bit/s`;
}
</script>

<template>
  <MarPopover
    v-model:visible="open"
    trigger="click"
    placement="top"
    :width="272"
    :show-arrow="false"
  >
    <template #reference>
      <MarButton
        circle
        icon="info"
        v-tooltip="t('browser.performance.title')"
        :aria-label="t('browser.performance.title')"
        :aria-expanded="open"
        :aria-controls="open ? panelId : undefined"
        @click="open = !open"
      />
    </template>
    <section :id="panelId" class="browser-performance" :aria-label="t('browser.performance.title')">
      <strong>{{ t('browser.performance.title') }}</strong>
      <dl>
        <dt>{{ t('browser.performance.connection') }}</dt>
        <dd>{{ connection }}</dd>
        <dt>{{ t('browser.performance.bitrate') }}</dt>
        <dd>{{ sample ? bitrate(sample.bitsPerSecond) : '—' }}</dd>
        <dt>{{ t('browser.performance.fps') }}</dt>
        <dd>{{ sample ? `${n(sample.framesPerSecond, rateFormat)} fps` : '—' }}</dd>
        <dt>{{ t('browser.performance.resolution') }}</dt>
        <dd>{{ frame ? `${frame.width} × ${frame.height}` : '—' }}</dd>
        <dt>{{ t('browser.performance.codec') }}</dt>
        <dd>{{ frame ? 'H.264' : '—' }}</dd>
      </dl>
      <p>{{ t('browser.performance.hint') }}</p>
    </section>
  </MarPopover>
</template>

<style scoped>
.browser-performance {
  color: var(--mar-ui-text-primary);
  font-size: var(--mar-font-size-meta);
}
.browser-performance dl {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 3fr);
  gap: 0.375rem 0.625rem;
  margin: 0.625rem 0;
}
.browser-performance dt,
.browser-performance p {
  color: var(--mar-ui-text-secondary);
}
.browser-performance dd {
  margin: 0;
  overflow-wrap: anywhere;
  font-variant-numeric: tabular-nums;
}
.browser-performance p {
  margin: 0;
}
</style>

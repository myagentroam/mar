<script setup lang="ts">
import { ref, useId, watch } from 'vue';
import { MarButton } from '@myagentroam/mar-ui/button';
import { MarPopover } from '@myagentroam/mar-ui/popover';
import { MarOption, MarSelect } from '@myagentroam/mar-ui/select';
import type { BrowserPictureMode, BrowserPictureQuality } from '@myagentroam/protocol';
import type { BrowserStreamSample } from '../../service/browser-attachment-client.js';
import type { BrowserDrawnView } from '../../service/browser-viewport.js';
import { useI18n } from 'vue-i18n';

// Owns only the local popover and formatting; attachment measurements are read-only.
const props = defineProps<{
  connection: string;
  frame?: BrowserDrawnView | undefined;
  sample?: BrowserStreamSample | undefined;
  disabled?: boolean;
  mode: BrowserPictureMode;
  quality?: BrowserPictureQuality | undefined;
}>();
const emit = defineEmits<{ quality: [mode: BrowserPictureMode] }>();
const modes = ['auto', 'low', 'medium', 'high'] as const;
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
        <dt>{{ t('browser.performance.viewport') }}</dt>
        <dd>{{ frame ? `${frame.width} × ${frame.height}` : '—' }}</dd>
        <dt>{{ t('browser.performance.decodedResolution') }}</dt>
        <dd>{{ frame ? `${frame.raster.width} × ${frame.raster.height}` : '—' }}</dd>
        <dt>{{ t('browser.performance.quality') }}</dt>
        <dd>{{ quality ? t(`browser.performance.${quality}`) : '—' }}</dd>
      </dl>
      <MarSelect
        :model-value="mode"
        :aria-label="t('browser.performance.qualityMode')"
        @change="emit('quality', $event as BrowserPictureMode)"
      >
        <MarOption
          v-for="value in modes"
          :key="value"
          :value="value"
          :label="t(`browser.performance.${value}`)"
        />
      </MarSelect>
      <p>{{ t('browser.performance.hint') }}</p>
    </section>
  </MarPopover>
</template>

<style scoped>
.browser-performance {
  display: grid;
  row-gap: 0.25rem;
  color: var(--mar-ui-text-primary);
  font-size: var(--mar-font-size-meta);
}
.browser-performance > strong {
  margin-block-end: 0.375rem;
}
.browser-performance dl {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 3fr);
  gap: 0.375rem 0.625rem;
  margin: 0;
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

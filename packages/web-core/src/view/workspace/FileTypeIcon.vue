<script setup lang="ts">
import { computed } from 'vue';
import { resolveIconTheme } from '../../icon-themes/index.js';
import { iconThemePreferenceService } from '../../service/icon-theme-preference-service.js';
import { themePreferenceService } from '../../service/theme-preference-service.js';

const props = withDefaults(
  defineProps<{ readonly name: string; readonly kind?: 'FILE' | 'DIRECTORY' }>(),
  { kind: 'FILE' }
);
const theme = themePreferenceService().baseTheme;
const iconTheme = iconThemePreferenceService().theme;
const icon = computed(() => {
  const light = theme.value !== 'vscode-dark-2026';
  const resolver = resolveIconTheme(iconTheme.value);
  return props.kind === 'DIRECTORY'
    ? resolver.resolveFolder(light, props.name)
    : resolver.resolveFile(props.name, light);
});
</script>

<template>
  <span
    class="file-type-icon mar-file-icon mar-file-icon-svg"
    aria-hidden="true"
    :style="{ color: icon.color, '--icon-cut': icon.cutColor }"
  >
    <svg viewBox="0 0 24 24" focusable="false">
      <use :href="icon.href" />
    </svg>
  </span>
</template>

<style scoped>
.file-type-icon {
  display: inline-grid;
  width: 1em;
  flex: 0 0 1em;
  place-items: center;
  font-size: 1rem;
  line-height: 1;
}
.mar-file-icon-svg {
  height: 1em;
}
.mar-file-icon-svg :deep(svg) {
  display: block;
  width: 1em;
  height: 1em;
}
</style>

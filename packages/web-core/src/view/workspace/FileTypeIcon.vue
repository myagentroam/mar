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
    v-if="icon.kind === 'glyph'"
    class="file-type-icon seti-file-icon"
    aria-hidden="true"
    :style="{ color: icon.color }"
    >{{ icon.character }}</span
  >
  <span
    v-else
    class="file-type-icon material-file-icon"
    aria-hidden="true"
    :style="{ color: icon.color }"
    v-html="icon.markup"
  />
</template>

<style scoped>
@font-face {
  font-family: 'MAR Seti';
  src: url('../../icon-themes/seti/assets/seti.woff') format('woff');
  font-style: normal;
  font-weight: normal;
  font-display: block;
}
.file-type-icon {
  display: inline-grid;
  width: 1em;
  flex: 0 0 1em;
  place-items: center;
  font-size: 1rem;
  line-height: 1;
}
.seti-file-icon {
  font-family: 'MAR Seti', sans-serif;
  font-style: normal;
  font-weight: normal;
}
.material-file-icon {
  height: 1em;
}
.material-file-icon :deep(svg) {
  display: block;
  width: 1em;
  height: 1em;
}
</style>

<script setup lang="ts">
import { useTemplateRef, watch } from 'vue';
import { usePopup, type PopupAnchor, type PopupPlacement } from '../popup/use-popup.js';
import '../popup/surface.css';

defineOptions({ name: 'MarTooltip' });

/** Renders a passive hint; registration, input and descriptions belong to its caller. */
const props = defineProps<{
  anchor: PopupAnchor | undefined;
  placement?: PopupPlacement | undefined;
}>();
const surface = useTemplateRef<HTMLElement>('surface');
const popup = usePopup(() => {});

watch(
  [surface, () => props.anchor, () => props.placement],
  ([element, anchor, placement]) => {
    if (!anchor || !element) popup.close();
    else popup.show(anchor, element, { placement });
  },
  { flush: 'post' }
);
</script>

<template>
  <div
    ref="surface"
    popover="manual"
    role="tooltip"
    class="mar-ui-popup mar-tooltip mar-tooltip-passive"
  >
    <div class="mar-ui-popup__content"><slot /></div>
  </div>
</template>

<style scoped>
.mar-tooltip {
  --mar-ui-popup-padding: 5px 11px;
  --mar-ui-popup-entry-y: 0;
  inline-size: max-content;
  max-inline-size: min(28rem, calc(100vw - 2rem));
  overflow-wrap: anywhere;
  white-space: pre-line;
  pointer-events: none;
  font-size: var(--mar-ui-font-size-meta);
  line-height: 1.5;
  border-color: var(--mar-ui-message-border);
  background: var(--mar-ui-tooltip-surface);
  box-shadow: var(--mar-ui-tooltip-shadow);
}
.mar-tooltip::before {
  border-color: var(--mar-ui-message-border);
  background: var(--mar-ui-tooltip-surface);
}
</style>

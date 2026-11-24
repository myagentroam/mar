<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import { MarIcon } from '@myagentroam/mar-ui/icons';

// Owns disclosure and presentation; callers supply actions and their behavior.
const props = withDefaults(
  defineProps<{
    label: string;
    collapseLabel: string;
    expandLabel: string;
    layout?: 'row' | 'compact' | 'wrap' | 'stacked' | 'image';
    mobileOnly?: boolean;
    contained?: boolean;
    compactOnDesktop?: boolean;
  }>(),
  { layout: 'row' }
);
const expanded = ref(true);
const bodyId = useId();
const toggleLabel = computed(() => (expanded.value ? props.collapseLabel : props.expandLabel));
</script>

<template>
  <div
    class="workspace-floating-actions"
    :class="[
      `is-${layout}`,
      {
        'is-collapsed': !expanded,
        'is-mobile-only': mobileOnly,
        'is-contained': contained,
        'is-desktop-compact': compactOnDesktop
      }
    ]"
    role="group"
    :aria-label="label"
  >
    <div
      :id="bodyId"
      class="workspace-floating-actions-body"
      :aria-hidden="!expanded"
      :inert="!expanded"
    >
      <slot :expanded="expanded" />
    </div>
    <button
      v-tooltip="toggleLabel"
      class="workspace-floating-actions-toggle mar-icon-button mar-icon-action"
      type="button"
      :aria-expanded="expanded"
      :aria-controls="bodyId"
      :aria-label="toggleLabel"
      @click="expanded = !expanded"
    >
      <MarIcon name="menu" />
    </button>
  </div>
</template>

<style scoped>
.workspace-floating-actions {
  --floating-action-size: 36px;
  --floating-action-gap: 0.35rem;
  --floating-toggle-gap: 0.2rem;
  position: fixed;
  z-index: 3;
  right: max(0.75rem, env(safe-area-inset-right));
  bottom: calc(0.75rem + env(safe-area-inset-bottom));
  display: flex;
  align-items: center;
  gap: 0;
  border: 1px solid var(--mar-border-default);
  border-radius: var(--mar-radius-surface);
  background: color-mix(in srgb, var(--mar-bg-panel) 96%, transparent);
  box-shadow: 0 4px 14px var(--mar-shadow-medium);
  padding: 0.25rem;
}
.workspace-floating-actions.is-contained {
  position: absolute;
}
.workspace-floating-actions :deep(.mar-ui-button) {
  border-radius: var(--mar-radius-control);
  width: var(--floating-action-size);
  min-width: var(--floating-action-size);
  height: var(--floating-action-size);
  min-height: var(--floating-action-size);
}
.workspace-floating-actions-body {
  display: flex;
  align-items: center;
  min-width: 0;
  max-height: 6rem;
  gap: var(--floating-action-gap);
  justify-content: flex-end;
  overflow: hidden;
  opacity: 1;
  transform: translateX(0) scaleX(1);
  transform-origin: right center;
  transition:
    max-width 0.18s ease,
    max-height 0.18s ease,
    opacity 0.14s ease,
    transform 0.18s ease;
}

.workspace-floating-actions.is-row .workspace-floating-actions-body {
  max-width: 12rem;
}

.workspace-floating-actions.is-compact .workspace-floating-actions-body {
  max-width: min(4.9rem, calc(100vw - 4.5rem));
}

.workspace-floating-actions.is-wrap .workspace-floating-actions-body {
  max-width: min(10.4rem, calc(100vw - 4.5rem));
  flex-wrap: wrap;
}

.workspace-floating-actions.is-image {
  --image-action-gap: 0.25rem;
  position: relative;
  inset: auto;
  align-self: flex-end;
  flex: none;
  max-inline-size: calc(100% - 1.5rem);
  margin-inline-end: max(0.75rem, env(safe-area-inset-right));
  margin-block-end: calc(0.75rem + env(safe-area-inset-bottom));
}

.workspace-floating-actions.is-image .workspace-floating-actions-body {
  gap: var(--image-action-gap);
  flex-wrap: wrap;
  max-width: 100%;
  align-items: center;
}

.workspace-floating-actions.is-image .workspace-floating-actions-toggle {
  margin-inline-start: var(--image-action-gap);
}

.workspace-floating-actions.is-stacked .workspace-floating-actions-body {
  max-width: min(16rem, calc(100vw - 4.5rem));
  flex-direction: column;
  gap: 0.25rem;
  justify-content: center;
}

.workspace-floating-actions-body :deep(.mar-ui-button + .mar-ui-button) {
  margin-inline-start: 0;
}

.workspace-floating-actions-toggle {
  display: grid;
  align-self: flex-end;
  width: var(--floating-action-size);
  min-width: var(--floating-action-size);
  height: var(--floating-action-size);
  min-height: var(--floating-action-size);
  place-items: center;
  border-radius: var(--mar-radius-control);
  margin-inline-start: var(--floating-toggle-gap);
  border: 0;
  background: transparent;
  color: var(--mar-text-secondary);
  cursor: pointer;
  font-size: 1.1rem;
}

.workspace-floating-actions.is-collapsed .workspace-floating-actions-body {
  max-width: 0;
  max-height: 0;
  opacity: 0;
  transform: translateX(0.45rem) scaleX(0.92);
  pointer-events: none;
}

.workspace-floating-actions.is-collapsed .workspace-floating-actions-toggle {
  margin-inline-start: 0;
}

@media (min-width: 768px) {
  .workspace-floating-actions.is-mobile-only {
    display: none;
  }
}
@media (min-width: 768px) and (pointer: fine) and (not (any-pointer: coarse)) {
  .workspace-floating-actions.is-desktop-compact {
    --floating-action-size: var(--mar-ui-compact-control-size);
    --floating-action-gap: 0.25rem;
    --floating-toggle-gap: var(--floating-action-gap);
    --mar-ui-action-icon-size: 14px;
    padding: 0.1875rem;
  }
  .workspace-floating-actions.is-desktop-compact :deep(.mar-ui-button) {
    --mar-ui-button-icon-size: var(--mar-ui-action-icon-size);
  }
  .is-desktop-compact .workspace-floating-actions-toggle {
    font-size: var(--mar-ui-action-icon-size);
  }
}
@media (prefers-reduced-motion: reduce) {
  .workspace-floating-actions-body {
    transition: none;
  }
}
</style>

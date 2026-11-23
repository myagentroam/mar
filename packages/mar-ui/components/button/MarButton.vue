<script setup lang="ts">
import { computed, useTemplateRef, type Component, type PropType } from 'vue';
import type { MarIconName } from '../../icons/icon-shapes.js';
import { resolveMarIcon } from '../../icons/mar-icons.js';
import { useMarFormDisabled } from '../form/form-context.js';

const props = defineProps({
  type: {
    type: String as PropType<'default' | 'primary' | 'danger' | 'warning'>,
    default: 'default'
  },
  nativeType: { type: String as PropType<'button' | 'submit'>, default: 'button' },
  tag: { type: String as PropType<'button' | 'a'>, default: 'button' },
  href: String,
  text: Boolean,
  link: Boolean,
  plain: Boolean,
  circle: Boolean,
  round: Boolean,
  icon: [String, Object, Function] as PropType<MarIconName | Component>,
  loadingIcon: [String, Object, Function] as PropType<MarIconName | Component>,
  disabled: { type: Boolean, default: undefined },
  loading: Boolean
});
const emit = defineEmits<{ click: [event: MouseEvent] }>();
const spinner = computed(() => resolveMarIcon(props.loadingIcon ?? 'loading-action'));
const disabled = useMarFormDisabled(() => props.disabled);
const inactive = computed(() => disabled.value || props.loading);
const root = useTemplateRef<HTMLButtonElement | HTMLAnchorElement>('root');
defineExpose({ ref: root, focus: (options?: FocusOptions) => root.value?.focus(options) });

function handleClick(event: MouseEvent): void {
  if (inactive.value) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  emit('click', event);
}
</script>

<template>
  <component
    :is="tag"
    ref="root"
    class="mar-ui-button"
    :class="[
      `mar-ui-button--${type}`,
      {
        'mar-ui-button--ghost': text && !link,
        'mar-ui-button--inline': link,
        'mar-ui-button--disabled': disabled,
        'mar-ui-button--plain': plain,
        'mar-ui-button--circle': circle,
        'mar-ui-button--round': round,
        'mar-ui-button--loading-in-label': loading && !icon && $slots.default
      }
    ]"
    :type="tag === 'button' ? nativeType : undefined"
    :disabled="tag === 'button' && inactive ? true : undefined"
    :href="tag === 'a' && !inactive ? href : undefined"
    :role="tag === 'a' && inactive ? 'link' : undefined"
    :aria-disabled="tag === 'a' && inactive ? true : undefined"
    :aria-busy="loading || undefined"
    @click="handleClick"
  >
    <span v-if="icon || loading" class="mar-ui-button__icon" aria-hidden="true">
      <component :is="spinner" v-if="loading" class="mar-ui-button__spinner" />
      <component :is="resolveMarIcon(icon)" v-else-if="icon" />
    </span>
    <span v-if="$slots.default" class="mar-ui-button__label"><slot /></span>
  </component>
</template>

<style scoped>
.mar-ui-button:is(.mar-icon-action, .mar-text-action) {
  --mar-ui-button-bg: transparent;
  --mar-ui-button-border: transparent;
  --mar-ui-button-hover-bg: var(--mar-action-hover-bg);
  --mar-ui-button-hover-border: transparent;
  --mar-ui-button-active-bg: var(--mar-action-hover-bg);
  --mar-ui-button-active-border: transparent;
  --mar-ui-button-disabled-bg: transparent;
  --mar-ui-button-disabled-border: transparent;
  --mar-ui-button-fg: var(--mar-ui-text-secondary);
  --mar-ui-button-hover-fg: var(--mar-action-hover-color, var(--mar-ui-text-primary));
  border-radius: var(--mar-ui-radius-control);
}

.mar-ui-button.mar-icon-action:is(
    :focus-visible,
    .is-active,
    [aria-expanded='true']:not(:where(.mar-icon-action--panel-toggle))
  ):not(:disabled, [aria-disabled='true']) {
  background: var(--mar-action-hover-bg);
  color: var(--mar-ui-button-hover-fg);
}

.mar-ui-button:is(.mar-icon-action, .mar-text-action):not(
    :disabled,
    .is-disabled,
    [aria-disabled='true']
  ) {
  --mar-ui-button-hover-bg: var(--mar-action-hover-bg);
  --mar-ui-button-active-bg: var(--mar-action-hover-bg);
  --mar-ui-button-hover-fg: var(--mar-action-hover-color, var(--mar-ui-text-primary));
  --mar-ui-button-active-fg: var(--mar-ui-button-hover-fg);
}

.mar-ui-button {
  --mar-ui-button-icon-size: 1em;
  --mar-ui-button-padding-block: 0.125rem;
  --mar-ui-button-fg: var(--mar-ui-text-secondary);
  --mar-ui-button-bg: var(--mar-ui-fill-soft);
  --mar-ui-button-border: var(--mar-ui-border-default);
  --mar-ui-button-hover-bg: var(--mar-ui-fill-row-hover);
  --mar-ui-button-hover-border: var(--mar-ui-border-medium);
  --mar-ui-button-hover-fg: var(--mar-ui-text-primary);
  --mar-ui-button-active-bg: var(--mar-ui-fill-selection);
  --mar-ui-button-active-border: var(--mar-ui-button-hover-border);
  --mar-ui-button-active-fg: var(--mar-ui-button-hover-fg);
  --mar-ui-button-disabled-fg: var(--mar-ui-text-disabled);
  --mar-ui-button-disabled-bg: var(--mar-ui-bg-panel);
  --mar-ui-button-disabled-border: var(--mar-ui-border-subtle);
  /* Keep anchor and native button geometry identical when host styles reset either element. */
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.375rem;
  min-block-size: var(--mar-ui-compact-control-size, 24px);
  padding: var(--mar-ui-button-padding-block) 0.625rem;
  border: 1px solid var(--mar-ui-button-border);
  border-radius: var(--mar-ui-radius-control);
  background: var(--mar-ui-button-bg);
  color: var(--mar-ui-button-fg);
  font: inherit;
  font-size: var(--mar-ui-font-size-control);
  font-weight: 500;
  line-height: 1.35;
  cursor: pointer;
  text-decoration: none;
}

.mar-ui-button:where(
  :has(> .mar-ui-button__label):not(.mar-ui-button--inline, .mar-icon-action, .mar-text-action)
) {
  vertical-align: middle;
}

.mar-ui-button--primary {
  --mar-ui-button-fg: var(--mar-ui-control-primary-fg);
  --mar-ui-button-bg: var(--mar-ui-control-primary-bg);
  --mar-ui-button-border: var(--mar-ui-button-bg);
  --mar-ui-button-hover-bg: var(--mar-ui-control-primary-hover);
  --mar-ui-button-hover-border: var(--mar-ui-button-hover-bg);
  --mar-ui-button-hover-fg: var(--mar-ui-button-fg);
  --mar-ui-button-active-bg: var(--mar-ui-control-primary-active);
  --mar-ui-button-active-border: var(--mar-ui-button-active-bg);
  --mar-ui-button-disabled-bg: var(--mar-ui-fill-soft);
}

.mar-ui-button--ghost,
.mar-ui-button--inline {
  --mar-ui-button-bg: transparent;
  --mar-ui-button-border: transparent;
  --mar-ui-button-hover-border: transparent;
  --mar-ui-button-disabled-bg: transparent;
  --mar-ui-button-disabled-border: transparent;
}

.mar-ui-button--inline {
  --mar-ui-button-hover-bg: transparent;
  --mar-ui-button-active-bg: transparent;
  min-block-size: auto;
  padding: 0;
}

.mar-ui-button--primary:is(.mar-ui-button--ghost, .mar-ui-button--inline, .mar-ui-button--plain) {
  --mar-ui-button-fg: var(--mar-ui-control-link-text);
  --mar-ui-button-hover-fg: var(--mar-ui-control-link-hover);
  --mar-ui-button-active-bg: var(--mar-ui-button-hover-bg);
  --mar-ui-button-active-border: var(--mar-ui-button-hover-border);
}
.mar-ui-button--primary.mar-ui-button--ghost {
  --mar-ui-button-hover-bg: var(--mar-ui-fill-row-hover);
}
.mar-ui-button--primary.mar-ui-button--plain {
  --mar-ui-button-bg: var(--mar-ui-fill-soft);
  --mar-ui-button-hover-bg: var(--mar-ui-fill-row-hover);
  --mar-ui-button-hover-border: var(--mar-ui-border-medium);
  --mar-ui-button-border: var(--mar-ui-border-default);
  --mar-ui-button-disabled-bg: var(--mar-ui-bg-panel);
}

.mar-ui-button--danger {
  --mar-ui-button-tone: var(--mar-ui-control-color-danger);
}
.mar-ui-button--warning {
  --mar-ui-button-tone: var(--mar-ui-control-color-warning);
}
.mar-ui-button:is(.mar-ui-button--danger, .mar-ui-button--warning) {
  --mar-ui-button-fg: var(--mar-ui-control-intent-fg, var(--mar-ui-button-tone));
  --mar-ui-button-bg: color-mix(
    in srgb,
    var(--mar-ui-button-tone) var(--mar-ui-control-intent-fill-strength),
    var(--mar-ui-control-intent-fill-base)
  );
  --mar-ui-button-border: color-mix(
    in srgb,
    var(--mar-ui-button-tone) var(--mar-ui-control-intent-border-strength),
    var(--mar-ui-bg-panel)
  );
  --mar-ui-button-hover-bg: color-mix(
    in srgb,
    var(--mar-ui-button-tone) var(--mar-ui-control-intent-hover-strength),
    var(--mar-ui-control-intent-fill-base)
  );
  --mar-ui-button-hover-border: color-mix(
    in srgb,
    var(--mar-ui-button-tone) var(--mar-ui-control-intent-hover-border-strength),
    var(--mar-ui-control-intent-fill-base)
  );
  --mar-ui-button-active-bg: color-mix(
    in srgb,
    var(--mar-ui-button-tone) var(--mar-ui-control-intent-active-strength),
    var(--mar-ui-control-intent-fill-base)
  );
  --mar-ui-button-hover-fg: var(--mar-ui-button-fg);
}
.mar-ui-button:is(.mar-ui-button--danger, .mar-ui-button--warning):is(
    .mar-ui-button--plain,
    .mar-ui-button--inline,
    .mar-ui-button--ghost
  ) {
  --mar-ui-button-fg: var(--mar-ui-button-tone);
  --mar-ui-button-hover-fg: var(--mar-ui-button-tone);
  --mar-ui-button-bg: transparent;
  --mar-ui-button-hover-bg: transparent;
  --mar-ui-button-active-bg: transparent;
}
.mar-ui-button:is(.mar-ui-button--danger, .mar-ui-button--warning):is(
    .mar-ui-button--inline,
    .mar-ui-button--ghost
  ) {
  --mar-ui-button-border: transparent;
  --mar-ui-button-hover-border: transparent;
}
.mar-ui-button:is(.mar-ui-button--circle, .mar-ui-button--round) {
  border-radius: 999px;
}
.mar-ui-button--circle {
  aspect-ratio: 1;
  padding-inline: 0;
}
.mar-ui-button + .mar-ui-button {
  margin-inline-start: 12px;
}

@media (hover: hover) {
  .mar-ui-button:not(:disabled, [aria-disabled='true']):hover {
    background: var(--mar-ui-button-hover-bg);
    border-color: var(--mar-ui-button-hover-border);
    color: var(--mar-ui-button-hover-fg);
  }
}

.mar-ui-button:not(:disabled, [aria-disabled='true']):active {
  background: var(--mar-ui-button-active-bg);
  border-color: var(--mar-ui-button-active-border);
  color: var(--mar-ui-button-active-fg);
}

.mar-ui-button--disabled {
  background: var(--mar-ui-button-disabled-bg);
  border-color: var(--mar-ui-button-disabled-border);
  color: var(--mar-ui-button-disabled-fg);
  cursor: not-allowed;
}

.mar-ui-button[aria-busy='true'] {
  cursor: progress;
}

@media (max-width: 767px) {
  .mar-ui-button:not(:has(> .mar-ui-button__label)) {
    --mar-ui-button-icon-size: var(--mar-ui-action-icon-size, 18px);
  }

  /* Labeled actions keep their glyph and spinner aligned with the label, not the tool icon scale. */
  .mar-ui-button:where(:has(> .mar-ui-button__label)) > .mar-ui-button__icon > :deep(.mar-icon) {
    font-size: inherit;
  }
}

.mar-ui-button__icon {
  font-size: var(--mar-ui-button-icon-size);
  flex: 0 0 1em;
  inline-size: 1em;
  display: inline-grid;
  place-items: center;
  block-size: 1em;
}

@media (prefers-reduced-motion: no-preference) {
  .mar-ui-button__spinner {
    animation: mar-ui-button-spin 2s linear infinite;
  }
}

@keyframes mar-ui-button-spin {
  to {
    transform: rotate(360deg);
  }
}

.mar-ui-button--loading-in-label {
  position: relative;
}

.mar-ui-button--loading-in-label .mar-ui-button__icon {
  position: absolute;
  inset: 0;
  margin: auto;
}

/* Keep the label's dimensions and accessible name while showing the busy glyph in its place. */
.mar-ui-button--loading-in-label .mar-ui-button__label {
  opacity: 0;
}

.mar-ui-button__label {
  min-inline-size: 0;
  overflow-wrap: anywhere;
}
</style>

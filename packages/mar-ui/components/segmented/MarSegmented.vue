<script setup lang="ts" generic="Value extends string">
import { shallowRef, useId, useTemplateRef, watch, watchPostEffect } from 'vue';

const props = defineProps<{
  options: readonly { value: Value; label: string; accessibleLabel?: string }[];
  label?: string;
  block?: boolean;
  compact?: boolean;
}>();
const model = defineModel<Value>({ required: true });
const emit = defineEmits<{ change: [value: Value] }>();
const name = useId();
const track = useTemplateRef('track');
const position = shallowRef<{ x: number; width: number }>();

function placeIndicator(): void {
  const element = track.value;
  if (!element?.clientWidth) return;
  const selected = element.querySelector('.is-selected')?.getBoundingClientRect();
  if (!selected?.width) {
    position.value = undefined;
    return;
  }
  // Preserve fractional flex widths so the indicator stays flush with either option.
  const { width } = selected;
  const borderLeft = parseFloat(getComputedStyle(element).borderLeftWidth);
  const x = selected.left - element.getBoundingClientRect().left - borderLeft;
  if (position.value?.x !== x || position.value.width !== width) position.value = { x, width };
}

// Keep the indicator aligned when the available width, labels, or fonts change.
watchPostEffect((onCleanup) => {
  const element = track.value;
  const options = props.options;
  if (!element || typeof ResizeObserver === 'undefined' || !options.length) return;
  const observer = new ResizeObserver(placeIndicator);
  observer.observe(element);
  for (const label of element.querySelectorAll('label')) observer.observe(label);
  onCleanup(() => observer.disconnect());
});
watch(model, placeIndicator, { flush: 'post' });

function select(value: Value): void {
  if (value === model.value) return;
  model.value = value;
  emit('change', value);
}

function navigateToEdge(event: KeyboardEvent): void {
  if (event.key !== 'Home' && event.key !== 'End') return;
  const index = event.key === 'Home' ? 0 : props.options.length - 1;
  const radio = track.value?.querySelectorAll('input')[index];
  if (!radio) return;
  event.preventDefault();
  radio.focus();
  radio.click();
}
</script>

<template>
  <div
    ref="track"
    class="mar-segmented"
    :class="{ 'is-block': block, 'is-compact': compact, 'has-indicator': position }"
    :style="
      position && { '--segment-x': `${position.x}px`, '--segment-width': `${position.width}px` }
    "
    role="radiogroup"
    :aria-label="label"
    @keydown="navigateToEdge"
  >
    <span v-if="position" class="mar-segmented-indicator" aria-hidden="true"></span>
    <label
      v-for="option in options"
      :key="option.value"
      class="mar-segmented-option"
      :class="{ 'is-selected': model === option.value }"
    >
      <input
        type="radio"
        :name="name"
        :value="option.value"
        :checked="model === option.value"
        :aria-label="option.accessibleLabel"
        @change="select(option.value)"
      />
      <span>{{ option.label }}</span>
    </label>
  </div>
</template>

<style scoped>
.mar-segmented {
  --mar-segmented-inset: 1px;
  --mar-segmented-border-width: 1px;
  position: relative;
  display: inline-flex;
  width: max-content;
  min-block-size: var(--mar-ui-compact-control-size, 24px);
  gap: 2px;
  padding: var(--mar-segmented-inset);
  border: var(--mar-segmented-border-width) solid var(--mar-ui-border-default);
  border-radius: var(--mar-ui-radius-control);
  background: var(--mar-ui-bg-subtle);
  color: var(--mar-ui-text-secondary);
  font-size: var(--mar-ui-font-size-control);
  line-height: 1.4;
}
.mar-segmented.is-block {
  display: flex;
  width: 100%;
  min-width: 0;
}
.mar-segmented-option,
.mar-segmented-indicator {
  border-radius: calc(
    var(--mar-ui-radius-control) - var(--mar-segmented-border-width) - var(--mar-segmented-inset)
  );
}
.mar-segmented-option {
  position: relative;
  display: grid;
  place-items: center;
  min-width: 0;
  padding-inline: var(--mar-ui-compact-option-padding-inline);
  color: inherit;
  font-size: inherit;
  font-weight: 400;
  white-space: nowrap;
}
.is-block .mar-segmented-option {
  flex: 1 1 0;
}
.is-compact .mar-segmented-option {
  /* Keep the same outer height after reducing the track padding. */
  min-block-size: calc(var(--mar-ui-compact-control-size) + 2px);
  padding-inline: 0.25rem;
}
.mar-segmented-option input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}
.mar-segmented-option.is-selected,
.mar-segmented-option:hover {
  color: var(--mar-ui-text-primary);
}
.mar-segmented-option:not(.is-selected):hover {
  background: var(--mar-ui-fill-row-hover);
}
.mar-segmented-option:has(:focus-visible) {
  outline: 2px solid var(--mar-ui-control-focus);
  outline-offset: -2px;
}
.mar-segmented:not(.has-indicator) .mar-segmented-option.is-selected,
.mar-segmented-indicator {
  background: var(--mar-ui-fill-selection);
}
.mar-segmented-indicator {
  position: absolute;
  inset-block: var(--mar-segmented-inset);
  left: 0;
  width: var(--segment-width, 0px);
  transform: translateX(var(--segment-x, 0px));
  pointer-events: none;
}
@media (prefers-reduced-motion: no-preference) {
  .has-indicator .mar-segmented-option {
    /* Keep the hover fill continuous as the selection indicator slides or reverses. */
    transition: background-color 100ms ease-out;
  }
  .has-indicator .mar-segmented-indicator {
    transition:
      transform 160ms ease-out,
      width 160ms ease-out;
  }
}
@media (forced-colors: active) {
  .mar-segmented-indicator {
    display: none;
  }
  .mar-segmented-option.is-selected::after {
    position: absolute;
    inset: 0;
    border: 1px solid Highlight;
    border-radius: inherit;
    pointer-events: none;
    content: '';
  }
  .mar-segmented-option:has(:focus-visible) {
    outline-color: CanvasText;
    outline-offset: -4px;
  }
}
</style>

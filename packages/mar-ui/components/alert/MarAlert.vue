<script setup lang="ts">
import { ref } from 'vue';
import { MarIcon } from '../../icons/index.js';
import { useMarUiLocale } from '../../locale/index.js';

withDefaults(
  defineProps<{
    title?: string;
    description?: string;
    type?: 'success' | 'warning' | 'info' | 'error';
    showIcon?: boolean;
    closable?: boolean;
  }>(),
  { type: 'info', closable: true }
);
const emit = defineEmits<{ close: [event: MouseEvent] }>();
const locale = useMarUiLocale();
const dismissed = ref(false);
</script>

<template>
  <div v-if="!dismissed" class="mar-ui-alert" :data-type="type" role="alert">
    <MarIcon v-if="showIcon" :name="type" class="mar-ui-alert__icon" />
    <div class="mar-ui-alert__content">
      <div v-if="title || $slots.title" class="mar-ui-alert__title">
        <slot name="title">{{ title }}</slot>
      </div>
      <div v-if="description || $slots.default" class="mar-ui-alert__description">
        <slot>{{ description }}</slot>
      </div>
    </div>
    <button
      v-if="closable"
      type="button"
      :aria-label="locale.close"
      @click="
        dismissed = true;
        emit('close', $event);
      "
    >
      <MarIcon name="close" />
    </button>
  </div>
</template>

<style scoped>
.mar-ui-alert {
  --alert-fg: var(--mar-ui-text-secondary);
  --alert-bg: var(--mar-ui-fill-subtle);
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  inline-size: 100%;
  padding: 0.5rem 1rem;
  border-radius: var(--mar-ui-radius-control);
  background: var(--alert-bg);
  color: var(--alert-fg);
  font-size: var(--mar-ui-font-size-body);
  line-height: 1.5;
}
[data-type='success'] {
  --alert-fg: var(--mar-ui-color-success-text);
  --alert-bg: var(--mar-ui-color-success-bg);
}
[data-type='warning'] {
  --alert-fg: var(--mar-ui-color-warning-text);
  --alert-bg: var(--mar-ui-color-warning-bg);
}
[data-type='error'] {
  --alert-fg: var(--mar-ui-color-danger-text);
  --alert-bg: var(--mar-ui-color-danger-bg);
}
.mar-ui-alert__icon {
  flex: none;
  inline-size: 1em;
  block-size: 1em;
  margin-block-start: 0.25em;
}
.mar-ui-alert__content {
  min-inline-size: 0;
  flex: 1;
  overflow-wrap: anywhere;
}
.mar-ui-alert__title {
  font-weight: 500;
}
.mar-ui-alert__title + .mar-ui-alert__description {
  margin-block-start: 0.25rem;
}
button {
  display: inline-flex;
  padding: 0.125rem;
  border: 0;
  border-radius: var(--mar-ui-radius-control);
  background: transparent;
  color: inherit;
  cursor: pointer;
}
button:focus-visible {
  outline: 2px solid currentColor;
}
</style>

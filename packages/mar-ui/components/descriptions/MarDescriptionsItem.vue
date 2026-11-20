<script setup lang="ts">
defineProps<{ label?: string }>();
</script>

<template>
  <div class="mar-ui-descriptions__item">
    <dt class="mar-ui-descriptions__label">
      <slot name="label">{{ label }}</slot>
    </dt>
    <dd class="mar-ui-descriptions__content"><slot /></dd>
  </div>
</template>

<style scoped>
.mar-ui-descriptions__item {
  display: grid;
  grid-template-columns:
    min(var(--mar-ui-descriptions-label-width, 132px), var(--mar-ui-descriptions-label-share, 38%))
    minmax(0, 1fr);
  min-inline-size: 0;
}
dt,
dd {
  min-inline-size: 0;
  margin: 0;
  padding: 0.5rem 0.75rem;
  overflow-wrap: anywhere;
}
dt {
  color: var(--mar-ui-text-secondary);
  font-weight: 500;
}
:global(.mar-ui-descriptions.is-bordered) > .mar-ui-descriptions__item > dt {
  border-inline-end: 1px solid var(--mar-ui-border-subtle);
  background: var(--mar-ui-bg-subtle);
}
:global(.mar-ui-descriptions.is-bordered) > .mar-ui-descriptions__item > dd {
  background: var(--mar-ui-bg-panel);
}
</style>

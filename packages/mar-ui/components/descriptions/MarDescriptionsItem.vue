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
    min(var(--mar-ui-descriptions-label-width, 112px), var(--mar-ui-descriptions-label-share, 34%))
    minmax(0, 1fr);
  align-items: baseline;
  gap: 0.75rem;
  min-inline-size: 0;
  padding-block: 0.5rem;
}
dt,
dd {
  min-inline-size: 0;
  margin: 0;
  overflow-wrap: anywhere;
}
dt {
  color: var(--mar-ui-text-secondary);
  font-weight: 500;
}

@container mar-descriptions (inline-size < 27rem) {
  .mar-ui-descriptions__item {
    grid-template-columns: minmax(0, 1fr);
    gap: 0.125rem;
  }
}
</style>

<script setup lang="ts">
withDefaults(defineProps<{ column?: number; border?: boolean }>(), { column: 3 });
</script>

<template>
  <dl
    class="mar-ui-descriptions"
    :class="{ 'is-bordered': border }"
    :style="{ '--descriptions-columns': column }"
  >
    <slot />
  </dl>
</template>

<style scoped>
.mar-ui-descriptions {
  display: grid;
  grid-template-columns: repeat(var(--descriptions-columns), minmax(0, 1fr));
  margin: 0;
  color: var(--mar-ui-text-primary);
  font-size: var(--mar-ui-font-size-body);
  line-height: 1.5;
}
.is-bordered {
  gap: 1px;
  border: 1px solid var(--mar-ui-border-subtle);
  background: var(--mar-ui-border-subtle);
}
.is-bordered > :deep(.mar-ui-descriptions__item > .mar-ui-descriptions__label) {
  border-inline-end: 1px solid var(--mar-ui-border-subtle);
  background: var(--mar-ui-bg-subtle);
}
.is-bordered > :deep(.mar-ui-descriptions__item > .mar-ui-descriptions__content) {
  background: var(--mar-ui-bg-panel);
}
@media (max-width: 480px) {
  .mar-ui-descriptions {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>

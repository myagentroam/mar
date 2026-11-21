<script setup lang="ts">
withDefaults(defineProps<{ column?: number; border?: boolean }>(), { column: 3 });
</script>

<template>
  <dl
    class="mar-ui-descriptions"
    :class="{ 'is-bordered': border }"
    :data-columns="column"
    :style="{ '--descriptions-columns': column }"
  >
    <slot />
  </dl>
</template>

<style scoped>
.mar-ui-descriptions {
  container: mar-descriptions / inline-size;
  display: grid;
  grid-template-columns: repeat(var(--descriptions-columns), minmax(0, 1fr));
  column-gap: 1.25rem;
  inline-size: 100%;
  margin: 0;
  color: var(--mar-ui-text-primary);
  font-size: var(--mar-ui-font-size-body);
  line-height: 1.5;
}
.is-bordered > :deep(.mar-ui-descriptions__item:not(:first-child)) {
  border-block-start: 1px solid var(--mar-ui-border-subtle);
}

@container mar-descriptions (inline-size >= 27rem) {
  /* Leave the first visual row open for the standard multi-column layouts. */
  .is-bordered[data-columns='2'] > :deep(.mar-ui-descriptions__item:nth-child(-n + 2)),
  .is-bordered[data-columns='3'] > :deep(.mar-ui-descriptions__item:nth-child(-n + 3)) {
    border-block-start: 0;
  }
}

@container mar-descriptions (inline-size < 27rem) {
  .mar-ui-descriptions > :deep(.mar-ui-descriptions__item) {
    grid-column: 1 / -1;
  }
}
</style>

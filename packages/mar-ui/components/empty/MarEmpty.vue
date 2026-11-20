<script setup lang="ts">
import { MarIcon } from '../../icons/index.js';
import { useMarUiLocale } from '../../locale/index.js';

defineProps<{ description?: string }>();
const locale = useMarUiLocale();
</script>

<template>
  <div class="mar-ui-empty">
    <MarIcon name="folder-open" size="32" />
    <p>{{ description ?? locale.noData }}</p>
  </div>
</template>

<style scoped>
.mar-ui-empty {
  display: grid;
  justify-items: center;
  gap: 0.5rem;
  padding-block: 1.5rem;
  color: var(--mar-ui-text-secondary);
  font-size: var(--mar-ui-font-size-body);
  text-align: center;
}
p {
  margin: 0;
}
</style>

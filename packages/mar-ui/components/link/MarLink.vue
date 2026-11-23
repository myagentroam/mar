<script setup lang="ts">
import type { Component } from 'vue';
import { MarIcon } from '../../icons/index.js';
import type { MarIconName } from '../../icons/icon-shapes.js';

withDefaults(
  defineProps<{
    href?: string | undefined;
    type?: 'default' | 'primary';
    underline?: boolean | 'always' | 'hover' | 'never';
    icon?: MarIconName | Component;
  }>(),
  { type: 'default', underline: 'hover' }
);
</script>

<template>
  <a class="mar-ui-link" :href="href" :data-type="type" :data-underline="underline">
    <MarIcon v-if="typeof icon === 'string'" :name="icon" />
    <component :is="icon" v-else-if="icon" aria-hidden="true" />
    <span v-if="$slots.default" class="mar-ui-link__inner"><slot /></span>
  </a>
</template>

<style scoped>
.mar-ui-link {
  display: inline-flex;
  min-inline-size: 0;
  align-items: center;
  gap: 0.25rem;
  color: var(--mar-ui-link-text-color, var(--mar-ui-text-secondary));
  font-size: inherit;
  text-decoration: none;
}
.mar-ui-link[data-type='primary'] {
  color: var(--mar-ui-link-text-color, var(--mar-ui-control-link-text));
}
.mar-ui-link:hover {
  color: var(--mar-ui-link-hover-text-color, var(--mar-ui-control-link-hover));
}
.mar-ui-link[data-underline='always'],
.mar-ui-link[data-underline='true']:hover,
.mar-ui-link[data-underline='hover']:hover {
  text-decoration: underline;
}
.mar-ui-link__inner {
  min-inline-size: 0;
}
svg {
  flex: none;
}
</style>

<script setup lang="ts">
import type { TableColumnProps, TableCellScope } from './table-columns.js';

/** Declares a column. The owning table renders its header and cell slots in source order. */
defineOptions({ name: 'MarTableColumn' });
defineProps<TableColumnProps>();
defineSlots<{
  default?(scope: TableCellScope): unknown;
  header?(scope: Omit<TableCellScope, 'row'>): unknown;
}>();
</script>

<template></template>

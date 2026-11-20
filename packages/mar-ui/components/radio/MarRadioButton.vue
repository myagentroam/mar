<script setup lang="ts">
import MarRadio from './MarRadio.vue';
import type { RadioValue } from './radio-context.js';
defineProps<{ value: RadioValue; disabled?: boolean }>();
</script>

<template>
  <MarRadio :value="value" :disabled="disabled" button><slot /></MarRadio>
</template>

<script setup lang="ts">
// Owns placement only; consumers supply status semantics, controls, and request state.
withDefaults(defineProps<{ placement?: 'top' | 'center' }>(), { placement: 'top' });
</script>

<template>
  <div class="mar-region-status" :class="{ 'mar-region-status--center': placement === 'center' }">
    <slot />
  </div>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    readonly name: 'help' | 'info';
    readonly size?: number | string;
  }>(),
  {
    size: '1em'
  }
);
</script>

<template>
  <svg
    class="mar-icon"
    viewBox="0 0 24 24"
    :width="size"
    :height="size"
    fill="currentColor"
    aria-hidden="true"
    focusable="false"
  >
    <path
      fill-rule="evenodd"
      d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 1.4a7.6 7.6 0 1 1 0 15.2 7.6 7.6 0 0 1 0-15.2Z"
      clip-rule="evenodd"
    />
    <template v-if="name === 'info'">
      <circle cx="12" cy="7.8" r="1" />
      <path d="M11.2 10.4h1.6v6.4h-1.6z" />
    </template>
    <template v-else>
      <path
        d="M11.2 14.2v-.4c0-1.25.52-1.9 1.5-2.56.84-.56 1.28-.98 1.28-1.76 0-1.02-.76-1.68-1.94-1.68-1.08 0-1.82.48-2.3 1.44L8.4 8.5c.7-1.42 1.96-2.16 3.7-2.16 2.12 0 3.58 1.18 3.58 3.04 0 1.42-.7 2.18-1.9 2.98-.86.58-1.14 1-1.14 1.84H11.2Z"
      />
      <circle cx="11.92" cy="17.1" r="1" />
    </template>
  </svg>
</template>

<style scoped>
.mar-icon {
  display: block;
  flex: 0 0 auto;
}
</style>

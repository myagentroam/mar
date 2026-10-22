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
        d="M9 10C9 8.8 10.2 8 12 8S15 8.9 15 10.2C15 11.3 14.4 11.9 13.3 12.6C12.3 13.25 12 13.7 12 14.5"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <circle cx="12" cy="17" r="0.75" />
    </template>
  </svg>
</template>

<style scoped>
.mar-icon {
  display: block;
  flex: 0 0 auto;
}
</style>

<script setup lang="ts">
withDefaults(
  defineProps<{
    readonly name: 'help' | 'info' | 'reasoning';
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
    <g
      v-if="name === 'reasoning'"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M12 6C12 2 7 2 7 5 3 5 2 9 4 11 1 14 3 18 6 18 6 22 12 22 12 18V6Z" />
      <path d="M12 6C12 2 17 2 17 5 21 5 22 9 20 11 23 14 21 18 18 18 18 22 12 22 12 18" />
      <path d="M7 5v3m-3 3c2-1 4 0 4 2m-2 5c0-2 1-3 3-3" />
      <path d="M17 5v3m3 3c-2-1-4 0-4 2m2 5c0-2-1-3-3-3" />
    </g>
    <template v-else>
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
    </template>
  </svg>
</template>

<style scoped>
.mar-icon {
  display: block;
  flex: 0 0 auto;
}
</style>

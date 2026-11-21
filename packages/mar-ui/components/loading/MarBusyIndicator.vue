<template>
  <i class="mar-busy-indicator" aria-hidden="true" />
</template>

<style src="./loading-ring.css"></style>

<style>
:where(.mar-busy-indicator) {
  display: inline-block;
  width: 0.75rem;
  height: 0.75rem;
  flex: none;
}

@media (prefers-reduced-motion: no-preference) {
  .mar-busy-indicator {
    animation: mar-loading-ring-spin 1.2s linear infinite;
  }
}
</style>

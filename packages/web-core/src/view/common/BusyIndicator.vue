<template>
  <i class="busy-indicator" aria-hidden="true" />
</template>

<style scoped>
.busy-indicator {
  display: inline-block;
  box-sizing: border-box;
  width: 0.75rem;
  height: 0.75rem;
  flex: none;
  border: 2px solid currentColor;
  border-inline-end-color: transparent;
  border-radius: 50%;
}
@media (prefers-reduced-motion: no-preference) {
  .busy-indicator {
    animation: busy-indicator-spin 1.2s linear infinite;
  }
}
@keyframes busy-indicator-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>

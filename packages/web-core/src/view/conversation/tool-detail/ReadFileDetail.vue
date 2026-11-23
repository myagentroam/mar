<script setup lang="ts">
import '../conversation-detail.css';
const props = defineProps<{ path: string; range?: string | undefined; text: string }>();
</script>

<template>
  <div class="tool-content read-detail">
    <p class="tool-detail-heading tool-detail-meta">
      {{ [props.path, props.range].filter(Boolean).join(' · ') }}
    </p>
    <pre class="mar-conversation-detail-text">{{ props.text }}</pre>
  </div>
</template>

<style scoped>
.tool-content p {
  margin: 0;
}
.tool-content > .tool-detail-heading {
  margin-bottom: 0.375rem;
}
</style>

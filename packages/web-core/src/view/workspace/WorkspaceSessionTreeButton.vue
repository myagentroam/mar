<script setup lang="ts">
import { translate } from '../../service/locale-preference-service.js';
import type { NavigationSummary } from '../../service/session-navigation-projection.js';
import MarIcon from '../common/MarIcon.vue';

defineProps<{
  sessionId: string;
  open: boolean;
  summary?: NavigationSummary | undefined;
  status: 'idle' | 'loading' | 'ready' | 'failed';
}>();
const emit = defineEmits<{ show: [sessionId: string, anchor: HTMLElement] }>();
</script>

<template>
  <button
    type="button"
    class="icon-button utility-control conversation-tree-button"
    :aria-description="
      status === 'failed'
        ? translate('sessionGroups.treeSyncUnavailable')
        : summary?.hasActiveDescendants
          ? translate('sessionGroups.activeDescendants', { count: summary.activeCount })
          : undefined
    "
    :aria-label="translate('sessionGroups.tree')"
    :aria-expanded="open"
    aria-haspopup="dialog"
    @click="emit('show', sessionId, $event.currentTarget as HTMLElement)"
  >
    <MarIcon name="session-tree" />
    <span
      v-if="summary?.hasActiveDescendants"
      class="tree-active-indicator mar-icon-status-badge"
      :class="{ paused: status !== 'ready' }"
      aria-hidden="true"
    />
  </button>
</template>

<style scoped>
.conversation-tree-button {
  display: inline-flex;
  position: relative;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 1.25rem;
  height: 1.25rem;
}
.tree-active-indicator {
  --mar-icon-status-size: 4px;
  --mar-icon-status-surface: var(--mar-bg-panel);
  inset-block-end: 3px;
  inset-inline-end: 3px;
}
.tree-active-indicator.paused {
  opacity: 0.6;
}
</style>

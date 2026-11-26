<script setup lang="ts">
import '../session/session-markers.css';
import { translate } from '../../service/locale-preference-service.js';
import type { NavigationSummary } from '../../service/session-navigation-projection.js';
import { MarIcon } from '@myagentroam/mar-ui/icons';

defineProps<{
  sessionId: string;
  open: boolean;
  collaboration?: boolean;
  summary?: NavigationSummary | undefined;
  status: 'idle' | 'loading' | 'ready' | 'failed';
}>();
const emit = defineEmits<{ show: [sessionId: string, anchor: HTMLElement] }>();
</script>

<template>
  <button
    type="button"
    class="mar-icon-button mar-icon-action conversation-tree-button"
    v-tooltip="translate(collaboration ? 'collaboration.entry' : 'sessionGroups.tree')"
    :aria-description="
      status === 'failed'
        ? translate('sessionGroups.treeSyncUnavailable')
        : summary?.hasActiveDescendants
          ? translate('sessionGroups.activeDescendants', { count: summary.activeCount })
          : undefined
    "
    :aria-label="translate(collaboration ? 'collaboration.entry' : 'sessionGroups.tree')"
    :aria-expanded="open"
    aria-haspopup="dialog"
    @click="emit('show', sessionId, $event.currentTarget as HTMLElement)"
  >
    <span class="tree-icon">
      <MarIcon :name="collaboration ? 'collaboration-network' : 'session-tree'" />
      <span
        v-if="summary?.hasActiveDescendants"
        class="tree-active-indicator mar-icon-status-badge"
        aria-hidden="true"
      />
    </span>
  </button>
</template>

<style scoped>
.conversation-tree-button {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
}
.tree-icon {
  position: relative;
  display: inline-flex;
  font-size: var(--mar-ui-action-icon-size, 18px);
}
.tree-active-indicator {
  --mar-icon-status-size: 4px;
  --mar-icon-status-surface: var(--mar-conversation-canvas);
  inset-block-end: 0;
  inset-inline-end: 0;
}

@media (max-width: 767px) {
  .conversation-tree-button {
    width: 36px;
    height: 36px;
  }
}
</style>

<script setup lang="ts">
import { translate } from '../../service/locale-preference-service.js';

defineProps<{
  running: number;
  unread: boolean;
}>();
</script>

<template>
  <span v-if="running > 0 || unread" class="session-state-badge" aria-hidden="true">
    <span v-if="running > 0" class="session-state-count">{{ running > 99 ? '99+' : running }}</span>
    <span v-if="unread" class="session-state-unread">{{ translate('sessionGroups.unread') }}</span>
  </span>
</template>

<style scoped>
.session-state-badge {
  display: inline-flex;
  flex: none;
  align-items: stretch;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, currentColor 60%, var(--mar-border-medium));
  border-radius: var(--mar-radius-marker);
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-nano);
  font-weight: 500;
  line-height: 1.4;
  white-space: nowrap;
}
.session-state-badge > span {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding-inline: 0.1875rem;
}
.session-state-count {
  background: var(--mar-color-brand);
  color: var(--mar-color-on-accent);
  font-variant-numeric: tabular-nums;
}
.session-state-unread {
  background: var(--mar-bg-panel);
}
.session-state-count + .session-state-unread {
  border-inline-start: 1px solid color-mix(in srgb, currentColor 60%, var(--mar-border-medium));
}
</style>

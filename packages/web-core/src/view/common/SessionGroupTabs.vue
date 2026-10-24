<script setup lang="ts">
import type { SessionGroup } from '@myagentroam/protocol';
import { translate } from '../../service/locale-preference-service.js';

const props = defineProps<{
  modelValue: SessionGroup;
  state: Record<SessionGroup, { running: number; unread: boolean }>;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: SessionGroup] }>();
const groups: readonly SessionGroup[] = ['MAIN', 'CHILD'];
function label(group: SessionGroup): string {
  return translate(group === 'MAIN' ? 'sessionGroups.main' : 'sessionGroups.child');
}
function accessibleLabel(group: SessionGroup): string {
  const state = props.state[group];
  return [
    label(group),
    state.running ? translate('sessionGroups.running', { count: state.running }) : '',
    state.unread ? translate('sessionGroups.unread') : ''
  ]
    .filter(Boolean)
    .join(', ');
}
function navigate(event: KeyboardEvent, group: SessionGroup): void {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const next =
    event.key === 'Home'
      ? 'MAIN'
      : event.key === 'End'
        ? 'CHILD'
        : group === 'MAIN'
          ? 'CHILD'
          : 'MAIN';
  emit('update:modelValue', next);
  const parent = (event.currentTarget as HTMLElement).parentElement;
  parent?.querySelector<HTMLButtonElement>(`[data-group="${next}"]`)?.focus();
}
</script>

<template>
  <div class="session-group-tabs" role="tablist" :aria-label="translate('sessionGroups.label')">
    <button
      v-for="group in groups"
      :key="group"
      type="button"
      role="tab"
      :data-group="group"
      :aria-selected="modelValue === group"
      :tabindex="modelValue === group ? 0 : -1"
      :aria-label="accessibleLabel(group)"
      @click="emit('update:modelValue', group)"
      @keydown="navigate($event, group)"
    >
      <span>{{ label(group) }}</span>
      <el-badge
        v-if="state[group].running"
        class="group-running"
        :value="state[group].running"
        :max="99"
        type="success"
        aria-hidden="true"
      />
      <span v-if="state[group].unread" class="group-unread" aria-hidden="true">{{
        translate('sessionGroups.unread')
      }}</span>
    </button>
  </div>
</template>

<style scoped>
.session-group-tabs {
  display: flex;
  gap: 0.25rem;
  padding: 0.25rem;
}
.session-group-tabs button {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 0.25rem;
  padding: 0.4rem 0.25rem;
  border: 0;
  border-radius: var(--mar-radius-control);
  background: transparent;
  color: var(--mar-text-secondary);
  font-size: var(--mar-font-size-meta);
  cursor: pointer;
}
.session-group-tabs button:hover {
  background: var(--mar-fill-row-hover);
}
.session-group-tabs button[aria-selected='true'] {
  background: var(--mar-fill-selection);
  color: var(--mar-text-primary);
}
.group-running :deep(.el-badge__content) {
  background: var(--mar-color-success-bg);
  border-color: var(--mar-color-success-text);
  color: var(--mar-color-success-text);
  font-size: var(--mar-font-size-meta);
  border-radius: var(--mar-radius-marker);
  padding: 0 0.25rem;
}
.group-unread {
  border: 1px solid var(--mar-border-medium);
  border-radius: var(--mar-radius-marker);
  color: var(--mar-text-primary);
  font-size: var(--mar-font-size-meta);
  line-height: 1;
  padding: 1px 3px;
}
</style>

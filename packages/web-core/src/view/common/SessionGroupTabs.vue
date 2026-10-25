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
  <div class="session-group-tabs">
    <div class="group-options" role="tablist" :aria-label="translate('sessionGroups.label')">
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
        <span class="group-label">{{
          translate(group === 'MAIN' ? 'sessionGroups.mainTab' : 'sessionGroups.childTab')
        }}</span>
        <span
          v-if="state[group].running || state[group].unread"
          class="group-markers"
          aria-hidden="true"
        >
          <el-badge
            v-if="state[group].running"
            class="group-running"
            :value="state[group].running"
            :max="99"
            type="primary"
          />
          <span v-if="state[group].unread" class="group-unread mar-unread-label">{{
            translate('sessionGroups.unread')
          }}</span>
        </span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.session-group-tabs {
  display: flex;
  flex-shrink: 0;
  min-width: 0;
  padding-block: 0.25rem;
}
.group-options {
  display: flex;
  flex: 1;
  min-width: 0;
  gap: 2px;
  padding: 2px;
  border-radius: var(--mar-radius-control);
  background: var(--mar-fill-hover);
}
.session-group-tabs button {
  flex: 1 1 0;
  display: inline-flex;
  min-width: 0;
  min-height: var(--mar-compact-control-size);
  align-items: center;
  justify-content: center;
  padding: 0.25rem;
  border: 0;
  border-radius: calc(var(--mar-radius-control) - 2px);
  background: transparent;
  color: var(--mar-text-secondary);
  font-family: inherit;
  font-size: var(--mar-font-size-meta);
  font-weight: 500;
  line-height: 1.4;
  text-align: center;
  white-space: nowrap;
  cursor: pointer;
}
.session-group-tabs button:hover {
  background: var(--mar-fill-row-hover);
  color: var(--mar-text-primary);
}
.session-group-tabs button[aria-selected='true'] {
  background: var(--mar-fill-selection);
  color: var(--mar-text-primary);
}
.session-group-tabs button:focus-visible {
  outline: 2px solid var(--mar-color-brand);
  outline-offset: -2px;
}
.group-markers {
  display: inline-flex;
  flex: none;
  margin-inline-start: 0.125rem;
  align-items: center;
  gap: 2px;
  transform: translateY(-0.25rem);
}
.group-running {
  display: inline-flex;
  flex: none;
}
.group-running :deep(.el-badge__content) {
  min-width: 14px;
  background: var(--mar-color-brand);
  border: 1px solid var(--mar-bg-panel);
  color: var(--mar-color-on-accent);
  font-size: var(--mar-font-size-nano);
  font-weight: 400;
  font-variant-numeric: tabular-nums;
  border-radius: var(--mar-radius-marker);
  height: auto;
  line-height: 1.2;
  padding: 0 0.1875rem;
}
</style>

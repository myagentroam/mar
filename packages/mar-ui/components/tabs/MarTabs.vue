<script setup lang="ts" generic="Name extends TabName">
import { Fragment, isVNode, nextTick, provide, useId, type VNode } from 'vue';
import MarTabPane from './MarTabPane.vue';
import { tabsKey, type TabName } from './tabs-context.js';

const props = defineProps<{ modelValue: Name }>();
const emit = defineEmits<{ 'update:modelValue': [name: Name]; 'tab-change': [name: Name] }>();
const id = useId();
provide(tabsKey, { id, active: () => props.modelValue });

// Read the declared order at render time so conditional panes never change position.
function panes(nodes: VNode[]): { name: Name; label: string }[] {
  return nodes.flatMap((node) => {
    if (node.type === Fragment && Array.isArray(node.children))
      return panes(node.children.filter(isVNode));
    if (node.type !== MarTabPane || !node.props) return [];
    return [{ name: node.props.name as Name, label: String(node.props.label ?? '') }];
  });
}

function activate(name: Name, event: MouseEvent) {
  const button = event.currentTarget as HTMLButtonElement;
  if (name !== props.modelValue) {
    emit('update:modelValue', name);
    emit('tab-change', name);
  }
  void nextTick(() => button.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
}

function navigate(event: KeyboardEvent, index: number, count: number) {
  const target =
    event.key === 'ArrowLeft'
      ? (index + count - 1) % count
      : event.key === 'ArrowRight'
        ? (index + 1) % count
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? count - 1
            : undefined;
  if (target === undefined) return;
  const button = (event.currentTarget as HTMLElement).parentElement?.querySelectorAll('button')[
    target
  ];
  if (!button) return;
  event.preventDefault();
  button.focus({ preventScroll: true });
  button.click();
}
</script>

<template>
  <div class="mar-ui-tabs">
    <div
      v-for="items in [panes($slots.default?.() ?? [])]"
      :key="id"
      class="mar-ui-tabs__header"
      role="tablist"
    >
      <button
        v-for="(pane, index) in items"
        :key="pane.name"
        :id="`${id}-tab-${pane.name}`"
        type="button"
        role="tab"
        :aria-selected="pane.name === modelValue"
        :aria-controls="`${id}-panel-${pane.name}`"
        :tabindex="
          pane.name === modelValue ||
          (index === 0 && !items.some((item) => item.name === modelValue))
            ? 0
            : -1
        "
        @click="activate(pane.name, $event)"
        @keydown="navigate($event, index, items.length)"
      >
        {{ pane.label }}
      </button>
    </div>
    <div class="mar-ui-tabs__content"><slot /></div>
  </div>
</template>

<style scoped>
.mar-ui-tabs {
  min-inline-size: 0;
}
.mar-ui-tabs__header {
  display: flex;
  margin-block-end: 0.875rem;
  overflow-x: auto;
  border-block-end: 1px solid var(--mar-ui-border-subtle);
}
button {
  flex: none;
  min-block-size: 28px;
  padding-inline: var(--mar-ui-compact-option-padding-inline);
  border: 1px solid var(--mar-ui-border-default);
  border-block-end: 0;
  border-radius: var(--mar-ui-radius-control) var(--mar-ui-radius-control) 0 0;
  background: var(--mar-ui-bg-tab-inactive, var(--mar-ui-bg-subtle));
  color: var(--mar-ui-text-secondary);
  font: inherit;
  font-size: var(--mar-ui-font-size-body);
  cursor: pointer;
}
button + button {
  margin-inline-start: -1px;
}
button:hover {
  background: var(--mar-ui-fill-row-hover);
  color: var(--mar-ui-text-primary);
}
button[aria-selected='true'] {
  background: var(--mar-ui-fill-selection);
  color: var(--mar-ui-text-primary);
}
button:focus-visible {
  outline: 2px solid var(--mar-ui-color-brand);
  outline-offset: -2px;
}
</style>

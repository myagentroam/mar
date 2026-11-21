<script setup lang="ts" generic="Name extends TabName">
import { Fragment, isVNode, provide, useId, type VNode } from 'vue';
import MarTabPane from './MarTabPane.vue';
import MarTabsHeader from './MarTabsHeader.vue';
import { tabsKey } from './tabs-context.js';
import type { MarTabsTab, TabName } from './tab-types.js';

type Props = {
  label?: string | undefined;
  itemClass?: string | undefined;
  tabClass?: string | undefined;
  closeClass?: string | undefined;
  appearance?: 'default' | 'workbench';
  size?: 'default' | 'small';
  activationMode?: 'manual' | 'automatic';
} & (
  | { mode?: 'panels'; tabs?: never; modelValue: Name; idPrefix?: never }
  | {
      mode: 'strip';
      tabs: readonly MarTabsTab<Name>[];
      modelValue: Name | undefined;
      idPrefix: string;
    }
);

// Owns the pane declaration and model bindings; the header owns focus and scrolling.
const props = defineProps<Props>();
const emit = defineEmits<{
  'update:modelValue': [name: Name];
  'tab-change': [name: Name];
  'tab-activate': [name: Name];
  'tab-close': [name: Name];
}>();
const id = useId();
provide(tabsKey, { id, active: () => props.modelValue });

// Read the declared order at render time so conditional panes never change position.
function panes(nodes: VNode[]): MarTabsTab<Name>[] {
  return nodes.flatMap((node) => {
    if (node.type === Fragment && Array.isArray(node.children))
      return panes(node.children.filter(isVNode));
    if (node.type !== MarTabPane || !node.props) return [];
    return [
      {
        name: node.props.name as Name,
        label: String(node.props.label ?? ''),
        description: node.props.description
      }
    ];
  });
}

function activate(name: Name): void {
  const changed = name !== props.modelValue;
  emit('tab-activate', name);
  if (changed) {
    emit('update:modelValue', name);
    emit('tab-change', name);
  }
}
</script>

<template>
  <div
    class="mar-ui-tabs"
    :class="{
      'mar-ui-tabs--strip': mode === 'strip',
      'mar-ui-tabs--workbench': appearance === 'workbench'
    }"
  >
    <MarTabsHeader
      :tabs="mode === 'strip' ? tabs : panes($slots.default?.() ?? [])"
      :model-value="modelValue"
      :id-prefix="mode === 'strip' ? idPrefix : id"
      :label="label"
      :item-class="itemClass"
      :tab-class="tabClass"
      :close-class="closeClass"
      :appearance="appearance ?? 'default'"
      :size="size ?? 'default'"
      :activation-mode="activationMode ?? (mode === 'strip' ? 'manual' : 'automatic')"
      :with-panels="mode !== 'strip'"
      @activate="activate"
      @close="emit('tab-close', $event)"
    >
      <template v-if="$slots.label" #label="scope"><slot name="label" v-bind="scope" /></template>
    </MarTabsHeader>
    <div v-if="mode !== 'strip'" class="mar-ui-tabs__content"><slot /></div>
  </div>
</template>

<style scoped>
.mar-ui-tabs {
  min-inline-size: 0;
}
.mar-ui-tabs--strip {
  display: flex;
  flex: 1;
  min-block-size: 0;
}
.mar-ui-tabs--strip > :first-child {
  flex: 1;
  min-inline-size: 0;
}
.mar-ui-tabs--workbench:not(.mar-ui-tabs--strip) {
  display: flex;
  flex: 1;
  min-block-size: 0;
  flex-direction: column;
}
.mar-ui-tabs--workbench > .mar-ui-tabs__content {
  display: contents;
}
</style>

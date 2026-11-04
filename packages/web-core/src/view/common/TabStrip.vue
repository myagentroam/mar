<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import MarIcon from './MarIcon.vue';
import { tabStripIdentity } from '../../util/tab-strip-identity.js';

export interface TabStripItem {
  readonly id: string | number;
  readonly label: string;
  readonly description?: string | undefined;
  readonly closeLabel?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly closeDisabled?: boolean | undefined;
  readonly separatorBefore?: boolean | undefined;
}
const props = defineProps<{
  readonly items: readonly TabStripItem[];
  readonly activeId?: string | number | undefined;
  readonly label: string;
  readonly idPrefix: string;
  readonly itemClass?: string | undefined;
  readonly tabClass?: string | undefined;
  readonly closeClass?: string | undefined;
}>();
const emit = defineEmits<{ activate: [id: string | number]; close: [id: string | number] }>();
const root = ref<HTMLElement>();
const focusedId = ref<string | number | undefined>(props.activeId);
const rovingId = computed(() => {
  const enabled = props.items.filter((item) => !item.disabled);
  return (
    enabled.find((item) => item.id === focusedId.value)?.id ??
    enabled.find((item) => item.id === props.activeId)?.id ??
    enabled[0]?.id
  );
});
let pendingClose: { id: string | number; index: number } | undefined;

function revealTab(tab: HTMLElement | undefined): void {
  tab?.parentElement?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function onKeydown(event: KeyboardEvent): void {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing) return;
  if (!(event.target instanceof HTMLElement) || event.target.getAttribute('role') !== 'tab') return;
  const tabs = Array.from(root.value?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []);
  const current = tabs.indexOf(event.target);
  if (current < 0 || tabs.length !== props.items.length) return;
  const enabled = props.items
    .map((item, index) => (item.disabled ? -1 : index))
    .filter((index) => index >= 0);
  if (enabled.length === 0) return;
  const index = enabled.indexOf(current);
  let target: number | undefined;
  if (event.key === 'ArrowLeft') target = enabled[(index - 1 + enabled.length) % enabled.length];
  else if (event.key === 'ArrowRight') target = enabled[(index + 1) % enabled.length];
  else if (event.key === 'Home') target = enabled[0];
  else if (event.key === 'End') target = enabled.at(-1);
  else return;
  if (target === undefined) return;
  event.preventDefault();
  focusedId.value = props.items[target]!.id;
  tabs[target]?.focus();
  revealTab(tabs[target]);
}

watch(
  () => props.activeId,
  () => {
    if (typeof document === 'undefined' || !root.value?.contains(document.activeElement))
      focusedId.value = props.activeId;
    void nextTick(() => {
      if (typeof HTMLElement === 'undefined' || !(root.value instanceof HTMLElement)) return;
      const selected = root.value?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      revealTab(selected ?? undefined);
    });
  },
  { flush: 'post', immediate: true }
);

function close(id: string | number, event: MouseEvent): void {
  const index = props.items.findIndex((item) => item.id === id);
  const row = (event.currentTarget as HTMLElement).parentElement;
  pendingClose = row?.contains(document.activeElement) ? { id, index } : undefined;
  emit('close', id);
}

watch(
  () => props.items.map((item) => item.id),
  (ids) => {
    const pending = pendingClose;
    if (pending === undefined || ids.includes(pending.id)) return;
    pendingClose = undefined;
    const enabled = props.items.filter((item) => !item.disabled);
    const next =
      enabled.find((item) => item.id === props.activeId) ??
      enabled[Math.min(pending.index, enabled.length - 1)];
    focusedId.value = next?.id;
    if (next === undefined) return;
    void nextTick(() => {
      if (document.activeElement !== document.body && !root.value?.contains(document.activeElement))
        return;
      const index = props.items.findIndex((item) => item.id === next.id);
      const tab = root.value?.querySelectorAll<HTMLElement>('[role="tab"]').item(index);
      tab?.focus();
      revealTab(tab ?? undefined);
    });
  },
  { flush: 'post' }
);
</script>

<template>
  <nav
    ref="root"
    class="tab-strip"
    role="tablist"
    :aria-label="label"
    @keydown="onKeydown"
    @focusout="!root?.contains($event.relatedTarget as Node | null) && (focusedId = activeId)"
  >
    <template v-for="item in items" :key="item.id">
      <span v-if="item.separatorBefore" class="tab-strip-separator" aria-hidden="true" />
      <div class="tab-strip-item" :class="[itemClass, { 'is-active': item.id === activeId }]">
        <button
          v-tooltip="item.description ?? item.label"
          class="tab-strip-tab"
          :class="tabClass"
          type="button"
          role="tab"
          :id="tabStripIdentity(idPrefix, item.id).tab"
          :aria-controls="tabStripIdentity(idPrefix, item.id).panel"
          :aria-description="item.description"
          :aria-selected="item.id === activeId"
          :tabindex="item.id === rovingId ? 0 : -1"
          :disabled="item.disabled"
          @focus="focusedId = item.id"
          @click="
            focusedId = item.id;
            emit('activate', item.id);
          "
        >
          <slot name="label" :item="item"
            ><span>{{ item.label }}</span></slot
          >
        </button>
        <button
          v-if="item.closeLabel"
          v-tooltip="item.closeLabel"
          class="icon-button utility-control tab-strip-close"
          :class="closeClass"
          type="button"
          :disabled="item.closeDisabled"
          :aria-label="item.closeLabel"
          @click.stop="close(item.id, $event)"
        >
          <MarIcon name="close" />
        </button>
      </div>
    </template>
  </nav>
</template>

<style scoped>
.tab-strip {
  display: flex;
  min-width: 0;
  height: 100%;
  flex: 1;
  overflow-x: auto;
  overflow-y: hidden;
  gap: 0;
  padding: 3px 4px 0;
}
.tab-strip-item {
  display: inline-flex;
  flex-shrink: 0;
  min-width: 0;
  max-width: min(15rem, 100%);
  box-sizing: border-box;
  align-items: center;
  border: 1px solid var(--mar-border-strong);
  border-bottom: 0;
  border-radius: var(--mar-radius-selection) var(--mar-radius-selection) 0 0;
  background: var(--mar-bg-subtle);
  color: inherit;
}
.tab-strip-separator {
  align-self: center;
  flex: none;
  width: 1px;
  height: 18px;
  margin: 0 5px;
  background: var(--mar-border-strong);
}
.tab-strip-tab {
  display: inline-flex;
  flex: 1 1 auto;
  min-width: 0;
  height: 100%;
  align-items: center;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: var(--mar-font-size-navigation);
  overflow: hidden;
  cursor: pointer;
  padding: 0 0.5rem;
}
.tab-strip-tab:not(:last-child) {
  padding-inline-end: 0.25rem;
}
.tab-strip-tab > span {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tab-strip-item.is-active {
  background: var(--mar-bg-page);
  color: var(--mar-text-primary);
}
.tab-strip-item:not(.is-active):hover {
  background: var(--mar-fill-row-hover);
  color: var(--mar-text-primary);
}
.tab-strip-close {
  --mar-action-icon-size: 14px;
  display: grid;
  flex: none;
  width: 24px;
  min-width: 24px;
  height: 24px;
  place-items: center;
  border: 0;
  border-radius: 3px;
  cursor: pointer;
  font-size: 13px;
}
.tab-strip-close:focus-visible {
  outline-offset: 1px;
}
@media (max-width: 767px) {
  .tab-strip {
    align-items: center;
    gap: 4px;
    padding: 2px 4px;
  }
  .tab-strip-item {
    height: 36px;
    min-height: 36px;
  }
  .tab-strip-tab > span {
    max-width: 120px;
  }
  .tab-strip-close {
    width: 36px;
    min-width: 36px;
    height: 36px;
  }
}
</style>

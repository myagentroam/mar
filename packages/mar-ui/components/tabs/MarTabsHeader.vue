<script setup lang="ts" generic="Name extends TabName">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import MarIcon from '../../icons/MarIcon.vue';
import { useMarUiLocale } from '../../locale/index.js';
import { marUiTooltipDirectiveKey } from '../tooltip/tooltip-directive.js';
import { tabStripIdentity, type MarTabsTab, type TabName } from './tab-types.js';

// This renderer owns keyboard focus and strip overflow. Selection and close policy are external.
const props = defineProps<{
  tabs: readonly MarTabsTab<Name>[];
  modelValue: Name | undefined;
  label?: string | undefined;
  itemClass?: string | undefined;
  tabClass?: string | undefined;
  closeClass?: string | undefined;
  idPrefix: string;
  appearance: 'default' | 'workbench';
  activationMode: 'manual' | 'automatic';
  withPanels: boolean;
}>();
const emit = defineEmits<{ activate: [name: Name]; close: [name: Name] }>();
const locale = useMarUiLocale();
const vTooltip = inject(marUiTooltipDirectiveKey, {});
const workbench = computed(() => props.appearance === 'workbench');
const root = ref<HTMLElement>();
const container = ref<HTMLElement>();
const hasOverflow = ref(false);
const canScrollPrevious = ref(false);
const canScrollNext = ref(false);
let resizeObserver: ResizeObserver | undefined;
const focusedId = ref<TabName | undefined>(props.modelValue);
const rovingId = computed(() => {
  const enabled = props.tabs.filter((item) => !item.disabled);
  return (
    enabled.find((item) => item.name === focusedId.value)?.name ??
    enabled.find((item) => item.name === props.modelValue)?.name ??
    enabled[0]?.name
  );
});
let pendingClose: { id: Name; index: number } | undefined;

function revealTab(tab: HTMLElement | undefined): void {
  const list = root.value;
  const item = tab?.closest('[data-tab-item]');
  if (list === undefined || item === null || item === undefined) return;
  const bounds = item.getBoundingClientRect();
  const viewport = list.getBoundingClientRect();
  const inset = workbench.value ? 4 : 0;
  if (bounds.left < viewport.left + inset) list.scrollLeft += bounds.left - viewport.left - inset;
  else if (bounds.right > viewport.right - inset)
    list.scrollLeft += bounds.right - viewport.right + inset;
}

function revealCurrentTab(): void {
  const list = root.value;
  if (list === undefined) return;
  const focused = list.contains(document.activeElement)
    ? document.activeElement?.closest('[data-tab-item]')?.querySelector<HTMLElement>('[role="tab"]')
    : undefined;
  revealTab(focused ?? list.querySelector<HTMLElement>('[aria-selected="true"]') ?? undefined);
}

function updateOverflow(): void {
  const list = root.value;
  const host = container.value;
  if (list === undefined || host === undefined) return;
  // Measure against the full host so removing the controls cannot retain false overflow.
  if (!workbench.value) return;
  hasOverflow.value = list.scrollWidth > host.clientWidth + 1;
  canScrollPrevious.value = hasOverflow.value && list.scrollLeft > 1;
  canScrollNext.value =
    hasOverflow.value && list.scrollLeft + list.clientWidth < list.scrollWidth - 1;
}

function observeTabs(): void {
  const list = root.value;
  if (resizeObserver === undefined || list === undefined) return;
  resizeObserver.disconnect();
  resizeObserver.observe(list);
  for (const item of list.querySelectorAll('[data-tab-item]')) resizeObserver.observe(item);
}

function scrollTabs(direction: number): void {
  const list = root.value;
  list?.scrollBy({
    left: direction * list.clientWidth * 0.75,
    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
  });
}

onMounted(() => {
  if (typeof HTMLElement === 'undefined' || !(root.value instanceof HTMLElement)) return;
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => {
      updateOverflow();
      revealCurrentTab();
    });
    observeTabs();
  }
  updateOverflow();
  revealCurrentTab();
});
onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = undefined;
});

function onKeydown(event: KeyboardEvent): void {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing) return;
  if (!(event.target instanceof HTMLElement) || event.target.getAttribute('role') !== 'tab') return;
  const tabs = Array.from(root.value?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []);
  const current = tabs.indexOf(event.target);
  if (current < 0 || tabs.length !== props.tabs.length) return;
  const enabled = props.tabs
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
  focusedId.value = props.tabs[target]!.name;
  tabs[target]?.focus({ preventScroll: true });
  if (props.activationMode === 'automatic') emit('activate', props.tabs[target]!.name);
  revealTab(tabs[target]);
}

watch(
  () => props.modelValue,
  () => {
    if (typeof document === 'undefined' || !root.value?.contains(document.activeElement))
      focusedId.value = props.modelValue;
    void nextTick(() => {
      if (typeof HTMLElement !== 'undefined' && root.value instanceof HTMLElement)
        revealCurrentTab();
    });
  },
  { flush: 'post', immediate: true }
);

function close(id: Name, event: MouseEvent): void {
  const index = props.tabs.findIndex((item) => item.name === id);
  const row = (event.currentTarget as HTMLElement).parentElement;
  pendingClose = row?.contains(document.activeElement) ? { id, index } : undefined;
  emit('close', id);
}

watch(
  () => props.tabs.map((item) => [item.name, item.label, item.separatorBefore, item.closeLabel]),
  () => {
    void nextTick(() => {
      if (resizeObserver === undefined) return;
      observeTabs();
      updateOverflow();
      revealCurrentTab();
    });
    const ids = props.tabs.map((item) => item.name);
    const pending = pendingClose;
    if (pending === undefined || ids.includes(pending.id)) return;
    pendingClose = undefined;
    const enabled = props.tabs.filter((item) => !item.disabled);
    const next =
      enabled.find((item) => item.name === props.modelValue) ??
      props.tabs.slice(pending.index).find((item) => !item.disabled) ??
      enabled.at(-1);
    focusedId.value = next?.name;
    if (next === undefined) return;
    void nextTick(() => {
      if (document.activeElement !== document.body && !root.value?.contains(document.activeElement))
        return;
      const index = props.tabs.findIndex((item) => item.name === next.name);
      const tab = root.value?.querySelectorAll<HTMLElement>('[role="tab"]').item(index);
      tab?.focus({ preventScroll: true });
      revealTab(tab ?? undefined);
    });
  },
  { flush: 'post' }
);

function activate(name: Name): void {
  focusedId.value = name;
  emit('activate', name);
}
</script>

<template>
  <div
    ref="container"
    class="mar-ui-tabs__header"
    :class="{
      'mar-tab': workbench,
      'mar-ui-tabs__header--workbench-panels': workbench && withPanels,
      'can-scroll-previous': canScrollPrevious,
      'can-scroll-next': canScrollNext
    }"
  >
    <button
      v-if="workbench && hasOverflow"
      v-tooltip="locale.tabs.scrollPrevious"
      class="mar-tab-scroll"
      type="button"
      :aria-label="locale.tabs.scrollPrevious"
      :aria-controls="`${idPrefix}-tablist`"
      :disabled="!canScrollPrevious"
      @click="scrollTabs(-1)"
    >
      <MarIcon name="chevron-left" />
    </button>
    <div
      ref="root"
      :id="`${idPrefix}-tablist`"
      :class="workbench ? 'mar-tab-strip' : 'mar-ui-tabs__list'"
      role="tablist"
      :aria-label="label"
      @scroll.passive="updateOverflow"
      @keydown="onKeydown"
      @focusout="!root?.contains($event.relatedTarget as Node | null) && (focusedId = modelValue)"
    >
      <template v-for="tab in tabs" :key="tab.name">
        <span
          v-if="tab.separatorBefore"
          :class="workbench ? 'mar-tab-strip-separator' : 'mar-ui-tabs__separator'"
          aria-hidden="true"
        />
        <div
          data-tab-item
          :class="[
            itemClass,
            workbench && 'mar-tab-strip-item',
            { 'is-active': tab.name === modelValue }
          ]"
        >
          <button
            v-tooltip="workbench ? (tab.description ?? tab.label) : tab.description"
            :class="[tabClass, workbench && 'mar-tab-strip-tab']"
            type="button"
            role="tab"
            :id="tabStripIdentity(idPrefix, tab.name).tab"
            :aria-controls="tabStripIdentity(idPrefix, tab.name).panel"
            :aria-description="tab.description"
            :aria-selected="tab.name === modelValue"
            :tabindex="tab.name === rovingId ? 0 : -1"
            :disabled="tab.disabled"
            @focus="focusedId = tab.name"
            @click="activate(tab.name)"
          >
            <slot name="label" :tab="tab">
              <span v-if="workbench" class="mar-tab-label">{{ tab.label }}</span>
              <template v-else>{{ tab.label }}</template>
            </slot>
          </button>
          <button
            v-if="tab.closeLabel"
            v-tooltip="tab.closeLabel"
            class="mar-tab-close mar-tab-strip-close"
            :class="closeClass"
            type="button"
            :disabled="tab.closeDisabled"
            :aria-label="tab.closeLabel"
            @click.stop="close(tab.name, $event)"
          >
            <MarIcon name="close" />
          </button>
        </div>
      </template>
    </div>
    <button
      v-if="workbench && hasOverflow"
      v-tooltip="locale.tabs.scrollNext"
      class="mar-tab-scroll"
      type="button"
      :aria-label="locale.tabs.scrollNext"
      :aria-controls="`${idPrefix}-tablist`"
      :disabled="!canScrollNext"
      @click="scrollTabs(1)"
    >
      <MarIcon name="chevron-right" />
    </button>
  </div>
</template>

<style scoped>
.mar-ui-tabs__header:not(.mar-tab) {
  margin-block-end: 0.875rem;
  border-block-end: 1px solid var(--mar-ui-border-subtle);
}
.mar-ui-tabs__list {
  display: flex;
  overflow-x: auto;
}
.mar-ui-tabs__list > div {
  flex: none;
}
.mar-ui-tabs__list > div + div {
  margin-inline-start: -1px;
}
.mar-ui-tabs__list [role='tab'] {
  min-block-size: var(--mar-ui-compact-control-size, 24px);
  padding: 0 var(--mar-ui-compact-option-padding-inline);
  border: 1px solid var(--mar-ui-border-default);
  border-block-end: 0;
  border-radius: var(--mar-ui-radius-control) var(--mar-ui-radius-control) 0 0;
  background: var(--mar-ui-bg-tab-inactive, var(--mar-ui-bg-subtle));
  color: var(--mar-ui-text-secondary);
  font: inherit;
  font-size: var(--mar-ui-font-size-meta);
  line-height: 1.35;
  cursor: pointer;
}
.mar-ui-tabs__list [role='tab']:hover:enabled {
  background: var(--mar-ui-fill-row-hover);
  color: var(--mar-ui-text-primary);
}
.mar-ui-tabs__list [role='tab'][aria-selected='true'] {
  background: var(--mar-ui-fill-selection);
  color: var(--mar-ui-text-primary);
}
.mar-ui-tabs__list [role='tab']:focus-visible {
  outline: 2px solid var(--mar-ui-control-focus);
  outline-offset: -2px;
}
.mar-ui-tabs__list .mar-tab-close {
  display: inline-grid;
  vertical-align: middle;
}
.mar-ui-tabs__list .mar-ui-tabs__separator {
  flex: none;
  width: 1px;
  margin-inline: 5px;
  background: var(--mar-ui-border-subtle);
}
.mar-tab {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
}

.mar-ui-tabs__header--workbench-panels {
  flex: none;
  min-height: 32px;
  align-items: stretch;
  border-bottom: 1px solid var(--mar-ui-border-subtle);
}
.mar-tab-scroll {
  --mar-ui-action-icon-size: 14px;
  flex: 0 0 20px;
  width: 20px;
  min-width: 20px;
  height: auto;
  padding: 0;
  border: 0;
  border-radius: var(--mar-ui-radius-control);
  cursor: pointer;
}

.mar-tab-strip {
  display: flex;
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
  gap: 0;
  padding: 3px 4px 0;
  font-weight: var(--mar-tab-font-weight, 500);
}

.mar-tab-strip::-webkit-scrollbar {
  display: none;
}

.mar-tab-strip-item {
  display: inline-flex;
  flex-shrink: 0;
  min-width: 0;
  height: var(--mar-tab-strip-item-height, 28px);
  max-width: min(15rem, 100%);
  box-sizing: border-box;
  align-items: center;
  border: 1px solid var(--mar-ui-border-default);
  border-bottom: 0;
  border-radius: var(--mar-ui-radius-selection) var(--mar-ui-radius-selection) 0 0;
  background: var(--mar-ui-bg-tab-inactive);
  color: var(--mar-ui-text-secondary);
}

.mar-tab-strip-separator {
  align-self: center;
  flex: none;
  width: 1px;
  height: 18px;
  margin: 0 5px;
  background: var(--mar-ui-border-subtle);
}

.mar-tab-strip-tab {
  display: inline-flex;
  flex: 1 1 auto;
  min-width: 0;
  height: 100%;
  align-items: center;
  border: 0;
  border-radius: inherit;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: var(--mar-tab-font-size, var(--mar-ui-font-size-meta));
  overflow: hidden;
  cursor: pointer;
  padding: 0 0.5rem;
  gap: 0.35rem;
  justify-content: center;
}

.mar-tab-strip-tab:not(:last-child) {
  padding-inline-end: 0.25rem;
}

:is(.mar-tab-label, :slotted(.mar-tab-label)) {
  min-width: 0;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mar-tab-strip-item.is-active {
  background: var(--mar-ui-fill-selection);
  color: var(--mar-ui-text-primary);
}

.mar-tab-strip-item:not(.is-active):has(.mar-tab-strip-tab:enabled):hover {
  background: var(--mar-ui-fill-row-hover);
  color: var(--mar-ui-text-primary);
}

.mar-tab-strip-item + .mar-tab-strip-item {
  margin-inline-start: -1px;
}

.mar-tab-strip-tab:focus-visible {
  outline: 2px solid var(--mar-ui-control-focus);
  outline-offset: -2px;
}

.mar-tab-close {
  --mar-ui-action-icon-size: 14px;
  display: grid;
  flex: none;
  width: 24px;
  min-width: 24px;
  height: 24px;
  place-items: center;
  padding: 2px;
  border: 0;
  border-radius: var(--mar-ui-radius-control);
  cursor: pointer;
  font-size: var(--mar-ui-font-size-navigation);
}

.mar-tab-close:focus-visible {
  outline-offset: 1px;
}

.mar-tab-close,
.mar-tab-scroll {
  border: 0;
  background: transparent;
  color: var(--mar-ui-text-secondary);
  text-align: center;
}
.mar-tab-close:disabled,
.mar-tab-scroll:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
.mar-tab-scroll:is(:hover, :active, :focus-visible):enabled {
  background: var(--mar-ui-fill-row-hover);
  color: var(--mar-ui-text-primary);
}
.mar-tab-close:is(:hover, :active, :focus-visible):enabled {
  color: var(--mar-ui-text-primary);
}
.mar-tab-scroll:focus-visible,
.mar-tab-close:focus-visible {
  outline: 2px solid var(--mar-ui-control-focus);
}
.mar-tab-scroll:focus-visible {
  outline-offset: 2px;
}

@media (max-width: 767px) {
  .mar-tab-scroll {
    display: none;
  }
  .mar-tab .mar-tab-strip:not(:focus-within) {
    --mar-tab-fade-start: 0px;
    --mar-tab-fade-end: 100%;
    mask-image: linear-gradient(
      to right,
      transparent,
      #000 var(--mar-tab-fade-start),
      #000 var(--mar-tab-fade-end),
      transparent
    );
  }
  .mar-tab.can-scroll-previous .mar-tab-strip {
    --mar-tab-fade-start: 12px;
  }
  .mar-tab.can-scroll-next .mar-tab-strip {
    --mar-tab-fade-end: calc(100% - 12px);
  }
  .mar-tab-strip-item {
    min-height: var(--mar-tab-strip-item-height, 28px);
  }
  :is(.mar-tab-label, :slotted(.mar-tab-label)) {
    max-width: 120px;
  }
  .mar-tab-strip-close {
    width: var(--mar-tab-strip-close-size, 24px);
    min-width: var(--mar-tab-strip-close-size, 24px);
    height: var(--mar-tab-strip-close-size, 24px);
  }
}
</style>

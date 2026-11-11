<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import MarIcon from './MarIcon.vue';
import { tabStripIdentity } from '../../util/tab-strip-identity.js';
import { translate } from '../../service/locale-preference-service.js';

export interface MarTabItem {
  readonly id: string | number;
  readonly label: string;
  readonly description?: string | undefined;
  readonly closeLabel?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly closeDisabled?: boolean | undefined;
  readonly separatorBefore?: boolean | undefined;
}
const props = defineProps<{
  readonly items: readonly MarTabItem[];
  readonly activeId?: string | number | undefined;
  readonly label: string;
  readonly idPrefix: string;
  readonly size?: 'default' | 'small' | undefined;
  readonly activationMode?: 'manual' | 'automatic' | undefined;
  readonly itemClass?: string | undefined;
  readonly tabClass?: string | undefined;
  readonly closeClass?: string | undefined;
}>();
const emit = defineEmits<{ activate: [id: string | number]; close: [id: string | number] }>();
const root = ref<HTMLElement>();
const container = ref<HTMLElement>();
const hasOverflow = ref(false);
const canScrollPrevious = ref(false);
const canScrollNext = ref(false);
let resizeObserver: ResizeObserver | undefined;
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
  const list = root.value;
  const item = tab?.closest('.tab-strip-item');
  if (list === undefined || item === null || item === undefined) return;
  const bounds = item.getBoundingClientRect();
  const viewport = list.getBoundingClientRect();
  if (bounds.left < viewport.left + 3) list.scrollLeft += bounds.left - viewport.left - 4;
  else if (bounds.right > viewport.right - 3) list.scrollLeft += bounds.right - viewport.right + 4;
}

function revealCurrentTab(): void {
  const list = root.value;
  if (list === undefined) return;
  const focused = list.contains(document.activeElement)
    ? document.activeElement?.closest('.tab-strip-item')?.querySelector<HTMLElement>('[role="tab"]')
    : undefined;
  revealTab(focused ?? list.querySelector<HTMLElement>('[aria-selected="true"]') ?? undefined);
}

function updateOverflow(): void {
  const list = root.value;
  const host = container.value;
  if (list === undefined || host === undefined) return;
  // Measure against the full host so removing the controls cannot retain false overflow.
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
  for (const item of list.querySelectorAll('.tab-strip-item')) resizeObserver.observe(item);
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
  resizeObserver = new ResizeObserver(() => {
    updateOverflow();
    revealCurrentTab();
  });
  observeTabs();
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
  tabs[target]?.focus({ preventScroll: true });
  if (props.activationMode === 'automatic') emit('activate', props.items[target]!.id);
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
  () => props.items.map((item) => [item.id, item.label, item.separatorBefore, item.closeLabel]),
  () => {
    void nextTick(() => {
      if (resizeObserver === undefined) return;
      observeTabs();
      updateOverflow();
      revealCurrentTab();
    });
    const ids = props.items.map((item) => item.id);
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
      tab?.focus({ preventScroll: true });
      revealTab(tab ?? undefined);
    });
  },
  { flush: 'post' }
);
</script>

<template>
  <div
    ref="container"
    class="mar-tab"
    :class="{
      'is-small': size === 'small',
      'can-scroll-previous': canScrollPrevious,
      'can-scroll-next': canScrollNext
    }"
  >
    <button
      v-if="hasOverflow"
      v-tooltip="translate('marTab.scrollPrevious')"
      class="icon-button mar-tab-scroll"
      type="button"
      :aria-label="translate('marTab.scrollPrevious')"
      :aria-controls="`${idPrefix}-tablist`"
      :disabled="!canScrollPrevious"
      @click="scrollTabs(-1)"
    >
      <MarIcon name="chevron-left" />
    </button>
    <nav
      ref="root"
      class="tab-strip"
      :id="`${idPrefix}-tablist`"
      :class="{ 'is-small': size === 'small' }"
      role="tablist"
      :aria-label="label"
      @scroll.passive="updateOverflow"
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
            class="icon-button utility-control mar-tab-close tab-strip-close"
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
    <button
      v-if="hasOverflow"
      v-tooltip="translate('marTab.scrollNext')"
      class="icon-button mar-tab-scroll"
      type="button"
      :aria-label="translate('marTab.scrollNext')"
      :aria-controls="`${idPrefix}-tablist`"
      :disabled="!canScrollNext"
      @click="scrollTabs(1)"
    >
      <MarIcon name="chevron-right" />
    </button>
  </div>
</template>

<style scoped>
.mar-tab {
  display: flex;
  flex: 1;
  min-width: 0;
  height: 100%;
}
.mar-tab.is-small {
  height: auto;
}
.mar-tab-scroll {
  --mar-action-icon-size: 14px;
  flex: 0 0 20px;
  width: 20px;
  min-width: 20px;
  height: auto;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--mar-text-secondary);
}
.tab-strip {
  display: flex;
  min-width: 0;
  height: 100%;
  flex: 1;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
  gap: 0;
  padding: 3px 4px 0;
}
.tab-strip::-webkit-scrollbar {
  display: none;
}
.tab-strip.is-small {
  --mar-tab-strip-item-height: 28px;
  --mar-tab-strip-close-size: 24px;
  --mar-tab-font-size: var(--mar-font-size-meta);
  height: auto;
  padding-block: 3px 0;
  font-weight: 500;
}
.tab-strip-item {
  display: inline-flex;
  flex-shrink: 0;
  min-width: 0;
  height: var(--mar-tab-strip-item-height, auto);
  max-width: min(15rem, 100%);
  box-sizing: border-box;
  align-items: center;
  border: 1px solid var(--mar-border-strong);
  border-bottom: 0;
  border-radius: var(--mar-radius-selection) var(--mar-radius-selection) 0 0;
  background: var(--mar-bg-subtle);
  color: var(--mar-text-secondary);
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
  font-size: var(--mar-tab-font-size, var(--mar-font-size-navigation));
  overflow: hidden;
  cursor: pointer;
  padding: 0 0.5rem;
}
.tab-strip.is-small .tab-strip-tab {
  gap: 0.35rem;
  justify-content: center;
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
  background: var(--mar-tab-strip-active-bg, var(--mar-bg-page));
  color: var(--mar-text-primary);
}
.tab-strip-item:not(.is-active):hover {
  background: var(--mar-fill-row-hover);
  color: var(--mar-text-primary);
}
@media (min-width: 768px) {
  .tab-strip-item + .tab-strip-item {
    margin-inline-start: -1px;
  }
}
@media (max-width: 767px) {
  .mar-tab-scroll {
    display: none;
  }
  .mar-tab .tab-strip:not(:focus-within) {
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
  .mar-tab.can-scroll-previous .tab-strip {
    --mar-tab-fade-start: 12px;
  }
  .mar-tab.can-scroll-next .tab-strip {
    --mar-tab-fade-end: calc(100% - 12px);
  }
  .tab-strip {
    align-items: center;
    gap: 4px;
    padding: 2px 4px;
  }
  .tab-strip-item {
    height: var(--mar-tab-strip-item-height, 36px);
    min-height: var(--mar-tab-strip-item-height, 36px);
  }
  .tab-strip-tab > span {
    max-width: 120px;
  }
  .tab-strip-close {
    width: var(--mar-tab-strip-close-size, 36px);
    min-width: var(--mar-tab-strip-close-size, 36px);
    height: var(--mar-tab-strip-close-size, 36px);
  }
}
</style>

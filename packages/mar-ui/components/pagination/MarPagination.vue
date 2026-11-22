<script setup lang="ts">
import { computed, onBeforeUpdate, onUpdated, useTemplateRef, watch, type Component } from 'vue';
import type { MarIconName } from '../../icons/icon-shapes.js';
import { useMarUiLocale } from '../../locale/index.js';
import MarButton from '../button/MarButton.vue';

/** Presents a controlled page number. Data fetching and confirmed page state belong to the caller. */
const props = withDefaults(
  defineProps<{
    currentPage?: number;
    pageSize?: number;
    total?: number;
    pagerCount?: number;
    layout?: string;
    background?: boolean;
    disabled?: boolean;
    prevIcon?: MarIconName | Component;
    nextIcon?: MarIconName | Component;
  }>(),
  {
    currentPage: 1,
    pageSize: 10,
    total: 0,
    pagerCount: 7,
    layout: 'prev, pager, next',
    prevIcon: 'chevron-left',
    nextIcon: 'chevron-right'
  }
);
const emit = defineEmits<{
  'update:currentPage': [page: number];
  'current-change': [page: number];
}>();

type Pager = number | 'back' | 'forward';
const locale = useMarUiLocale();
const navigation = useTemplateRef<HTMLElement>('navigation');
let previousFocus: Element | undefined;
const sections = computed(() => props.layout.split(',').map((part) => part.trim()));
const pageCount = computed(() => Math.max(1, Math.ceil(props.total / Math.max(1, props.pageSize))));
const page = computed(() => clamp(props.currentPage));
const pagerCount = computed(() => {
  const count = Math.min(21, Math.max(5, Math.floor(props.pagerCount)));
  return count % 2 ? count : count - 1;
});
const jump = computed(() => pagerCount.value - 2);
const pagers = computed<Pager[]>(() => {
  const last = pageCount.value;
  const count = pagerCount.value;
  if (last <= count) return range(1, last);

  const half = (count - 1) / 2;
  if (page.value <= half + 1) return [...range(1, count - 1), 'forward', last];
  if (page.value >= last - half) return [1, 'back', ...range(last - count + 2, last)];
  return [1, 'back', ...range(page.value - half + 1, page.value + half - 1), 'forward', last];
});

function range(first: number, last: number): number[] {
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}

function clamp(value: number): number {
  return Math.max(1, Math.min(value, pageCount.value));
}

function emitPage(value: number): void {
  emit('update:currentPage', value);
  emit('current-change', value);
}

function request(value: number): void {
  const next = clamp(value);
  if (!props.disabled && next !== page.value) emitPage(next);
}

onBeforeUpdate(() => {
  const root = navigation.value;
  const active = root?.ownerDocument?.activeElement;
  previousFocus = active && root?.contains(active) ? active : undefined;
});
onUpdated(() => {
  const focused = previousFocus;
  previousFocus = undefined;
  const root = navigation.value;
  if (!root || !focused || (root.contains(focused) && !focused.matches(':disabled'))) return;
  const doc = root.ownerDocument;
  // Do not steal focus if the user moved on while the page request was in flight.
  if (doc.activeElement && doc.activeElement !== doc.body && doc.activeElement !== focused) return;
  root.querySelector<HTMLElement>('[aria-current="page"]')?.focus({ preventScroll: true });
});

// Match EL's range correction without re-emitting a page the owner already confirmed.
watch(pageCount, (count) => {
  if (props.currentPage > count) emitPage(count);
});

function caption(template: string, value: number): string {
  return template.replace('{value}', String(value));
}
</script>

<template>
  <nav
    ref="navigation"
    class="mar-ui-pagination"
    :class="{ 'is-background': background }"
    :aria-label="locale.pagination.label"
  >
    <div class="mar-ui-pagination__controls">
      <template v-for="section in sections" :key="section">
        <span v-if="section === 'total'" class="mar-ui-pagination__total">
          {{ caption(locale.pagination.total, total) }}
        </span>
        <MarButton
          v-else-if="section === 'prev' || section === 'next'"
          class="mar-ui-pagination__button"
          :class="section === 'prev' ? 'mar-ui-pagination__previous' : 'mar-ui-pagination__next'"
          :text="!background"
          :icon="section === 'prev' ? prevIcon : nextIcon"
          :aria-label="section === 'prev' ? locale.pagination.previous : locale.pagination.next"
          :disabled="section === 'prev' ? page === 1 : page === pageCount"
          :aria-disabled="disabled || undefined"
          :tabindex="disabled ? -1 : undefined"
          @click="request(page + (section === 'prev' ? -1 : 1))"
        />
        <ul v-else-if="section === 'pager'" class="mar-ui-pagination__pages">
          <li v-for="item in pagers" :key="item">
            <MarButton
              v-if="typeof item === 'number'"
              class="mar-ui-pagination__button mar-ui-pagination__page"
              :text="!background"
              :type="item === page ? 'primary' : 'default'"
              :aria-current="item === page ? 'page' : undefined"
              :aria-disabled="disabled || undefined"
              :tabindex="disabled ? -1 : undefined"
              :aria-label="caption(locale.pagination.page, item)"
              @click="request(item)"
              >{{ item }}</MarButton
            >
            <MarButton
              v-else
              class="mar-ui-pagination__button mar-ui-pagination__jump"
              :text="!background"
              :aria-disabled="disabled || undefined"
              :tabindex="disabled ? -1 : undefined"
              :aria-label="
                caption(item === 'back' ? locale.pagination.back : locale.pagination.forward, jump)
              "
              :icon="item === 'back' ? 'chevrons-left' : 'chevrons-right'"
              @click="request(page + (item === 'back' ? -jump : jump))"
              ><span aria-hidden="true">…</span></MarButton
            >
          </li>
        </ul>
      </template>
    </div>
  </nav>
</template>

<style scoped>
.mar-ui-pagination {
  max-inline-size: 100%;
  min-inline-size: 0;
}
.mar-ui-pagination__controls,
.mar-ui-pagination__pages {
  display: flex;
  align-items: center;
  gap: 4px;
}
.mar-ui-pagination__controls {
  flex-wrap: wrap;
}
.mar-ui-pagination__pages {
  flex-wrap: wrap;
  list-style: none;
  margin: 0;
  padding: 0;
}
.mar-ui-pagination__total {
  margin-inline-end: 4px;
  color: var(--mar-ui-text-secondary);
  font-size: var(--mar-ui-font-size-meta);
}
.mar-ui-pagination__button {
  min-inline-size: var(--mar-ui-compact-control-size, 24px);
  min-block-size: var(--mar-ui-compact-control-size, 24px);
  padding-inline: 4px;
  font-variant-numeric: tabular-nums;
}
.mar-ui-pagination__button[aria-disabled='true']:not([aria-current]) {
  --mar-ui-button-fg: var(--mar-ui-text-disabled);
  --mar-ui-button-hover-fg: var(--mar-ui-text-disabled);
  --mar-ui-button-hover-bg: var(--mar-ui-button-bg);
  --mar-ui-button-hover-border: var(--mar-ui-button-border);
  cursor: not-allowed;
}
.mar-ui-pagination__jump:not(:hover, :focus-visible) :deep(.mar-ui-button__icon),
.mar-ui-pagination__jump:is(:hover, :focus-visible) :deep(.mar-ui-button__label) {
  display: none;
}
</style>

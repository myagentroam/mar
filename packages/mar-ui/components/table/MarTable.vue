<script setup lang="ts">
import {
  computed,
  h,
  onMounted,
  onUnmounted,
  onUpdated,
  shallowRef,
  useAttrs,
  useId,
  watch,
  type FunctionalComponent,
  type VNode
} from 'vue';
import { MarIcon } from '../../icons/index.js';
import { useMarUiLocale } from '../../locale/index.js';
import '../popup/surface.css';
import {
  field,
  readColumns,
  sortRows,
  type TableCellScope,
  type TableColumn,
  type TableKey,
  type TableOrder,
  type TableRow,
  type TableSortChange
} from './table-columns.js';
import { useTableOverflowHint } from './use-table-overflow-hint.js';

/** Owns column layout and row presentation, not the caller's data, queries or row actions. */
defineOptions({ inheritAttrs: false });
const props = withDefaults(
  defineProps<{
    data?: readonly TableRow[];
    rowKey?: string | ((row: TableRow) => TableKey);
    emptyText?: string;
    tableLayout?: 'fixed' | 'auto';
    maxHeight?: number | string;
    expandRowKeys?: readonly TableKey[];
    defaultExpandAll?: boolean;
    treeProps?: { children?: string };
  }>(),
  { data: () => [], tableLayout: 'fixed' }
);
const slots = defineSlots<{ default?(): VNode[]; empty?(): VNode[]; loading?(): VNode[] }>();
const emit = defineEmits<{
  'row-click': [row: TableRow, column: TableColumn | undefined, event: MouseEvent];
  'sort-change': [event: TableSortChange];
  'expand-change': [row: TableRow, expanded: TableRow[] | boolean];
}>();

const attrs = useAttrs();
const locale = useMarUiLocale();
const tableId = useId();
const viewport = shallowRef<HTMLElement>();
const viewportWidth = shallowRef(0);
const overflows = shallowRef(false);
const hint = useTableOverflowHint();
const { surface, text: hintText } = hint;
let resize: ResizeObserver | undefined;
const sort = shallowRef<{ key: string; order: Exclude<TableOrder, null> }>();
const overrides = shallowRef<ReadonlyMap<TableKey, boolean>>(new Map());

// A replacement tree reapplies default expansion so filtering cannot hide matching descendants.
watch(
  () => props.data,
  () => {
    if (props.treeProps && props.defaultExpandAll && overrides.value.size) {
      overrides.value = new Map();
    }
  }
);

const height = computed(() => {
  const value = props.maxHeight;
  return typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))
    ? `${value}px`
    : value;
});
const expandedKeys = computed(() =>
  props.expandRowKeys === undefined ? undefined : new Set(props.expandRowKeys.map(String))
);
const objectKeys = new WeakMap<object, number>();
let nextKey = 0;

function rowKey(row: TableRow, index: number): TableKey {
  if (typeof props.rowKey === 'function') return props.rowKey(row);
  const key = field(row, props.rowKey);
  if (typeof key === 'string' || typeof key === 'number' || typeof key === 'symbol') return key;
  if (row !== null && typeof row === 'object') {
    let id = objectKeys.get(row);
    if (id === undefined) objectKeys.set(row, (id = ++nextKey));
    return id;
  }
  return index;
}

function isExpanded(key: TableKey): boolean {
  return expandedKeys.value?.has(String(key)) ?? overrides.value.get(key) ?? props.defaultExpandAll;
}

interface RowEntry {
  row: TableRow;
  key: TableKey;
  index: number;
  depth: number;
  hasChildren: boolean;
}

function flatten(rows: readonly TableRow[]): RowEntry[] {
  const entries: RowEntry[] = [];
  function visit(values: readonly TableRow[], depth: number): void {
    values.forEach((row) => {
      const index = entries.length;
      const key = rowKey(row, index);
      const children = props.treeProps
        ? field(row, props.treeProps.children ?? 'children')
        : undefined;
      const hasChildren = Array.isArray(children) && children.length > 0;
      entries.push({ row, key, index, depth, hasChildren });
      if (hasChildren && isExpanded(key)) visit(children, depth + 1);
    });
  }
  visit(rows, 0);
  return entries;
}

function toggle(entry: RowEntry, rows: readonly RowEntry[], details: boolean): void {
  const expanded = !isExpanded(entry.key);
  const previous = overrides.value;
  if (expandedKeys.value === undefined) {
    const next = new Map(previous);
    next.delete(entry.key);
    next.set(entry.key, expanded);
    overrides.value = next;
  }
  if (!details) {
    emit('expand-change', entry.row, expanded);
    return;
  }

  // Expanded rows follow expansion order, not the order in which the table is rendered.
  const controlled = expandedKeys.value !== undefined;
  const keyOf = (key: TableKey) => (controlled ? String(key) : key);
  const openKeys = new Set<TableKey>(
    controlled
      ? expandedKeys.value
      : [
          ...(props.defaultExpandAll
            ? rows.filter(({ key }) => !previous.has(key)).map(({ key }) => key)
            : []),
          ...[...previous].filter(([, open]) => open).map(([key]) => key)
        ]
  );
  if (expanded) openKeys.add(keyOf(entry.key));
  else openKeys.delete(keyOf(entry.key));
  const byKey = new Map(rows.map((row) => [keyOf(row.key), row]));
  emit(
    'expand-change',
    entry.row,
    [...openKeys].flatMap((key) => {
      const item = byKey.get(key);
      return item ? [item.row] : [];
    })
  );
}

function changeSort(column: TableColumn, requested?: Exclude<TableOrder, null>): void {
  const current = sort.value?.key === column.key ? sort.value.order : null;
  const order = requested
    ? requested === current
      ? null
      : requested
    : current === 'ascending'
      ? 'descending'
      : current === 'descending'
        ? null
        : 'ascending';
  sort.value = order ? { key: column.key, order } : undefined;
  emit('sort-change', { column, prop: column.prop ?? '', order });
}

function measure(): void {
  if (!viewport.value || typeof viewport.value.clientWidth !== 'number') return;
  viewportWidth.value = viewport.value.clientWidth;
  overflows.value =
    viewport.value.scrollWidth > viewportWidth.value + 1 ||
    viewport.value.scrollHeight > viewport.value.clientHeight + 1;
  hint.refresh();
}
onMounted(() => {
  measure();
  if (typeof ResizeObserver !== 'undefined' && viewport.value) {
    resize = new ResizeObserver(measure);
    resize.observe(viewport.value);
    const grid = viewport.value.firstElementChild;
    if (grid) resize.observe(grid);
  }
});
onUpdated(measure);
onUnmounted(() => resize?.disconnect());

function disclosure(
  entry: RowEntry,
  rows: readonly RowEntry[],
  details: boolean,
  controls?: string
): VNode {
  const expanded = isExpanded(entry.key);
  return h(
    'button',
    {
      type: 'button',
      class: 'mar-ui-table__disclosure',
      'aria-label': expanded ? locale.value.table.collapse : locale.value.table.expand,
      'aria-expanded': expanded,
      'aria-controls': expanded ? controls : undefined,
      onClick: (event: MouseEvent) => {
        event.stopPropagation();
        toggle(entry, rows, details);
      }
    },
    [h(MarIcon, { name: expanded ? 'chevron-down' : 'chevron-right' })]
  );
}

function clicked(entry: RowEntry, column: TableColumn, event: MouseEvent): void {
  if (
    event.defaultPrevented ||
    !(event.target instanceof Element) ||
    !(event.currentTarget instanceof HTMLElement)
  )
    return;
  const selection = event.currentTarget.ownerDocument.getSelection();
  if (selection && !selection.isCollapsed && selection.containsNode(event.currentTarget, true))
    return;
  if (event.target.closest('a, button, input, select, textarea, [role="button"], [role="link"]'))
    return;
  emit('row-click', entry.row, column, event);
}

function cell(
  scope: TableCellScope,
  entry: RowEntry,
  rows: readonly RowEntry[],
  index: number,
  detailId: string
): VNode {
  const { column } = scope;
  const contents =
    column.type === 'expand'
      ? [disclosure(entry, rows, true, detailId)]
      : (column.defaultSlot?.(scope) ?? String(field(entry.row, column.prop) ?? ''));
  const tree = index === 0 && props.treeProps;
  const indent =
    tree && (entry.depth > 0 || entry.hasChildren)
      ? h(
          'span',
          { class: 'mar-ui-table__indent', style: { paddingInlineStart: `${entry.depth * 16}px` } },
          [
            entry.hasChildren
              ? disclosure(entry, rows, false)
              : h('span', { class: 'mar-ui-table__tree-placeholder' })
          ]
        )
      : null;
  return h(
    'td',
    {
      key: column.key,
      class: ['mar-ui-table__cell', column.className],
      onClick: (event: MouseEvent) => clicked(entry, column, event)
    },
    [
      h('div', { class: 'mar-ui-table__cell-inner' }, [
        indent,
        h(
          'div',
          {
            class: ['mar-ui-table__value', column.showOverflowTooltip && 'is-clipped'],
            'data-mar-table-overflow': column.showOverflowTooltip ? '' : undefined
          },
          contents
        )
      ])
    ]
  );
}

function header(column: TableColumn, index: number): VNode {
  const label = column.headerSlot?.({ column, $index: index }) ?? column.label ?? '';
  const order = sort.value?.key === column.key ? sort.value.order : undefined;
  return h(
    'th',
    {
      key: column.key,
      scope: 'col',
      'aria-sort': order,
      class: ['mar-ui-table__cell', column.className],
      onClick: column.sortable ? () => changeSort(column) : undefined
    },
    [
      h(
        'div',
        { class: 'mar-ui-table__cell-inner' },
        column.sortable
          ? [
              h('button', { type: 'button', class: 'mar-ui-table__sort' }, [
                h('span', {}, label),
                h('span', { class: 'mar-ui-table__sort-indicators', 'aria-hidden': 'true' }, [
                  ...(['ascending', 'descending'] as const).map((direction) =>
                    h('span', {
                      'data-sort-order': direction,
                      onClick: (event: MouseEvent) => {
                        event.stopPropagation();
                        changeSort(column, direction);
                      }
                    })
                  )
                ])
              ])
            ]
          : label
      )
    ]
  );
}

// Forward conditional slots explicitly: slot presence is not reactive in the child render.
const ColumnView: FunctionalComponent<{
  loading: typeof slots.loading;
  empty: typeof slots.empty;
}> = ({ loading, empty }) => {
  const columns = readColumns(slots.default?.() ?? []);
  const limit = columns.reduce((sum, col) => sum + col.baseWidth, 0);
  const flex = columns.reduce((sum, col) => sum + (col.flexible ? col.baseWidth : 0), 0);
  const extra = Math.max(0, viewportWidth.value - limit);
  const expand = columns.find((column) => column.type === 'expand');
  const currentSort = columns.find((column) => column.key === sort.value?.key);
  const rows = flatten(sortRows(props.data, currentSort, sort.value?.order ?? null));
  const rowNodes: VNode[] = [];
  if (loading || rows.length === 0) {
    const statusContent = loading?.() ?? empty?.();
    rowNodes.push(
      h('tr', { class: loading ? 'mar-ui-table__loading' : 'mar-ui-table__empty' }, [
        h('td', { colspan: Math.max(1, columns.length) }, [
          h(
            'div',
            {
              class: {
                'mar-ui-table__empty-content': true,
                'mar-ui-table__empty-content--text': statusContent === undefined
              },
              style: { inlineSize: viewportWidth.value > 0 ? `${viewportWidth.value}px` : '100%' }
            },
            statusContent ?? props.emptyText ?? locale.value.noData
          )
        ])
      ])
    );
  }
  for (const entry of rows) {
    const detailId = `${tableId}-detail-${entry.index}`;
    rowNodes.push(
      h(
        'tr',
        { key: entry.key, class: 'mar-ui-table__row' },
        columns.map((column, index) =>
          cell({ column, row: entry.row, $index: entry.index }, entry, rows, index, detailId)
        )
      )
    );
    if (expand && isExpanded(entry.key)) {
      rowNodes.push(
        h(
          'tr',
          {
            key: `${tableId}-detail-${String(entry.key)}`,
            id: detailId,
            class: 'mar-ui-table__detail'
          },
          [
            h(
              'td',
              { colspan: columns.length },
              expand.defaultSlot?.({ row: entry.row, column: expand, $index: entry.index })
            )
          ]
        )
      );
    }
  }
  return h(
    'table',
    {
      class: 'mar-ui-table__grid',
      'aria-label': attrs['aria-label'],
      'aria-labelledby': attrs['aria-labelledby'],
      onVnodeUpdated: hint.refresh,
      style: { tableLayout: props.tableLayout, minInlineSize: `${limit}px` }
    },
    [
      h(
        'colgroup',
        {},
        columns.map((column) =>
          h('col', {
            key: column.key,
            style: {
              width: `${column.baseWidth + (column.flexible && flex > 0 ? (extra * column.baseWidth) / flex : 0)}px`
            }
          })
        )
      ),
      h('thead', {}, [h('tr', {}, columns.map(header))]),
      h('tbody', {}, rowNodes)
    ]
  );
};
ColumnView.props = ['loading', 'empty'];
</script>

<template>
  <div class="mar-ui-table" v-bind="$attrs">
    <div
      ref="viewport"
      class="mar-ui-table__viewport"
      :class="{ 'is-height-limited': height !== undefined }"
      :style="{ maxBlockSize: height }"
      :tabindex="overflows ? 0 : undefined"
      :role="
        overflows && ($attrs['aria-label'] || $attrs['aria-labelledby']) ? 'region' : undefined
      "
      :aria-label="overflows ? ($attrs['aria-label'] as string | undefined) : undefined"
      :aria-labelledby="overflows ? ($attrs['aria-labelledby'] as string | undefined) : undefined"
      @pointerover="hint.onPointerOver"
      @pointerout="hint.onPointerOut"
      @pointerdown="hint.reset"
      @focusin="hint.onFocusIn"
      @focusout="hint.onFocusOut"
      @scroll="hint.reset"
    >
      <ColumnView :loading="slots.loading" :empty="slots.empty" />
    </div>
    <div
      :id="hint.id"
      ref="surface"
      class="mar-ui-popup mar-ui-table__hint"
      popover="manual"
      role="tooltip"
      @pointerenter="hint.onSurfaceEnter"
      @pointerleave="hint.onSurfaceLeave"
    >
      <div class="mar-ui-popup__content">{{ hintText }}</div>
    </div>
  </div>
</template>

<style scoped>
.mar-ui-table {
  position: relative;
  box-sizing: border-box;
  min-inline-size: 0;
  inline-size: 100%;
  background: var(--mar-ui-table-bg);
  color: var(--mar-ui-text-primary);
  font-size: calc(var(--mar-ui-font-size-body) - 1px);
}
.mar-ui-table__viewport {
  overflow: auto;
}
.mar-ui-table__viewport:focus-visible {
  outline: 2px solid var(--mar-ui-control-focus);
  outline-offset: -2px;
}
.mar-ui-table__viewport :deep(.mar-ui-table__grid) {
  border-collapse: separate;
  border-spacing: 0;
  inline-size: 100%;
}
.mar-ui-table__viewport :deep(th) {
  background: var(--mar-ui-table-header-bg);
  color: var(--mar-ui-text-secondary);
  font-size: var(--mar-ui-font-size-meta);
  font-weight: 500;
  text-align: start;
}
.is-height-limited :deep(th) {
  position: sticky;
  inset-block-start: 0;
  z-index: 1;
}
.mar-ui-table__viewport :deep(.mar-ui-table__cell) {
  box-sizing: border-box;
  padding: 3px 10px;
  border-block-end: 1px solid var(--mar-ui-border-subtle);
  vertical-align: middle;
}
.mar-ui-table__viewport :deep(th.mar-ui-table__cell) {
  overflow-wrap: anywhere;
  padding-block: 2px;
}
.mar-ui-table__viewport :deep(.mar-ui-table__cell-inner) {
  display: flex;
  align-items: center;
  min-inline-size: 0;
  min-block-size: var(--mar-ui-compact-control-size, 24px);
  line-height: 1.45;
}
.mar-ui-table__viewport :deep(.mar-ui-table__value) {
  min-inline-size: 0;
  flex: 1 1 auto;
  overflow-wrap: anywhere;
}
.mar-ui-table__viewport :deep(.mar-ui-table__value.is-clipped) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mar-ui-table__viewport :deep(.mar-ui-table__detail > td) {
  padding: 12px 16px;
  border-block-end: 1px solid var(--mar-ui-border-subtle);
}
.mar-ui-table__viewport :deep(.mar-ui-table__empty > td),
.mar-ui-table__viewport :deep(.mar-ui-table__loading > td) {
  block-size: calc(2 * var(--mar-ui-compact-control-size, 24px));
  padding: 0;
  text-align: center;
  color: var(--mar-ui-text-secondary);
  border-block-end: 1px solid var(--mar-ui-border-subtle);
}
.mar-ui-table__viewport :deep(.mar-ui-table__empty-content) {
  position: sticky;
  inset-inline-start: 0;
  box-sizing: border-box;
  max-inline-size: 100%;
  padding-inline: 12px;
  overflow-wrap: anywhere;
}
.mar-ui-table__viewport :deep(.mar-ui-table__empty-content--text) {
  font-size: var(--mar-ui-font-size-meta);
}
@media (hover: hover) {
  .mar-ui-table__viewport :deep(.mar-ui-table__row:hover > td) {
    background: var(--mar-ui-table-row-hover-bg);
  }
}
.mar-ui-table__viewport :deep(.mar-ui-table__sort),
.mar-ui-table__viewport :deep(.mar-ui-table__disclosure) {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0;
  border: 0;
  border-radius: var(--mar-ui-radius-control);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: start;
  cursor: pointer;
}
.mar-ui-table__viewport :deep(.mar-ui-table__sort) {
  min-block-size: var(--mar-ui-compact-control-size, 24px);
}
.mar-ui-table__viewport :deep(.mar-ui-table__sort:focus-visible),
.mar-ui-table__viewport :deep(.mar-ui-table__disclosure:focus-visible) {
  outline: 2px solid var(--mar-ui-control-focus);
  outline-offset: -2px;
}
.mar-ui-table__viewport :deep(.mar-ui-table__sort-indicators) {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  color: var(--mar-ui-text-muted);
}
.mar-ui-table__viewport :deep(.mar-ui-table__sort-indicators > span) {
  display: grid;
  place-items: center;
  inline-size: 10px;
  block-size: 8px;
}
.mar-ui-table__viewport :deep(.mar-ui-table__sort-indicators > span::before) {
  content: '';
  border-inline: 5px solid transparent;
}
.mar-ui-table__viewport
  :deep(.mar-ui-table__sort-indicators > [data-sort-order='ascending']::before) {
  border-block-end: 5px solid currentColor;
}
.mar-ui-table__viewport
  :deep(.mar-ui-table__sort-indicators > [data-sort-order='descending']::before) {
  border-block-start: 5px solid currentColor;
}
.mar-ui-table__viewport :deep(th[aria-sort='ascending'] [data-sort-order='ascending']),
.mar-ui-table__viewport :deep(th[aria-sort='descending'] [data-sort-order='descending']) {
  color: var(--mar-ui-text-primary);
}
@media (forced-colors: active) {
  .mar-ui-table__viewport :deep(th[aria-sort='ascending'] [data-sort-order='ascending']),
  .mar-ui-table__viewport :deep(th[aria-sort='descending'] [data-sort-order='descending']) {
    outline: 1px solid ButtonText;
  }
}
.mar-ui-table__viewport :deep(.mar-ui-table__indent) {
  display: inline-flex;
  flex: none;
}
.mar-ui-table__viewport :deep(.mar-ui-table__disclosure),
.mar-ui-table__viewport :deep(.mar-ui-table__tree-placeholder) {
  justify-content: center;
  inline-size: 24px;
  block-size: 24px;
}
.mar-ui-table__viewport :deep(.mar-ui-table__disclosure svg) {
  inline-size: 14px;
  block-size: 14px;
}
.mar-ui-table__hint {
  --mar-ui-overlay-border: var(--mar-ui-tooltip-border);
  --mar-ui-overlay-surface: var(--mar-ui-tooltip-surface);
  --mar-ui-overlay-shadow: var(--mar-ui-tooltip-shadow);
  --mar-ui-popup-padding: 6px 10px;
  max-inline-size: min(28rem, var(--mar-ui-popup-max-width, 100vw));
  font-size: var(--mar-ui-font-size-meta);
  line-height: 1.5;
  white-space: pre-line;
  overflow-wrap: anywhere;
  user-select: text;
}
</style>

import { Fragment, isVNode, type Slot, type VNode } from 'vue';

// Column slots are declared independently of the table data, matching EL's untyped slot scope.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TableRow = any;
export type TableOrder = 'ascending' | 'descending' | null;
export type TableKey = PropertyKey;

export interface TableColumnProps {
  readonly prop?: string;
  readonly label?: string;
  readonly type?: 'expand';
  readonly width?: number | string | undefined;
  readonly minWidth?: number | string | undefined;
  readonly sortable?: boolean | 'custom';
  readonly sortMethod?: (a: TableRow, b: TableRow) => number;
  readonly className?: string;
  readonly showOverflowTooltip?: boolean;
}

export interface TableColumn extends TableColumnProps {
  readonly key: string;
  readonly property?: string;
  readonly baseWidth: number;
  readonly flexible: boolean;
  readonly defaultSlot?: Slot;
  readonly headerSlot?: Slot;
}

export interface TableCellScope {
  readonly row: TableRow;
  readonly column: TableColumn;
  readonly $index: number;
}

export interface TableSortChange {
  readonly column: TableColumn;
  readonly prop: string;
  readonly order: TableOrder;
}

function pixels(width: number | string | undefined): number | undefined {
  if (width === undefined || width === '') return undefined;
  const value = Number.parseInt(String(width), 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Resolves slot fragments each render so conditional, repeated and extension columns keep order. */
export function readColumns(children: readonly unknown[]): TableColumn[] {
  const columns: TableColumn[] = [];
  function visit(nodes: readonly unknown[], prefix: string): void {
    nodes.forEach((node, index) => {
      if (!isVNode(node)) return;
      const key = `${prefix}/${node.key === null ? `i:${index}` : `k:${String(node.key)}`}`;
      if (node.type === Fragment && Array.isArray(node.children)) {
        visit(node.children, key);
      } else if (
        typeof node.type === 'object' &&
        'name' in node.type &&
        node.type.name === 'MarTableColumn'
      ) {
        columns.push(readColumn(node, key));
      }
    });
  }
  visit(children, '');
  return columns;
}

function readColumn(node: VNode, key: string): TableColumn {
  const props = (node.props ?? {}) as Omit<TableColumnProps, 'sortable' | 'showOverflowTooltip'> & {
    readonly sortable?: boolean | 'custom' | '';
    readonly showOverflowTooltip?: boolean | '';
    readonly 'min-width'?: number | string;
    readonly 'class-name'?: string;
    readonly 'sort-method'?: TableColumnProps['sortMethod'];
    readonly 'show-overflow-tooltip'?: boolean | '';
  };
  const slots = node.children as { default?: Slot; header?: Slot } | null;
  const width = pixels(props.width);
  const overflow = props['show-overflow-tooltip'] ?? props.showOverflowTooltip;
  return {
    ...props,
    key,
    ...(props.prop !== undefined && { property: props.prop }),
    baseWidth:
      width ?? pixels(props['min-width'] ?? props.minWidth) ?? (props.type === 'expand' ? 48 : 80),
    flexible: width === undefined && props.type !== 'expand',
    sortable:
      props.sortable === 'custom' ? 'custom' : props.sortable === true || props.sortable === '',
    showOverflowTooltip: overflow === true || overflow === '',
    ...((props['class-name'] ?? props.className) !== undefined && {
      className: props['class-name'] ?? props.className
    }),
    ...((props['sort-method'] ?? props.sortMethod) !== undefined && {
      sortMethod: props['sort-method'] ?? props.sortMethod
    }),
    ...(slots?.default && { defaultSlot: slots.default }),
    ...(slots?.header && { headerSlot: slots.header })
  };
}

export function field(row: unknown, path: string | undefined): unknown {
  if (!path) return undefined;
  return path.split('.').reduce<unknown>((value, key) => {
    if (value !== null && typeof value === 'object') return (value as Record<string, unknown>)[key];
    return undefined;
  }, row);
}

export function sortRows(
  rows: readonly TableRow[],
  column: TableColumn | undefined,
  order: TableOrder
): readonly TableRow[] {
  if (column?.sortable !== true || !order || (!column.prop && !column.sortMethod)) return rows;
  const direction = order === 'ascending' ? 1 : -1;
  const compare = column.sortMethod;
  return rows
    .map((row, index) => ({ row, index, value: compare ? undefined : field(row, column.prop) }))
    .sort((a, b) => {
      const result = compare ? compare(a.row, b.row) : compareFields(a.value, b.value);
      return result ? direction * result : a.index - b.index;
    })
    .map(({ row }) => row);
}

function compareFields(a: unknown, b: unknown): number {
  // Use the raw field, not formatted cell text. Match EL's relative ordering for comparable values.
  if (
    (typeof a !== 'string' && typeof a !== 'number' && typeof a !== 'boolean') ||
    (typeof b !== 'string' && typeof b !== 'number' && typeof b !== 'boolean')
  )
    return 0;
  return a < b ? -1 : a > b ? 1 : 0;
}

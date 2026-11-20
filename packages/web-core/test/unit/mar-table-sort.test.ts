import { describe, expect, it } from 'vitest';
import { sortRows, type TableColumn } from '../../../mar-ui/components/table/table-columns.js';

describe('MarTable local sorting', () => {
  it.each(['field', 'custom comparator'] as const)('preserves ties with a %s', (kind) => {
    const rows = [
      { id: 'A', value: 10 },
      { id: 'C', value: 5 },
      { id: 'B', value: 10 },
      { id: 'D', value: 5 }
    ];
    const column: TableColumn = {
      key: 'value',
      prop: 'value',
      sortable: true,
      baseWidth: 100,
      flexible: false,
      ...(kind === 'custom comparator' && { sortMethod: (a, b) => a.value - b.value })
    };

    expect(sortRows(rows, column, 'ascending').map((row) => row.id)).toEqual(['C', 'D', 'A', 'B']);
    expect(sortRows(rows, column, 'descending').map((row) => row.id)).toEqual(['A', 'B', 'C', 'D']);
    expect(rows.map((row) => row.id)).toEqual(['A', 'C', 'B', 'D']);
  });
});

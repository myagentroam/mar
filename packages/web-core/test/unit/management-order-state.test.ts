import { ref } from 'vue';
import { describe, expect, it } from 'vitest';
import { createManagementOrderState } from '../../src/service/ManagementOrderState.js';

describe('Management order drafts', () => {
  it('reorders by drag and restores the snapshot on cancel', () => {
    const items = ref([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    const initial = items.value;
    const state = createManagementOrderState(items, () => true);
    state.startSorting();
    state.dragStart('c', {} as DragEvent);
    state.dragOver('a');
    expect(items.value.map((v) => v.id)).toEqual(['c', 'a', 'b']);
    expect(initial.map((v) => v.id)).toEqual(['a', 'b', 'c']);
    state.cancelSorting();
    expect(items.value.map((v) => v.id)).toEqual(['a', 'b', 'c']);
    expect(state.sorting.value).toBe(false);
    expect(state.draggedId.value).toBeUndefined();
  });

  it('keeps saved order and starts the next draft from that order', () => {
    const items = ref([{ id: 'a' }, { id: 'b' }]);
    const state = createManagementOrderState(items, () => true);
    state.startSorting();
    state.moveBy('b', -1);
    state.finishSorting();
    state.cancelSorting();
    expect(items.value.map((v) => v.id)).toEqual(['b', 'a']);
    state.startSorting();
    state.moveBy('b', 1);
    state.cancelSorting();
    expect(items.value.map((v) => v.id)).toEqual(['b', 'a']);
  });

  it('ignores read-only, in-flight, missing and out-of-range moves', () => {
    const items = ref([{ id: 'a' }, { id: 'b' }]);
    let writable = false;
    const state = createManagementOrderState(items, () => writable);
    state.startSorting();
    expect(state.sorting.value).toBe(false);
    writable = true;
    state.startSorting();
    state.moveBy('a', -1);
    state.moveBy('missing', 1);
    state.dragStart('b', {} as DragEvent);
    state.dragOver('missing');
    writable = false;
    state.dragOver('a');
    state.moveBy('b', -1);
    state.cancelSorting();
    expect(state.sorting.value).toBe(true);
    expect(items.value.map((v) => v.id)).toEqual(['a', 'b']);
    writable = true;
    state.cancelSorting();
    state.moveBy('b', -1);
    expect(items.value.map((v) => v.id)).toEqual(['a', 'b']);
  });
});

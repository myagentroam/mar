import { ref, type Ref } from 'vue';

export function createManagementOrderState<T extends { readonly id: string }>(
  items: Ref<T[]>,
  canChange: () => boolean
) {
  const sorting = ref(false);
  const draggedId = ref<string>();
  let snapshot: T[] = [];

  function startSorting() {
    if (sorting.value || !canChange()) return;
    snapshot = [...items.value];
    sorting.value = true;
  }

  function finishSorting() {
    sorting.value = false;
    draggedId.value = undefined;
    snapshot = [];
  }

  function cancelSorting() {
    if (!sorting.value || !canChange()) return;
    items.value = [...snapshot];
    finishSorting();
  }

  function move(sourceId: string, targetId: string) {
    if (!sorting.value || !canChange() || sourceId === targetId) return;
    const source = items.value.findIndex((item) => item.id === sourceId);
    const target = items.value.findIndex((item) => item.id === targetId);
    if (source < 0 || target < 0) return;
    const next = [...items.value];
    const [moved] = next.splice(source, 1);
    if (moved === undefined) return;
    next.splice(target, 0, moved);
    items.value = next;
  }

  function dragStart(id: string, event: DragEvent) {
    if (!sorting.value || !canChange()) return;
    draggedId.value = id;
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  function dragOver(id: string) {
    if (draggedId.value !== undefined) move(draggedId.value, id);
  }

  function moveBy(id: string, delta: number) {
    const index = items.value.findIndex((item) => item.id === id);
    if (index < 0) return;
    const target = items.value[index + delta];
    if (target !== undefined) move(id, target.id);
  }

  return {
    sorting,
    draggedId,
    startSorting,
    finishSorting,
    cancelSorting,
    dragStart,
    dragOver,
    moveBy
  };
}

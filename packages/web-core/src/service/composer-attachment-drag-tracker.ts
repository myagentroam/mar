export function createComposerAttachmentDragTracker(setDragging: (dragging: boolean) => void) {
  let depth = 0;
  return {
    enter(): void {
      depth += 1;
      setDragging(true);
    },
    leave(): void {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    },
    reset(): void {
      depth = 0;
      setDragging(false);
    }
  };
}

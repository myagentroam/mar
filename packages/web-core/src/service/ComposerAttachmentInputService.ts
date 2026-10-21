import { createComposerAttachmentDragTracker } from './ComposerAttachmentDragTracker.js';
import { createLongTextAttachment, isLongComposerPaste } from './ComposerPasteService.js';

export function createComposerAttachmentInputService(options: {
  readonly canAcceptFiles: () => boolean;
  readonly addFiles: (files: Iterable<File>) => void;
  readonly confirmDrop?: (files: readonly File[]) => boolean | Promise<boolean>;
  readonly rejectDirectory: () => void;
  readonly setDragging: (dragging: boolean) => void;
}) {
  const drag = createComposerAttachmentDragTracker(options.setDragging);

  function onPaste(event: ClipboardEvent): void {
    if (!options.canAcceptFiles()) return;
    const clipboardItems = [...(event.clipboardData?.items ?? [])];
    const hasFileItem =
      clipboardItems.some((item) => item.kind === 'file') ||
      [...(event.clipboardData?.types ?? [])].includes('Files');
    const itemFiles = clipboardItems
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    const files = itemFiles.length > 0 ? itemFiles : [...(event.clipboardData?.files ?? [])];
    if (hasFileItem || files.length > 0) {
      event.preventDefault();
      if (files.length > 0) options.addFiles(files);
      return;
    }
    const text = event.clipboardData?.getData('text/plain');
    if (text !== undefined && isLongComposerPaste(text)) {
      event.preventDefault();
      options.addFiles([createLongTextAttachment(text)]);
    }
  }

  function onDragEnter(event: DragEvent): void {
    if (!options.canAcceptFiles() || !hasDraggedFiles(event.dataTransfer)) return;
    drag.enter();
  }

  function onDragLeave(): void {
    drag.leave();
  }

  async function onDrop(event: DragEvent): Promise<void> {
    drag.reset();
    if (!options.canAcceptFiles()) return;
    if (hasDraggedDirectory(event.dataTransfer)) {
      options.rejectDirectory();
      return;
    }
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.length === 0) return;
    if (!(await (options.confirmDrop?.(files) ?? true)) || !options.canAcceptFiles()) return;
    options.addFiles(files);
  }

  return { onPaste, onDragEnter, onDragLeave, onDrop };
}

function hasDraggedFiles(dataTransfer: DataTransfer | null): boolean {
  if (dataTransfer === null) return false;
  if ([...dataTransfer.types].some((type) => type.toLocaleLowerCase() === 'files')) return true;
  return [...dataTransfer.items].some((item) => item.kind === 'file');
}

function hasDraggedDirectory(dataTransfer: DataTransfer | null): boolean {
  return [...(dataTransfer?.items ?? [])].some((item) => {
    const entry = (
      item as DataTransferItem & { webkitGetAsEntry?: () => { isDirectory: boolean } | null }
    ).webkitGetAsEntry?.();
    return entry?.isDirectory === true;
  });
}

import { describe, expect, it, vi } from 'vitest';
import { createComposerAttachmentInputService } from '../../src/service/ComposerAttachmentInputService.js';

function clipboardEvent(options: {
  readonly files?: readonly File[];
  readonly text?: string;
}): ClipboardEvent {
  const preventDefault = vi.fn();
  const files = options.files ?? [];
  const items = files.map(
    (file) =>
      ({
        kind: 'file',
        getAsFile: () => file
      }) as DataTransferItem
  );
  return {
    clipboardData: {
      items,
      files,
      types: files.length > 0 ? ['Files'] : ['text/plain'],
      getData: (type: string) => (type === 'text/plain' ? (options.text ?? '') : '')
    },
    preventDefault
  } as unknown as ClipboardEvent;
}

function dragEvent(options: {
  readonly files?: readonly File[];
  readonly directory?: boolean;
}): DragEvent {
  const files = options.files ?? [];
  return {
    dataTransfer: {
      files,
      types: files.length > 0 ? ['Files'] : [],
      items: files.map(
        (file) =>
          ({
            kind: 'file',
            getAsFile: () => file,
            ...(options.directory === true
              ? {
                  webkitGetAsEntry: () => ({ isDirectory: true })
                }
              : {})
          }) as DataTransferItem
      )
    }
  } as unknown as DragEvent;
}

describe('Web Composer Attachment Input', () => {
  it('Pass clipboard files to the attachment uploader and prevent the default paste behavior', () => {
    const addFiles = vi.fn();
    const service = createComposerAttachmentInputService({
      canAcceptFiles: () => true,
      addFiles,
      rejectDirectory: vi.fn(),
      setDragging: vi.fn()
    });
    const image = new File(['image'], 'pasted.png', { type: 'image/png' });
    const event = clipboardEvent({ files: [image] });

    service.onPaste(event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(addFiles).toHaveBeenCalledWith([image]);
  });

  it('Convert long text pastes into TXT attachments while leaving short text to the browser', async () => {
    const addFiles = vi.fn();
    const service = createComposerAttachmentInputService({
      canAcceptFiles: () => true,
      addFiles,
      rejectDirectory: vi.fn(),
      setDragging: vi.fn()
    });
    const longEvent = clipboardEvent({
      text: Array.from({ length: 100 }, (_, index) => `line-${index}`).join('\n')
    });
    const shortEvent = clipboardEvent({ text: 'normal text' });

    service.onPaste(longEvent);
    service.onPaste(shortEvent);

    expect(longEvent.preventDefault).toHaveBeenCalledOnce();
    expect(addFiles).toHaveBeenCalledOnce();
    const pastedFile = addFiles.mock.calls[0]?.[0][0] as File;
    expect(pastedFile.name).toMatch(/^pasted-text-\d{8}-\d{6}\.txt$/);
    expect(await pastedFile.text()).toContain('line-99');
    expect(shortEvent.preventDefault).not.toHaveBeenCalled();
  });

  it('Track nested drag-and-drop events, reject directories, and clear the highlight after a drop', async () => {
    const dragging: boolean[] = [];
    const addFiles = vi.fn();
    const rejectDirectory = vi.fn();
    const service = createComposerAttachmentInputService({
      canAcceptFiles: () => true,
      addFiles,
      rejectDirectory,
      setDragging: (value) => dragging.push(value)
    });
    const file = new File(['document'], 'dropped.pdf', { type: 'application/pdf' });

    service.onDragEnter(dragEvent({ files: [file] }));
    service.onDragEnter(dragEvent({ files: [file] }));
    service.onDragLeave();
    await service.onDrop(dragEvent({ files: [file], directory: true }));
    await service.onDrop(dragEvent({ files: [file] }));

    expect(dragging).toEqual([true, true, false, false]);
    expect(rejectDirectory).toHaveBeenCalledOnce();
    expect(addFiles).toHaveBeenCalledWith([file]);
  });

  it('Confirms a file drop before adding files and rechecks whether input is writable', async () => {
    const addFiles = vi.fn();
    const confirmDrop = vi
      .fn<(files: readonly File[]) => Promise<boolean>>()
      .mockResolvedValue(false);
    const service = createComposerAttachmentInputService({
      canAcceptFiles: () => true,
      addFiles,
      confirmDrop,
      rejectDirectory: vi.fn(),
      setDragging: vi.fn()
    });
    const file = new File(['document'], 'dropped.pdf', { type: 'application/pdf' });

    await service.onDrop(dragEvent({ files: [file] }));

    expect(confirmDrop).toHaveBeenCalledWith([file]);
    expect(addFiles).not.toHaveBeenCalled();

    confirmDrop.mockResolvedValueOnce(true);
    await service.onDrop(dragEvent({ files: [file] }));
    expect(addFiles).toHaveBeenCalledWith([file]);
  });

  it('Leave clipboard and file drag-and-drop handling untouched when editing is disabled', async () => {
    const addFiles = vi.fn();
    const setDragging = vi.fn();
    const service = createComposerAttachmentInputService({
      canAcceptFiles: () => false,
      addFiles,
      rejectDirectory: vi.fn(),
      setDragging
    });
    const image = new File(['image'], 'pasted.png', { type: 'image/png' });
    const paste = clipboardEvent({ files: [image] });

    service.onPaste(paste);
    service.onDragEnter(dragEvent({ files: [image] }));
    await service.onDrop(dragEvent({ files: [image] }));

    expect(paste.preventDefault).not.toHaveBeenCalled();
    expect(addFiles).not.toHaveBeenCalled();
    expect(setDragging).toHaveBeenCalledWith(false);
  });
});

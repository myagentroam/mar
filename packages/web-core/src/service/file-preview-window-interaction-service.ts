import {
  consoleKeyboardShortcutService,
  invokeConsoleShortcut,
  type ConsoleShortcutBinding,
  type ConsoleShortcutResult
} from './console-keyboard-shortcut-service.js';
import { createMobileLayerHistoryService } from './mobile-layer-history-service.js';

interface FilePreviewWindowInteractionOptions {
  isOpen(): boolean;
  root?(): HTMLElement | undefined;
  closeWindow(): boolean | Promise<boolean>;
  closeTab(): boolean | Promise<boolean>;
}

export function createFilePreviewWindowInteractionService(
  options: FilePreviewWindowInteractionOptions
) {
  let mounted = false;
  let closing = false;
  let unregisterShortcut: (() => void) | undefined;
  let unregisterEscape: (() => void) | undefined;
  const history = createMobileLayerHistoryService({
    isOpen: options.isOpen,
    close: () => requestClose(true)
  });
  const frameBindings = new Map<HTMLIFrameElement, () => void>();

  function isOwnOverlay(element: Element): boolean {
    return element === options.root?.()?.closest('.el-overlay-dialog');
  }

  function hasOverlay(): boolean {
    return [...document.querySelectorAll('.el-overlay-message-box, .el-overlay-dialog')].some(
      (overlay) => !isOwnOverlay(overlay) && overlay.getClientRects().length > 0
    );
  }

  async function requestClose(all: boolean): Promise<void> {
    if (closing || !options.isOpen() || hasOverlay()) return;
    closing = true;
    try {
      const closed = await (all ? options.closeWindow() : options.closeTab());
      if (all && closed && mounted) history.dispose();
    } finally {
      closing = false;
    }
  }

  const closeBinding: ConsoleShortcutBinding = {
    command: 'filePreview.close',
    priority: 110,
    scope: 'file-preview',
    modalOwner: () => options.root?.(),
    keys: [
      { key: 'w', code: 'KeyW', ctrl: true },
      { key: 'w', code: 'KeyW', ctrl: true, shift: true },
      { key: 'w', code: 'KeyW', alt: true },
      { key: 'w', code: 'KeyW', alt: true, shift: true }
    ],
    when: options.isOpen,
    execute: (event) => {
      // Foreground ownership remains in effect while confirmation is pending.
      if (!event.repeat) void requestClose(event.shiftKey);
      return 'HANDLED';
    }
  };

  function handleShortcut(event: KeyboardEvent): ConsoleShortcutResult {
    return invokeConsoleShortcut(closeBinding, event);
  }

  function isEscapeBlocked(event: KeyboardEvent): boolean {
    return (
      event.defaultPrevented ||
      event.isComposing ||
      event.keyCode === 229 ||
      // Element Plus closes dialogs without consuming Escape. The original
      // propagation path still identifies a dialog after it has been removed.
      event.composedPath().some((target) => {
        const element = target as Element;
        return (
          element.nodeType === 1 &&
          element.matches('.el-overlay-message-box, .el-overlay-dialog') &&
          !isOwnOverlay(element)
        );
      }) ||
      hasOverlay()
    );
  }

  const escapeBinding: ConsoleShortcutBinding = {
    command: 'filePreview.closeWindow',
    priority: 105,
    scope: 'file-preview',
    modalOwner: () => options.root?.(),
    keys: [{ key: 'Escape' }],
    when: (event) => options.isOpen() && !isEscapeBlocked(event),
    execute: (event) => {
      if (!event.repeat) void requestClose(true);
      return 'HANDLED';
    }
  };

  function handleEscape(event: KeyboardEvent): void {
    if (invokeConsoleShortcut(escapeBinding, event) !== 'HANDLED') return;
    event.preventDefault();
    event.stopPropagation();
  }

  function bindFrame(frame: HTMLIFrameElement): void {
    frameBindings.get(frame)?.();
    frameBindings.delete(frame);
    let frameDocument: Document | null;
    try {
      frameDocument = frame.contentDocument;
    } catch {
      // An isolated cross-origin preview cannot expose its keyboard events.
      return;
    }
    const frameWindow = frameDocument?.defaultView;
    if (frameDocument === null || frameWindow === null || frameWindow === undefined) return;
    // Events from a same-origin preview must not fall through to its background Workspace.
    const onKeydown = (event: KeyboardEvent): void =>
      consoleKeyboardShortcutService.handle(event, 'file-preview');
    frameDocument.addEventListener('keydown', onKeydown, { capture: true });
    frameBindings.set(frame, () => {
      frameDocument.removeEventListener('keydown', onKeydown, { capture: true });
    });
  }

  function mount(): void {
    if (mounted) return;
    mounted = true;
    unregisterShortcut = consoleKeyboardShortcutService.register(closeBinding);
    unregisterEscape = consoleKeyboardShortcutService.register(escapeBinding);
    history.start();
  }

  function dispose(): void {
    if (!mounted) return;
    mounted = false;
    unregisterShortcut?.();
    unregisterShortcut = undefined;
    unregisterEscape?.();
    unregisterEscape = undefined;
    for (const unbind of frameBindings.values()) unbind();
    frameBindings.clear();
    history.dispose();
  }

  return { mount, dispose, handleShortcut, handleEscape, isEscapeBlocked, bindFrame };
}

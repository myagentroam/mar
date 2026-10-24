import {
  consoleKeyboardShortcutService,
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

  function handleShortcut(event: KeyboardEvent): ConsoleShortcutResult {
    if (
      !options.isOpen() ||
      event.defaultPrevented ||
      event.isComposing ||
      event.keyCode === 229 ||
      event.metaKey ||
      event.altKey === event.ctrlKey ||
      (event.code !== 'KeyW' && event.key.toLowerCase() !== 'w')
    )
      return 'IGNORED';
    // The foreground file window owns close combinations, including while a
    // confirmation is pending; they must never reach a Workspace underneath.
    if (!event.repeat) void requestClose(event.shiftKey);
    return 'HANDLED';
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

  function handleEscape(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || !options.isOpen() || isEscapeBlocked(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) void requestClose(true);
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
    const onKeydown = (event: KeyboardEvent): void => {
      if (handleShortcut(event) !== 'HANDLED') return;
      event.preventDefault();
      event.stopPropagation();
    };
    frameDocument.addEventListener('keydown', onKeydown, { capture: true });
    frameWindow.addEventListener('keydown', handleEscape);
    frameBindings.set(frame, () => {
      frameDocument.removeEventListener('keydown', onKeydown, { capture: true });
      frameWindow.removeEventListener('keydown', handleEscape);
    });
  }

  function mount(): void {
    if (mounted) return;
    mounted = true;
    unregisterShortcut = consoleKeyboardShortcutService.register({
      priority: 110,
      handle: handleShortcut
    });
    // Escape runs after the focused editor, find panel and context menu.
    window.addEventListener('keydown', handleEscape);
    history.start();
  }

  function dispose(): void {
    if (!mounted) return;
    mounted = false;
    unregisterShortcut?.();
    unregisterShortcut = undefined;
    window.removeEventListener('keydown', handleEscape);
    for (const unbind of frameBindings.values()) unbind();
    frameBindings.clear();
    history.dispose();
  }

  return { mount, dispose, handleShortcut, handleEscape, isEscapeBlocked, bindFrame };
}

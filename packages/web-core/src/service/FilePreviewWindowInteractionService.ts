import {
  consoleKeyboardShortcutService,
  type ConsoleShortcutResult
} from './ConsoleKeyboardShortcutService.js';
import { MOBILE_WORKBENCH_VIEWPORT_QUERY } from '../util/mobile-workbench.js';

interface FilePreviewWindowInteractionOptions {
  isOpen(): boolean;
  closeWindow(): boolean | Promise<boolean>;
  closeTab(): boolean | Promise<boolean>;
}

const HISTORY_KEY = '__marFilePreviewWindow';
interface HistoryGuard {
  readonly owner: string;
  readonly previousState: unknown;
}
let historySequence = 0;
let pendingHistoryRelease: Promise<void> | undefined;

function releaseHistoryEntry(): void {
  if (pendingHistoryRelease !== undefined) return;
  let resolve!: () => void;
  const release = new Promise<void>((done) => {
    resolve = done;
  });
  pendingHistoryRelease = release;
  const complete = () => {
    window.removeEventListener('popstate', complete);
    pendingHistoryRelease = undefined;
    resolve();
  };
  window.addEventListener('popstate', complete);
  window.history.back();
}

function historyGuard(state: unknown): HistoryGuard | undefined {
  if (typeof state !== 'object' || state === null) return undefined;
  const guard = (state as Record<string, unknown>)[HISTORY_KEY];
  if (
    typeof guard !== 'object' ||
    guard === null ||
    typeof (guard as HistoryGuard).owner !== 'string' ||
    !Object.hasOwn(guard, 'previousState')
  )
    return undefined;
  return guard as HistoryGuard;
}

export function createFilePreviewWindowInteractionService(
  options: FilePreviewWindowInteractionOptions
) {
  let mounted = false;
  let closing = false;
  let unregisterShortcut: (() => void) | undefined;
  let guard: HistoryGuard | undefined;
  let guardedState: unknown;
  const frameBindings = new Map<HTMLIFrameElement, () => void>();

  function hasOverlay(): boolean {
    return [...document.querySelectorAll('.el-overlay-message-box, .el-overlay-dialog')].some(
      (overlay) => overlay.getClientRects().length > 0
    );
  }

  async function requestClose(all: boolean): Promise<void> {
    if (closing || !options.isOpen() || hasOverlay()) return;
    closing = true;
    try {
      const closed = await (all ? options.closeWindow() : options.closeTab());
      if (all && closed && mounted) releaseHistory();
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
          element.nodeType === 1 && element.matches('.el-overlay-message-box, .el-overlay-dialog')
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

  function onPopState(): void {
    if (guard === undefined || historyGuard(window.history.state)?.owner === guard.owner) return;
    if (!options.isOpen()) {
      releaseHistory();
      return;
    }
    // Restore the guard before asynchronous confirmation, so another Back
    // cannot leave the page or create a second confirmation.
    window.history.pushState(guardedState, '');
    void requestClose(true);
  }

  function releaseHistory(): void {
    window.removeEventListener('popstate', onPopState);
    const ownsEntry =
      guard !== undefined && historyGuard(window.history.state)?.owner === guard.owner;
    guard = undefined;
    guardedState = undefined;
    if (ownsEntry) releaseHistoryEntry();
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

  function mountHistoryGuard(): void {
    if (!mounted || !options.isOpen()) return;
    const state: unknown = window.history.state;
    guard = historyGuard(state);
    if (guard === undefined) {
      guard = { owner: `${Date.now()}-${++historySequence}`, previousState: state };
      guardedState = {
        ...(typeof state === 'object' && state !== null ? state : {}),
        [HISTORY_KEY]: guard
      };
      window.history.pushState(guardedState, '');
    } else guardedState = state;
    window.addEventListener('popstate', onPopState);
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
    if (!window.matchMedia(MOBILE_WORKBENCH_VIEWPORT_QUERY).matches) return;
    // A previous window's Back cleanup must finish before this window owns
    // history; its delayed popstate is not a request to close this window.
    if (pendingHistoryRelease === undefined) mountHistoryGuard();
    else void pendingHistoryRelease.then(mountHistoryGuard);
  }

  function dispose(): void {
    if (!mounted) return;
    mounted = false;
    unregisterShortcut?.();
    unregisterShortcut = undefined;
    window.removeEventListener('keydown', handleEscape);
    for (const unbind of frameBindings.values()) unbind();
    frameBindings.clear();
    releaseHistory();
  }

  return { mount, dispose, handleShortcut, handleEscape, isEscapeBlocked, bindFrame };
}

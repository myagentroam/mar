import { nextTick, onMounted, watch, type WatchStopHandle } from 'vue';
import { consoleKeyboardShortcutService } from './console-keyboard-shortcut-service.js';

/** Custom auxiliary surfaces keep the header available, unlike modal dialogs. */
export function createMobileSurfaceFocusService(options: {
  readonly isOpen: () => boolean;
  readonly regions: () => readonly (HTMLElement | null | undefined)[];
  readonly close?: () => void;
  readonly terminal?: () => boolean;
}) {
  let trigger: HTMLElement | undefined;
  let restoring = false;
  let focusedWithin = false;

  function hasModal(): boolean {
    return [
      ...document.querySelectorAll(
        '.el-overlay-dialog, .el-overlay-message-box, .workspace-file-tabs, .workspace-file-page-frame.is-fullscreen'
      )
    ].some(
      (element) =>
        element.getClientRects().length > 0 &&
        (!element.matches('.workspace-file-tabs, .workspace-file-page-frame.is-fullscreen') ||
          !options.regions().some((region) => region?.contains(element)))
    );
  }

  function contains(target: EventTarget | null): boolean {
    if (!(target instanceof Node)) return false;
    return options.regions().some(
      (region) =>
        region?.contains(target) ||
        [...(region?.querySelectorAll('[aria-controls]') ?? [])].some((control) =>
          control
            .getAttribute('aria-controls')
            ?.split(/\s+/)
            .some((id) => document.getElementById(id)?.contains(target))
        )
    );
  }

  function focusSurface(): void {
    const region = options.regions().find((element) => element?.getClientRects().length);
    region?.focus({ preventScroll: true });
  }

  function restoreFocus(): void {
    const target =
      trigger?.isConnected &&
      !trigger.closest('[inert]') &&
      !trigger.matches('input, textarea, :disabled') &&
      !trigger.isContentEditable
        ? trigger
        : document.querySelector<HTMLElement>('.activity-rail button:not(:disabled)');
    target?.focus({ preventScroll: true });
    focusedWithin = false;
  }

  function onFocus(event: FocusEvent): void {
    if (options.isOpen() && contains(event.target)) focusedWithin = true;
    if (!options.isOpen() || restoring || hasModal() || contains(event.target)) return;
    restoring = true;
    focusSurface();
    restoring = false;
  }

  function onKey(event: KeyboardEvent): void {
    if (
      !options.isOpen() ||
      event.defaultPrevented ||
      event.isComposing ||
      hasModal() ||
      event
        .composedPath()
        .some(
          (target) =>
            target instanceof Element &&
            target.matches('.el-overlay-dialog, .el-overlay-message-box')
        )
    )
      return;
    if (event.key === 'Tab') {
      const targets = options
        .regions()
        .flatMap((region) =>
          region
            ? [
                ...region.querySelectorAll<HTMLElement>(
                  'button, a[href], input, textarea, select, [tabindex]'
                )
              ].filter(
                (element) =>
                  element.tabIndex >= 0 &&
                  !element.closest('[inert]') &&
                  !element.matches(':disabled') &&
                  element.getClientRects().length > 0
              )
            : []
        );
      const index = targets.indexOf(document.activeElement as HTMLElement);
      const nextIndex =
        index < 0
          ? event.shiftKey
            ? targets.length - 1
            : 0
          : (index + (event.shiftKey ? -1 : 1) + targets.length) % targets.length;
      const next = targets[nextIndex];
      event.preventDefault();
      next?.focus({ preventScroll: true });
    }
  }

  let stop: WatchStopHandle | undefined;
  let unregisterClose: (() => void) | undefined;
  onMounted(() => {
    if (options.close !== undefined)
      unregisterClose = consoleKeyboardShortcutService.register({
        command: 'mobileSurface.close',
        scope: 'overlay',
        priority: 20,
        keys: [{ key: 'Escape' }],
        when: () => options.isOpen() && !options.terminal?.() && !hasModal(),
        execute: () => {
          options.close?.();
          return 'HANDLED';
        }
      });
    stop = watch(
      options.isOpen,
      async (open, wasOpen) => {
        if (open) {
          if (
            document.activeElement instanceof HTMLElement &&
            !options.regions()[0]?.contains(document.activeElement)
          )
            trigger = document.activeElement;
          await nextTick();
          if (stop !== undefined && options.isOpen() && !hasModal()) focusSurface();
        } else if (
          wasOpen &&
          (contains(document.activeElement) ||
            (document.activeElement === document.body && focusedWithin))
        ) {
          restoreFocus();
        }
      },
      { immediate: true, flush: 'post' }
    );
    document.addEventListener('focusin', onFocus);
    window.addEventListener('keydown', onKey);
  });
  return {
    dispose() {
      stop?.();
      stop = undefined;
      document.removeEventListener('focusin', onFocus);
      window.removeEventListener('keydown', onKey);
      unregisterClose?.();
      unregisterClose = undefined;
      if (focusedWithin && contains(document.activeElement)) restoreFocus();
    }
  };
}

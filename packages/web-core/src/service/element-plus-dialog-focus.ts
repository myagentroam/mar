import {
  FOCUS_AFTER_RELEASED,
  FOCUS_AFTER_TRAPPED
} from 'element-plus/es/components/focus-trap/index.mjs';
import type { App } from 'vue';

const quietReturn: FocusOptions & { focusVisible: boolean } = {
  preventScroll: true,
  focusVisible: false
};

/** Preserve an invoker's pointer focus appearance without changing Element Plus dismissal or trapping. */
export const elementPlusDialogFocusPlugin = {
  install(app: App): void {
    const quietInvokers = new WeakMap<HTMLElement, HTMLElement>();

    function rememberInvoker({ target }: Event): void {
      if (!(target instanceof HTMLElement) || !target.matches('.el-dialog, .el-message-box'))
        return;
      const invoker = document.activeElement;
      quietInvokers.delete(target);
      if (
        invoker instanceof HTMLElement &&
        invoker !== document.body &&
        !invoker.matches(':focus-visible')
      )
        quietInvokers.set(target, invoker);
    }

    function prepareFocusReturn(event: Event): void {
      const dialog = event.target;
      if (!(dialog instanceof HTMLElement)) return;
      const invoker = quietInvokers.get(dialog);
      quietInvokers.delete(dialog);
      // A v-if dialog may already have lost focus to body during its leave transition.
      const active = document.activeElement;
      if (
        !invoker?.isConnected ||
        (active !== document.body && !dialog.contains(active)) ||
        !(event instanceof CustomEvent) ||
        event.detail?.focusReason !== 'keyboard' ||
        event.defaultPrevented
      )
        return;
      // Run after Element Plus notifies the dialog's close-auto-focus handler, but before its fallback.
      dialog.addEventListener(
        FOCUS_AFTER_RELEASED,
        (release) => {
          if (release.defaultPrevented) return;
          const destination = document.activeElement;
          if (destination && destination !== document.body && !dialog.contains(destination)) {
            release.preventDefault();
            return;
          }
          invoker.focus(quietReturn);
          if (document.activeElement === invoker) release.preventDefault();
        },
        { once: true }
      );
    }

    // Element Plus dispatches non-bubbling focus trap events on the dialog content, including teleports.
    document.addEventListener(FOCUS_AFTER_TRAPPED, rememberInvoker, true);
    document.addEventListener(FOCUS_AFTER_RELEASED, prepareFocusReturn, true);
    app.onUnmount(() => {
      document.removeEventListener(FOCUS_AFTER_TRAPPED, rememberInvoker, true);
      document.removeEventListener(FOCUS_AFTER_RELEASED, prepareFocusReturn, true);
    });
  }
};

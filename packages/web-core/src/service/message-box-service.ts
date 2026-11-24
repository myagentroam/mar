import { createApp, type Component, type VNode } from 'vue';
import MarMessageBoxView from '../view/overlays/MarMessageBoxView.vue';

export interface MarMessageBoxOptions {
  type?: 'info' | 'success' | 'warning' | 'error';
  icon?: Component;
  confirmButtonType?: 'primary' | 'danger';
  confirmButtonText?: string;
  cancelButtonText?: string;
  customClass?: string;
  inputType?: 'text' | 'password';
  inputValue?: string;
  inputPlaceholder?: string;
  inputPattern?: RegExp;
  inputErrorMessage?: string;
  inputValidator?: (value: string) => boolean | string | undefined;
  signal?: AbortSignal;
}

export type MarMessageBoxVariant = 'alert' | 'confirm' | 'prompt';
export type MarMessageBoxAction = 'confirm' | 'cancel' | 'close';
type Message = string | VNode;
const dismissals = new Set<() => void>();
let sequence = 0;

/** Mounts each independent request once and settles it exactly once after its UI is removed. */
function open(
  variant: MarMessageBoxVariant,
  message: Message,
  title: string,
  options: MarMessageBoxOptions = {}
) {
  return new Promise<{ value: string; action: 'confirm' }>((resolve, reject) => {
    if (options.signal?.aborted) return reject('cancel');
    const host = document.createElement('div');
    document.body.append(host);
    let finished = false;

    function finish(action: MarMessageBoxAction, value = '') {
      if (finished) return;
      finished = true;
      dismissals.delete(dismiss);
      options.signal?.removeEventListener('abort', dismiss);
      queueMicrotask(() => {
        app.unmount();
        host.remove();
        if (action === 'confirm') resolve({ value, action });
        else reject('cancel');
      });
    }

    function dismiss() {
      finish('close');
    }

    dismissals.add(dismiss);
    const app = createApp(MarMessageBoxView, {
      message,
      title,
      options,
      variant,
      onFinish: finish
    });
    app.config.idPrefix = `mar-message-box-${++sequence}`;
    try {
      app.mount(host);
      options.signal?.addEventListener('abort', dismiss, { once: true });
    } catch (error) {
      dismissals.delete(dismiss);
      host.remove();
      reject(error);
    }
  });
}

export const MarMessageBox = {
  async alert(message: Message, title: string, options?: MarMessageBoxOptions) {
    await open('alert', message, title, options);
    return 'confirm' as const;
  },
  async confirm(message: Message, title: string, options?: MarMessageBoxOptions) {
    await open('confirm', message, title, options);
    return 'confirm' as const;
  },
  prompt(message: Message, title: string, options?: MarMessageBoxOptions) {
    return open('prompt', message, title, options);
  },
  close() {
    for (const dismiss of [...dismissals].reverse()) dismiss();
  }
};

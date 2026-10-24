import { h, type AppContext } from 'vue';
import { ElMessageBox as ElementMessageBox, type ElMessageBoxOptions } from 'element-plus';
import { createMobileLayerHistoryService } from './MobileLayerHistoryService.js';

type Message = ElMessageBoxOptions['message'];
type Variant = 'alert' | 'confirm' | 'prompt';

function open(
  variant: Variant,
  message: Message,
  titleOrOptions?: ElMessageBoxOptions['title'] | ElMessageBoxOptions,
  options?: ElMessageBoxOptions,
  context?: AppContext | null
) {
  const settings = typeof titleOrOptions === 'object' ? titleOrOptions : options;
  const original = settings?.message ?? message;
  let close: (() => void) | undefined;
  const history = createMobileLayerHistoryService({ isOpen: () => true, close: () => close?.() });
  const configured: ElMessageBoxOptions = {
    ...settings,
    message: (actions) => {
      close = actions.close;
      const content = typeof original === 'function' ? original(actions) : original;
      const lifecycle = {
        onVnodeMounted: () => history.start(),
        onVnodeBeforeUnmount: () => history.dispose()
      };
      return typeof content === 'string' && settings?.dangerouslyUseHTMLString
        ? h('span', { ...lifecycle, innerHTML: content })
        : h('span', lifecycle, [content]);
    }
  };
  const promise =
    typeof titleOrOptions === 'object'
      ? context === undefined
        ? ElementMessageBox[variant](message, configured)
        : ElementMessageBox[variant](message, configured, context)
      : context === undefined
        ? ElementMessageBox[variant](message, titleOrOptions, configured)
        : ElementMessageBox[variant](message, titleOrOptions, configured, context);
  return promise.finally(() => history.dispose());
}

/** Keep Element Plus actions and guards; add only per-instance mobile return. */
export const ElMessageBox = {
  alert: (...args: Parameters<typeof ElementMessageBox.alert>) => open('alert', ...args),
  confirm: (...args: Parameters<typeof ElementMessageBox.confirm>) => open('confirm', ...args),
  prompt: (...args: Parameters<typeof ElementMessageBox.prompt>) => open('prompt', ...args),
  close: () => ElementMessageBox.close()
};

import { ElMessage, type MessageHandler } from 'element-plus';
import { h, nextTick } from 'vue';
import type { MessageFeedback } from '../model/message-feedback.js';
import { marIcon } from '../util/mar-icons.js';
import { translate } from './LocalePreferenceService.js';
import { AuthenticationContextChangedError } from './WorkbenchHttpService.js';

/** A presentation boundary, not a notification queue or an error classifier. */
export const showMessage: MessageFeedback = (message, type, cause) => {
  // Resolve the owner after closing v-if dialogs have left the DOM.
  void nextTick(() => renderMessage(message, type, cause));
};

const renderMessage: MessageFeedback = (message, type, cause) => {
  if (!message.trim() || cause instanceof AuthenticationContextChangedError) return;
  // Reading time depends on content size, never on translated semantic keywords.
  const needsReading = message.includes('\n') || message.length > 180;
  let handle: MessageHandler | undefined;
  let ownerObserver: MutationObserver | undefined;
  const dialog =
    typeof document === 'undefined'
      ? undefined
      : document.activeElement?.closest<HTMLElement>('[role="dialog"]');
  handle = ElMessage[type]({
    message: () =>
      h('span', [
        h('span', { class: 'mar-message-text' }, message),
        h(
          'button',
          {
            type: 'button',
            class: 'el-message__closeBtn mar-message-close',
            title: translate('common.close'),
            'aria-label': translate('common.close'),
            onClick: () => handle?.close()
          },
          [h(marIcon('close'))]
        )
      ]),
    icon: marIcon(type),
    customClass: 'mar-message',
    ...(dialog ? { appendTo: dialog } : {}),
    showClose: false,
    grouping: false,
    onClose: () => ownerObserver?.disconnect(),
    duration: needsReading ? 0 : type === 'error' || type === 'warning' ? 6_000 : 3_000
  });
  // Element Plus renders independently of the dialog's Vue tree.
  if (dialog) {
    ownerObserver = new MutationObserver(() => {
      if (!dialog.isConnected) handle?.close();
    });
    ownerObserver.observe(dialog.ownerDocument.body, { childList: true, subtree: true });
  }
};

/** Used only when the owning application or authenticated identity ends. */
export function clearMessages(): void {
  ElMessage.closeAll();
  // Keep clearing ordered with pending renders; later feedback belongs to the new context.
  void nextTick(() => ElMessage.closeAll());
}

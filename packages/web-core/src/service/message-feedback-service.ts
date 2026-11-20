import { nextTick } from 'vue';
import type { MessageFeedback } from '../model/message-feedback.js';
import { dismissMessages, presentMessage } from './mar-message-presenter.js';
import { AuthenticationContextChangedError } from './workbench-http-service.js';

/** Orders transient feedback after the caller's UI update without owning the operation. */
export const showMessage: MessageFeedback = (message, type, cause) => {
  if (!message.trim() || cause instanceof AuthenticationContextChangedError) return;
  void nextTick(() => presentMessage(message, type));
};

/** Used only when the owning application or authenticated identity ends. */
export function clearMessages(): void {
  dismissMessages();
  void nextTick(dismissMessages);
}

import { nextTick } from 'vue';
import type { MessageType } from '../model/message-feedback.js';
import { dismissMessages, presentMessage, type MessageSurface } from './mar-message-presenter.js';
import { AuthenticationContextChangedError } from './workbench-http-service.js';

/** Orders transient feedback after the caller's UI update without owning the operation. */
export const showMessage = (
  message: string,
  type: MessageType,
  cause?: unknown,
  surface?: MessageSurface
): void => {
  if (!message.trim() || cause instanceof AuthenticationContextChangedError) return;
  void nextTick(() =>
    surface ? presentMessage(message, type, surface) : presentMessage(message, type)
  );
};

/** Used only when the owning application or authenticated identity ends. */
export function clearMessages(): void {
  dismissMessages();
  void nextTick(dismissMessages);
}

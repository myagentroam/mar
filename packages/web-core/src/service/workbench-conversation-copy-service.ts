import type { MessageFeedback } from '../model/message-feedback.js';
import { translate } from './locale-preference-service.js';

export async function copyConversationMessage(
  text: string,
  onSuccess: () => void,
  notice: MessageFeedback
): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    onSuccess();
  } catch {
    notice(
      translate(
        'generated.workbenchPageInteractionService.copyFailedCheckTheBrowserClipboardPermission'
      ),
      'error'
    );
  }
}

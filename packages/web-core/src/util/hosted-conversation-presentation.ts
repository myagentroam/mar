import type { HostedConversationSummary } from '@myagentroam/protocol';
import { translate } from '../service/LocalePreferenceService.js';

export function hostedConversationTitle(
  conversation: Pick<HostedConversationSummary, 'title' | 'titleSource'>
): string {
  return conversation.titleSource === 'DEFAULT'
    ? translate('hostedConversations.temporaryTitle')
    : conversation.title;
}

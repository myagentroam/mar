import type { ComposerReference } from '@myagentroam/protocol';
import { translate } from '../service/locale-preference-service.js';

export function composerReferenceKey(reference: ComposerReference): string {
  return reference.type === 'quote'
    ? `quote:${reference.id}`
    : reference.type === 'session'
      ? `session:${reference.sessionId}`
      : `file:${reference.path}`;
}

export function composerReferenceDescription(reference: ComposerReference): string {
  if (reference.type !== 'quote')
    return reference.type === 'session' ? reference.label : reference.path;
  if (reference.source === 'assistant')
    return [
      translate('composer.quoteAssistant'),
      reference.timestamp,
      reference.streaming ? translate('composer.quoteStreaming') : undefined
    ]
      .filter(Boolean)
      .join(' · ');
  return [
    reference.path,
    reference.origin === 'HISTORY'
      ? translate('composer.quoteHistory')
      : reference.origin === 'TOOL_CHANGE'
        ? translate('composer.quoteToolChange')
        : translate('composer.quoteWorkingTree'),
    reference.revision,
    reference.source === 'file' && reference.unsaved
      ? translate('composer.quoteUnsaved')
      : undefined
  ]
    .filter(Boolean)
    .join(' · ');
}

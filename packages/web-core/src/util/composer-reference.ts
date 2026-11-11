import type { ComposerReference } from '@myagentroam/protocol';
import { translate } from '../service/locale-preference-service.js';
import { formatDateTime } from './time-presentation.js';

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
  if (reference.source === 'assistant') {
    const timestamp =
      reference.timestamp && /^\d{4}-\d{2}-\d{2}T/.test(reference.timestamp)
        ? Date.parse(reference.timestamp)
        : NaN;
    const sourceDay = reference.timestamp?.slice(0, 10) ?? '';
    // Date.parse normalizes nonexistent calendar days, so verify the source day before formatting.
    const isDate =
      Number.isFinite(timestamp) && new Date(sourceDay).toISOString().slice(0, 10) === sourceDay;
    return [
      translate('composer.quoteAssistant'),
      isDate ? formatDateTime(timestamp) : reference.timestamp,
      reference.streaming ? translate('composer.quoteStreaming') : undefined
    ]
      .filter(Boolean)
      .join(' · ');
  }
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

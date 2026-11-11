import type { ComposerReference } from '@myagentroam/protocol';
import { translate } from '../service/locale-preference-service.js';
import { formatDateTime } from './time-presentation.js';

// Presentation limits never change the saved reference or its serialized snapshot.
const TAG_CHARACTERS = 32;
const PREVIEW_CHARACTERS = 500;

function limitedText(text: string, limit: number): string {
  const characters = Array.from(text);
  return characters.length > limit ? `${characters.slice(0, limit - 1).join('')}…` : text;
}

export function composerReferenceLabel(reference: ComposerReference): string {
  const text =
    reference.type === 'quote'
      ? (reference.text
          .split('\n')
          .find((line) => line.trim())
          ?.trim() ?? reference.label)
      : reference.label;
  return limitedText(text, TAG_CHARACTERS);
}

export function composerReferencePreview(text: string): string {
  return limitedText(text, PREVIEW_CHARACTERS);
}

export function composerReferenceKey(reference: ComposerReference): string {
  return reference.type === 'quote'
    ? `quote:${reference.id}`
    : reference.type === 'session'
      ? `session:${reference.sessionId}`
      : `file:${reference.path}`;
}

export function composerReferenceDescription(reference: ComposerReference): string {
  if (reference.type !== 'quote')
    return composerReferencePreview(
      reference.type === 'session' ? reference.label : reference.path
    );
  if (reference.source === 'assistant') {
    const timestamp =
      reference.timestamp && /^\d{4}-\d{2}-\d{2}T/.test(reference.timestamp)
        ? Date.parse(reference.timestamp)
        : NaN;
    const sourceDay = reference.timestamp?.slice(0, 10) ?? '';
    // Date.parse normalizes nonexistent calendar days, so verify the source day before formatting.
    const isDate =
      Number.isFinite(timestamp) && new Date(sourceDay).toISOString().slice(0, 10) === sourceDay;
    return composerReferencePreview(
      [
        translate('composer.quoteAssistant'),
        isDate ? formatDateTime(timestamp) : reference.timestamp,
        reference.streaming ? translate('composer.quoteStreaming') : undefined
      ]
        .filter(Boolean)
        .join(' · ')
    );
  }
  return composerReferencePreview(
    [
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
      .join(' · ')
  );
}

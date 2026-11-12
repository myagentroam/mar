import { createUuid } from './uuid.js';
import {
  composerQuoteSchema,
  serializeComposerTag,
  MAX_COMPOSER_MESSAGE_CHARACTERS,
  type ComposerQuoteDraft,
  type ComposerReference
} from '@myagentroam/protocol';

/** Return a new draft array only after both snapshot and encoded aggregate limits pass. */
export function appendComposerQuote(
  references: readonly ComposerReference[],
  quote: ComposerQuoteDraft,
  input: string,
  id: string = createUuid()
): readonly ComposerReference[] {
  const snapshot = composerQuoteSchema.parse({ ...quote, id });
  const next = [...references, snapshot];
  const xml = serializeComposerTag('mar_references', { references: next });
  if (input.length + xml.length + 1 > MAX_COMPOSER_MESSAGE_CHARACTERS)
    throw new Error('COMPOSER_TAG_INVALID');
  return next;
}

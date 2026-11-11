import type { ComposerQuoteDraft } from '@myagentroam/protocol';

/** The composition owner binds draft admission; a captured action reports whether it added the quote. */
export interface ComposerQuoteTarget {
  capture(): ((quote: ComposerQuoteDraft) => boolean) | undefined;
}

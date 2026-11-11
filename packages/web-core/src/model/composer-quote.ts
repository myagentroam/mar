import type { ComposerQuoteDraft } from '@myagentroam/protocol';

/** A source captures an add action; the composition owner alone binds its draft and admission. */
export interface ComposerQuoteTarget {
  capture(): ((quote: ComposerQuoteDraft) => void) | undefined;
}

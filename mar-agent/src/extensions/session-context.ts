import type { ExtensionServiceKey } from './services.js';

/** Context proposed by a Session-scoped extension, confirmed only after durable submission. */
export interface ExtensionSessionContextItem {
  readonly content: string;
  /** Synchronously confirm only the version captured by collect, not later observations. */
  acknowledge(): void;
}

export interface ExtensionSessionContextProvider {
  collect(
    signal: AbortSignal
  ): readonly ExtensionSessionContextItem[] | Promise<readonly ExtensionSessionContextItem[]>;
  /** Bounded resource summary for normal and compact context reconstruction; consumes no updates. */
  resources?(signal: AbortSignal): readonly string[] | Promise<readonly string[]>;
  /** Wakes an active wait when unread model-visible context becomes available. */
  readonly wake?: {
    pending(): boolean;
    subscribe(listener: () => void): () => void;
  };
}

export const SESSION_CONTEXT_PROVIDER: ExtensionServiceKey<ExtensionSessionContextProvider> = {
  id: 'core.session-context-provider',
  scope: 'session'
};

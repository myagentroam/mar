import type { ExtensionServiceKey } from './services.js';

/** Context proposed by a Session-scoped extension, confirmed only after durable submission. */
export interface ExtensionSessionContextItem {
  readonly content: string;
  /** Synchronously confirm only the version captured by collect, not later observations. */
  acknowledge(): void;
}

export interface ExtensionRequestContext {
  /** Contextual block updates keyed by ID. Omitted IDs are left untouched. */
  readonly items?: readonly { readonly id: string; readonly content: string }[];
  /** Validate and adopt the capture, checking only inputs it depends on. False rebuilds it. */
  accept?(hasClientMessage: (id: string) => boolean): boolean;
  /** Confirms the supplied blocks retained in the successfully completed request. */
  acknowledge?(deliveredIds: ReadonlySet<string>): void;
}

export interface ExtensionSessionContextProvider {
  collect(
    signal: AbortSignal
  ): readonly ExtensionSessionContextItem[] | Promise<readonly ExtensionSessionContextItem[]>;
  /** Bounded resource summary for normal and compact context reconstruction; consumes no updates. */
  resources?(signal: AbortSignal): readonly string[] | Promise<readonly string[]>;
  /** Supplies contextual data for a normal request. */
  requestContext?(input: {
    readonly signal: AbortSignal;
    /** Client IDs of messages actually present at this request boundary, not pending inputs. */
    readonly clientMessageIds: readonly string[];
  }): ExtensionRequestContext | Promise<ExtensionRequestContext>;
  /** Wakes an active wait when unread model-visible context becomes available. */
  readonly wake?: {
    pending(): boolean;
    subscribe(listener: () => void): () => void;
    reason?(): 'subagent_message' | 'context_update';
  };
}

export const SESSION_CONTEXT_PROVIDER: ExtensionServiceKey<ExtensionSessionContextProvider> = {
  id: 'core.session-context-provider',
  scope: 'session'
};

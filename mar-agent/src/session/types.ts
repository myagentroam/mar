/** Public session provenance; storage may persist additional private metadata. */
export type SessionSource =
  | { readonly type: 'user' }
  | {
      readonly type: 'subagent';
      readonly parentSessionId: string;
      readonly rootSessionId: string;
      readonly parentExecutionId?: string;
      readonly parentOperationId?: string;
      readonly ownerInstanceId?: string;
      readonly extensionId?: string;
      readonly role: 'general-purpose' | 'explore';
      readonly description: string;
    };

export interface SessionListInput {
  readonly limit?: number;
  readonly cursor?: string;
  readonly source?: SessionSource['type'];
  readonly parentSessionId?: string;
  readonly rootSessionId?: string;
}

export interface SessionTitleUpdateInput {
  readonly automatic?: boolean;
  readonly expectedTitle?: string;
  readonly executionId?: string;
  readonly turnId?: string;
}

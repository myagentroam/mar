/** An ordered, side-effect-free chain over facts normalized by the protocol adapter. */
export type ModelErrorAction = 'retry' | 'fail' | 'refreshCredential' | 'resetContinuation';

export interface ModelErrorDecision<Action extends ModelErrorAction = ModelErrorAction> {
  readonly id: string;
  readonly action: Action;
  readonly reason?: string;
  /** Preserve an existing error diagnostic without authorizing a replay. */
  readonly reportedRetryable?: true;
}

export interface ModelErrorRule<
  Facts,
  Action extends ModelErrorAction = ModelErrorAction
> extends ModelErrorDecision<Action> {
  readonly matches: (facts: Facts) => boolean;
}

export interface UpstreamModelError {
  readonly source: 'http' | 'sse' | 'websocket';
  readonly status?: number | undefined;
  readonly code?: string | undefined;
  readonly message?: string | undefined;
}

export interface ContinuationErrorFacts {
  readonly resetContinuation: boolean;
  readonly code: string;
  readonly message: string;
}

export function classifyModelError<Facts, Action extends ModelErrorAction>(
  rules: readonly ModelErrorRule<Facts, Action>[],
  facts: Facts
): ModelErrorDecision<Action> | undefined {
  return rules.find((rule) => rule.matches(facts));
}

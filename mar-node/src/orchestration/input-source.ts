/** Internal, in-process origin; transport input and model text cannot supply this key. */
export const ORCHESTRATION_INPUT_SOURCE = Symbol('orchestration-input-source');

export interface OrchestrationInputSource {
  readonly runId: string;
  readonly hasMessage: boolean;
}

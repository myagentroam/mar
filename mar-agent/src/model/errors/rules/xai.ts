import type { ContinuationErrorFacts, ModelErrorRule } from '../chain.js';

export const xAiContinuationErrorRule: ModelErrorRule<ContinuationErrorFacts, 'resetContinuation'> =
  {
    id: 'xai.responses-missing-reference',
    action: 'resetContinuation',
    // Grok WSS can return a gRPC-prefixed missing reference; HTTP may return a plain error.
    matches: ({ resetContinuation, code, message }) =>
      resetContinuation &&
      ['api_error', 'mar_agent_model_protocol_error'].includes(code.trim()) &&
      /^(?:(?:mar_agent_model_protocol_error|api_error): )?(?:grpc error: )?response with id=\S+ not found[.!]?$/u.test(
        message
      )
  };

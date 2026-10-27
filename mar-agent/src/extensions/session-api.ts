import { AgentError } from '../error.js';
import type { ExtensionHooks } from './hooks.js';
import type { ExtensionOperationRunner, ExtensionOperations } from './operation.js';
import {
  invokeCorePromptSubmission,
  type DomainPromptInputOperations,
  type DomainPromptInputFacts
} from './prompt-input.js';
import type { ExtensionResourceScope } from './resources.js';
import type {
  ExtensionSessionAction,
  ExtensionSessionApi,
  ExtensionSessionBackend,
  ExtensionSessionReceipt,
  DomainSessionOperations,
  DomainSessionFacts
} from './session-input.js';

export function bindCoreSession(
  backend: ExtensionSessionBackend,
  scope: ExtensionResourceScope,
  run: ExtensionOperationRunner,
  operations: Pick<ExtensionOperations, 'continue'>,
  hooks: Pick<
    ExtensionHooks<
      DomainSessionOperations & DomainPromptInputOperations,
      DomainSessionFacts & DomainPromptInputFacts
    >,
    'invoke' | 'emit'
  >
): ExtensionSessionApi {
  const sessionAction: ExtensionSessionAction = (request, call, leaf) =>
    operations.continue(call, async () => {
      if (request.kind === 'append')
        return hooks.invoke('session.append', request.input, call, (input, effective) =>
          leaf({ kind: 'append', input }, effective)
        );
      return leaf(request, call);
    });
  return {
    captureRequest: (input = {}) => run((call) => backend.captureRequest(call, input)),
    inspect: () => run((call) => backend.inspect(call)),
    describe: () =>
      run((call) => {
        if (!backend.describe)
          throw new AgentError(
            'MAR_AGENT_SESSION_INPUT_UNAVAILABLE',
            'Session metadata is unavailable.'
          );
        return backend.describe(call);
      }),
    messages: (input: import('./session-messages.js').ExtensionSessionMessagesInput = {}) =>
      run((call) => backend.messages(input, call)),
    append: (input: import('./session-input.js').ExtensionAppendInput) =>
      run((call) => backend.enqueue({ kind: 'append', input }, call, sessionAction)),
    submit: (input: import('./session-input.js').ExtensionSubmitInput) =>
      run(async (call) => {
        const { queueSignal, ...request } = input;
        if (queueSignal !== undefined && !(queueSignal instanceof AbortSignal))
          throw new AgentError(
            'MAR_AGENT_SESSION_INPUT_INVALID',
            'Session input lifetime must be an AbortSignal.'
          );
        // Admission uses the caller's cancellation; accepted work may outlive it.
        call.signal.throwIfAborted();
        const accepted = queueSignal
          ? Object.freeze({
              ...call,
              signal: AbortSignal.any([scope.signal, queueSignal])
            })
          : call;
        let receipt: ExtensionSessionReceipt | undefined;
        const admission = await invokeCorePromptSubmission(
          hooks,
          request,
          call,
          async (content, effective) => {
            effective.signal.throwIfAborted();
            receipt = await backend.enqueue(
              {
                kind: 'submit',
                input: {
                  ...content,
                  ...(request.provenance === undefined ? {} : { provenance: request.provenance }),
                  ...(request.modelAttribution === undefined
                    ? {}
                    : { modelAttribution: request.modelAttribution }),
                  ...(request.delivery === undefined ? {} : { delivery: request.delivery }),
                  ...(request.waitFor === undefined ? {} : { waitFor: request.waitFor })
                }
              },
              queueSignal ? accepted : effective,
              sessionAction
            );
            return {};
          }
        );
        return receipt ?? backend.handled(request, call, admission.result.value);
      }),
    compact: (input: import('./session-input.js').ExtensionCompactInput = {}) =>
      run((call) => backend.enqueue({ kind: 'compact', input }, call, sessionAction))
  };
}

import { MarAgentError } from '../error.js';
import type { RunInputImage } from '../runtime/contracts.js';
import type { CoreDomainOperations, CoreDomainFacts } from './contracts.js';
import type { ExtensionHooks } from './hooks.js';
import type { CoreOperationContext } from './operation.js';
import { isModelImageUrl } from '../model/image.js';

/** Content only. Identity, queue policy and lifetime come from the physical ingress. */
export interface CorePromptInput {
  readonly text: string;
  readonly modelText?: string;
  readonly context?: readonly string[];
  /** Optional model projection; context remains the original admitted content. */
  readonly modelContext?: readonly string[];
  readonly images?: readonly RunInputImage[];
}
export interface CorePromptResult {
  /** An interceptor answer, not proof of queue admission or a storage write. */
  readonly value?: unknown;
}
export function captureCorePromptInput(input: CorePromptInput): CorePromptInput {
  if (
    !input ||
    typeof input.text !== 'string' ||
    (input.modelText !== undefined && typeof input.modelText !== 'string') ||
    (input.context !== undefined &&
      (!Array.isArray(input.context) ||
        !Array.from(input.context).every((item) => typeof item === 'string'))) ||
    (input.modelContext !== undefined &&
      (!Array.isArray(input.modelContext) ||
        !Array.from(input.modelContext).every((item) => typeof item === 'string'))) ||
    (input.images !== undefined &&
      (!Array.isArray(input.images) ||
        !Array.from(input.images).every(
          (image) =>
            image &&
            typeof image.name === 'string' &&
            typeof image.mimeType === 'string' &&
            typeof image.dataBase64 === 'string' &&
            (image.url === undefined || isModelImageUrl(image.url))
        )))
  )
    throw new MarAgentError('MAR_AGENT_SESSION_INPUT_INVALID', 'Prompt content is invalid.');
  return structuredClone({
    text: input.text,
    ...(input.modelText === undefined ? {} : { modelText: input.modelText }),
    ...(input.context === undefined ? {} : { context: input.context }),
    ...(input.modelContext === undefined ? {} : { modelContext: input.modelContext }),
    ...(input.images === undefined ? {} : { images: input.images })
  });
}

/** One admission chain for SDK input and queued Extension input, before either writer or FIFO. */
export async function invokeCorePromptSubmission(
  hooks: ExtensionHooks<CoreDomainOperations, CoreDomainFacts>,
  input: CorePromptInput,
  call: CoreOperationContext,
  leaf: (input: CorePromptInput, call: CoreOperationContext) => Promise<CorePromptResult>
): Promise<{ readonly entered: number; readonly result: CorePromptResult }> {
  let entered = 0;
  let tail: Promise<unknown> = Promise.resolve();
  const result = await hooks.invoke(
    'prompt.submit',
    captureCorePromptInput(input),
    call,
    (input, effective) => {
      const captured = captureCorePromptInput(input);
      // Concurrent next calls keep their invocation order at the single writer/FIFO boundary.
      const pending = tail.then(async () => {
        effective.signal.throwIfAborted();
        const result = await leaf(captured, effective);
        entered++;
        return result;
      });
      tail = pending.catch(() => undefined);
      return pending;
    }
  );
  if (!result || typeof result !== 'object' || Array.isArray(result))
    throw new MarAgentError(
      'MAR_AGENT_SESSION_INPUT_INVALID',
      'Prompt admission result is invalid.'
    );
  return { entered, result };
}

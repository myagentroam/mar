import { splitContextualPrompt } from '../runtime/context/contextual-blocks.js';
import {
  updateLoadedSkillWorldState,
  updatePromptWorldState,
  type ContextualWorldState
} from '../runtime/context/world-state.js';
import type { AgentModelConfiguration } from '../model/configuration.js';
import type { SessionModelMessage, SessionModelRequest } from '../session/model-request.js';
import type { ClientToolDefinition } from '../tools/contracts.js';
import { prepareSessionModelRequest } from './request-preparation.js';

/** Capture and transform a candidate; only ordinary prompt updates commit during preparation. */
export async function prepareExecutionRoundRequest<Bindings, Scope>(input: {
  readonly messages: SessionModelMessage[];
  readonly continuation: SessionModelMessage | undefined;
  readonly model: Pick<AgentModelConfiguration, 'protocol' | 'inputCapabilities'>;
  readonly requestBase: Omit<SessionModelRequest, 'system' | 'systemBlocks' | 'messages' | 'tools'>;
  residentTools(): readonly ClientToolDefinition[];
  readonly autoPermission: boolean;
  readonly signal: AbortSignal;
  readonly skillLoads?: ReadonlyMap<string, string>;
  capture(): {
    roundTools: readonly ClientToolDefinition[];
    roundBindings: Bindings;
    toolScope: Scope;
    composeSystemPrompt(): Promise<Parameters<typeof splitContextualPrompt>[0]>;
  };
  bind(scope: Scope): void;
  world(): ContextualWorldState;
  commitWorld(
    world: ContextualWorldState,
    deliveredSkills?: ReadonlyMap<string, string>
  ): Promise<void>;
  preparing(messages: readonly SessionModelMessage[] | undefined, baseLength: number): void;
  transform(request: SessionModelRequest, bindings: Bindings): Promise<SessionModelRequest>;
}) {
  const { roundTools, roundBindings, toolScope, composeSystemPrompt } = input.capture();
  const residentTools = input.residentTools();
  const requestMessages =
    input.continuation === undefined ? input.messages : [...input.messages, input.continuation];
  input.bind(toolScope);
  const composed = splitContextualPrompt(await composeSystemPrompt());
  const skillAnchor = input.messages.length;
  const promptWorld = updatePromptWorldState(input.world(), skillAnchor, composed.parts);
  const loads = input.skillLoads;
  const world = loads?.size
    ? updateLoadedSkillWorldState(promptWorld, skillAnchor, loads)
    : promptWorld;
  const candidateRequest = prepareSessionModelRequest(
    {
      ...input.requestBase,
      system: composed.system,
      ...(composed.systemBlocks ? { systemBlocks: composed.systemBlocks } : {}),
      messages: requestMessages,
      tools: roundTools
    },
    input.model,
    world.entries,
    residentTools,
    input.autoPermission
  );
  input.preparing(candidateRequest.messages, input.messages.length);
  let request: SessionModelRequest;
  try {
    request = await input.transform(candidateRequest, roundBindings);
  } finally {
    input.preparing(undefined, input.messages.length);
  }
  input.signal.throwIfAborted();
  if (promptWorld !== input.world()) await input.commitWorld(promptWorld);
  return {
    candidateRequest,
    request,
    toolScope,
    acknowledgeSkillContext: loads?.size
      ? async () => {
          const current = input.world();
          const next =
            current === promptWorld
              ? world
              : updateLoadedSkillWorldState(current, skillAnchor, loads);
          await input.commitWorld(next, loads);
        }
      : undefined
  };
}

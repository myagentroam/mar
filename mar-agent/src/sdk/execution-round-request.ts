import { splitContextualPrompt } from '../runtime/context/contextual-blocks.js';
import {
  PROVIDED_CONTEXT_ID_PREFIX,
  updateLoadedSkillWorldState,
  updatePromptWorldState,
  updateProvidedContextWorldState,
  type ContextualWorldState
} from '../runtime/context/world-state.js';
import type { AgentModelConfiguration } from '../model/configuration.js';
import type { SessionModelMessage, SessionModelRequest } from '../session/model-request.js';
import type { ClientToolDefinition } from '../tools/contracts.js';
import { prepareSessionModelRequest } from './request-preparation.js';
import type { ExtensionRequestContext } from '../extensions/session-context.js';

/** Capture and transform a candidate. Request-scoped context commits only on model completion. */
export async function prepareExecutionRoundRequest<Bindings, Scope>(input: {
  readonly messages: SessionModelMessage[];
  readonly model: Pick<AgentModelConfiguration, 'protocol' | 'inputCapabilities'>;
  readonly requestBase: Omit<SessionModelRequest, 'system' | 'systemBlocks' | 'messages' | 'tools'>;
  residentTools(): readonly ClientToolDefinition[];
  readonly autoPermission: boolean;
  readonly signal: AbortSignal;
  readonly skillLoads?: ReadonlyMap<string, string>;
  requestContext?(): Promise<ExtensionRequestContext>;
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
  input.bind(toolScope);
  const composed = splitContextualPrompt(await composeSystemPrompt());
  const skillAnchor = input.messages.length;
  const context = input.requestContext ? await input.requestContext() : undefined;
  const baseline = input.world();
  const promptWorld = updatePromptWorldState(baseline, skillAnchor, composed.parts);
  const requestWorld =
    context?.items === undefined
      ? promptWorld
      : updateProvidedContextWorldState(promptWorld, skillAnchor, context.items);
  const loads = input.skillLoads;
  const world = loads?.size
    ? updateLoadedSkillWorldState(requestWorld, skillAnchor, loads)
    : requestWorld;
  // Append-only changes retain the existing entries by reference. A Skill replacement
  // removes an earlier anchor and invalidates the provider's committed message count.
  const replacesSkillContext =
    world !== requestWorld &&
    requestWorld.entries.some((entry, index) => entry !== world.entries[index]);
  const candidateRequest = prepareSessionModelRequest(
    {
      ...input.requestBase,
      system: composed.system,
      ...(composed.systemBlocks ? { systemBlocks: composed.systemBlocks } : {}),
      messages: input.messages,
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
  if (promptWorld !== baseline) await input.commitWorld(promptWorld);
  const items = context?.items ?? [];
  const deliveredIds = new Set(items.map(({ id }) => id));
  if (deliveredIds.size && request.messages !== candidateRequest.messages) {
    // Hooks can filter or edit one block without affecting its peers. A kept message
    // retains its identity; an older visible revision does not acknowledge a new one.
    const latest = new Map<string, SessionModelMessage>();
    for (const message of candidateRequest.messages) {
      const block = message.contextualBlock;
      if (block?.kind === 'context' && block.id.startsWith(PROVIDED_CONTEXT_ID_PREFIX))
        latest.set(block.id, message);
    }
    const sent = new Set(request.messages);
    for (const id of deliveredIds) {
      const captured = latest.get(`${PROVIDED_CONTEXT_ID_PREFIX}${id}`);
      if (!captured || !sent.has(captured)) deliveredIds.delete(id);
    }
  }
  return {
    candidateRequest,
    request,
    toolScope,
    replacesSkillContext,
    acceptRequestContext: context?.accept?.bind(context),
    acknowledgeRequestContext:
      deliveredIds.size && (requestWorld !== promptWorld || context?.acknowledge)
        ? async () => {
            if (deliveredIds.size === items.length) {
              if (requestWorld !== promptWorld) await input.commitWorld(requestWorld);
            } else {
              const delivered = requestWorld.entries
                .slice(promptWorld.entries.length)
                .filter(({ block }) =>
                  deliveredIds.has(block!.id.slice(PROVIDED_CONTEXT_ID_PREFIX.length))
                );
              if (delivered.length)
                await input.commitWorld({
                  ...promptWorld,
                  entries: [...promptWorld.entries, ...delivered]
                });
            }
            context?.acknowledge?.(deliveredIds);
          }
        : undefined,
    acknowledgeSkillContext: loads?.size
      ? async () => {
          const current = input.world();
          const next =
            current === requestWorld
              ? world
              : updateLoadedSkillWorldState(current, skillAnchor, loads);
          await input.commitWorld(next, loads);
        }
      : undefined
  };
}

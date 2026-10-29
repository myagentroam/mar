import { AgentError } from '../error.js';
import {
  normalizeSessionMessagesInput,
  sessionMessagesPage
} from '../extensions/session-messages.js';
import type { ExtensionSessionBackend } from '../extensions/session-input.js';
import type { SessionStore } from '../session/store/contracts.js';
import { readResourceImages, restoreMessages } from '../runtime/context/restore.js';
import {
  latestContextualWorldStateGeneration,
  parsePersistedContextualWorldState
} from '../runtime/context/world-state.js';
import { projectSessionRequestMessages } from './request-preparation.js';
import type { SessionRuntime } from './session-runtime.js';
import type { ResolvedModelConfiguration } from './model-runtime.js';

/** Reads either a live request snapshot or the authoritative Session history. */
export function createSessionExtensionMessages(ports: {
  sessionId: string;
  store: Pick<
    SessionStore,
    | 'getSession'
    | 'executionConfiguration'
    | 'readResource'
    | 'readInputImages'
    | 'readExecutionState'
    | 'readContextualWorldState'
  >;
  runtime(id: string): Pick<SessionRuntime, 'execution' | 'contextualWorldState'> | undefined;
  models(): { models: ReadonlyMap<string, ResolvedModelConfiguration>; defaultModelId: string };
}): ExtensionSessionBackend['messages'] {
  const { sessionId, store, runtime, models } = ports;
  return async (input, call) => {
    const selection = normalizeSessionMessagesInput(input);
    call.signal.throwIfAborted();
    let target = sessionId;
    if (selection.agentId !== undefined) {
      const child = await store.getSession(selection.agentId).catch((error: unknown) => {
        if (error instanceof AgentError && error.code === 'MAR_AGENT_SESSION_NOT_FOUND')
          throw new AgentError('MAR_AGENT_SUBAGENT_NOT_FOUND', 'Direct child Session not found.');
        throw error;
      });
      if (child.source.parentSessionId !== sessionId)
        throw new AgentError('MAR_AGENT_SUBAGENT_NOT_FOUND', 'Direct child Session not found.');
      target = child.id;
    }
    call.signal.throwIfAborted();
    const targetRuntime = runtime(target);
    const requestMessages = targetRuntime?.execution?.requestMessages;
    if (selection.view === 'request' && requestMessages) {
      const messages = requestMessages.read();
      const restored = selection.includeImages
        ? await Promise.all(
            messages.map(async (message) =>
              message.images?.length
                ? {
                    ...message,
                    images: await readResourceImages(store, target, message.images)
                  }
                : message
            )
          )
        : messages;
      call.signal.throwIfAborted();
      return sessionMessagesPage(restored, selection);
    }
    const modelState = models();
    const targetConfiguration =
      selection.view === 'request' && target !== sessionId
        ? await store.executionConfiguration(target)
        : undefined;
    call.signal.throwIfAborted();
    const requestModel =
      selection.view === 'request'
        ? modelState.models.get(targetConfiguration?.modelId ?? modelState.defaultModelId)
        : undefined;
    if (selection.view === 'request' && !requestModel)
      throw new AgentError('MAR_AGENT_MODEL_DISABLED', 'Selected model is unavailable.');
    const includeImages =
      selection.includeImages &&
      (requestModel === undefined || requestModel.inputCapabilities.includes('IMAGE'));
    const state = await store.readExecutionState(target);
    call.signal.throwIfAborted();
    const restored = await restoreMessages(store, target, state.contextRecords, {
      includeImages,
      strictImages: includeImages
    });
    call.signal.throwIfAborted();
    if (requestModel) {
      const generation = latestContextualWorldStateGeneration(state.contextRecords);
      const cachedWorld = targetRuntime?.contextualWorldState;
      const world =
        cachedWorld?.generation === generation
          ? cachedWorld
          : parsePersistedContextualWorldState(await store.readContextualWorldState(target));
      call.signal.throwIfAborted();
      return sessionMessagesPage(
        projectSessionRequestMessages(
          restored.messages,
          world?.generation === generation ? (world?.entries ?? []) : [],
          requestModel.inputCapabilities.includes('IMAGE'),
          requestModel.codeMode
        ),
        selection
      );
    }
    return sessionMessagesPage(restored.messages, selection, restored.toolOutcomes);
  };
}

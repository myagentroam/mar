import { randomUUID } from 'node:crypto';
import { MarAgentError } from '../error.js';
import { ExtensionRequestBridge } from '../extensions/model-request.js';
import { transformCoreModelStream } from '../extensions/model-stream.js';
import { modelTextInput } from '../model/text-blocks.js';
import type { CoreModelsBackend } from '../extensions/models.js';
import type { CoreOperationContext } from '../extensions/operation.js';
import type { CoreModelRequest, CoreRequestSnapshot } from '../extensions/model-request.js';
import type {
  ModelAdapter,
  ModelRequest,
  ModelStopReason,
  ModelUsage
} from '../model/contracts.js';
import type { ResolvedModelConfiguration } from './model-runtime.js';

export function createExtensionModels(
  state: () => { models: ReadonlyMap<string, ResolvedModelConfiguration>; defaultModelId: string },
  createAdapter: (
    modelId: string,
    models: ReadonlyMap<string, ResolvedModelConfiguration>
  ) => ModelAdapter,
  resolveSnapshot?: (
    snapshot: CoreRequestSnapshot,
    call: CoreOperationContext
  ) => { modelId: string; request: ModelRequest; view: CoreModelRequest },
  observeUsage?: (
    usage: import('../model/usage-observer.js').ModelRequestUsage,
    call: CoreOperationContext
  ) => Promise<void> | void
): CoreModelsBackend {
  return {
    list: () => {
      const { models, defaultModelId } = state();
      return Object.freeze(
        [...models.values()].map((model) =>
          Object.freeze({
            id: model.id,
            name: model.name,
            modelId: model.modelId,
            contextWindowTokens: model.contextWindowTokens,
            maxOutputTokens: model.maxOutputTokens,
            inputCapabilities: Object.freeze([...model.inputCapabilities]),
            reasoningEfforts: Object.freeze([...model.reasoningEfforts]),
            isDefault: model.id === defaultModelId
          })
        )
      );
    },
    async generate(input, call, transform, transformEvent, diagnoseCleanup) {
      call.signal.throwIfAborted();
      const { models, defaultModelId } = state();
      const snapshot =
        input.requestSnapshot === undefined
          ? undefined
          : resolveSnapshot?.(input.requestSnapshot, call);
      if (input.requestSnapshot !== undefined && !snapshot)
        throw new MarAgentError(
          'MAR_AGENT_MODEL_SNAPSHOT_INVALID',
          'Request snapshot is unavailable.'
        );
      if (input.retainToolCatalog && !snapshot)
        throw new MarAgentError(
          'MAR_AGENT_MODEL_SNAPSHOT_INVALID',
          'A retained tool catalog requires a real request snapshot.'
        );
      const modelId = input.modelId ?? snapshot?.modelId ?? defaultModelId;
      const configuration = models.get(modelId);
      if (!configuration)
        throw new MarAgentError('MAR_AGENT_MODEL_DISABLED', 'Selected model is unavailable.');
      if (
        input.outputLimit !== undefined &&
        (!Number.isSafeInteger(input.outputLimit) || input.outputLimit < 1)
      )
        throw new MarAgentError(
          'MAR_AGENT_MODEL_REQUEST_INVALID',
          'Output limit must be a positive integer.'
        );
      const system = input.system === undefined ? undefined : modelTextInput(input.system);
      const prompt = input.prompt === undefined ? undefined : modelTextInput(input.prompt);
      const { systemBlocks: capturedBlocks, ...captured } = snapshot?.request ?? {};
      const systemBlocks = system ? system.blocks : capturedBlocks;
      const bridge = new ExtensionRequestBridge(
        modelId,
        {
          ...captured,
          system: system?.text ?? snapshot?.request.system ?? '',
          ...(systemBlocks === undefined ? {} : { systemBlocks }),
          messages: snapshot?.request.messages ?? [],
          tools: input.retainToolCatalog ? snapshot!.request.tools : [],
          toolChoice: 'none'
        },
        snapshot?.view.messages
      );
      const view = await transform({
        ...bridge.view,
        messages: [
          ...(input.messages ?? bridge.view.messages),
          ...(prompt
            ? [
                {
                  role: 'user' as const,
                  content: prompt.text,
                  ...(prompt.blocks === undefined ? {} : { textBlocks: prompt.blocks })
                }
              ]
            : [])
        ],
        ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {})
      });
      const lowered = bridge.lower(view);
      if (lowered.tools.length && !input.retainToolCatalog)
        throw new MarAgentError(
          'MAR_AGENT_MODEL_REQUEST_INVALID',
          'Independent generation does not execute tools.'
        );
      const request: ModelRequest = {
        ...lowered,
        usageRequestId: randomUUID(),
        ...(observeUsage === undefined
          ? {}
          : {
              onModelUsage: (usage) => observeUsage(usage, call),
              onModelUsageFailure: () => diagnoseCleanup?.('MAR_AGENT_MODEL_USAGE_FAILED')
            }),
        ...(input.retainToolCatalog &&
        snapshot!.request.systemBlocks === undefined &&
        snapshot!.request.messages.every((message) => message.textBlocks === undefined)
          ? { cachePrefixMessages: Math.max(0, lowered.messages.length - (prompt ? 1 : 0)) }
          : {}),
        toolChoice: 'none',
        allowTools: input.retainToolCatalog === true,
        outputLimit: Math.min(
          input.outputLimit ?? configuration.maxOutputTokens,
          configuration.maxOutputTokens
        )
      };
      const adapter = createAdapter(modelId, models);
      let text = '';
      const chunks = new Map<string, string>();
      let stopReason: ModelStopReason | undefined;
      let usage: ModelUsage | undefined;
      let failed = false;
      try {
        for await (const event of transformCoreModelStream(
          (signal) => adapter.start(request, signal),
          call.signal,
          transformEvent,
          () => diagnoseCleanup?.('MAR_AGENT_MODEL_STREAM_CLEANUP_FAILED')
        )) {
          call.signal.throwIfAborted();
          if (event.type === 'text.delta' && event.phase === 'final_answer')
            chunks.set(event.itemId, (chunks.get(event.itemId) ?? '') + event.delta);
          else if (event.type === 'text.completed' && event.phase !== 'commentary')
            chunks.set(event.itemId, event.text);
          else if (event.type === 'output.reset') chunks.clear();
          else if (event.type === 'usage') usage = { ...event.usage };
          else if (event.type === 'completed') stopReason = event.reason;
          else if (event.type === 'client_tool.call' && !input.retainToolCatalog)
            throw new MarAgentError(
              'MAR_AGENT_MODEL_REQUEST_INVALID',
              'Independent generation received a tool call.'
            );
        }
        call.signal.throwIfAborted();
        if (!stopReason)
          throw new MarAgentError(
            'MAR_AGENT_MODEL_STREAM_INCOMPLETE',
            'Model stream ended without a terminal outcome.'
          );
        text = [...chunks.values()].join('');
        return {
          outcome: stopReason === 'cancelled' ? 'cancelled' : text ? 'text' : 'empty',
          text,
          stopReason,
          ...(usage ? { usage: Object.freeze(usage) } : {})
        };
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        try {
          await adapter.close?.();
        } catch (error) {
          // eslint-disable-next-line no-unsafe-finally -- Preserve a primary failure; surface cleanup failures after success.
          if (!failed) throw error;
          diagnoseCleanup?.('MAR_AGENT_MODEL_ADAPTER_CLEANUP_FAILED');
        }
      }
    }
  };
}

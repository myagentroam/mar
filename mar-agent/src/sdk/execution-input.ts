import { AgentError } from '../error.js';
import type { SessionStore } from '../session/store/contracts.js';
import type { SessionRecord } from '../session/record-contract.js';
import type { SessionModelMessage as ModelMessage } from '../session/model-request.js';
import {
  SessionInputCoordinator,
  recordSessionInputCommit,
  type SessionInputEntry,
  type ExtensionSessionRequest,
  type ExtensionSessionActionResult,
  type ExtensionInputSource
} from '../extensions/session-input.js';
import type { ExtensionPromptInput, ExtensionPromptResult } from '../extensions/prompt-input.js';
import type { ExtensionOperationContext } from '../extensions/operation.js';
import type { SubagentMailboxMessage } from '../subagent/session-controller.js';
import type { ResolvedModelConfiguration } from './model-runtime.js';
import type { SmartCompactionInput } from '../runtime/compaction/smart.js';
import type { CompactFlight } from '../runtime/compaction/coordinator.js';
import { inputMetadataFromRecord } from '../session/record-projection.js';
import { AGENT_EXECUTION_POLICY } from '../runtime/execution-policy.js';
import { publishModelResources, type ResourcePublisher } from '../runtime/resource-publication.js';
import { extensionInputSource } from './extension-session-launch.js';
import type { createExecutionModelContext } from './execution-model-context.js';
import type { InternalExecutionOptions } from './session-execution.js';
import type { RunInput } from './types.js';
import { renderSubagentUpdate } from '../subagent/model-update.js';
import type { SubagentSessionController } from '../subagent/session-controller.js';

/** Owns committed input, mailbox admission and live projection for one Execution. */
export function createExecutionInput(input: {
  host: ResourcePublisher;
  store: Pick<
    SessionStore,
    'append' | 'persistInputImages' | 'readInputImages' | 'persistResource' | 'setResourceUrl'
  >;
  sessionId: string;
  executionId: string;
  turnId: string;
  mode: 'run' | 'plan' | 'compact';
  source: 'user' | 'subagent';
  controller: AbortController;
  inputs: Pick<SessionInputCoordinator, 'drain' | 'boundarySize'>;
  messages: ModelMessage[];
  pendingInputs: Map<string, SessionRecord>;
  messageSources: WeakMap<ModelMessage, SessionRecord>;
  modelContext: Pick<
    ReturnType<typeof createExecutionModelContext>,
    'recordEnvironment' | 'rememberInput'
  >;
  model(): Pick<ResolvedModelConfiguration, 'inputCapabilities' | 'contextWindowTokens'>;
  tokens(): number | undefined;
  setSmartInput(value: SmartCompactionInput): void;
  withRecordProjection<T>(action: () => Promise<T>): Promise<T>;
  appendExtensionMessage(
    entry: SessionInputEntry,
    request: Extract<ExtensionSessionRequest, { kind: 'append' }>,
    call: ExtensionOperationContext
  ): Promise<ExtensionSessionActionResult>;
  startCompact(): (input?: { focus?: string; async?: boolean }) => CompactFlight;
  compactContext(): (input?: { focus?: string; async?: boolean }) => Promise<boolean>;
}) {
  const {
    host,
    store,
    sessionId,
    executionId,
    turnId,
    mode,
    controller,
    inputs,
    messages,
    pendingInputs,
    messageSources,
    modelContext,
    model,
    tokens,
    setSmartInput,
    withRecordProjection,
    appendExtensionMessage,
    startCompact,
    compactContext
  } = input;
  const sessionSource = { type: input.source };
  const writeInputRecord = async (
    content: ExtensionPromptInput,
    type: 'turn.user' | 'extension.input',
    metadata: {
      readonly source?: ExtensionInputSource;
      readonly inputSource?: 'parent_agent' | 'extension';
      readonly messageId?: string;
      readonly clientMessageId?: string;
    },
    call: ExtensionOperationContext,
    commitEvidence: (recordId: string) => void,
    projectCommitted: (
      actual: ExtensionPromptInput,
      recordId: string,
      metadata: NonNullable<ModelMessage['metadata']>
    ) => void
  ) => {
    call.signal.throwIfAborted();
    if (content.images?.length && !model().inputCapabilities.includes('IMAGE'))
      throw new AgentError(
        'MAR_AGENT_INPUT_CAPABILITY_UNSUPPORTED',
        'Selected model does not support image input.'
      );
    await withRecordProjection(async () => {
      call.signal.throwIfAborted();
      const smartPercent =
        tokens() === undefined ? undefined : (tokens()! * 100) / model().contextWindowTokens;
      const smartCompaction =
        mode !== 'compact' &&
        sessionSource.type === 'user' &&
        type === 'turn.user' &&
        metadata.inputSource === undefined &&
        smartPercent !== undefined &&
        smartPercent >= AGENT_EXECUTION_POLICY.smartCompactionPercent &&
        smartPercent < AGENT_EXECUTION_POLICY.automaticCompactionPercent;
      const modelImages = await publishModelResources(
        host,
        content.images,
        {
          sessionId,
          executionId
        },
        store
      );
      const actualContent =
        modelImages === content.images
          ? content
          : {
              ...content,
              ...(modelImages === undefined ? {} : { images: modelImages })
            };
      const images = modelImages?.length
        ? await store.persistInputImages(sessionId, modelImages)
        : [];
      const record = await store.append(
        sessionId,
        {
          type,
          payload: {
            ...metadata,
            prompt: content.text,
            ...(smartCompaction ? { smartCompaction: true } : {}),
            ...(content.modelText === undefined ? {} : { modelText: content.modelText }),
            ...(content.context === undefined ? {} : { context: content.context }),
            ...(content.modelContext === undefined ? {} : { modelContext: content.modelContext }),
            ...(images.length ? { images } : {})
          },
          executionId,
          turnId
        },
        { signal: call.signal }
      );
      commitEvidence(record.recordId);
      const inputMetadata = inputMetadataFromRecord(record);
      setSmartInput({
        recordId: record.recordId,
        eligible: smartCompaction,
        requested: false
      });
      modelContext.rememberInput({
        content: content.modelText ?? content.text,
        metadata: inputMetadata
      });
      projectCommitted(actualContent, record.recordId, inputMetadata);
      for (const text of content.modelContext ?? content.context ?? [])
        messages.push({ role: 'user', content: text, contextKind: 'contextual' });
    });
  };
  const appendMailboxMessages = async (restoring = false): Promise<boolean> =>
    inputs.drain(
      async (entry, request, call) => {
        call.signal.throwIfAborted();
        if (request.kind === 'compact') {
          if (request.input.async) {
            const flight = startCompact()(request.input);
            entry.start();
            return { changed: await flight.result, executionId };
          }
          return { changed: await compactContext()(request.input), executionId };
        }
        if (request.kind === 'append') {
          const result = await appendExtensionMessage(entry, request, call);
          return { ...result, executionId };
        }
        if (entry.nativeSteer?.recordId) {
          const received = pendingInputs.get(entry.nativeSteer.recordId);
          if (!received) return { changed: false, modelChanged: false };
          return withRecordProjection(async () => {
            call.signal.throwIfAborted();
            const payload = received.payload as Record<string, unknown>;
            const images = await store.readInputImages(sessionId, payload.images);
            if (images.length && !model().inputCapabilities.includes('IMAGE'))
              throw new AgentError(
                'MAR_AGENT_INPUT_CAPABILITY_UNSUPPORTED',
                'Selected model does not support image input.'
              );
            const percent =
              tokens() === undefined ? undefined : (tokens()! * 100) / model().contextWindowTokens;
            const eligible =
              sessionSource.type === 'user' &&
              percent !== undefined &&
              percent >= AGENT_EXECUTION_POLICY.smartCompactionPercent &&
              percent < AGENT_EXECUTION_POLICY.automaticCompactionPercent;
            const actual: Record<string, unknown> = {
              ...payload,
              ...(eligible ? { smartCompaction: true } : {})
            };
            const content = (actual.modelText ?? actual.prompt) as string;
            const applied = await store.append(
              sessionId,
              {
                type: 'model.context',
                payload: {
                  role: 'user',
                  content,
                  inputRef: received.recordId,
                  input: actual
                },
                executionId,
                turnId
              },
              { signal: call.signal }
            );
            const outcome = {
              changed: true,
              modelChanged: true,
              executionId,
              recordId: received.recordId
            };
            recordSessionInputCommit(entry, outcome);
            pendingInputs.delete(received.recordId);
            const metadata = inputMetadataFromRecord({ ...received, payload: actual });
            const message: ModelMessage = {
              role: 'user',
              content,
              metadata,
              ...(images.length ? { images } : {})
            };
            messages.push(message);
            messageSources.set(message, applied);
            modelContext.rememberInput({ content, metadata });
            setSmartInput({ recordId: received.recordId, eligible, requested: false });
            for (const text of (payload.modelContext ?? payload.context ?? []) as string[])
              messages.push({ role: 'user', content: text, contextKind: 'contextual' });
            return outcome;
          });
        }
        const parent = entry.parentMessage as SubagentMailboxMessage | undefined;
        let outcome: ExtensionSessionActionResult | undefined;
        const content: ExtensionPromptInput = {
          text: request.input.text,
          ...(request.input.modelText === undefined ? {} : { modelText: request.input.modelText }),
          ...(request.input.context === undefined ? {} : { context: request.input.context }),
          ...(request.input.modelContext === undefined
            ? {}
            : { modelContext: request.input.modelContext }),
          ...(request.input.images === undefined ? {} : { images: request.input.images })
        };
        await writeInputRecord(
          content,
          parent && !parent.delivery?.origin ? 'turn.user' : 'extension.input',
          parent && !parent.delivery?.origin
            ? {
                inputSource: 'parent_agent',
                ...(parent.delivery ? { messageId: parent.delivery.messageId } : {})
              }
            : {
                source: extensionInputSource(
                  call,
                  request.input.provenance,
                  request.input.modelAttribution
                ),
                ...(parent?.delivery ? { messageId: parent.delivery.messageId } : {})
              },
          call,
          (recordId) => {
            outcome = { changed: true, executionId, recordId };
            recordSessionInputCommit(entry, outcome);
          },
          (actual, recordId, metadata) => {
            messages.push({
              role: 'user',
              content: actual.modelText ?? actual.text,
              metadata,
              ...(actual.images?.length
                ? {
                    images: actual.images.map((image) => ({ ...image }))
                  }
                : {})
            });
            parent?.delivery?.applied();
          }
        );
        return outcome!;
      },
      {
        executionId,
        turnId,
        signal: controller.signal,
        ...(restoring ? { restoring: true as const } : {})
      },
      inputs.boundarySize
    );
  const startInitialInput = async (ports: {
    input: RunInput;
    internal: InternalExecutionOptions;
    restoredImages: boolean;
    operation<T>(action: (call: ExtensionOperationContext) => T): T;
    admit(
      content: ExtensionPromptInput,
      call: ExtensionOperationContext,
      write: (
        content: ExtensionPromptInput,
        call: ExtensionOperationContext
      ) => Promise<ExtensionPromptResult>
    ): Promise<unknown>;
    enqueue(content: ExtensionPromptInput, call: ExtensionOperationContext): Promise<unknown>;
    project(actual: ExtensionPromptInput, metadata: NonNullable<ModelMessage['metadata']>): void;
  }): Promise<boolean> => {
    if (pendingInputs.size) await appendMailboxMessages(true);
    let entered = false;
    const write = async (content: ExtensionPromptInput, call: ExtensionOperationContext) => {
      call.signal.throwIfAborted();
      if (
        (content.images?.length || ports.restoredImages) &&
        !model().inputCapabilities.includes('IMAGE')
      )
        throw new AgentError(
          'MAR_AGENT_INPUT_CAPABILITY_UNSUPPORTED',
          'Selected model does not support image input.'
        );
      if (entered) {
        await ports.enqueue(content, call);
        return {};
      }
      await modelContext.recordEnvironment();
      call.signal.throwIfAborted();
      const { internal, input: request } = ports;
      await writeInputRecord(
        content,
        internal.inputSource === 'extension' ? 'extension.input' : 'turn.user',
        {
          ...(internal.extensionSource ? { source: internal.extensionSource } : {}),
          ...(internal.delivery ? { messageId: internal.delivery.messageId } : {}),
          ...(internal.inputSource === undefined ? {} : { inputSource: internal.inputSource }),
          ...(request.clientMessageId ? { clientMessageId: request.clientMessageId } : {})
        },
        call,
        (recordId) => {
          entered = true;
          internal.inputCommitted?.(recordId);
        },
        (actual, _recordId, metadata) => {
          ports.project(actual, metadata);
          internal.delivery?.applied();
        }
      );
      return {};
    };
    const { input: request, internal } = ports;
    const content: ExtensionPromptInput = {
      text: request.prompt,
      ...(internal.modelText === undefined ? {} : { modelText: internal.modelText }),
      ...(internal.inputContext === undefined ? {} : { context: internal.inputContext }),
      ...(internal.modelContext === undefined ? {} : { modelContext: internal.modelContext }),
      ...(request.images === undefined ? {} : { images: request.images })
    };
    await ports.operation((call) =>
      internal.promptAdmitted ? write(content, call) : ports.admit(content, call, write)
    );
    return entered;
  };
  const receiveSteer = (
    content: ExtensionPromptInput,
    clientMessageId: string,
    call: ExtensionOperationContext
  ) =>
    withRecordProjection(async () => {
      call.signal.throwIfAborted();
      if (content.images?.length && !model().inputCapabilities.includes('IMAGE'))
        throw new AgentError(
          'MAR_AGENT_INPUT_CAPABILITY_UNSUPPORTED',
          'Selected model does not support image input.'
        );
      const modelImages = await publishModelResources(
        host,
        content.images,
        { sessionId, executionId },
        store
      );
      const images = modelImages?.length
        ? await store.persistInputImages(sessionId, modelImages)
        : [];
      const record = await store.append(
        sessionId,
        {
          type: 'turn.user',
          payload: {
            deferred: true,
            prompt: content.text,
            ...(content.modelText === undefined ? {} : { modelText: content.modelText }),
            ...(content.context === undefined ? {} : { context: content.context }),
            ...(content.modelContext === undefined ? {} : { modelContext: content.modelContext }),
            clientMessageId,
            ...(images.length ? { images } : {})
          },
          executionId,
          turnId
        },
        { signal: call.signal }
      );
      pendingInputs.set(record.recordId, record);
      return record;
    });
  const appendSubagentUpdates = async (
    subagents: Pick<SubagentSessionController, 'collectModelUpdates'> | undefined
  ) => {
    if (!subagents) return;
    await withRecordProjection(async () => {
      controller.signal.throwIfAborted();
      for (const update of subagents.collectModelUpdates()) {
        controller.signal.throwIfAborted();
        const message: ModelMessage = {
          role: 'user',
          content: renderSubagentUpdate(update.snapshot, update.truncated),
          contextKind: 'contextual'
        };
        const stored = await store.append(
          sessionId,
          { type: 'model.context', payload: message, executionId, turnId },
          { signal: controller.signal }
        );
        messages.push(message);
        messageSources.set(message, stored);
        update.acknowledge();
      }
    });
  };
  return { startInitialInput, receiveSteer, appendSubagentUpdates, appendMailboxMessages };
}

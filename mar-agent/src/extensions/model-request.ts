import type { SessionModelMessage as ModelMessage } from '../session/model-request.js';
import type { SessionModelRequest as ModelRequest } from '../session/model-request.js';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { AgentReasoningEffort } from '../model/configuration.js';
import type { ModelTextBlock } from '../model/contracts.js';
import { resolveModelTextBlocks } from '../model/text-blocks.js';
import type { ClientToolDefinition } from '../tools/contracts.js';
import { orderToolDefinitions, stableToolDefinition } from '../model/tool-definition-projection.js';
import { AgentError } from '../error.js';

/** Provider-private context is retained through opaque references, never exposed as payloads. */
export type ExtensionModelMessage =
  | { readonly role: 'opaque'; readonly sourceRef: string }
  | {
      readonly role: 'user' | 'assistant' | 'tool' | 'tool_call';
      readonly content: string;
      readonly textBlocks?: readonly ModelTextBlock[];
      readonly sourceRef?: string;
      readonly callId?: string;
      readonly name?: string;
      readonly arguments?: unknown;
      readonly images?: readonly import('../model/image.js').ModelImage[];
    };
export interface ExtensionModelRequest {
  readonly modelId: string;
  readonly system: string;
  readonly systemBlocks?: readonly ModelTextBlock[];
  readonly messages: readonly ExtensionModelMessage[];
  readonly tools: readonly ClientToolDefinition[];
  readonly toolChoice?: 'auto' | 'none';
  readonly reasoningEffort?: AgentReasoningEffort;
  readonly images?: readonly import('../model/image.js').ModelImage[];
}

export interface ExtensionRequestSnapshot {
  readonly id: string;
  readonly request: ExtensionModelRequest;
}

/** Only actual SDK model dispatch records snapshots; public views carry no raw payload authority. */
export class ExtensionRequestSnapshots {
  readonly #requests = new WeakMap<
    ExtensionRequestSnapshot,
    { modelId: string; request: ModelRequest }
  >();
  #current: ExtensionRequestSnapshot | undefined;
  #completed: ExtensionRequestSnapshot | undefined;

  record(modelId: string, request: ModelRequest): ExtensionRequestSnapshot {
    const {
      onAttemptDiagnostic: _diagnostic,
      onModelUsage: _usage,
      onModelUsageFailure: _usageFailure,
      usageRequestId: _usageRequestId,
      ...serializable
    } = request;
    const retained = structuredClone(serializable);
    let view: ExtensionModelRequest | undefined;
    // Preserve dispatch-time isolation without projecting unused public views.
    const snapshot = Object.freeze({
      id: randomUUID(),
      get request(): ExtensionModelRequest {
        return (view ??= freezeSnapshot(new ExtensionRequestBridge(modelId, retained).view));
      }
    });
    this.#requests.set(snapshot, { modelId, request: retained });
    this.#current = snapshot;
    return snapshot;
  }
  complete(snapshot: ExtensionRequestSnapshot): void {
    if (!this.#requests.has(snapshot))
      throw new AgentError('MAR_AGENT_MODEL_SNAPSHOT_INVALID', 'Request snapshot is unavailable.');
    this.#completed = snapshot;
  }
  capture(input: { readonly completed?: boolean } = {}): ExtensionRequestSnapshot | undefined {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      (input.completed !== undefined && typeof input.completed !== 'boolean')
    )
      throw new AgentError(
        'MAR_AGENT_MODEL_SNAPSHOT_INVALID',
        'Request snapshot selection is invalid.'
      );
    return input.completed === true ? this.#completed : this.#current;
  }
  resolve(snapshot: ExtensionRequestSnapshot): {
    modelId: string;
    request: ModelRequest;
    view: ExtensionModelRequest;
  } {
    const entry = this.#requests.get(snapshot);
    if (!entry)
      throw new AgentError(
        'MAR_AGENT_MODEL_SNAPSHOT_INVALID',
        'Request snapshot does not belong to the current Session.'
      );
    return {
      modelId: entry.modelId,
      request: structuredClone(entry.request),
      view: snapshot.request
    };
  }
}

function freezeSnapshot<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeSnapshot(child);
    Object.freeze(value);
  }
  return value;
}

/** One conversion per actual request; references are valid only for this candidate. */
export class ExtensionRequestBridge {
  readonly #messages = new Map<
    string,
    { original: ModelMessage; view: ExtensionModelMessage; index: number }
  >();
  rewroteCommittedInput = false;
  readonly view: ExtensionModelRequest;
  constructor(
    readonly modelId: string,
    readonly original: ModelRequest,
    sourceMessages?: readonly ExtensionModelMessage[],
    private readonly committedPrefix = 0
  ) {
    const messages = original.messages.map((original, index): ExtensionModelMessage => {
      const sourceRef = sourceMessages?.[index]?.sourceRef ?? randomUUID();
      const view: ExtensionModelMessage =
        original.role === 'provider'
          ? { role: 'opaque', sourceRef }
          : {
              role: original.role,
              content: original.content,
              ...(original.textBlocks === undefined
                ? {}
                : { textBlocks: structuredClone(original.textBlocks) }),
              sourceRef,
              ...(original.callId !== undefined ? { callId: original.callId } : {}),
              ...(original.name !== undefined ? { name: original.name } : {}),
              ...(original.arguments !== undefined
                ? { arguments: structuredClone(original.arguments) }
                : {}),
              ...(original.images !== undefined ? { images: structuredClone(original.images) } : {})
            };
      this.#messages.set(sourceRef, { original, view: structuredClone(view), index });
      return view;
    });
    this.view = {
      modelId,
      system: original.system,
      ...(original.systemBlocks === undefined
        ? {}
        : { systemBlocks: structuredClone(original.systemBlocks) }),
      messages,
      tools: structuredClone(original.tools),
      ...(original.toolChoice ? { toolChoice: original.toolChoice } : {}),
      ...(original.reasoningEffort ? { reasoningEffort: original.reasoningEffort } : {}),
      ...(original.images ? { images: structuredClone(original.images) } : {})
    };
  }

  lower(view: ExtensionModelRequest): ModelRequest {
    if (
      !view ||
      view.modelId !== this.modelId ||
      typeof view.system !== 'string' ||
      !Array.isArray(view.messages) ||
      !Array.isArray(view.tools) ||
      view.tools.some(
        (tool) =>
          !tool ||
          typeof tool !== 'object' ||
          typeof tool.name !== 'string' ||
          typeof tool.description !== 'string' ||
          !tool.inputSchema ||
          typeof tool.inputSchema !== 'object' ||
          Array.isArray(tool.inputSchema)
      )
    )
      throw new AgentError(
        'MAR_AGENT_EXTENSION_MODEL_REQUEST_INVALID',
        'Model request view is invalid.'
      );
    const seen = new Set<string>();
    if (
      view.messages.length < this.committedPrefix ||
      view.system !== this.original.system ||
      !isDeepStrictEqual(view.systemBlocks, this.original.systemBlocks)
    )
      this.rewroteCommittedInput = true;
    const messages = view.messages.map((message, index): ModelMessage => {
      if (!message || typeof message !== 'object')
        throw new AgentError(
          'MAR_AGENT_EXTENSION_MODEL_REQUEST_INVALID',
          'Message view is invalid.'
        );
      const source = message.sourceRef ? this.#messages.get(message.sourceRef) : undefined;
      if (message.sourceRef) {
        if (!source || seen.has(message.sourceRef))
          throw new AgentError(
            'MAR_AGENT_EXTENSION_MODEL_REQUEST_INVALID',
            'Message source reference is invalid.'
          );
        seen.add(message.sourceRef);
      }
      if (index < this.committedPrefix && source?.index !== index)
        this.rewroteCommittedInput = true;
      if (source && isDeepStrictEqual(message, source.view)) return source.original;
      if (index < this.committedPrefix) this.rewroteCommittedInput = true;
      if (
        message.role === 'opaque' ||
        typeof message.content !== 'string' ||
        !['user', 'assistant', 'tool', 'tool_call'].includes(message.role)
      )
        throw new AgentError(
          'MAR_AGENT_EXTENSION_MODEL_REQUEST_INVALID',
          'Message view is invalid.'
        );
      if (message.textBlocks !== undefined && message.role === 'tool_call')
        throw new AgentError(
          'MAR_AGENT_MODEL_CAPABILITY_UNAVAILABLE',
          'Text blocks cannot replace structured tool-call arguments.'
        );
      return {
        role: message.role,
        content: message.content,
        ...(source && message.role === source.original.role
          ? {
              ...(source.original.contextKind === undefined
                ? {}
                : { contextKind: source.original.contextKind }),
              ...(source.original.contextualBlock === undefined
                ? {}
                : { contextualBlock: source.original.contextualBlock }),
              ...(source.original.metadata === undefined
                ? {}
                : { metadata: source.original.metadata })
            }
          : {}),
        ...(message.textBlocks === undefined
          ? {}
          : { textBlocks: resolveModelTextBlocks(message.content, message.textBlocks) }),
        ...(message.callId !== undefined ? { callId: message.callId } : {}),
        ...(message.name !== undefined ? { name: message.name } : {}),
        ...(message.role === 'tool' &&
        source?.original.role === 'tool' &&
        message.callId === source.original.callId &&
        message.name === source.original.name &&
        source.original.isError !== undefined
          ? { isError: source.original.isError }
          : {}),
        ...(message.arguments !== undefined
          ? { arguments: structuredClone(message.arguments) }
          : {}),
        ...(message.images !== undefined ? { images: structuredClone(message.images) } : {})
      };
    });
    const {
      toolChoice: _toolChoice,
      reasoningEffort: _reasoningEffort,
      images: _images,
      systemBlocks: _systemBlocks,
      ...retained
    } = this.original;
    // Middleware selects declarations; it must not reorder a retained discovery prefix.
    const order = new Map(this.original.tools.map((tool, index) => [tool.name, index]));
    const tools = orderToolDefinitions(structuredClone(view.tools))
      .sort(
        (left, right) =>
          (order.get(left.name) ?? order.size) - (order.get(right.name) ?? order.size)
      )
      .map(stableToolDefinition);
    return {
      ...retained,
      system: view.system,
      ...(view.systemBlocks === undefined
        ? {}
        : { systemBlocks: resolveModelTextBlocks(view.system, view.systemBlocks) }),
      messages,
      tools,
      ...(view.toolChoice ? { toolChoice: view.toolChoice } : {}),
      ...(view.reasoningEffort ? { reasoningEffort: view.reasoningEffort } : {}),
      ...(view.images ? { images: structuredClone(view.images) } : {})
    };
  }
}

export interface DomainModelRequestOperations {
  'model.request': { input: ExtensionModelRequest; output: ExtensionModelRequest };
}
export type DomainModelRequestFacts = Record<never, never>;

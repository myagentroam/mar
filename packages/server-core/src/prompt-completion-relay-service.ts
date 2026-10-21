import { createHash } from 'node:crypto';
import {
  promptCompletionContextInputSchema,
  promptCompletionContextSchema,
  promptCompletionGenerateInputSchema,
  promptCompletionResponseSchema,
  resolveMarAgentDefaultReasoningEffort,
  type PromptCompletionCancel,
  type PromptCompletionConfiguration,
  type PromptCompletionGenerateInput,
  type PromptCompletionResponse,
  type PromptCompletionTarget
} from '@myagentroam/protocol';
import type { CurrentUserSession } from './session.js';
import type { MarAgentRuntimeModelService } from './mar-agent-runtime-model-service.js';

export class PromptCompletionAccessError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode = 409
  ) {
    super('The prompt completion request could not be completed.');
  }
}

export interface CompletionResourceAuthorization {
  readonly workspaceId: string;
  readonly authorizationView: string;
  readonly revalidate: () => Promise<void>;
}

interface CompletionRelayOptions {
  readonly settings: {
    readConfiguration(): Promise<PromptCompletionConfiguration>;
  };
  readonly runtimeModels: Pick<MarAgentRuntimeModelService, 'preparePromptCompletion'>;
  readonly ownsConnection: (sessionHash: string, connectionId: string) => boolean;
  readonly available: (
    nodeId: string,
    trigger?: PromptCompletionGenerateInput['request']['trigger']
  ) => Promise<boolean>;
  readonly authorize: (
    actor: CurrentUserSession,
    nodeId: string,
    target: PromptCompletionTarget
  ) => Promise<CompletionResourceAuthorization>;
  readonly canUseModel: (userId: number, modelId: string) => Promise<boolean>;
  readonly forward: (
    actor: CurrentUserSession,
    nodeId: string,
    target: PromptCompletionTarget,
    operation: 'context' | 'generate' | 'cancel',
    data: unknown,
    workspaceId?: string
  ) => Promise<unknown>;
  readonly now?: () => number;
}

interface Intent {
  readonly userId: number;
  readonly sessionHash: string;
  readonly connectionId: string;
  readonly nodeId: string;
  readonly requestId: string;
  readonly sequence: number;
  expiresAt: number;
  readonly fingerprint?: string;
  cancelled: boolean;
  pending?: Promise<PromptCompletionResponse>;
}

/** Registers intent before asynchronous authorization; never stores draft or model configuration. */
export class PromptCompletionRelayService {
  private readonly intents = new Map<string, Intent>();
  private readonly now: () => number;
  constructor(private readonly options: CompletionRelayOptions) {
    this.now = options.now ?? Date.now;
  }

  async context(actor: CurrentUserSession, nodeId: string, raw: unknown) {
    const input = promptCompletionContextInputSchema.parse(raw);
    this.requireConnection(actor, input.workbenchConnectionId);
    await this.requireEnabled();
    if (!(await this.options.available(nodeId)))
      throw new PromptCompletionAccessError('PROMPT_COMPLETION_UNAVAILABLE');
    const resource = await this.options.authorize(actor, nodeId, input.target);
    this.requireConnection(actor, input.workbenchConnectionId);
    return promptCompletionContextSchema.parse(
      await this.options.forward(
        actor,
        nodeId,
        input.target,
        'context',
        input,
        resource.workspaceId
      )
    );
  }

  generate(
    actor: CurrentUserSession,
    nodeId: string,
    raw: unknown
  ): Promise<PromptCompletionResponse> {
    const input = promptCompletionGenerateInputSchema.parse(raw);
    this.prune();
    const key = intentKey(actor, input.request.pageEpoch);
    const previous = this.intents.get(key);
    if (previous && input.request.intentSequence <= previous.sequence) {
      if (
        input.request.intentSequence === previous.sequence &&
        input.request.requestId === previous.requestId &&
        previous.nodeId === nodeId &&
        previous.connectionId === input.workbenchConnectionId &&
        !previous.cancelled &&
        previous.pending
      )
        return previous.fingerprint === digest(input)
          ? previous.pending
          : Promise.resolve(response(input, 'cancelled'));
      return Promise.resolve(response(input, 'cancelled'));
    }
    if (previous?.pending && !previous.cancelled)
      return Promise.resolve(response(input, 'skipped', 'IN_FLIGHT'));
    this.requireCapacity(actor.userId, key);
    const intent: Intent = {
      userId: actor.userId,
      sessionHash: actor.sessionHash,
      connectionId: input.workbenchConnectionId,
      nodeId,
      requestId: input.request.requestId,
      sequence: input.request.intentSequence,
      expiresAt: this.now() + 60_000,
      fingerprint: digest(input),
      cancelled: false
    };
    this.intents.set(key, intent);
    const pending = Promise.resolve().then(() => this.execute(actor, nodeId, input, intent));
    intent.pending = pending.finally(() => {
      delete intent.pending;
    });
    return intent.pending;
  }

  async cancel(
    actor: CurrentUserSession,
    nodeId: string,
    target: PromptCompletionTarget,
    connectionId: string,
    request: PromptCompletionCancel
  ): Promise<void> {
    this.prune();
    const key = intentKey(actor, request.pageEpoch);
    const previous = this.intents.get(key);
    if (previous && request.intentSequence < previous.sequence) return;
    if (
      previous &&
      request.intentSequence === previous.sequence &&
      (request.requestId !== previous.requestId || previous.nodeId !== nodeId)
    )
      return;
    this.requireCapacity(actor.userId, key);
    if (previous && request.intentSequence === previous.sequence) {
      previous.cancelled = true;
      previous.expiresAt = this.now() + 60_000;
    } else
      this.intents.set(key, {
        userId: actor.userId,
        sessionHash: actor.sessionHash,
        connectionId,
        nodeId,
        requestId: request.requestId,
        sequence: request.intentSequence,
        expiresAt: this.now() + 60_000,
        cancelled: true
      });
    // This fixed operation reads nothing; fresh model/resource authorization is deliberately unnecessary.
    await this.options.forward(actor, nodeId, target, 'cancel', request);
  }

  dispose(): void {
    for (const intent of this.intents.values()) intent.cancelled = true;
    this.intents.clear();
  }

  private async execute(
    actor: CurrentUserSession,
    nodeId: string,
    input: PromptCompletionGenerateInput,
    intent: Intent
  ): Promise<PromptCompletionResponse> {
    const deadline = this.now() + 12_000;
    const current = () =>
      !intent.cancelled &&
      this.now() < deadline &&
      this.intents.get(intentKey(actor, input.request.pageEpoch)) === intent &&
      this.options.ownsConnection(actor.sessionHash, input.workbenchConnectionId);
    if (!current()) return response(input, 'cancelled');
    const configuration = await this.requireEnabled();
    if (!current()) return response(input, 'cancelled');
    if (!(await this.options.available(nodeId, input.request.trigger)))
      throw new PromptCompletionAccessError('PROMPT_COMPLETION_UNAVAILABLE');
    const resource = await this.options.authorize(actor, nodeId, input.target);
    if (!current()) return response(input, 'cancelled');
    const prepared = await this.options.runtimeModels.preparePromptCompletion({
      userId: actor.userId,
      nodeId,
      workspaceId: resource.workspaceId,
      selectedModelId: configuration.modelId!
    });
    if (!current()) return response(input, 'cancelled');
    const reasoningEffort =
      configuration.reasoningEffort ??
      resolveMarAgentDefaultReasoningEffort(
        prepared.model.defaultReasoningEffort,
        prepared.model.reasoningEfforts
      );
    if (
      prepared.model.reasoningEfforts.length > 0 &&
      !prepared.model.reasoningEfforts.includes(reasoningEffort)
    )
      throw new PromptCompletionAccessError('PROMPT_COMPLETION_EFFORT_UNAVAILABLE');
    const { credential, ...modelIdentity } = prepared.model;
    const credentialIdentity = credential
      ? { type: credential.type, credentialId: credential.credentialId }
      : null;
    const modelRevision = digest([configuration, modelIdentity, credentialIdentity]);
    await resource.revalidate();
    if (digest(await this.requireEnabled()) !== digest(configuration))
      return response(input, 'skipped', 'UNAVAILABLE');
    if (!current()) return response(input, 'cancelled');
    const runtime = {
      ...prepared,
      workspaceId: resource.workspaceId,
      authorizationView: resource.authorizationView,
      expiresAt: this.now() + 5 * 60_000,
      reasoningEffort,
      modelRevision,
      credentialScope: digest([
        actor.userId,
        nodeId,
        resource.workspaceId,
        credentialIdentity,
        prepared.model.id
      ])
    };
    const result = promptCompletionResponseSchema.parse(
      await this.options.forward(
        actor,
        nodeId,
        input.target,
        'generate',
        { ...input, runtime },
        resource.workspaceId
      )
    );
    if (!current()) return response(input, 'cancelled');
    if (digest(await this.requireEnabled()) !== digest(configuration))
      return response(input, 'skipped', 'UNAVAILABLE');
    await resource.revalidate();
    if (!(await this.options.canUseModel(actor.userId, configuration.modelId!)))
      throw new PromptCompletionAccessError('MAR_AGENT_MODEL_FORBIDDEN', 403);
    if (!current()) return response(input, 'cancelled');
    if (
      result.requestId !== input.request.requestId ||
      result.draftRevision !== input.request.draftRevision ||
      result.cursorPosition !== input.request.cursorPosition ||
      result.contextVersion !== input.request.contextVersion ||
      result.historyGeneration !== input.request.historyGeneration
    )
      throw new PromptCompletionAccessError('PROMPT_COMPLETION_RESPONSE_INVALID', 502);
    return result;
  }

  private async requireEnabled() {
    const configuration = await this.options.settings.readConfiguration();
    if (!configuration.enabled) throw new PromptCompletionAccessError('PROMPT_COMPLETION_DISABLED');
    if (configuration.modelId === null)
      throw new PromptCompletionAccessError('PROMPT_COMPLETION_MODEL_REQUIRED');
    return configuration;
  }

  private requireConnection(actor: CurrentUserSession, connectionId: string): void {
    if (!this.options.ownsConnection(actor.sessionHash, connectionId))
      throw new PromptCompletionAccessError('WORKBENCH_CONNECTION_NOT_FOUND', 403);
  }

  private requireCapacity(userId: number, key: string): void {
    if (this.intents.has(key)) return;
    if (
      this.intents.size >= 4096 ||
      [...this.intents.values()].filter((value) => value.userId === userId).length >= 128
    )
      throw new PromptCompletionAccessError('PROMPT_COMPLETION_CAPACITY', 429);
  }

  private prune(): void {
    for (const [key, intent] of this.intents)
      if (!intent.pending && intent.expiresAt <= this.now()) this.intents.delete(key);
  }
}

function intentKey(actor: CurrentUserSession, pageEpoch: string): string {
  return JSON.stringify([actor.userId, actor.sessionHash, pageEpoch]);
}
function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function response(
  input: PromptCompletionGenerateInput,
  status: 'cancelled' | 'skipped',
  reason?: Extract<PromptCompletionResponse, { status: 'skipped' }>['reason']
): PromptCompletionResponse {
  const identity = {
    requestId: input.request.requestId,
    contextVersion: input.request.contextVersion,
    historyGeneration: input.request.historyGeneration,
    draftRevision: input.request.draftRevision,
    cursorPosition: input.request.cursorPosition
  };
  return status === 'cancelled'
    ? { ...identity, status }
    : { ...identity, status, reason: reason ?? 'UNAVAILABLE' };
}

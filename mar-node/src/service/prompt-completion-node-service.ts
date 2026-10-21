import { createHash, randomUUID } from 'node:crypto';
import { PromptCompletionJournal } from './prompt-completion-journal.js';
import type { generatePromptCompletion } from './prompt-completion-generator.js';
import {
  promptCompletionContextInputSchema,
  promptCompletionGenerateInputSchema,
  promptCompletionRuntimeSchema,
  promptCompletionCancelSchema,
  modelUsageGrantSchema,
  type ModelUsageGrant,
  type PromptCompletionContextInput,
  type PromptCompletionRuntime,
  type PromptCompletionTarget,
  type RunnerName
} from '@myagentroam/protocol';
import type { NodeOperationHandler } from '../connector/node-operation-router.js';
import type { NodeConversationTurn } from '../runtime-model.js';
import type { MarAgentRuntimeModelFactory } from '../runner/mar-agent/runtime-model-factory.js';
import { PromptCompletionCache, type CompletionReference } from './prompt-completion-cache.js';
import { projectCompletionContext } from './prompt-completion-context.js';
import {
  withPredictionTaskState,
  type PredictionTaskState
} from './prompt-completion-task-context.js';
import { projectPredictionAttention } from './prompt-completion-attention.js';
import {
  PromptCompletionService,
  type CompletionAuthorization
} from './prompt-completion-service.js';
import type { NodeModelUsageService } from './model-usage-service.js';

export interface CompletionActor {
  readonly userId: number;
  readonly sessionHash: string;
}

interface CompletionNodeOptions {
  readonly readAttentionFile?: (
    input: PromptCompletionContextInput,
    actor: CompletionActor,
    event: import('@myagentroam/protocol').PromptCompletionAttention
  ) => Promise<unknown>;
  readonly taskState?: (
    input: PromptCompletionContextInput,
    actor: CompletionActor
  ) => PredictionTaskState;
  readonly generation: () => string;
  /** Checks the existing Watch owner, selected resource and lease without renewing it. */
  readonly observed: (input: PromptCompletionContextInput, actor: CompletionActor) => boolean;
  /** Uses the existing normalized reader and rejects Session/Runner/Workspace mismatches. */
  readonly readPage: (
    input: PromptCompletionContextInput,
    actor: CompletionActor,
    signal: AbortSignal
  ) => Promise<readonly NodeConversationTurn[]>;
  /** Reads bounded reference history from the authorized Workspace. */
  readonly references: (
    workspaceId: string,
    actor: CompletionActor,
    signal: AbortSignal
  ) => Promise<readonly CompletionReference[]>;
  readonly modelFactory: Pick<MarAgentRuntimeModelFactory, 'create'>;
  readonly usage: Pick<NodeModelUsageService, 'completion'>;
  readonly generate?: typeof generatePromptCompletion;
  readonly now?: () => number;
}

interface AuthorizedCompletion extends CompletionAuthorization {
  readonly usageGrant: ModelUsageGrant;
  readonly actor: CompletionActor;
  readonly input: PromptCompletionContextInput;
  readonly runtime: PromptCompletionRuntime;
}

/** Owns the auxiliary domain; Connector only supplies existing readers and lifecycle hooks. */
export class PromptCompletionNodeService {
  private readonly cache: PromptCompletionCache;
  private journal: PromptCompletionJournal | undefined;
  private readonly requests: PromptCompletionService;
  private readonly contextReaders = new Map<number, AbortController>();
  private disposed = false;
  private readonly refreshTimer: NodeJS.Timeout;
  private readonly generations = new Map<
    string,
    { generation: string; target: PromptCompletionTarget }
  >();
  private readonly now: () => number;

  constructor(private readonly options: CompletionNodeOptions) {
    this.now = options.now ?? Date.now;
    this.cache = new PromptCompletionCache({ now: this.now });
    this.requests = new PromptCompletionService({
      record: async (entry) => {
        await this.journal?.record(entry);
      },
      now: this.now,
      modelFactory: options.modelFactory,
      ...(options.generate ? { generate: options.generate } : {}),
      authorized: (raw) => {
        const authorization = raw as AuthorizedCompletion;
        return this.options.observed(authorization.input, authorization.actor);
      },
      context: async (raw, request, signal) => {
        const authorization = raw as AuthorizedCompletion;
        signal.throwIfAborted();
        const context = await this.readContext(authorization.input, authorization.actor, signal);
        const sessionId = authorization.input.sessionId;
        return {
          ...context,
          ...(request.attention?.length && this.options.readAttentionFile
            ? {
                attention: await projectPredictionAttention(
                  request.attention,
                  (event) =>
                    this.options.readAttentionFile!(
                      authorization.input,
                      authorization.actor,
                      event
                    ),
                  signal,
                  this.now()
                )
              }
            : {}),
          history:
            sessionId === null
              ? context.history
              : this.cache.session(
                  authorization.scope,
                  sessionId,
                  context.identity.historyGeneration,
                  context.history
                )
        };
      },
      references: async (raw, _request, signal) => {
        const authorization = raw as AuthorizedCompletion;
        // The refresh closure captures only authorized resource metadata, never the draft.
        const { actor, input, scope, expiresAt } = authorization;
        const lease = { expiresAt, valid: () => this.options.observed(input, actor) };
        const result = await this.cache.references(scope, input.sessionId, lease, (readSignal) =>
          this.options.references(scope.workspaceId, actor, readSignal)
        );
        signal.throwIfAborted();
        return result.messages;
      },
      usage: (raw) => {
        const authorization = raw as AuthorizedCompletion;
        return this.options.usage.completion(
          authorization.executionId,
          authorization.usageGrant,
          authorization.input.sessionId ?? authorization.executionId,
          authorization.actor.userId
        );
      }
    });
    this.refreshTimer = setInterval(() => {
      this.cache.sweep();
    }, 30_000);
    this.refreshTimer.unref?.();
  }

  operations(): Readonly<Record<string, NodeOperationHandler>> {
    return {
      'prompt-completion.context': (raw) => this.context(raw),
      'prompt-completion.generate': (raw) => this.generate(raw),
      'prompt-completion.cancel': (raw) => this.cancel(raw)
    };
  }

  private async context(raw: unknown) {
    if (this.disposed) throw new Error('PROMPT_COMPLETION_UNAVAILABLE');
    const { actor, data } = unpack(raw);
    const input = promptCompletionContextInputSchema.parse(data);
    if (this.contextReaders.has(actor.userId) || this.contextReaders.size >= 2)
      throw new Error('PROMPT_COMPLETION_CONTEXT_BUSY');
    const controller = new AbortController();
    this.contextReaders.set(actor.userId, controller);
    const timer = setTimeout(() => controller.abort(), 1_000);
    timer.unref?.();
    const signal = controller.signal;
    const pending = this.readContext(input, actor, signal)
      .then((context) => context.identity)
      .finally(() => {
        clearTimeout(timer);
        this.contextReaders.delete(actor.userId);
      });
    return new Promise<Awaited<typeof pending>>((resolve, reject) => {
      const abort = () => reject(new Error('PROMPT_COMPLETION_CONTEXT_TIMEOUT'));
      signal.addEventListener('abort', abort, { once: true });
      pending.then(
        (value) => {
          signal.removeEventListener('abort', abort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener('abort', abort);
          reject(error);
        }
      );
      if (signal.aborted) abort();
    });
  }

  private generate(raw: unknown) {
    const { actor, data, usageGrant } = unpack(raw);
    const { runtime: rawRuntime, ...publicInput } = data;
    const input = promptCompletionGenerateInputSchema.parse(publicInput);
    const runtime = promptCompletionRuntimeSchema.parse(rawRuntime);
    if (input.target.kind === 'WORKSPACE' && input.target.workspaceId !== runtime.workspaceId)
      throw new Error('PROMPT_COMPLETION_AUTHORIZATION_INVALID');
    const descriptor: PromptCompletionContextInput = {
      target: input.target,
      runner: input.request.runner,
      sessionId: input.request.sessionId,
      workbenchConnectionId: input.workbenchConnectionId,
      pageEpoch: input.request.pageEpoch
    };
    const authorization: AuthorizedCompletion = {
      ...runtime,
      usageGrant: modelUsageGrantSchema.parse(usageGrant),
      userId: String(actor.userId),
      actor,
      input: descriptor,
      runtime,
      scope: {
        workspaceId: runtime.workspaceId,
        generation: this.options.generation(),
        authorizationView: digest([runtime.authorizationView, input.target])
      },
      executionId: randomUUID()
    };
    return this.requests.generate(
      { ...input.request, pageEpoch: epoch(actor, descriptor.pageEpoch) },
      authorization
    );
  }

  private cancel(raw: unknown) {
    const { actor, data } = unpack(raw);
    const input = promptCompletionCancelSchema.parse(data);
    this.requests.cancel(String(actor.userId), {
      ...input,
      pageEpoch: epoch(actor, input.pageEpoch)
    });
    return { cancelled: true };
  }

  private async readContext(
    input: PromptCompletionContextInput,
    actor: CompletionActor,
    signal: AbortSignal
  ) {
    if (!this.options.observed(input, actor))
      throw new Error('PROMPT_COMPLETION_CONTEXT_UNAVAILABLE');
    const generation = this.historyGeneration(input.target, input.sessionId, input.runner);
    const turns = await this.options.readPage(input, actor, signal);
    signal.throwIfAborted();
    if (
      !this.options.observed(input, actor) ||
      generation !== this.historyGeneration(input.target, input.sessionId, input.runner)
    )
      throw new Error('PROMPT_COMPLETION_CONTEXT_UNAVAILABLE');
    const context = projectCompletionContext(turns, generation);
    return this.options.taskState
      ? withPredictionTaskState(context, this.options.taskState(input, actor))
      : context;
  }

  initializeJournal(dataDirectory: string): void {
    this.journal?.dispose();
    this.journal = new PromptCompletionJournal(dataDirectory, this.now);
  }

  sweep(): void {
    this.cache.sweep();
  }

  disconnect(): void {
    for (const controller of this.contextReaders.values()) controller.abort();
    this.requests.disconnect();
    this.cache.clear();
    this.generations.clear();
  }

  invalidateWorkspace(workspaceId: string): void {
    this.cache.invalidateWorkspace(workspaceId);
    this.requests.invalidateWorkspace(workspaceId);
    for (const [key, entry] of this.generations)
      if (entry.target.kind === 'WORKSPACE' && entry.target.workspaceId === workspaceId)
        this.generations.delete(key);
  }

  invalidateUser(userId: number): void {
    this.requests.invalidateUser(String(userId));
    // Permission changes retire all reference views; they can be rebuilt after fresh authorization.
    this.cache.clear();
  }

  invalidateSession(workspaceId: string, sessionId: string): void {
    // Retire source material without interrupting an already frozen prediction request.
    this.cache.invalidateSession(workspaceId, sessionId);
  }

  releasePage(actor: CompletionActor, pageEpoch: string): void {
    this.requests.releasePage(String(actor.userId), epoch(actor, pageEpoch));
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.refreshTimer);
    for (const controller of this.contextReaders.values()) controller.abort();
    this.requests.dispose();
    this.journal?.dispose();
    this.cache.dispose();
    this.generations.clear();
  }

  private historyGeneration(
    target: PromptCompletionTarget,
    sessionId: string | null,
    runner: RunnerName
  ): string {
    const key = digest([this.options.generation(), target, sessionId, runner]);
    let entry = this.generations.get(key);
    if (!entry) {
      entry = { generation: randomUUID(), target };
      this.generations.set(key, entry);
    }
    while (this.generations.size > 256)
      this.generations.delete(this.generations.keys().next().value!);
    return entry.generation;
  }
}

function unpack(raw: unknown): {
  actor: CompletionActor;
  data: Record<string, unknown>;
  usageGrant: unknown;
} {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('MESSAGE_INVALID');
  const { __requestUserId, __workspaceWatchSessionHash, __usageGrant, ...data } = raw as Record<
    string,
    unknown
  >;
  if (
    typeof __requestUserId !== 'number' ||
    !Number.isSafeInteger(__requestUserId) ||
    __requestUserId <= 0 ||
    typeof __workspaceWatchSessionHash !== 'string' ||
    !__workspaceWatchSessionHash
  )
    throw new Error('USER_AUTHORIZATION_REQUIRED');
  return {
    actor: { userId: __requestUserId, sessionHash: __workspaceWatchSessionHash },
    data,
    usageGrant: __usageGrant
  };
}
function epoch(actor: CompletionActor, pageEpoch: string): string {
  return digest([actor.sessionHash, pageEpoch]);
}
function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

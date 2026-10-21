import { createHash, randomUUID } from 'node:crypto';
import {
  generatePromptCompletion,
  type GeneratePromptCompletionInput
} from './prompt-completion-generator.js';
import {
  promptCompletionRequestSchema,
  promptCompletionCancelSchema,
  type PromptCompletionRequest,
  type PromptCompletionCancel,
  type PromptCompletionResponse,
  type MarAgentRuntimeModelConfiguration,
  type MarAgentReasoningEffort
} from '@myagentroam/protocol';
import type { MarAgentRuntimeModelFactory } from '../runner/mar-agent/runtime-model-factory.js';
import type { CompletionCacheScope } from './prompt-completion-cache.js';
import type { CompletionContextProjection } from './prompt-completion-context.js';

// Keep cancellation watermarks longer than the five-minute runtime authorization.
const PAGE_INTENT_TTL_MS = 6 * 60_000;

export interface CompletionAuthorization {
  readonly userId: string;
  readonly scope: CompletionCacheScope;
  readonly expiresAt: number;
  readonly model: MarAgentRuntimeModelConfiguration;
  readonly modelRevision: string;
  readonly credentialScope: string;
  readonly reasoningEffort: MarAgentReasoningEffort;
  readonly runtimeScopeId: string;
  readonly executionId: string;
}

interface CompletionServiceOptions {
  readonly record?: (entry: Readonly<Record<string, unknown>>) => Promise<void>;
  readonly modelFactory: Pick<MarAgentRuntimeModelFactory, 'create'>;
  readonly authorized: (authorization: CompletionAuthorization) => boolean;
  readonly validateAuthorization?: (authorization: CompletionAuthorization) => Promise<void>;
  readonly context: (
    authorization: CompletionAuthorization,
    request: PromptCompletionRequest,
    signal: AbortSignal
  ) => Promise<CompletionContextProjection>;
  readonly references: (
    authorization: CompletionAuthorization,
    request: PromptCompletionRequest,
    signal: AbortSignal
  ) => Promise<readonly string[]>;
  readonly usage: (authorization: CompletionAuthorization) => Pick<
    GeneratePromptCompletionInput,
    'onModelUsage' | 'onModelUsageFailure'
  > & {
    readonly release: () => void;
  };
  readonly generate?: typeof generatePromptCompletion;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

interface PageIntent {
  readonly userId: string;
  requestId: string;
  sequence: number;
  expiresAt: number;
  closed: boolean;
  active?: { readonly controller: AbortController; readonly workspaceId: string };
}

/** One manual auxiliary request; it never mutates a Session or enqueues a Run. */
export class PromptCompletionService {
  private readonly pages = new Map<string, PageIntent>();
  private readonly rates = new Map<string, number[]>();
  private readonly affinities = new Map<string, { key: string; expiresAt: number }>();
  private readonly now: () => number;
  private disposed = false;

  constructor(private readonly options: CompletionServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  async generate(
    raw: unknown,
    authorization: CompletionAuthorization
  ): Promise<PromptCompletionResponse> {
    const request = promptCompletionRequestSchema.parse(raw);
    const startedAt = this.now();
    const analysis: Record<string, unknown> = {};
    let result: PromptCompletionResponse | undefined;
    let failed = false;
    let failureCode: string | undefined;
    try {
      result = await this.execute(request, authorization, analysis);
      return result;
    } catch (error) {
      failed = true;
      const code = (error as { code?: unknown } | null)?.code;
      failureCode =
        typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(code)
          ? code
          : 'PROMPT_COMPLETION_FAILED';
      throw error;
    } finally {
      const context = JSON.stringify(analysis);
      try {
        await this.options.record?.({
          schemaVersion: 1,
          startedAt,
          finishedAt: this.now(),
          durationMs: this.now() - startedAt,
          requestId: request.requestId,
          workspaceId: authorization.scope.workspaceId,
          userId: authorization.userId,
          runner: request.runner,
          sessionId: request.sessionId,
          modelId: authorization.model.id,
          providerModelId: authorization.model.modelId,
          reasoningEffort: authorization.reasoningEffort,
          input: {
            trigger: request.trigger,
            draft: request.draft,
            cursorPosition: request.cursorPosition,
            mode: request.completionMode
          },
          context: context.slice(0, 96_000),
          contextTruncated: context.length > 96_000,
          output: result?.status === 'ready' ? result.suggestion : null,
          status: failed ? 'failed' : result?.status,
          reason: failed ? failureCode : result?.status === 'skipped' ? result.reason : undefined
        });
      } catch {
        console.warn('PROMPT_COMPLETION_JOURNAL_WRITE_FAILED');
      }
    }
  }

  private async execute(
    request: PromptCompletionRequest,
    authorization: CompletionAuthorization,
    analysis: Record<string, unknown>
  ): Promise<PromptCompletionResponse> {
    const identity = responseIdentity(request);
    this.prune();
    if (!this.allowed(authorization))
      return { ...identity, status: 'skipped', reason: 'UNAVAILABLE' };
    const pageKey = JSON.stringify([authorization.userId, request.pageEpoch]);
    const previous = this.pages.get(pageKey);
    if (previous && (previous.closed || request.intentSequence <= previous.sequence))
      return { ...identity, status: 'cancelled' };
    if (previous?.active) return { ...identity, status: 'skipped', reason: 'IN_FLIGHT' };
    if (!previous && !this.hasPageCapacity(authorization.userId))
      return { ...identity, status: 'skipped', reason: 'CAPACITY' };
    const active = [...this.pages.values()].filter((page) => page.active);
    if (active.some((page) => page.userId === authorization.userId))
      return { ...identity, status: 'skipped', reason: 'IN_FLIGHT' };
    if (active.length >= 2) return { ...identity, status: 'skipped', reason: 'CAPACITY' };
    const controller = new AbortController();
    const page: PageIntent = {
      userId: authorization.userId,
      requestId: request.requestId,
      sequence: request.intentSequence,
      expiresAt: this.now() + PAGE_INTENT_TTL_MS,
      closed: false,
      active: { controller, workspaceId: authorization.scope.workspaceId }
    };
    this.pages.set(pageKey, page);
    const timeout = setTimeout(
      () => controller.abort(),
      Math.min(this.options.timeoutMs ?? 12_000, authorization.expiresAt - this.now())
    );
    const signal = controller.signal;
    // Retain physical capacity until cleanup finishes, even if a slow reader ignores abort.
    const running = (async (): Promise<PromptCompletionResponse> => {
      try {
        const context = await this.options.context(authorization, request, signal);
        if (!this.allowed(authorization) || signal.aborted)
          return { ...identity, status: 'cancelled' };
        if (context.identity.historyGeneration !== request.historyGeneration)
          return { ...identity, status: 'cancelled' };
        analysis.context = context;
        const references = await this.options.references(authorization, request, signal);
        analysis.references = references;
        if (!this.allowed(authorization) || signal.aborted)
          return { ...identity, status: 'cancelled' };
        if (
          request.trigger === 'AUTO' &&
          !request.draft &&
          context.history.length === 0 &&
          references.length === 0
        )
          return { ...identity, status: 'empty' };
        const calls = (this.rates.get(authorization.userId) ?? []).filter(
          (time) => time > this.now() - 60_000
        );
        if (!this.rates.has(authorization.userId) && this.rates.size >= 4096)
          return { ...identity, status: 'skipped', reason: 'CAPACITY' };
        const wait = Math.max(
          0,
          2_000 - (this.now() - (calls.at(-1) ?? -Infinity)),
          calls.length >= 20 ? 60_000 - (this.now() - calls[0]!) : 0
        );
        if (wait > 0)
          return { ...identity, status: 'skipped', reason: 'RATE_LIMITED', retryAfterMs: wait };
        calls.push(this.now());
        this.rates.set(authorization.userId, calls);
        const [model] = this.options.modelFactory.create([authorization.model], {
          runtimeScopeId: authorization.runtimeScopeId,
          executionId: authorization.executionId
        });
        if (!model) throw new Error('PROMPT_COMPLETION_MODEL_UNAVAILABLE');
        let usage: ReturnType<CompletionServiceOptions['usage']> | undefined;
        let suggestion: string | null;
        try {
          usage = this.options.usage(authorization);
          ({ suggestion } = await (this.options.generate ?? generatePromptCompletion)({
            model,
            trigger: request.trigger,
            reasoningEffort: authorization.reasoningEffort,
            history: context.history,
            referenceMessages: references,
            executionSnapshot: context.executionSnapshot,
            onPreparedInput: (value) => {
              analysis.preparedInput = value;
            },
            onPredictionOutput: (value) => {
              analysis.modelOutput = value;
            },
            ...(context.attention ? { attention: context.attention } : {}),
            draft: request.draft,
            cursorPosition: request.cursorPosition,
            completionMode: request.completionMode,
            promptCacheKey: this.affinity(authorization),
            signal,
            ...(usage.onModelUsage ? { onModelUsage: usage.onModelUsage } : {}),
            ...(usage.onModelUsageFailure ? { onModelUsageFailure: usage.onModelUsageFailure } : {})
          }));
        } finally {
          try {
            usage?.release();
          } finally {
            await model.credentialProvider?.close();
          }
        }
        if (!this.allowed(authorization) || signal.aborted)
          return { ...identity, status: 'cancelled' };
        await this.options.validateAuthorization?.(authorization);
        if (!this.allowed(authorization) || signal.aborted)
          return { ...identity, status: 'cancelled' };
        const expiresAt = Math.min(this.now() + 30_000, authorization.expiresAt);
        return suggestion === null
          ? { ...identity, status: 'empty' }
          : { ...identity, status: 'ready', suggestion, source: 'generated', expiresAt };
      } catch (error) {
        if (signal.aborted) return { ...identity, status: 'cancelled' };
        throw error;
      } finally {
        clearTimeout(timeout);
        delete page.active;
      }
    })();
    return new Promise((resolve, reject) => {
      const aborted = () => {
        cleanup();
        resolve({ ...identity, status: 'cancelled' });
      };
      const cleanup = () => signal.removeEventListener('abort', aborted);
      // Transport errors remain rejections; no response body or draft is logged here.
      void running.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error) => {
          cleanup();
          reject(error);
        }
      );
      if (signal.aborted) aborted();
      else signal.addEventListener('abort', aborted, { once: true });
    });
  }

  /** Identity is authenticated separately; cancellation does not require generation rights. */
  cancel(userId: string, raw: unknown): void {
    const request: PromptCompletionCancel = promptCompletionCancelSchema.parse(raw);
    this.prune();
    const key = JSON.stringify([userId, request.pageEpoch]);
    const page = this.pages.get(key);
    if (page && request.intentSequence < page.sequence) return;
    if (page && request.intentSequence === page.sequence && page.requestId !== request.requestId)
      throw new Error('PROMPT_COMPLETION_INTENT_CONFLICT');
    if (!page && !this.hasPageCapacity(userId)) throw new Error('PROMPT_COMPLETION_CAPACITY');
    page?.active?.controller.abort();
    if (page) {
      page.sequence = request.intentSequence;
      page.requestId = request.requestId;
      page.expiresAt = this.now() + PAGE_INTENT_TTL_MS;
    } else
      this.pages.set(key, {
        userId,
        requestId: request.requestId,
        sequence: request.intentSequence,
        expiresAt: this.now() + PAGE_INTENT_TTL_MS,
        closed: false
      });
  }

  invalidateWorkspace(workspaceId: string): void {
    for (const page of this.pages.values())
      if (page.active?.workspaceId === workspaceId) page.active.controller.abort();
    this.affinities.clear();
  }

  invalidateUser(userId: string): void {
    for (const [key, page] of this.pages)
      if ((JSON.parse(key) as string[])[0] === userId) page.active?.controller.abort();
    this.affinities.clear();
  }

  releasePage(userId: string, pageEpoch: string): void {
    const page = this.pages.get(JSON.stringify([userId, pageEpoch]));
    if (!page) return;
    page.closed = true;
    page.expiresAt = this.now() + PAGE_INTENT_TTL_MS;
    page.active?.controller.abort();
  }

  disconnect(): void {
    for (const page of this.pages.values()) page.active?.controller.abort();
    this.affinities.clear();
  }

  dispose(): void {
    this.disposed = true;
    for (const page of this.pages.values()) page.active?.controller.abort();
    this.rates.clear();
    this.affinities.clear();
    this.pages.clear();
  }

  private allowed(authorization: CompletionAuthorization): boolean {
    return (
      !this.disposed &&
      authorization.expiresAt > this.now() &&
      this.options.authorized(authorization)
    );
  }

  private affinity(authorization: CompletionAuthorization): string {
    const identity = digest([
      authorization.userId,
      authorization.scope,
      authorization.modelRevision,
      authorization.credentialScope
    ]);
    const found = this.affinities.get(identity);
    if (found && found.expiresAt > this.now()) return found.key;
    const entry = { key: randomUUID(), expiresAt: this.now() + 15 * 60_000 };
    this.affinities.set(identity, entry);
    while (this.affinities.size > 128) this.affinities.delete(this.affinities.keys().next().value!);
    return entry.key;
  }

  private prune(): void {
    for (const [key, page] of this.pages)
      if (!page.active && page.expiresAt <= this.now()) this.pages.delete(key);
    for (const [key, value] of this.affinities)
      if (value.expiresAt <= this.now()) this.affinities.delete(key);
    for (const [key, calls] of this.rates)
      if ((calls.at(-1) ?? 0) <= this.now() - 60_000) this.rates.delete(key);
  }

  private hasPageCapacity(userId: string): boolean {
    return (
      this.pages.size < 4096 &&
      [...this.pages.values()].filter((page) => page.userId === userId).length < 128
    );
  }
}

function responseIdentity(request: PromptCompletionRequest) {
  return {
    requestId: request.requestId,
    contextVersion: request.contextVersion,
    historyGeneration: request.historyGeneration,
    draftRevision: request.draftRevision,
    cursorPosition: request.cursorPosition
  };
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

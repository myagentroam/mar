import {
  modelUsageGrantSchema,
  modelUsageGrantClaimsSchema,
  modelUsageRecordSchema,
  type ModelUsageGrant,
  type ModelUsageRecord
} from '@myagentroam/protocol';
import type { ModelUsageOutbox } from './model-usage-outbox.js';
import { nodeLog } from '../operational.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { GenerateModelTextInput } from '@myagentroam/agent';
import { normalizeMarAgentUsage } from '../runner/mar-agent/conversation-normalizer.js';

interface UsageBinding {
  readonly userId: number;
  readonly grant: ModelUsageGrant;
  readonly scopeId: string;
  readonly sessionId: string;
  readonly runner: ModelUsageRecord['runner'];
}

/** Execution-private attribution never enters Run projections or browser Watch events. */
export class NodeModelUsageService {
  private readonly scope = new AsyncLocalStorage<unknown>();
  private readonly bindings = new Map<string, UsageBinding>();
  constructor(
    private readonly outbox: () => ModelUsageOutbox | undefined,
    private readonly nodeId: () => string | undefined
  ) {}
  withGrant<T>(grant: unknown, action: () => T): T {
    return this.scope.run(grant, action);
  }
  bindInherited(runId: string, sessionId: string, runner: ModelUsageRecord['runner']): void {
    if (!this.bindings.has(runId)) this.bind(runId, this.scope.getStore(), sessionId, runner);
  }
  bind(runId: string, grant: unknown, sessionId: string, runner: ModelUsageRecord['runner']): void {
    this.bindings.delete(runId);
    if (grant === undefined) return;
    try {
      const parsedGrant = modelUsageGrantSchema.parse(grant);
      const claims = modelUsageGrantClaimsSchema.parse(
        JSON.parse(Buffer.from(parsedGrant.token.split('.')[0]!, 'base64url').toString())
      );
      if (claims.nodeId !== this.nodeId() || claims.scopeId !== parsedGrant.scopeId) return;
      this.bindings.set(runId, {
        userId: claims.userId,
        grant: parsedGrant,
        scopeId: claims.scopeId,
        sessionId,
        runner
      });
    } catch {
      nodeLog('model.usage.invalid', { code: 'USAGE_GRANT_INVALID' });
    }
  }
  release(runId: string): void {
    this.bindings.delete(runId);
  }
  completion(
    executionId: string,
    grant: unknown,
    sessionId: string,
    expectedUserId?: number
  ): Pick<GenerateModelTextInput, 'onModelUsage' | 'onModelUsageFailure'> & {
    readonly release: () => void;
  } {
    this.bind(executionId, grant, sessionId, 'mar-agent');
    if (expectedUserId !== undefined && this.bindings.get(executionId)?.userId !== expectedUserId)
      this.release(executionId);
    if (!this.bindings.has(executionId)) throw new Error('PROMPT_COMPLETION_USAGE_GRANT_REQUIRED');
    return {
      onModelUsage: (usage) =>
        this.record(executionId, {
          ...normalizeMarAgentUsage({
            ...usage,
            sessionId,
            executionId,
            purpose: 'other',
            agentRole: 'root'
          }),
          purpose: 'prompt_completion'
        }),
      onModelUsageFailure: () =>
        nodeLog('model.usage.invalid', { code: 'PROMPT_COMPLETION_USAGE_FAILED' }),
      release: () => this.release(executionId)
    };
  }
  promoteSession(previousId: string, nextId: string): void {
    for (const [runId, binding] of this.bindings)
      if (binding.sessionId === previousId)
        this.bindings.set(runId, { ...binding, sessionId: nextId });
  }
  clear(): void {
    this.bindings.clear();
  }
  record(runId: string, value: unknown): void {
    const binding = this.bindings.get(runId);
    if (!binding || !value || typeof value !== 'object') return;
    const parsed = modelUsageRecordSchema.safeParse({
      ...value,
      scopeId: binding.scopeId,
      runner: binding.runner,
      runId,
      sessionId:
        typeof (value as Record<string, unknown>).sessionId === 'string'
          ? (value as Record<string, unknown>).sessionId
          : binding.sessionId
    });
    if (!parsed.success) {
      nodeLog('model.usage.invalid', { code: 'USAGE_RECORD_INVALID' });
      return;
    }
    this.outbox()?.record(binding.grant, parsed.data);
  }
}

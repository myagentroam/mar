import type { ModelEvent, ModelTurnSession } from '../model/contracts.js';
import type { SessionModelMessage, SessionModelRequest } from '../session/model-request.js';
import type { SessionRuntime } from './session-runtime.js';
import type { ResourceInputProjection } from './resource-input.js';
import type { AuthoritativeModelUsage } from '../runtime/context/usage.js';
import { AGENT_EXECUTION_POLICY } from '../runtime/execution-policy.js';

/** Owns request publication, continuation accounting and provider usage for one Execution. */
export class ExecutionModelLifecycle {
  private dispatchedInputs = 0;
  private dispatchedLocal = 0;
  private readonly completedMedia = new WeakSet<readonly SessionModelMessage[]>();
  private contextTokens: number | undefined;
  private smartTokens: number | undefined;
  private lastUsage: AuthoritativeModelUsage | undefined;

  constructor(
    private readonly ports: {
      modelId: string;
      contextWindowTokens: number;
      signal: AbortSignal;
      messages: SessionModelMessage[];
      turn: ModelTurnSession;
      runtime: Pick<SessionRuntime, 'recordRequest' | 'completeRequest'>;
      resources: Pick<ResourceInputProjection, 'complete'>;
      stream(
        start: (signal: AbortSignal) => AsyncIterable<ModelEvent>,
        signal: AbortSignal
      ): AsyncIterable<ModelEvent>;
      compactPending(): boolean;
      startCompact(): void;
      updateBoundary(value: number): void;
      initialUsage: AuthoritativeModelUsage | undefined;
      initialSmartTokens: number | undefined;
    }
  ) {
    this.lastUsage = ports.initialUsage;
    this.contextTokens = ports.initialUsage?.contextInputTokens;
    this.smartTokens = ports.initialSmartTokens;
  }

  get tokens(): number | undefined {
    return this.contextTokens;
  }
  get smartContextTokens(): number | undefined {
    return this.smartTokens;
  }
  get usage(): AuthoritativeModelUsage | undefined {
    return this.lastUsage;
  }
  resetSmart(): void {
    this.smartTokens = undefined;
  }
  invalidate(): void {
    this.contextTokens = undefined;
    this.smartTokens = undefined;
    this.lastUsage = undefined;
  }

  async *start(request: SessionModelRequest): AsyncIterable<ModelEvent> {
    const snapshot = this.ports.runtime.recordRequest(this.ports.modelId, request);
    this.dispatchedInputs = request.messages.length;
    this.dispatchedLocal = this.ports.messages.length;
    const ports = this.ports;
    const completed = this.completedMedia;
    yield* ports.stream(async function* (signal) {
      for await (const event of ports.turn.start(request, signal)) {
        if (event.type === 'completed' && event.reason !== 'cancelled') {
          completed.add(request.messages);
          ports.runtime.completeRequest(snapshot);
        }
        yield event;
      }
    }, ports.signal);
  }

  async afterModel(
    closedPrefixLength: number,
    request: SessionModelRequest | undefined
  ): Promise<void> {
    this.ports.turn.commitContinuationInput?.(
      this.dispatchedInputs + this.ports.messages.length - this.dispatchedLocal
    );
    if (request && this.completedMedia.has(request.messages)) {
      await this.ports.resources.complete(request);
      this.ports.updateBoundary(closedPrefixLength);
    }
    if (
      this.contextTokens !== undefined &&
      (this.contextTokens * 100) / this.ports.contextWindowTokens >=
        AGENT_EXECUTION_POLICY.backgroundCompactionPercent &&
      !this.ports.compactPending()
    )
      this.ports.startCompact();
  }

  observeTokens(tokens: number): void {
    this.contextTokens = tokens;
    this.smartTokens = tokens;
  }
  observeUsage(usage: Omit<AuthoritativeModelUsage, 'historyMessages'> | undefined): void {
    if (usage !== undefined) {
      this.contextTokens = usage.contextInputTokens;
      this.smartTokens = usage.contextInputTokens;
      this.lastUsage = { ...usage, historyMessages: [...this.ports.messages] };
    }
  }
}

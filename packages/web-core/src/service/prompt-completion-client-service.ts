import { createUuid } from '../util/uuid.js';
import { computed, type ComputedRef } from 'vue';
import {
  promptCompletionContextSchema,
  promptCompletionResponseSchema,
  type PromptCompletionTarget,
  type PromptCompletionResponse,
  type RunnerName
} from '@myagentroam/protocol';
import type { CompletionDraft, CompletionTrigger } from './prompt-completion-service.js';

export interface PromptCompletionBinding {
  readonly enabled: boolean;
  readonly contextKey: string;
  readonly automaticKey?: string | undefined;
  readonly automaticTerminalKey?: string | undefined;
  readonly readContextRevision?: () => string;
  readonly request: (
    draft: CompletionDraft,
    signal: AbortSignal,
    attention?: readonly import('@myagentroam/protocol').PromptCompletionAttention[],
    trigger?: CompletionTrigger
  ) => Promise<PromptCompletionResponse>;
}
export interface CompletionClientTarget {
  readonly nodeId: string;
  readonly target: PromptCompletionTarget;
  readonly runner: RunnerName;
  readonly sessionId: string | null;
}
type Request = <T>(path: string, init?: RequestInit) => Promise<T>;

/** One page-wide sequence spans resource changes; only explicit editor actions enter complete(). */
export class PromptCompletionClientService {
  private connection: string | undefined;
  private pageEpoch = '';
  private sequence = 0;
  constructor(
    private readonly options: {
      readonly request: Request;
      readonly connectionId: () => string | undefined;
    }
  ) {}

  bind(options: {
    readonly attention?: () => readonly import('@myagentroam/protocol').PromptCompletionAttention[];
    readonly enabled: () => boolean;
    readonly automaticKey?: () => string | undefined;
    readonly automaticTerminalKey?: () => string | undefined;
    readonly readContextRevision?: () => string;
    readonly target: () => CompletionClientTarget | undefined;
  }): ComputedRef<PromptCompletionBinding> {
    return computed(() => {
      const target = options.target();
      const connectionId = this.options.connectionId();
      const contextKey = JSON.stringify([connectionId, target]);
      const current = () =>
        options.enabled() &&
        connectionId === this.options.connectionId() &&
        contextKey === JSON.stringify([this.options.connectionId(), options.target()]);
      return {
        enabled: Boolean(target && connectionId && options.enabled()),
        contextKey,
        automaticKey: options.automaticKey?.(),
        automaticTerminalKey: options.automaticTerminalKey?.(),
        ...(options.readContextRevision
          ? { readContextRevision: options.readContextRevision }
          : {}),
        request: (draft, signal, attention, trigger = 'MANUAL') => {
          if (!target || !connectionId || !current() || signal.aborted)
            return Promise.reject(aborted());
          return this.complete(
            target,
            connectionId,
            draft,
            signal,
            current,
            trigger,
            attention ?? options.attention?.()
          );
        }
      };
    });
  }

  private async complete(
    target: CompletionClientTarget,
    connectionId: string,
    draft: CompletionDraft,
    signal: AbortSignal,
    current: () => boolean,
    trigger: CompletionTrigger,
    attention?: readonly import('@myagentroam/protocol').PromptCompletionAttention[]
  ): Promise<PromptCompletionResponse> {
    if (this.connection !== connectionId) {
      this.connection = connectionId;
      this.pageEpoch = createUuid();
      this.sequence = 0;
    }
    const intent = {
      requestId: createUuid(),
      pageEpoch: this.pageEpoch,
      intentSequence: ++this.sequence
    };
    const controller = new AbortController();
    const abort = () => controller.abort();
    const cancel = () => {
      const cancellation = new AbortController();
      const timeout = setTimeout(() => cancellation.abort(), 2_000);
      void this.post(
        target.nodeId,
        'cancel',
        { target: target.target, workbenchConnectionId: connectionId, request: intent },
        cancellation.signal,
        true
      )
        .catch(() => undefined)
        .finally(() => clearTimeout(timeout));
    };
    signal.addEventListener('abort', abort, { once: true });
    controller.signal.addEventListener('abort', cancel, { once: true });
    const deadline = setTimeout(abort, 12_000);
    try {
      const context = promptCompletionContextSchema.parse(
        await this.post(
          target.nodeId,
          'context',
          {
            target: target.target,
            runner: target.runner,
            sessionId: target.sessionId,
            pageEpoch: intent.pageEpoch,
            workbenchConnectionId: connectionId
          },
          controller.signal
        )
      );
      controller.signal.throwIfAborted();
      if (!current()) {
        controller.abort();
        throw aborted();
      }
      const request = {
        ...intent,
        trigger,
        completionMode: draft.text.length === 0 ? 'NEXT' : 'REWRITE',
        ...(attention?.length ? { attention } : {}),
        draft: draft.text,
        cursorPosition: draft.cursor,
        draftRevision: intent.intentSequence,
        runner: target.runner,
        sessionId: target.sessionId,
        contextVersion: context.contextVersion,
        historyGeneration: context.historyGeneration
      };
      const result = promptCompletionResponseSchema.parse(
        await this.post(
          target.nodeId,
          'generate',
          {
            target: target.target,
            workbenchConnectionId: connectionId,
            request
          },
          controller.signal
        )
      );
      controller.signal.throwIfAborted();
      if (
        !current() ||
        result.requestId !== intent.requestId ||
        result.cursorPosition !== draft.cursor ||
        result.draftRevision !== request.draftRevision ||
        result.contextVersion !== context.contextVersion ||
        result.historyGeneration !== context.historyGeneration
      )
        throw aborted();
      return result;
    } finally {
      clearTimeout(deadline);
      signal.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', cancel);
    }
  }

  private post(
    nodeId: string,
    operation: 'context' | 'generate' | 'cancel',
    body: unknown,
    signal: AbortSignal,
    keepalive = false
  ) {
    return this.options.request<unknown>(
      `/api/nodes/${encodeURIComponent(nodeId)}/prompt-completion/${operation}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
        keepalive
      }
    );
  }
}

function aborted(): DOMException {
  return new DOMException('Prompt completion was cancelled.', 'AbortError');
}

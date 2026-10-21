import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface CoreOperationContext {
  readonly operationId: string;
  readonly sessionId: string;
  readonly sessionEpoch: number;
  readonly ownerInstanceId?: string;
  readonly extensionId?: string;
  readonly parentOperationId?: string;
  readonly executionId?: string;
  readonly turnId?: string;
  /** Correlation with the actual enclosing tool call; not an authority token. */
  readonly toolCallId?: string;
  readonly parentToolCallId?: string;
  readonly actor: 'model' | 'sdk' | 'extension' | 'code-mode';
  readonly entry: 'direct' | 'programmatic' | 'native-api';
  readonly signal: AbortSignal;
}

/** Internal callback binding shared by the typed hooks and contribution handlers. */
export type CoreCallbackRunner = <Value>(
  call: CoreOperationContext,
  callback: (call: CoreOperationContext) => Value | Promise<Value>,
  settled?: boolean
) => Promise<Value>;

/** Internal identity propagation. Caller-controlled payloads never select a framework identity. */
export class ExtensionOperations {
  readonly #current = new AsyncLocalStorage<
    { context: CoreOperationContext; active: boolean; children: Set<Promise<void>> } | undefined
  >();

  current(): CoreOperationContext | undefined {
    const frame = this.#current.getStore();
    return frame?.active ? frame.context : undefined;
  }

  /** Bind the effective owner signal before author code can call another facade. */
  callback<Value>(
    call: CoreOperationContext,
    callback: (call: CoreOperationContext) => Value | Promise<Value>,
    settled = false
  ): Promise<Value> {
    const controller = new AbortController();
    const effective = Object.freeze({
      ...call,
      signal: AbortSignal.any([call.signal, controller.signal])
    });
    return this.continue(
      effective,
      async () => {
        try {
          return await callback(effective);
        } catch (error) {
          // Cancel descendants before continue joins them; retain the original callback error.
          controller.abort(error);
          throw error;
        }
      },
      settled
    );
  }

  /** Physical transport ingress starts a new ancestry; native plugin calls cannot choose it. */
  async continue<T>(
    context: CoreOperationContext,
    operation: () => Promise<T>,
    settled = false
  ): Promise<T> {
    const frame = { context, active: true, children: new Set<Promise<void>>() };
    return this.#current.run(frame, async () => {
      try {
        if (!settled) context.signal.throwIfAborted();
        return await operation();
      } finally {
        while (frame.children.size) await Promise.all([...frame.children]);
        frame.active = false;
      }
    });
  }

  /** Physical transport ingress starts a new ancestry; native plugin calls cannot choose it. */
  enter<T>(
    identity: Omit<CoreOperationContext, 'operationId' | 'parentOperationId'>,
    operation: (context: CoreOperationContext) => T
  ): T {
    return this.#current.run(undefined, () => this.run(identity, operation));
  }

  run<T>(
    identity: Omit<CoreOperationContext, 'operationId' | 'parentOperationId'>,
    operation: (context: CoreOperationContext) => T
  ): T {
    const parent = this.current();
    const context: CoreOperationContext = Object.freeze({
      ...identity,
      operationId: randomUUID(),
      ...(parent
        ? {
            parentOperationId: parent.operationId,
            ...((identity.toolCallId ?? parent.toolCallId) === undefined
              ? {}
              : { toolCallId: identity.toolCallId ?? parent.toolCallId! }),
            ...((identity.parentToolCallId ?? parent.parentToolCallId) === undefined
              ? {}
              : { parentToolCallId: identity.parentToolCallId ?? parent.parentToolCallId! }),
            entry: parent.entry,
            signal: AbortSignal.any([identity.signal, parent.signal])
          }
        : {})
    });
    const ancestor = this.#current.getStore();
    const frame = { context, active: true, children: new Set<Promise<void>>() };
    let value: T;
    try {
      value = this.#current.run(frame, () => {
        context.signal.throwIfAborted();
        return operation(context);
      });
    } catch (error) {
      frame.active = false;
      throw error;
    }
    if (!value || typeof (value as { then?: unknown }).then !== 'function') {
      frame.active = false;
      return value;
    }
    const result = (async () => {
      try {
        return await value;
      } finally {
        while (frame.children.size) await Promise.all([...frame.children]);
        frame.active = false;
      }
    })();
    if (ancestor?.active) {
      const settled = result.then(
        () => undefined,
        () => undefined
      );
      ancestor.children.add(settled);
      void settled.then(() => ancestor.children.delete(settled));
    }
    return result as T;
  }
}

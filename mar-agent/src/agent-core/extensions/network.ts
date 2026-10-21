import { MarAgentError } from '../error.js';
import type { CoreDomainFacts, CoreDomainOperations } from './contracts.js';
import type { ExtensionHooks } from './hooks.js';
import type { CoreOperationContext } from './operation.js';
import type { ExtensionResourceScope } from './resources.js';

export interface CoreHttpRequest {
  readonly url: string;
  readonly method?: string;
  readonly headers?: readonly (readonly [string, string])[];
  readonly body?: string | Uint8Array;
  readonly redirect?: 'follow' | 'manual' | 'error';
  readonly signal?: AbortSignal;
}
export interface CoreHttpResponse {
  readonly url: string;
  readonly status: number;
  readonly statusText: string;
  readonly redirected: boolean;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: AsyncIterable<Uint8Array>;
  close(): Promise<void>;
}
export interface CoreNetworkApi {
  fetch(input: CoreHttpRequest): Promise<CoreHttpResponse>;
}
export interface CoreNetworkBackend {
  fetch(input: CoreHttpRequest, call: CoreOperationContext): Promise<CoreHttpResponse>;
}
export interface CoreHttpCompletion {
  readonly status: number;
  readonly redirected: boolean;
}

export function bindCoreNetwork(
  backend: CoreNetworkBackend,
  run: <Value>(
    operation: (call: CoreOperationContext) => Promise<Value>,
    signal?: AbortSignal
  ) => Promise<Value>,
  scope: ExtensionResourceScope,
  hooks: ExtensionHooks<CoreDomainOperations, CoreDomainFacts>,
  diagnose: () => void
): CoreNetworkApi {
  return {
    fetch: (input) =>
      run(
        (call) =>
          hooks.invoke('network.fetch', input, call, async (input, effective) => {
            if (typeof backend.fetch !== 'function')
              throw new MarAgentError(
                'MAR_AGENT_HOST_PORT_UNAVAILABLE',
                'Native HTTP port is unavailable.'
              );
            const response = await backend.fetch(input, effective);
            let iterator: AsyncIterator<Uint8Array> | undefined;
            const close = async () => {
              // Close the transport first so an in-flight pull is released before iterator cleanup.
              const results = await Promise.allSettled([
                Promise.resolve().then(() => response.close()),
                Promise.resolve().then(() => iterator?.return?.())
              ]);
              const failure = results.find((result) => result.status === 'rejected');
              if (failure?.status === 'rejected') throw failure.reason;
            };
            let registration;
            try {
              registration = scope.effect(() => close);
              await registration.ready;
              iterator = response.body[Symbol.asyncIterator]();
              await hooks.emit(
                'network.completed',
                { status: response.status, redirected: response.redirected },
                effective
              );
            } catch (error) {
              try {
                await close();
              } catch {
                diagnose();
              }
              throw error;
            }
            const resource = registration;
            let done = false;
            let nextTail: Promise<unknown> = Promise.resolve();
            const body: AsyncIterableIterator<Uint8Array> = {
              [Symbol.asyncIterator]() {
                return this;
              },
              next() {
                const pending = nextTail.then(pull);
                nextTail = pending.catch(() => undefined);
                return pending;
              },
              async return() {
                done = true;
                await resource.dispose();
                return { done: true, value: undefined };
              }
            };
            async function pull(): Promise<IteratorResult<Uint8Array>> {
              if (done) return { done: true, value: undefined };
              try {
                const next = await scope.run(async (signal) => {
                  signal.throwIfAborted();
                  const next = await iterator!.next();
                  signal.throwIfAborted();
                  return next;
                }, effective.signal);
                if (next.done) {
                  done = true;
                  await resource.dispose();
                  return { done: true, value: undefined };
                }
                if (!(next.value instanceof Uint8Array))
                  throw new MarAgentError(
                    'MAR_AGENT_NETWORK_RESPONSE_INVALID',
                    'HTTP body must yield raw bytes.'
                  );
                return { done: false, value: new Uint8Array(next.value) };
              } catch (error) {
                done = true;
                try {
                  await resource.dispose();
                } catch {
                  diagnose();
                }
                throw error;
              }
            }
            return {
              url: response.url,
              status: response.status,
              statusText: response.statusText,
              redirected: response.redirected,
              headers: Object.freeze(
                response.headers.map((pair) => Object.freeze([...pair] as [string, string]))
              ),
              body,
              close: async () => {
                done = true;
                await resource.dispose();
              }
            };
          }),
        input.signal
      )
  };
}

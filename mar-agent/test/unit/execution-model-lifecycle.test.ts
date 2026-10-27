import { expect, it, vi } from 'vitest';
import { ExecutionModelLifecycle } from '../../src/sdk/execution-model-lifecycle.js';

it('binds the model request snapshot and adopts its accepted media', async () => {
  const messages = [{ role: 'user', content: 'one' }];
  const recordRequest = vi.fn(() => ({ requestId: 'captured' }));
  const completeRequest = vi.fn();
  const acceptMessages = vi.fn(async () => {});
  const updateBoundary = vi.fn();
  const model = new ExecutionModelLifecycle({
    modelId: 'm',
    contextWindowTokens: 100,
    signal: new AbortController().signal,
    messages,
    turn: {
      async *start() {
        yield { type: 'completed', reason: 'stop' };
      }
    },
    runtime: { recordRequest, completeRequest },
    resources: { complete: acceptMessages },
    stream: (start, signal) => start(signal),
    compactPending: () => false,
    startCompact: () => {},
    updateBoundary,
    initialUsage: undefined,
    initialSmartTokens: undefined
  } as never);
  const request = { messages: [...messages] } as never;
  await Array.fromAsync(model.start(request));
  messages.push({ role: 'assistant', content: 'two' });
  await model.afterModel(1, request);
  expect(recordRequest).toHaveBeenCalledWith('m', request);
  expect(completeRequest).toHaveBeenCalledWith({ requestId: 'captured' });
  expect(acceptMessages).toHaveBeenCalledTimes(1);
  expect(updateBoundary).toHaveBeenCalledWith(1);
});

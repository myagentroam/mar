import { expect, it, vi } from 'vitest';
import { createSessionExtensionMessages } from '../../src/sdk/session-extension-messages.js';

it('routes a child request to its live request snapshot rather than the parent history', async () => {
  const readExecutionState = vi.fn();
  const getSession = vi.fn(async () => ({ id: 'child', source: { parentSessionId: 'parent' } }));
  const messages = createSessionExtensionMessages({
    sessionId: 'parent',
    store: { readExecutionState, getSession },
    runtime: (id: string) =>
      id === 'child'
        ? {
            execution: {
              requestMessages: {
                read: () => [{ role: 'user', content: 'child input' }]
              }
            }
          }
        : undefined,
    models: () => ({
      defaultModelId: 'm',
      models: new Map([['m', { inputCapabilities: ['TEXT'] }]])
    })
  } as never);
  const page = await messages(
    { agentId: 'child', view: 'request' } as never,
    { signal: new AbortController().signal } as never
  );
  expect(getSession).toHaveBeenCalledWith('child');
  expect(readExecutionState).not.toHaveBeenCalled();
  expect(JSON.stringify(page)).toContain('child input');
});

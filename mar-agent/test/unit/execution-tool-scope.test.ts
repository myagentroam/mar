import { expect, it, vi } from 'vitest';
import { createExecutionToolScope } from '../../src/sdk/execution-tool-scope.js';

it('captures each round tool binding and restores the operation frame for tool invocation', async () => {
  const events: string[] = [];
  const tool = { name: 'read', inputSchema: { type: 'object' }, description: 'read' };
  let binding = { definition: tool, source: { kind: 'host' }, version: 1 };
  const invoke = vi.fn(async (_call, _operation, bindings) => {
    events.push(`binding:${bindings.get('read').version}`);
    return { content: 'ok' };
  });
  const capture = createExecutionToolScope({
    store: {},
    host: {},
    sessionId: 's',
    executionId: 'e',
    turnId: 't',
    mode: 'run',
    controller: new AbortController(),
    sessionWriterOwner: {},
    selectedModel: { id: 'm', contextWindowTokens: 1000, inputCapabilities: [] },
    permissionPolicy: { mode: 'auto' },
    todo: {},
    waitInterrupt: undefined,
    skills: new Map(),
    coreExtensions: {
      epoch: 1,
      services: { resolve: () => undefined },
      agentAction: () => {},
      withTools: (_b, _s, run) => run(),
      invoke,
      assertLive() {},
      pin: () => () => {},
      diagnose() {}
    },
    operations: { enter: (_context, run) => run({}) },
    scheduleTool: () => {},
    sources: {
      withFrame: (_context, run) => {
        events.push('frame');
        return run();
      },
      assertActive() {}
    },
    mcpRegistry: { expectedTool: () => undefined, expose: async () => ({ content: '' }) },
    autoPermissionPrompt: 'permission',
    currentExecutionToolImages: [],
    inputImageBytes: new Map(),
    snapshotTools: () => [tool],
    baseTools: () => [tool],
    captureTools: () => new Map([['read', binding]]),
    promptComposition: () => ({ sections: [] }),
    smartInput: () => undefined,
    modelInputImages: () => undefined,
    startCompact: () => {
      throw new Error('unexpected');
    },
    preparedPrompt: () => undefined,
    clearPreparedPrompt() {},
    operation: (run) => run({}),
    emit: async () => {}
  } as never);
  const first = capture();
  binding = { ...binding, version: 2 };
  const second = capture();
  await first.toolScope.context.invokeTool!(
    { name: 'read', callId: 'c', input: {} },
    first.toolScope.context,
    'direct'
  );
  await second.toolScope.context.invokeTool!(
    { name: 'read', callId: 'c2', input: {} },
    second.toolScope.context,
    'direct'
  );
  expect(events).toEqual(['frame', 'binding:1', 'frame', 'binding:2']);
});

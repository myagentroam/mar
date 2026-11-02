import { expect, it, vi } from 'vitest';
import type { ExtensionToolSpec, SessionExtensionContext } from '@myagentroam/agent/extensions';
import { createToolCallScheduler } from '../../../mar-agent/dist/tools/scheduler.js';
import { agentNetworkExtension } from '../../src/runner/mar-agent/agent-network-extension.js';

async function registeredTools() {
  const tools = new Map<string, ExtensionToolSpec>();
  const context = {
    hooks: { intercept: vi.fn() },
    tools: { register: (tool: ExtensionToolSpec) => tools.set(tool.name, tool) }
  } as unknown as SessionExtensionContext;
  await agentNetworkExtension(vi.fn(), () => 'execution').attachSession!(context);
  return tools;
}

it('classifies all network tools as safe', async () => {
  const tools = await registeredTools();
  for (const name of [
    'agent_list',
    'agent_view',
    'agent_wait',
    'agent_start',
    'agent_send',
    'agent_stop'
  ])
    expect(tools.get(name)?.parallelSafety, name).toBe('safe');
});

it('starts network reads alongside a pending wait alongside lifecycle controls', async () => {
  const tools = await registeredTools();
  const release = Promise.withResolvers<void>();
  const started: string[] = [];
  const schedule = createToolCallScheduler([...tools.values()], async (call: { name: string }) => {
    started.push(call.name);
    if (call.name === 'agent_wait') await release.promise;
  });
  const pending = [
    'agent_wait',
    'agent_list',
    'agent_view',
    'agent_start',
    'agent_send',
    'agent_stop'
  ].map((name) => schedule({ name }));
  try {
    for (let index = 0; index < 20; index++) await Promise.resolve();
    expect(started).toEqual([
      'agent_wait',
      'agent_list',
      'agent_view',
      'agent_start',
      'agent_send',
      'agent_stop'
    ]);
  } finally {
    release.resolve();
    await Promise.all(pending);
  }
  expect(started).toEqual([
    'agent_wait',
    'agent_list',
    'agent_view',
    'agent_start',
    'agent_send',
    'agent_stop'
  ]);
});

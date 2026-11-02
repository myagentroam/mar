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

it('classifies network observations as safe and lifecycle controls as serial', async () => {
  const tools = await registeredTools();
  for (const name of ['agent_list', 'agent_view', 'agent_wait'])
    expect(tools.get(name)?.parallelSafety, name).toBe('safe');
  for (const name of ['agent_start', 'agent_send', 'agent_stop'])
    expect(tools.get(name)?.parallelSafety, name).toBe('serial');
});

it('starts network reads alongside a pending wait and keeps lifecycle controls ordered', async () => {
  const tools = await registeredTools();
  const release = Promise.withResolvers<void>();
  const started: string[] = [];
  const schedule = createToolCallScheduler([...tools.values()], async (call: { name: string }) => {
    started.push(call.name);
    if (call.name === 'agent_wait') await release.promise;
  });
  const pending = ['agent_wait', 'agent_list', 'agent_view', 'agent_start'].map((name) =>
    schedule({ name })
  );
  try {
    for (let index = 0; index < 20; index++) await Promise.resolve();
    expect(started).toEqual(['agent_wait', 'agent_list', 'agent_view']);
  } finally {
    release.resolve();
    await Promise.all(pending);
  }
  expect(started).toEqual(['agent_wait', 'agent_list', 'agent_view', 'agent_start']);
});

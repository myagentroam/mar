import { expect, it } from 'vitest';
import type { Agent } from '@myagentroam/agent';
import type { ExtensionToolSpec, SessionExtensionContext } from '@myagentroam/agent/extensions';
import { createSessionToolScheduler } from '../../../src/tools/scheduler.js';
import { registerControlTools } from '../src/control.js';
import { SessionObservations } from '../src/observations.js';
import { registerQueryTools } from '../src/query.js';
import { registerStart, StartAdmission } from '../src/start.js';
import { registerWait } from '../src/wait.js';

function registeredTools() {
  const tools = new Map<string, ExtensionToolSpec>();
  const context = {
    tools: { register: (tool: ExtensionToolSpec) => tools.set(tool.name, tool) }
  } as unknown as SessionExtensionContext;
  const agent = {} as Agent;
  const observations = new SessionObservations();
  const admission = new StartAdmission();
  registerStart(context, agent, admission);
  registerControlTools(context, agent, observations, new Map(), admission);
  registerQueryTools(context, agent);
  registerWait(context, agent, observations);
  return tools;
}

it('classifies all agent tools as safe', () => {
  const tools = registeredTools();
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

it('allows independent reads during a pending wait alongside lifecycle controls', async () => {
  const tools = registeredTools();
  const schedule = createSessionToolScheduler();
  const release = Promise.withResolvers<void>();
  const started: string[] = [];
  const wait = schedule(tools.get('agent_wait'), async () => {
    started.push('wait');
    await release.promise;
  });
  const reads = ['agent_list', 'agent_view'].map((name) =>
    schedule(tools.get(name), async () => {
      started.push(name);
    })
  );
  const controls = ['agent_start', 'agent_send', 'agent_stop'].map((name) =>
    schedule(tools.get(name), async () => {
      started.push(name);
    })
  );
  try {
    for (let index = 0; index < 20; index++) await Promise.resolve();
    expect(started).toEqual([
      'wait',
      'agent_list',
      'agent_view',
      'agent_start',
      'agent_send',
      'agent_stop'
    ]);
  } finally {
    release.resolve();
    await Promise.all([wait, ...reads, ...controls]);
  }
  expect(started).toEqual([
    'wait',
    'agent_list',
    'agent_view',
    'agent_start',
    'agent_send',
    'agent_stop'
  ]);
});

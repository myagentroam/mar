import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionAgentsApi } from '../../src/extensions.js';
import { JsonlSessionStore } from '../../src/session/store/index.js';
import { fixture, cleanupCoreFixtures } from './support/core-extension-fixture.js';

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupCoreFixtures();
});

describe('SDK subagent detail residency', () => {
  it('uses child writer durability and preserves independent native observations after eviction', async () => {
    let first!: ExtensionAgentsApi;
    let second!: ExtensionAgentsApi;
    const f = await fixture(
      [
        {
          id: 'first',
          apiVersion: '1.0',
          attachSession: (c) => {
            if (c.agents) first = c.agents;
          }
        },
        {
          id: 'second',
          apiVersion: '1.0',
          attachSession: (c) => {
            if (c.agents) second = c.agents;
          }
        }
      ],
      () => [
        { type: 'text.completed', itemId: 'answer', phase: 'final_answer', text: 'durable result' },
        { type: 'completed', reason: 'completed' }
      ]
    );
    await (await f.session.run({ prompt: 'initialize' })).result();
    let oldest = '';
    for (let i = 0; i < 20; i++) {
      const child = await first.spawn({ prompt: `child-${i}`, background: false });
      oldest ||= child.agentId;
      expect(child.status).toBe('completed');
    }
    // Foreground spawn consumed this native owner's terminal result, not the model's.
    expect(await first.wait({ agentId: oldest, waitMs: 1 })).not.toHaveProperty('summary');
    // Model update consumption and eviction happen at successive preparation boundaries.
    await (await f.session.run({ prompt: 'consume updates' })).result();
    await (await f.session.run({ prompt: 'prepare resources' })).result();
    const read = vi.spyOn(JsonlSessionStore.prototype, 'read');
    expect(await first.inspect({ agentId: oldest })).toHaveProperty('summary', 'durable result');
    expect(read.mock.calls.filter(([id]) => id === oldest)).toHaveLength(1);
    expect(await first.wait({ agentId: oldest, waitMs: 1 })).not.toHaveProperty('summary');
    expect(await second.wait({ agentId: oldest, waitMs: 1 })).toHaveProperty(
      'summary',
      'durable result'
    );
    expect(await second.wait({ agentId: oldest, waitMs: 1 })).not.toHaveProperty('summary');
    const listed = await first.list();
    expect(listed).toHaveLength(20);
    expect(listed.every((s) => s.summary === 'durable result')).toBe(true);
  });
});

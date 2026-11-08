import { afterEach, describe, expect, it } from 'vitest';
import type { SessionExtensionContext } from '../../src/extensions/contracts.js';
import { fixture, answer, cleanupCoreFixtures } from './support/core-extension-fixture.js';

afterEach(cleanupCoreFixtures);

async function context() {
  let context!: SessionExtensionContext;
  const { agent, session } = await fixture(
    [
      {
        id: 'revocation',
        apiVersion: '1.0',
        attachSession(value) {
          context = value;
        }
      }
    ],
    () => answer()
  );
  await session.run({ prompt: 'initialize' }).result();
  return { context, agent };
}

describe('captured tool reference lifetime', () => {
  it('preserves a captured handler until owner retirement without rebinding to a same-name replacement', async () => {
    const {
      context: { tools },
      agent
    } = await context();
    let oldCalls = 0;
    const resource = tools.register({
      name: 'probe',
      description: 'Probe',
      inputSchema: { type: 'object' },
      execute: () => {
        oldCalls++;
        return { content: 'old' };
      }
    });
    await resource.ready;
    const ref = tools.catalog().find((ref) => ref.definition.name === 'probe')!;
    await resource.dispose();
    expect(await tools.check({ name: 'probe', ref, arguments: {} })).toMatchObject({
      available: true
    });
    expect(await tools.invoke({ name: 'probe', ref, arguments: {} })).toHaveProperty(
      'content',
      'old'
    );
    const replacement = tools.register({
      name: 'probe',
      description: 'Replacement',
      inputSchema: { type: 'object' },
      execute: () => ({ content: 'new' })
    });
    await replacement.ready;
    expect(await tools.invoke({ name: 'probe', ref, arguments: {} })).toHaveProperty(
      'content',
      'old'
    );
    expect(await tools.invoke({ name: 'probe', arguments: {} })).toHaveProperty('content', 'new');
    expect(oldCalls).toBe(2);
    await agent.dispose();
    await expect(tools.invoke({ name: 'probe', ref, arguments: {} })).rejects.toMatchObject({
      code: 'MAR_AGENT_EXTENSION_RETIRED'
    });
  });

  it('lets an entered handler and its captured reference finish after unregistering', async () => {
    const {
      context: { tools }
    } = await context();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let calls = 0;
    const resource = tools.register({
      name: 'probe',
      description: 'Probe',
      inputSchema: { type: 'object' },
      async execute() {
        if (++calls === 1) {
          started.resolve();
          await finish.promise;
        }
        return { content: 'entered' };
      }
    });
    await resource.ready;
    const ref = tools.catalog().find((ref) => ref.definition.name === 'probe')!;
    const pending = tools.invoke({ name: 'probe', ref, arguments: {} });
    try {
      await started.promise;
      await resource.dispose();
      expect(await tools.invoke({ name: 'probe', ref, arguments: {} })).toHaveProperty(
        'content',
        'entered'
      );
      finish.resolve();
      expect(await pending).toHaveProperty('content', 'entered');
      expect(calls).toBe(2);
    } finally {
      finish.resolve();
      await pending;
    }
  });
});

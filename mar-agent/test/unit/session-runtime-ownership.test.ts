import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionExtensionContext } from '../../src/extensions.js';
import { answer, cleanupCoreFixtures, fixture } from './support/core-extension-fixture.js';

afterEach(cleanupCoreFixtures);

describe('Session execution ownership across handles', () => {
  it('uses the executing handle model and mode through the shared backend', async () => {
    let context!: SessionExtensionContext;
    const seen: Array<{ modelId: string; mode: string | undefined }> = [];
    const f = await fixture(
      [
        {
          id: 'ownership',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
            value.hooks.intercept('prompt.submit', async (input, _call, next) => {
              const description = await value.session!.describe();
              const composition = await value.prompts.composeDefault();
              seen.push({ modelId: description.modelId, mode: composition.facts?.mode });
              return next(input);
            });
          }
        }
      ],
      answer
    );
    await f.agent.reconfigureModels({
      models: [
        f.adapter.configuration,
        {
          ...f.adapter.configuration,
          id: 'other',
          name: 'Other'
        }
      ],
      defaultModelId: 'test'
    });
    const reopened = await f.agent.openSession(f.session.id);
    expect(await reopened.plan({ prompt: 'plan', modelId: 'other' }).result()).toMatchObject({
      status: 'completed'
    });
    expect(seen).toEqual([{ modelId: 'other', mode: 'plan' }]);
    expect(await context.session!.describe()).toMatchObject({ modelId: 'test' });
    expect((await context.prompts.composeDefault()).facts).toMatchObject({
      mode: 'run',
      modelId: 'test'
    });
    expect(await f.session.run({ prompt: 'next' }).result()).toMatchObject({ status: 'completed' });
    expect(seen.at(-1)).toEqual({ modelId: 'test', mode: 'run' });
  });

  it.each(['cancelled', 'failed'] as const)(
    'revokes the shared context after a %s preparation',
    async (status) => {
      let context!: SessionExtensionContext;
      let ready!: () => void;
      let resume!: () => void;
      const entered = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      let first = true;
      const f = await fixture(
        [
          {
            id: 'preparation',
            apiVersion: '1.0',
            attachSession(value) {
              context = value;
              value.hooks.intercept('prompt.submit', async (input, _call, next) => {
                if (first) {
                  first = false;
                  ready();
                  await gate;
                  if (status === 'failed') throw new Error('Fixture preparation failed.');
                }
                return next(input);
              });
            }
          }
        ],
        answer
      );
      await f.agent.reconfigureModels({
        models: [
          f.adapter.configuration,
          {
            ...f.adapter.configuration,
            id: 'other',
            name: 'Other'
          }
        ],
        defaultModelId: 'test'
      });
      const listExecutionExtensions = vi.fn(async () => ({ skills: [] }));
      Object.assign(f.host, { listExecutionExtensions });
      const reopened = await f.agent.openSession(f.session.id);
      const pending = reopened.plan({ prompt: 'prepare', modelId: 'other' });
      try {
        await entered;
        expect(() => f.session.run({ prompt: 'must not enter' })).toThrow(
          expect.objectContaining({ code: 'MAR_AGENT_EXECUTION_ACTIVE' })
        );
        expect(await context.session!.describe()).toMatchObject({ modelId: 'other' });
        listExecutionExtensions.mockClear();
        expect(
          (await context.prompts.composeDefault({ modelId: 'test', mode: 'run', tools: [] })).facts
        ).toEqual({ modelId: 'test', mode: 'run', tools: [] });
        expect(listExecutionExtensions).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionId: f.session.id,
            executionId: pending.executionId,
            modelId: 'test'
          })
        );
        if (status === 'cancelled') pending.cancel();
      } finally {
        resume();
      }
      expect(await pending.result()).toMatchObject({ status });
      expect(await context.session!.describe()).toMatchObject({ modelId: 'test' });
      expect((await context.prompts.composeDefault()).facts).toMatchObject({
        modelId: 'test',
        mode: 'run'
      });
      expect(await f.session.run({ prompt: 'next execution' }).result()).toMatchObject({
        status: 'completed'
      });
    }
  );

  it('does not replace an absent execution instruction with a later Host update', async () => {
    let context!: SessionExtensionContext;
    let inspect!: () => Promise<void>;
    const f = await fixture(
      [
        {
          id: 'instruction',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
            value.hooks.intercept('prompt.submit', async (input, _call, next) => {
              await inspect();
              const composition = await value.prompts.composeDefault();
              expect(composition.sections.map((part) => part.text).join('\n')).not.toContain(
                'LATER_HOST_POLICY'
              );
              return next(input);
            });
          }
        }
      ],
      answer
    );
    inspect = async () => {
      f.agent.setSystemInstruction('LATER_HOST_POLICY');
    };
    expect(await f.session.run({ prompt: 'keep snapshot' }).result()).toMatchObject({
      status: 'completed'
    });
    expect(
      (await context.prompts.composeDefault()).sections.map((part) => part.text).join('\n')
    ).toContain('LATER_HOST_POLICY');
  });
});

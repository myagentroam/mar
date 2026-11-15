import { effectiveInstructions } from './support/model-context.js';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionExtensionContext } from '../../src/extensions.js';
import * as prompts from '../../src/prompts/index.js';
import { normalizePromptComposition } from '../../src/extensions/prompt-composition.js';
import { answer, cleanupCoreFixtures, fixture } from './support/core-extension-fixture.js';

afterEach(cleanupCoreFixtures);

describe('Core structured Prompt composition', () => {
  it.each([
    ['run', [], 'f6facf2f7a772ded1446cf59aac493e9113887f1c7824be86b8ede325bdc2f99'],
    [
      'run',
      ['read', 'exec', 'skill'],
      'bf0b78260966c973822f0d9b11cb0f3a13d9aabdfb73976e63aaf240c7e4b299'
    ],
    ['plan', [], '43f0786265a49a7848e30d2dbd3cea52547669cd89c91a24f518e1150280ba7a'],
    [
      'plan',
      ['read', 'exec', 'skill'],
      'b531f7af7e8e676bd742d65dc3f7f82029bd9f2c0459bc1ca2a39c83c75df0cf'
    ],
    ['compact', [], '9d453e4f73a6bdd80c59c7d191affdb3971a9ec018d46725079a684407b90d4f'],
    [
      'compact',
      ['read', 'exec', 'skill'],
      'e69dde0f081f4a0df9eb216c5967b6edd402d48276fd1de4b1f41e0d43aece21'
    ]
  ] as const)('preserves the current %s Prompt bytes (%j)', (mode, tools, digest) => {
    const input = {
      mode,
      tools,
      platform: 'linux',
      workspace: '/fixture',
      extension: 'FIXTURE_CALLER'
    };
    const parts = prompts.buildSystemPromptSections(input);
    expect(createHash('sha256').update(prompts.buildSystemPrompt(input)).digest('hex')).toBe(
      digest
    );
    expect(
      parts
        .filter((part) => part.text)
        .map((part) => part.text)
        .join('\n\n')
    ).toBe(prompts.buildSystemPrompt(input));
    expect(Object.isFrozen(parts)).toBe(true);
  });

  it.each([
    null,
    {},
    { sections: [undefined] },
    { sections: new Array(1) },
    { sections: [], facts: { tools: new Array(1) } },
    { sections: [], facts: { mode: 'unknown' } }
  ])('rejects malformed explicit composition %j', (input) => {
    expect(() => normalizePromptComposition(input)).toThrow(
      expect.objectContaining({ code: 'MAR_AGENT_EXTENSION_PROMPT_INVALID' })
    );
  });

  it('preserves Hook ancestry for nested pure composition while retaining other registrations', async () => {
    let context!: SessionExtensionContext;
    const own: string[] = [];
    const other: string[] = [];
    const f = await fixture(
      [
        {
          id: 'nested',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
            value.hooks.intercept('prompt.section', async (part, _call, next) => {
              if (part.id === 'outer' || part.id === 'inner') own.push(part.id);
              if (part.id === 'outer') {
                const nested = await value.prompts.composeSections({
                  sections: [{ id: 'inner', text: 'INNER' }]
                });
                expect(nested.sections[0]?.text).toBe('INNER:other');
              }
              return next(part);
            });
            value.hooks.intercept('prompt.section', (part, _call, next) => {
              if (part.id === 'outer' || part.id === 'inner') other.push(part.id);
              return next({ ...part, text: part.text === null ? null : `${part.text}:other` });
            });
          }
        }
      ],
      answer
    );
    await f.session.run({ prompt: 'initialize' }).result();
    expect(
      (await context.prompts.composeSections({ sections: [{ id: 'outer', text: 'OUTER' }] }))
        .sections[0]?.text
    ).toBe('OUTER:other');
    expect(own).toEqual(['outer']);
    expect(other).toEqual(['inner', 'outer']);
    expect(f.adapter.requests).toHaveLength(1);
  });

  it.each(['ANTHROPIC_MESSAGES', 'OPENAI_RESPONSES'] as const)(
    'uses actual assembler sections and facts in the main request and Compact (%s)',
    async (protocol) => {
      const visits: Array<{ mode?: string; modelId?: string; tools?: readonly string[] }> = [];
      const f = await fixture(
        [
          {
            id: 'parts',
            apiVersion: '1.0',
            attachSession(context) {
              context.hooks.intercept('prompt.sections', (input, _call, next) => {
                visits.push(input.facts ?? {});
                expect(input.sections.some((part) => part.id === 'core:identity')).toBe(true);
                return next({
                  ...input,
                  sections: [...input.sections, { id: 'parts:policy', text: 'STRUCTURED_POLICY' }]
                });
              });
              context.hooks.intercept('prompt.section', (part, _call, next) =>
                next({
                  ...part,
                  text:
                    part.id === 'core:identity'
                      ? 'REPLACED_IDENTITY'
                      : part.id === 'core:output-style'
                        ? null
                        : part.text
                })
              );
              context.hooks.intercept('prompt.compose', (text, _call, next) =>
                next(`${text}\nFINAL_STRING_HOOK`)
              );
            }
          }
        ],
        answer,
        false,
        false,
        {},
        protocol
      );
      expect(await f.session.run({ prompt: 'initialize' }).result()).toHaveProperty(
        'status',
        'completed'
      );
      expect(f.adapter.requests[0]?.system).toContain('REPLACED_IDENTITY');
      expect(f.adapter.requests[0]?.system).toContain('STRUCTURED_POLICY');
      expect(f.adapter.requests[0]?.system).toContain('FINAL_STRING_HOOK');
      expect(f.adapter.requests[0]?.system).not.toContain('You are MAR Agent');
      expect(visits[0]).toMatchObject({
        mode: 'run',
        modelId: 'test',
        tools: expect.arrayContaining(['read'])
      });
      expect(await f.session.compact().result()).toHaveProperty('status', 'completed');
      expect(visits.length).toBeGreaterThan(1);
      for (const request of f.adapter.requests) {
        expect(request.system).toContain('STRUCTURED_POLICY');
        expect(request.system).toContain('REPLACED_IDENTITY');
      }
    }
  );

  it('exposes omitted conditional parts to section hooks without parsing strings', async () => {
    const f = await fixture(
      [
        {
          id: 'omitted',
          apiVersion: '1.0',
          attachSession(context) {
            context.hooks.intercept('prompt.section', (part, _call, next) => {
              if (part.id === 'core:mode') {
                expect(part.text).toBe(null);
                return next({ ...part, text: 'EXPLICIT_CONDITIONAL_SECTION' });
              }
              return next(part);
            });
          }
        }
      ],
      answer
    );
    expect(await f.session.run({ prompt: 'initialize' }).result()).toHaveProperty(
      'status',
      'completed'
    );
    expect(effectiveInstructions(f.adapter.requests[0]!)).toContain('EXPLICIT_CONDITIONAL_SECTION');
  });

  it('copies and freezes explicit composition without sending a request or running the final string hook', async () => {
    let context!: SessionExtensionContext;
    let strings = 0;
    const f = await fixture(
      [
        {
          id: 'copy',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
            value.prompts.register({ id: 'copy:registered', text: 'REGISTERED' });
            value.hooks.intercept('prompt.compose', (input, _call, next) => {
              strings++;
              return next(input);
            });
          }
        }
      ],
      answer
    );
    await f.session.run({ prompt: 'initialize' }).result();
    const before = f.adapter.requests.length;
    const input = { sections: [{ id: 'manual', text: 'MANUAL' }], facts: { tools: ['read'] } };
    const output = await context.prompts.composeSections(input);
    input.sections[0]!.text = 'MUTATED';
    input.facts.tools.push('exec');
    expect(output.sections).toEqual([
      { id: 'manual', text: 'MANUAL' },
      { id: 'copy:registered', text: 'REGISTERED' }
    ]);
    expect(output.facts?.tools).toEqual(['read']);
    expect(Object.isFrozen(output)).toBe(true);
    expect(Object.isFrozen(output.sections)).toBe(true);
    expect(output.sections.every(Object.isFrozen)).toBe(true);
    expect(f.adapter.requests.length).toBe(before);
    expect(strings).toBe(1);
    expect(await context.prompts.compose('Explicit base')).toBe('Explicit base\n\nREGISTERED');
  });

  it('captures registered sections once and uses new contributions only on the next composition', async () => {
    let context!: SessionExtensionContext;
    let replaced = false;
    const f = await fixture(
      [
        {
          id: 'snapshot',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
            const registration = value.prompts.register({ id: 'snapshot:part', text: 'OLD' });
            value.hooks.intercept('prompt.section', async (part, _call, next) => {
              if (part.id === 'manual' && !replaced) {
                replaced = true;
                await registration.dispose();
                value.prompts.register({ id: 'snapshot:part', text: 'NEW' });
              }
              return next(part);
            });
          }
        }
      ],
      answer
    );
    await f.session.run({ prompt: 'initialize' }).result();
    const input = { sections: [{ id: 'manual', text: 'base' }] };
    expect((await context.prompts.composeSections(input)).sections.at(-1)?.text).toBe('OLD');
    expect((await context.prompts.composeSections(input)).sections.at(-1)?.text).toBe('NEW');
  });

  it('supports whole-list short circuit without re-dispatching section handlers', async () => {
    let parts = 0;
    const f = await fixture(
      [
        {
          id: 'short',
          apiVersion: '1.0',
          attachSession(context) {
            context.hooks.intercept('prompt.sections', () => ({
              sections: [{ id: 'short:answer', text: 'WHOLE_PROMPT' }]
            }));
            context.hooks.intercept('prompt.section', (input, _call, next) => {
              parts++;
              return next(input);
            });
          }
        }
      ],
      answer
    );
    expect(await f.session.run({ prompt: 'initialize' }).result()).toHaveProperty(
      'status',
      'completed'
    );
    expect(f.adapter.requests[0]?.system).toBe('WHOLE_PROMPT');
    expect(parts).toBe(0);
  });

  it.each(['invalid-next', 'invalid-return', 'duplicate-return'] as const)(
    'rejects %s before sending the model request',
    async (fault) => {
      const f = await fixture(
        [
          {
            id: 'invalid',
            apiVersion: '1.0',
            attachSession(context) {
              context.hooks.intercept('prompt.sections', (input, _call, next) => {
                if (fault === 'invalid-next')
                  return next({ sections: [{ id: '', text: 'invalid' }] });
                if (fault === 'duplicate-return')
                  return {
                    sections: [
                      { id: 'same', text: 'one' },
                      { id: 'same', text: 'two' }
                    ]
                  };
                return { sections: [{ id: 'bad', text: 42 }] } as unknown as typeof input;
              });
            }
          }
        ],
        answer
      );
      expect(await f.session.run({ prompt: 'blocked' }).result()).toMatchObject({
        status: 'failed',
        errorCode: expect.stringMatching(/MAR_AGENT_EXTENSION_PROMPT_(INVALID|CONFLICT)/)
      });
      expect(f.adapter.requests).toHaveLength(0);
    }
  );

  it.each([
    'null-next',
    'bad-facts',
    'retarget-next',
    'bad-text-return',
    'bad-final-string'
  ] as const)(
    'rejects malformed runtime Hook output (%s) with a stable Prompt diagnostic',
    async (fault) => {
      let context!: SessionExtensionContext;
      const f = await fixture(
        [
          {
            id: 'runtime-invalid',
            apiVersion: '1.0',
            attachSession(value) {
              context = value;
            }
          }
        ],
        answer
      );
      await f.session.run({ prompt: 'initialize' }).result();
      if (fault === 'bad-final-string')
        context.hooks.intercept('prompt.compose', () => 42 as never);
      else
        context.hooks.intercept('prompt.section', (part, _call, next) => {
          if (fault === 'null-next') return next(null as never);
          if (fault === 'bad-facts') return next({ ...part, facts: { tools: 42 as never } });
          if (fault === 'retarget-next') return next({ ...part, id: 'other' });
          return 42 as never;
        });
      await expect(context.prompts.compose('Explicit base')).rejects.toMatchObject({
        code: 'MAR_AGENT_EXTENSION_PROMPT_INVALID'
      });
      expect(f.adapter.requests).toHaveLength(1);
    }
  );

  it('cancels in-flight composition on clear and refuses its retired facade', async () => {
    let context!: SessionExtensionContext;
    const entered = Promise.withResolvers<void>();
    const f = await fixture(
      [
        {
          id: 'cancel',
          apiVersion: '1.0',
          attachSession(value) {
            context = value;
            value.hooks.intercept('prompt.section', async (part, call, next) => {
              if (part.id === 'blocked') {
                entered.resolve();
                await new Promise((_, reject) =>
                  call.signal.addEventListener('abort', () => reject(call.signal.reason), {
                    once: true
                  })
                );
              }
              return next(part);
            });
          }
        }
      ],
      answer
    );
    await f.session.run({ prompt: 'initialize' }).result();
    const stale = context;
    const composition = context.prompts.composeSections({
      sections: [{ id: 'blocked', text: 'old' }]
    });
    const rejected = expect(composition).rejects.toThrow();
    await entered.promise;
    await f.agent.clearSession(f.session.id);
    await rejected;
    await expect(stale.prompts.composeSections({ sections: [] })).rejects.toThrow(/RETIRED/);
    expect(await f.session.run({ prompt: 'new epoch' }).result()).toHaveProperty(
      'status',
      'completed'
    );
  });
});

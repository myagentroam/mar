import { describe, expect, it, vi } from 'vitest';
import { createExecutionRoundPreparer } from '../../src/sdk/execution-round-preparation.js';
import { prepareExecutionRoundRequest } from '../../src/sdk/execution-round-request.js';
import { resetContextualWorldState } from '../../src/runtime/context/world-state.js';

describe('execution round preparation', () => {
  it('passes complete request context to normal request preparation without a separate budget', async () => {
    let world = resetContextualWorldState(undefined, 0, {
      instructionSnapshot: undefined,
      instructionContent: undefined
    });
    const boardId = 'request:shared';
    const model = {
      protocol: 'OPENAI_RESPONSES',
      inputCapabilities: ['TEXT'],
      contextWindowTokens: 4096,
      maxOutputTokens: 1024
    } as const;
    const prepare = (content: string, paragraphs: string[]) =>
      prepareExecutionRoundRequest({
        messages: paragraphs.map((text) => ({ role: 'user', content: text })),
        model,
        requestBase: {},
        residentTools: () => [],
        autoPermission: false,
        signal: new AbortController().signal,
        capture: () => ({
          roundTools: [],
          roundBindings: undefined,
          toolScope: undefined,
          composeSystemPrompt: async () => ({ text: 'System' })
        }),
        requestContext: async () => ({
          items: [
            { id: 'shared', content },
            { id: 'stable', content: 'Unchanged shared data' }
          ]
        }),
        bind: () => {},
        world: () => world,
        commitWorld: async (next) => {
          world = next;
        },
        preparing: () => {},
        transform: async (request) => request
      });
    const first = await prepare('Initial view', ['First']);
    await first.acknowledgeRequestContext!();
    const large = 'new detail '.repeat(2000);
    const second = await prepare(large, ['First', 'Second']);
    const messages = second.request.messages;
    expect(messages.slice(0, first.request.messages.length)).toEqual(first.request.messages);
    expect(
      messages.filter(({ contextualBlock }) => contextualBlock?.id === 'request:stable')
    ).toEqual(
      first.request.messages.filter(
        ({ contextualBlock }) => contextualBlock?.id === 'request:stable'
      )
    );
    expect(messages.at(-1)).toMatchObject({
      contextualBlock: { id: boardId, operation: 'replace' },
      content: expect.stringContaining(large)
    });
  });

  it('commits ordinary prompt changes without committing a pending data change', async () => {
    let world = resetContextualWorldState(undefined, 0, {
      instructionSnapshot: undefined,
      instructionContent: undefined
    });
    const candidate = await prepareExecutionRoundRequest({
      messages: [{ role: 'user', content: 'Continue.' }],
      model: { protocol: 'OPENAI_RESPONSES', inputCapabilities: ['TEXT'] },
      requestBase: {},
      residentTools: () => [],
      autoPermission: false,
      signal: new AbortController().signal,
      requestContext: async () => ({ items: [{ id: 'shared', content: 'Pending data' }] }),
      capture: () => ({
        roundTools: [],
        roundBindings: undefined,
        toolScope: undefined,
        composeSystemPrompt: async () => ({
          text: 'Core\n\nInstructions',
          sections: [
            { id: 'core:identity', text: 'Core' },
            { id: 'core:caller-instructions', text: 'Instructions' }
          ]
        })
      }),
      bind: () => {},
      world: () => world,
      commitWorld: async (next) => {
        world = next;
      },
      preparing: () => {},
      transform: async (request) => request
    });
    expect(world.promptSnapshot?.map(({ id }) => id)).toEqual(['core:caller-instructions']);
    expect(candidate.request.messages.map(({ contextualBlock }) => contextualBlock?.id)).toContain(
      'request:shared'
    );
    await candidate.acknowledgeRequestContext!();
    expect(world.promptSnapshot?.map(({ id }) => id)).toEqual(['core:caller-instructions']);
    expect(world.entries.at(-1)).toMatchObject({
      block: { id: 'request:shared', authority: 'context' }
    });
  });

  it.each([undefined, 'workflow', 'request:shared'])(
    'keeps Skill acknowledgement independent of extensions and filtered block %s',
    async (filtered) => {
      let world = resetContextualWorldState(undefined, 0, {
        instructionSnapshot: undefined,
        instructionContent: undefined
      });
      const acknowledge = vi.fn();
      const commitWorld = vi.fn(
        async (next: typeof world, _loads?: ReadonlyMap<string, string>) => {
          world = next;
        }
      );
      const loads = new Map([['workflow', 'Follow the workflow.']]);
      const candidate = await prepareExecutionRoundRequest({
        messages: [{ role: 'user', content: 'Continue.' }],
        model: { protocol: 'OPENAI_RESPONSES', inputCapabilities: ['TEXT'] },
        requestBase: {},
        residentTools: () => [],
        autoPermission: false,
        signal: new AbortController().signal,
        skillLoads: loads,
        requestContext: async () => ({
          items: [{ id: 'shared', content: 'Shared data' }],
          acknowledge
        }),
        capture: () => ({
          roundTools: [],
          roundBindings: undefined,
          toolScope: undefined,
          composeSystemPrompt: async () => ({ text: 'System' })
        }),
        bind: () => {},
        world: () => world,
        commitWorld,
        preparing: () => {},
        transform: async (request) =>
          filtered === undefined
            ? request
            : {
                ...request,
                messages: request.messages.filter(
                  ({ contextualBlock }) => !contextualBlock?.id.endsWith(filtered)
                )
              }
      });
      expect(world.entries).toEqual([]);
      commitWorld.mockClear();
      await candidate.acknowledgeRequestContext?.();
      expect(acknowledge).toHaveBeenCalledTimes(filtered === 'request:shared' ? 0 : 1);
      expect(commitWorld).toHaveBeenCalledTimes(filtered === 'request:shared' ? 0 : 1);
      expect(world.entries.some(({ kind }) => kind === 'loaded-skill')).toBe(false);

      await candidate.acknowledgeSkillContext!();
      expect(commitWorld.mock.calls.at(-1)?.[1]).toBe(loads);
      expect(world.entries.map(({ block }) => block?.id)).toEqual([
        ...(filtered === 'request:shared' ? [] : ['request:shared']),
        'runtime:loaded-skill:workflow'
      ]);
    }
  );

  it('only anchors Skill guidance after the prepared request is acknowledged', async () => {
    const skillId = 'runtime:loaded-skill:workflow';
    let world = resetContextualWorldState(undefined, 0, {
      instructionSnapshot: undefined,
      instructionContent: undefined
    });
    const prepare = (body: string) =>
      prepareExecutionRoundRequest({
        messages: [{ role: 'user', content: 'Follow the workflow.' }],
        model: { protocol: 'OPENAI_RESPONSES', inputCapabilities: ['TEXT'] },
        requestBase: {},
        residentTools: () => [],
        autoPermission: false,
        signal: new AbortController().signal,
        skillLoads: new Map([['workflow', body]]),
        capture: () => ({
          roundTools: [],
          roundBindings: undefined,
          toolScope: undefined,
          composeSystemPrompt: async () => ({ text: 'System' })
        }),
        bind: () => {},
        world: () => world,
        commitWorld: async (next) => {
          world = next;
        },
        preparing: () => {},
        transform: async (request) => request
      });
    const discarded = await prepare('Discarded guidance.');
    expect(discarded.request.messages.find((m) => m.contextualBlock?.id === skillId)?.content).toBe(
      'Discarded guidance.'
    );
    expect(world.entries.some((entry) => entry.block?.id === skillId)).toBe(false);
    const accepted = await prepare('Accepted guidance.');
    expect(accepted.replacesSkillContext).toBe(false);
    expect(world.entries.some((entry) => entry.block?.id === skillId)).toBe(false);
    await accepted.acknowledgeSkillContext!();
    expect(
      world.entries.filter((entry) => entry.block?.id === skillId).map((entry) => entry.content)
    ).toEqual(['Accepted guidance.']);
    const unchanged = await prepare('Accepted guidance.');
    expect(unchanged.replacesSkillContext).toBe(false);
    const replacement = await prepare('Replacement guidance.');
    expect(replacement.replacesSkillContext).toBe(true);
    expect(world.entries.find((entry) => entry.block?.id === skillId)?.content).toBe(
      'Accepted guidance.'
    );
  });

  it('rebuilds after late input and resource adoption without recollecting subagent updates', async () => {
    const calls: string[] = [];
    let attempt = 0;
    const prepare = createExecutionRoundPreparer<number, number>({
      prepareInputs: async (collect) => {
        calls.push(`inputs:${collect}`);
      },
      buildCandidate: async () => {
        calls.push('candidate');
        return ++attempt;
      },
      adoptLateInput: async () => {
        calls.push('late');
        return attempt === 1;
      },
      prepareResources: async (candidate) => {
        calls.push(`resources:${candidate}`);
        return candidate === 2 ? { retry: true } : { round: candidate };
      }
    });
    await expect(prepare()).resolves.toBe(3);
    expect(calls).toEqual([
      'inputs:true',
      'candidate',
      'late',
      'inputs:false',
      'candidate',
      'late',
      'resources:2',
      'inputs:false',
      'candidate',
      'late',
      'resources:3'
    ]);
  });
});

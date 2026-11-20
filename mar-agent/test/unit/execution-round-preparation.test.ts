import { describe, expect, it } from 'vitest';
import { createExecutionRoundPreparer } from '../../src/sdk/execution-round-preparation.js';
import { prepareExecutionRoundRequest } from '../../src/sdk/execution-round-request.js';
import { resetContextualWorldState } from '../../src/runtime/context/world-state.js';

describe('execution round preparation', () => {
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
    expect(world.entries.some((entry) => entry.block?.id === skillId)).toBe(false);
    await accepted.acknowledgeSkillContext!();
    expect(
      world.entries.filter((entry) => entry.block?.id === skillId).map((entry) => entry.content)
    ).toEqual(['Accepted guidance.']);
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

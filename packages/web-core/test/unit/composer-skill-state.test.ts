import { parseComposerTags } from '@myagentroam/protocol';
import { workspaceTargetRef } from './support/workspace-fixture.js';
import { describe, expect, it } from 'vitest';
import { ref } from 'vue';
import { createComposerSkillService } from '../../src/service/ComposerSkillService.js';
import type { EffectiveWorkspaceSkill } from '../../src/service/EffectiveWorkspaceSkillService.js';
import { createRunnerInteractionService } from '../../src/service/RunnerInteractionService.js';
import {
  createComposerSkillTokenService,
  serializeComposerMessage
} from '../../src/service/ComposerSkillTokenService.js';

const skillA: EffectiveWorkspaceSkill = {
  name: 'db-query',
  description: 'Query database',
  localStatus: 'INSTALLED',
  source: 'WORKSPACE',
  skillFilePath: '/workspace/.agents/skills/db-query/SKILL.md'
};
const skillB: EffectiveWorkspaceSkill = {
  name: 'redis-tool',
  description: 'Operate Redis',
  localStatus: 'INSTALLED',
  source: 'NODE_HOME',
  skillFilePath: '/home/agent/.agents/skills/redis-tool/SKILL.md'
};

function createSkillServiceHarness(options?: {
  readonly now?: () => number;
  readonly respond?: (path: string) => Promise<{ skills: readonly EffectiveWorkspaceSkill[] }>;
}) {
  const selectedNodeId = ref<string | undefined>('node-1');
  const selectedWorkspaceId = ref<string | undefined>('workspace-1');
  const skills = ref<readonly EffectiveWorkspaceSkill[]>([]);
  const loading = ref(false);
  const failed = ref(false);
  const requested: string[] = [];
  const service = createComposerSkillService({
    workspaceTarget: workspaceTargetRef(selectedNodeId, selectedWorkspaceId),
    skills,
    loading,
    failed,
    request: <T>(path: string): Promise<T> => {
      requested.push(path);
      return (options?.respond?.(path) ??
        Promise.resolve({ skills: [skillA, skillB] })) as Promise<T>;
    },
    ...(options?.now === undefined ? {} : { now: options.now })
  });
  return { service, selectedNodeId, selectedWorkspaceId, skills, loading, failed, requested };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('Web Composer Skill Loading State', () => {
  it('Loads skills when first invoked and avoids duplicate requests for five minutes', async () => {
    let now = 1_000_000;
    const harness = createSkillServiceHarness({ now: () => now });

    harness.service.ensureFresh();
    expect(harness.loading.value).toBe(true);
    await flush();
    expect(harness.skills.value.map((skill) => skill.name)).toEqual(['db-query', 'redis-tool']);
    expect(harness.loading.value).toBe(false);
    expect(harness.requested).toEqual([
      '/api/workspaces/workspace-1/effective-skills?nodeId=node-1'
    ]);

    now += 4 * 60 * 1000;
    harness.service.ensureFresh();
    await flush();
    expect(harness.requested).toHaveLength(1);
  });

  it('shows existing data while refreshing expired cache in the background', async () => {
    let now = 1_000_000;
    const replacement: EffectiveWorkspaceSkill = { ...skillA, description: 'Updated description' };
    const responses: Array<{ skills: readonly EffectiveWorkspaceSkill[] }> = [
      { skills: [skillA] },
      { skills: [replacement] }
    ];
    const harness = createSkillServiceHarness({
      now: () => now,
      respond: () => Promise.resolve(responses.shift() ?? { skills: [] })
    });

    harness.service.ensureFresh();
    await flush();
    expect(harness.skills.value[0]?.description).toBe('Query database');

    now += 6 * 60 * 1000;
    harness.service.ensureFresh();
    expect(harness.skills.value[0]?.description).toBe('Query database');
    expect(harness.loading.value).toBe(false);
    await flush();
    expect(harness.skills.value[0]?.description).toBe('Updated description');
    expect(harness.requested).toHaveLength(2);
  });

  it('Keeps the old cache when refresh fails and marks the service failed when no cache exists', async () => {
    let now = 1_000_000;
    let shouldFail = false;
    const harness = createSkillServiceHarness({
      now: () => now,
      respond: () =>
        shouldFail ? Promise.reject(new Error('NETWORK')) : Promise.resolve({ skills: [skillA] })
    });

    shouldFail = true;
    harness.service.ensureFresh();
    await flush();
    expect(harness.skills.value).toEqual([]);
    expect(harness.failed.value).toBe(true);

    shouldFail = false;
    harness.service.ensureFresh();
    await flush();
    expect(harness.skills.value[0]?.name).toBe('db-query');
    expect(harness.failed.value).toBe(false);

    shouldFail = true;
    now += 6 * 60 * 1000;
    harness.service.ensureFresh();
    await flush();
    expect(harness.skills.value[0]?.name).toBe('db-query');
    expect(harness.failed.value).toBe(true);
  });

  it('Does not repeat requests while loading the same context', async () => {
    const harness = createSkillServiceHarness();
    harness.service.ensureFresh();
    harness.service.ensureFresh();
    await flush();
    expect(harness.requested).toHaveLength(1);
  });

  it('Does not request skills and clears them when the Workspace context is missing', async () => {
    const harness = createSkillServiceHarness();
    harness.selectedWorkspaceId.value = undefined;
    harness.service.ensureFresh();
    await flush();
    expect(harness.requested).toHaveLength(0);
    expect(harness.skills.value).toEqual([]);
  });
});

describe('Web Composer Skill Selection and Sending', () => {
  function createInteractionHarness(inputValue: string) {
    type Options = Parameters<typeof createRunnerInteractionService>[0];
    const input = { value: inputValue } as Options['input'];
    const skills = ref<readonly EffectiveWorkspaceSkill[]>([skillA, skillB]);
    const state = createRunnerInteractionService({
      input,
      draftSessionOpen: { value: false } as Options['draftSessionOpen'],
      selectedSession: { value: undefined } as Options['selectedSession'],
      profile: {
        value: {
          runner: 'codex',
          models: [],
          accessOptions: [],
          commands: [
            {
              id: 'compact',
              runner: 'codex',
              label: 'Compact',
              description: 'Compact context',
              inputHint: '',
              source: 'CODEX_APP_SERVER',
              interaction: 'IMMEDIATE_ACTION',
              available: true,
              reasonCode: null
            }
          ],
          capabilities: []
        }
      } as unknown as Options['profile'],
      skills
    });
    return { input, state };
  }

  it('Filters skills by name and description for a command query', () => {
    const { input, state } = createInteractionHarness('/db');
    state.updatePicker(input.value.length);
    expect(state.visibleSkills.value.map((skill) => skill.name)).toEqual(['db-query']);

    input.value = '/redis';
    state.updatePicker(input.value.length);
    expect(state.visibleSkills.value.map((skill) => skill.name)).toEqual(['redis-tool']);

    input.value = '/';
    state.updatePicker(input.value.length);
    expect(state.visibleSkills.value).toHaveLength(2);
    expect(state.visibleEntryCount.value).toBe(3);
  });

  it('Adds only a skill token when selected and preserves the draft', () => {
    const { input, state } = createInteractionHarness('Keep this draft\n/db');
    state.updatePicker(input.value.length);
    const selected: EffectiveWorkspaceSkill[] = [];

    state.selectSkill(skillA, (skill) => selected.push(skill));

    expect(selected).toEqual([skillA]);
    expect(input.value).toBe('Keep this draft\n');
    expect(state.commandPickerOpen.value).toBe(false);
  });

  it('Moves across command and skill groups, selecting a skill without sending when Enter is pressed', () => {
    const { input, state } = createInteractionHarness('/');
    state.updatePicker(input.value.length);
    const selected: EffectiveWorkspaceSkill[] = [];
    const sends: Array<readonly [boolean, boolean | undefined, string | undefined]> = [];
    const keydown = (key: string) =>
      state.onKeydown(
        {
          key,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          preventDefault() {}
        } as KeyboardEvent,
        {
          mobile: false,
          canInterrupt: false,
          stop: () => undefined,
          send: (replaceCurrent, preserveDraft, contentOverride) =>
            sends.push([replaceCurrent, preserveDraft, contentOverride]),
          selectSkill: (skill) => selected.push(skill)
        }
      );

    keydown('ArrowDown');
    keydown('ArrowDown');
    expect(state.activeCommandIndex.value).toBe(2);
    keydown('ArrowDown');
    expect(state.activeCommandIndex.value).toBe(0);
    keydown('ArrowDown');
    keydown('ArrowDown');
    keydown('Enter');

    expect(sends).toEqual([]);
    expect(selected).toEqual([skillB]);
    expect(input.value).toBe('');
  });

  it('Deduplicates skill labels, removes them as a whole, and serializes them as a tag in selection order', () => {
    const input = ref('Body');
    const tokens = createComposerSkillTokenService();
    tokens.select(skillA);
    tokens.select(skillB);
    tokens.select(skillA);

    expect(parseComposerTags(serializeComposerMessage(tokens.tokens.value, input.value))).toEqual([
      { kind: 'text', text: 'Body\n' },
      expect.objectContaining({
        kind: 'mar_skills',
        payload: expect.objectContaining({
          action: 'use',
          skills: [
            {
              name: 'db-query',
              source: 'WORKSPACE',
              path: '/workspace/.agents/skills/db-query/SKILL.md'
            },
            {
              name: 'redis-tool',
              source: 'NODE_HOME',
              path: '/home/agent/.agents/skills/redis-tool/SKILL.md'
            }
          ]
        })
      })
    ]);
    tokens.remove('db-query');
    expect(tokens.tokens.value.map((token) => token.name)).toEqual(['redis-tool']);
    expect(input.value).toBe('Body');
  });

  it('Keeps skill selection order independent of the body cursor position', () => {
    const input = ref('Before and after');
    const tokens = createComposerSkillTokenService();
    tokens.select(skillA);
    tokens.select(skillB);

    expect(tokens.tokens.value.map((token) => token.name)).toEqual(['db-query', 'redis-tool']);
    expect(input.value).toBe('Before and after');
    expect(parseComposerTags(serializeComposerMessage(tokens.tokens.value, input.value))).toEqual([
      { kind: 'text', text: 'Before and after\n' },
      expect.objectContaining({
        kind: 'mar_skills',
        payload: expect.objectContaining({
          action: 'use',
          skills: [
            {
              name: 'db-query',
              source: 'WORKSPACE',
              path: '/workspace/.agents/skills/db-query/SKILL.md'
            },
            {
              name: 'redis-tool',
              source: 'NODE_HOME',
              path: '/home/agent/.agents/skills/redis-tool/SKILL.md'
            }
          ]
        })
      })
    ]);
  });
});

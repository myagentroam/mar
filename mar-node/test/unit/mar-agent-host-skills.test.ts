import { expect, it } from 'vitest';
import { computerUseHostSkill } from '../../src/runner/mar-agent/computer-use-skill.js';
import {
  marctlHostSkill,
  marctlExecutionEnvironment
} from '../../src/runner/mar-agent/marctl-skill.js';

it('offers scoped CLI guidance only in an authorized Workspace execution', async () => {
  const environment = {
    MAR_CTL_CONTEXT_REQUIRED: '1',
    MAR_CTL_SERVER_URL: 'https://fixture.invalid',
    MAR_CTL_USER_TOKEN: 'private-fixture-token',
    MAR_CTL_NODE_ID: 'node',
    MAR_CTL_WORKSPACE_ID: 'workspace',
    OTHER_SECRET: 'private'
  };
  for (const key of [
    'MAR_CTL_CONTEXT_REQUIRED',
    'MAR_CTL_SERVER_URL',
    'MAR_CTL_USER_TOKEN',
    'MAR_CTL_NODE_ID',
    'MAR_CTL_WORKSPACE_ID'
  ]) {
    const missing: Record<string, string> = { ...environment };
    delete missing[key];
    expect(marctlHostSkill(missing)).toBeUndefined();
  }
  const skill = marctlHostSkill(environment)!;
  expect(skill.requiredTools).toEqual(['exec']);
  expect(skill.description).toContain('model and effort configuration');
  expect(skill.description).toContain('persistent prompts, schedules');
  expect(skill.description).toContain('authorized Node discovery');
  expect(skill.description).toContain('remote commands, and file transfer');
  const content = await skill.load();
  for (const term of [
    '## MAR Workspace management',
    'Use native agent_* tools for Agent discovery, creation, communication, observation, waiting and stopping.',
    'Do not switch to marctl when a native operation fails.',
    'Use marctl agents config <id> --model <id> --effort <effort>',
    'Use agents prompt get/set/clear for persistent instructions',
    'Use agents schedule list/get/create/update for scheduled tasks',
    'marctl nodes lists authorized Nodes',
    'Session IDs and parent relationships do not grant authorization.'
  ])
    expect(content).toContain(term);
  expect(content).not.toContain(environment.MAR_CTL_USER_TOKEN);
  expect(content).toContain('\n\n');
  expect(marctlExecutionEnvironment(environment)).not.toHaveProperty('OTHER_SECRET');
  expect(marctlExecutionEnvironment()).toEqual({});
});

it('provides desktop guidance from the Node host with its real tool dependency', async () => {
  expect(computerUseHostSkill.requiredTools).toEqual([
    'mcp__mar_computer__exec',
    'mcp__mar_computer__wait'
  ]);
  const content = await computerUseHostSkill.load();
  for (const instruction of [
    '## Operating the desktop',
    'observationId',
    'OUTCOME_UNKNOWN',
    'paste_text',
    'untrusted task data',
    'combine a deterministic sequence',
    'Do not split predictable keyboard steps',
    'Runtime already returns a final primary-display screenshot',
    'exact locations, identifiers, and interaction instructions',
    'expected initialization or modal flow',
    'batch safe repetitive interactions',
    'small test stroke',
    'mcp__mar_computer__wait',
    'STOPPING',
    'wait timeout or interrupted wait does not stop the task',
    'complete strokes or bounded batches',
    'restore those settings in a finally block',
    'do not operate the same desktop',
    'Do not issue sleep-only calls',
    'resumed transparently for a later Run',
    'Always obtain a fresh observation after a Run boundary'
  ])
    expect(content).toContain(instruction);
});

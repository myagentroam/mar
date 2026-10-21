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
  expect(skill.description).toContain('MAR-managed Workspace');
  expect(skill.description).toContain('scheduled tasks');
  expect(skill.description).toContain('status/history/results');
  expect(skill.description).toContain('for the current or other Sessions');
  expect(skill.description).toContain('other authorized MAR Nodes');
  expect(skill.description).toContain('Ordinary local shell work');
  const content = await skill.load();
  for (const term of [
    'sessions start',
    'sessions wait',
    '24 hours',
    'fixer#<task-id>',
    'reviewer#<task-or-change-id>',
    'never automatically wakes',
    'untrusted task data'
  ])
    expect(content).toContain(term);
  for (const instruction of [
    'only when the current identity or scope is unknown',
    'known target ID',
    'sessions config <session-id> --model <id> --effort high --json',
    'may switch the current execution',
    'Choose exactly one of --steer or --queue, even when idle',
    'Use --queue to place input in a subsequent turn',
    'Additional context: focus on the resume path.',
    'missing, conflicting, repeated, or obsolete options are rejected locally',
    'when fresh state is needed',
    'sessions list --limit 10 --json',
    '--query <title>',
    '--parent <session-id>',
    'sessions graph <session-id>',
    'without scanning Runners',
    'Do not scan the Workspace to prove capacity',
    'Reuse recorded Session/Run IDs and receipts',
    'session.status',
    'sessions rename <session-id> --title <name>',
    'sessions schedule list/get/create/update',
    'send/goal/stop/wait always require explicit target IDs',
    'Other-owner edits return a PENDING proposal',
    'session.model',
    'session.effort',
    'session.title',
    'session.runId',
    'session.queuedCount',
    'session.latestMessage',
    'session.recentTools',
    'RUNNING/IDLE/SLEEPING',
    'progress, the last observed snapshot',
    'decision-changing updates rather than routine reports',
    'ordinary queued input waits until the Goal exits',
    'latest 10 SEGMENTs, not messages',
    '--limit 1..100',
    'segments[].items[]',
    'assistant_message',
    'kind === "assistant_message"',
    'payload.text',
    'user_message.payload.clientMessageId',
    'Reuse the returned page',
    '--cursor <nextCursor>',
    'Follow the repository workflow for development and review',
    'Prefer --timeout 5m',
    'reuse its process/cell handle',
    'Session Prompt is edited in the Web UI only',
    'no queue-item edit/delete/reorder commands'
  ])
    expect(content).toContain(instruction);
  for (const instruction of [
    'shared by all Session subcommands',
    'get returns task (null if absent)',
    'id, revision, objective, cron, timezone and enabled',
    'applied updates also return task',
    'Reuse that task instead of probing its shape or refetching unchanged state',
    'Schedule text is trimmed at both ends',
    'compare after the same trimming',
    'a conclusive update response needs no extra get'
  ])
    expect(content).toContain(instruction);
  expect(content).not.toContain('--forced');
  expect(content).not.toContain('urgent corrections');
  expect(content).not.toContain('without interrupting');
  expect(content).not.toContain('not live steering');
  expect(content).not.toContain('Start with marctl sessions current');
  expect(content).not.toContain('--delivery');
  expect(content).not.toContain('cancel the current Run');
  expect(content).not.toContain('There is no Session custom prompt setting');
  expect(content).not.toContain('Shape:');
  expect(content).not.toContain(environment.MAR_CTL_USER_TOKEN);
  expect(content).toContain('\n\n');
  expect(marctlExecutionEnvironment(environment)).not.toHaveProperty('OTHER_SECRET');
  expect(marctlExecutionEnvironment()).toEqual({});
});

it('provides desktop guidance from the Node host with its real tool dependency', async () => {
  expect(computerUseHostSkill.requiredTools).toEqual(['mcp__mar_computer__exec']);
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
    'Do not issue sleep-only calls',
    'resumed transparently for a later Run',
    'Always obtain a fresh observation after a Run boundary'
  ])
    expect(content).toContain(instruction);
});

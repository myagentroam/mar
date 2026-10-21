import { describe, expect, it } from 'vitest';
import { projectCompletionContext } from '../../src/service/prompt-completion-context.js';
import { withPredictionTaskState } from '../../src/service/prompt-completion-task-context.js';

describe('Prediction task state', () => {
  const base = projectCompletionContext([], 'history');
  const task = { goal: null, queue: { version: 1, paused: false, items: [] } } as const;
  it.each([
    ['RUNNING', 'RUNNING'],
    ['SUCCEEDED', 'COMPLETED'],
    ['FAILED', 'FAILED'],
    ['INTERRUPTED', 'UNKNOWN']
  ])('projects %s without inferring Goal completion', (runStatus, phase) => {
    expect(
      JSON.parse(withPredictionTaskState(base, { ...task, runStatus }).executionSnapshot).phase
    ).toBe(phase);
  });
  it('keeps queue content distinct from executed work and changes semantic identity', () => {
    const first = withPredictionTaskState(base, task);
    const next = withPredictionTaskState(base, {
      ...task,
      runStatus: 'SUCCEEDED',
      goal: { id: 'g', objective: 'Verify the API', status: 'active', revision: 1 },
      queue: { version: 2, paused: true, items: [{ queueItemId: 'q', content: 'Run tests' }] }
    });
    expect(next.identity.contextVersion).not.toBe(first.identity.contextVersion);
    expect(JSON.parse(next.executionSnapshot)).toMatchObject({
      phase: 'COMPLETED',
      goal: { status: 'active' },
      queue: { paused: true, items: [{ status: 'QUEUED_NOT_EXECUTED' }] }
    });
  });
  it('uses authoritative run status instead of a conflicting imported history status', () => {
    const imported = {
      ...base,
      executionSnapshot: JSON.stringify({ status: 'INTERRUPTED', waiting: [] })
    };
    expect(
      JSON.parse(
        withPredictionTaskState(imported, { ...task, runStatus: 'RUNNING' }).executionSnapshot
      )
    ).toMatchObject({ status: 'RUNNING', phase: 'RUNNING' });
  });
  it('preserves UNKNOWN instead of claiming that unsupported state is empty', () => {
    expect(
      JSON.parse(
        withPredictionTaskState(base, { goal: 'UNKNOWN', queue: 'UNKNOWN' }).executionSnapshot
      )
    ).toMatchObject({ goal: 'UNKNOWN', queue: 'UNKNOWN' });
  });
});

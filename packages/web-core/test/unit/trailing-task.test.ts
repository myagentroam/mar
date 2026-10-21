import { describe, expect, it } from 'vitest';
import { createTrailingTask } from '../../src/util/trailing-task.js';

describe('Workspace Inspector Trailing Refresh', () => {
  it('Repeated triggers while running leave only one trailing execution', async () => {
    const releases: Array<() => void> = [];
    let executions = 0;
    const task = createTrailingTask(async () => {
      executions += 1;
      await new Promise<void>((resolve) => releases.push(resolve));
    });

    const completion = task.request();
    await Promise.resolve();
    expect(task.running()).toBe(true);
    expect(executions).toBe(1);

    void task.request();
    void task.request();
    releases.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(executions).toBe(2);

    releases.shift()?.();
    await completion;
    expect(task.running()).toBe(false);
    expect(executions).toBe(2);
  });

  it('releases a failed refresh so a later explicit retry can run', async () => {
    let attempts = 0;
    const failure = new Error('refresh failed');
    const task = createTrailingTask(async () => {
      attempts += 1;
      if (attempts === 1) throw failure;
    });

    await expect(task.request()).rejects.toBe(failure);
    expect(task.running()).toBe(false);
    await task.request();
    expect(attempts).toBe(2);
    expect(task.running()).toBe(false);
  });
});

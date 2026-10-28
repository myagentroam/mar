import { expect, it, vi } from 'vitest';
import type { AbstractRunner } from '../../src/runner/abstract-runner.js';
import { RunnerRegistry } from '../../src/runner/runner-registry.js';

it('waits for every runner and reports the first stop failure', async () => {
  const failure = new Error('runner stop failed');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const secondStop = vi.fn(async () => {
    await gate;
  });
  const registry = new RunnerRegistry([
    {
      name: 'codex',
      stop: async () => {
        throw failure;
      }
    } as unknown as AbstractRunner,
    { name: 'claude-code', stop: secondStop } as unknown as AbstractRunner
  ]);
  let settled = false;
  const stop = registry.stop().finally(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(secondStop).toHaveBeenCalledOnce();
  expect(settled).toBe(false);
  release();
  await expect(stop).rejects.toBe(failure);
});

it('continues stopping other runners after a synchronous stop failure', async () => {
  const failure = new Error('synchronous stop failed');
  const secondStop = vi.fn();
  const registry = new RunnerRegistry([
    {
      name: 'codex',
      stop: () => {
        throw failure;
      }
    } as unknown as AbstractRunner,
    { name: 'claude-code', stop: secondStop } as unknown as AbstractRunner
  ]);
  await expect(registry.stop()).rejects.toBe(failure);
  expect(secondStop).toHaveBeenCalledOnce();
});

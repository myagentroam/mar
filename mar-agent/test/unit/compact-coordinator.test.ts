import { describe, expect, it } from 'vitest';
import { CompactCoordinator } from '../../src/runtime/compaction/coordinator.js';

describe('Compact coordinator', () => {
  it('generates in the background and installs only at a checkpoint without reentry', async () => {
    const coordinator = new CompactCoordinator();
    let generated!: () => void;
    const generation = new Promise<void>((resolve) => {
      generated = resolve;
    });
    let installed = false;
    const first = coordinator.start('one', undefined, async (prepare) => {
      await generation;
      await prepare();
      installed = true;
      return true;
    });
    expect(coordinator.start('two', undefined, async () => false)).toBe(first);
    expect(await coordinator.checkpoint(false)).toBeUndefined();
    const waiting = coordinator.checkpoint(true);
    expect(installed).toBe(false);
    generated();
    expect(await waiting).toBe(true);
    expect(installed).toBe(true);
    expect(coordinator.pending).toBe(false);
  });

  it('rejects recursive requests and conflicting focus', async () => {
    const coordinator = new CompactCoordinator();
    coordinator.start('one', 'first', async (prepare) => {
      expect(() => coordinator.start('recursive', undefined, async () => true)).toThrow(
        'Recursive'
      );
      await prepare();
      return true;
    });
    expect(() => coordinator.start('other', 'second', async () => true)).toThrow('different');
    expect(await coordinator.checkpoint(true)).toBe(true);
  });

  it('observes failures without leaving the lane locked', async () => {
    const coordinator = new CompactCoordinator();
    coordinator.start('one', undefined, async () => {
      throw new Error('generation failed');
    });
    await expect(coordinator.checkpoint(true)).rejects.toThrow('generation failed');
    expect(coordinator.pending).toBe(false);
    coordinator.start('two', undefined, async () => false);
    expect(await coordinator.checkpoint(true)).toBe(false);
  });

  it('cancels a ready task without installing it', async () => {
    const coordinator = new CompactCoordinator();
    let installed = false;
    const flight = coordinator.start('one', undefined, async (prepare) => {
      await prepare();
      installed = true;
      return true;
    });
    await coordinator.close(new Error('stopped'));
    await expect(flight.result).rejects.toThrow('stopped');
    expect(installed).toBe(false);
    expect(coordinator.pending).toBe(false);
  });
});

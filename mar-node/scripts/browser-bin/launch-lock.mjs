import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';

export async function lockLaunch(root) {
  const active = join(root, 'active');
  // Playwright checks and publishes its session entry separately; concurrent
  // starts must not create two daemons under the same name.
  const path = join(root, 'launch');
  const deadline = Date.now() + 30_000;
  while (existsSync(active)) {
    try {
      mkdirSync(path, { mode: 0o700 });
      return path;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error('Another Playwright launch did not finish.');
      await setTimeout(50);
    }
  }
  throw new Error('The MAR Browser Use execution has ended.');
}

import { mkdir, rmdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Exclude setup and run for one deployment without taking over unknown owners. */
export async function acquireQuickStartLock(root: string): Promise<() => Promise<void>> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, '.deployment-lock');
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('QUICK_START_IN_USE');
    throw error;
  }
  let release: Promise<void> | undefined;
  return () => (release ??= rmdir(path));
}

import { open } from 'node:fs/promises';

export async function syncJsonlDirectory(path: string) {
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r');
  await syncAndClose(handle);
}

export async function syncAndClose(handle: Awaited<ReturnType<typeof open>>): Promise<void> {
  try {
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
  await handle.close();
}

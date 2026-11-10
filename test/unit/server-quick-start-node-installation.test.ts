import { access } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { serverNodeEntrypoint } from '../../mar-server/src/quick-start/node-dependency.js';

describe('Quick Start Node dependency', () => {
  it('resolves the installed Node entrypoint without a separate installation', async () => {
    const entrypoint = await serverNodeEntrypoint();
    expect(entrypoint).toMatch(/dist[/\\]main\.js$/u);
    await expect(access(entrypoint)).resolves.toBeUndefined();
  });
});

import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { NodeDatabase } from '../../src/database.js';

describe('Workspace Git policy persistence', () => {
  it('preserves legacy workspaces, enables new ones and never resets a saved choice on refresh', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mar-git-policy-'));
    const path = join(root, 'node.sqlite');
    try {
      const initial = new NodeDatabase(path, 'node');
      const existing = initial.saveWorkspace({
        path: join(root, 'existing'),
        kind: 'DIRECTORY',
        gitSummary: null
      });
      initial.setWorkspaceGitPolicy(existing.id, true);
      initial.close();
      const database = new NodeDatabase(path, 'node');
      try {
        expect(database.getWorkspace(existing.id)?.preserveGitConfig).toBe(true);
        const created = database.saveWorkspace({
          path: join(root, 'new'),
          kind: 'DIRECTORY',
          gitSummary: null
        });
        expect(created.preserveGitConfig).toBe(false);
        expect(database.setWorkspaceGitPolicy(created.id, true).preserveGitConfig).toBe(true);
        database.saveWorkspace({
          path: created.path,
          kind: 'GIT_WORKSPACE',
          gitSummary: { branch: 'main' }
        });
        expect(database.getWorkspace(created.id)?.preserveGitConfig).toBe(true);
      } finally {
        database.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

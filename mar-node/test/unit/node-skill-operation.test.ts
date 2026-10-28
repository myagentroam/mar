import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NodeDatabase } from '../../src/database.js';
import { SkillNodeOperationService } from '../../src/service/skill-node-operation-service.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Node Skill async operation', () => {
  it('returns a job before download completes and exposes the final directory result through job status', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'mar-skill-operation-'));
    roots.push(workspace);
    let releaseDownload!: () => void;
    const downloadReady = new Promise<void>((resolve) => (releaseDownload = resolve));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await downloadReady;
        return new Response(
          JSON.stringify({
            schemaVersion: 1,
            files: [
              {
                path: 'SKILL.md',
                contentBase64: Buffer.from(
                  '---\nname: review\ndescription: Review code\n---\n'
                ).toString('base64')
              }
            ]
          }),
          { status: 200 }
        );
      })
    );
    const service = new SkillNodeOperationService(
      () =>
        ({
          getWorkspace: () => ({ path: workspace }),
          getWorkspaceByPath: () => ({ path: workspace, includeParentRepository: true })
        }) as unknown as NodeDatabase,
      () => ({
        serverUrl: 'https://server.test',
        allowedRoots: [],
        nodeId: 'node-1',
        credential: 'secret'
      })
    );
    const skillContentBase64 = Buffer.from(
      '---\nname: review\ndescription: Review code\n---\n'
    ).toString('base64');
    const contentHash = createHash('sha256')
      .update(`SKILL.md\0${skillContentBase64}`)
      .digest('hex');
    const operations = service.operations();
    const accepted = (await operations['workspace.skills.install']!({
      workspaceId: 'workspace-1',
      name: 'review',
      artifactTicket: 'ticket-1',
      metadata: {
        schemaVersion: 1,
        favoriteId: 'favorite-1',
        versionId: 'version-1',
        commitSha: 'a'.repeat(40),
        contentHash,
        installedAt: 1
      }
    })) as { installJobId: string };
    expect(accepted.installJobId).toEqual(expect.any(String));
    expect(
      await operations['skill.install.job.get']!({ installJobId: accepted.installJobId })
    ).toMatchObject({ status: 'RUNNING' });

    releaseDownload();
    await expect
      .poll(async () =>
        operations['skill.install.job.get']!({ installJobId: accepted.installJobId })
      )
      .toMatchObject({ status: 'SUCCEEDED' });
    await expect(
      readFile(path.join(workspace, '.agents', 'skills', 'review', 'SKILL.md'), 'utf8')
    ).resolves.toContain('name: review');

    const rejected = (await operations['workspace.skills.install']!({
      workspaceId: 'workspace-1',
      name: 'review-copy',
      artifactTicket: 'ticket-2',
      metadata: {
        schemaVersion: 1,
        favoriteId: 'favorite-1',
        versionId: 'version-1',
        commitSha: 'a'.repeat(40),
        contentHash: 'c'.repeat(64),
        installedAt: 1
      }
    })) as { installJobId: string };
    await expect
      .poll(async () =>
        operations['skill.install.job.get']!({ installJobId: rejected.installJobId })
      )
      .toMatchObject({ status: 'FAILED', errorCode: 'SKILL_CONTENT_INVALID' });

    const retried = (await operations['workspace.skills.install']!({
      workspaceId: 'workspace-1',
      name: 'review-copy',
      artifactTicket: 'ticket-3',
      metadata: {
        schemaVersion: 1,
        favoriteId: 'favorite-1',
        versionId: 'version-1',
        commitSha: 'a'.repeat(40),
        contentHash,
        installedAt: 2
      }
    })) as { installJobId: string };
    await expect
      .poll(async () =>
        operations['skill.install.job.get']!({ installJobId: retried.installJobId })
      )
      .toMatchObject({ status: 'SUCCEEDED' });
  });
});

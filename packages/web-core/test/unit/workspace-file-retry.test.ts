import {
  createFileAccessFixture,
  type WorkspaceFilePreviewTransfers
} from '../support/file-access-fixture.js';
import { expect, it, vi } from 'vitest';
import type { WorkspaceFileOpenIntent } from '../../src/util/workspace-file-tab.js';
import { createWorkspaceFileWorkbenchController } from '../../src/service/workspace-file-workbench-controller.js';
import type { ScopedHttpService } from '../../src/service/scoped-http-service.js';
import { createWorkspaceFilePreviewService } from '../../src/service/workspace-file-preview-service.js';

it.each(['text', 'pdf'] as const)(
  'retries the same historical %s snapshot scope without an HTTP body fallback',
  async (kind) => {
    const failure = new Error('Read failed');
    const readPreviewRange = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue({
        offset: 0,
        bytes: new TextEncoder().encode('recovered'),
        size: 9,
        nextOffset: null,
        revision: 'r'
      });
    const readPreviewObject = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue({
      url: 'blob:historical',
      size: 9,
      revision: 'r'
    });
    const fetchContent = vi.fn();
    const previews = createWorkspaceFilePreviewService({
      access: createFileAccessFixture({
        http: { request: vi.fn() } as ScopedHttpService,
        transfers: () => ({ readPreviewRange, readPreviewObject }),
        fetchContent
      }),
      onWritten: vi.fn()
    });
    const target = {
      nodeId: 'node',
      workspaceId: 'workspace',
      path: kind === 'text' ? 'module.ts' : 'report.pdf',
      history: { commit: 'a'.repeat(40), repositoryPath: 'nested-repo', refs: ['refs/heads/main'] }
    };
    try {
      await previews.open(1, target);
      expect(previews.page(1).error.value).toBe(failure);
      expect(previews.page(1).contentUrl.value).toBeUndefined();
      await previews.open(1, target);
      expect(previews.page(1).error.value).toBeUndefined();
      expect(previews.page(1).fileContent.value).toMatchObject({
        content: kind === 'text' ? 'recovered' : '',
        size: 9,
        encoding: kind === 'text' ? 'utf-8' : 'base64'
      });
      expect(previews.page(1).target.value).toEqual(target);
      const read = kind === 'text' ? readPreviewRange : readPreviewObject;
      expect(read.mock.calls.map(([source]) => source)).toEqual([target, target]);
      expect(kind === 'text' ? readPreviewObject : readPreviewRange).not.toHaveBeenCalled();
      expect(previews.page(1).contentUrl.value).toBe(
        kind === 'pdf' ? 'blob:historical' : undefined
      );
      expect(fetchContent).not.toHaveBeenCalled();
    } finally {
      previews.reset();
    }
  }
);

it.each(['repository', 'worktree', 'history'] as const)(
  'retries the original %s file without changing its tab or target',
  async (scope) => {
    const failure = new Error('Read failed');
    const request = vi.fn();
    const http = { request } as ScopedHttpService;
    const fetchContent = vi.fn();
    const readPreviewRange = vi
      .fn<NonNullable<WorkspaceFilePreviewTransfers['readPreviewRange']>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue({
        bytes: new TextEncoder().encode('recovered'),
        offset: 0,
        size: 9,
        nextOffset: null,
        revision: 'r1'
      });
    const target = { nodeId: 'node', workspaceId: 'workspace' };
    const owner = createWorkspaceFileWorkbenchController({
      target: () => target,
      externalTarget: () => target,
      fileWriteEnabled: () => false,
      onPopupBlocked: vi.fn(),
      page: () => undefined,
      prewarmEnabled: () => false,
      resolveRepositoryPath: () => undefined,
      reveal: async () => {},
      comparison: async () => undefined,
      onOpenFailure: vi.fn(),
      onRevealFailure: vi.fn(),
      access: createFileAccessFixture({
        http,
        fetchContent,
        transfers: () => ({ readPreviewRange })
      }),
      preview: { onWritten: vi.fn() },
      navigation: { http, onFailure: vi.fn(), onFileTarget: vi.fn() }
    });
    const base = {
      ...target,
      path: 'module.ts',
      targetLine: 12,
      targetColumn: 3,
      repositoryPath: 'nested-repo',
      worktreePath: scope === 'worktree' ? '/other-worktree' : ''
    };
    const intent: WorkspaceFileOpenIntent =
      scope === 'history'
        ? { ...base, kind: 'HISTORY_TEXT', commit: 'a'.repeat(40), refs: ['refs/heads/main'] }
        : { ...base, kind: 'WORKTREE_TEXT' };
    try {
      if (scope === 'history') await owner.openTab(intent);
      else
        await owner.openWorkspaceFile(
          intent.path,
          12,
          scope === 'worktree' ? '/other-worktree' : undefined,
          true,
          3,
          'nested-repo'
        );
      const frame = owner.frames.value[0]!;
      const originalTarget = frame.target.value;
      const originalTab = owner.activeTab.value;
      expect(frame.error.value).toBe(failure);
      await owner.reloadFile(frame.id);
      expect(frame.error.value).toBeUndefined();
      expect(frame.fileContent.value?.content).toBe('recovered');
      expect(frame.target.value).toEqual(originalTarget);
      expect(owner.activeTab.value).toBe(originalTab);
      expect(owner.tabList.value).toHaveLength(1);
      expect(frame.targetLine.value).toBe(12);
      expect(frame.targetColumn.value).toBe(3);
      expect(readPreviewRange.mock.calls.map(([source]) => source)).toEqual([
        originalTarget,
        originalTarget
      ]);
      expect(originalTarget).toMatchObject(
        scope === 'history'
          ? {
              history: {
                repositoryPath: 'nested-repo',
                commit: 'a'.repeat(40),
                refs: ['refs/heads/main']
              }
            }
          : {
              repositoryPath: 'nested-repo',
              ...(scope === 'worktree' && { worktreePath: '/other-worktree' })
            }
      );
      expect(request).not.toHaveBeenCalled();
      expect(fetchContent).not.toHaveBeenCalled();
    } finally {
      owner.dispose();
    }
  }
);

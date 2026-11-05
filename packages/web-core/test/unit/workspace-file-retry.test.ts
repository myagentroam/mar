import { expect, it, vi } from 'vitest';
import type { WorkspaceFileOpenIntent } from '../../src/util/workspace-file-tab.js';
import { createWorkspaceFileWorkbenchController } from '../../src/service/workspace-file-workbench-controller.js';
import type { ScopedHttpService } from '../../src/service/scoped-http-service.js';
import { createWorkspaceFilePreviewService } from '../../src/service/workspace-file-preview-service.js';

it.each(['text', 'image'] as const)(
  'recovers a historical %s file through the server when its direct transport fails',
  async (kind) => {
    const failure = new Error('Direct read failed');
    const directGitFileReadRange = vi.fn().mockRejectedValue(failure);
    const directGitFileObjectUrl = vi.fn().mockRejectedValue(failure);
    const fetchContent = vi.fn().mockImplementation(
      async () =>
        new Response(kind === 'text' ? 'recovered' : 'r', {
          headers: { 'content-range': kind === 'text' ? 'bytes 0-8/9' : 'bytes 0-0/9' }
        })
    );
    const previews = createWorkspaceFilePreviewService({
      http: { request: vi.fn() } as ScopedHttpService,
      transfers: () => ({ directGitFileReadRange, directGitFileObjectUrl }),
      onWritten: vi.fn(),
      fetchContent
    });
    const target = {
      nodeId: 'node',
      workspaceId: 'workspace',
      path: kind === 'text' ? 'module.ts' : 'image.png',
      history: { commit: 'a'.repeat(40), repositoryPath: 'nested-repo', refs: ['refs/heads/main'] }
    };
    try {
      await previews.open(1, target);
      expect(previews.page(1).error.value).toBe(failure);
      expect(fetchContent).not.toHaveBeenCalled();

      await previews.open(1, target, { serverOnly: true });
      expect(previews.page(1).error.value).toBeUndefined();
      expect(previews.page(1).fileContent.value).toMatchObject({
        content: kind === 'text' ? 'recovered' : '',
        size: 9,
        encoding: kind === 'text' ? 'utf-8' : 'base64'
      });
      expect(previews.page(1).target.value).toEqual(target);
      if (kind === 'image') {
        const url = new URL(previews.page(1).contentUrl.value!, 'http://localhost');
        expect(url.pathname).toBe(
          `/api/workspaces/workspace/git/commits/${target.history.commit}/files/content`
        );
        expect(Object.fromEntries(url.searchParams)).toMatchObject({
          nodeId: target.nodeId,
          path: target.path,
          repositoryPath: target.history.repositoryPath,
          refs: target.history.refs[0]
        });
        expect(directGitFileObjectUrl).toHaveBeenCalledOnce();
      } else expect(directGitFileObjectUrl).not.toHaveBeenCalled();
      expect(directGitFileReadRange).toHaveBeenCalledOnce();
      expect(fetchContent).toHaveBeenCalledOnce();
    } finally {
      previews.reset();
    }
  }
);

it.each(['repository', 'worktree', 'history'] as const)(
  'retries the original %s file without changing its tab or target',
  async (scope) => {
    const failure = new Error('Read failed');
    const request = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue({
        file: {
          encoding: 'utf-8',
          content: 'recovered',
          size: 9,
          nextOffset: null,
          revision: 'r1'
        }
      });
    const http = { request } as ScopedHttpService;
    const fetchContent = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockImplementation(async () => new Response('recovered'));
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
      preview: { http, fetchContent, transfers: () => ({}), onWritten: vi.fn() },
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
      const url = (
        scope === 'history' ? fetchContent.mock.calls.at(-1)?.[0] : request.mock.calls.at(-1)?.[0]
      ) as string;
      const parsed = new URL(url, 'http://fixture');
      expect(parsed.searchParams.get('repositoryPath')).toBe('nested-repo');
      if (scope === 'worktree')
        expect(parsed.searchParams.get('worktreePath')).toBe('/other-worktree');
      if (scope === 'history') {
        expect(parsed.pathname).toContain('a'.repeat(40));
        expect(parsed.searchParams.getAll('refs')).toEqual(['refs/heads/main']);
      }
    } finally {
      owner.dispose();
    }
  }
);

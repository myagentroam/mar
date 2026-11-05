import { createFileAccessFixture } from '../support/file-access-fixture.js';
import { afterEach, expect, it, vi } from 'vitest';
import { createWorkspaceFilesController } from '../../src/service/workspace-files-controller.js';
import { createWorkspaceFileWorkbenchController } from '../../src/service/workspace-file-workbench-controller.js';
import { ElMessageBox } from '../../src/service/message-box-service.js';
import { localePreferenceService, translate } from '../../src/service/locale-preference-service.js';
import type { ScopedHttpService } from '../../src/service/scoped-http-service.js';
import WorkspaceFilesPanel from '../../src/view/workspace/WorkspaceFilesPanel.vue?unit-render';
import {
  flushComponent,
  renderComponent,
  textContent,
  trigger
} from './support/component-renderer.js';

vi.mock('../../src/view/workspace/WorkspaceFileTree.vue?unit-render', async () => {
  const { defineComponent, h } = await import('vue');
  return {
    default: defineComponent({
      emits: ['action'],
      setup(_props, { emit }) {
        return () =>
          h(
            'button',
            {
              onClick: () =>
                emit('action', 'DELETE', { path: 'old.ts', name: 'old.ts', kind: 'FILE' })
            },
            'delete fixture'
          );
      }
    })
  };
});

afterEach(() => vi.restoreAllMocks());

it.each(['zh-CN', 'en-US'] as const)(
  'projects the host Files Watch state in %s without fetching',
  async (locale) => {
    const preference = localePreferenceService();
    const previousLocale = preference.locale.value;
    preference.setLocale(locale);
    const list = vi.fn();
    const files = createWorkspaceFilesController({
      target: () => ({ nodeId: 'node', workspaceId: 'workspace' }),
      workspaceName: () => 'Workspace',
      list,
      mutate: vi.fn(),
      revealLocal: vi.fn(),
      preflight: vi.fn(),
      queue: vi.fn(),
      onFailure: vi.fn(),
      onWorkspace: vi.fn(),
      onMutationFailure: vi.fn(),
      onDeletedSelection: vi.fn(),
      onRevealSelection: vi.fn()
    });
    const retry = vi.fn();
    try {
      const loading = renderComponent(WorkspaceFilesPanel, {
        service: files,
        visible: true,
        mobileViewport: false,
        watchStatus: 'loading',
        onRetryWatch: retry
      });
      expect(textContent(loading.root)).toContain(
        translate('generated.workspaceInspector.loading')
      );
      expect(textContent(loading.root)).not.toContain(translate('common.loadFailedRetry'));
      loading.unmount();
      const failed = renderComponent(WorkspaceFilesPanel, {
        service: files,
        visible: true,
        mobileViewport: false,
        watchStatus: 'failed',
        onRetryWatch: retry
      });
      try {
        const button = failed
          .findAll('ElButton')
          .find((node) => textContent(node).includes(translate('common.loadFailedRetry')));
        expect(button).toBeDefined();
        await trigger(button!, 'onClick');
        expect(retry).toHaveBeenCalledOnce();
        expect(list).not.toHaveBeenCalled();
      } finally {
        failed.unmount();
      }
    } finally {
      preference.setLocale(previousLocale);
    }
  }
);

it.each([
  'mounted dirty',
  'suspended dirty',
  'failure',
  'old target',
  'old target failure'
] as const)(
  'finishes a confirmed deletion through the Files owner after panel unmount (%s)',
  async (scenario) => {
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue(
      'confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>
    );
    let resolve!: (value: undefined) => void;
    let reject!: (error: Error) => void;
    const mutation = vi.fn(
      () =>
        new Promise<undefined>((accept, fail) => {
          resolve = accept;
          reject = fail;
        })
    );
    const http = {
      request: vi.fn(async () => ({
        file: {
          path: 'old.ts',
          encoding: 'utf-8',
          content: 'original',
          size: 8,
          nextOffset: null,
          revision: 'a'.repeat(64)
        }
      }))
    } as unknown as ScopedHttpService;
    let target = { nodeId: 'node', workspaceId: 'workspace' };
    const requestCloseAll = vi.fn(async () => true);
    let tabIdentity = '';
    let port = {
      requestCloseAll,
      captureDirtyDrafts: () => [
        { tabIdentity, path: 'old.ts', content: 'dirty', expectedRevision: 'a'.repeat(64) }
      ],
      hasPendingSave: () => false,
      cursorPosition: () => undefined,
      navigateTo: vi.fn(),
      focusPage: vi.fn(() => true)
    };
    const owner = createWorkspaceFileWorkbenchController({
      externalTarget: () => ({ nodeId: 'node', workspaceId: 'workspace' }),
      fileWriteEnabled: () => false,
      onPopupBlocked: () => {},
      target: () => target,
      page: () => port,
      prewarmEnabled: () => false,
      resolveRepositoryPath: () => undefined,
      reveal: async () => {},
      onOpenFailure: vi.fn(),
      onRevealFailure: vi.fn(),
      comparison: async () => undefined,
      access: createFileAccessFixture({ http, transfers: () => ({}) }),
      preview: { onWritten: vi.fn() },
      navigation: { http, onFileTarget: vi.fn(), onFailure: vi.fn() }
    });
    await owner.openFile('old.ts');
    tabIdentity = owner.activeTab.value!.identity;
    expect(owner.snapshot().dirtyTextDrafts).toHaveLength(1);
    if (scenario === 'suspended dirty') {
      expect(owner.suspendForHtml()).toBe(true);
      port = undefined as never;
    }
    const failure = vi.fn();
    const deleted = vi.fn(() => owner.invalidateDeletedSelection());
    const files = createWorkspaceFilesController({
      target: () => target,
      workspaceName: () => 'Workspace',
      list: async () => ({ entries: [], nextCursor: null }),
      mutate: mutation,
      revealLocal: async () => {},
      preflight: async () => [],
      queue: vi.fn(),
      onFailure: vi.fn(),
      onWorkspace: vi.fn(),
      onDeletedSelection: deleted,
      onRevealSelection: async () => {},
      onMutationFailure: failure
    });
    files.tree.applyRootPage({
      entries: [{ path: 'old.ts', name: 'old.ts', kind: 'FILE', size: 8 }],
      nextCursor: null
    });
    files.tree.selectPath('old.ts');
    const view = renderComponent(WorkspaceFilesPanel, {
      service: files,
      visible: true,
      mobileViewport: false
    });
    try {
      const button = view.findAll('button').find((node) => node.text === 'delete fixture');
      expect(button).toBeDefined();
      await trigger(button!, 'onClick');
      await vi.waitFor(() => expect(mutation).toHaveBeenCalledOnce());
      view.unmount();
      if (scenario === 'old target' || scenario === 'old target failure') {
        target = { nodeId: 'node', workspaceId: 'other' };
        files.resetTree();
      }
      if (scenario === 'failure' || scenario === 'old target failure')
        reject(new Error('delete failed'));
      else resolve(undefined);
      await flushComponent();
      if (scenario === 'mounted dirty' || scenario === 'suspended dirty') {
        expect(deleted).toHaveBeenCalledOnce();
        expect(owner.snapshot().fileTabs.tabs).toEqual([]);
        expect(owner.snapshot().dirtyTextDrafts).toEqual([]);
        expect(requestCloseAll).not.toHaveBeenCalled();
        expect(failure).not.toHaveBeenCalled();
      } else if (scenario === 'failure' || scenario === 'old target failure') {
        expect(failure).toHaveBeenCalledOnce();
        expect(failure).toHaveBeenCalledWith(
          expect.any(Error),
          'operation',
          { nodeId: 'node', workspaceId: 'workspace' },
          'old.ts'
        );
        expect(deleted).not.toHaveBeenCalled();
      } else {
        expect(deleted).not.toHaveBeenCalled();
        expect(failure).not.toHaveBeenCalled();
      }
    } finally {
      owner.dispose();
    }
  }
);

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ElMessageBox } from 'element-plus';
import Page from '../../src/view/settings/ConversationTemplateManagementPage.vue?unit-render';
import { i18n } from '../../src/service/LocalePreferenceService.js';
import { showMessage } from '../../src/service/MessageFeedbackService.js';
import {
  flushComponent,
  renderComponent,
  textContent,
  trigger
} from './support/component-renderer.js';

vi.mock('../../src/service/MessageFeedbackService.js', () => ({ showMessage: vi.fn() }));
const originalLocale = i18n.global.locale.value;
const template = {
  id: 'template-1',
  nodeId: 'node-1',
  name: 'Review template',
  description: '',
  status: 'ACTIVE',
  currentVersionId: 'version-1',
  available: true,
  createdAt: 1,
  updatedAt: 2,
  draftRevision: 3,
  publishedVersion: 1
};
const draft = {
  templateId: template.id,
  nodeId: template.nodeId,
  workspaceId: 'workspace-1',
  revision: 3,
  name: template.name,
  description: '',
  allowedModels: [{ modelId: 'coding', name: 'Coding' }],
  defaultModelId: 'coding',
  mcpIds: [],
  networkMode: 'NONE',
  quotas: { maxStorageBytes: 1024, maxUploadBytes: 512 },
  updatedAt: 2
};
const version = {
  id: 'version-1',
  templateId: template.id,
  version: 1,
  status: 'AVAILABLE',
  contentHash: 'a'.repeat(64),
  manifestHash: 'b'.repeat(64),
  mcpConfigHash: 'c'.repeat(64),
  fileCount: 42,
  totalBytes: 4096,
  hostPolicyVersion: 1,
  publishedByUserId: 1,
  publishedAt: 2
};
function detail(id = template.id) {
  return {
    template: { ...template, id, name: id },
    draft: { ...draft, templateId: id },
    versions: [{ ...version, templateId: id }]
  };
}
function fixture() {
  return vi.fn(async (path: string, _init?: RequestInit): Promise<unknown> => {
    if (path.startsWith('/api/admin/conversation-templates?')) {
      const page = Number(new URL(path, 'http://fixture').searchParams.get('page'));
      return {
        templates: [{ ...template, id: `template-${page}` }],
        page,
        pageSize: 20,
        total: 21,
        hasMore: page === 1
      };
    }
    if (path.includes('/model-options?')) return { models: draft.allowedModels };
    if (path.startsWith('/api/workspaces?')) return { workspaces: [] };
    if (path.endsWith('/template-1') || path.endsWith('/template-2'))
      return detail(path.split('/').at(-1));
    throw new Error(`Unexpected request: ${path}`);
  });
}
function button(view: ReturnType<typeof renderComponent>, label: string) {
  return view.findAll('ElButton').find((node) => textContent(node).trim() === label)!;
}
beforeEach(() => {
  i18n.global.locale.value = 'en-US';
  vi.mocked(showMessage).mockClear();
  vi.stubGlobal('window', {
    location: { search: '', href: 'http://fixture/console' },
    history: { replaceState() {} },
    setTimeout: (callback: () => void, delay: number) => globalThis.setTimeout(callback, delay),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  i18n.global.locale.value = originalLocale;
});

describe('Template management component behavior', () => {
  it('renders authoritative pages without slicing twice, opens version history and closes details', async () => {
    const request = fixture();
    const view = renderComponent(Page, { request, writable: true, nodes: [] });
    try {
      await flushComponent();
      const paging = view.findAll('ElPagination')[0]!;
      expect(paging.props.total).toBe(21);
      await trigger(paging, 'onCurrentChange', 2);
      const table = view.findAll('ElTable')[0]!;
      const rows = table.props.data as Array<{ id: string }>;
      expect(rows.map((row) => row.id)).toEqual(['template-2']);
      await trigger(table, 'onRowClick', rows[0]);
      expect(view.findAll('ElDialog')[0]!.props.title).toBe('template-2');
      expect(view.findAll('ElTable').at(-1)!.props.data).toEqual([
        { ...version, templateId: 'template-2' }
      ]);
      await trigger(button(view, i18n.global.t('common.close')), 'onClick');
      expect(view.findAll('ElDialog')).toHaveLength(0);
    } finally {
      view.unmount();
    }
  });

  it('ignores a late detail response after another row has been opened', async () => {
    let release!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const base = fixture();
    const request = vi.fn((path: string, init?: RequestInit) =>
      path.endsWith('/template-1') ? pending : base(path, init)
    );
    const view = renderComponent(Page, { request, writable: false, nodes: [] });
    try {
      await flushComponent();
      const table = view.findAll('ElTable')[0]!;
      const first = trigger(table, 'onRowClick', template);
      await trigger(table, 'onRowClick', { ...template, id: 'template-2' });
      release(detail());
      await first;
      expect(view.findAll('ElDialog')[0]!.props.title).toBe('template-2');
      expect(showMessage).not.toHaveBeenCalled();
    } finally {
      view.unmount();
    }
  });

  it.each(['SUCCEEDED', 'FAILED'])(
    'confirms publication, polls the job and reports %s',
    async (status) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue(
        'confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>
      );
      const job = {
        id: 'job-1',
        templateId: template.id,
        draftRevision: 3,
        stage: 'VALIDATING',
        status: 'RUNNING',
        errorCode: null,
        createdAt: 1,
        updatedAt: 2
      };
      const base = fixture();
      const request = vi.fn(async (path: string, init?: RequestInit) => {
        if (path.endsWith('/publish')) return { job };
        if (path.endsWith('/publish-jobs/job-1'))
          return {
            job: {
              ...job,
              status,
              ...(status === 'SUCCEEDED'
                ? { stage: 'REGISTERED', versionId: version.id }
                : { errorCode: 'CONVERSATION_TEMPLATE_MODEL_INVALID' })
            }
          };
        return base(path, init);
      });
      const view = renderComponent(Page, { request, writable: true, nodes: [] });
      try {
        await flushComponent();
        const publishing = trigger(
          button(view, i18n.global.t('conversationTemplates.publish')),
          'onClick'
        );
        await flushComponent();
        expect(ElMessageBox.confirm).toHaveBeenCalledOnce();
        const write = request.mock.calls.find(([, init]) => init?.method === 'POST')!;
        expect(write[0]).toBe('/api/admin/conversation-templates/template-1/publish');
        expect(JSON.parse(String(write[1]!.body))).toMatchObject({
          templateId: template.id,
          draftRevision: 3,
          requestId: expect.any(String)
        });
        expect(button(view, i18n.global.t('conversationTemplates.publish')).props.loading).toBe(
          true
        );
        await vi.advanceTimersByTimeAsync(1000);
        await publishing;
        expect(request).toHaveBeenCalledWith(
          '/api/admin/conversation-templates/template-1/publish-jobs/job-1'
        );
        expect(showMessage).toHaveBeenCalledWith(
          i18n.global.t(
            status === 'SUCCEEDED'
              ? 'conversationTemplates.publishSucceeded'
              : 'conversationTemplates.errorModelInvalid'
          ),
          status === 'SUCCEEDED' ? 'success' : 'error'
        );
      } finally {
        view.unmount();
      }
    }
  );
});

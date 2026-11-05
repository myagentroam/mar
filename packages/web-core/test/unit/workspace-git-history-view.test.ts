import { ref, nextTick } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localePreferenceService } from '../../src/service/locale-preference-service.js';
import WorkspaceGitHistory from '../../src/view/workspace/WorkspaceGitHistory.vue?unit-render';
import { renderComponent } from './support/component-renderer.js';

afterEach(() => vi.unstubAllGlobals());

describe.each(['zh-CN', 'en-US'] as const)('Git history in %s', (locale) => {
  it.each([false, true])(
    'reports commit copy feedback from its context menu (failure=%s)',
    async (fails) => {
      localePreferenceService().setLocale(locale);
      const hash = 'a'.repeat(40);
      const service = {
        historyRefs: ref([]),
        historyCommits: ref([
          {
            hash,
            parents: [],
            subject: 'Update project',
            authorName: 'Developer',
            authorEmail: 'developer@example.test',
            committedAt: 1,
            refs: []
          }
        ]),
        historyNextCursor: ref(null),
        historyLoading: ref(false),
        historyError: ref(undefined),
        historyFetchFailed: ref(false),
        historyFiles: ref({}),
        historyFilesLoading: ref([]),
        historyFilesErrors: ref([]),
        historyRepositoryPath: ref(''),
        selectedHistoryRefs: ref([]),
        historySource: ref({ repositoryPath: '', refs: [] }),
        repositories: ref([]),
        selectHistory: vi.fn(),
        loadHistoryFiles: vi.fn(),
        loadHistory: vi.fn()
      };
      const failure = new Error('Clipboard access denied');
      const writeText = fails
        ? vi.fn().mockRejectedValue(failure)
        : vi.fn().mockResolvedValue(undefined);
      const notice = vi.fn();
      vi.stubGlobal('navigator', { clipboard: { writeText } });
      vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
      const view = renderComponent(WorkspaceGitHistory, { service, onNotice: notice });
      try {
        const row = view
          .findAll('button')
          .find((node) => String(node.props.class).includes('history-commit-row'))!;
        const preventDefault = vi.fn();
        (
          row.props.onContextmenu as (event: {
            preventDefault(): void;
            clientX: number;
            clientY: number;
          }) => void
        )({ preventDefault, clientX: 40, clientY: 50 });
        expect(preventDefault).toHaveBeenCalledOnce();
        await nextTick();
        expect(
          view
            .findAll('div')
            .some(
              (node) => node.props.class === 'history-context-menu' && node.props.role === 'menu'
            )
        ).toBe(true);
        const item = view.findAll('button').find((node) => node.props.role === 'menuitem')!;
        expect(
          view
            .findAll('button')
            .some((node) => String(node.props.class).includes('history-commit-more'))
        ).toBe(false);
        await (item.props.onClick as () => Promise<void>)();
        expect(writeText).toHaveBeenCalledWith(hash);
        expect(notice).toHaveBeenCalledOnce();
        expect(notice.mock.calls[0]?.[1]).toBe(fails ? 'error' : 'info');
        if (fails) expect(notice.mock.calls[0]?.[2]).toBe(failure);
        await nextTick();
        expect(
          view.findAll('div').some((node) => node.props.class === 'history-context-menu')
        ).toBe(false);
      } finally {
        view.unmount();
      }
    }
  );
});

import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import ElementPlus, { ID_INJECTION_KEY, ZINDEX_INJECTION_KEY } from 'element-plus';
import { i18n } from '../../src/service/LocalePreferenceService.js';
import GitDiffViewer from '../../src/view/workspace/GitDiffViewer.vue';
import {
  createToolChangeReviewService,
  loadToolChangeDiff,
  toolChangeOpenIntent
} from '../../src/service/ToolChangeReviewService.js';
import { conversationFileChangeEntries } from '../../src/util/conversation-presentation.js';
import {
  workspaceFileTabIdentity,
  type WorkspaceFileTab
} from '../../src/util/workspace-file-tab.js';

const text = '--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new\n';
const diff = {
  status: 'available' as const,
  source: 'TOOL_CHANGE' as const,
  format: 'unified-diff' as const,
  resourceRef: 'c10a59dd-680f-46f6-9b75-31bfbd520506',
  byteSize: Buffer.byteLength(text),
  sha256: createHash('sha256').update(text).digest('hex')
};
const changeId = 'f22e0a23-1281-4b99-aeb4-96dfd041bfb1';
const entry = { path: 'file', change: 'MODIFIED', status: 'Modified', changeId, diff };
const scope = {
  nodeId: 'node',
  workspaceId: 'workspace',
  sessionId: 'session',
  scope: 'SESSION' as const
};
function tab(): WorkspaceFileTab {
  const intent = toolChangeOpenIntent(entry, scope)!;
  return { ...intent, id: 1, identity: workspaceFileTabIdentity(intent), fileName: 'file' };
}
const page = {
  type: 'file_changes',
  version: 1,
  resourceRef: diff.resourceRef,
  format: diff.format,
  byteSize: diff.byteSize,
  sha256: diff.sha256,
  content: text
};

describe('tool change review', () => {
  it.each(['WORKING_TREE', 'HISTORY', 'TOOL_CHANGE'] as const)(
    'uses the shared source-file action for %s without a separate current-file shortcut',
    async (source) => {
      const app = createSSRApp({
        render: () =>
          h(GitDiffViewer, {
            path: 'file',
            paths: ['file'],
            diff: { text },
            source,
            loading: false,
            previewEnabled: true,
            embedded: true
          })
      });
      app.use(i18n);
      app.use(ElementPlus);
      app.provide(ID_INJECTION_KEY, { prefix: 50, current: 0 });
      app.provide(ZINDEX_INJECTION_KEY, { current: 0 });
      const html = await renderToString(app);
      expect(html).toContain('aria-label="Open source file"');
      expect(html).toContain('Ctrl/⌘+E');
      expect(html).not.toContain('Open current file');
    }
  );

  it('keeps all Runner legacy entries and trustworthy zero statistics without inventing details', () => {
    for (const change of ['ADDED', 'MODIFIED', 'DELETED', 'RENAMED', 'COPIED', 'TYPE_CHANGED']) {
      const changes = conversationFileChangeEntries([
        {
          id: change,
          kind: 'file_change',
          status: 'COMPLETED',
          payload: {
            changes: [{ path: 'file', change, additions: 0, deletions: null, diffAvailable: true }]
          }
        }
      ]);
      expect(changes[0]).toMatchObject({ path: 'file', change, additions: 0 });
      expect(changes[0]).not.toHaveProperty('deletions');
      expect(changes[0]).not.toHaveProperty('diff');
      expect(toolChangeOpenIntent(changes[0]!, scope)).toBeUndefined();
    }
  });

  it('separates changes to the same path and scopes without duplicating repeated opens', () => {
    const service = createToolChangeReviewService(vi.fn());
    service.open(entry, scope);
    service.open(entry, scope);
    expect(service.tabs.tabs.value).toHaveLength(1);
    service.open({ ...entry, changeId: 'ee171bba-0822-4e0f-b4c8-84e652a7f145' }, scope);
    service.open(entry, { ...scope, scope: 'HOSTED' });
    expect(service.tabs.tabs.value).toHaveLength(3);
    service.clear();
    expect(service.tabs.tabs.value).toHaveLength(0);
  });

  it('reads immutable content only from the selected resource endpoint', async () => {
    const request = vi.fn().mockResolvedValue(page);
    expect(await loadToolChangeDiff(tab(), request)).toEqual({ text });
    expect(request.mock.calls[0]![0]).toContain(
      `/api/agent-sessions/session/tool-resources/${diff.resourceRef}?`
    );
    expect(request.mock.calls[0]![0]).toContain('workspaceId=workspace');
    const hosted = { ...tab(), toolChange: { ...tab().toolChange!, scope: 'HOSTED' as const } };
    await loadToolChangeDiff(hosted, request);
    expect(request.mock.calls[1]![0]).toContain(
      '/api/nodes/node/hosted-conversations/session/tool-resources/'
    );
  });

  it('joins bounded pages and rejects wrong identities, hashes, repeated cursors and short bodies', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ ...page, content: text.slice(0, 10), nextCursor: 'next' })
      .mockResolvedValueOnce({ ...page, content: text.slice(10) });
    expect(await loadToolChangeDiff(tab(), request)).toEqual({ text });
    expect(request.mock.calls[1]![0]).toContain('cursor=next');
    for (const invalid of [
      { ...page, resourceRef: changeId },
      { ...page, sha256: 'b'.repeat(64) },
      { ...page, content: '' }
    ])
      await expect(loadToolChangeDiff(tab(), vi.fn().mockResolvedValue(invalid))).rejects.toThrow(
        'TOOL_RESOURCE_RESPONSE_INVALID'
      );
    await expect(
      loadToolChangeDiff(
        tab(),
        vi.fn().mockResolvedValue({ ...page, content: 'x', nextCursor: 'same' })
      )
    ).rejects.toThrow('TOOL_RESOURCE_RESPONSE_INVALID');
  });

  it('cancels pagination without accepting late content', async () => {
    const controller = new AbortController();
    const request = vi.fn(async () => {
      controller.abort();
      return page;
    });
    await expect(loadToolChangeDiff(tab(), request, controller.signal)).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });
});

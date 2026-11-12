import { toolResultResourcePageSchema } from '@myagentroam/protocol';
import { sha256 } from '../util/sha256.js';
import type { FileChangeEntry } from '../util/conversation-presentation.js';
import type { WorkspaceFileOpenIntent, WorkspaceFileTab } from '../util/workspace-file-tab.js';
import { createWorkspaceFileTabService } from './workspace-file-tab-service.js';

export interface ToolChangeScope {
  readonly nodeId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly scope: 'SESSION' | 'HOSTED';
}

export function toolChangeOpenIntent(
  entry: FileChangeEntry,
  scope: ToolChangeScope
): WorkspaceFileOpenIntent | undefined {
  if (entry.diff?.status !== 'available' || !entry.changeId) return undefined;
  return {
    kind: 'TOOL_CHANGE_DIFF',
    nodeId: scope.nodeId,
    workspaceId: scope.workspaceId,
    path: entry.path,
    repositoryPath: '',
    worktreePath: '',
    paths: [entry.path],
    toolChange: {
      scope: scope.scope,
      sessionId: scope.sessionId,
      changeId: entry.changeId,
      diff: entry.diff
    }
  };
}

export async function loadToolChangeDiff(
  tab: WorkspaceFileTab,
  request: (path: string) => Promise<unknown>,
  signal?: AbortSignal
): Promise<{ text: string }> {
  const source = tab.toolChange;
  if (tab.kind !== 'TOOL_CHANGE_DIFF' || !source) throw new Error('TOOL_RESOURCE_INPUT_INVALID');
  const prefix =
    source.scope === 'SESSION'
      ? `/api/agent-sessions/${encodeURIComponent(source.sessionId)}/tool-resources/${encodeURIComponent(source.diff.resourceRef)}`
      : `/api/nodes/${encodeURIComponent(tab.nodeId)}/hosted-conversations/${encodeURIComponent(source.sessionId)}/tool-resources/${encodeURIComponent(source.diff.resourceRef)}`;
  const chunks: string[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  let bytes = 0;
  const encoder = new TextEncoder();
  for (let pageIndex = 0; pageIndex < 66; pageIndex++) {
    signal?.throwIfAborted();
    const query = new URLSearchParams({ maxBytes: String(256 * 1024) });
    if (source.scope === 'SESSION') {
      query.set('nodeId', tab.nodeId);
      query.set('workspaceId', tab.workspaceId);
    }
    if (cursor !== undefined) query.set('cursor', cursor);
    const page = toolResultResourcePageSchema.parse(await request(`${prefix}?${query}`));
    signal?.throwIfAborted();
    const chunkBytes = encoder.encode(page.content).byteLength;
    if (
      page.resourceRef !== source.diff.resourceRef ||
      page.sha256 !== source.diff.sha256 ||
      page.byteSize !== source.diff.byteSize ||
      chunkBytes > 256 * 1024 ||
      (page.nextCursor !== undefined && chunkBytes === 0)
    )
      throw new Error('TOOL_RESOURCE_RESPONSE_INVALID');
    bytes += chunkBytes;
    if (bytes > source.diff.byteSize) throw new Error('TOOL_RESOURCE_RESPONSE_INVALID');
    chunks.push(page.content);
    if (page.nextCursor === undefined) {
      if (bytes !== source.diff.byteSize) throw new Error('TOOL_RESOURCE_RESPONSE_INVALID');
      const text = chunks.join('');
      if ((await sha256(encoder.encode(text))) !== source.diff.sha256)
        throw new Error('TOOL_RESOURCE_RESPONSE_INVALID');
      signal?.throwIfAborted();
      return { text };
    }
    if (seen.has(page.nextCursor)) throw new Error('TOOL_RESOURCE_RESPONSE_INVALID');
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error('TOOL_RESOURCE_RESPONSE_INVALID');
}

export function createToolChangeReviewService(request: (path: string) => Promise<unknown>) {
  const tabs = createWorkspaceFileTabService();
  return {
    tabs,
    open(entry: FileChangeEntry, scope: ToolChangeScope) {
      const intent = toolChangeOpenIntent(entry, scope);
      if (intent) tabs.open(intent);
    },
    load: (tab: WorkspaceFileTab, signal?: AbortSignal) => loadToolChangeDiff(tab, request, signal),
    clear: () => tabs.restore({ tabs: [] })
  };
}

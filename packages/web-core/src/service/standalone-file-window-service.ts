import type { WorkspaceFileOpenIntent } from '../util/workspace-file-tab.js';

export interface StandaloneFileWindowService {
  open(url: string): Window | undefined;
  openNew(url: string): Window | undefined;
}

export const STANDALONE_FILE_OPEN_EVENT = 'mar-open-standalone-file';
export function standaloneFileContext(url: string): string {
  const parsed = new URL(
    url,
    typeof location === 'undefined' ? 'http://localhost' : location.origin
  );
  const match = /^[/]share[/]([A-Za-z0-9_-]{1,128})$/u.exec(parsed.pathname);
  return match === null ? 'workbench' : `share:${match[1]}`;
}

export interface StandaloneFileOpenIntent {
  readonly nodeId: string;
  readonly workspaceId: string;
  readonly path: string;
  readonly worktreePath?: string;
  readonly repositoryPath?: string;
  readonly line?: number;
  readonly column?: number;
  readonly tab?: WorkspaceFileOpenIntent;
}

export function standaloneFileOpenIntent(url: string): StandaloneFileOpenIntent | undefined {
  const parsed = new URL(
    url,
    typeof location === 'undefined' ? 'http://localhost' : location.origin
  );
  if (
    standaloneFileContext(url) !== 'workbench' ||
    parsed.searchParams.get('standaloneFile') !== '1' ||
    parsed.searchParams.get('markdownPreview') === '1' ||
    parsed.searchParams.get('htmlPreview') === '1' ||
    parsed.searchParams.get('source') === 'hosted'
  )
    return undefined;
  const nodeId = parsed.searchParams.get('nodeId');
  const workspaceId = parsed.searchParams.get('workspaceId');
  const path = parsed.searchParams.get('path');
  if (nodeId === null || workspaceId === null || path === null) return undefined;
  const worktreePath = parsed.searchParams.get('worktreePath');
  const line = Number(parsed.searchParams.get('line'));
  const column = Number(parsed.searchParams.get('column'));
  const tabKind = parsed.searchParams.get('fileTabKind');
  let tab: WorkspaceFileOpenIntent | undefined;
  if (tabKind !== null) {
    if (tabKind !== 'WORKTREE_DIFF' && tabKind !== 'HISTORY_DIFF') return undefined;
    const repositoryPath = parsed.searchParams.get('repositoryPath') ?? '';
    const commit = parsed.searchParams.get('commit');
    if (tabKind === 'HISTORY_DIFF' && commit === null) return undefined;
    const previousPath = parsed.searchParams.get('previousPath');
    const refs = parsed.searchParams.getAll('refs');
    const paths = parsed.searchParams.getAll('paths');
    tab = {
      kind: tabKind,
      ...(parsed.searchParams.get('gitFile') === '1' ? { gitFile: true } : {}),
      nodeId,
      workspaceId,
      path,
      repositoryPath,
      worktreePath: worktreePath ?? '',
      ...(commit === null ? {} : { commit }),
      ...(previousPath === null ? {} : { previousPath }),
      ...(refs.length === 0 ? {} : { refs }),
      paths: paths.length === 0 ? [path] : paths
    };
  }
  return {
    nodeId,
    workspaceId,
    path,
    ...(worktreePath === null ? {} : { worktreePath }),
    ...(tab === undefined && parsed.searchParams.has('repositoryPath')
      ? { repositoryPath: parsed.searchParams.get('repositoryPath')! }
      : {}),
    ...(line > 0 ? { line } : {}),
    ...(column > 0 ? { column } : {}),
    ...(tab === undefined ? {} : { tab })
  };
}

export function createStandaloneFileWindowService(
  openWindow?: (url?: string, target?: string) => Window | null,
  context = 'workbench'
): StandaloneFileWindowService {
  let fileWindow: Window | undefined;
  let markdownWindow: Window | undefined;
  let htmlWindow: Window | undefined;
  return {
    openNew(url) {
      if (standaloneFileContext(url) !== context) return undefined;
      const opener =
        openWindow ?? (typeof window === 'undefined' ? undefined : window.open.bind(window));
      const popup = opener?.(url, '_blank');
      if (popup == null) return undefined;
      popup.opener = null;
      popup.focus();
      return popup;
    },
    open(url) {
      if (standaloneFileContext(url) !== context) return undefined;
      const opener =
        openWindow ?? (typeof window === 'undefined' ? undefined : window.open.bind(window));
      if (opener === undefined) return undefined;
      const markdownPreview =
        new URL(url, 'http://localhost').searchParams.get('markdownPreview') === '1';
      const htmlPreview = new URL(url, 'http://localhost').searchParams.get('htmlPreview') === '1';
      const existing = htmlPreview ? htmlWindow : markdownPreview ? markdownWindow : fileWindow;
      const isNew = existing === undefined || existing.closed;
      const standalone =
        isNew &&
        typeof window !== 'undefined' &&
        window.matchMedia?.('(display-mode: standalone)').matches === true;
      const popup =
        existing !== undefined && !existing.closed
          ? existing
          : opener(
              standalone ? url : '',
              htmlPreview
                ? `mar-html-preview${context === 'workbench' ? '' : ':' + context}`
                : markdownPreview
                  ? `mar-markdown-preview${context === 'workbench' ? '' : ':' + context}`
                  : `mar-file-preview${context === 'workbench' ? '' : ':' + context}`
            );
      if (popup === null) return undefined;
      if (htmlPreview) htmlWindow = popup;
      else if (markdownPreview) markdownWindow = popup;
      else fileWindow = popup;
      if (standalone) {
        popup.opener = null;
        popup.focus();
        return popup;
      }
      let handled = false;
      try {
        handled = !popup.dispatchEvent(
          new CustomEvent(STANDALONE_FILE_OPEN_EVENT, {
            cancelable: true,
            detail: { url }
          })
        );
      } catch {
        // A previously reused named window may currently be cross-origin.
      }
      popup.opener = null;
      if (!handled) popup.location.replace(url);
      popup.focus();
      return popup;
    }
  };
}

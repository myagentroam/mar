import { createWorkbenchPageShortcuts } from './workbench-page-shortcuts.js';
import type { MessageFeedback } from '../model/message-feedback.js';
import type { WorkspaceTarget } from '../model/workbench.js';
import type { ComposerAttachmentFile } from '@myagentroam/protocol';
import { nextTick, type Ref } from 'vue';
import { runnerBrandIcon } from '../util/runner-brand-icon.js';
import type { NodeSummary, Session, Workspace, WorkspaceTab } from '../model/workbench.js';
import type { WorkspaceFileWorkbenchHandle } from './workbench-surface-state-service.js';
import type { WorkspaceFileOpenIntent } from '../util/workspace-file-tab.js';
import type { WorkbenchView } from '../util/workbench-route.js';
import { nodePresentation, sessionActivityTitle } from '../util/workbench-presentation.js';
import { formatRelativeSessionActivity } from '../util/session-list.js';
import { translate } from '../service/locale-preference-service.js';
import { toolChangeOpenIntent } from './tool-change-review-service.js';
import type { FileChangeEntry } from '../util/conversation-presentation.js';
import { copyConversationMessage as copyMessage } from './workbench-conversation-copy-service.js';
import { isHtmlFile } from '../util/file-preview.js';

export interface WorkbenchPageInteractionOptions {
  readonly view: Readonly<Ref<WorkbenchView>>;
  readonly nodes: Ref<NodeSummary[]>;
  readonly workspaceTabs: Readonly<Ref<readonly WorkspaceTab[]>>;
  readonly activeWorkspaceTabId: Readonly<Ref<string | undefined>>;
  readonly activateWorkspaceTab: (tab: WorkspaceTab) => Promise<unknown>;
  readonly closeWorkspaceTab: (tab: WorkspaceTab) => void;
  readonly closeUnpinnedWorkspaceTabs: () => void;
  readonly workspaceTarget: Readonly<Ref<WorkspaceTarget | undefined>>;
  readonly selectedWorkspace: Readonly<Ref<Workspace | undefined>>;
  readonly selectedSessionId?: Readonly<Ref<string | undefined>>;
  readonly nodeReady: Readonly<Ref<boolean>>;
  readonly openNewSessionComposer: () => void;
  readonly filesReady: Readonly<Ref<boolean>>;
  readonly contentSearchReady: Readonly<Ref<boolean>>;
  readonly terminalReady: Readonly<Ref<boolean>>;
  readonly quickOpenFileVisible: Ref<boolean>;
  readonly workspaceFileWorkbench: Ref<WorkspaceFileWorkbenchHandle | null | undefined>;
  readonly openWorkspaceFileExternal: (path: string, line?: number, column?: number) => void;
  readonly fileWorkbench: {
    openTab(intent: WorkspaceFileOpenIntent): Promise<void>;
    openFile(path: string, line?: number, column?: number): Promise<void>;
    openComparison(path: string, line?: number, column?: number): Promise<void>;
  };
  readonly showAsideTool: (tool: 'search' | 'changes') => void;
  readonly openAttachmentImage?: (attachment: ComposerAttachmentFile) => Promise<void>;
  readonly openHtml: (path: string) => void;
  readonly openHtmlExternal: (path: string) => void;
  readonly toggleTerminal: () => void;
  readonly sessionActivityClockNow: Readonly<Ref<number>>;
  readonly notice: MessageFeedback;
  readonly formatSessionTime: (value: number) => string;
}

export function createWorkbenchPageInteractionService(options: WorkbenchPageInteractionOptions) {
  function openAgentFileChange(entry: FileChangeEntry): void {
    const target = options.workspaceTarget.value;
    const sessionId = options.selectedSessionId?.value;
    if (!target || !sessionId || !options.nodeReady.value) return;
    const intent = toolChangeOpenIntent(entry, { ...target, sessionId, scope: 'SESSION' });
    if (intent) void options.fileWorkbench.openTab(intent);
  }
  let quickOpenOrigin: HTMLElement | undefined;

  function workspaceTabNodeLabel(tab: WorkspaceTab): string {
    const node = options.nodes.value.find((candidate) => candidate.id === tab.nodeId);
    return node === undefined ? (tab.nodeLabel ?? tab.nodeId) : nodePresentation(node);
  }

  function sessionRelativeActivity(session: Session): string {
    if (session.externalDiscovered === false) return '—';
    return formatRelativeSessionActivity(
      session.lastActivityAt,
      options.sessionActivityClockNow.value
    );
  }

  function sessionActivityTooltip(session: Session): string | undefined {
    return sessionActivityTitle(session, options.formatSessionTime);
  }

  function openAgentWorkspaceFile(
    path: string,
    line?: number,
    column?: number,
    external = false,
    attachment?: ComposerAttachmentFile
  ): void {
    if (
      !external &&
      attachment?.mime.startsWith('image/') &&
      options.openAttachmentImage !== undefined
    ) {
      void options.openAttachmentImage(attachment);
      return;
    }
    openWorkspaceFile(path, line, column, external, true);
  }

  function openQuickWorkspaceFile(
    path: string,
    line?: number,
    column?: number,
    external = false
  ): void {
    openWorkspaceFile(path, line, column, external);
  }

  function openWorkspaceFile(
    path: string,
    line: number | undefined,
    column: number | undefined,
    external: boolean,
    preferGitChanges = false
  ): void {
    const workspaceRoot = options.selectedWorkspace.value?.path
      .replaceAll('\\', '/')
      .replace(/\/+$/, '');
    const normalizedPath = path.replaceAll('\\', '/');
    const windowsWorkspace = workspaceRoot !== undefined && /^[a-z]:\//i.test(workspaceRoot);
    const comparablePath = windowsWorkspace ? normalizedPath.toLocaleLowerCase() : normalizedPath;
    const comparableRoot = windowsWorkspace ? workspaceRoot.toLocaleLowerCase() : workspaceRoot;
    const workspacePath =
      workspaceRoot !== undefined &&
      comparableRoot !== undefined &&
      comparablePath.startsWith(`${comparableRoot}/`)
        ? normalizedPath.slice(workspaceRoot.length + 1)
        : normalizedPath;
    if (
      preferGitChanges &&
      isHtmlFile(workspacePath) &&
      !workspacePath.startsWith('/') &&
      !/^[a-z]:\//i.test(workspacePath) &&
      !workspacePath.split('/').some((segment) => segment === '..' || segment === '')
    ) {
      if (external) options.openHtmlExternal(workspacePath);
      else options.openHtml(workspacePath);
      return;
    }
    if (!options.filesReady.value) {
      options.notice(
        translate('generated.workbenchPageInteractionService.filePreviewIsCurrentlyUnavailable'),
        'error'
      );
      return;
    }
    if (external) {
      options.openWorkspaceFileExternal(workspacePath, line, column);
      return;
    }
    void (preferGitChanges
      ? options.fileWorkbench.openComparison(workspacePath, line, column)
      : options.fileWorkbench.openFile(workspacePath, line, column));
  }

  function openQuickOpenFile(): void {
    if (
      options.view.value !== 'nodes' ||
      !options.nodes.value.some((node) => node.connected && !node.disabled)
    )
      return;
    quickOpenOrigin =
      document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    options.quickOpenFileVisible.value = true;
  }

  function closeQuickOpenFile(selected = false): void {
    options.quickOpenFileVisible.value = false;
    if (!selected) void nextTick(() => quickOpenOrigin?.focus());
  }

  const workspaceShortcuts = createWorkbenchPageShortcuts(options, openQuickOpenFile);
  const copyConversationMessage = (text: string, onSuccess: () => void): Promise<void> =>
    copyMessage(text, onSuccess, options.notice);

  return {
    openAgentFileChange,
    closeQuickOpenFile,
    copyConversationMessage,
    workspaceShortcuts,
    openAgentWorkspaceFile,
    openQuickWorkspaceFile,
    openQuickOpenFile,
    runnerBrandIcon,
    sessionActivityTitle: sessionActivityTooltip,
    sessionRelativeActivity,
    workspaceTabNodeLabel
  };
}

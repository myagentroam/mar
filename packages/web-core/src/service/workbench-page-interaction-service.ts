import type { MessageFeedback } from '../model/message-feedback.js';
import type { WorkspaceTarget } from '../model/workbench.js';
import type { ComposerAttachmentFile } from '@myagentroam/protocol';
import { nextTick, type Ref } from 'vue';
import claudeRunnerIcon from '../assets/runner-claude-code.png';
import codexRunnerIcon from '../assets/runner-codex.png';
import marAgentRunnerIcon from '../assets/logo-icon.png';
import openCodeRunnerIcon from '../assets/runner-opencode.svg';
import type { NodeSummary, Session, Workspace, WorkspaceTab } from '../model/workbench.js';
import type { WorkspaceInspectorHandle } from '../service/workbench-workspace-cache-controller.js';
import type { WorkbenchView } from '../util/workbench-route.js';
import { nodePresentation, sessionActivityTitle } from '../util/workbench-presentation.js';
import { formatRelativeSessionActivity } from '../util/session-list.js';
import { translate } from '../service/locale-preference-service.js';
import type { ConsoleShortcutResult } from './console-keyboard-shortcut-service.js';
import { toolChangeOpenIntent } from './tool-change-review-service.js';
import type { FileChangeEntry } from '../util/conversation-presentation.js';

interface WorkbenchPageInteractionOptions {
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
  readonly workspaceInspector: Ref<WorkspaceInspectorHandle | null | undefined>;
  readonly openAttachmentImage?: (attachment: ComposerAttachmentFile) => Promise<void>;
  readonly toggleTerminal: () => void;
  readonly sessionActivityClockNow: Readonly<Ref<number>>;
  readonly notice: MessageFeedback;
  readonly formatSessionTime: (value: number) => string;
}

export function runnerBrandIcon(value: Session['runner']): string {
  if (value === 'mar-agent') return marAgentRunnerIcon;
  if (value === 'codex') return codexRunnerIcon;
  return value === 'claude-code' ? claudeRunnerIcon : openCodeRunnerIcon;
}

export function createWorkbenchPageInteractionService(options: WorkbenchPageInteractionOptions) {
  function openAgentFileChange(entry: FileChangeEntry): void {
    const target = options.workspaceTarget.value;
    const sessionId = options.selectedSessionId?.value;
    if (!target || !sessionId || !options.nodeReady.value) return;
    const intent = toolChangeOpenIntent(entry, { ...target, sessionId, scope: 'SESSION' });
    if (intent) options.workspaceInspector.value?.openWorkspaceFileTab(intent);
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
    if (options.workspaceInspector.value == null) {
      options.notice(
        translate('generated.workbenchPageInteractionService.filePreviewIsCurrentlyUnavailable'),
        'error'
      );
      return;
    }
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
    if (external) {
      options.workspaceInspector.value.openWorkspaceFileExternal(workspacePath, line, column);
      return;
    }
    void (preferGitChanges
      ? options.workspaceInspector.value.openWorkspaceFileComparison(workspacePath, line, column)
      : options.workspaceInspector.value.openFile(workspacePath, line, column));
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

  function onGlobalKeydown(event: KeyboardEvent): ConsoleShortcutResult {
    const target = event.target;
    const blocked =
      target instanceof Element &&
      (target.closest('.terminal-dock, .el-overlay, .el-popper, .el-select, [role="dialog"]') !==
        null ||
        (target.closest('.composer-host') === null &&
          target.closest(
            'input, textarea, select, [contenteditable]:not([contenteditable="false"])'
          ) !== null));
    if (
      (event.altKey || event.ctrlKey) &&
      (event.code === 'KeyW' || event.key.toLowerCase() === 'w')
    ) {
      if (
        (event.ctrlKey && event.altKey) ||
        event.metaKey ||
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        options.view.value !== 'nodes' ||
        options.quickOpenFileVisible.value ||
        blocked
      ) {
        return 'IGNORED';
      }
      const activeTab = options.workspaceTabs.value.find(
        (tab) => tab.id === options.activeWorkspaceTabId.value
      );
      if (options.workspaceTabs.value.length === 0) return 'IGNORED';
      if (event.repeat) return 'HANDLED';
      if (event.shiftKey) options.closeUnpinnedWorkspaceTabs();
      else if (activeTab !== undefined && activeTab.pinned !== true)
        options.closeWorkspaceTab(activeTab);
      return 'HANDLED';
    }
    const ctrlTab = event.ctrlKey && !event.altKey && event.key === 'Tab';
    const newSessionKey = event.code === 'KeyN' || event.key.toLowerCase() === 'n';
    const ctrlNewSession = event.ctrlKey && !event.altKey && !event.shiftKey && newSessionKey;
    const digit =
      /^Digit([0-9])$/.exec(event.code)?.[1] ?? (/^[0-9]$/.test(event.key) ? event.key : undefined);
    const ctrlNumberedTab =
      event.ctrlKey && !event.altKey && !event.shiftKey && digit !== undefined;
    if (
      ((event.altKey && !event.ctrlKey && !event.shiftKey) ||
        ctrlTab ||
        ctrlNewSession ||
        ctrlNumberedTab) &&
      !event.metaKey &&
      !event.defaultPrevented &&
      !event.isComposing &&
      event.keyCode !== 229 &&
      options.view.value === 'nodes' &&
      !options.quickOpenFileVisible.value &&
      !blocked
    ) {
      const cycleShortcut = ctrlTab || event.key === 'ArrowLeft' || event.key === 'ArrowRight';
      if (event.repeat && !cycleShortcut && !ctrlNumberedTab) return 'IGNORED';
      if (
        newSessionKey &&
        options.nodeReady.value &&
        options.workspaceTarget.value?.workspaceId !== undefined
      ) {
        options.openNewSessionComposer();
        return 'HANDLED';
      }
      const numberedTabIndex = ctrlNumberedTab
        ? digit === '0'
          ? 9
          : Number(digit) - 1
        : undefined;
      if (numberedTabIndex !== undefined) {
        const numberedTab = options.workspaceTabs.value[numberedTabIndex];
        if (numberedTab === undefined) return 'IGNORED';
        if (event.repeat) return 'HANDLED';
        void options.activateWorkspaceTab(numberedTab);
        return 'HANDLED';
      }
      if (!cycleShortcut || options.workspaceTabs.value.length === 0) return 'IGNORED';
      const index = options.workspaceTabs.value.findIndex(
        (tab) => tab.id === options.activeWorkspaceTabId.value
      );
      if (index < 0) return 'IGNORED';
      if (event.repeat || options.workspaceTabs.value.length === 1) return 'HANDLED';
      const offset = event.key === 'ArrowLeft' || (ctrlTab && event.shiftKey) ? -1 : 1;
      const adjacent =
        options.workspaceTabs.value[
          (index + offset + options.workspaceTabs.value.length) % options.workspaceTabs.value.length
        ];
      if (adjacent === undefined) return 'IGNORED';
      void options.activateWorkspaceTab(adjacent);
      return 'HANDLED';
    }
    const terminalFocused = target instanceof Element && target.closest('.terminal-dock') !== null;
    if (
      terminalFocused &&
      !(event.shiftKey && event.code === 'Backquote' && (event.ctrlKey || event.metaKey))
    )
      return 'IGNORED';
    if (!event.ctrlKey && !event.metaKey) return 'IGNORED';
    const key = event.key.toLowerCase();
    const editableTarget =
      target instanceof HTMLElement &&
      (target.isContentEditable || target.matches('input, textarea, select'));
    if (event.shiftKey && key === 'v') {
      if (editableTarget || event.isComposing) return 'IGNORED';
      return options.workspaceInspector.value?.openCurrentRenderedPreview() === true
        ? 'HANDLED'
        : 'IGNORED';
    }
    if (event.shiftKey && key === 'o') {
      if (
        options.view.value !== 'nodes' ||
        !options.nodes.value.some((node) => node.connected && !node.disabled)
      )
        return 'IGNORED';
      openQuickOpenFile();
      return 'HANDLED';
    }
    if (event.shiftKey && key === 'f') {
      if (!options.contentSearchReady.value || event.isComposing) return 'IGNORED';
      options.workspaceInspector.value?.openSearch();
      return 'HANDLED';
    }
    if (event.shiftKey && key === 'k') {
      if (options.selectedWorkspace.value?.kind !== 'GIT_WORKSPACE' || !options.filesReady.value)
        return 'IGNORED';
      options.workspaceInspector.value?.openChanges();
      return 'HANDLED';
    }
    if (event.shiftKey && event.code === 'Backquote') {
      if (!options.terminalReady.value || event.isComposing) return 'IGNORED';
      options.toggleTerminal();
      return 'HANDLED';
    }
    return 'IGNORED';
  }

  async function copyConversationMessage(text: string, onSuccess: () => void): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      onSuccess();
    } catch {
      options.notice(
        translate(
          'generated.workbenchPageInteractionService.copyFailedCheckTheBrowserClipboardPermission'
        ),
        'error'
      );
    }
  }

  return {
    openAgentFileChange,
    closeQuickOpenFile,
    copyConversationMessage,
    onGlobalKeydown,
    openAgentWorkspaceFile,
    openQuickWorkspaceFile,
    openQuickOpenFile,
    runnerBrandIcon,
    sessionActivityTitle: sessionActivityTooltip,
    sessionRelativeActivity,
    workspaceTabNodeLabel
  };
}

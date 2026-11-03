import type { WorkbenchPageInteractionOptions } from './workbench-page-interaction-service.js';
import {
  consoleKeyboardShortcutService,
  type ConsoleShortcutBinding
} from './console-keyboard-shortcut-service.js';
import { workspaceKeys } from './console-shortcut-keys.js';

export function createWorkbenchPageShortcuts(
  options: WorkbenchPageInteractionOptions,
  openQuickOpenFile: () => void
): readonly ConsoleShortcutBinding[] {
  const workspaceReady = (event: KeyboardEvent): boolean => {
    const target = event.target;
    const blocked =
      target instanceof Element &&
      (target.closest('[role="dialog"], [aria-modal="true"]') !== null ||
        (target.closest(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"])'
        ) !== null &&
          !consoleKeyboardShortcutService.isWithin('pane', target)));
    return options.view.value === 'nodes' && !options.quickOpenFileVisible.value && !blocked;
  };
  const workspaceBinding = (
    command: string,
    keys: ConsoleShortcutBinding['keys'],
    execute: ConsoleShortcutBinding['execute']
  ): ConsoleShortcutBinding => ({
    command,
    keys,
    execute,
    priority: 10,
    scope: 'workspace',
    when: workspaceReady
  });
  return [
    workspaceBinding('workspace.closeTab', workspaceKeys.close, (event) => {
      const active = options.workspaceTabs.value.find(
        (tab) => tab.id === options.activeWorkspaceTabId.value
      );
      if (options.workspaceTabs.value.length === 0) return 'IGNORED';
      if (!event.repeat) {
        if (event.shiftKey) options.closeUnpinnedWorkspaceTabs();
        else if (active !== undefined && active.pinned !== true) options.closeWorkspaceTab(active);
      }
      return 'HANDLED';
    }),
    workspaceBinding('workspace.newSession', workspaceKeys.newSession, (event) => {
      if (
        event.repeat ||
        !options.nodeReady.value ||
        options.workspaceTarget.value?.workspaceId === undefined
      )
        return 'IGNORED';
      options.openNewSessionComposer();
      return 'HANDLED';
    }),
    workspaceBinding('workspace.cycleTab', workspaceKeys.cycle, (event) => {
      const tabs = options.workspaceTabs.value;
      const index = tabs.findIndex((tab) => tab.id === options.activeWorkspaceTabId.value);
      if (tabs.length === 0 || index < 0) return 'IGNORED';
      if (event.repeat || tabs.length === 1) return 'HANDLED';
      const offset = event.key === 'ArrowLeft' || (event.key === 'Tab' && event.shiftKey) ? -1 : 1;
      const adjacent = tabs[(index + offset + tabs.length) % tabs.length];
      if (adjacent === undefined) return 'IGNORED';
      void options.activateWorkspaceTab(adjacent);
      return 'HANDLED';
    }),
    workspaceBinding('workspace.numberedTab', workspaceKeys.numbered, (event) => {
      const digit = /^Digit([0-9])$/.exec(event.code)?.[1] ?? event.key;
      const index = digit === '0' ? 9 : Number(digit) - 1;
      const tab = options.workspaceTabs.value[index];
      if (tab === undefined) return 'IGNORED';
      if (!event.repeat) void options.activateWorkspaceTab(tab);
      return 'HANDLED';
    }),
    {
      command: 'workspace.renderedPreview',
      priority: 10,
      scope: 'workspace',
      keys: workspaceKeys.preview,
      when: (event) =>
        !(
          event.target instanceof HTMLElement &&
          (event.target.isContentEditable || event.target.matches('input, textarea, select'))
        ),
      execute: () =>
        options.workspaceInspector.value?.openCurrentRenderedPreview() === true
          ? 'HANDLED'
          : 'IGNORED'
    },
    {
      command: 'workspace.quickOpen',
      priority: 10,
      scope: 'workspace',
      keys: workspaceKeys.quickOpen,
      when: () =>
        options.view.value === 'nodes' &&
        options.nodes.value.some((node) => node.connected && !node.disabled),
      execute: () => {
        openQuickOpenFile();
        return 'HANDLED';
      }
    },
    {
      command: 'workspace.search',
      priority: 10,
      scope: 'workspace',
      keys: workspaceKeys.search,
      when: () => options.contentSearchReady.value && options.workspaceInspector.value != null,
      execute: () => {
        options.showInspectorTool('search');
        return 'HANDLED';
      }
    },
    {
      command: 'workspace.changes',
      priority: 10,
      scope: 'workspace',
      keys: workspaceKeys.changes,
      when: () =>
        options.selectedWorkspace.value?.kind === 'GIT_WORKSPACE' &&
        options.filesReady.value &&
        options.workspaceInspector.value != null,
      execute: () => {
        options.showInspectorTool('changes');
        return 'HANDLED';
      }
    },
    {
      command: 'workspace.terminal',
      priority: 10,
      scope: 'workspace',
      allowedInBlockedScopes: ['terminal'],
      keys: workspaceKeys.terminal,
      when: () => options.terminalReady.value,
      execute: () => {
        options.toggleTerminal();
        return 'HANDLED';
      }
    }
  ];
}

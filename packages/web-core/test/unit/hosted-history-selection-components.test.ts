import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostedConversationSummary } from '@myagentroam/protocol';
import HostedWorkspace from '../../src/view/conversation/HostedConversationWorkspacePage.vue?unit-render';
import { createHostedConversationWorkspaceService } from '../../src/service/hosted-conversation-workspace-service.js';
import { createHostedConversationSelectionService } from '../../src/service/hosted-conversation-selection-service.js';
import { createHostedConversationWatchCoordinator } from '../../src/service/hosted-conversation-watch-coordinator.js';
import { showMessage } from '../../src/service/message-feedback-service.js';
import { localePreferenceService } from '../../src/service/locale-preference-service.js';
import {
  flushComponent,
  renderComponent,
  textContent,
  trigger
} from './support/component-renderer.js';

vi.mock('../../src/service/message-feedback-service.js', () => ({ showMessage: vi.fn() }));

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const first: HostedConversationSummary = {
  id: 'conversation-a',
  nodeId: 'node-a',
  sessionId: 'session-a',
  templateId: 'template',
  templateName: 'Template',
  activeVersionId: 'version',
  title: 'History A',
  titleSource: 'CUSTOM',
  pinnedAt: null,
  status: 'ACTIVE',
  modelId: 'model',
  createdAt: 1,
  updatedAt: 1,
  lastActivityAt: 1,
  activity: { status: 'IDLE', updatedAt: 1, version: 1 }
};
// The conversation ID alone is not a target identity.
const second = { ...first, nodeId: 'node-b', sessionId: 'session-b', title: 'History B' };

beforeEach(() => {
  vi.stubGlobal('HTMLElement', class {});
  vi.stubGlobal('window', {
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} })
  });
  vi.stubGlobal('document', {
    documentElement: { lang: '' },
    addEventListener() {},
    removeEventListener() {}
  });
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function fixture(hasUnread = false) {
  const request = vi.fn(async () => ({ items: [first, second], nextCursor: null })) as Parameters<
    typeof createHostedConversationWorkspaceService
  >[0]['request'];
  const workspace = createHostedConversationWorkspaceService({
    request,
    workbenchConnectionId: () => 'connection-current',
    heartbeatMs: 60_000,
    requestTimeoutMs: 1_000,
    confirmationTimeoutMs: 60_000
  });
  await workspace.loadConversations();
  workspace.selectConversation(first.nodeId, first.id);
  const openings: ReturnType<typeof deferred>[] = [];
  const begin = vi.fn(() => {
    const gate = deferred();
    openings.push(gate);
    return gate.promise;
  });
  const coordinator = createHostedConversationWatchCoordinator({
    workspace: {
      start: vi.fn(),
      restart: vi.fn(),
      pause: vi.fn(),
      stop: vi.fn(),
      handleEvent: () => false
    },
    session: {
      beginSelectedSessionWatch: vi.fn(),
      restartSelectedSessionWatch: vi.fn(),
      pauseSelectedSessionWatch: vi.fn(),
      stopSelectedSessionWatch: vi.fn(),
      handleSessionWatchVisibility: vi.fn(),
      handleEvent: () => false
    },
    hosted: {
      beginSelectedConversationWatch: begin,
      restartSelectedConversationWatch: begin,
      pauseSelectedConversationWatch: vi.fn(),
      stopSelectedConversationWatch: vi.fn(),
      handleVisibility: vi.fn(),
      handleWatchEvent: () => false
    }
  });
  const selection = createHostedConversationSelectionService({
    workspace,
    markRead: vi.fn(),
    coordinator: () => coordinator
  });
  const select = vi.fn(selection.select);
  const view = renderComponent(HostedWorkspace, {
    workspace,
    request,
    selectConversation: select,
    clearConversation: selection.clear,
    connected: true,
    mobileViewport: false,
    mobileHistoryOpen: false,
    sidebarCollapsed: false,
    restoringRoute: false,
    routeTarget: undefined,
    hasUnreadConversation: () => hasUnread
  });
  await flushComponent();
  const row = (title: string) =>
    view
      .findAll('button')
      .find((node) => node.props['class'] === 'history-open' && textContent(node).includes(title))!;
  const busy = () =>
    view.findAll('section').find((node) => node.props['class'] === 'page-loading-state')?.props[
      'aria-busy'
    ];
  return { view, row, busy, workspace, select, openings };
}

describe('Hosted history selection during initial opening', () => {
  it.each([
    ['en-US', 'Unread'],
    ['zh-CN', '未读']
  ] as const)('renders unread history as a readable label in %s', async (locale, label) => {
    const preference = localePreferenceService();
    const previousLocale = preference.locale.value;
    preference.setLocale(locale);
    const f = await fixture(true);
    try {
      const badges = f.view
        .findAll('span')
        .filter((node) => String(node.props['class']).includes('history-unread-label'));
      expect(badges).toHaveLength(2);
      for (const badge of badges) {
        expect(textContent(badge)).toBe(label);
        expect(badge.props['aria-hidden']).not.toBe(true);
      }
    } finally {
      f.view.unmount();
      preference.setLocale(previousLocale);
    }
  });

  it.each(['success', 'failure'] as const)(
    'replaces A with B, deduplicates B and isolates late A %s and cleanup',
    async (outcome) => {
      const f = await fixture();
      try {
        await trigger(f.row(first.title), 'onClick');
        await trigger(f.row(first.title), 'onClick');
        expect(f.select).toHaveBeenCalledTimes(1);
        expect(f.openings).toHaveLength(1);
        expect(f.busy()).toBe(true);
        await trigger(f.row(second.title), 'onClick');
        expect(f.select).toHaveBeenCalledTimes(2);
        expect(f.workspace.selectedNodeId.value).toBe(second.nodeId);
        expect(f.row(second.title).props['aria-current']).toBe('page');
        await trigger(f.row(second.title), 'onClick');
        expect(f.select).toHaveBeenCalledTimes(2);

        if (outcome === 'success') f.openings[0]!.resolve();
        else f.openings[0]!.reject(new Error('Stale A failed'));
        await flushComponent();
        expect(showMessage).not.toHaveBeenCalled();
        expect(f.workspace.selectedNodeId.value).toBe(second.nodeId);
        expect(f.busy()).toBe(true);
        await trigger(f.row(second.title), 'onClick');
        expect(f.select).toHaveBeenCalledTimes(2);

        f.openings[1]!.resolve();
        await flushComponent();
        expect(f.busy()).toBe(false);
        expect(f.row(second.title).props['aria-current']).toBe('page');
      } finally {
        f.view.unmount();
      }
    }
  );

  it('keeps a reopened A owned by its newer request when the first A fails late', async () => {
    const f = await fixture();
    try {
      await trigger(f.row(first.title), 'onClick');
      await trigger(f.row(second.title), 'onClick');
      await trigger(f.row(first.title), 'onClick');
      expect(f.select).toHaveBeenCalledTimes(3);
      f.openings[0]!.reject(new Error('Stale first A failed'));
      f.openings[1]!.resolve();
      await flushComponent();
      expect(showMessage).not.toHaveBeenCalled();
      expect(f.busy()).toBe(true);
      await trigger(f.row(first.title), 'onClick');
      expect(f.select).toHaveBeenCalledTimes(3);
      f.openings[2]!.resolve();
      await flushComponent();
      expect(f.busy()).toBe(false);
      expect(f.workspace.selectedNodeId.value).toBe(first.nodeId);
    } finally {
      f.view.unmount();
    }
  });

  it('reports the current opening failure and allows an explicit retry', async () => {
    const f = await fixture();
    try {
      await trigger(f.row(first.title), 'onClick');
      const error = new Error('Current opening failed');
      f.openings[0]!.reject(error);
      await flushComponent();
      expect(showMessage).toHaveBeenCalledExactlyOnceWith(expect.any(String), 'error', error);
      expect(f.busy()).toBe(false);
      await trigger(f.row(first.title), 'onClick');
      expect(f.select).toHaveBeenCalledTimes(2);
      expect(f.busy()).toBe(true);
      f.openings[1]!.resolve();
      await flushComponent();
      expect(f.busy()).toBe(false);
    } finally {
      f.view.unmount();
    }
  });
});

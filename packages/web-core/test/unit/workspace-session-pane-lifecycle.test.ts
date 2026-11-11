import { describe, expect, it, vi } from 'vitest';
import { effectScope, ref, watch, type Ref } from 'vue';
import type { ComposerQuoteDraft, ComposerReference } from '@myagentroam/protocol';
import { createComposerAttachmentService } from '../../src/service/composer-attachment-service.js';
import {
  createWorkspaceSessionPaneLifecycle,
  createWorkspaceSessionPaneRead
} from '../../src/service/workspace-session-pane-loader.js';
import { createConversationScrollService } from '../../src/service/conversation-scroll-service.js';
import {
  createSessionDraftService,
  type DraftTarget
} from '../../src/service/session-draft-service.js';
import { createWorkbenchSubmissionOwner } from '../../src/service/workbench-submission-service.js';
import { createWorkspaceSessionPaneState } from '../../src/service/workspace-session-pane-state.js';

function fakeLoader(load: Parameters<typeof createWorkspaceSessionPaneRead>[0]) {
  return { load, read: createWorkspaceSessionPaneRead(load) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('secondary session Pane lifecycle', () => {
  it.each([false, true])(
    'keeps failure diagnostics inline and supports explicit retry (cached=%s)',
    async (cached) => {
      const failed = ref(false);
      const failureCause = ref<unknown>();
      const loading = ref(false);
      const loadingContent = ref(false);
      const failure = new Error('SESSION_HISTORY_INITIAL_FAILED');
      const load = vi
        .fn()
        .mockRejectedValueOnce(failure)
        .mockResolvedValue({
          session: { id: 's', workspaceId: 'w', runner: 'codex' },
          changed: true
        });
      const scope = effectScope();
      const lifecycle = scope.run(() =>
        createWorkspaceSessionPaneLifecycle({
          target: ref({ kind: 'session', nodeId: 'n', workspaceId: 'w', sessionId: 's' }),
          visible: ref(true),
          loading,
          loadingContent,
          failed,
          failureCause,
          currentRequest: () => 0,
          loader: fakeLoader(load),
          restore: () => cached,
          save: vi.fn(),
          cancel: vi.fn(),
          stopWatch: vi.fn(),
          beginInitialRender: async () => {},
          scrollElement: () => undefined,
          scrollLatest: async () => {},
          markRead: vi.fn()
        })
      )!;
      try {
        await lifecycle.reload();
        expect(failed.value).toBe(true);
        expect(failureCause.value).toBe(failure);
        expect(loading.value).toBe(false);
        expect(loadingContent.value).toBe(false);
        expect(load).toHaveBeenCalledOnce();
        const retry = lifecycle.reload();
        expect(failed.value).toBe(false);
        expect(failureCause.value).toBeUndefined();
        expect(loading.value).toBe(true);
        expect(loadingContent.value).toBe(!cached);
        await retry;
        expect(load).toHaveBeenCalledTimes(2);
        expect(loading.value).toBe(false);
        expect(failed.value).toBe(false);
      } finally {
        scope.stop();
      }
    }
  );

  it('preserves the same visible session reading position and follow intent while positioning a different target', async () => {
    const target = ref<DraftTarget>({
      kind: 'session',
      nodeId: 'n',
      workspaceId: 'w',
      sessionId: 'a'
    });
    const visible = ref(false);
    const element = {
      scrollHeight: 1000,
      scrollTop: 0,
      clientHeight: 200,
      ownerDocument: { elementFromPoint: () => null },
      getBoundingClientRect: () => ({ top: 0, left: 0, width: 100, height: 200 }),
      contains: () => false
    } as unknown as HTMLElement;
    const scroll = createConversationScrollService();
    scroll.setElement(element);
    let cached = false;
    const scope = effectScope();
    const lifecycle = scope.run(() =>
      createWorkspaceSessionPaneLifecycle({
        target,
        visible,
        loading: ref(false),
        loadingContent: ref(false),
        failed: ref(false),
        currentRequest: () => 0,
        loader: fakeLoader(
          vi.fn().mockResolvedValue({
            session: { id: 'a', workspaceId: 'w', runner: 'codex' },
            changed: true
          })
        ),
        restore: () => cached,
        save: () => {
          cached = true;
        },
        cancel: vi.fn(),
        stopWatch: vi.fn(),
        beginInitialRender: async () => {},
        scrollElement: () => scroll.element.value,
        scrollLatest: async () => {
          scroll.scrollToLatest();
        },
        markRead: vi.fn(),
        failureCause: ref<unknown>()
      })
    )!;
    visible.value = true;
    await lifecycle.reload();
    expect(element.scrollTop).toBe(1000);
    element.scrollTop = 300;
    scroll.handleScroll(vi.fn());
    expect(scroll.following.value).toBe(false);
    visible.value = false;
    visible.value = true;
    await lifecycle.reload();
    expect(element.scrollTop).toBe(300);
    expect(scroll.following.value).toBe(false);

    visible.value = false;
    target.value = { kind: 'session', nodeId: 'n', workspaceId: 'w', sessionId: 'b' };
    target.value = { kind: 'session', nodeId: 'n', workspaceId: 'w', sessionId: 'a' };
    visible.value = true;
    await lifecycle.reload();
    expect(element.scrollTop).toBe(1000);
    expect(scroll.following.value).toBe(true);

    scroll.scrollToLatest();
    visible.value = false;
    visible.value = true;
    await lifecycle.reload();
    const restoreAnchor = scroll.captureRenderAnchor();
    Object.defineProperty(element, 'scrollHeight', { value: 1200, configurable: true });
    restoreAnchor();
    expect(scroll.following.value).toBe(true);
    expect(element.scrollTop).toBe(1200);

    element.scrollTop = 300;
    scroll.handleScroll(vi.fn());
    target.value = { kind: 'session', nodeId: 'n', workspaceId: 'w', sessionId: 'b' };
    await lifecycle.reload();
    expect(element.scrollTop).toBe(1200);
    expect(scroll.following.value).toBe(true);
    visible.value = false;
    const remounted = { ...element, scrollTop: 0 } as HTMLElement;
    scroll.setElement(remounted);
    visible.value = true;
    await lifecycle.reload();
    expect(remounted.scrollTop).toBe(1200);
    scope.stop();
  });

  it('invalidates a pending read after an A → B → A target change', async () => {
    const target = ref<DraftTarget>({
      kind: 'session',
      nodeId: 'n',
      workspaceId: 'a',
      sessionId: 'same'
    });
    const visible = ref(true);
    const first = deferred<never>();
    const markRead = vi.fn();
    const scroll = vi.fn();
    const failureCause = ref<unknown>();
    const scope = effectScope();
    let revision = 0;
    let current!: () => boolean;
    scope.run(() => {
      watch(
        target,
        () => {
          revision += 1;
        },
        { flush: 'sync' }
      );
      createWorkspaceSessionPaneLifecycle({
        target,
        visible,
        loading: ref(false),
        loadingContent: ref(false),
        failed: ref(false),
        currentRequest: () => revision,
        loader: fakeLoader(
          vi.fn((input) => {
            current = input.isCurrent;
            return first.promise;
          })
        ),
        restore: () => false,
        save: vi.fn(),
        cancel: vi.fn(),
        stopWatch: vi.fn(),
        beginInitialRender: async () => {},
        scrollElement: () => undefined,
        scrollLatest: scroll,
        markRead,
        failureCause
      });
    });
    const oldCurrent = current;
    target.value = { ...target.value, workspaceId: 'b' };
    target.value = { ...target.value, workspaceId: 'a' };
    expect(oldCurrent()).toBe(false);
    scope.stop();
    first.resolve(undefined as never);
    await first.promise;
    await Promise.resolve();
    expect(scroll).not.toHaveBeenCalled();
    expect(markRead).not.toHaveBeenCalled();
    expect(failureCause.value).toBeUndefined();
  });

  it('does not scroll or mark read when disposed during initial rendering', async () => {
    const target = ref<DraftTarget>({
      kind: 'session',
      nodeId: 'n',
      workspaceId: 'w',
      sessionId: 's'
    });
    const render = deferred<void>();
    const scroll = vi.fn();
    const markRead = vi.fn();
    const cancel = vi.fn();
    const failureCause = ref<unknown>();
    const scope = effectScope();
    scope.run(() =>
      createWorkspaceSessionPaneLifecycle({
        target,
        visible: ref(true),
        loading: ref(false),
        loadingContent: ref(false),
        failed: ref(false),
        currentRequest: () => 0,
        loader: fakeLoader(
          vi.fn().mockResolvedValue({
            session: { id: 's', workspaceId: 'w', runner: 'codex' },
            changed: true
          })
        ),
        restore: () => false,
        save: vi.fn(),
        cancel,
        stopWatch: vi.fn(),
        beginInitialRender: () => render.promise,
        scrollElement: () => undefined,
        scrollLatest: scroll,
        markRead,
        failureCause
      })
    );
    await Promise.resolve();
    scope.stop();
    render.resolve();
    await render.promise;
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();
    expect(scroll).not.toHaveBeenCalled();
    expect(markRead).not.toHaveBeenCalled();
    expect(failureCause.value).toBeUndefined();
  });

  it.each(['target change', 'scope disposal'])(
    'invalidates in-flight positioning after %s',
    async (action) => {
      const target = ref<DraftTarget>({
        kind: 'session',
        nodeId: 'n',
        workspaceId: 'w',
        sessionId: 'a'
      });
      const gate = deferred<void>();
      const positioned = vi.fn();
      const scope = effectScope();
      const lifecycle = scope.run(() =>
        createWorkspaceSessionPaneLifecycle({
          target,
          visible: ref(true),
          loading: ref(false),
          loadingContent: ref(false),
          failed: ref(false),
          currentRequest: () => 0,
          loader: fakeLoader(
            vi.fn().mockResolvedValue({
              session: { id: 'a', workspaceId: 'w', runner: 'codex' },
              changed: true
            })
          ),
          restore: () => false,
          save: vi.fn(),
          cancel: vi.fn(),
          stopWatch: vi.fn(),
          beginInitialRender: async () => {},
          scrollElement: () => undefined,
          scrollLatest: async (isCurrent) => {
            await gate.promise;
            if (isCurrent()) positioned();
          },
          markRead: vi.fn(),
          failureCause: ref<unknown>()
        })
      )!;
      const old = lifecycle.reload();
      await Promise.resolve();
      await Promise.resolve();
      if (action === 'target change')
        target.value = { kind: 'session', nodeId: 'n', workspaceId: 'w', sessionId: 'b' };
      else scope.stop();
      gate.resolve();
      await old;
      if (action === 'target change') {
        await lifecycle.reload();
        expect(positioned).toHaveBeenCalledOnce();
      } else expect(positioned).not.toHaveBeenCalled();
      scope.stop();
    }
  );
});

function createDraftStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key)
  };
}

function createQuoteOwners(target: Ref<DraftTarget | undefined>) {
  const storage = createDraftStorage();
  const drafts = createSessionDraftService({ target, storage });
  const attachments = createComposerAttachmentService({
    context: () => target.value,
    notice: vi.fn(),
    request: async <T>() => ({}) as T,
    csrfToken: ref(''),
    renewCsrfToken: async () => '',
    onUnauthenticated: vi.fn()
  });
  const submissions = createWorkbenchSubmissionOwner();
  return { storage, drafts, attachments, submissions };
}

function createQuotePaneState(
  target: Ref<DraftTarget | undefined>,
  pane: 'main' | 'aside',
  owners: ReturnType<typeof createQuoteOwners>
) {
  const scope = effectScope();
  const state = scope.run(() =>
    createWorkspaceSessionPaneState({
      pane,
      draftTarget: target,
      drafts: owners.drafts,
      attachments: owners.attachments,
      submissions: owners.submissions,
      onConversationOverflow: vi.fn()
    })
  )!;
  return { state, scope };
}

function fileQuote(text: string): ComposerQuoteDraft {
  return {
    type: 'quote',
    label: 'main.ts:4',
    source: 'file',
    path: 'src/main.ts',
    origin: 'WORKING_TREE',
    startLine: 4,
    endLine: 4,
    text
  };
}

describe('session Pane quote capture', () => {
  it('writes each quote only to the originating Pane draft', () => {
    const target = ref<DraftTarget | undefined>({
      kind: 'session',
      nodeId: 'node',
      workspaceId: 'workspace',
      sessionId: 'session-a'
    });
    const owners = createQuoteOwners(target);
    const main = createQuotePaneState(target, 'main', owners);
    const aside = createQuotePaneState(target, 'aside', owners);
    try {
      const mainCapture = main.state.captureQuote(() => true, vi.fn());
      const asideCapture = aside.state.captureQuote(() => true, vi.fn());
      mainCapture?.(fileQuote('main selection'));
      asideCapture?.(fileQuote('aside selection'));

      const targetValue = target.value!;
      const mainReferences = owners.drafts.forTarget(targetValue, 'main').references.value;
      const asideReferences = owners.drafts.forTarget(targetValue, 'aside').references.value;
      expect(mainReferences).toMatchObject([{ source: 'file', text: 'main selection' }]);
      expect(asideReferences).toMatchObject([{ source: 'file', text: 'aside selection' }]);
      const mainQuote = mainReferences[0];
      const asideQuote = asideReferences[0];
      if (mainQuote?.type !== 'quote' || asideQuote?.type !== 'quote') {
        throw new Error('Expected independent quote references in both panes');
      }
      expect(mainQuote.id).not.toBe(asideQuote.id);
    } finally {
      main.scope.stop();
      aside.scope.stop();
    }
  });

  it('ignores a menu capture after its target changes or the Pane locks', () => {
    const firstTarget: DraftTarget = {
      kind: 'session',
      nodeId: 'node',
      workspaceId: 'workspace',
      sessionId: 'session-a'
    };
    const secondTarget: DraftTarget = { ...firstTarget, sessionId: 'session-b' };
    const target = ref<DraftTarget | undefined>(firstTarget);
    const owners = createQuoteOwners(target);
    const pane = createQuotePaneState(target, 'aside', owners);
    let enabled = true;
    const rejected = vi.fn();
    try {
      const staleCapture = pane.state.captureQuote(() => enabled, rejected);
      target.value = secondTarget;
      staleCapture?.(fileQuote('stale selection'));

      const lockedCapture = pane.state.captureQuote(() => enabled, rejected);
      enabled = false;
      lockedCapture?.(fileQuote('locked selection'));

      expect(pane.state.captureQuote(() => false, rejected)).toBeUndefined();
      expect(owners.drafts.forTarget(firstTarget, 'aside').references.value).toEqual([]);
      expect(owners.drafts.forTarget(secondTarget, 'aside').references.value).toEqual([]);
      expect(rejected).not.toHaveBeenCalled();
    } finally {
      pane.scope.stop();
    }
  });

  it('keeps an added quote as a persisted snapshot without replacing draft text or arrays', () => {
    const currentTarget: DraftTarget = {
      kind: 'session',
      nodeId: 'node',
      workspaceId: 'workspace',
      sessionId: 'session-a'
    };
    const target = ref<DraftTarget | undefined>(currentTarget);
    const owners = createQuoteOwners(target);
    const pane = createQuotePaneState(target, 'main', owners);
    const slot = owners.drafts.forTarget(currentTarget, 'main');
    const fileReference: ComposerReference = {
      type: 'file',
      path: 'src/main.ts',
      label: 'main.ts'
    };
    const originalReferences: ComposerReference[] = [fileReference];
    const body = 'Review @src/main.ts and keep this draft';
    slot.input.value = body;
    slot.references.value = originalReferences;
    slot.persist();
    const selected = fileQuote('captured source snapshot');

    try {
      pane.state.captureQuote(() => true, vi.fn())?.(selected);
      selected.text = 'source changed after capture';

      expect(slot.input.value).toBe(body);
      expect(slot.references.value).not.toBe(originalReferences);
      expect(originalReferences).toEqual([fileReference]);
      expect(slot.references.value).toMatchObject([
        fileReference,
        { source: 'file', path: 'src/main.ts', text: 'captured source snapshot' }
      ]);
      const persisted = JSON.parse(
        owners.storage.values.get('mar.workbench.draft.node.workspace') ?? '{}'
      ) as { input?: string; references?: readonly ComposerReference[] };
      expect(persisted.input).toBe(body);
      expect(persisted.references).toEqual(slot.references.value);

      const restored = createSessionDraftService({
        target: ref(currentTarget),
        storage: owners.storage
      });
      const restoredSlot = restored.forTarget(currentTarget, 'main');
      expect(restoredSlot.input.value).toBe(body);
      expect(restoredSlot.references.value).toEqual(slot.references.value);
    } finally {
      pane.scope.stop();
    }
  });
});

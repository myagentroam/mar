import { describe, expect, it, vi } from 'vitest';
import { computed, effectScope, ref } from 'vue';
import { createWorkspaceSessionPaneState } from '../../src/service/workspace-session-pane-state.js';
import { createWorkbenchSubmissionOwner } from '../../src/service/workbench-submission-service.js';
import { createComposerAttachmentService } from '../../src/service/composer-attachment-service.js';
import {
  createSessionDraftService,
  type DraftTarget
} from '../../src/service/session-draft-service.js';

function fixture() {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null
  };
  const target = ref<DraftTarget | undefined>({
    kind: 'session',
    nodeId: 'n',
    workspaceId: 'w',
    sessionId: 'a'
  });
  return { storage, values, target, owner: createSessionDraftService({ target, storage }) };
}

describe('Workspace Pane composer drafts', () => {
  it.each(
    (['close', 'evict', 'reopen', 'failure', 'delete', 'sign-out'] as const).flatMap((scenario) =>
      (['main', 'aside'] as const).map((pane) => ({ scenario, pane }))
    )
  )(
    'settles a real $pane queue PATCH completion after Workspace $scenario in durable storage',
    async ({ scenario, pane: position }) => {
      const { owner, target, storage, values } = fixture();
      const originalTarget = target.value!;
      const scope = effectScope();
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const pending = new Promise<void>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      const pane = scope.run(() =>
        createWorkspaceSessionPaneState({
          submissions: createWorkbenchSubmissionOwner(),
          pane: position,
          draftTarget: target,
          drafts: owner,
          attachments: createComposerAttachmentService({
            context: () => target.value,
            request: vi.fn() as never,
            renewCsrfToken: vi.fn(),
            csrfToken: ref('csrf'),
            onUnauthenticated: vi.fn(),
            notice: vi.fn()
          }),
          onConversationOverflow: vi.fn()
        })
      )!;
      const queue = ref({ version: 0, paused: false, items: [] });
      const actions = pane.createQueueActions({
        queue,
        currentSessionQueue: computed(() => queue.value),
        currentSelectionRevision: () => 0,
        request: (() => pending) as never,
        notice: vi.fn(),
        errorMessage: String,
        missingQueueItemError: () => false,
        beginSubmission: () => () => true
      });
      try {
        owner.input.value = 'Unsubmitted composer';
        const otherTargets = [
          { ...originalTarget, nodeId: 'other-node' },
          { ...originalTarget, workspaceId: 'other-workspace' },
          { ...originalTarget, sessionId: 'other-session' }
        ];
        for (const other of otherTargets) {
          const otherSlot = owner.forTarget(other);
          otherSlot.queueEdit.value = {
            queueItemId: 'item',
            content: 'Other target',
            tags: '',
            origin: ''
          };
          otherSlot.persist();
        }
        pane.queue.startEditing({ queueItemId: 'item', content: 'Saved edit' });
        const old = owner.forTarget(originalTarget, position);
        const saving = actions.save('item');
        target.value = undefined;
        if (scenario === 'evict')
          for (let index = 0; index < 65; index++)
            owner.forTarget({ ...originalTarget, workspaceId: `evict-${index}` });
        else owner.releaseWorkspace('n', 'w');
        expect([...values.values()].some((value) => value.includes('Saved edit'))).toBe(true);
        if (scenario === 'reopen') {
          target.value = originalTarget;
          pane.queue.startEditing({ queueItemId: 'item', content: 'New edit' });
          pane.queue.editingContent.value = 'New edit';
        } else if (scenario === 'delete') owner.releaseSession('n', 'w', 'a');
        else if (scenario === 'sign-out') owner.clear();
        if (scenario === 'failure') reject(new Error('PATCH failed'));
        else resolve();
        expect(await saving).toBe(scenario !== 'failure');
        const restored = createSessionDraftService({ target: ref(originalTarget), storage });
        const expected =
          scenario === 'failure' ? 'Saved edit' : scenario === 'reopen' ? 'New edit' : undefined;
        expect(restored.queueEdit.value?.content).toBe(expected);
        expect(owner.forTarget(originalTarget).queueEdit.value?.content).toBe(expected);
        expect(restored.input.value).toBe(scenario === 'sign-out' ? '' : 'Unsubmitted composer');
        for (const other of otherTargets)
          expect(restored.forTarget(other).queueEdit.value?.content).toBe(
            scenario === 'sign-out' ? undefined : 'Other target'
          );
        old.queueEdit.value = { queueItemId: 'item', content: 'stale', tags: '', origin: '' };
        expect(old.persist()).toBe(false);
        expect(
          createSessionDraftService({ target: ref(originalTarget), storage }).queueEdit.value
            ?.content
        ).toBe(expected);
      } finally {
        scope.stop();
      }
    }
  );

  it('recovers the active legacy session draft into Main once without copying it into Aside', () => {
    const { owner, target, storage, values } = fixture();
    values.set(
      'mar.workbench.session-draft.["n","w","a"]',
      JSON.stringify({
        input: 'legacy input',
        references: [{ type: 'file', path: 'a.ts', label: 'a.ts' }]
      })
    );
    // Workspace selection can precede restoration of its selected Session.
    target.value = { kind: 'workspace', nodeId: 'n', workspaceId: 'w' };
    expect(owner.input.value).toBe('');
    target.value = { ...target.value, kind: 'session', sessionId: 'a' };
    expect(owner.input.value).toBe('legacy input');
    expect(owner.references.value).toEqual([{ type: 'file', path: 'a.ts', label: 'a.ts' }]);
    expect(owner.bindTarget(target, 'aside').input.value).toBe('');
    owner.input.value = '';
    owner.references.value = [];
    owner.persist();
    values.set(
      'mar.workbench.session-draft.["n","w","b"]',
      JSON.stringify({ input: 'other legacy' })
    );
    target.value = { ...target.value, kind: 'session', sessionId: 'b' };
    const restored = createSessionDraftService({ target, storage });
    expect(restored.input.value).toBe('');
  });

  it('never replaces an existing Workspace Pane draft with a legacy session draft', () => {
    const { owner, values } = fixture();
    values.set('mar.workbench.draft.n.w', JSON.stringify({ input: 'current input' }));
    values.set(
      'mar.workbench.session-draft.["n","w","a"]',
      JSON.stringify({ input: 'legacy input' })
    );
    expect(owner.input.value).toBe('current input');
  });

  it('recovers legacy queue editing by session and does not revive a finished edit', () => {
    const { owner, target, storage, values } = fixture();
    const queueEdit = { queueItemId: 'q', content: 'old edit', tags: 'tags', origin: 'origin' };
    values.set('mar.workbench.session-draft.["n","w","a"]', JSON.stringify({ queueEdit }));
    expect(owner.queueEdit.value).toEqual(queueEdit);
    expect(owner.bindTarget(target, 'aside').queueEdit.value).toEqual(queueEdit);
    owner.queueEdit.value = undefined;
    owner.persist();
    const restored = createSessionDraftService({ target, storage });
    expect(restored.queueEdit.value).toBeUndefined();
  });

  it('keeps an unsaved Main edit when selecting a session that still has a legacy draft', () => {
    const { owner, target, values } = fixture();
    values.set(
      'mar.workbench.session-draft.["n","w","a"]',
      JSON.stringify({ input: 'legacy input' })
    );
    target.value = { kind: 'workspace', nodeId: 'n', workspaceId: 'w' };
    owner.input.value = 'new unsaved input';
    target.value = { kind: 'session', nodeId: 'n', workspaceId: 'w', sessionId: 'a' };
    expect(owner.input.value).toBe('new unsaved input');
  });

  it.each(['additional key', 'nonempty payload'] as const)(
    'does not revive another legacy draft after clearing when storage rejects an %s',
    (failure) => {
      const { target, storage, values } = fixture();
      values.set(
        'mar.workbench.session-draft.["n","w","a"]',
        JSON.stringify({ input: 'legacy input' })
      );
      values.set(
        'mar.workbench.session-draft.["n","w","b"]',
        JSON.stringify({ input: 'other legacy' })
      );
      const constrained = {
        ...storage,
        setItem: (key: string, value: string) => {
          if (
            (failure === 'additional key' && key !== 'mar.workbench.draft.n.w') ||
            (failure === 'nonempty payload' && value.includes('legacy input'))
          )
            throw new Error('Storage quota exceeded');
          storage.setItem(key, value);
        }
      };
      const owner = createSessionDraftService({ target, storage: constrained });
      expect(owner.input.value).toBe('legacy input');
      owner.input.value = '';
      owner.persist();
      target.value = { kind: 'session', nodeId: 'n', workspaceId: 'w', sessionId: 'b' };
      const restored = createSessionDraftService({ target, storage: constrained });
      expect(restored.input.value).toBe('');
    }
  );

  it('retains text, skills and references when its Pane switches sessions or opens a new session', () => {
    const { owner, target } = fixture();
    const main = owner.bindTarget(target, 'main');
    main.input.value = 'unfinished';
    main.skillTokens.value = [
      { name: 'review', source: 'WORKSPACE', skillFilePath: '/review/SKILL.md', available: true }
    ];
    main.references.value = [{ type: 'file', path: 'ref.ts', label: 'ref.ts' }];
    const skills = main.skillTokens.value;
    const references = main.references.value;
    target.value = { ...target.value!, kind: 'session', sessionId: 'b' };
    expect(main.input.value).toBe('unfinished');
    expect(main.skillTokens.value).toBe(skills);
    expect(main.references.value).toBe(references);
    target.value = { kind: 'workspace', nodeId: 'n', workspaceId: 'w' };
    expect(main.input.value).toBe('unfinished');
  });

  it('isolates Main and Aside even on the same session and restores each Workspace independently', () => {
    const { owner, target, storage } = fixture();
    const asideTarget = ref<DraftTarget | undefined>(target.value);
    const main = owner.bindTarget(target, 'main');
    const aside = owner.bindTarget(asideTarget, 'aside');
    main.input.value = 'main';
    aside.input.value = 'aside';
    main.persist();
    aside.persist();
    expect(main.input.value).toBe('main');
    asideTarget.value = undefined;
    asideTarget.value = target.value;
    expect(aside.input.value).toBe('aside');
    target.value = { kind: 'session', nodeId: 'other', workspaceId: 'w', sessionId: 'a' };
    expect(main.input.value).toBe('');
    main.input.value = 'another host';
    target.value = asideTarget.value;
    expect(main.input.value).toBe('main');
    const restored = createSessionDraftService({ target, storage });
    expect(restored.bindTarget(target, 'main').input.value).toBe('main');
    expect(restored.bindTarget(target, 'aside').input.value).toBe('aside');
  });

  it('keeps queue edits with their session while the Composer text follows the Pane', () => {
    const { owner, target, storage } = fixture();
    owner.input.value = 'composer';
    owner.queueEdit.value = { queueItemId: 'q', content: 'edited', tags: 'tags', origin: 'origin' };
    owner.persist();
    target.value = { ...target.value!, kind: 'session', sessionId: 'b' };
    expect(owner.input.value).toBe('composer');
    expect(owner.queueEdit.value).toBeUndefined();
    owner.persist();
    target.value = { ...target.value!, kind: 'session', sessionId: 'a' };
    const restored = createSessionDraftService({ target, storage });
    expect(restored.queueEdit.value?.content).toBe('edited');
  });
});

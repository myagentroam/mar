import { computed, ref } from 'vue';
import { workspaceTargetRef } from './support/workspace-fixture.js';
import { describe, expect, it } from 'vitest';
import { COMPOSER_SKILL_TOKEN_PLACEHOLDER } from '../../src/service/composer-skill-token-service.js';
import { createSessionDraftService } from '../../src/service/session-draft-service.js';

function workspaceDraftTarget(
  node: { readonly value: string | undefined },
  workspace: { readonly value: string | undefined }
) {
  const target = workspaceTargetRef(node, workspace);
  return computed(() =>
    target.value === undefined ? undefined : { kind: 'workspace' as const, ...target.value }
  );
}

describe('Web Workspace Draft State', () => {
  it.each([false, true])(
    'keeps bounded slots and retries a retained settlement after storage failure: %s',
    (failStorage) => {
      const values = new Map<string, string>();
      let failing = false;
      const storage = {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => {
          if (failing) throw new Error('quota');
          values.set(key, value);
        },
        removeItem: (key: string) => {
          if (failing) throw new Error('unavailable');
          values.delete(key);
        }
      };
      const owner = createSessionDraftService({ target: ref(undefined), storage });
      const target = { kind: 'session' as const, nodeId: 'n', workspaceId: 'w', sessionId: 's' };
      const old = owner.forTarget(target);
      old.input.value = 'submitted';
      const settlement = old.retain();
      owner.releaseWorkspace('n', 'w');
      const inactive = Array.from({ length: 65 }, (_, index) => {
        const target = { kind: 'workspace' as const, nodeId: 'n', workspaceId: `other-${index}` };
        return { target, slot: owner.forTarget(target) };
      });
      // The in-flight draft is not a pinned LRU slot: the oldest of 65 ordinary slots is evicted.
      expect(owner.forTarget(inactive[0]!.target)).not.toBe(inactive[0]!.slot);
      failing = failStorage;
      settlement.settle(() => {
        old.input.value = '';
      });
      settlement.release();
      expect(old.persist()).toBe(false);
      expect(owner.forTarget(target).input.value).toBe('');
      failing = false;
      expect(owner.forTarget(target).persist()).toBe(true);
      expect(createSessionDraftService({ target: ref(target), storage }).input.value).toBe('');
      settlement.settle(() => {
        old.input.value = 'released settlement';
      });
      expect(owner.forTarget(target).input.value).toBe('');
    }
  );

  it('keeps captured requests independent when one releases before another settles', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key)
    };
    const owner = createSessionDraftService({ target: ref(undefined), storage });
    const target = { kind: 'workspace' as const, nodeId: 'n', workspaceId: 'w' };
    const old = owner.forTarget(target);
    old.input.value = 'submitted';
    const finished = old.retain();
    const pending = old.retain();
    owner.releaseWorkspace('n', 'w');
    finished.release();
    finished.settle(() => {
      old.input.value = 'already released';
    });
    expect(old.input.value).toBe('submitted');
    pending.settle(() => {
      old.input.value = '';
    });
    pending.release();
    expect(createSessionDraftService({ target: ref(target), storage }).input.value).toBe('');
    expect(old.persist()).toBe(false);
  });

  it('does not let an already released slot acquire a new settlement', () => {
    const values = new Map<string, string>();
    const owner = createSessionDraftService({
      target: ref(undefined),
      storage: {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => void values.set(key, value),
        removeItem: (key) => void values.delete(key)
      }
    });
    const target = { kind: 'workspace' as const, nodeId: 'n', workspaceId: 'w' };
    const old = owner.forTarget(target);
    old.input.value = 'unsent';
    owner.releaseWorkspace('n', 'w');
    const late = old.retain();
    late.settle(() => {
      old.input.value = '';
    });
    late.release();
    expect(owner.forTarget(target).input.value).toBe('unsent');
  });

  it('releases closed Workspace drafts after persisting them and bounds inactive slots', () => {
    const values = new Map<string, string>();
    const owner = createSessionDraftService({
      target: ref(undefined),
      storage: {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => void values.set(key, value),
        removeItem: (key) => void values.delete(key)
      }
    });
    const target = { kind: 'session' as const, nodeId: 'n', workspaceId: 'w', sessionId: 's' };
    const first = owner.forTarget(target);
    first.input.value = 'unsent';
    first.queueEdit.value = { queueItemId: 'q', content: 'edit', tags: '', origin: '' };
    owner.releaseWorkspace('n', 'w');
    const restored = owner.forTarget(target);
    expect(restored).not.toBe(first);
    expect(restored.input.value).toBe('unsent');
    expect(restored.queueEdit.value?.content).toBe('edit');
    first.input.value = 'late mutation from a released slot';
    first.persist();
    restored.restore();
    expect(restored.input.value).toBe('unsent');
    for (let i = 0; i < 100; i++) owner.forTarget({ ...target, workspaceId: `other-${i}` });
    expect(owner.forTarget(target)).not.toBe(restored);
    expect(owner.forTarget(target).input.value).toBe('unsent');
  });

  it.each([false, true])(
    'discards deleted session edits without clearing shared Pane input (evicted: %s)',
    (evicted) => {
      const values = new Map<string, string>();
      const owner = createSessionDraftService({
        target: ref(undefined),
        storage: {
          getItem: (key) => values.get(key) ?? null,
          setItem: (key, value) => void values.set(key, value),
          removeItem: (key) => void values.delete(key)
        }
      });
      const target = { kind: 'session' as const, nodeId: 'n', workspaceId: 'w', sessionId: 's' };
      const deleted = owner.forTarget(target);
      deleted.input.value = 'Main draft';
      owner.forTarget(target, 'aside').input.value = 'Aside draft';
      deleted.queueEdit.value = {
        queueItemId: 'deleted',
        content: 'private',
        tags: '',
        origin: ''
      };
      const survivorTarget = { ...target, sessionId: 'survivor' };
      owner.forTarget(survivorTarget).queueEdit.value = {
        queueItemId: 'keep',
        content: 'keep editing',
        tags: '',
        origin: ''
      };
      const legacyKey = `mar.workbench.session-draft.${JSON.stringify(['n', 'w', 's'])}`;
      const queueKey = `mar.workbench.queue-edit.${JSON.stringify(['n', 'w', 'session', 's'])}`;
      values.set(legacyKey, JSON.stringify({ queueEdit: deleted.queueEdit.value }));
      deleted.persist();
      if (evicted) owner.releaseWorkspace('n', 'w');

      owner.releaseSession('n', 'w', 's');
      deleted.persist();
      expect(values.has(queueKey)).toBe(false);
      expect(values.has(legacyKey)).toBe(false);
      expect(owner.forTarget(survivorTarget).input.value).toBe('Main draft');
      expect(owner.forTarget(survivorTarget, 'aside').input.value).toBe('Aside draft');
      expect(owner.forTarget(survivorTarget).queueEdit.value?.content).toBe('keep editing');
      expect(owner.forTarget(target).queueEdit.value).toBeUndefined();
    }
  );

  it('keeps unsaved drafts in memory when release cannot persist them', () => {
    const target = { kind: 'workspace' as const, nodeId: 'n', workspaceId: 'w' };
    const owner = createSessionDraftService({
      target: ref(target),
      storage: {
        getItem: () => null,
        setItem: () => {
          throw new Error('quota');
        },
        removeItem: () => {
          throw new Error('quota');
        }
      }
    });
    const first = owner.forTarget(target);
    first.input.value = 'must not disappear';
    owner.releaseWorkspace('n', 'w');
    expect(owner.forTarget(target)).toBe(first);
    expect(first.input.value).toBe('must not disappear');
  });

  it('retains unsaved Pane input but discards a deleted session edit when storage fails', () => {
    const target = { kind: 'session' as const, nodeId: 'n', workspaceId: 'w', sessionId: 's' };
    const owner = createSessionDraftService({
      target: ref(target),
      storage: {
        getItem: () => null,
        setItem: () => {
          throw new Error('quota');
        },
        removeItem: () => {
          throw new Error('unavailable');
        }
      }
    });
    const main = owner.forTarget(target);
    const aside = owner.forTarget(target, 'aside');
    main.input.value = 'Main unsaved input';
    aside.input.value = 'Aside unsaved input';
    main.queueEdit.value = { queueItemId: 'q', content: 'deleted edit', tags: '', origin: '' };

    owner.releaseSession('n', 'w', 's');
    expect(owner.forTarget(target).input.value).toBe('Main unsaved input');
    expect(owner.forTarget(target, 'aside').input.value).toBe('Aside unsaved input');
    expect(main.queueEdit.value).toBeUndefined();
    expect(aside.queueEdit.value).toBeUndefined();
  });

  it.each([false, true])(
    'keeps the durable legacy input if its Workspace migration fails (all writes fail: %s)',
    (allWritesFail) => {
      const target = { kind: 'session' as const, nodeId: 'n', workspaceId: 'w', sessionId: 's' };
      const legacyKey = `mar.workbench.session-draft.${JSON.stringify(['n', 'w', 's'])}`;
      const values = new Map([
        [
          legacyKey,
          JSON.stringify({
            input: 'durable legacy input',
            queueEdit: { queueItemId: 'q', content: 'deleted edit', tags: '', origin: '' }
          })
        ]
      ]);
      const storage = {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => {
          if (allWritesFail || key.startsWith('mar.workbench.draft.')) throw new Error('quota');
          values.set(key, value);
        },
        removeItem: (key: string) => void values.delete(key)
      };
      const owner = createSessionDraftService({ target: ref(target), storage });
      expect(owner.input.value).toBe('durable legacy input');
      owner.releaseSession('n', 'w', 's');
      expect(JSON.parse(values.get(legacyKey)!).input).toBe('durable legacy input');
      const restored = createSessionDraftService({ target: ref(target), storage });
      expect(restored.input.value).toBe('durable legacy input');
      if (!allWritesFail) expect(restored.queueEdit.value).toBeUndefined();
    }
  );

  it('protects both active Panes when they bind the same target Ref', () => {
    const target = { kind: 'workspace' as const, nodeId: 'n', workspaceId: 'active' };
    const current = ref(target);
    const owner = createSessionDraftService({
      target: current,
      storage: { getItem: () => null, setItem() {}, removeItem() {} }
    });
    owner.bindTarget(current, 'aside');
    const main = owner.forTarget(target);
    const aside = owner.forTarget(target, 'aside');
    main.input.value = 'main';
    aside.input.value = 'aside';
    for (let i = 0; i < 100; i++) owner.forTarget({ ...target, workspaceId: String(i) });
    expect(owner.forTarget(target)).toBe(main);
    expect(owner.forTarget(target, 'aside')).toBe(aside);
    expect(main.input.value).toBe('main');
    expect(aside.input.value).toBe('aside');
  });

  it('clears persisted and evicted drafts on sign-out without deleting other preferences', () => {
    const values = new Map<string, string>([
      ['mar.workbench.session-draft.legacy', 'legacy'],
      ['mar.locale', 'en-US']
    ]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
      get length() {
        return values.size;
      },
      key: (index: number) => [...values.keys()][index] ?? null
    };
    const target = { kind: 'session' as const, nodeId: 'n', workspaceId: 'w', sessionId: 's' };
    const owner = createSessionDraftService({ target: ref(undefined), storage });
    const first = owner.forTarget(target);
    first.input.value = 'previous account';
    first.queueEdit.value = { queueItemId: 'q', content: 'private edit', tags: '', origin: '' };
    owner.releaseWorkspace('n', 'w');
    expect(values.size).toBeGreaterThan(2);
    owner.clear();
    expect([...values]).toEqual([['mar.locale', 'en-US']]);
    first.persist();
    const next = createSessionDraftService({ target: ref(target), storage });
    expect(next.input.value).toBe('');
    expect(next.queueEdit.value).toBeUndefined();
  });

  it('persists and restores a queue edit with its hidden source metadata for only its target', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key)
    };
    const a = { kind: 'session' as const, nodeId: 'n', workspaceId: 'w', sessionId: 'a' };
    const b = { ...a, sessionId: 'b' };
    const first = createSessionDraftService({ target: ref(a), storage });
    first.forTarget(a).queueEdit.value = {
      queueItemId: 'item',
      content: 'edited',
      tags: '<tag>',
      origin: '<origin>'
    };
    first.forTarget(a).persist();
    const restored = createSessionDraftService({ target: ref(a), storage });
    expect(restored.forTarget(a).queueEdit.value).toEqual({
      queueItemId: 'item',
      content: 'edited',
      tags: '<tag>',
      origin: '<origin>'
    });
    expect(restored.forTarget(b).queueEdit.value).toBeUndefined();
  });
  it('keeps the workspace input through session creation when storage writes fail', () => {
    const target = ref<import('../../src/service/session-draft-service.js').DraftTarget>({
      kind: 'workspace',
      nodeId: 'n',
      workspaceId: 'w'
    });
    const owner = createSessionDraftService({
      target,
      storage: {
        getItem: () => null,
        setItem: () => {
          throw new Error('quota');
        },
        removeItem: () => {
          throw new Error('quota');
        }
      }
    });
    owner.input.value = 'follow-up';
    owner.persist();
    target.value = { kind: 'session', nodeId: 'n', workspaceId: 'w', sessionId: 'created' };
    expect(owner.input.value).toBe('follow-up');
    owner.input.value = 'newer input';
    owner.persist();
    target.value = { kind: 'workspace', nodeId: 'n', workspaceId: 'w' };
    expect(owner.input.value).toBe('newer input');
  });
  it('owns independent workspace Pane drafts and reuses each side on session changes', () => {
    const values = new Map<string, string>();
    const a = { kind: 'session' as const, nodeId: 'n', workspaceId: 'w', sessionId: 'a' };
    const b = { kind: 'session' as const, nodeId: 'n', workspaceId: 'w', sessionId: 'b' };
    const owner = createSessionDraftService({
      target: ref(a),
      storage: {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => void values.set(key, value),
        removeItem: (key) => void values.delete(key)
      }
    });
    const main = owner.forTarget(a);
    const aside = owner.forTarget(b, 'aside');
    main.input.value = 'main draft';
    aside.input.value = 'aside draft';
    aside.persist();
    expect(main.input.value).toBe('main draft');
    const moved = owner.forTarget(b, 'aside');
    expect(moved).toBe(aside);
    expect(moved.input.value).toBe('aside draft');
    moved.input.value = 'moved draft';
    expect(aside.input.value).toBe('moved draft');
    expect(main.input.value).toBe('main draft');
  });
  it('keeps live Pane input independent when both sides switch to the same target', () => {
    const values = new Map<string, string>();
    const a = { kind: 'session' as const, nodeId: 'n', workspaceId: 'w', sessionId: 'a' };
    const b = { kind: 'session' as const, nodeId: 'n', workspaceId: 'w', sessionId: 'b' };
    const targetA = ref(a);
    const targetB = ref(b);
    const owner = createSessionDraftService({
      target: targetA,
      storage: {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => void values.set(key, value),
        removeItem: (key) => void values.delete(key)
      }
    });
    const main = owner.bindTarget(targetA);
    const aside = owner.bindTarget(targetB, 'aside');
    main.input.value = 'main';
    aside.input.value = 'aside';
    expect(owner.input.value).toBe('main');
    expect(owner.forTarget(b, 'aside').input.value).toBe('aside');
    targetA.value = b;
    expect(main.input.value).toBe('main');
    main.input.value = 'moved';
    expect(aside.input.value).toBe('aside');
    expect(owner.forTarget(a).input.value).toBe('moved');
  });
  it('restores the same workspace input across session identities and new-session mode', () => {
    const values = new Map<string, string>();
    const target = ref<import('../../src/service/session-draft-service.js').DraftTarget>({
      kind: 'workspace',
      nodeId: 'node-1',
      workspaceId: 'workspace-1'
    });
    const state = createSessionDraftService({
      target,
      storage: {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => void values.set(key, value),
        removeItem: (key) => void values.delete(key)
      }
    });
    state.input.value = 'new session draft';
    state.persist();
    target.value = {
      kind: 'session',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      sessionId: 'a'
    };
    state.restore();
    expect(state.input.value).toBe('new session draft');
    state.input.value = 'draft A';
    state.persist();
    target.value = {
      kind: 'session',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      sessionId: 'b'
    };
    state.restore();
    expect(state.input.value).toBe('draft A');
    target.value = {
      kind: 'session',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      sessionId: 'a'
    };
    state.restore();
    expect(state.input.value).toBe('draft A');
    target.value = { kind: 'workspace', nodeId: 'node-1', workspaceId: 'workspace-1' };
    state.restore();
    expect(state.input.value).toBe('draft A');
  });
  it('Persists and restores drafts per Node and Workspace; empty content clears storage', () => {
    const values = new Map<string, string>();
    const nodeId = { value: 'node-1' };
    const workspaceId = { value: 'workspace-1' };
    const state = createSessionDraftService({
      target: workspaceDraftTarget(nodeId, workspaceId),
      storage: {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => void values.set(key, value),
        removeItem: (key) => void values.delete(key)
      }
    });

    state.input.value = 'Continue publishing';
    state.persist();
    expect(JSON.parse(values.get('mar.workbench.draft.node-1.workspace-1')!)).toEqual({
      input: 'Continue publishing',
      skillTokens: [],
      references: []
    });
    state.input.value = '';
    state.persist();
    expect(values.has('mar.workbench.draft.node-1.workspace-1')).toBe(false);
  });

  it('Saves the body and skill tokens separately, then waits to revalidate available skills after restore', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key)
    };
    const options = {
      target: workspaceDraftTarget({ value: 'node-1' }, { value: 'workspace-1' }),
      storage
    };
    const state = createSessionDraftService(options);
    state.input.value = 'Review';
    state.skillTokens.value = [
      {
        name: 'db-query',
        source: 'WORKSPACE',
        skillFilePath: '/workspace/.agents/skills/db-query/SKILL.md',
        available: true
      }
    ];
    state.persist();

    const restored = createSessionDraftService(options);
    restored.restore();
    expect(restored.skillTokens.value).toEqual([
      expect.objectContaining({ name: 'db-query', available: false })
    ]);
    expect(restored.input.value).toBe('Review');
  });

  it('Restoring an old draft removes inline placeholders and discards malformed skills', () => {
    const state = createSessionDraftService({
      target: workspaceDraftTarget({ value: 'node-1' }, { value: 'workspace-1' }),
      storage: {
        getItem: () =>
          JSON.stringify({
            input: `Review${COMPOSER_SKILL_TOKEN_PLACEHOLDER}${COMPOSER_SKILL_TOKEN_PLACEHOLDER}`,
            skillTokens: [null, { name: 'broken' }]
          }),
        setItem: () => undefined,
        removeItem: () => undefined
      }
    });

    state.restore();

    expect(state.input.value).toBe('Review');
    expect(state.skillTokens.value).toEqual([]);
  });

  it('Switching Workspace identities does not read a same-named draft from another host', () => {
    const nodeId = { value: 'node-2' };
    const state = createSessionDraftService({
      target: workspaceDraftTarget(nodeId, { value: 'workspace-1' }),
      storage: {
        getItem: () => 'node-2 draft',
        setItem: () => undefined,
        removeItem: () => undefined
      }
    });

    state.restore();
    expect(state.input.value).toBe('node-2 draft');
  });
});

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

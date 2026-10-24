import { workspaceTargetRef } from './support/workspace-fixture.js';
import { describe, expect, it } from 'vitest';
import { COMPOSER_SKILL_TOKEN_PLACEHOLDER } from '../../src/service/composer-skill-token-service.js';
import { createSessionDraftService } from '../../src/service/session-draft-service.js';

describe('Web Workspace Draft State', () => {
  it('Persists and restores drafts per Node and Workspace; empty content clears storage', () => {
    const values = new Map<string, string>();
    const nodeId = { value: 'node-1' };
    const workspaceId = { value: 'workspace-1' };
    const state = createSessionDraftService({
      workspaceTarget: workspaceTargetRef(nodeId, workspaceId),
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
      workspaceTarget: workspaceTargetRef({ value: 'node-1' }, { value: 'workspace-1' }),
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
      workspaceTarget: workspaceTargetRef({ value: 'node-1' }, { value: 'workspace-1' }),
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
      workspaceTarget: workspaceTargetRef(nodeId, { value: 'workspace-1' }),
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

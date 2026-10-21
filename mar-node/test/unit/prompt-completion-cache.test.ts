import { describe, expect, it } from 'vitest';
import { PromptCompletionCache } from '../../src/service/prompt-completion-cache.js';

function fixture() {
  let now = 1_000;
  const cache = new PromptCompletionCache({ now: () => now, refreshMs: 100, hardTtlMs: 500 });
  const scope = { workspaceId: 'workspace', generation: 'generation', authorizationView: 'view' };
  const reference = { sessionId: 'other', id: 'message', revision: 1, text: 'Check compatibility' };
  const lease = { expiresAt: 2_000, valid: () => true };
  return {
    cache,
    scope,
    reference,
    lease,
    advance: (ms: number) => {
      now += ms;
    }
  };
}

describe('PromptCompletionCache', () => {
  it('samples four other sessions evenly without reloading when the current session changes', async () => {
    const f = fixture();
    let calls = 0;
    const load = async () => {
      calls++;
      return Array.from({ length: 5 }, (_, session) =>
        Array.from({ length: 20 }, (_, index) => ({
          sessionId: `session-${session}`,
          id: `message-${index}`,
          revision: 1,
          text: `session-${session}: message-${index}`
        }))
      ).flat();
    };
    const first = await f.cache.references(f.scope, 'session-0', f.lease, load);
    expect(first.messages).toHaveLength(20);
    for (let session = 1; session <= 4; session++) {
      expect(first.messages.filter((text) => text.startsWith(`session-${session}:`))).toHaveLength(
        5
      );
      expect(first.messages).toContain(`session-${session}: message-19`);
      expect(first.messages).not.toContain(`session-${session}: message-0`);
    }
    expect(first.messages.some((text) => text.startsWith('session-0:'))).toBe(false);
    const second = await f.cache.references(f.scope, 'session-1', f.lease, load);
    expect(second.messages).toContain('session-0: message-19');
    expect(second.messages.some((text) => text.startsWith('session-1:'))).toBe(false);
    expect(await f.cache.references(f.scope, 'session-0', f.lease, load)).toEqual(first);
    const emptyComposer = await f.cache.references(f.scope, null, f.lease, load);
    expect(emptyComposer.messages).toHaveLength(20);
    expect(emptyComposer.messages.some((text) => text.startsWith('session-4:'))).toBe(false);
    for (let session = 0; session < 4; session++)
      expect(
        emptyComposer.messages.filter((text) => text.startsWith(`session-${session}:`))
      ).toHaveLength(5);
    expect(calls).toBe(1);
    f.cache.dispose();
  });

  it('keeps multilingual long samples bounded while retaining other sessions and recent messages', async () => {
    const f = fixture();
    const references = Array.from({ length: 5 }, (_, session) =>
      Array.from({ length: 20 }, (_, index) => ({
        sessionId: `session-${session}`,
        id: `message-${index}`,
        revision: 1,
        text: `session-${session}: message-${index} ` + '检查兼容性😀'.repeat(600)
      }))
    ).flat();
    const result = await f.cache.references(f.scope, 'session-0', f.lease, async () => references);
    expect(result.messages.length).toBeGreaterThanOrEqual(4);
    expect(result.messages.length).toBeLessThanOrEqual(20);
    expect(
      result.messages.reduce((sum, text) => sum + Buffer.byteLength(text), 0)
    ).toBeLessThanOrEqual(8192);
    for (const text of result.messages) {
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1024);
      expect(text).not.toContain('\uFFFD');
    }
    for (let session = 1; session <= 4; session++)
      expect(
        result.messages.some((text) => text.startsWith(`session-${session}: message-19 `))
      ).toBe(true);
    expect(f.cache.statistics().bytes).toBeLessThan(50 * 1024);
    f.cache.dispose();
  });

  it('does not interrupt another Workspace reference build when a source session changes', async () => {
    const f = fixture();
    await f.cache.references(f.scope, 'current', f.lease, async () => [f.reference]);
    let finish!: (value: (typeof f.reference)[]) => void;
    const pending = f.cache.references(
      { ...f.scope, workspaceId: 'other-workspace' },
      'current',
      f.lease,
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    await Promise.resolve();
    f.cache.invalidateSession('workspace', 'other');
    finish([f.reference]);
    expect((await pending).messages).toEqual([f.reference.text]);
    f.cache.dispose();
  });

  it('reuses workspace references across sessions, pins prefixes and keeps an unchanged refresh stable', async () => {
    const f = fixture();
    let calls = 0;
    const load = async () => {
      calls++;
      return [f.reference];
    };
    const first = await f.cache.references(f.scope, 'one', f.lease, load);
    expect(await f.cache.references(f.scope, 'two', f.lease, load)).toEqual(first);
    expect(calls).toBe(1);
    f.advance(101);
    f.cache.sweep();
    expect(calls).toBe(1);
    await f.cache.references(f.scope, 'one', f.lease, load);
    expect(calls).toBe(2);
    expect(await f.cache.references(f.scope, 'one', f.lease, load)).toEqual(first);
    expect(first.messages).toEqual(['Check compatibility']);
    f.cache.dispose();
  });

  it('new sessions see refreshed references while an existing session retains a bounded prefix', async () => {
    const f = fixture();
    let text = 'first';
    const load = async () => [{ ...f.reference, text }];
    const old = await f.cache.references(f.scope, 'one', f.lease, load);
    text = 'second';
    f.advance(101);
    f.cache.sweep();
    expect(await f.cache.references(f.scope, 'one', f.lease, load)).toEqual(old);
    expect((await f.cache.references(f.scope, 'two', f.lease, load)).messages).toEqual(['second']);
    f.advance(501);
    expect((await f.cache.references(f.scope, 'one', f.lease, load)).messages).toEqual(['second']);
    f.cache.dispose();
  });

  it('isolates authorization views and excludes the current session without deduplicating equal text', async () => {
    const f = fixture();
    const load = async () => [f.reference, { ...f.reference, id: 'another' }];
    expect((await f.cache.references(f.scope, 'other', f.lease, load)).messages).toEqual([]);
    expect((await f.cache.references(f.scope, 'new', f.lease, load)).messages).toHaveLength(2);
    expect(
      (
        await f.cache.references(
          { ...f.scope, authorizationView: 'restricted' },
          'new',
          f.lease,
          async () => []
        )
      ).messages
    ).toEqual([]);
    f.cache.dispose();
  });

  it('does not publish a late build after invalidation or authorization loss', async () => {
    const f = fixture();
    let finish!: (value: (typeof f.reference)[]) => void;
    const pending = f.cache.references(
      f.scope,
      'one',
      f.lease,
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    await Promise.resolve();
    f.cache.invalidateWorkspace('workspace');
    finish([f.reference]);
    expect((await pending).messages).toEqual([]);
    let authorized = true;
    const lease = { expiresAt: 2_000, valid: () => authorized };
    const revoked = f.cache.references(f.scope, 'one', lease, async () => {
      authorized = false;
      return [f.reference];
    });
    expect((await revoked).messages).toEqual([]);
    f.cache.dispose();
  });

  it('does not read history during maintenance and preserves idle material until TTL', async () => {
    const f = fixture();
    let active = true;
    let calls = 0;
    await f.cache.references(
      f.scope,
      'one',
      { expiresAt: 1_300, valid: () => active },
      async () => {
        calls++;
        return [f.reference];
      }
    );
    f.advance(101);
    active = false;
    f.cache.sweep();
    expect(calls).toBe(1);
    expect(f.cache.statistics().scopes).toBe(1);
    active = true;
    f.advance(201);
    f.cache.sweep();
    expect(calls).toBe(1);
    expect(f.cache.statistics().scopes).toBe(1);
    f.advance(200);
    f.cache.sweep();
    expect(f.cache.statistics().scopes).toBe(0);
    f.cache.dispose();
  });

  it('renews retention on manual usage without renewing failed reference freshness', async () => {
    const f = fixture();
    await f.cache.references(f.scope, null, f.lease, async () => [f.reference]);
    f.advance(400);
    const cached = await f.cache.references(f.scope, null, f.lease, async () => {
      throw new Error('read failed');
    });
    expect(cached.messages).toEqual([f.reference.text]);
    f.cache.sweep();
    f.advance(101);
    f.cache.sweep();
    expect(f.cache.statistics().scopes).toBe(1);
    expect(
      (
        await f.cache.references(f.scope, null, f.lease, async () => {
          throw new Error('read failed');
        })
      ).messages
    ).toEqual([]);
    f.advance(501);
    f.cache.sweep();
    expect(f.cache.statistics().scopes).toBe(0);
    f.cache.dispose();
  });

  it('refreshes reference content only on manual usage after its refresh interval', async () => {
    const f = fixture();
    const first = await f.cache.references(f.scope, null, f.lease, async () => [f.reference]);
    f.advance(400);
    await f.cache.references(f.scope, null, f.lease, async () => [f.reference]);
    f.advance(400);
    f.cache.sweep();
    expect(f.cache.statistics().scopes).toBe(1);
    const second = await f.cache.references(f.scope, null, f.lease, async () => [f.reference]);
    expect(second.epoch).toBe(first.epoch);
    f.cache.dispose();
  });

  it('merges session messages by identity, preserves append-only blocks and replaces edited history', () => {
    const f = fixture();
    const message = { id: 'one', revision: 1, role: 'user' as const, text: 'first' };
    const first = f.cache.session(f.scope, 'session', 'branch', [message]);
    const second = f.cache.session(f.scope, 'session', 'branch', [
      message,
      { ...message, id: 'two' }
    ]);
    expect(second[0]).toBe(first[0]);
    expect(second).toHaveLength(2);
    const edited = f.cache.session(f.scope, 'session', 'branch', [
      { ...message, revision: 2, text: 'edited' }
    ]);
    expect(edited).toEqual([{ ...message, revision: 2, text: 'edited' }]);
    expect(f.cache.session(f.scope, 'session', 'new-branch', [])).toEqual([]);
    f.cache.dispose();
  });

  it('bounds all views together and reclaims expired scopes', async () => {
    const f = fixture();
    for (let index = 0; index < 50; index++) {
      await f.cache.references(
        { ...f.scope, authorizationView: String(index) },
        'session',
        f.lease,
        async () => [f.reference]
      );
    }
    expect(f.cache.statistics().scopes).toBeLessThanOrEqual(32);
    expect(f.cache.statistics().bytes).toBeLessThanOrEqual(32 * 1024 * 1024);
    f.advance(16 * 60_000);
    f.cache.sweep();
    expect(f.cache.statistics()).toEqual({ scopes: 0, bytes: 0 });
    f.cache.dispose();
  });
});

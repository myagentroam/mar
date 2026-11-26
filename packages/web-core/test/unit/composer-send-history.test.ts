import { describe, expect, it, vi } from 'vitest';
import { createComposerSendHistory } from '../../src/service/composer-send-history-service.js';

const target = { nodeId: 'node', workspaceId: 'workspace', sessionId: 'session' };
const month = 30 * 24 * 60 * 60 * 1000;

function storage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key)
  };
}

function fixture() {
  const local = storage();
  let now = 100;
  const history = createComposerSendHistory({
    canUseNode: (nodeId) => nodeId !== 'organization',
    now: () => now
  });
  history.bindStorage(local);
  const send = (id: string, body: string, scope = target) => {
    const accept = history.captureSubmission(scope.nodeId);
    now += 1;
    accept?.(scope, id, body);
  };
  return { local, history, send, advance: (amount: number) => (now += amount) };
}

describe('Composer send history', () => {
  it('navigates only the requested session, without wrapping or restoring drafts', () => {
    const { history, send } = fixture();
    send('1', 'oldest');
    send('2', 'newest');
    send('2', 'duplicate acknowledgement');
    send('3', 'another session', { ...target, sessionId: 'other' });
    send('4', 'another workspace', { ...target, workspaceId: 'other' });
    send('5', 'another node', { ...target, nodeId: 'other' });
    const main = history.createNavigation();
    const aside = history.createNavigation();
    const replace = vi.fn(() => true);

    expect(main.recall(target, 'newer', replace)).toBe(false);
    expect(main.recall(target, 'older', replace)).toBe(true);
    expect(main.recall(target, 'older', replace)).toBe(true);
    expect(main.recall(target, 'older', replace)).toBe(false);
    expect(main.recall(target, 'newer', replace)).toBe(true);
    expect(main.recall(target, 'newer', replace)).toBe(false);
    expect(aside.recall(target, 'older', replace)).toBe(true);
    expect(replace.mock.calls).toEqual([['newest'], ['oldest'], ['newest'], ['newest']]);
  });

  it('does not move or renew an entry when the editor rejects replacement', () => {
    const { history, send, advance } = fixture();
    send('1', 'only entry');
    advance(month - 1);
    const navigation = history.createNavigation();
    expect(navigation.recall(target, 'older', () => false)).toBe(false);
    advance(1);
    expect(navigation.recall(target, 'older', () => true)).toBe(false);
  });

  it('renews only entries actually recalled and evicts least-recently-used entries', () => {
    const { history, send, advance } = fixture();
    for (let index = 0; index < 30; index++) send(String(index), `body ${index}`);
    const navigation = history.createNavigation();
    const replace = vi.fn(() => true);
    advance(100);
    while (navigation.recall(target, 'older', replace)) advance(1);
    send('30', 'body 30');
    replace.mockClear();
    navigation.reset();
    while (navigation.recall(target, 'older', replace)) advance(1);
    const bodies = replace.mock.calls.flat();
    expect(bodies).toHaveLength(30);
    expect(bodies).toContain('body 0');
    expect(bodies).not.toContain('body 29');

    advance(month - 1);
    const expired = history.createNavigation();
    expect(expired.recall(target, 'older', replace)).toBe(false);
  });

  it('bounds storage by account, skips oversized bodies, and invalidates old account writes', () => {
    const { history, local, send } = fixture();
    const body = '字'.repeat(5000);
    for (let index = 0; index < 75; index++)
      send(String(index), body, { ...target, sessionId: String(index) });
    expect(
      new TextEncoder().encode([...local.map.values()].join('')).byteLength
    ).toBeLessThanOrEqual(1024 * 1024);
    send('big', body + body);
    expect(history.createNavigation().recall(target, 'older', () => true)).toBe(false);

    const pending = history.captureSubmission(target.nodeId);
    expect(history.captureSubmission('organization')).toBeUndefined();
    history.clearAccount();
    const next = storage();
    history.bindStorage(next);
    pending?.(target, 'late', 'not in either account');
    expect([...local.map.values()].join('')).not.toContain(body);
    expect(next.map.size).toBe(0);
  });

  it('invalidates other tabs and their pending receipts when the account history is cleared', () => {
    const { history, local, send } = fixture();
    const otherTab = createComposerSendHistory({ canUseNode: () => true });
    otherTab.bindStorage(local);
    const pending = otherTab.captureSubmission(target.nodeId)!;
    send('first', 'before sign-out');

    history.clearAccount();
    pending(target, 'late', 'late from another tab');

    expect([...local.map.values()].join('')).not.toContain('late from another tab');
    expect(otherTab.captureSubmission(target.nodeId)).toBeUndefined();

    history.bindStorage(local);
    send('fresh', 'after signing in again');
    expect(otherTab.createNavigation().recall(target, 'older', () => true)).toBe(false);
    otherTab.clearAccount();
    const replace = vi.fn(() => true);
    expect(history.createNavigation().recall(target, 'older', replace)).toBe(true);
    expect(replace).toHaveBeenCalledExactlyOnceWith('after signing in again');
  });

  it('keeps fresh history when a stale write overlaps account clearing', () => {
    const { history, local, send } = fixture();
    const otherTab = createComposerSendHistory({ canUseNode: () => true });
    otherTab.bindStorage({
      ...local,
      setItem(key, value) {
        history.clearAccount();
        history.bindStorage(local);
        send('fresh', 'fresh history');
        local.setItem(key, value);
      }
    });
    otherTab.captureSubmission(target.nodeId)!(target, 'stale', 'stale history');

    expect([...local.map.values()].join('')).not.toContain('stale history');
    const replace = vi.fn(() => true);
    expect(history.createNavigation().recall(target, 'older', replace)).toBe(true);
    expect(replace).toHaveBeenCalledExactlyOnceWith('fresh history');
  });

  it('keeps history and submission usable when browser storage is unavailable', () => {
    const { history } = fixture();
    const blocked = () => {
      throw new Error('storage unavailable');
    };
    history.bindStorage({ getItem: blocked, setItem: blocked, removeItem: blocked });
    const accept = history.captureSubmission(target.nodeId);
    expect(accept).toBeUndefined();
    expect(history.createNavigation().recall(target, 'older', () => true)).toBe(false);
    expect(() => history.clearAccount()).not.toThrow();

    history.bindStorage({ getItem: () => null, setItem: blocked, removeItem: blocked });
    const receipt = history.captureSubmission(target.nodeId)!;
    expect(() => receipt(target, '1', 'body')).not.toThrow();
    expect(() => history.clearAccount()).not.toThrow();
  });
});

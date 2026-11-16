import { describe, expect, it } from 'vitest';
import { createAccountStorage } from '../../src/service/account-storage-service.js';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, String(value));
  }
}

describe('account-scoped browser storage', () => {
  it('keeps each handle bound to its user and exposes only logical keys', () => {
    const browserStorage = new MemoryStorage();
    const alice = createAccountStorage(browserStorage, 17);
    const bob = createAccountStorage(browserStorage, 29);

    alice.setItem('composer', 'alice-draft');
    alice.setItem('selection', 'alice-workspace');
    bob.setItem('composer', 'bob-draft');

    expect(alice.physicalKey('composer')).toBe('mar.account.v1.17.composer');
    expect(bob.physicalKey('composer')).toBe('mar.account.v1.29.composer');
    expect(alice.getItem('composer')).toBe('alice-draft');
    expect(bob.getItem('composer')).toBe('bob-draft');
    expect(alice.length).toBe(2);
    expect([alice.key(0), alice.key(1), alice.key(2)]).toEqual(['composer', 'selection', null]);
  });

  it('clears only the selected user prefix and preserves unrelated storage', () => {
    const browserStorage = new MemoryStorage();
    const alice = createAccountStorage(browserStorage, 17);
    const bob = createAccountStorage(browserStorage, 29);
    browserStorage.setItem('unrelated.preference', 'keep');
    alice.setItem('composer', 'alice-draft');
    bob.setItem('composer', 'bob-draft');

    alice.clear();

    expect(alice.length).toBe(0);
    expect(bob.getItem('composer')).toBe('bob-draft');
    expect(browserStorage.getItem('unrelated.preference')).toBe('keep');
  });
});

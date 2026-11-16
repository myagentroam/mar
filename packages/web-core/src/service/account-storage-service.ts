import type { InjectionKey, Ref } from 'vue';

export const ACCOUNT_STORAGE_KEY: InjectionKey<Readonly<Ref<AccountStorage>>> =
  Symbol('account-storage');

/** Maps logical domain keys into one confirmed account's browser storage.
 * Handles are immutable: domain owners bind a new handle only after clearing old state.
 * Serialization, retention, cancellation and authentication remain with their owners.
 */
export interface AccountStorage extends Storage {
  physicalKey(key: string): string;
}

export function createAccountStorage(storage: Storage, userId: number): AccountStorage {
  const prefix = `mar.account.v1.${userId}.`;
  const physicalKey = (key: string) => `${prefix}${key}`;
  const keys = () => {
    const result: string[] = [];
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (key?.startsWith(prefix)) result.push(key.slice(prefix.length));
    }
    return result;
  };
  return {
    physicalKey,
    get length() {
      return keys().length;
    },
    key: (index) => keys()[index] ?? null,
    getItem: (key) => storage.getItem(physicalKey(key)),
    setItem: (key, value) => storage.setItem(physicalKey(key), value),
    removeItem: (key) => storage.removeItem(physicalKey(key)),
    clear: () => {
      for (const key of keys()) storage.removeItem(physicalKey(key));
    }
  };
}

/** No business persistence is available before the Server confirms an account. */
export const unboundAccountStorage: AccountStorage = {
  length: 0,
  physicalKey: (key) => key,
  key: () => null,
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
  clear: () => {}
};

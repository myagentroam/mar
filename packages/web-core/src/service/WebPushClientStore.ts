import type { WebPushBinding, WebPushRegistration } from '@myagentroam/protocol';

export interface BrowserPushClient {
  readonly account: string;
  readonly request: WebPushRegistration;
  readonly binding?: WebPushBinding;
}
export interface PushDisplayBinding extends WebPushBinding {
  readonly account: string;
}
export interface WebPushClientStore {
  read(): Promise<BrowserPushClient | undefined>;
  write(client: BrowserPushClient): Promise<void>;
  display(binding: PushDisplayBinding | undefined): Promise<void>;
  locked<T>(action: () => Promise<T>): Promise<T>;
}

// The Worker reads only `display`; registration credentials never enter its payloads.
export function createWebPushClientStore(): WebPushClientStore {
  let opening: Promise<IDBDatabase> | undefined;
  function open(): Promise<IDBDatabase> {
    opening ??= new Promise((resolve, reject) => {
      const request = indexedDB.open('mar.web-push.v1', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('bindings');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('WEB_PUSH_STORAGE_UNAVAILABLE'));
    });
    return opening;
  }
  async function write(key: string, value: unknown): Promise<void> {
    const database = await open();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('bindings', 'readwrite');
      const store = transaction.objectStore('bindings');
      if (value === undefined) store.delete(key);
      else store.put(value, key);
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
  }
  return {
    async read() {
      const database = await open();
      return new Promise((resolve, reject) => {
        const request = database.transaction('bindings').objectStore('bindings').get('client');
        request.onsuccess = () => resolve(request.result as BrowserPushClient | undefined);
        request.onerror = () => reject(request.error);
      });
    },
    write: (client) => write('client', client),
    display: (binding) => write('display', binding),
    locked: async (action) => await navigator.locks.request('mar.web-push.v1', action)
  };
}

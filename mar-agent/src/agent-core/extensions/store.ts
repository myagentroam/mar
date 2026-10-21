import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { MarAgentError } from '../error.js';
import { acquireFileLock } from '../storage/file-lock.js';
import {
  cloneCoreJson,
  type CoreJsonValue,
  type CoreStoreApi,
  type CoreStoreCommit
} from './data.js';

interface StoreDocument {
  revision: number;
  values: Record<string, CoreJsonValue>;
}
type StoreRun = <T>(operation: (signal: AbortSignal) => Promise<T>) => Promise<T>;

/** One application-bound installation namespace, independent from Session JSONL or Code Mode state. */
export class ExtensionStore {
  readonly #path: string;
  constructor(readonly directory: string) {
    if (typeof directory !== 'string' || !isAbsolute(directory))
      throw new MarAgentError(
        'MAR_AGENT_EXTENSION_STORE_INVALID',
        'Extension store requires an absolute data directory.'
      );
    this.#path = join(directory, 'core-store.json');
  }

  bind(run: StoreRun): CoreStoreApi {
    const commit = (input: CoreStoreCommit) => run((signal) => this.#commit(input, signal));
    return {
      get: ({ key }) =>
        run(async (signal) => {
          validateKey(key);
          const document = await this.#read(signal);
          const value = Object.hasOwn(document.values, key) ? document.values[key] : undefined;
          return {
            revision: document.revision,
            ...(value === undefined ? {} : { value: cloneCoreJson(value) })
          };
        }),
      keys: () =>
        run(async (signal) => {
          const document = await this.#read(signal);
          return { revision: document.revision, keys: Object.keys(document.values).sort() };
        }),
      set: async ({ key, value, expectedRevision }) => {
        const copied = cloneCoreJson(value);
        const result = await commit({
          writes: [{ key, value: copied }],
          ...(expectedRevision === undefined ? {} : { expectedRevision })
        });
        return { revision: result.revision, value: copied };
      },
      delete: ({ key, expectedRevision }) =>
        commit({
          writes: [{ key }],
          ...(expectedRevision === undefined ? {} : { expectedRevision })
        }),
      commit
    };
  }

  async #read(signal: AbortSignal): Promise<StoreDocument> {
    signal.throwIfAborted();
    let text: string;
    try {
      text = await readFile(this.#path, { encoding: 'utf8', signal });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { revision: 0, values: {} };
      throw error;
    }
    signal.throwIfAborted();
    try {
      const value = JSON.parse(text) as StoreDocument;
      if (
        !value ||
        !Number.isSafeInteger(value.revision) ||
        value.revision < 0 ||
        !value.values ||
        typeof value.values !== 'object' ||
        Array.isArray(value.values)
      )
        throw new Error();
      const values = cloneCoreJson(value.values) as Record<string, CoreJsonValue>;
      return { revision: value.revision, values };
    } catch {
      throw new MarAgentError(
        'MAR_AGENT_EXTENSION_STORE_CORRUPT',
        'Extension store document is invalid.'
      );
    }
  }

  async #commit(input: CoreStoreCommit, signal: AbortSignal): Promise<{ revision: number }> {
    if (
      !input ||
      !Array.isArray(input.writes) ||
      (input.expectedRevision !== undefined &&
        (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0))
    )
      throw new MarAgentError(
        'MAR_AGENT_EXTENSION_STORE_INVALID',
        'Store mutation or expected revision is invalid.'
      );
    const writes = input.writes.map((write) => {
      if (!write || typeof write !== 'object')
        throw new MarAgentError('MAR_AGENT_EXTENSION_STORE_INVALID', 'Store mutation is invalid.');
      const { key, value } = write;
      validateKey(key);
      return { key, ...(value === undefined ? {} : { value: cloneCoreJson(value) }) };
    });
    signal.throwIfAborted();
    await mkdir(this.directory, { recursive: true });
    const release = await acquireFileLock(
      join(this.directory, 'core-store.lock'),
      'Extension store is busy.',
      5000,
      { signal, code: 'MAR_AGENT_EXTENSION_STORE_LOCKED' }
    );
    const temporary = join(this.directory, `.core-store-${randomUUID()}.tmp`);
    try {
      const document = await this.#read(signal);
      if (input.expectedRevision !== undefined && document.revision !== input.expectedRevision)
        throw new MarAgentError(
          'MAR_AGENT_EXTENSION_STORE_CONFLICT',
          'Store revision changed before commit.'
        );
      const values: Record<string, CoreJsonValue> = Object.assign(
        Object.create(null),
        document.values
      );
      for (const { key, value } of writes)
        if (value === undefined) delete values[key];
        else values[key] = value;
      const revision = document.revision + 1;
      if (!Number.isSafeInteger(revision))
        throw new MarAgentError(
          'MAR_AGENT_EXTENSION_STORE_INVALID',
          'Store revision is exhausted.'
        );
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify({ revision, values }));
        await handle.sync();
      } finally {
        await handle.close();
      }
      signal.throwIfAborted();
      await rename(temporary, this.#path);
      return { revision };
    } finally {
      try {
        await rm(temporary, { force: true });
      } finally {
        await release();
      }
    }
  }
}

function validateKey(key: string): void {
  if (typeof key !== 'string')
    throw new MarAgentError('MAR_AGENT_EXTENSION_STORE_INVALID', 'Store key must be a string.');
}

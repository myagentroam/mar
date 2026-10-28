import { describe, expect, it, vi } from 'vitest';
import { createCodexCatalogInteractionService } from '../../src/service/codex-catalog-interaction-service.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('credential catalog interaction', () => {
  it('does not load or install a catalog after selection changes during preparation', async () => {
    const preparation = deferred<void>();
    const loadCatalog = vi.fn();
    const service = createCodexCatalogInteractionService({
      loadCatalog,
      importModels: vi.fn()
    });
    const pending = service.open('credential-1', () => preparation.promise);
    service.reset();
    preparation.resolve();
    await expect(pending).resolves.toBeUndefined();
    expect(loadCatalog).not.toHaveBeenCalled();
    expect(service.catalog.value).toBeUndefined();
    expect(service.loading.value).toBe(false);
  });

  it('does not accept an import response or failure after the dialog closes', async () => {
    const request = deferred<never>();
    const accept = vi.fn(async () => undefined);
    const service = createCodexCatalogInteractionService({
      loadCatalog: vi.fn(),
      importModels: () => request.promise
    });
    const pending = service.importModels(
      service.currentRevision(),
      'credential-1',
      {} as never,
      accept
    );
    expect(service.importing.value).toBe(true);
    service.reset();
    request.reject(new Error('late failure'));
    await expect(pending).resolves.toBeUndefined();
    expect(accept).not.toHaveBeenCalled();
    expect(service.importing.value).toBe(false);
  });

  it('keeps the import busy through acceptance and clears sensitive catalog state on disposal', async () => {
    const acceptance = deferred<void>();
    const service = createCodexCatalogInteractionService({
      loadCatalog: vi.fn(async () => ({ models: [] }) as never),
      importModels: vi.fn(async () => ({ items: [] }) as never)
    });
    await service.open('credential-1', async () => undefined);
    const pending = service.importModels(
      service.currentRevision(),
      'credential-1',
      {} as never,
      () => acceptance.promise
    );
    await Promise.resolve();
    expect(service.importing.value).toBe(true);
    service.dispose();
    expect(service.catalog.value).toBeUndefined();
    expect(service.importing.value).toBe(false);
    acceptance.resolve();
    await pending;
  });
});

import { describe, expect, it, vi } from 'vitest';
import { createHtmlPreviewService } from '../../src/service/html-preview-service.js';
import { ApiError } from '../../src/util/api-error.js';

describe('HTML preview grants', () => {
  it('ignores replaced and released requests, and supports retry after failure', async () => {
    const pending: Array<{
      resolve: (value: { url: string }) => void;
      reject: (error: Error) => void;
      signal: AbortSignal;
    }> = [];
    const request = vi.fn(
      (_path: string, init?: RequestInit) =>
        new Promise<{ url: string }>((resolve, reject) => {
          pending.push({ resolve, reject, signal: init!.signal as AbortSignal });
        })
    );
    const service = createHtmlPreviewService({ request } as never);
    const target = { nodeId: 'n', workspaceId: 'w', path: 'a.html' };
    const first = service.open(target);
    const second = service.open({ ...target, path: 'b.html' });
    expect(pending[0]!.signal.aborted).toBe(true);
    pending[1]!.resolve({ url: 'https://example.test/b' });
    await second;
    pending[0]!.resolve({ url: 'https://example.test/a' });
    await first;
    expect(service.state.value.url).toBe('https://example.test/b');
    const failure = service.open(target);
    expect(service.state.value.url).toBeUndefined();
    const missing = new ApiError(
      'FILE_NOT_FOUND',
      'File not found.',
      {},
      'Missing HTML document.',
      'preview-request',
      'node-request'
    );
    pending[2]!.reject(missing);
    await failure;
    expect(service.state.value.error).toBe(missing);
    const retry = service.open(target);
    expect(service.state.value.error).toBeUndefined();
    pending[3]!.resolve({ url: 'https://example.test/retry' });
    await retry;
    expect(service.state.value.url).toBe('https://example.test/retry');
    const late = service.open(target);
    service.release();
    expect(pending[4]!.signal.aborted).toBe(true);
    pending[4]!.resolve({ url: 'https://example.test/late' });
    await late;
    expect(service.state.value.url).toBeUndefined();
    expect(service.state.value.error).toBeUndefined();
  });
});

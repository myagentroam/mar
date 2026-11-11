import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, provide, ref } from 'vue';
import { createHtmlPreviewService } from '../../src/service/html-preview-service.js';
import {
  createWorkbenchHttpService,
  WORKBENCH_HTTP_KEY
} from '../../src/service/workbench-http-service.js';
import Browser from '../../src/view/workspace/WorkspaceHtmlBrowser.vue?unit-render';
import { ApiError } from '../../src/util/api-error.js';
import { flushComponent, renderComponent, trigger } from './support/component-renderer.js';

afterEach(() => vi.unstubAllGlobals());

describe('HTML preview grants', () => {
  it.each(['NETWORK_UNAVAILABLE', 'PERMISSION_DENIED'])(
    'uses the shared HTTP owner for %s and recovers on reload',
    async (code) => {
      const http = createWorkbenchHttpService({
        csrfToken: ref('owner-token'),
        csrfStorageKey: 'fixture-csrf',
        onUnauthenticated: vi.fn()
      });
      const fetch = vi.fn<typeof globalThis.fetch>();
      if (code === 'NETWORK_UNAVAILABLE')
        fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      else fetch.mockResolvedValueOnce(Response.json({ error: code }, { status: 403 }));
      fetch.mockResolvedValueOnce(Response.json({ url: '/fixture/recovered.html' }));
      vi.stubGlobal('fetch', fetch);
      const renewCsrfToken = vi.fn(async () => 'fallback-token');
      const view = renderComponent(
        defineComponent({
          setup() {
            provide(WORKBENCH_HTTP_KEY, http);
            return () =>
              h(Browser, {
                nodeId: 'node',
                workspaceId: 'workspace',
                path: 'index.html',
                csrfToken: 'fallback-token',
                renewCsrfToken
              });
          }
        })
      );
      try {
        await flushComponent();
        expect(http.networkUnavailable.value).toBe(code === 'NETWORK_UNAVAILABLE');
        expect(view.findAll('p').some((node) => node.props.role === 'alert')).toBe(true);
        expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ 'x-csrf-token': 'owner-token' });
        expect(renewCsrfToken).not.toHaveBeenCalled();
        await trigger(view.findAll('ElButton')[0]!, 'onClick');
        await flushComponent();
        expect(http.networkUnavailable.value).toBe(false);
        expect(view.findAll('p').some((node) => node.props.role === 'alert')).toBe(false);
        expect(view.findAll('iframe')[0]?.props.src).toBe('/fixture/recovered.html');
      } finally {
        view.unmount();
      }
    }
  );
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

import { shallowRef } from 'vue';
import type { ScopedHttpService } from './scoped-http-service.js';

export interface HtmlPreviewTarget {
  readonly nodeId: string;
  readonly workspaceId: string;
  readonly path: string;
}

export interface HtmlPreviewState {
  readonly url?: string | undefined;
  readonly loading: boolean;
  readonly error: boolean;
}

export function createHtmlPreviewService(http: Pick<ScopedHttpService, 'request'>) {
  const state = shallowRef<HtmlPreviewState>({ loading: false, error: false });
  let controller: AbortController | undefined;

  function release(): void {
    controller?.abort();
    controller = undefined;
    state.value = { loading: false, error: false };
  }

  async function open(target: HtmlPreviewTarget): Promise<void> {
    controller?.abort();
    const request = new AbortController();
    controller = request;
    state.value = { loading: true, error: false };
    try {
      const result = await http.request<{ readonly url: string }>('/api/html-preview/grants', {
        method: 'POST',
        body: JSON.stringify(target),
        signal: request.signal
      });
      if (controller === request) state.value = { loading: false, error: false, url: result.url };
    } catch {
      if (controller === request) state.value = { loading: false, error: true };
    }
  }

  return { state, open, release };
}

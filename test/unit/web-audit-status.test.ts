import { afterEach, describe, expect, it, vi } from 'vitest';
import AuditManagementPage from '../../ee/web/src/view/settings/AuditManagementPage.vue?unit-render';
import {
  flushComponent,
  renderComponent,
  textContent
} from '../../packages/web-core/test/unit/support/component-renderer.js';

afterEach(() => vi.unstubAllGlobals());

describe('audit result presentation', () => {
  it('keeps success neutral and distinguishes denied and failed results in the list and details', async () => {
    vi.stubGlobal('window', {
      location: { href: 'http://localhost/console', search: '' },
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
    });
    const events = ['SUCCESS', 'DENIED', 'FAILED'].map((result, index) => ({
      id: String(index),
      result,
      eventType: 'login.succeeded',
      occurredAt: 1,
      authenticationMethod: 'password',
      errorCode: result === 'FAILED' ? 'TEST_FAILED' : null
    }));
    const request = vi.fn(async (path: string) =>
      path.includes('?')
        ? { events, total: events.length, page: 1 }
        : events.find((event) => path.endsWith('/' + event.id))
    );
    const view = renderComponent(AuditManagementPage, { request });
    try {
      await flushComponent();
      expect(view.findAll('ElTag').map((tag) => tag.props['type'])).toEqual([
        'info',
        'warning',
        'danger'
      ]);
      const table = view.findAll('ElTable')[0]!;
      const open = table.props['onRowClick'] as (row: unknown) => Promise<void>;
      for (const [index, type] of ['info', 'warning', 'danger'].entries()) {
        await open(events[index]);
        await flushComponent();
        expect(view.findAll('ElTag').at(-1)?.props['type']).toBe(type);
      }
      expect(textContent(view.findAll('ElDialog')[0]!)).toContain('TEST_FAILED');
    } finally {
      view.unmount();
    }
  });
});

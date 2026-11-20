import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it } from 'vitest';
import { MarButton } from '@myagentroam/mar-ui/button';
import { marIcon } from '@myagentroam/mar-ui/icons';

describe('MarButton', () => {
  it('uses the explicit disabled state without a form library', async () => {
    const html = await renderToString(
      createSSRApp(() =>
        h('form', [
          h(MarButton, { id: 'disabled', disabled: true }, () => 'Save'),
          h(MarButton, { id: 'enabled' }, () => 'Cancel')
        ])
      )
    );
    expect(html.match(/<button[^>]+\bid="disabled"[^>]*>/u)?.[0]).toMatch(/\sdisabled(?=\s|>)/u);
    expect(html.match(/<button[^>]+\bid="enabled"[^>]*>/u)?.[0]).not.toMatch(/\sdisabled(?=\s|>)/u);
  });
  it('renders a non-submit button with a decorative MAR icon and visible label', async () => {
    const html = await renderToString(
      createSSRApp(() => h(MarButton, { icon: marIcon('check') }, () => 'Save'))
    );
    expect(html).toMatch(/^<button\b[^>]*\btype="button"/u);
    expect(html).toContain('data-mar-icon="check"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('>Save<');
  });

  it('preserves native submit attributes and the accessible name while busy', async () => {
    const html = await renderToString(
      createSSRApp(() =>
        h(MarButton, {
          type: 'primary',
          nativeType: 'submit',
          form: 'settings',
          icon: marIcon('check'),
          loading: true,
          'aria-label': 'Save settings'
        })
      )
    );
    expect(html).toMatch(/^<button\b[^>]*\btype="submit"/u);
    expect(html).toContain('mar-ui-button--primary');
    expect(html).toContain('form="settings"');
    expect(html).toContain('aria-label="Save settings"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toMatch(/^<button\b[^>]*\sdisabled(?=\s|>)/u);
    expect(html).toContain('data-mar-icon="loading-action"');
    expect(html).not.toContain('data-mar-icon="check"');
  });

  it.each(['refresh', marIcon('refresh')] as const)(
    'accepts a loading icon name or legacy icon component',
    async (loadingIcon) => {
      const html = await renderToString(
        createSSRApp(() => h(MarButton, { loading: true, loadingIcon }, () => 'Save'))
      );
      expect(html).toContain('data-mar-icon="refresh"');
      expect(html).not.toContain('data-mar-icon="loading-action"');
    }
  );
});

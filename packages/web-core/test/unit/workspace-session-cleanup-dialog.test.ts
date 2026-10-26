import { afterEach, describe, expect, it } from 'vitest';
import CleanupDialog from '../../src/view/workspace/WorkspaceSessionCleanupDialog.vue?unit-render';
import { localePreferenceService } from '../../src/service/locale-preference-service.js';
import {
  flushComponent,
  renderComponent,
  textContent,
  trigger
} from './support/component-renderer.js';

const originalLocale = localePreferenceService().locale.value;
afterEach(() => localePreferenceService().setLocale(originalLocale));

describe('Workspace cleanup partial result presentation', () => {
  it.each(['en-US', 'zh-CN'] as const)(
    'shows settled counts and an explicit time-budget result (%s)',
    async (locale) => {
      localePreferenceService().setLocale(locale);
      const view = renderComponent(CleanupDialog, {
        modelValue: true,
        cleanup: async () => ({
          deleted: 2,
          skipped: 1,
          failed: 0,
          deletedByRunner: { codex: 2 },
          timedOut: true,
          remaining: 7
        })
      });
      try {
        const submit = view.findAll('ElButton').find((button) => button.props.type === 'danger')!;
        await trigger(submit, 'onClick');
        await flushComponent();
        const text = textContent(view.root);
        expect(text).toContain(
          locale === 'en-US' ? 'Cleanup partially complete' : '已完成部分清理'
        );
        expect(text).toContain(locale === 'en-US' ? 'Not processed7' : '待处理7');
        expect(text).toContain(locale === 'en-US' ? 'Run cleanup again' : '可再次发起清理');
        expect(text).toContain('Codex 2');
        expect(view.findAll('h3').map(textContent)).not.toContain(
          locale === 'en-US' ? 'Cleanup complete' : '清理完成'
        );
      } finally {
        view.unmount();
      }
    }
  );
});

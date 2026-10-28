import { describe, expect, it, vi } from 'vitest';
import { defineComponent, h, provide, ref } from 'vue';
import WorkbenchSurface from '../../src/view/workbench/WorkbenchSurface.vue?unit-render';
import {
  createManagementComposition,
  MANAGEMENT_COMPOSITION_KEY
} from '../../src/service/management-composition.js';
import { renderComponent, textContent } from './support/component-renderer.js';

vi.mock('../../src/service/mobile-surface-focus-service.js', () => ({
  createMobileSurfaceFocusService: () => ({ dispose: vi.fn() })
}));

vi.mock('../../src/view/workbench/WorkbenchHeader.vue?unit-render', () => ({
  default: { render: () => null }
}));

describe('Workbench surface host slots', () => {
  it.each(['settings', 'management'])(
    'renders host contributions only in the active %s surface',
    (view) => {
      const page = {
        view,
        managementSection: 'system',
        admin: { authenticated: true },
        workspaceRegistrationNodeId: 'node-a',
        setComposerInputFocus: vi.fn(),
        setComposerRangeEditor: vi.fn(),
        hostedConversationWorkspace: {
          snapshot: ref(),
          conversations: ref([]),
          selectedNodeId: ref(),
          selectedConversationId: ref()
        }
      };
      const composition = createManagementComposition([
        {
          id: 'system',
          order: 1,
          labelKey: 'navigation.nodeManagement',
          component: { render: () => h('p', 'Resolved management page') },
          visible: () => true,
          props: () => ({ request: async <T>() => undefined as T })
        }
      ]);
      const rendered = renderComponent(
        defineComponent({
          setup() {
            provide(MANAGEMENT_COMPOSITION_KEY, composition);
            return () =>
              h(
                WorkbenchSurface,
                { page },
                {
                  'workspace-registration': () => h('p', 'Host registration'),
                  settings: () => h('p', 'Host settings'),
                  'management-notice': () => h('p', 'Host management notice')
                }
              );
          }
        })
      );
      try {
        expect(page.setComposerRangeEditor).toHaveBeenCalledOnce();
        const text = textContent(rendered.root);
        expect(text).toContain('Host registration');
        expect(text.includes('Host settings')).toBe(view === 'settings');
        expect(text.includes('Host management notice')).toBe(view === 'management');
        expect(text.includes('Resolved management page')).toBe(view === 'management');
      } finally {
        rendered.unmount();
      }
      expect(page.setComposerRangeEditor).toHaveBeenCalledTimes(2);
    }
  );
});

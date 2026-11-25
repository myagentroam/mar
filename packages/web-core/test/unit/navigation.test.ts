import { afterEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import {
  createWorkbenchNavigationPresentation,
  createWorkbenchNavigationService
} from '../../src/service/workbench-navigation-service.js';
import { transitionMobileWorkbenchLayout } from '../../src/util/mobile-workbench.js';
import type { WorkbenchView } from '../../src/util/workbench-route.js';
import type { SettingsSection } from '../../src/model/settings.js';

afterEach(() => vi.unstubAllGlobals());

function setup(mobile = true) {
  const query = {
    matches: mobile,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  };
  vi.stubGlobal('window', { matchMedia: () => query });
  const service = createWorkbenchNavigationService({
    initialView: 'nodes' as 'nodes' | 'settings' | 'extra',
    initialSettingsSection: 'account' as 'account' | 'appearance',
    initialManagementSection: 'system' as 'system' | 'resources',
    opensMobileSidebar: (view) => view !== 'extra'
  });
  return { service, query };
}

describe('Public Navigation Layout', () => {
  it.each(['nodes', 'conversations'] as const)(
    're-enters mobile %s content from a covering page without toggling its menu',
    (view) => {
      vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) });
      const navigation = createWorkbenchNavigationService<WorkbenchView, SettingsSection, 'system'>(
        {
          initialView: view,
          initialSettingsSection: 'account',
          initialManagementSection: 'system',
          opensMobileSidebar: (next) => next !== 'conversations'
        }
      );
      const transition = vi.fn();
      const presentation = createWorkbenchNavigationPresentation({
        navigation,
        management: { items: () => [] },
        admin: ref({ authenticated: true, mustChangePassword: false }),
        defaultManagement: 'system',
        canOpenWorkspaceSidebar: () => true,
        transition,
        recoverNotifications: vi.fn().mockResolvedValue(undefined),
        layout: { panelWidths: ref({}), setPanelWidth: vi.fn() }
      });

      presentation.selectMobileUtilityPanel('schedules');
      presentation.selectNavigation(view, 'enter-content');
      expect(navigation.view.value).toBe(view);
      expect(navigation.mobileUtilityPanel.value).toBeUndefined();
      expect(navigation.mobileSidebarOpen.value).toBe(false);
      expect(presentation.hostedConversationMobileHistoryOpen.value).toBe(false);
      expect(transition).not.toHaveBeenCalled();

      presentation.selectNavigation(view);
      expect(navigation.mobileSidebarOpen.value).toBe(view === 'nodes');
      expect(presentation.hostedConversationMobileHistoryOpen.value).toBe(view === 'conversations');
    }
  );

  it('keeps utility drawers, navigation and Workspace tools mutually exclusive', () => {
    const { service } = setup();
    service.selectView('settings');
    service.selectMobileUtilityPanel('activity');
    expect(service.mobileSidebarOpen.value).toBe(true);
    expect(service.mobileUtilityPanel.value).toBe('activity');
    service.openMobileWorkspaceSurface('terminal');
    expect(service.mobileUtilityPanel.value).toBeUndefined();
    service.selectMobileUtilityPanel('activity');
    expect(service.mobileWorkspaceSurface.value).toBe('conversation');
    service.selectView('settings');
    expect(service.mobileUtilityPanel.value).toBeUndefined();
    expect(service.mobileSidebarOpen.value).toBe(true);
    service.selectMobileUtilityPanel('activity');
    service.selectMobileUtilityPanel(undefined);
    expect(service.mobileUtilityPanel.value).toBeUndefined();
    expect(service.mobileSidebarOpen.value).toBe(false);
  });

  it('clears utility drawers on breakpoint changes and ignores them on desktop', () => {
    const { service, query } = setup();
    service.start();
    service.selectMobileUtilityPanel('activity');
    const change = query.addEventListener.mock.calls[0]![1] as (event: {
      matches: boolean;
    }) => void;
    change({ matches: true });
    expect(service.mobileUtilityPanel.value).toBe('activity');
    change({ matches: false });
    expect(service.mobileUtilityPanel.value).toBeUndefined();
    service.selectMobileUtilityPanel('activity');
    expect(service.mobileUtilityPanel.value).toBeUndefined();
    service.dispose();
  });

  it('Uses the composed initial state without reading the product URL or enterprise defaults', () => {
    const { service } = setup();
    expect(service.view.value).toBe('nodes');
    expect(service.managementSection.value).toBe('system');
    expect(service.settingsSection.value).toBe('account');
    expect(service.sidebarCollapsed.value).toBe(true);
  });

  it('Resets the mobile surface when switching views and opens the sidebar according to the composed layout', () => {
    const { service } = setup();
    service.mobileWorkspaceSurface.value = 'terminal';
    service.selectView('settings');
    expect(service.mobileWorkspaceSurface.value).toBe('conversation');
    expect(service.mobileSidebarOpen.value).toBe(true);
    service.selectSettings('appearance');
    expect(service.mobileSidebarOpen.value).toBe(false);
    service.selectView('extra');
    expect(service.mobileSidebarOpen.value).toBe(false);
    service.selectView('nodes');
    service.selectManagement('resources');
    expect(service.managementSection.value).toBe('resources');
    expect(service.mobileSidebarOpen.value).toBe(false);
  });

  it('Keeps mobile surfaces mutually exclusive while desktop ignores them and expands navigation', () => {
    const { service } = setup();
    service.mobileSidebarOpen.value = true;
    service.openMobileWorkspaceSurface('terminal');
    expect(service.mobileSidebarOpen.value).toBe(false);
    expect(service.mobileWorkspaceSurface.value).toBe('terminal');
    service.closeMobileWorkspaceSurface();
    service.mobileViewport.value = false;
    service.openMobileWorkspaceSurface('inspector');
    expect(service.mobileWorkspaceSurface.value).toBe('conversation');
    service.selectView('settings');
    expect(service.sidebarCollapsed.value).toBe(false);
  });

  it('Installs breakpoint monitoring once, restarts it after disposal, and preserves the surface at the same breakpoint', () => {
    const { service, query } = setup();
    service.start();
    service.start();
    expect(query.addEventListener).toHaveBeenCalledOnce();
    const onChange = query.addEventListener.mock.calls[0]![1] as (event: {
      matches: boolean;
    }) => void;
    service.mobileWorkspaceSurface.value = 'terminal';
    onChange({ matches: true });
    expect(service.mobileWorkspaceSurface.value).toBe('terminal');
    onChange({ matches: false });
    expect(service.mobileWorkspaceSurface.value).toBe('conversation');
    expect(service.mobileViewport.value).toBe(false);
    service.dispose();
    expect(query.removeEventListener).toHaveBeenCalledWith('change', onChange);
    service.start();
    expect(query.addEventListener).toHaveBeenCalledTimes(2);
    service.dispose();
  });

  it('Preserves the same breakpoint object and force-resets the sidebar and mobile surface', () => {
    const layout = {
      mobileViewport: true,
      sidebarCollapsed: true,
      mobileSidebarOpen: true,
      mobileWorkspaceSurface: 'inspector' as const
    };
    expect(transitionMobileWorkbenchLayout(layout, true)).toBe(layout);
    expect(transitionMobileWorkbenchLayout(layout, true, true)).toEqual({
      ...layout,
      mobileSidebarOpen: false,
      mobileWorkspaceSurface: 'conversation'
    });
  });
});

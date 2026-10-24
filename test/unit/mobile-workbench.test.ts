import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MOBILE_WORKBENCH_VIEWPORT_QUERY,
  transitionMobileWorkbenchLayout
} from '../../ee/web/src/util/mobile-workbench';
import { createWorkbenchNavigationService } from '../../ee/web/src/service/workbench-navigation-service';

describe('Mobile Workbench layout state', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('Uses 767px as the mobile workspace breakpoint', () => {
    expect(MOBILE_WORKBENCH_VIEWPORT_QUERY).toBe('(max-width: 767px)');
  });

  it('Resizing within the mobile breakpoint keeps open tool layers', () => {
    const current = {
      mobileViewport: true,
      sidebarCollapsed: true,
      mobileSidebarOpen: false,
      mobileWorkspaceSurface: 'inspector' as const
    };

    expect(transitionMobileWorkbenchLayout(current, true)).toBe(current);
  });

  it('Crossing the breakpoint restores the collapsed sidebar and Conversation surface', () => {
    expect(
      transitionMobileWorkbenchLayout(
        {
          mobileViewport: false,
          sidebarCollapsed: false,
          mobileSidebarOpen: false,
          mobileWorkspaceSurface: 'terminal'
        },
        true
      )
    ).toEqual({
      mobileViewport: true,
      sidebarCollapsed: true,
      mobileSidebarOpen: false,
      mobileWorkspaceSurface: 'conversation'
    });
  });

  it('Mobile navigation opens only the sidebar while domain services dismiss tool surfaces', () => {
    const query = {
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    } as unknown as MediaQueryList;
    vi.stubGlobal('window', { location: { search: '' }, matchMedia: () => query });
    const navigation = createWorkbenchNavigationService();
    navigation.mobileWorkspaceSurface.value = 'terminal';

    navigation.selectView('settings');

    expect(navigation.view.value).toBe('settings');
    expect(navigation.mobileSidebarOpen.value).toBe(true);
    expect(navigation.mobileWorkspaceSurface.value).toBe('conversation');
  });

  it('Entering standalone chat on mobile closes the navigation sidebar', () => {
    const query = {
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    } as unknown as MediaQueryList;
    vi.stubGlobal('window', { location: { search: '' }, matchMedia: () => query });
    const navigation = createWorkbenchNavigationService();
    navigation.mobileSidebarOpen.value = true;

    navigation.selectView('conversations');

    expect(navigation.view.value).toBe('conversations');
    expect(navigation.mobileSidebarOpen.value).toBe(false);
  });
});

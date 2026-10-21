export const MOBILE_WORKBENCH_VIEWPORT_QUERY = '(max-width: 767px)';

export type MobileWorkspaceSurface = 'conversation' | 'sessions' | 'inspector' | 'terminal';

export interface MobileWorkbenchLayout {
  readonly mobileViewport: boolean;
  readonly sidebarCollapsed: boolean;
  readonly mobileSidebarOpen: boolean;
  readonly mobileWorkspaceSurface: MobileWorkspaceSurface;
}

export function transitionMobileWorkbenchLayout(
  current: MobileWorkbenchLayout,
  nextMobileViewport: boolean,
  force = false
): MobileWorkbenchLayout {
  if (!force && current.mobileViewport === nextMobileViewport) return current;
  return {
    mobileViewport: nextMobileViewport,
    sidebarCollapsed: nextMobileViewport ? true : current.sidebarCollapsed,
    mobileSidebarOpen: false,
    mobileWorkspaceSurface: 'conversation'
  };
}

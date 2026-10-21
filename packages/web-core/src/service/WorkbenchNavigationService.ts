import { ref, type Ref } from 'vue';
import {
  MOBILE_WORKBENCH_VIEWPORT_QUERY,
  transitionMobileWorkbenchLayout,
  type MobileWorkspaceSurface
} from '../util/mobile-workbench.js';

export interface WorkbenchNavigationService<
  WorkbenchView extends string,
  SettingsSection extends string,
  ManagementSection extends string
> {
  readonly view: Ref<WorkbenchView>;
  readonly settingsSection: Ref<SettingsSection>;
  readonly managementSection: Ref<ManagementSection>;
  readonly mobileViewport: Ref<boolean>;
  readonly sidebarCollapsed: Ref<boolean>;
  readonly mobileSidebarOpen: Ref<boolean>;
  readonly mobileWorkspaceSurface: Ref<MobileWorkspaceSurface>;
  start(): void;
  dispose(): void;
  selectView(view: WorkbenchView): void;
  closeMobileSidebar(): void;
  selectSettings(section: SettingsSection): void;
  selectManagement(section: ManagementSection): void;
  openMobileWorkspaceSurface(surface: Exclude<MobileWorkspaceSurface, 'conversation'>): void;
  closeMobileWorkspaceSurface(): void;
}

export function createWorkbenchNavigationService<
  WorkbenchView extends string,
  SettingsSection extends string,
  ManagementSection extends string
>(options: {
  readonly initialView: WorkbenchView;
  readonly initialSettingsSection: SettingsSection;
  readonly initialManagementSection: ManagementSection;
  readonly opensMobileSidebar: (view: WorkbenchView) => boolean;
}): WorkbenchNavigationService<WorkbenchView, SettingsSection, ManagementSection> {
  const initialMobileViewport = window.matchMedia(MOBILE_WORKBENCH_VIEWPORT_QUERY).matches;
  const view = ref(options.initialView) as Ref<WorkbenchView>;
  const settingsSection = ref(options.initialSettingsSection) as Ref<SettingsSection>;
  const managementSection = ref(options.initialManagementSection) as Ref<ManagementSection>;
  const mobileViewport = ref(initialMobileViewport);
  const sidebarCollapsed = ref(initialMobileViewport);
  const mobileSidebarOpen = ref(false);
  const mobileWorkspaceSurface = ref<MobileWorkspaceSurface>('conversation');
  let viewportQuery: MediaQueryList | undefined;

  function updateViewportMode(nextMobileViewport: boolean, force = false): void {
    const next = transitionMobileWorkbenchLayout(
      {
        mobileViewport: mobileViewport.value,
        sidebarCollapsed: sidebarCollapsed.value,
        mobileSidebarOpen: mobileSidebarOpen.value,
        mobileWorkspaceSurface: mobileWorkspaceSurface.value
      },
      nextMobileViewport,
      force
    );
    mobileViewport.value = next.mobileViewport;
    sidebarCollapsed.value = next.sidebarCollapsed;
    mobileSidebarOpen.value = next.mobileSidebarOpen;
    mobileWorkspaceSurface.value = next.mobileWorkspaceSurface;
  }

  function handleViewportChange(event: MediaQueryListEvent): void {
    updateViewportMode(event.matches);
  }

  function start(): void {
    if (viewportQuery !== undefined) return;
    viewportQuery = window.matchMedia(MOBILE_WORKBENCH_VIEWPORT_QUERY);
    updateViewportMode(viewportQuery.matches, true);
    viewportQuery.addEventListener('change', handleViewportChange);
  }

  function dispose(): void {
    viewportQuery?.removeEventListener('change', handleViewportChange);
    viewportQuery = undefined;
  }

  function closeMobileWorkspaceSurface(): void {
    mobileWorkspaceSurface.value = 'conversation';
  }

  function closeMobileSidebar(): void {
    if (mobileViewport.value) mobileSidebarOpen.value = false;
  }

  function selectView(nextView: WorkbenchView): void {
    view.value = nextView;
    if (mobileViewport.value) {
      closeMobileWorkspaceSurface();
      mobileSidebarOpen.value = options.opensMobileSidebar(nextView);
      return;
    }
    sidebarCollapsed.value = false;
  }

  function selectSettings(section: SettingsSection): void {
    settingsSection.value = section;
    closeMobileSidebar();
  }

  function selectManagement(section: ManagementSection): void {
    managementSection.value = section;
    closeMobileSidebar();
  }

  function openMobileWorkspaceSurface(
    surface: Exclude<MobileWorkspaceSurface, 'conversation'>
  ): void {
    if (!mobileViewport.value) return;
    closeMobileSidebar();
    mobileWorkspaceSurface.value = surface;
  }

  return {
    view,
    settingsSection,
    managementSection,
    mobileViewport,
    sidebarCollapsed,
    mobileSidebarOpen,
    mobileWorkspaceSurface,
    start,
    dispose,
    selectView,
    closeMobileSidebar,
    selectSettings,
    selectManagement,
    openMobileWorkspaceSurface,
    closeMobileWorkspaceSurface
  };
}

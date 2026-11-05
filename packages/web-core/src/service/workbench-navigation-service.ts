import type { WorkbenchView as ApplicationView } from '../util/workbench-route.js';
import type { SettingsSection as ApplicationSettings } from '../model/settings.js';
import type { AdminState } from './admin-auth-service.js';
import type { ManagementComposition } from './management-composition.js';
import { translate } from './locale-preference-service.js';
import { computed, proxyRefs, ref, watch, type Ref } from 'vue';
import {
  MOBILE_WORKBENCH_VIEWPORT_QUERY,
  transitionMobileWorkbenchLayout,
  type MobileWorkspaceSurface
} from '../util/mobile-workbench.js';

export type MobileUtilityPanel = 'activity';

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
  readonly mobileUtilityPanel: Ref<MobileUtilityPanel | undefined>;
  start(): void;
  dispose(): void;
  selectView(view: WorkbenchView, mode?: 'preserve-layout'): void;
  closeMobileSidebar(): void;
  selectSettings(section: SettingsSection): void;
  selectManagement(section: ManagementSection): void;
  openMobileWorkspaceSurface(surface: Exclude<MobileWorkspaceSurface, 'conversation'>): void;
  closeMobileWorkspaceSurface(): void;
  selectMobileUtilityPanel(panel: MobileUtilityPanel | undefined): void;
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
  const mobileUtilityPanel = ref<MobileUtilityPanel>();
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
    if (force || nextMobileViewport !== mobileViewport.value) mobileUtilityPanel.value = undefined;
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
    mobileUtilityPanel.value = undefined;
    if (mobileViewport.value) mobileSidebarOpen.value = false;
  }

  function selectView(nextView: WorkbenchView, mode?: 'preserve-layout'): void {
    if (mode === 'preserve-layout') {
      view.value = nextView;
      return;
    }
    mobileUtilityPanel.value = undefined;
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
    mobileUtilityPanel.value = undefined;
    closeMobileSidebar();
    mobileWorkspaceSurface.value = surface;
  }

  function selectMobileUtilityPanel(panel: MobileUtilityPanel | undefined): void {
    if (!mobileViewport.value) return;
    const hadUtilityPanel = mobileUtilityPanel.value !== undefined;
    mobileUtilityPanel.value = panel;
    if (panel === undefined) {
      if (hadUtilityPanel) closeMobileSidebar();
      return;
    }
    mobileSidebarOpen.value = true;
    closeMobileWorkspaceSurface();
  }

  return {
    view,
    settingsSection,
    managementSection,
    mobileViewport,
    sidebarCollapsed,
    mobileSidebarOpen,
    mobileWorkspaceSurface,
    mobileUtilityPanel,
    start,
    dispose,
    selectView,
    closeMobileSidebar,
    selectSettings,
    selectManagement,
    openMobileWorkspaceSurface,
    closeMobileWorkspaceSurface,
    selectMobileUtilityPanel
  };
}

export function createWorkbenchNavigationPresentation<ManagementSection extends string>(input: {
  readonly navigation: WorkbenchNavigationService<
    ApplicationView,
    ApplicationSettings,
    ManagementSection
  >;
  readonly management: Pick<ManagementComposition<ManagementSection>, 'items'>;
  readonly admin: Readonly<Ref<AdminState>>;
  readonly defaultManagement: ManagementSection;
  readonly transition: (previous: ApplicationView, next: ApplicationView) => void;
  readonly recoverNotifications: () => Promise<unknown>;
  readonly layout: Pick<
    ReturnType<typeof import('./workbench-layout-service.js').createWorkbenchLayoutService>,
    'panelWidths' | 'setPanelWidth'
  >;
}) {
  type WorkbenchView = ApplicationView;
  type SettingsSection = ApplicationSettings;
  const navigationService = input.navigation;
  const {
    view,
    managementSection,
    mobileViewport,
    mobileSidebarOpen,
    mobileUtilityPanel,
    mobileWorkspaceSurface,
    sidebarCollapsed,
    closeMobileSidebar,
    closeMobileWorkspaceSurface,
    openMobileWorkspaceSurface,
    selectView: selectWorkbenchView
  } = navigationService;
  const managementComposition = input.management;
  const admin = input.admin;
  const hostedConversationMobileHistoryOpen = ref(false);
  const hostedConversationMobileFilesOpen = ref(false);

  watch(mobileViewport, (mobile) => {
    if (!mobile) {
      hostedConversationMobileHistoryOpen.value = false;
      hostedConversationMobileFilesOpen.value = false;
    }
  });

  const navigationItems = computed<
    readonly {
      readonly id: WorkbenchView;
      readonly label: string;
      readonly icon: string;
    }[]
  >(() => [
    { id: 'nodes', label: translate('navigation.nodes'), icon: '◫' },
    { id: 'conversations', label: translate('navigation.conversations'), icon: '◉' },
    { id: 'management' as const, label: translate('navigation.management'), icon: '☷' },
    { id: 'settings', label: translate('navigation.settings'), icon: '⚙' }
  ]);

  const sidebarContentVisible = computed(() => !sidebarCollapsed.value || mobileSidebarOpen.value);

  const settingsItems = computed<
    readonly { readonly id: SettingsSection; readonly label: string }[]
  >(() => [
    { id: 'account', label: translate('navigation.account') },
    { id: 'usage', label: translate('usageStatistics.title') },
    { id: 'appearance', label: translate('settings.appearance') },
    { id: 'custom-themes', label: translate('customThemes.title') },
    {
      id: 'notifications',
      label: translate('workbenchNotificationCenter.systemNotifications.title')
    },
    { id: 'quick-prompts', label: translate('quickPrompts.title') },
    { id: 'personal-instructions', label: translate('navigation.personalInstructions') },
    { id: 'git', label: translate('personalGit.title') },
    { id: 'shortcuts', label: translate('navigation.shortcuts') },
    { id: 'about', label: translate('navigation.about') }
  ]);

  const managementItems = computed(() =>
    managementComposition.items(admin.value).map(({ id, labelKey }) => ({
      id,
      label: translate(labelKey)
    }))
  );

  function selectNavigation(nextView: WorkbenchView): void {
    const previousView = view.value;
    hostedConversationMobileFilesOpen.value = false;
    const collapseSidebar =
      mobileViewport.value &&
      previousView === nextView &&
      mobileSidebarOpen.value &&
      mobileUtilityPanel.value === undefined;
    if (mobileViewport.value && nextView === 'conversations') {
      const historyWasOpen = hostedConversationMobileHistoryOpen.value;
      hostedConversationMobileHistoryOpen.value = previousView === nextView && !historyWasOpen;
      if (previousView === nextView) {
        navigationService.selectMobileUtilityPanel(undefined);
        closeMobileSidebar();
        closeMobileWorkspaceSurface();
        return;
      }
    } else hostedConversationMobileHistoryOpen.value = false;
    if (
      nextView === 'management' &&
      !managementItems.value.some((item) => item.id === managementSection.value)
    )
      managementSection.value = managementItems.value[0]?.id ?? input.defaultManagement;
    selectWorkbenchView(nextView);
    if (
      collapseSidebar ||
      (mobileViewport.value &&
        previousView !== nextView &&
        (nextView === 'nodes' || nextView === 'conversations'))
    )
      closeMobileSidebar();
    if (previousView !== nextView && (nextView === 'nodes' || nextView === 'conversations'))
      void input.recoverNotifications().catch(() => undefined);
    input.transition(previousView, nextView);
  }

  function closeHostedConversationMobileHistory(): void {
    hostedConversationMobileHistoryOpen.value = false;
  }
  function closeHostedConversationMobileFiles(): void {
    hostedConversationMobileFilesOpen.value = false;
  }

  function selectMobileUtilityPanel(panel: typeof mobileUtilityPanel.value): void {
    if (!mobileViewport.value) return;
    if (panel !== undefined) {
      closeHostedConversationMobileHistory();
      closeHostedConversationMobileFiles();
    }
    navigationService.selectMobileUtilityPanel(panel);
  }

  return {
    navigationItems,
    settingsItems,
    managementItems,
    selectNavigation,
    selectMobileUtilityPanel,
    hostedConversationMobileFilesOpen,
    hostedConversationMobileHistoryOpen,
    closeHostedConversationMobileHistory,
    closeHostedConversationMobileFiles,
    layoutView: proxyRefs({
      mobileViewport,
      mobileSidebarOpen,
      mobileUtilityPanel,
      mobileWorkspaceSurface,
      closeMobileSidebar,
      closeMobileWorkspaceSurface,
      openMobileWorkspaceSurface,
      selectMobileUtilityPanel,
      sidebarCollapsed,
      sidebarContentVisible,
      panelWidths: input.layout.panelWidths,
      setPanelWidth: input.layout.setPanelWidth
    })
  };
}

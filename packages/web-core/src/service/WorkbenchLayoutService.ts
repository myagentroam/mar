import { ref, type Ref } from 'vue';
import type { WorkspaceTab } from '../model/workbench.js';
import { restoreWorkspaceTabs } from './WorkspaceTabService.js';

interface WorkbenchLayout {
  readonly sidebarCollapsed?: boolean;
  readonly explorerCollapsed?: boolean;
  readonly expandedNodeIds?: readonly string[];
  readonly nodeOrder?: readonly string[];
  readonly workspaceOrderByNode?: Readonly<Record<string, readonly string[]>>;
}

interface WorkbenchLayoutServiceOptions {
  readonly sidebarCollapsed: Ref<boolean>;
  readonly expandedNodeIds: Ref<readonly string[]>;
  readonly nodeOrder: Ref<readonly string[]>;
  readonly workspaceOrderByNode: Ref<Readonly<Record<string, readonly string[]>>>;
  readonly workspaceTabs: Ref<readonly WorkspaceTab[]>;
  readonly maxWorkspaceTabs: number;
  readonly restoreTree: (
    expandedNodeIds: readonly string[],
    workspaceOrderByNode: Readonly<Record<string, readonly string[]>>,
    nodeOrder: readonly string[]
  ) => void;
  readonly restoreTabs: (tabs: readonly WorkspaceTab[]) => void;
}

const LAYOUT_STORAGE_KEY = 'mar.workbench.layout.v1';
const TABS_STORAGE_KEY = 'mar.workbench.tabs.v1';
const WIDTHS_STORAGE_KEY = 'mar.workbench.panel-widths.v1';

export const WORKBENCH_PANEL_LIMITS = {
  sidebar: { min: 220, max: 420 },
  inspector: { min: 275, max: 600 }
} as const;
export type WorkbenchPanel = keyof typeof WORKBENCH_PANEL_LIMITS;
type PanelWidths = Partial<Record<WorkbenchPanel, number>>;

function panelWidth(panel: WorkbenchPanel, value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const { min, max } = WORKBENCH_PANEL_LIMITS[panel];
  return Math.max(min, Math.min(max, Math.round(value)));
}

export function createWorkbenchLayoutService(options: WorkbenchLayoutServiceOptions) {
  const panelWidths = ref<PanelWidths>({});

  function setPanelWidth(panel: WorkbenchPanel, value: number): void {
    const width = panelWidth(panel, value);
    if (width === undefined || panelWidths.value[panel] === width) return;
    panelWidths.value = { ...panelWidths.value, [panel]: width };
    try {
      localStorage.setItem(WIDTHS_STORAGE_KEY, JSON.stringify(panelWidths.value));
    } catch {
      // Resizing remains usable when browser persistence is unavailable.
    }
  }

  function persist(): void {
    try {
      sessionStorage.setItem(
        LAYOUT_STORAGE_KEY,
        JSON.stringify({
          sidebarCollapsed: options.sidebarCollapsed.value,
          expandedNodeIds: options.expandedNodeIds.value,
          nodeOrder: options.nodeOrder.value,
          workspaceOrderByNode: options.workspaceOrderByNode.value
        } satisfies WorkbenchLayout)
      );
    } catch {
      // A blocked or full browser session cache must not prevent access to Node facts.
    }
    try {
      localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify(options.workspaceTabs.value));
    } catch {
      // A blocked or full browser local cache must not prevent access to Node facts.
    }
  }

  function restore(): void {
    panelWidths.value = {};
    try {
      const widths: unknown = JSON.parse(localStorage.getItem(WIDTHS_STORAGE_KEY) ?? '{}');
      if (typeof widths === 'object' && widths !== null && !Array.isArray(widths)) {
        for (const panel of ['sidebar', 'inspector'] as const) {
          const width = panelWidth(panel, (widths as Record<string, unknown>)[panel]);
          if (width !== undefined) panelWidths.value[panel] = width;
        }
      }
    } catch {
      // Invalid preferences fall back to responsive defaults independently of tabs.
    }
    try {
      const layout = JSON.parse(sessionStorage.getItem(LAYOUT_STORAGE_KEY) ?? '{}') as unknown;
      if (typeof layout === 'object' && layout !== null) {
        const stored = layout as WorkbenchLayout;
        options.sidebarCollapsed.value =
          stored.sidebarCollapsed === true ||
          (stored.sidebarCollapsed === undefined && stored.explorerCollapsed === true);
        options.restoreTree(
          Array.isArray(stored.expandedNodeIds)
            ? stored.expandedNodeIds.filter((id): id is string => typeof id === 'string')
            : [],
          stored.workspaceOrderByNode ?? {},
          Array.isArray(stored.nodeOrder)
            ? stored.nodeOrder.filter((id): id is string => typeof id === 'string')
            : []
        );
      }
    } catch {
      options.restoreTree([], {}, []);
    }
    try {
      const storedTabs = JSON.parse(localStorage.getItem(TABS_STORAGE_KEY) ?? '[]') as unknown;
      if (!Array.isArray(storedTabs)) return;
      options.restoreTabs(
        restoreWorkspaceTabs(storedTabs.filter(isWorkspaceTab), options.maxWorkspaceTabs)
      );
    } catch {
      options.restoreTabs([]);
    }
  }

  return { persist, restore, panelWidths, setPanelWidth };
}

function isWorkspaceTab(value: unknown): value is WorkspaceTab {
  if (typeof value !== 'object' || value === null) return false;
  const tab = value as Partial<WorkspaceTab>;
  return (
    typeof tab.id === 'string' &&
    typeof tab.nodeId === 'string' &&
    typeof tab.workspaceId === 'string' &&
    typeof tab.label === 'string' &&
    typeof tab.lastActiveAt === 'number' &&
    (tab.pinned === undefined || typeof tab.pinned === 'boolean') &&
    (tab.selectedSessionId === undefined ||
      (typeof tab.selectedSessionId === 'string' && tab.selectedSessionId.length > 0))
  );
}

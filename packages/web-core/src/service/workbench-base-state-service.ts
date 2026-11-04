import { computed, ref, type Ref } from 'vue';
import {
  createWorkbenchNotificationService,
  type WorkbenchNotification
} from './workbench-notification-service.js';
import type { Workspace } from '../model/workbench.js';
import { createAdminSessionStateService } from './admin-session-state-service.js';
import { createSessionDraftService } from './session-draft-service.js';
import { createWorkbenchHttpService } from './workbench-http-service.js';
import { createWorkbenchSelectionStateService } from './workbench-selection-state-service.js';
import { createWorkbenchSurfaceStateService } from './workbench-surface-state-service.js';
import { createWorkspaceSessionPagingService } from './workspace-session-paging-service.js';

const USER_CSRF_STORAGE_KEY = 'mar.user.csrf-token';

/** Creates ordinary tab-local state; product navigation and extensions stay with the host. */
export function createWorkbenchBaseStateService<
  WorkspaceType extends Workspace = Workspace
>(options: { readonly sessionPageSize: number; readonly onUnauthenticated: () => void }) {
  const admin = createAdminSessionStateService();
  const http = createWorkbenchHttpService({
    csrfToken: admin.csrfToken,
    csrfStorageKey: USER_CSRF_STORAGE_KEY,
    onUnauthenticated: options.onUnauthenticated
  });
  const selection = createWorkbenchSelectionStateService<WorkspaceType>();
  const paging = createWorkspaceSessionPagingService(options.sessionPageSize);
  const surface = createWorkbenchSurfaceStateService();
  const draftTarget = computed(() => {
    const workspace = selection.workspaceTarget.value;
    if (workspace === undefined) return undefined;
    const sessionId = selection.selectedSessionId.value;
    return surface.draftSessionOpen.value ||
      sessionId === undefined ||
      sessionId.startsWith('draft:')
      ? { kind: 'workspace' as const, ...workspace }
      : { kind: 'session' as const, ...workspace, sessionId };
  });
  const draft = createSessionDraftService({
    target: draftTarget
  });
  return { admin, http, selection, paging, draft, draftTarget, surface };
}

/** Composes foreground targets without interpreting host management identifiers. */
export function createWorkbenchPageStateService<
  Navigation extends { readonly view: Ref<string> },
  WorkspaceType extends Workspace = Workspace
>(options: {
  readonly sessionPageSize: number;
  readonly onUnauthenticated: () => void;
  readonly navigation: Navigation;
  readonly onWorkspaceRunCompleted?: (nodeId: string, workspaceId: string) => void;
  readonly onNotificationClick?: (notification: WorkbenchNotification) => Promise<void>;
  readonly visibleWorkspaceTargets: () => readonly {
    readonly nodeId: string;
    readonly workspaceId: string;
    readonly sessionId: string;
  }[];
}) {
  const navigation = options.navigation;
  const core = createWorkbenchBaseStateService<WorkspaceType>(options);
  const { admin, http, selection } = core;
  const hostedSelection = {
    selectedNodeId: ref<string>(),
    selectedConversationId: ref<string>()
  };
  const notifications = createWorkbenchNotificationService(
    computed(() => admin.admin.value.username),
    {
      request: http.request,
      ...(options.onWorkspaceRunCompleted === undefined
        ? {}
        : { onWorkspaceRunCompleted: options.onWorkspaceRunCompleted }),
      ...(options.onNotificationClick === undefined
        ? {}
        : { onNotificationClick: options.onNotificationClick }),
      activeTargets: () => {
        if (navigation.view.value === 'conversations') {
          const nodeId = hostedSelection.selectedNodeId.value;
          const conversationId = hostedSelection.selectedConversationId.value;
          return nodeId === undefined || conversationId === undefined
            ? []
            : [
                {
                  targetType: 'HOSTED_CONVERSATION',
                  nodeId,
                  conversationId
                }
              ];
        }
        if (navigation.view.value !== 'nodes') return [];
        return options.visibleWorkspaceTargets().map((target) => ({
          targetType: 'WORKSPACE_SESSION' as const,
          ...target
        }));
      }
    }
  );
  return {
    ...core,
    navigation,
    hostedSelection,
    notifications
  };
}

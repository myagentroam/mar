import { computed, type Ref } from 'vue';
import {
  createWorkbenchNotificationService,
  type WorkbenchNotification
} from './workbench-notification-service.js';
import { createAdminSessionStateService } from './admin-session-state-service.js';
import { createWorkbenchHttpService } from './workbench-http-service.js';
import { createWorkspaceSessionPagingService } from './workspace-session-paging-service.js';

const USER_CSRF_STORAGE_KEY = 'mar.user.csrf-token';

/** Creates ordinary tab-local state; product navigation and extensions stay with the host. */
export function createWorkbenchBaseStateService(options: {
  readonly sessionPageSize: number;
  readonly onUnauthenticated: () => void;
}) {
  const admin = createAdminSessionStateService();
  const http = createWorkbenchHttpService({
    csrfToken: admin.csrfToken,
    csrfStorageKey: USER_CSRF_STORAGE_KEY,
    onUnauthenticated: options.onUnauthenticated
  });
  const paging = createWorkspaceSessionPagingService(options.sessionPageSize);
  return { admin, http, paging };
}

/** Composes foreground targets without interpreting host management identifiers. */
export function createWorkbenchPageStateService<
  Navigation extends { readonly view: Ref<string> }
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
  readonly visibleHostedTarget: () =>
    { readonly nodeId: string; readonly conversationId: string } | undefined;
}) {
  const navigation = options.navigation;
  const core = createWorkbenchBaseStateService(options);
  const { admin, http } = core;
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
          const target = options.visibleHostedTarget();
          return target === undefined
            ? []
            : [
                {
                  targetType: 'HOSTED_CONVERSATION',
                  ...target
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
    notifications
  };
}
